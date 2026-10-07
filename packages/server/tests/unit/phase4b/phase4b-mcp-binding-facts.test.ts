import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import {
  digestPhase4bMcpColpClosure,
  parsePrintedRoutes,
  phase4bMcpReadConfigDigest,
  phase4bMcpReadConfigProjection,
  phase4bMcpWriteConfigDigest,
  phase4bMcpWriteConfigProjection,
} from '../../../scripts/phase4b-mcp-binding-facts.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const OTHER_SERVER_UUID = '119b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const READ_SECRET = Buffer.alloc(32, 77).toString('base64');
const RETAINED_SECRET = Buffer.alloc(32, 88).toString('base64');
const REQUEST_STATE_KEY = Buffer.alloc(32, 99).toString('base64');
const ROUTES = '├── /health (GET, HEAD)\n└── /collections/-/mcp (POST)\n';

test('read config projection is stable, covers actual config, and uses runtime endpoints/routes', () => {
  const config = readConfig();
  const facts = { origin: 'https://collections.example.test', config, routes: ROUTES };
  const first = phase4bMcpReadConfigProjection(facts);
  const second = phase4bMcpReadConfigProjection(facts);

  assert.deepEqual(first, second);
  assert.equal(first.origin, facts.origin);
  assert.equal(first.productOrigin, config.productOrigin);
  assert.equal(first.endpointPath, config.mcp?.endpointPath);
  assert.equal(first.endpoint, config.mcp?.endpoint);
  assert.equal(first.serverUuid, config.mcp?.serverUuid);
  assert.equal(first.protocolVersion, '2026-07-28');
  assert.equal(first.requestRateLimit.maxRequests, config.mcp?.requestRateLimit.maxRequests);
  assert.equal(first.collectionResources.cursorKeys.active.secretDigest, sha256(READ_SECRET));
  assert.equal(first.oauth.issuer, config.mcp?.oauth.issuer);
  assert.equal('clientId' in first.oauth, false);
  assert.equal(first.endpoints.includes(config.publication.endpoints.directory), true);
  assert.equal(first.endpoints.includes(config.mcp!.endpoint), true);
  assert.notDeepEqual(first.endpoints, ['mcp']);
  assert.deepEqual(first.routes, ['/collections/-/mcp', '/health']);
  assert.equal(first.ports.includes('client'), true);
  assert.equal(first.ports.includes('mcp'), true);
});

test('read config digest is stable and changes with actual config fields', () => {
  const base = {
    origin: 'https://collections.example.test',
    config: readConfig(),
    routes: ROUTES,
  };
  const baseline = phase4bMcpReadConfigDigest(base);
  assert.equal(baseline, phase4bMcpReadConfigDigest({
    ...base,
    config: readConfig(),
  }));
  assert.notEqual(phase4bMcpReadConfigDigest({
    ...base,
    routes: '└── /other (GET)\n',
  }), baseline);
  assert.notEqual(phase4bMcpReadConfigDigest({
    ...base,
    origin: 'https://collections-other.example.test',
  }), baseline);

  const variants = [
    () => readConfig({ MCP_REQUEST_MAX_BODY_BYTES: '32768' }),
    () => readConfig({ MCP_REQUEST_RATE_LIMIT_MAX: '60' }),
    () => readConfig({ MCP_COLLECTION_RESOURCE_CURSOR_TTL_MS: '600000' }),
    // Issuer and JWKS URI must share an origin (T-06 / T-08), so the issuer
    // variant moves both to the new origin.
    () => readConfig({
      MCP_OAUTH_ISSUER: 'https://issuer-other.example.test/realms/known',
      MCP_OAUTH_JWKS_URI: 'https://issuer-other.example.test/realms/known/protocol/openid-connect/certs',
    }),
    () => readConfig({ PUBLICATION_ORIGIN: 'https://collections-other.example.test' }),
    () => readConfig({
      PUBLICATION_SERVER_UUID: OTHER_SERVER_UUID,
      MCP_SERVER_UUID: OTHER_SERVER_UUID,
    }),
  ];
  for (const makeConfig of variants) {
    assert.notEqual(
      phase4bMcpReadConfigDigest({ ...base, config: makeConfig() }),
      baseline,
    );
  }
});

