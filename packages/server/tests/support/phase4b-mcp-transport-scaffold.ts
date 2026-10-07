/**
 * Shared scaffold for the phase4b MCP transport suite
 * (tests/unit/phase4b/phase4b-mcp-transport.test.ts): env fixtures,
 * projections, server bootstrap, HTTP/JSON-RPC helpers, and OAuth
 * credential fixtures. The test file registers its own afterEach that
 * closes the `apps` this scaffold accumulates.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { connect as rawConnect } from 'node:net';
import { Readable } from 'node:stream';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type KeyLike,
} from 'jose';
import type { FastifyInstance } from 'fastify';
import { McpResourceNotFoundError } from '@know-n/colp/mcp';
import { loadConfig } from './test-config.js';
import {
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpReadToolAdapter,
  createMcpOauthVerifier,
  createPhase4bMcpReadOperations,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpReadOperations,
  type Phase4bMcpSnapshotResourceProjection,
  type McpOauthVerifier,
  type McpOauthVerifierOptions,
} from '../../src/modules/mcp/index.js';
import { emptyReadToolAdapterBundle } from './phase4b-mcp-read-tools-fixture.js';
import type { JwksProvider } from '../../src/modules/identity/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import { InMemoryMetrics } from '../../src/infrastructure/telemetry/index.js';
import type { McpReadTransportDependencies } from '../../src/transport/mcp/mcp-read-routes.js';
import { mcpTrustedRequestHostHeader } from '../../src/transport/mcp/mcp-shared-admission.js';
import {
  waitForCondition,
  waitForRealTime,
  withRealTimeout,
} from './async-test-helpers.js';

export const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
/** Host that matches `baseEnv.PUBLICATION_ORIGIN` (`https://collections.example.test`). */
export const MCP_TEST_REQUEST_HOST = 'collections.example.test';
export const NOW = new Date('2026-08-05T08:00:00.000Z');
export const ISSUER = 'https://app.example.test/api/v1/auth';
export const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
export const CLIENT_ID = 'known-mcp-oauth-client';
export const SCOPES = ['mcp:read:public', 'mcp:read:own'];
export const WRITE_SCOPES = ['access:write', 'nodes:write', 'changes:plan', 'changes:commit', 'changes:cancel'];
export const SUBJECT = 'urn:known:subject:alice';
export const ACCOUNT_ID = 'account-alice-1';

export const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: SERVER_UUID,
  LOG_LEVEL: 'silent',
};

