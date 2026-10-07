import { createPhase4bMcpPackageEvidence } from '../../../src/modules/mcp/colp-package-evidence.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import Fastify from 'fastify';
import {
  assertPhase4bMcpWriteArtifactRedaction,
  assertPhase4bMcpWriteRepositoryBinding,
  mergePhase4bMcpWriteNegativeControls,
  phase4bMcpWriteAcceptanceNegativeControls,
} from '../../../scripts/acceptance/phase4b-mcp-write-acceptance.js';
import {
  MCP_WRITE_ACCEPTANCE_NEGATIVE_CONTROL_MODE,
  MCP_WRITE_NEGATIVE_CONTROL_IDS,
} from '../../../scripts/phase4b-mcp-write-acceptance-bindings.mjs';
import {
  runDeploymentConformanceProbes,
  type DeploymentConformanceScope,
  type VerifiedDeploymentConformanceEvidence,
} from '@know-n/colp/conformance';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_WRITE_CONFORMANCE_PLAN,
  PHASE4B_MCP_WRITE_ENDPOINTS,
  PHASE4B_MCP_WRITE_PORTS,
  PHASE4B_MCP_WRITE_PROFILE_CLAIMS,
  PHASE4B_MCP_WRITE_REQUIRED_PROBE_FAMILY_IDS,
  claimPhase4bMcpReadProfiles,
  claimPhase4bMcpWriteProfiles,
  createMcpReadManifestCandidate,
  createPhase4bMcpReadProfileClaimController,
  createPhase4bMcpWriteProfileClaimController,
  verifyPhase4bMcpSdkAcceptedEvidence,
  type Phase4bMcpReadProfileClaims,
  type Phase4bMcpWriteProfileClaims,
} from '../../../src/modules/mcp/index.js';
import { registerPublicationManifestRoutes } from '../../../src/transport/product/publication-manifest-routes.js';
import { createPhase4bMcpWriteSyntheticTarget } from '../../support/phase4b-mcp-write-conformance-target.js';
import { mcpEnvironment } from '../../../scripts/phase4b-mcp-write-acceptance-adapter.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const GENERATED_AT = '2026-08-06T08:00:00.000Z';
const SOURCE_REVISION = 'a'.repeat(40);
const SOURCE_DIGEST = 'b'.repeat(64);
const BACKEND_ROOT = resolve(import.meta.dirname, '../../..');

test('MCP Write acceptance pins a coherent browser-auth config without ambient OIDC', () => {
  const env = mcpEnvironment(
    { DATABASE_URL: 'postgres://ambient.invalid/ignored', OIDC_CLIENT_SECRET: 'ambient-secret' },
    'http://127.0.0.1:34567',
    'postgres://known:test@127.0.0.1:5432/known',
    SERVER_UUID,
  );
  const config = loadConfig(env);
  assert.equal(config.betterAuth.enabled, false);
  assert.equal(config.testIdentityProviderEnabled, false);
  assert.equal(config.oidc.jwksUri, 'https://issuer.example.test/realms/known/protocol/openid-connect/certs');
  assert.equal(config.oidc.clientAuthMode, 'none');
});

test('MCP-W10 derives the full core/publication/publisher/mcp write deployment plan', () => {
  assert.deepEqual(PHASE4B_MCP_WRITE_PROFILE_CLAIMS, [
    'core',
    'publication',
    'publisher',
    'mcp-read',
    'mcp-write',
  ]);
  assert.deepEqual(PHASE4B_MCP_WRITE_CONFORMANCE_PLAN.profiles, PHASE4B_MCP_WRITE_PROFILE_CLAIMS);
  assert.equal(PHASE4B_MCP_WRITE_CONFORMANCE_PLAN.probeIds.includes(
    'mcp-2026-07-28.write-mrtr-contracts',
  ), true);
  assert.equal(PHASE4B_MCP_WRITE_REQUIRED_PROBE_FAMILY_IDS.includes(
    'mcp-2026-07-28.write-mrtr-contracts',
  ), true);
  assert.equal(PHASE4B_MCP_WRITE_REQUIRED_PROBE_FAMILY_IDS.includes(
    'mcp-2026-07-28.read-schema-contracts',
  ), true);
  assert.equal(PHASE4B_MCP_WRITE_CONFORMANCE_PLAN.probeIds.includes(
    'publisher.transaction-contracts',
  ), true);
});