test('write config projection covers MCP Write fields and changes with actual config', () => {
  const config = writeConfig();
  const facts = { origin: 'https://collections.example.test', config, routes: ROUTES };
  const projection = phase4bMcpWriteConfigProjection(facts);

  assert.equal(projection.origin, facts.origin);
  assert.equal(projection.write.requestStateKeyDigest, sha256(REQUEST_STATE_KEY));
  assert.equal(projection.write.approvalBaseUri, config.mcpWrite?.approvalBaseUri);
  assert.equal(projection.write.planTtlMilliseconds, config.mcpWrite?.planTtlMilliseconds);
  assert.deepEqual(projection.write.commitRateLimit, config.mcpWrite?.commitRateLimit);
  assert.equal(projection.write.maintenanceIntervalMs, config.mcpWrite?.maintenanceIntervalMs);
  assert.equal(projection.endpoints.includes(config.publication.endpoints.directory), true);
  assert.equal(projection.routes.includes('/collections/-/mcp'), true);
  assert.equal(projection.ports.includes('publisher'), true);
  assert.equal(projection.ports.includes('approval'), true);

  const base = facts;
  const baseline = phase4bMcpWriteConfigDigest(base);
  assert.notEqual(phase4bMcpWriteConfigDigest({
    ...base,
    routes: '└── /other (GET)\n',
  }), baseline);
  assert.notEqual(phase4bMcpWriteConfigDigest({
    ...base,
    origin: 'https://collections-other.example.test',
  }), baseline);
  const variants = [
    () => writeConfig({ MCP_WRITE_APPROVAL_BASE_URI: 'https://app.example.test/approvals/other' }),
    () => writeConfig({ MCP_WRITE_PLAN_TTL_MS: '600000' }),
    () => writeConfig({
      MCP_WRITE_COMMIT_RATE_LIMIT_MAX: '7',
      MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS: '1000',
    }),
    () => writeConfig({ MCP_WRITE_MAINTENANCE_INTERVAL_MS: '45000' }),
    () => writeConfig({
      PUBLICATION_SERVER_UUID: OTHER_SERVER_UUID,
      MCP_SERVER_UUID: OTHER_SERVER_UUID,
    }),
  ];
  for (const makeConfig of variants) {
    assert.notEqual(
      phase4bMcpWriteConfigDigest({ ...base, config: makeConfig() }),
      baseline,
    );
  }
});

test('config projections never expose secret key material or secret refs', () => {
  const readFacts = {
    origin: 'https://collections.example.test',
    config: readConfig(),
    routes: ROUTES,
  };
  const writeFacts = {
    origin: 'https://collections.example.test',
    config: writeConfig(),
    routes: ROUTES,
  };
  const readJson = JSON.stringify(phase4bMcpReadConfigProjection(readFacts));
  const writeJson = JSON.stringify(phase4bMcpWriteConfigProjection(writeFacts));

  for (const secret of [READ_SECRET, RETAINED_SECRET, REQUEST_STATE_KEY, '${MCP_OAUTH_CLIENT_SECRET}']) {
    assert.equal(readJson.includes(secret), false, `read projection leaked ${secret}`);
    assert.equal(writeJson.includes(secret), false, `write projection leaked ${secret}`);
  }
});

test('parsePrintedRoutes extracts Fastify absolute route paths', () => {
  assert.deepEqual(parsePrintedRoutes(ROUTES), ['/collections/-/mcp', '/health']);
});

