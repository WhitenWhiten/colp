import { createPhase4bMcpPackageEvidence } from '../../../src/modules/mcp/colp-package-evidence.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import Fastify from 'fastify';
import {
  runDeploymentConformanceProbes,
  type DeploymentConformanceCommand,
  type DeploymentConformanceTarget,
  type VerifiedDeploymentConformanceEvidence,
} from '@know-n/colp/conformance';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_READ_CONFORMANCE_PLAN,
  PHASE4B_MCP_READ_CONFORMANCE_SCOPE,
  PHASE4B_MCP_READ_PROFILE_CLAIMS,
  claimPhase4bMcpReadProfiles,
  createPhase4bMcpReadProfileClaimController,
  createMcpReadManifestCandidate,
  verifyPhase4bMcpSdkAcceptedEvidence,
  type Phase4bMcpReadProfileClaims,
} from '../../../src/modules/mcp/index.js';
import { registerPublicationManifestRoutes } from '../../../src/transport/product/publication-manifest-routes.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const GENERATED_AT = '2026-08-05T08:00:00.000Z';
const SOURCE_REVISION = 'a'.repeat(40);
const SOURCE_DIGEST = 'b'.repeat(64);

test('R14 derives the exact source-bound mcp-read deployment plan without mcp-write', () => {
  assert.deepEqual(PHASE4B_MCP_READ_PROFILE_CLAIMS, ['core', 'mcp-read']);
  assert.deepEqual(PHASE4B_MCP_READ_CONFORMANCE_SCOPE.profiles, ['core', 'mcp-read']);
  assert.deepEqual(PHASE4B_MCP_READ_CONFORMANCE_SCOPE.capabilities, []);
  assert.deepEqual(PHASE4B_MCP_READ_CONFORMANCE_PLAN.probeIds, [
    'mcp-2026-07-28.transport-header-contracts',
    'mcp-2026-07-28.discovery-contracts',
    'mcp-2026-07-28.subscription-contracts',
    'mcp-2026-07-28.read-schema-contracts',
    'mcp-2026-07-28.oauth-client-contracts',
  ]);
  assert.equal(PHASE4B_MCP_READ_CONFORMANCE_PLAN.probeIds.includes(
    'mcp-2026-07-28.write-mrtr-contracts',
  ), false);
});

test('verifies the committed COLP-MCP-15 accepted artifact and rejects missing or tampered evidence', () => {
  const verified = verifyPhase4bMcpSdkAcceptedEvidence(readAccepted());
  assert.equal(verified.artifact.candidate, 'mcp-2026-07-28-sdk-accepted');
  assert.equal(verified.artifact.mcpVersion, '2026-07-28');
  assert.equal(verified.artifact.probeFamilyIds.includes(
    'mcp-2026-07-28.transport-header-contracts',
  ), true);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.artifact), true);

  assert.throws(() => verifyPhase4bMcpSdkAcceptedEvidence(undefined), /object/u);
  const tampered = accepted();
  tampered.packageVersion = '9.9.9';
  assert.throws(() => verifyPhase4bMcpSdkAcceptedEvidence(tampered), /evidenceDigest|packageVersion/u);
  const missing = accepted() as Record<string, unknown>;
  delete missing.packageVersion;
  assert.throws(() => verifyPhase4bMcpSdkAcceptedEvidence(missing), /packageVersion|fields/u);
});