export function mcpEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...baseEnv,
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: ISSUER,
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://app.example.test/.well-known/oauth-authorization-server/api/v1/auth',
    MCP_OAUTH_JWKS_URI: `${ISSUER}/jwks`,
    MCP_OAUTH_SCOPES: SCOPES.join(','),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export const apps: FastifyInstance[] = [];

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function prodEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const oidcKey = Buffer.alloc(32, 5).toString('base64');
  const prodServerUuid = '019f9031-c541-74d0-bc83-15a5526fbb54';
  return {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'production',
    PRODUCT_ORIGIN: 'https://app.example.test',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_JWKS_URI: 'https://issuer.example/jwks',
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_EDITOR_CURSOR_KEY_ID: 'prod-editor-v1',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'prod-owned-v1',
    PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_LINK_HEALTH_CURSOR_KEY_ID: 'prod-link-health-v1',
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
    PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-visitor-hmac-key-32b',
    PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-ratelimit-hmac-key-32b',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'prod-collaboration-invite-rate-limit-hmac',
    PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'keyed',
    OIDC_TRANSACTION_HMAC_SECRET: 'prod-hmac-secret-not-dev-default',
    OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${oidcKey}`,
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    PUBLICATION_SERVER_UUID: prodServerUuid,
    PUBLICATION_CURSOR_ACTIVE_KEY_ID: 'prod-publication-v1',
    PUBLICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 17).toString('base64'),
    FOLLOW_CURSOR_ACTIVE_KEY_ID: 'prod-follow-v1',
    FOLLOW_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 19).toString('base64'),
    FEED_CURSOR_ACTIVE_KEY_ID: 'prod-feed-v1',
    FEED_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 21).toString('base64'),
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_KEY_ID: 'prod-public-activity-v1',
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 27).toString('base64'),
    NOTIFICATION_CURSOR_ACTIVE_KEY_ID: 'prod-notification-v1',
    NOTIFICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 23).toString('base64'),
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 37).toString('base64'),
    COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 43).toString('base64'),
    OIDC_ALLOW_TEST_PROVIDER: 'false',
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: prodServerUuid,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: ISSUER,
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://app.example.test/.well-known/oauth-authorization-server/api/v1/auth',
    MCP_OAUTH_JWKS_URI: `${ISSUER}/jwks`,
    MCP_OAUTH_SCOPES: SCOPES.join(','),
    MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_KEY_ID: 'prod-mcp-collection-v1',
    MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 31).toString('base64'),
    MCP_REQUEST_RATE_LIMIT_MAX: '120',
    MCP_REQUEST_RATE_LIMIT_WINDOW_MS: '60000',
    MCP_OAUTH_REVOCATION_STORE: 'postgres',
    ...overrides,
  };
}

export function emptyResourceProjection(): Phase4bMcpCollectionResourceProjection {
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

export function emptySnapshotResourceProjection(): Phase4bMcpSnapshotResourceProjection {
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

export function emptyNodeResourceProjection(): Phase4bMcpNodeResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

export function toolCollectionProjection(): Phase4bMcpCollectionResourceProjection {
  return Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource(input) {
      if (input.resource.collectionId === 'private-collection') {
        throw new McpResourceNotFoundError();
      }
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: 'application/vnd.collection-protocol.collection+json',
            text: JSON.stringify({
              collection: Object.freeze({
                id: input.resource.collectionId,
                title: 'Public <script>alert(1)</script>',
                visibility: 'public',
                updatedAt: '2026-08-05T08:00:00.000Z',
              }),
            }),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

export function toolSnapshotProjection(): Phase4bMcpSnapshotResourceProjection {
  return Object.freeze({
    async readResource(input) {
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: 'application/vnd.collection-protocol.snapshot+json',
            text: JSON.stringify({
              type: 'collection_snapshot_summary',
              complete: false,
              collection: Object.freeze({
                id: input.resource.collectionId,
                title: 'Snapshot 1',
                updatedAt: '2026-08-05T08:00:00.000Z',
              }),
              resourceLink: Object.freeze({
                type: 'resource_link',
                name: 'Collection snapshot',
                mimeType: 'application/vnd.collection-protocol.snapshot+json',
              }),
            }),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async readPage() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

export function hostToolSurface() {
  return createPhase4bMcpReadToolAdapter({
    collectionProjection: toolCollectionProjection(),
    snapshotProjection: toolSnapshotProjection(),
    nodeProjection: emptyNodeResourceProjection(),
    serverUuid: SERVER_UUID,
  });
}

export function gatedToolSurface() {
  const baseCollectionProjection = toolCollectionProjection();
  return createPhase4bMcpReadToolAdapter({
    collectionProjection: Object.freeze({
      ...baseCollectionProjection,
      async readResource() {
        return new Promise<never>(() => {});
      },
    }),
    snapshotProjection: toolSnapshotProjection(),
    nodeProjection: emptyNodeResourceProjection(),
    serverUuid: SERVER_UUID,
  });
}

export interface TestServer {
  readonly app: FastifyInstance;
  readonly config: ReturnType<typeof loadConfig>;
  readonly origin: string;
}

export async function startApi(
  env: Record<string, string>,
  dependencies: McpReadTransportDependencies = {},
  toolAdapter = emptyReadToolAdapterBundle(),
): Promise<TestServer> {
  const config = loadConfig(env);
  const source = dependencies.changeSignalSource ?? createPhase4bMcpChangeSignalSource();
  const app = buildApiApp({
    config,
    mcpReadOperations: dependencies.operations,
    mcpReadTransport: {
      ...dependencies,
      readToolAdapter: toolAdapter.adapter,
      readToolParamDeclarations: toolAdapter.paramDeclarations,
      changeSignalSource: source,
    },
    mcpReadResourceProjection: emptyResourceProjection(),
    mcpNodeResourceProjection: dependencies.nodeResourceProjection ?? emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: dependencies.snapshotResourceProjection ?? emptySnapshotResourceProjection(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return { app, config, origin: `http://127.0.0.1:${address.port}` };
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
          name: 'known-r06-test',
          version: '1.0.0',
        },
      },
      ...params,
    },
  });
}

export function mcpTestHostHeader(
  origin: string = baseEnv.PUBLICATION_ORIGIN,
): string {
  return mcpTrustedRequestHostHeader(origin);
}

export function withMcpTestHost(
  headers: Record<string, string>,
  origin: string = baseEnv.PUBLICATION_ORIGIN,
): Record<string, string> {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'host') return headers;
  }
  return { host: mcpTestHostHeader(origin), ...headers };
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error('aborted');
}