test('claims and activates core/mcp-write only through official probes and current artifact', async () => {
  const issuedReadClaims = await readClaims();
  const candidate = readCandidate();
  const deploymentEvidence = await runDeploymentConformanceProbes(
    createPhase4bMcpWriteSyntheticTarget(),
    mcpWriteScope(candidate),
  );
  assert.deepEqual(deploymentEvidence.profiles, PHASE4B_MCP_WRITE_PROFILE_CLAIMS);
  assert.equal(deploymentEvidence.mcpBinding?.probeFamilyIds.includes(
    'mcp-2026-07-28.write-mrtr-contracts',
  ), true);

  const claims = claimPhase4bMcpWriteProfiles({
    acceptedEvidence: readAccepted(),
    conformanceCandidate: candidate,
    deploymentEvidence,
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    generatedAt: GENERATED_AT,
  });
  assert.deepEqual(claims.profiles, PHASE4B_MCP_WRITE_PROFILE_CLAIMS);
  assert.equal(claims.protocolVersion, '2026-07-28');

  const config = mcpConfig();
  // `features.mcp.tools` is no longer a write-claim marker: the read surface
  // always exposes read-only tools to authenticated principals, so every
  // candidate declares `tools: true` (2026-08-27 MCP usability audit,
  // MCP-U-11). Write activation is visible through `profiles` instead.
  const closed = createMcpReadManifestCandidate(config.mcp!);
  assert.deepEqual(closed.manifest.mounts[0]!.profiles, ['core']);
  assert.equal(closed.manifest.mounts[0]!.features.mcp?.tools, true);

  const readOnly = createMcpReadManifestCandidate(config.mcp!, issuedReadClaims);
  assert.equal(readOnly.manifest.mounts[0]!.profiles.includes('mcp-read'), true);
  assert.equal(readOnly.manifest.mounts[0]!.profiles.includes('mcp-write'), false);
  assert.equal(readOnly.manifest.mounts[0]!.features.mcp?.tools, true);

  const writeMount = createMcpReadManifestCandidate(config.mcp!, issuedReadClaims, claims);
  assert.deepEqual(writeMount.manifest.mounts[0]!.profiles, PHASE4B_MCP_WRITE_PROFILE_CLAIMS);
  assert.equal(writeMount.manifest.mounts[0]!.features.mcp?.tools, true);
  assert.equal(writeMount.claimed, true);
  assert.equal(writeMount.endpoint.endsWith('/collections/-/mcp'), true);

  const app = Fastify({ logger: false });
  const readController = createPhase4bMcpReadProfileClaimController();
  const writeController = createPhase4bMcpWriteProfileClaimController();
  registerPublicationManifestRoutes(
    app,
    config.publication,
    undefined,
    undefined,
    undefined,
    undefined,
    config.mcp,
    undefined,
    readController,
    undefined,
    writeController,
  );
  const before = await app.inject({ method: 'GET', url: '/.well-known/collection-protocol' });
  const beforeMount = before.json<{ mounts: Array<{ id: string; profiles: string[] }> }>()
    .mounts.find((mount) => mount.id === 'mcp');
  assert.deepEqual(beforeMount?.profiles, ['core']);

  readController.activate(issuedReadClaims);
  const afterRead = await app.inject({ method: 'GET', url: '/.well-known/collection-protocol' });
  const readMount = afterRead.json<{ mounts: Array<{ id: string; profiles: string[] }> }>()
    .mounts.find((mount) => mount.id === 'mcp');
  assert.deepEqual(readMount?.profiles, ['core', 'mcp-read']);
  assert.equal(readMount?.profiles.includes('mcp-write'), false);

  writeController.activate(claims);
  const afterWrite = await app.inject({ method: 'GET', url: '/.well-known/collection-protocol' });
  const writeMountHttp = afterWrite.json<{ mounts: Array<{
    id: string;
    profiles: string[];
    features: { mcp: { tools: boolean } };
  }> }>().mounts.find((mount) => mount.id === 'mcp');
  assert.deepEqual(writeMountHttp?.profiles, PHASE4B_MCP_WRITE_PROFILE_CLAIMS);
  assert.equal(writeMountHttp?.features.mcp.tools, true);
  await app.close();
});