test('claims and activates core/mcp-read only through the official COLP assert gate', async () => {
  const acceptedEvidence = verifyPhase4bMcpSdkAcceptedEvidence(readAccepted());
  const deploymentEvidence = await runDeploymentConformanceProbes(
    syntheticReadTarget(),
    mcpReadScope(readCandidate()),
  );
  assert.deepEqual(deploymentEvidence.profiles, ['core', 'mcp-read']);
  assert.equal(deploymentEvidence.mcpBinding?.probeFamilyIds.length, 5);
  assert.equal(deploymentEvidence.mcpBinding?.probeFamilyIds.includes(
    'mcp-2026-07-28.write-mrtr-contracts',
  ), false);

  const claims = claimPhase4bMcpReadProfiles({
    acceptedEvidence,
    conformanceCandidate: readCandidate(),
    deploymentEvidence,
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    generatedAt: GENERATED_AT,
  });
  assert.deepEqual(claims.profiles, ['core', 'mcp-read']);
  assert.equal(claims.profiles.includes('mcp-write' as never), false);
  assert.equal(claims.protocolVersion, '2026-07-28');

  const config = mcpConfig();
  const unclaimed = createMcpReadManifestCandidate(config.mcp!);
  assert.deepEqual(unclaimed.manifest.mounts[0]!.profiles, ['core']);
  assert.equal(unclaimed.claimed, false);

  const claimed = createMcpReadManifestCandidate(config.mcp!, claims);
  assert.deepEqual(claimed.manifest.mounts[0]!.profiles, ['core', 'mcp-read']);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.manifest.mounts[0]!.features.mcp?.protocolVersion, '2026-07-28');
  assert.equal(claimed.manifest.mounts[0]!.profiles.includes('mcp-write' as never), false);

  const app = Fastify({ logger: false });
  const controller = createPhase4bMcpReadProfileClaimController();
  registerPublicationManifestRoutes(
    app,
    config.publication,
    undefined,
    undefined,
    undefined,
    undefined,
    config.mcp,
    undefined,
    controller,
  );
  const before = await app.inject({ method: 'GET', url: '/.well-known/collection-protocol' });
  assert.equal(before.statusCode, 200);
  const beforeMount = before.json<{ mounts: Array<{ id: string; profiles: string[] }> }>()
    .mounts.find((mount) => mount.id === 'mcp');
  assert.deepEqual(beforeMount?.profiles, ['core']);

  controller.activate(claims);
  const after = await app.inject({ method: 'GET', url: '/.well-known/collection-protocol' });
  const afterMount = after.json<{ mounts: Array<{ id: string; profiles: string[] }> }>()
    .mounts.find((mount) => mount.id === 'mcp');
  assert.deepEqual(afterMount?.profiles, ['core', 'mcp-read']);
  assert.equal(afterMount?.profiles.includes('mcp-write' as never), false);
  await app.close();
});

test('claim gate fails closed on wrong deployment scope, missing binding, and copied claims', async () => {
  const acceptedEvidence = verifyPhase4bMcpSdkAcceptedEvidence(readAccepted());
  const deploymentEvidence = await runDeploymentConformanceProbes(
    syntheticReadTarget(),
    mcpReadScope(readCandidate()),
  );

  assert.throws(() => claimPhase4bMcpReadProfiles({
    acceptedEvidence,
    conformanceCandidate: readCandidate(),
    deploymentEvidence: structuredClone(deploymentEvidence) as never,
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    generatedAt: GENERATED_AT,
  }), /returned by|wrong scope|incomplete/u);
  assert.throws(() => claimPhase4bMcpReadProfiles({
    acceptedEvidence,
    conformanceCandidate: readCandidate(),
    deploymentEvidence: {
      ...deploymentEvidence,
      profiles: ['core', 'mcp-read', 'mcp-write'],
    } as unknown as VerifiedDeploymentConformanceEvidence,
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    generatedAt: GENERATED_AT,
  }), /wrong scope|incomplete|mcp-write/u);
  assert.throws(() => claimPhase4bMcpReadProfiles({
    acceptedEvidence,
    conformanceCandidate: readCandidate(),
    deploymentEvidence: {
      ...deploymentEvidence,
      mcpBinding: undefined,
    } as unknown as VerifiedDeploymentConformanceEvidence,
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    generatedAt: GENERATED_AT,
  }), /accepted COLP|evidenceDigest|binding/u);

  assert.throws(() => createMcpReadManifestCandidate(
    mcpConfig().mcp!,
    { profiles: ['core', 'mcp-write'] } as unknown as Phase4bMcpReadProfileClaims,
  ), /issued by claimPhase4bMcpReadProfiles/u);
});

