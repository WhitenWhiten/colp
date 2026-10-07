import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { connect } from 'node:net';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { McpResourceNotFoundError } from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  McpOauthVerificationError,
  MCP_COMPAT_ENDPOINT_PATH,
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH,
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH,
  createMcpReadProtectedResourceMetadata,
  createPhase4bMcpChangeSignalSource,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
  type McpReadFeatureConfig,
  type McpReadProtectedResourceMetadata,
} from '../../../src/modules/mcp/index.js';
import {
  buildBetterAuthConfig,
  OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN_PREFIX,
  oauthAuthorizationServerMetadataPath,
} from '../../../src/modules/auth/better-auth-config.js';
import { createBetterAuthRuntime } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import { openBetterAuthPostgres } from '../../support/better-auth-postgres.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { mapMcpOauthChallengeToProductError } from '../../../src/transport/mcp/mcp-protected-resource-routes.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const BUILTIN_ISSUER = 'https://collections.example.test/api/v1/auth';
const BUILTIN_AS_METADATA_PATH = oauthAuthorizationServerMetadataPath();
const BUILTIN_AS_METADATA_URL =
  `https://collections.example.test${BUILTIN_AS_METADATA_PATH}`;

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: SERVER_UUID,
  LOG_LEVEL: 'silent',
};

function mcpEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  return {
    ...baseEnv,
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://app.example.test/api/v1/auth',
    MCP_OAUTH_AUDIENCE: 'https://collections.example.test/collections/-/mcp',
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://app.example.test/.well-known/oauth-authorization-server/api/v1/auth',
    MCP_OAUTH_JWKS_URI: 'https://app.example.test/api/v1/auth/jwks',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
    ...overrides,
  } as Record<string, string>;
}

const apps: FastifyInstance[] = [];
const fixtures: Array<{ close: () => Promise<void> }> = [];

function emptyResourceProjection(): Phase4bMcpCollectionResourceProjection {
  return Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function emptySnapshotResourceProjection(): Phase4bMcpSnapshotResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async readPage() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function emptyNodeResourceProjection(): Phase4bMcpNodeResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

function issuerOnEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  return {
    ...baseEnv,
    PRODUCT_ORIGIN: 'https://collections.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef1',
    BETTER_AUTH_OAUTH_ISSUER_ENABLED: 'true',
    MCP_OAUTH_ISSUER: BUILTIN_ISSUER,
    MCP_OAUTH_AUDIENCE: 'https://collections.example.test/collections/-/mcp',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: BUILTIN_AS_METADATA_URL,
    MCP_OAUTH_JWKS_URI: `${BUILTIN_ISSUER}/jwks`,
    ...overrides,
  } as Record<string, string>;
}

async function startApi(
  env: Record<string, string>,
  registerRoutes: (app: FastifyInstance, config: ReturnType<typeof loadConfig>) => void = () => {},
  betterAuthRuntime?: { readonly mount: (app: FastifyInstance) => void; readonly handle?: (request: Request) => Promise<Response> },
): Promise<{
  readonly app: FastifyInstance;
  readonly config: ReturnType<typeof loadConfig>;
  readonly origin: string;
}> {
  const config = loadConfig(env);
  const toolAdapter = emptyReadToolAdapterBundle();
  const app = buildApiApp({
    config,
    mcpReadTransport: {
      changeSignalSource: createPhase4bMcpChangeSignalSource(),
      readToolAdapter: toolAdapter.adapter,
      readToolParamDeclarations: toolAdapter.paramDeclarations,
    },
    mcpReadResourceProjection: emptyResourceProjection(),
    mcpNodeResourceProjection: emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
    ...(betterAuthRuntime === undefined ? {} : { betterAuthRuntime }),
  });
  registerRoutes(app, config);
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return { app, config, origin: `http://127.0.0.1:${address.port}` };
}