test('write claim gate refuses read-only, copied, missing-binding, and package-only evidence', async () => {
  const candidate = readCandidate();
  const writeEvidence = await runDeploymentConformanceProbes(
    createPhase4bMcpWriteSyntheticTarget(),
    mcpWriteScope(candidate),
  );
  const readEvidence = await runDeploymentConformanceProbes(
    createPhase4bMcpWriteSyntheticTarget(),
    {
      profiles: ['core', 'mcp-read'],
      capabilities: [],
      mcpConformance: {
        packageVersion: String(candidate.packageVersion),
        requirementsDigest: String(candidate.requirementsDigest),

      },
    },
  );

  assert.throws(() => claimPhase4bMcpWriteProfiles({
    acceptedEvidence: readAccepted(),
    conformanceCandidate: candidate,
    deploymentEvidence: structuredClone(writeEvidence) as never,
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    generatedAt: GENERATED_AT,
  }), /returned by|probe/i);
  assert.throws(() => claimPhase4bMcpWriteProfiles({
    acceptedEvidence: readAccepted(),
    conformanceCandidate: candidate,
    deploymentEvidence: readEvidence,
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    generatedAt: GENERATED_AT,
  }), /wrong scope|incomplete|write-mrtr/u);
  assert.throws(() => claimPhase4bMcpWriteProfiles({
    acceptedEvidence: readAccepted(),
    conformanceCandidate: candidate,
    deploymentEvidence: Object.freeze({
      ...writeEvidence,
      mcpBinding: undefined,
    }) as unknown as VerifiedDeploymentConformanceEvidence,
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    generatedAt: GENERATED_AT,
  }), /binding|accepted COLP/u);

  const claims = claimPhase4bMcpWriteProfiles({
    acceptedEvidence: readAccepted(),
    conformanceCandidate: candidate,
    deploymentEvidence: writeEvidence,
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    generatedAt: GENERATED_AT,
  });
  assert.throws(
    () => createMcpReadManifestCandidate(
      mcpConfig().mcp!,
      undefined,
      { profiles: ['core', 'mcp-write'] } as unknown as Phase4bMcpWriteProfileClaims,
    ),
    /issued by claimPhase4bMcpWriteProfiles/u,
  );
  assert.throws(
    () => createMcpReadManifestCandidate(
      mcpConfig().mcp!,
      { profiles: ['core', 'mcp-read', 'mcp-write'] } as unknown as Phase4bMcpReadProfileClaims,
      claims,
    ),
    /issued by claimPhase4bMcpReadProfiles/u,
  );
});