test('source-bound runner keeps mcp-read unclaimed until activation and records fail-closed controls', () => {
  const runner = readFileSync(new URL(
    '../../../scripts/phase4b-mcp-read-acceptance.mjs',
    import.meta.url,
  ), 'utf8');
  const bootstrap = readFileSync(new URL(
    '../../../scripts/acceptance/phase4b-mcp-read-acceptance.ts',
    import.meta.url,
  ), 'utf8');
  const sources = [runner, bootstrap];
  for (const marker of [
    'runPhase4bMcpReadAcceptance',
    'claimPhase4bMcpReadProfiles',
    'accepted: true',
    'deploymentProven: false',
    'mcp-write',
    'FAIL-CLOSED',
  ]) {
    assert.equal(sources.some((source) => source.includes(marker)), true, marker);
  }
});

test('R14 conformance target probes real discovery/schema/OAuth through the official client', () => {
  const source = readFileSync(new URL(
    '../../../scripts/evidence/phase4b-mcp-read-conformance-target.ts',
    import.meta.url,
  ), 'utf8');
  for (const marker of [
    '@modelcontextprotocol/client',
    'StreamableHTTPClientTransport',
    'authProvider',
    "client.request('tools/list', {})",
    "client.discover()",
    "payload.resultType !== 'complete'",
  ]) {
    assert.equal(source.includes(marker), true, marker);
  }
});
function accepted(): Record<string, unknown> {
  return structuredClone(createPhase4bMcpPackageEvidence().accepted) as unknown as Record<string, unknown>;
}

function readAccepted(): unknown {
  return accepted();
}

function readCandidate(): Record<string, unknown> {
  return structuredClone(createPhase4bMcpPackageEvidence().candidate) as unknown as Record<string, unknown>;
}

function mcpReadScope(candidate: Record<string, unknown>): Parameters<typeof runDeploymentConformanceProbes>[1] {
  return {
    profiles: ['core', 'mcp-read'],
    capabilities: [],
    mcpConformance: {
      packageVersion: String(candidate.packageVersion),
      requirementsDigest: String(candidate.requirementsDigest),

    },
  };
}

function syntheticReadTarget(): DeploymentConformanceTarget {
  return Object.freeze({
    async execute(command: DeploymentConformanceCommand) {
      switch (command.kind) {
        case 'mcp-2026-07-28.transport-header-contract':
          const headerNames = command.headers.map(({ name }) => name.toLowerCase());
          const uniqueHeaders = new Set(headerNames).size === headerNames.length;
          const singleMethod = headerNames.filter((name) => name === 'mcp-method').length <= 1;
          return {
            challenge: command.challenge,
            accepted: uniqueHeaders && singleMethod,
            codec: 'base64',
            decoded: 'sentinel',
            unique: uniqueHeaders && singleMethod,
          };
        case 'mcp-2026-07-28.discovery-contract':
          return {
            challenge: command.challenge,
            protocolVersion: '2026-07-28',
            discovered: true,
            serverInfo: { name: 'Known MCP Read', version: '0.1.0' },
            capabilitiesDeclared: true,
            extensionsBounded: true,
          };
        case 'mcp-2026-07-28.subscription-contract':
          return {
            challenge: command.challenge,
            subscriptionId: command.subscriptionId,
            acknowledged: true,
            notificationRouted: command.notification.subscriptionId === command.subscriptionId,
            requestScoped: true,
            bodyCarried: false,
          };
        case 'mcp-2026-07-28.read-schema-contract':
          return {
            challenge: command.challenge,
            accepted: Array.isArray(command.schema) ? false : true,
            refsResolved: !Array.isArray(command.schema),
          };
        case 'mcp-2026-07-28.oauth-client-contract':
          return {
            challenge: command.challenge,
            issuerValidated: command.issuer === command.expectedIssuer,
            dcrApplicationType: command.applicationType,
            credentialIssuerKeyed: command.issuer === command.expectedIssuer,
            refreshStateIsolated: command.issuer === command.expectedIssuer,
          };
        default:
          throw new TypeError(`Unexpected R14 conformance command: ${command.kind}`);
      }
    },
    async restart() {},
    async readDiagnostics() {
      return { engine: 'postgresql', mcpReadProfile: 'candidate' };
    },
  });
}

function mcpConfig() {
  return loadConfig({
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    PUBLICATION_SERVER_UUID: SERVER_UUID,
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: 'https://collections.example.test/collections/-/mcp',
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  });
}