test('colp closure digest is recursive and changes with transitive mcp/conformance source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phase4b-colp-closure-'));
  try {
    for (const directory of [
      'dist/client',
      'dist/mcp',
      'dist/conformance/generated',
      'dist/security',
      'dist/schema',
      'dist/semantic',
      'dist/server',
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, 'package.json'), '{}\n');
    writeFileSync(join(root, 'package-lock.json'), '{}\n');
    writeFileSync(join(root, 'dist/mcp/index.ts'), 'export const mcp = 1;\n');
    writeFileSync(join(root, 'dist/conformance/index.ts'), 'export const conformance = 1;\n');
    writeFileSync(join(root, 'dist/conformance/generated/evidence.json'), '{}\n');
    writeFileSync(join(root, 'dist/conformance/generated/mcp-2026-07-28-sdk-accepted.json'), '{}\n');
    writeFileSync(join(root, 'dist/conformance/generated/mcp-conformance-candidate.json'), '{}\n');
    writeFileSync(join(root, 'dist/conformance/generated/requirements.json'), '{}\n');
    writeFileSync(join(root, 'dist/security/index.ts'), 'export const security = 1;\n');
    writeFileSync(join(root, 'dist/schema/index.ts'), 'export const schema = 1;\n');
    writeFileSync(join(root, 'dist/server/index.ts'), 'export const server = 1;\n');
    writeFileSync(join(root, 'dist/client/index.ts'), 'export const client = 1;\n');
    writeFileSync(join(root, 'dist/semantic/index.ts'), 'export const semantic = 1;\n');

    const domain = 'known.r14.colp.v1';
    const baseline = await digestPhase4bMcpColpClosure(root, domain);
    assert.equal(await digestPhase4bMcpColpClosure(root, domain), baseline);

    writeFileSync(join(root, 'dist/semantic/index.ts'), 'export const semantic = 2;\n');
    const afterSemantic = await digestPhase4bMcpColpClosure(root, domain);
    assert.notEqual(afterSemantic, baseline);

    writeFileSync(join(root, 'dist/mcp/new-file.ts'), 'export const newFile = true;\n');
    const afterMcp = await digestPhase4bMcpColpClosure(root, domain);
    assert.notEqual(afterMcp, afterSemantic);

    writeFileSync(join(root, 'dist/conformance/generated/evidence.json'), '{"changed":true}\n');
    const afterGenerated = await digestPhase4bMcpColpClosure(root, domain);
    assert.notEqual(afterGenerated, afterMcp);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read/write adapters wire route set and full colp closure into repository bindings', () => {
  for (const file of [
    resolve('scripts/phase4b-mcp-read-acceptance-adapter.ts'),
    resolve('scripts/phase4b-mcp-write-acceptance-adapter.ts'),
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /app\.printRoutes\(\{ commonPrefix: false \}\)/u);
    assert.match(source, /digestPhase4bMcpColpClosure/u);
    assert.match(source, /phase4bMcp(Read|Write)ConfigDigest/u);
    assert.match(source, /parsePrintedRoutes/u);
    assert.match(source, /routes/u);
  }
});

function readConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    PRODUCT_ORIGIN: 'https://app.example.test',
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
    MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_KEY_ID: 'mcp-collection-resource-v1',
    MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_SECRET: READ_SECRET,
    MCP_COLLECTION_RESOURCE_CURSOR_RETAINED_KEYS: JSON.stringify([
      { id: 'retained-v1', secret: RETAINED_SECRET },
    ]),
    ...overrides,
  });
}

function writeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    PRODUCT_ORIGIN: 'https://app.example.test',
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
    MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_KEY_ID: 'mcp-collection-resource-v1',
    MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_SECRET: READ_SECRET,
    MCP_COLLECTION_RESOURCE_CURSOR_RETAINED_KEYS: JSON.stringify([
      { id: 'retained-v1', secret: RETAINED_SECRET },
    ]),
    MCP_WRITE_REQUEST_STATE_KEY: REQUEST_STATE_KEY,
    MCP_WRITE_APPROVAL_BASE_URI: 'https://app.example.test/approvals',
    MCP_WRITE_PLAN_TTL_MS: '900000',
    MCP_WRITE_COMMIT_RATE_LIMIT_MAX: '60',
    MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS: '60000',
    MCP_WRITE_MAINTENANCE_INTERVAL_MS: '60000',
    ...overrides,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