async function startIssuerApi(env: Record<string, string>) {
  const config = loadConfig(env);
  const built = buildBetterAuthConfig(config.betterAuth);
  if (!built) throw new Error('Better Auth settings expected');
  const fixture = await openBetterAuthPostgres(built);
  fixtures.push(fixture);
  const runtime = createBetterAuthRuntime({
    enabled: true,
    config: built,
    database: { db: fixture.db, type: 'postgres', transaction: true },
  });
  if (!runtime) throw new Error('Better Auth runtime expected');
  return startApi(env, () => {}, runtime);
}

function rawHttp(
  origin: string,
  headers: readonly string[],
): Promise<{ readonly status: number; readonly body: string }> {
  const url = new URL(PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH, origin);
  return new Promise((resolve, reject) => {
    const outgoing = rawRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: [...headers, 'Connection', 'close'],
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

function rawWire(
  origin: string,
  requestLine: string,
): Promise<{ readonly statusLine: string; readonly body: string }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let raw = '';
    socket.setEncoding('latin1');
    socket.once('connect', () => socket.end(`${requestLine}\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk: string) => {
      raw += chunk;
    });
    socket.once('end', () => resolve(parseRawHttpResponse(raw)));
    socket.once('error', reject);
  });
}

function parseRawHttpResponse(raw: string): { readonly statusLine: string; readonly body: string } {
  const separator = raw.indexOf('\r\n\r\n');
  const head = separator === -1 ? raw : raw.slice(0, separator);
  let body = separator === -1 ? '' : raw.slice(separator + 4);
  const lines = head.split('\r\n');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  if ((headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
    body = decodeChunked(body);
  }
  return { statusLine: lines[0] ?? '', body };
}

function decodeChunked(value: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < value.length) {
    const lineEnd = value.indexOf('\r\n', cursor);
    if (lineEnd === -1) break;
    const size = Number.parseInt(value.slice(cursor, lineEnd), 16);
    if (!Number.isFinite(size)) break;
    cursor = lineEnd + 2;
    result += value.slice(cursor, cursor + size);
    cursor += size + 2;
  }
  return result;
}

function cloneMcpConfig(config: ReturnType<typeof loadConfig>): ReturnType<typeof loadConfig> {
  return structuredClone(config) as ReturnType<typeof loadConfig>;
}

test('enabled production composition exposes exactly one OAuth protected resource metadata document', async () => {
  const server = await startApi(mcpEnv());
  const config = server.config.mcp;
  if (!config) throw new Error('MCP config expected');

  const response = await fetch(
    `${server.origin}${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH}`,
    { headers: { Origin: 'https://app.example.test' } },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const vary = response.headers.get('vary') ?? '';
  assert.match(vary, /\bAuthorization\b/u);
  assert.match(vary, /\bOrigin\b/u);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/u);

  const body = await response.json() as McpReadProtectedResourceMetadata;
  assert.deepEqual(Object.keys(body).sort(), [
    'authorization_servers',
    'jwks_uri',
    'resource',
    'scopes_supported',
  ]);
  assert.deepEqual(body, {
    resource: config.oauth.audience,
    authorization_servers: [config.oauth.issuer],
    scopes_supported: [...config.oauth.scopes, 'product:read', 'product:write', 'offline_access'],
    jwks_uri: config.oauth.jwksUri,
  });
  assert.equal(body.authorization_servers[0], 'https://app.example.test/api/v1/auth');
  assert.equal(body.authorization_servers[0], config.oauth.issuer);
  assert.notEqual(body.authorization_servers[0], config.oauth.authorizationServerMetadataUrl);
  assert.notEqual(
    body.authorization_servers[0],
    'https://app.example.test/.well-known/oauth-authorization-server/api/v1/auth',
  );
  assert.equal(createMcpReadProtectedResourceMetadata(config).resource, body.resource);

  const second = await fetch(`${server.origin}${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH}`);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), body);

  const alias = await fetch(`${server.origin}${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH}`);
  assert.equal(alias.status, 200);
  assert.equal(alias.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await alias.json(), body);
});

test('metadata URLs come from validated config, never request Host, Origin, or listener address', async () => {
  const server = await startApi(mcpEnv());
  const config = server.config.mcp;
  if (!config) throw new Error('MCP config expected');

  const forged = await rawWire(server.origin, [
    `GET ${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH} HTTP/1.1`,
    'Host: attacker.example',
    'Origin: https://attacker.example',
  ].join('\r\n'));
  assert.match(forged.statusLine, /^HTTP\/1\.1 200 /u);
  const body = JSON.parse(forged.body) as McpReadProtectedResourceMetadata;
  assert.equal(body.resource, config.oauth.audience);
  assert.deepEqual(body.authorization_servers, [config.oauth.issuer]);
  assert.notEqual(body.authorization_servers[0], config.oauth.authorizationServerMetadataUrl);
  assert.doesNotMatch(forged.body, /127\.0\.0\.1/u);
  assert.doesNotMatch(forged.body, /attacker\.example/u);

  const aliasForged = await rawWire(server.origin, [
    `GET ${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH} HTTP/1.1`,
    'Host: attacker.example',
    'Origin: https://attacker.example',
  ].join('\r\n'));
  assert.match(aliasForged.statusLine, /^HTTP\/1\.1 200 /u);
  assert.deepEqual(JSON.parse(aliasForged.body), body);
  assert.doesNotMatch(aliasForged.body, /127\.0\.0\.1|attacker\.example/u);
});

test('metadata route rejects query strings and non-GET methods without leaking the document', async () => {
  const server = await startApi(mcpEnv());
  const path = PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH;

  const queried = await fetch(`${server.origin}${path}?client_id=attacker`);
  assert.equal(queried.status, 400);
  assert.doesNotMatch(await queried.text(), /scopes_supported|authorization_servers|jwks_uri/u);

  const posted = await fetch(`${server.origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.get('allow'), 'GET');
  assert.doesNotMatch(await posted.text(), /scopes_supported|authorization_servers|jwks_uri/u);
});

test('raw duplicate singleton and Host headers fail closed without exposing metadata', async () => {
  const server = await startApi(mcpEnv());
  const path = PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH;

  for (const duplicate of ['Authorization', 'Origin'] as const) {
    const response = await rawHttp(server.origin, [
      duplicate,
      duplicate === 'Authorization' ? 'Bearer one' : 'https://app.example.test',
      duplicate,
      duplicate === 'Authorization' ? 'Bearer two' : 'https://app.example.test',
    ]);
    assert.equal(response.status, 400, duplicate);
    assert.doesNotMatch(response.body, /scopes_supported|authorization_servers|jwks_uri/u);
  }

  const duplicateHost = await rawWire(server.origin, [
    `GET ${path} HTTP/1.1`,
    'Host: attacker.example',
    'Host: attacker.example',
  ].join('\r\n'));
  assert.match(duplicateHost.statusLine, /^HTTP\/1\.1 400 /u);
  assert.doesNotMatch(duplicateHost.body, /scopes_supported|authorization_servers|jwks_uri/u);
});

test('OAuth challenge mapper produces stable 401/403 product errors without leaking config', async () => {
  const internalMarker = 'MCP-OAUTH-INTERNAL-MARKER';
  const server = await startApi(mcpEnv(), (app, config) => {
    const mcp = config.mcp;
    if (!mcp) throw new Error('MCP config expected');
    app.get('/__test/mcp-missing-scope', async () => {
      throw mapMcpOauthChallengeToProductError(
        new McpOauthVerificationError('missing_scope', internalMarker),
        mcp,
      );
    });
    app.get('/__test/mcp-invalid-token', async () => {
      throw mapMcpOauthChallengeToProductError(
        new McpOauthVerificationError('invalid_token', internalMarker),
        mcp,
      );
    });
  });
  const config = server.config.mcp;
  if (!config) throw new Error('MCP config expected');
  const strictResourceMetadata =
    `${config.origin}${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH}`;

  const missing = await fetch(`${server.origin}/__test/mcp-missing-scope`);
  const missingBody = await missing.text();
  assert.equal(missing.status, 403);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  const missingVary = missing.headers.get('vary') ?? '';
  assert.match(missingVary, /\bAuthorization\b/u);
  assert.match(missingVary, /\bOrigin\b/u);
  assert.equal(JSON.parse(missingBody).error.code, 'insufficient_permission');
  assert.equal(
    missing.headers.get('www-authenticate'),
    `Bearer error="insufficient_scope", scope="mcp:read:public mcp:read:own", resource_metadata="${strictResourceMetadata}"`,
  );
  assert.doesNotMatch(missingBody, new RegExp(internalMarker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.doesNotMatch(missingBody, /issuer\.example\.test/u);
  assert.doesNotMatch(missing.headers.get('www-authenticate') ?? '', /127\.0\.0\.1|attacker\.example/u);

  const invalid = await fetch(`${server.origin}/__test/mcp-invalid-token`);
  const invalidBody = await invalid.text();
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get('cache-control'), 'no-store');
  const invalidVary = invalid.headers.get('vary') ?? '';
  assert.match(invalidVary, /\bAuthorization\b/u);
  assert.match(invalidVary, /\bOrigin\b/u);
  assert.equal(JSON.parse(invalidBody).error.code, 'authentication_required');
  assert.equal(
    invalid.headers.get('www-authenticate'),
    `Bearer error="invalid_token", resource_metadata="${strictResourceMetadata}"`,
  );
  assert.equal(
    strictResourceMetadata,
    'https://collections.example.test/.well-known/oauth-protected-resource/collections/-/mcp',
  );
  assert.doesNotMatch(invalid.headers.get('www-authenticate') ?? '', /mcp:read/u);
  assert.doesNotMatch(invalidBody, new RegExp(internalMarker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.doesNotMatch(invalidBody, /issuer\.example\.test/u);
  assert.doesNotMatch(invalid.headers.get('www-authenticate') ?? '', /127\.0\.0\.1|attacker\.example/u);
});

test('flag off exposes no MCP metadata or endpoint routes', async () => {
  const server = await startApi(baseEnv);
  for (const path of [
    PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH,
    PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH,
    '/.well-known/mcp',
    '/.well-known/oauth-authorization-server',
    BUILTIN_AS_METADATA_PATH,
    '/collections/-/mcp',
  ]) {
    const response = await fetch(`${server.origin}${path}`);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /scopes_supported|authorization_servers|jwks_uri/u);
  }
});

test('metadata builder fails closed on validated config drift', () => {
  const config = loadConfig(mcpEnv()).mcp;
  if (!config) throw new Error('MCP config expected');

  const endpointDrift = cloneMcpConfig({ mcp: config }).mcp as McpReadFeatureConfig;
  (endpointDrift as { endpointPath: string }).endpointPath = '/collections/-/mcp-attacker';
  assert.throws(
    () => createMcpReadProtectedResourceMetadata(endpointDrift),
    /endpoint path is frozen/u,
  );

  const protocolDrift = cloneMcpConfig({ mcp: config }).mcp as McpReadFeatureConfig;
  (protocolDrift as { protocolVersion: string }).protocolVersion = '2025-11-25';
  assert.throws(
    () => createMcpReadProtectedResourceMetadata(protocolDrift),
    /protocolVersion is fixed/u,
  );

  const budgetDrift = cloneMcpConfig({ mcp: config }).mcp as McpReadFeatureConfig;
  (budgetDrift.budgets.output as { maxDepth: number }).maxDepth = 65;
  assert.throws(
    () => createMcpReadProtectedResourceMetadata(budgetDrift),
    /maxDepth/u,
  );

  const urlDrift = cloneMcpConfig({ mcp: config }).mcp as McpReadFeatureConfig;
  (urlDrift.oauth as { authorizationServerMetadataUrl: string })
    .authorizationServerMetadataUrl = 'not-a-url';
  assert.throws(
    () => createMcpReadProtectedResourceMetadata(urlDrift),
    /authorization server metadata URL/u,
  );
});

test('issuer off 404s AS metadata; the same request is 200 when issuer is on', async () => {
  const off = await startApi(mcpEnv());
  const offResponse = await fetch(`${off.origin}${BUILTIN_AS_METADATA_PATH}`);
  assert.equal(offResponse.status, 404);
  assert.doesNotMatch(await offResponse.text(), /scopes_supported|authorization_servers|jwks_uri/u);

  const on = await startIssuerApi(issuerOnEnv(mcpEnv({
    MCP_OAUTH_ISSUER: BUILTIN_ISSUER,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: BUILTIN_AS_METADATA_URL,
    MCP_OAUTH_JWKS_URI: `${BUILTIN_ISSUER}/jwks`,
  })));
  const onResponse = await fetch(`${on.origin}${BUILTIN_AS_METADATA_PATH}`);
  assert.equal(onResponse.status, 200, 'positive control: issuer-on must expose AS metadata');
  assert.equal(onResponse.headers.get('cache-control'), 'no-store');
  const body = await onResponse.json() as { issuer?: string };
  assert.equal(body.issuer, BUILTIN_ISSUER);
});

test('AS metadata issuer is MCP_OAUTH_ISSUER and ignores Host or Origin', async () => {
  const server = await startIssuerApi(issuerOnEnv(mcpEnv({
    MCP_OAUTH_ISSUER: BUILTIN_ISSUER,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: BUILTIN_AS_METADATA_URL,
    MCP_OAUTH_JWKS_URI: `${BUILTIN_ISSUER}/jwks`,
  })));
  const response = await fetch(`${server.origin}${BUILTIN_AS_METADATA_PATH}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json() as { issuer?: string };
  assert.equal(body.issuer, server.config.mcp?.oauth.issuer);
  assert.equal(body.issuer, BUILTIN_ISSUER);

  const forged = await rawWire(server.origin, [
    `GET ${BUILTIN_AS_METADATA_PATH} HTTP/1.1`,
    'Host: attacker.example',
    'Origin: https://attacker.example',
  ].join('\r\n'));
  assert.match(forged.statusLine, /^HTTP\/1\.1 200 /u);
  assert.equal((JSON.parse(forged.body) as { issuer?: string }).issuer, BUILTIN_ISSUER);
  assert.doesNotMatch(forged.body, /127\.0\.0\.1|attacker\.example/u);

  const mcpPrm = await fetch(`${server.origin}/api/v1/auth/.well-known/oauth-protected-resource`);
  assert.equal(mcpPrm.status, 404, 'mcp() PRM must not be a public dual authority');

  const asCompatAlias = await fetch(
    `${server.origin}${OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN_PREFIX}${MCP_COMPAT_ENDPOINT_PATH}`,
  );
  assert.equal(asCompatAlias.status, 404, 'AS well-known must not grow a mcp-compat alias');
});

test('MCP off and issuer on 404s PRM while AS metadata exists', async () => {
  const server = await startIssuerApi(issuerOnEnv());
  for (const path of [
    PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH,
    PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH,
  ]) {
    const prm = await fetch(`${server.origin}${path}`);
    assert.equal(prm.status, 404, path);
    assert.doesNotMatch(await prm.text(), /scopes_supported|authorization_servers|jwks_uri/u);
  }
  const asMetadata = await fetch(`${server.origin}${BUILTIN_AS_METADATA_PATH}`);
  assert.equal(asMetadata.status, 200);
  assert.equal(asMetadata.headers.get('cache-control'), 'no-store');
  assert.equal((await asMetadata.json() as { issuer?: string }).issuer, BUILTIN_ISSUER);
});
