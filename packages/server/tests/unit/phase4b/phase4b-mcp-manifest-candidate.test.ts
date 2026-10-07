import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { validateManifestSemantics } from '@know-n/colp/semantic';
import { loadConfig } from '../../support/test-config.js';
import { createPublicationManifestCandidate, type PublicationManifestConfig } from '../../../src/modules/publication/index.js';
import {
  createMcpReadManifestCandidate,
  isMcpReadManifestCandidateClosed,
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
  PHASE4B_MCP_READ_MANIFEST_PROFILES,
  PHASE4B_MCP_READ_PROFILE_CLAIMS,
  PHASE4B_MCP_WRITE_PROFILE_CLAIMS,
  type McpReadFeatureConfig,
} from '../../../src/modules/mcp/index.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';

function loadMcpConfig(): McpReadFeatureConfig {
  const config = loadConfig({
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
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: 'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  }).mcp;
  assert.ok(config, 'MCP feature config must be present');
  return config;
}

function publicationConfig(overrides: Partial<PublicationManifestConfig> = {}): PublicationManifestConfig {
  return {
    origin: 'https://collections.example.test',
    mountPath: '/colp/v0.1/',
    serverUuid: SERVER_UUID,
    title: 'Known Collections',
    maxPageSize: 200,
    maxSnapshotNodes: 100_000,
    endpoints: {
      directory: 'https://collections.example.test/colp/v0.1/directory',
      collection: 'https://collections.example.test/colp/v0.1/collections/{collectionId}',
      snapshot: 'https://collections.example.test/colp/v0.1/collections/{collectionId}/snapshot',
    },
    ...overrides,
  };
}

test('builds a frozen, schema- and semantic-valid read-only candidate without a Profile claim', () => {
  const candidate = createMcpReadManifestCandidate(loadMcpConfig());
  assert.equal(candidate.claimed, false);
  assert.deepEqual(candidate.profiles, PHASE4B_MCP_READ_MANIFEST_PROFILES);
  assert.deepEqual(candidate.profiles, ['core']);
  assert.equal(candidate.protocolVersion, '2026-07-28');
  assert.equal(candidate.endpoint, 'https://collections.example.test/collections/-/mcp');

  const mount = candidate.manifest.mounts[0];
  assert.deepEqual(mount.profiles, ['core'], 'candidate must never declare mcp-read/mcp-write');
  assert.ok(!mount.profiles.includes('mcp-read' as never));
  assert.ok(!mount.profiles.includes('mcp-write' as never));
  assert.equal(mount.endpoints.mcp, 'https://collections.example.test/collections/-/mcp');
  // `tools: true` even without claims: authenticated read-only tools are
  // always served by the read surface (MCP-U-11).
  assert.deepEqual(mount.features.mcp, {
    protocolVersion: '2026-07-28',
    resources: true,
    tools: true,
  });
  assert.equal(mount.auth.anonymousRead, true);
  assert.equal(mount.auth.oauth, true);
  assert.equal(mount.auth.protectedResourceMetadata, 'https://collections.example.test/.well-known/oauth-protected-resource');

  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.manifest), true);
  assert.equal(Object.isFrozen(mount), true);
  assert.equal(Object.isFrozen(mount.endpoints), true);

  assert.equal(createValidatorRegistry().validate('manifest', candidate.manifest).valid, true);
  assert.deepEqual(validateManifestSemantics(candidate.manifest), { valid: true, issues: [] });
  assert.equal(isMcpReadManifestCandidateClosed(candidate), true);
});

test('candidate is serializable and deterministic, and never writes a live Manifest', () => {
  const candidate = createMcpReadManifestCandidate(loadMcpConfig());
  const json = JSON.stringify(candidate.manifest);
  const parsed = JSON.parse(json) as { mounts: Array<{ endpoints: Record<string, string> }> };
  assert.equal(parsed.mounts[0]?.endpoints.mcp, candidate.endpoint);
  // Pure/deterministic: rebuilding from the same config yields identical bytes.
  assert.equal(JSON.stringify(createMcpReadManifestCandidate(loadMcpConfig()).manifest), json);
});

test('candidate fails closed when the frozen config drifts', () => {
  const config = loadMcpConfig();
  assert.throws(
    () => createMcpReadManifestCandidate({ ...config, endpointPath: '/collections/-/mcp/v2' as never }),
    /frozen/u,
  );
  assert.throws(
    () => createMcpReadManifestCandidate({ ...config, serverUuid: 'not-a-uuid' }),
    /lowercase UUID/u,
  );
  assert.throws(
    () => createMcpReadManifestCandidate({ ...config, origin: 'https://other.example.test' }),
    /endpoint must stay on the configured origin/u,
  );
  assert.throws(
    () => createMcpReadManifestCandidate({ ...config, protocolVersion: '2025-11-25' as never }),
    /protocolVersion is fixed/u,
  );
  assert.throws(
    () => createMcpReadManifestCandidate({ ...config, budgets: { ...config.budgets, output: { ...config.budgets.output, maxDepth: 65 } } }),
    /MCP output maxDepth/u,
  );
});

test('runtime feature flags advertise mcp-read and mcp-write without official claims', () => {
  const readAdvertised = createMcpReadManifestCandidate(loadMcpConfig(), undefined, undefined, {
    advertiseRead: true,
  });
  assert.equal(readAdvertised.claimed, true);
  assert.deepEqual(readAdvertised.profiles, [...PHASE4B_MCP_READ_PROFILE_CLAIMS]);
  assert.equal(readAdvertised.manifest.title, 'Known MCP Read');
  assert.equal(isMcpReadManifestCandidateClosed(readAdvertised), false);

  const writeAdvertised = createMcpReadManifestCandidate(loadMcpConfig(), undefined, undefined, {
    advertiseWrite: true,
  });
  assert.equal(writeAdvertised.claimed, true);
  assert.deepEqual(writeAdvertised.profiles, [...PHASE4B_MCP_WRITE_PROFILE_CLAIMS]);
  assert.equal(writeAdvertised.manifest.title, 'Known MCP');
  assert.equal(writeAdvertised.manifest.mounts[0]!.endpoints.mcp, writeAdvertised.endpoint);
  assert.ok(writeAdvertised.manifest.mounts[0]!.endpoints.node);
  assert.equal(createValidatorRegistry().validate('manifest', writeAdvertised.manifest).valid, true);
  assert.deepEqual(validateManifestSemantics(writeAdvertised.manifest), { valid: true, issues: [] });
});

test('MCP-off closed state: the live Publication Manifest never declares MCP endpoint/features/profiles', () => {
  const candidate = createPublicationManifestCandidate(publicationConfig(), ['directory', 'collection', 'snapshot']);
  const mount = candidate.manifest.mounts[0];
  assert.deepEqual(mount.profiles, ['core']);
  assert.equal('mcp' in mount.endpoints, false);
  assert.equal(mount.features.mcp, undefined);
  assert.equal(PHASE4B_MCP_CONFIG_ENDPOINT_PATH, '/collections/-/mcp');
  assert.equal(PHASE4B_MCP_CONFIG_PROTOCOL_VERSION, '2026-07-28');
});