/** Node `fetch` strips Host; MCP admission needs the configured origin Host. */
export function mcpHttpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | Uint8Array = '',
  signal?: AbortSignal,
): Promise<Response> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    let settled = false;
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
    }, (res) => {
      if (settled) return;
      settled = true;
      const headerInit = new Headers();
      for (const [name, value] of Object.entries(res.headersDistinct ?? res.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          headerInit.append(name, item);
        }
      }
      resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
        status: res.statusCode ?? 0,
        statusText: res.statusMessage,
        headers: headerInit,
      }));
    });
    const onAbort = (): void => {
      req.destroy(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.end(method === 'GET' || method === 'HEAD' ? undefined : body);
  });
}

export function mcpHttpPost(
  url: string,
  headers: Record<string, string>,
  body: string | Uint8Array = '',
  signal?: AbortSignal,
): Promise<Response> {
  return mcpHttpRequest(url, 'POST', headers, body, signal);
}

/** FetchImplementation that keeps the trusted MCP Host (Node fetch strips it). */
export function createMcpTestFetch(
  trustedOrigin: string = baseEnv.PUBLICATION_ORIGIN,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const headers = withMcpTestHost(
      Object.fromEntries(new Headers(init?.headers).entries()),
      trustedOrigin,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = init?.body;
    const body = typeof rawBody === 'string' || rawBody instanceof Uint8Array
      ? rawBody
      : '';
    return mcpHttpRequest(url, method, headers, body, init?.signal ?? undefined);
  };
}

export async function postJson(
  server: TestServer,
  method: string,
  id: number | string | null,
  init: RequestInit = {},
): Promise<Response> {
  const origin = server.config.mcp?.origin ?? server.config.publication.origin;
  return mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': method,
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json;q=1, text/event-stream;q=0.5',
      ...(init.headers as Record<string, string> | undefined),
    }, origin),
    (init.body as string | Uint8Array | undefined) ?? modernBody(method, id),
    init.signal ?? undefined,
  );
}

export async function postRaw(
  server: TestServer,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  const origin = server.config.mcp?.origin ?? server.config.publication.origin;
  return mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({ 'content-type': 'application/json', ...headers }, origin),
    body,
  );
}

export async function assertInvalidJsonResponse(response: Response, label: string): Promise<string> {
  assert.equal(response.status, 400, label);
  const text = await response.text();
  const payload = JSON.parse(text) as { readonly error?: { readonly code?: string; readonly message?: string } };
  assert.equal(payload.error?.code, 'invalid_json', label);
  assert.equal(payload.error?.message, 'The JSON body is invalid.', label);
  return text;
}

