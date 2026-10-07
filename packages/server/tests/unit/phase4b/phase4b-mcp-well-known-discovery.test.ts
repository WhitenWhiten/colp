import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { McpResourceNotFoundError } from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH,
  PHASE4B_MCP_WELL_KNOWN_ANONYMOUS_TOOLS,
  PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH,
  createMcpWellKnownDiscoveryDocument,
  createPhase4bMcpChangeSignalSource,
  type McpReadFeatureConfig,
  type McpWellKnownDiscoveryDocument,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import { buildApiApp } from '../../../src/transport/app.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';

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
});

async function startApi(env: Record<string, string>): Promise<{
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
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return { app, config, origin: `http://127.0.0.1:${address.port}` };
}

function expectedDiscovery(config: McpReadFeatureConfig): McpWellKnownDiscoveryDocument {
  return {
    endpoint: config.endpoint,
    transport: 'streamable-http',
    protocolVersion: config.protocolVersion,
    documentation: `${config.origin}/mcp`,
    oauthProtectedResourceMetadata:
      `${config.origin}${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH}`,
    anonymous: { resources: true, tools: PHASE4B_MCP_WELL_KNOWN_ANONYMOUS_TOOLS },
  };
}

function rawHttp(
  origin: string,
  headers: readonly string[],
): Promise<{ readonly status: number; readonly body: string }> {
  const url = new URL(PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH, origin);
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

test('anonymous GET /.well-known/mcp returns 200 JSON matching loaded config', async () => {
  const server = await startApi(mcpEnv());
  const config = server.config.mcp;
  if (!config) throw new Error('MCP config expected');

  const response = await fetch(`${server.origin}${PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/u);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const body = await response.json() as McpWellKnownDiscoveryDocument;
  assert.deepEqual(body, expectedDiscovery(config));
  assert.deepEqual(body, createMcpWellKnownDiscoveryDocument(config));
  assert.equal(body.endpoint, config.endpoint);
  assert.equal(body.transport, 'streamable-http');
  assert.equal(body.protocolVersion, config.protocolVersion);
  assert.equal(body.documentation, `${config.origin}/mcp`);
  assert.equal(
    body.oauthProtectedResourceMetadata,
    `${config.origin}${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH}`,
  );
  assert.deepEqual(body.anonymous, { resources: true, tools: true });
  assert.doesNotMatch(body.endpoint, /know-n\.com/u);
});

test('discovery URLs come from validated config, never request Host or Origin', async () => {
  const server = await startApi(mcpEnv());
  const config = server.config.mcp;
  if (!config) throw new Error('MCP config expected');

  const forged = await rawHttp(server.origin, [
    'Host', 'attacker.example',
    'Origin', 'https://attacker.example',
  ]);
  assert.equal(forged.status, 200);
  const body = JSON.parse(forged.body) as McpWellKnownDiscoveryDocument;
  assert.deepEqual(body, expectedDiscovery(config));
  assert.doesNotMatch(forged.body, /127\.0\.0\.1/u);
  assert.doesNotMatch(forged.body, /attacker\.example/u);
  assert.doesNotMatch(forged.body, /know-n\.com/u);
});

test('flag off exposes no /.well-known/mcp document', async () => {
  const server = await startApi(baseEnv);
  const response = await fetch(`${server.origin}${PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH}`);
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /streamable-http|oauthProtectedResourceMetadata/u);
});
