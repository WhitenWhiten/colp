/** HTTP harness for MCP-W06 write-tool unit tests. Not a test file. */
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type KeyLike,
} from 'jose';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpResourceNotFoundError,
  type McpAuthenticatedAuthorizationBinding,
} from '@know-n/colp/mcp';
import { loadConfig } from './test-config.js';
import {
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  createMcpOauthVerifier,
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpRequestContext,
  type McpOauthVerifier,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../src/modules/mcp/index.js';
import type { JwksProvider } from '../../src/modules/identity/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import type { McpReadTransportDependencies } from '../../src/transport/mcp/mcp-read-routes.js';
import { emptyReadToolAdapterBundle } from './phase4b-mcp-read-tools-fixture.js';
import { mcpHttpPost, withMcpTestHost } from './phase4b-mcp-transport-scaffold.js';
import type { InMemoryWriteToolFixture } from './phase4b-mcp-write-tools-fixture.js';

export const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
export const NOW = new Date('2026-08-06T08:00:00.000Z');
export const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
export const ISSUER = 'https://issuer.example.test/realms/known';
export const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
export const CLIENT_ID = 'mcp-write-client';
export const READ_SCOPES = ['mcp:read:public', 'mcp:read:own'] as const;
export const WRITE_SCOPES = [
  ...READ_SCOPES,
  'nodes:write',
  'collections:create',
  'collections:write',
  'annotations:write',
  'access:write',
  'changes:commit',
  'changes:cancel',
] as const;

export const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: SERVER_UUID,
  LOG_LEVEL: 'silent',
};

export function mcpEnv(scopes: readonly string[] = READ_SCOPES): Record<string, string> {
  return {
    ...baseEnv,
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: ISSUER,
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    // FIX-M-016 acceptance: loadConfig requires a coherent OIDC issuer/JWKS
    // triple whenever the test provider is disabled; the suite never fetches
    // this endpoint (the MCP verifier is injected), so an HTTPS test URI is
    // sufficient to boot the real API surface.
    OIDC_ISSUER: ISSUER,
    OIDC_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: scopes.join(','),
  } as Record<string, string>;
}

export const apps: FastifyInstance[] = [];

export async function closeWriteToolApps(): Promise<void> {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
}

export interface TestServer {
  readonly app: FastifyInstance;
  readonly config: ReturnType<typeof loadConfig>;
  readonly origin: string;
}

export async function startApi(
  env: Record<string, string>,
  auth: { readonly verifier: McpOauthVerifier },
  writeFixture: InMemoryWriteToolFixture,
  dependencies: McpReadTransportDependencies = {},
): Promise<TestServer> {
  const config = loadConfig(env);
  const source = dependencies.changeSignalSource ?? createPhase4bMcpChangeSignalSource();
  const readSurface = emptyReadToolAdapterBundle();
  const app = buildApiApp({
    config,
    mcpReadTransport: {
      changeSignalSource: source,
      readToolAdapter: readSurface.adapter,
      readToolParamDeclarations: readSurface.paramDeclarations,
      oauthVerifier: auth.verifier,
      writeToolAdapter: writeFixture.bundle.adapter,
      writeToolParamDeclarations: writeFixture.bundle.paramDeclarations,
      ...dependencies,
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

export function modernBody(
  method: string,
  id: number | string | null,
  params: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {
          tools: { call: true },
        },
        'io.modelcontextprotocol/clientInfo': {
          name: 'known-w06-test',
          version: '1.0.0',
        },
      },
      ...params,
    },
  });
}

export async function postJson(
  server: TestServer,
  method: string,
  id: number | string | null,
  init: RequestInit = {},
): Promise<Response> {
  return mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': method,
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json;q=1, text/event-stream;q=0.5',
      ...(init.headers as Record<string, string> | undefined),
    }, server.config.publication.origin),
    (init.body as string | Uint8Array | undefined) ?? modernBody(method, id),
    init.signal ?? undefined,
  );
}

export function parseJsonRpc(body: string): {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
} {
  return JSON.parse(body) as {
    result?: Record<string, unknown>;
    error?: { code?: number; message?: string; data?: unknown };
  };
}

export async function createKeyFixture(kid: string): Promise<{
  readonly kid: string;
  readonly privateKey: KeyLike;
  readonly jwk: Record<string, unknown>;
}> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid, alg: 'RS256', use: 'sig' });
  return { kid, privateKey: pair.privateKey, jwk };
}

export function staticJwksProvider(keys: readonly Record<string, unknown>[]): JwksProvider {
  return {
    async getKeySet(): Promise<JSONWebKeySet> {
      return { keys: [...keys] } as JSONWebKeySet;
    },
  };
}

export async function mintCredential(input: {
  readonly key: KeyLike;
  readonly kid: string;
  readonly scopes: readonly string[];
  readonly subject?: string;
  readonly jti?: string;
}): Promise<string> {
  return new SignJWT({
    scope: input.scopes.join(' '),
    client_id: CLIENT_ID,
  })
    .setProtectedHeader({ alg: 'RS256', kid: input.kid })
    .setIssuer(ISSUER)
    .setSubject(input.subject ?? 'urn:known:subject:alice')
    .setAudience(AUDIENCE)
    .setIssuedAt(NOW_SECONDS - 5)
    .setExpirationTime(NOW_SECONDS + 3_600)
    .setJti(input.jti ?? 'w06-credential-jti-1')
    .sign(input.key);
}

export async function authFixture(
  scopes: readonly string[],
  overrides: { readonly subject?: string; readonly jti?: string } = {},
): Promise<{ readonly verifier: McpOauthVerifier; readonly token: string }> {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scopes,
    ...overrides,
  });
  const verifier = createMcpOauthVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    allowedScopes: [...scopes],
    jwks: staticJwksProvider([key.jwk]),
    isRevoked: async () => false,
    securityEpoch: async () => 'epoch-1',
    now: () => NOW,
    clockToleranceSeconds: 0,
    resolveAccountBySubject: async (sub) => ({
      id: `account:${sub}`,
      subjectId: sub,
      status: 'active',
    }),
  });
  return { verifier, token };
}

export function directContext(
  binding: McpAuthenticatedAuthorizationBinding,
  scope: readonly string[],
) {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
      Object.freeze({ name: 'Mcp-Name', value: 'changes.plan' }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: Object.freeze({
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': Object.freeze({}),
        }),
        name: 'changes.plan',
      }),
    }),
    binding,
    scope,
    authorization: Object.freeze({ accountSubjectId: binding.principalId }),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
  });
}

export function planArguments() {
  return {
    operations: [{
      type: 'set_visibility',
      collectionId: 'collection-1',
      baseRevision: 'resource-r1',
      input: { visibility: 'protected' },
    }],
    reason: 'publish this node',
    dryRun: true,
  };
}

export function commitArguments(planId: string, idempotencyKey = 'idem-w06') {
  return { planId, idempotencyKey };
}
export function nodeCreateArguments(title = 'W06 bookmark') {
  return {
    collectionId: 'collection-1',
    parentId: 'root-1',
    node: {
      kind: 'bookmark',
      title,
      url: 'https://example.test/w06',
      description: null,
      tags: ['w06'],
      visibility: 'private',
    },
    reason: 'create bookmark',
    confirmApply: true,
  };
}

export async function verifiedBinding(auth: {
  readonly verifier: McpOauthVerifier;
  readonly token: string;
}) {
  const verified = await auth.verifier.verify({ authorization: `Bearer ${auth.token}` });
  return verified.binding;
}