export function rawHttpPost(
  server: TestServer,
  body: string,
  headerFields: readonly string[],
): Promise<{ readonly status: number; readonly body: string }> {
  const url = new URL(PHASE4B_MCP_CONFIG_ENDPOINT_PATH, server.origin);
  return new Promise((resolve, reject) => {
    const requestHeaders: string[] = [];
    for (let index = 0; index < headerFields.length; index += 2) {
      requestHeaders.push(`${headerFields[index]}: ${headerFields[index + 1]}`);
    }
    const originHost = mcpTestHostHeader(server.config.mcp?.origin ?? server.config.publication.origin);
    const socket = rawConnect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.end([
        `POST ${url.pathname} HTTP/1.1`,
        `Host: ${originHost}`,
        ...requestHeaders,
        `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'));
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk: string) => {
      raw += chunk;
    });
    socket.once('end', () => {
      try {
        const separator = raw.indexOf('\r\n\r\n');
        if (separator < 0) throw new Error('missing HTTP response separator');
        const headerBlock = raw.slice(0, separator);
        const rawBody = raw.slice(separator + 4);
        const statusLine = headerBlock.split('\r\n', 1)[0] ?? '';
        const status = Number(statusLine.split(' ', 2)[1]);
        if (!Number.isInteger(status)) throw new Error('invalid HTTP status line');
        const headers = new Map(
          headerBlock.split('\r\n').slice(1).map((line) => {
            const colon = line.indexOf(':');
            return colon < 0
              ? [line.toLowerCase(), '']
              : [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
          }),
        );
        const bodyText = (headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')
          ? decodeChunkedBody(rawBody)
          : rawBody;
        resolve({ status, body: bodyText });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function decodeChunkedBody(rawBody: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < rawBody.length) {
    const lineEnd = rawBody.indexOf('\r\n', cursor);
    if (lineEnd < 0) throw new Error('invalid chunk framing');
    const sizeText = rawBody.slice(cursor, lineEnd).split(';', 1)[0]?.trim() ?? '';
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isInteger(size) || size < 0) throw new Error('invalid chunk size');
    cursor = lineEnd + 2;
    if (size === 0) return result;
    result += rawBody.slice(cursor, cursor + size);
    cursor += size;
    if (rawBody.slice(cursor, cursor + 2) !== '\r\n') throw new Error('invalid chunk terminator');
    cursor += 2;
  }
  throw new Error('missing final chunk');
}

export function parseJsonRpc(body: string): {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: number; readonly message?: string };
} {
  return JSON.parse(body) as {
    result?: Record<string, unknown>;
    error?: { code?: number; message?: string };
  };
}

export function parseSse(text: string): Record<string, unknown> {
  const data = text
    .split('\n\n')
    .map((event) => event.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map((line) => line.slice('data: '.length))
    .join('\n');
  return JSON.parse(data) as Record<string, unknown>;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return withRealTimeout(promise, ms, message);
}

export function requestBudgetOperations(): Phase4bMcpReadOperations {
  return createPhase4bMcpReadOperations({
    metrics: new InMemoryMetrics(),
    maxConcurrentRequests: 1,
    maxQueuedRequests: 1,
    maxListeners: 16,
  });
}

export async function waitForQueueSlot(
  operations: Phase4bMcpReadOperations,
  timeoutMs = 5_000,
): Promise<void> {
  await waitForCondition(
    () => operations.inspect().counts.queuedRequests >= 1,
    {
      timeoutMs,
      description: 'a queued MCP request to occupy the budget slot',
    },
  );
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
  readonly scope?: readonly string[];
  readonly key: KeyLike;
  readonly kid: string;
  readonly now?: Date;
  readonly jti?: string;
  readonly subject?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly expOffsetSeconds?: number;
}): Promise<string> {
  const now = input.now ?? NOW;
  const scope = input.scope ?? SCOPES;
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  return new SignJWT({
    scope: scope.join(' '),
    client_id: CLIENT_ID,
  })
    .setProtectedHeader({ alg: 'RS256', kid: input.kid })
    .setIssuer(input.issuer ?? ISSUER)
    .setSubject(input.subject ?? SUBJECT)
    .setAudience(input.audience ?? AUDIENCE)
    .setIssuedAt(nowSeconds - 5)
    .setExpirationTime(nowSeconds + (input.expOffsetSeconds ?? 3_600))
    .setJti(input.jti ?? 'r06-credential-jti-1')
    .sign(input.key);
}

export function verifierOptions(overrides: Partial<McpOauthVerifierOptions> = {}): McpOauthVerifierOptions {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    allowedScopes: SCOPES,
    jwks: staticJwksProvider([]),
    isRevoked: async () => false,
    securityEpoch: async () => 'epoch-1',
    now: () => NOW,
    clockToleranceSeconds: 0,
    resolveAccountBySubject: async (sub) => (
      typeof sub === 'string' && sub.trim() !== ''
        ? {
            id: sub === SUBJECT ? ACCOUNT_ID : `account:${sub}`,
            subjectId: sub,
            status: 'active',
          }
        : null
    ),
    ...overrides,
  };
}

export async function authFixture(delayMs = 0): Promise<{
  readonly verifier: McpOauthVerifier;
  readonly token: string;
}> {
  return authFixtureWithSecurityEpoch(async () => {
    if (delayMs > 0) {
      await waitForRealTime(delayMs, 'inject MCP security-epoch lookup latency');
    }
    return 'epoch-1';
  });
}

export interface AuthGate {
  readonly started: Promise<void>;
  readonly release: () => void;
}

export interface AuthFixtureResult {
  readonly verifier: McpOauthVerifier;
  readonly token: string;
}

export function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

export async function authFixtureWithSecurityEpoch(
  securityEpoch: () => Promise<string>,
): Promise<AuthFixtureResult> {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid });
  const verifier = createMcpOauthVerifier(verifierOptions({
    jwks: staticJwksProvider([key.jwk]),
    securityEpoch,
  }));
  return { verifier, token };
}

export async function writeOnlyAuthFixture(): Promise<AuthFixtureResult> {
  const key = await createKeyFixture('key-write');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid, scope: WRITE_SCOPES });
  const verifier = createMcpOauthVerifier(verifierOptions({
    allowedScopes: [...SCOPES, ...WRITE_SCOPES],
    jwks: staticJwksProvider([key.jwk]),
  }));
  return { verifier, token };
}

export async function gatedAuthFixture(): Promise<AuthFixtureResult & { readonly gate: AuthGate }> {
  const started = createDeferred();
  const release = createDeferred();
  const fixture = await authFixtureWithSecurityEpoch(async () => {
    started.resolve();
    await release.promise;
    return 'epoch-1';
  });
  return {
    ...fixture,
    gate: {
      started: started.promise,
      release: release.resolve,
    },
  };
}