test('write repository binding, negative controls, redaction, and runner sources are source-bound', () => {
  const runner = readFileSync(
    resolve(BACKEND_ROOT, 'scripts/phase4b-mcp-write-acceptance.mjs'),
    'utf8',
  );
  const bootstrap = readFileSync(
    resolve(BACKEND_ROOT, 'scripts/acceptance/phase4b-mcp-write-acceptance.ts'),
    'utf8',
  );
  const bindings = readFileSync(
    resolve(BACKEND_ROOT, 'scripts/phase4b-mcp-write-acceptance-bindings.mjs'),
    'utf8',
  );
  const adapter = readFileSync(
    resolve(BACKEND_ROOT, 'scripts/phase4b-mcp-write-acceptance-adapter.ts'),
    'utf8',
  );
  const sources = [runner, bootstrap, bindings];
  for (const marker of [
    'runPhase4bMcpWriteAcceptance',
    'claimPhase4bMcpWriteProfiles',
    'accepted: true',
    'deploymentProven: false',
    'mcp-2026-07-28.write-mrtr-contracts',
    'FAIL-CLOSED',
    'real-temporary-source-corruption',
    'runMcpWriteSourceNegativeControls',
    'negativeControlDigest',
  ]) {
    assert.equal(sources.some((source) => source.includes(marker)), true, marker);
  }
  assert.match(runner, /negativeControls:\s*\[\]/u);
  assert.match(runner, /documented empty shape/u);
  for (const authBinding of [
    "BETTER_AUTH_ENABLED: 'false'",
    "OIDC_ALLOW_TEST_PROVIDER: 'false'",
    "OIDC_CLIENT_AUTH_MODE: 'none'",
    'OIDC_JWKS_URI:',
  ]) {
    assert.equal(adapter.includes(authBinding), true, authBinding);
  }
  assert.match(adapter, /exploreDirectoryRateLimiter:\s*createMemorySearchRateLimiter/u);
  assert.match(adapter, /snapshotQuery\s*=\s*\{[\s\S]*sharedExposure:\s*createPostgresSharedExposureFactsPort/u);
  assert.match(bootstrap, /Claims gate runtime eligibility/u);
  assert.deepEqual([...MCP_WRITE_NEGATIVE_CONTROL_IDS], [
    'missing-authorization-recheck',
    'missing-idempotency-key-scope',
    'missing-mcp-write-route',
    'missing-mcp-write-port',
    'missing-mcp-write-migration',
    'drifted-mcp-write-bindings',
  ]);
  assert.equal(MCP_WRITE_ACCEPTANCE_NEGATIVE_CONTROL_MODE, 'real-temporary-source-corruption');

  const binding = {
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    migrationHead: '000000000001_initial',
    migrationDigest: SOURCE_DIGEST,
    configDigest: SOURCE_DIGEST,
    lockfileDigest: SOURCE_DIGEST,
    backendArtifactDigest: SOURCE_DIGEST,
    colpDigest: SOURCE_DIGEST,
    protocolVersion: '2026-07-28' as const,
    endpoints: PHASE4B_MCP_WRITE_ENDPOINTS,
    ports: PHASE4B_MCP_WRITE_PORTS,
    routes: Object.freeze(['/health', '/collections/-/mcp'] as const),
  };
  const controls = phase4bMcpWriteAcceptanceNegativeControls({ binding, acceptedEvidence: readAccepted() });
  assert.ok(controls.length >= 5);
  assert.equal(controls.every((control) => control.outcome === 'failed_closed'), true);
  const sourceControls = MCP_WRITE_NEGATIVE_CONTROL_IDS.map((id) => ({
    id,
    outcome: 'failed_closed' as const,
    injection: `temporary-source ${id} removed or mismatched`,
    observationDigest: 'c'.repeat(64),
  }));
  const merged = mergePhase4bMcpWriteNegativeControls({
    binding,
    acceptedEvidence: readAccepted(),
    sourceNegativeControls: sourceControls,
  });
  assert.ok(merged.length >= controls.length + MCP_WRITE_NEGATIVE_CONTROL_IDS.length);
  assert.equal(merged.every((control) => control.outcome === 'failed_closed'), true);
  for (const id of MCP_WRITE_NEGATIVE_CONTROL_IDS) {
    assert.equal(merged.some((control) => control.id === id), true, id);
  }
  assert.throws(
    () => mergePhase4bMcpWriteNegativeControls({
      binding,
      acceptedEvidence: readAccepted(),
      sourceNegativeControls: [],
    }),
    /temporary-source negative controls/u,
  );
  assertPhase4bMcpWriteArtifactRedaction(JSON.stringify({ binding, surfaces: ['artifact'] }));
});

test('W10 target and W08 fixture require the official client over the real MCP route', () => {
  const target = readFileSync(resolve(
    BACKEND_ROOT,
    'scripts/evidence/phase4b-mcp-write-conformance-target.ts',
  ), 'utf8');
  for (const marker of [
    '@modelcontextprotocol/client',
    'StreamableHTTPClientTransport',
    "client.request('tools/call', {",
    'changes.plan',
    'changes.commit',
    'mcp_change_plans',
    'mcp_commit_receipts',
  ]) {
    assert.equal(target.includes(marker), true, marker);
  }
  const fixture = readFileSync(resolve(
    BACKEND_ROOT,
    'scripts/mcp-w08-e2e-fixture.ts',
  ), 'utf8');
  for (const marker of [
    'createPhase4bMcpOfficialClient',
    'registerMcpReadRoutes',
    'createPhase4bMcpWriteComposition',
  ]) {
    assert.equal(fixture.includes(marker), true, marker);
  }
  assert.equal(fixture.includes('harness.adapter.callTool'), false);
});

test('W08 real-stack approval handoff cannot collapse OAuth and browser epochs', () => {
  const fixture = readFileSync(resolve(
    BACKEND_ROOT,
    'scripts/mcp-w08-e2e-fixture.ts',
  ), 'utf8');
  const harness = readFileSync(resolve(
    BACKEND_ROOT,
    'scripts/real-stack-e2e.mjs',
  ), 'utf8');
  const browserAcceptance = readFileSync(resolve(
    BACKEND_ROOT,
    '../Known-Frontend/web/e2e-real-stack/write-approval-acceptance.spec.ts',
  ), 'utf8');

  for (const marker of [
    'createPostgresMcpOauthRevocationStore',
    'revocationStore.isRevoked(input)',
    'revocationStore.securityEpoch()',
    'where subject_id = $1',
    'verified.accountSubjectId',
    'stored.binding.securityEpoch !== verified.binding.securityEpoch',
    'select epoch from mcp_oauth_security_epoch where id = 1',
    'stored.approvalUri !== approvalUri',
  ]) {
    assert.equal(fixture.includes(marker), true, marker);
  }
  assert.doesNotMatch(fixture, /securityEpoch:\s*(?:async\s*)?\(\)\s*=>\s*['"]0['"]/u);
  assert.doesNotMatch(fixture, /id:\s*`account:\$\{sub\}`/u);

  for (const marker of [
    'accountSecurityEpoch: String(browserEpochs.rows[0].account_security_epoch)',
    'sessionSecurityEpoch: String(browserEpochs.rows[0].session_security_epoch)',
    'browserAccountSecurityEpoch: session.accountSecurityEpoch',
    'browserSessionSecurityEpoch: session.sessionSecurityEpoch',
  ]) {
    assert.equal(harness.includes(marker), true, marker);
  }

  for (const marker of [
    'page.goto(fixture.approvalUri)',
    'expect(fixture.mcpSecurityEpoch).toBe(fixture.mcpAuthoritySecurityEpoch)',
    'expect(fixture.mcpSecurityEpoch).not.toBe(fixture.browserAccountSecurityEpoch)',
    "expect(fixture.browserAccountSecurityEpoch).toBe('0')",
    "expect(fixture.browserSessionSecurityEpoch).toBe('0')",
    'Please sign in before authorizing this MCP change.',
    '&reason=approval_required',
    "page.locator('[data-plan-id]')",
  ]) {
    assert.equal(browserAcceptance.includes(marker), true, marker);
  }
  assert.doesNotMatch(browserAcceptance, /__KNOWN_FLAGS__|enableWriteApprovals/u);
  assert.doesNotMatch(browserAcceptance, /page\.goto\(`\/approvals\/\$\{/u);
});

function mcpWriteScope(candidate: Record<string, unknown>): DeploymentConformanceScope {
  return {
    profiles: PHASE4B_MCP_WRITE_PROFILE_CLAIMS,
    capabilities: [],
    mcpConformance: {
      packageVersion: String(candidate.packageVersion),
      requirementsDigest: String(candidate.requirementsDigest),

    },
  };
}

async function readClaims(): Promise<Phase4bMcpReadProfileClaims> {
  const acceptedEvidence = verifyPhase4bMcpSdkAcceptedEvidence(readAccepted());
  const candidate = readCandidate();
  const deploymentEvidence = await runDeploymentConformanceProbes(
    createPhase4bMcpWriteSyntheticTarget(),
    {
      profiles: ['core', 'mcp-read'],
      capabilities: [],
      mcpConformance: {
        packageVersion: String(candidate.packageVersion),
        requirementsDigest: String(candidate.requirementsDigest),

      },
    },
  );
  return claimPhase4bMcpReadProfiles({
    acceptedEvidence,
    conformanceCandidate: candidate,
    deploymentEvidence,
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    generatedAt: GENERATED_AT,
  });
}

function accepted(): Record<string, unknown> {
  return structuredClone(createPhase4bMcpPackageEvidence().accepted) as unknown as Record<string, unknown>;
}

function readAccepted(): unknown {
  return accepted();
}

function readCandidate(): Record<string, unknown> {
  return structuredClone(createPhase4bMcpPackageEvidence().candidate) as unknown as Record<string, unknown>;
}

function mcpConfig() {
  const requestStateKey = Buffer.alloc(32, 77).toString('base64');
  return loadConfig({
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    PUBLICATION_SERVER_UUID: SERVER_UUID,
    KNOWN_FEATURE_MCP_READ: 'true',
    KNOWN_FEATURE_MCP_WRITE: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: 'https://collections.example.test/collections/-/mcp',
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'nodes:write,access:write,changes:commit,changes:cancel',
    MCP_WRITE_REQUEST_STATE_KEY: requestStateKey,
  });
}
