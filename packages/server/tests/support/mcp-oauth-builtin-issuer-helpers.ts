/**
 * T-09 CIMD e2e helpers. PKCE / consent / token wrappers live with the T-04
 * issuer helpers; this file owns CIMD metadata, the gold-dance, JWT inspect,
 * live-key signing, MCP JSON-RPC, and SSE.
 */
import { randomUUID } from 'node:crypto';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { McpResourceNotFoundError } from '@know-n/colp/mcp';
import { decodeJwt, decodeProtectedHeader, importJWK, SignJWT, type JWK, type KeyLike } from 'jose';
import { symmetricDecrypt } from 'better-auth/crypto';
import type { Pool } from 'pg';
import type {
  Phase4bMcpCollectionResourceProjection,
  Phase4bMcpNodeResourceProjection,
  Phase4bMcpSnapshotResourceProjection,
} from '../../src/modules/mcp/index.js';
import { McpOauthVerificationError } from '../../src/modules/mcp/index.js';
import {
  BUILTIN_ISSUER_TEST_AS_METADATA_URL,
  BUILTIN_ISSUER_TEST_AUDIENCE,
  BUILTIN_ISSUER_TEST_ISSUER,
  BUILTIN_ISSUER_TEST_JWKS_URI,
  BUILTIN_ISSUER_TEST_SCOPE_LIST,
  BUILTIN_ISSUER_TEST_SCOPES,
  builtinIssuerTestEnv,
  createBuiltinIssuerPkce,
  exchangeBuiltinIssuerToken,
  submitBuiltinIssuerConsent,
  type BuiltinIssuerInjectApp,
} from './builtin-issuer-test-helpers.js';
import { PHASE4B_MCP_CONFIG_SERVER_UUID } from './phase4b-mcp-config-env.js';
import { mcpHttpPost, withMcpTestHost } from './phase4b-mcp-transport-scaffold.js';
import { waitForRealTime, withRealTimeout } from './async-test-helpers.js';

export const T09_TRUSTED_ORIGIN = 'https://app.example.test';
export const T09_SESSION_COOKIE = '__Host-known_session';
export const T09_PASSWORD = 'password-123'; // secret-scan: allow 'password-123'
export const T09_CIMD_CLIENT_ID = 'https://cimd.example.test/.well-known/oauth-client';
export const T09_CIMD_REDIRECT = 'https://cimd.example.test/callback';
export const T09_CIMD_CLIENT_NAME = 'T-09 CIMD Client';
/** Claude Code-shaped CIMD: no-port loopback + ephemeral authorize port. */
export const T09_CLAUDE_CIMD_CLIENT_ID = 'https://cimd.example.test/oauth/claude-code-client-metadata';
export const T09_CLAUDE_CIMD_CLIENT_NAME = 'T-09 Claude Code CIMD Client';
export const T09_CLAUDE_CIMD_REDIRECT_LOCALHOST = 'http://localhost/callback';
export const T09_CLAUDE_CIMD_REDIRECT_LOOPBACK = 'http://127.0.0.1/callback';
export const T09_CLAUDE_EPHEMERAL_REDIRECT = 'http://localhost:3118/callback';
export const T09_CLAUDE_SECOND_EPHEMERAL_REDIRECT = 'http://localhost:4118/callback';
export const T09_CLAUDE_POST_EPHEMERAL_REDIRECT = 'http://localhost:5118/callback';
/** RFC 6890 private — real CIMD URL validation / hardened fetch refuse this. */
export const T09_CIMD_PRIVATE_CLIENT_ID = 'https://10.0.0.1/.well-known/oauth-client';
export const T09_DCR_REDIRECT = 'http://127.0.0.1:8943/callback';
export const T09_DCR_CLIENT_NAME = 'T-09 DCR Client';
export const T09_ALLOWED_ALGS = Object.freeze(['RS256', 'ES256', 'PS256', 'ES384']);
export const T09_RESOURCE_URI = `colp://${PHASE4B_MCP_CONFIG_SERVER_UUID}/collections/t09-cimd/metadata`;

export const T09_CIMD_METADATA = Object.freeze({
  client_id: T09_CIMD_CLIENT_ID,
  client_name: T09_CIMD_CLIENT_NAME,
  redirect_uris: Object.freeze([T09_CIMD_REDIRECT]),
  token_endpoint_auth_method: 'none',
  grant_types: Object.freeze(['authorization_code']),
  response_types: Object.freeze(['code']),
  scope: BUILTIN_ISSUER_TEST_SCOPE_LIST,
});

export const T09_CLAUDE_CIMD_METADATA = Object.freeze({
  client_id: T09_CLAUDE_CIMD_CLIENT_ID,
  client_name: T09_CLAUDE_CIMD_CLIENT_NAME,
  redirect_uris: Object.freeze([T09_CLAUDE_CIMD_REDIRECT_LOCALHOST, T09_CLAUDE_CIMD_REDIRECT_LOOPBACK]),
  grant_types: Object.freeze(['authorization_code', 'refresh_token']),
  response_types: Object.freeze(['code']),
  token_endpoint_auth_method: 'none',
  scope: BUILTIN_ISSUER_TEST_SCOPE_LIST,
});

let t09ClaudeCimdFetchCount = 0;

export function t09ResetClaudeCimdFetchCount(): void {
  t09ClaudeCimdFetchCount = 0;
}

export function t09ReadClaudeCimdFetchCount(): number {
  return t09ClaudeCimdFetchCount;
}

const T09_CIMD_SCOPE_SPACE = BUILTIN_ISSUER_TEST_SCOPE_LIST;
export const T09_CIMD_SCOPE_WITH_OFFLINE_ACCESS = `${BUILTIN_ISSUER_TEST_SCOPE_LIST} offline_access` as const;

export function t09IssuerMcpEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: T09_TRUSTED_ORIGIN,
    PUBLICATION_ORIGIN: T09_TRUSTED_ORIGIN,
    PUBLICATION_SERVER_UUID: PHASE4B_MCP_CONFIG_SERVER_UUID,
    ALLOWED_ORIGINS: T09_TRUSTED_ORIGIN,
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
    AUTH_RATE_LIMIT_MAX: '1000000',
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: PHASE4B_MCP_CONFIG_SERVER_UUID,
    MCP_ALLOWED_ORIGINS: T09_TRUSTED_ORIGIN,
    MCP_OAUTH_ISSUER: BUILTIN_ISSUER_TEST_ISSUER,
    MCP_OAUTH_JWKS_URI: BUILTIN_ISSUER_TEST_JWKS_URI,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: BUILTIN_ISSUER_TEST_AS_METADATA_URL,
    MCP_OAUTH_REVOCATION_STORE: 'postgres',
    ...builtinIssuerTestEnv({
      MCP_OAUTH_AUDIENCE: BUILTIN_ISSUER_TEST_AUDIENCE,
      MCP_OAUTH_SCOPES: BUILTIN_ISSUER_TEST_SCOPES,
    }),
    ...overrides,
  };
}

/** Serves CIMD JSON for the public-looking URL; other URLs use the real hardened fetch. */
export async function t09TestFetchClientMetadataResource(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const href = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).href;
  if (href === T09_CIMD_CLIENT_ID || href === `${T09_CIMD_CLIENT_ID}/`) {
    return new Response(JSON.stringify(T09_CIMD_METADATA), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (href === T09_CLAUDE_CIMD_CLIENT_ID || href === `${T09_CLAUDE_CIMD_CLIENT_ID}/`) {
    t09ClaudeCimdFetchCount += 1;
    return new Response(JSON.stringify(T09_CLAUDE_CIMD_METADATA), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
    });
  }
  return fetchClientMetadataResource(input, init);
}

export function t09UniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

export function t09CookieHeader(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}`;
}

export function t09SessionCookieOf(res: { cookies?: unknown }): string | null {
  const cookies = (res.cookies ?? []) as Array<{ name: string; value: string }>;
  return cookies.find((cookie) => cookie.name === T09_SESSION_COOKIE)?.value ?? null;
}

export function t09RedirectUrl(response: {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  json(): unknown;
}): string {
  const location = response.headers.location;
  if (typeof location === 'string' && location.length > 0) {
    return location;
  }
  const body = response.json() as { url?: unknown; redirect_uri?: unknown };
  if (typeof body.url === 'string' && body.url.length > 0) return body.url;
  if (typeof body.redirect_uri === 'string' && body.redirect_uri.length > 0) return body.redirect_uri;
  throw new Error(`authorize/consent produced no redirect (${response.statusCode})`);
}

export async function t09Authorize(
  app: BuiltinIssuerInjectApp,
  input: {
    readonly clientId: string;
    readonly cookie: string;
    readonly challenge: string;
    readonly resource?: string;
    readonly state?: string;
    readonly redirectUri?: string;
    readonly method?: 'GET' | 'POST';
    readonly scope?: string;
  },
): Promise<{ readonly statusCode: number; readonly location: string | null; readonly body: string }> {
  const url = new URL(`${BUILTIN_ISSUER_TEST_ISSUER}/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri ?? T09_CIMD_REDIRECT);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', input.scope ?? T09_CIMD_SCOPE_SPACE);
  url.searchParams.set('state', input.state ?? 't09-state');
  if (input.resource !== undefined) url.searchParams.set('resource', input.resource);
  const method = input.method ?? 'GET';
  const path = method === 'GET' ? `${url.pathname}${url.search}` : url.pathname;
  const response = await app.inject({
    method,
    url: path,
    headers: {
      cookie: t09CookieHeader(T09_SESSION_COOKIE, input.cookie),
      origin: T09_TRUSTED_ORIGIN,
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    payload: method === 'POST' ? url.searchParams.toString() : undefined,
  });
  let location: string | null = null;
  try {
    location = t09RedirectUrl(response);
  } catch {
    location = null;
  }
  return { statusCode: response.statusCode, location, body: response.body };
}

export async function t09ConsentApprove(
  app: BuiltinIssuerInjectApp,
  input: {
    readonly cookie: string;
    readonly oauthQuery: string;
    readonly csrfToken?: string;
    readonly scope?: string;
  },
): Promise<string> {
  const headers: Record<string, string> = {
    cookie: t09CookieHeader(T09_SESSION_COOKIE, input.cookie),
    origin: T09_TRUSTED_ORIGIN,
  };
  if (input.csrfToken !== undefined) headers['x-csrf-token'] = input.csrfToken;
  const response = await submitBuiltinIssuerConsent(app, {
    accept: true,
    scope: input.scope ?? T09_CIMD_SCOPE_SPACE,
    oauth_query: input.oauthQuery,
  }, headers);
  return t09RedirectUrl(response);
}

export async function t09ExchangeCode(
  app: BuiltinIssuerInjectApp,
  input: {
    readonly code: string;
    readonly verifier: string;
    readonly resource?: string;
    readonly clientId?: string;
    readonly redirectUri?: string;
  },
) {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri ?? T09_CIMD_REDIRECT,
    client_id: input.clientId ?? T09_CIMD_CLIENT_ID,
    code_verifier: input.verifier,
  };
  if (input.resource !== undefined) body.resource = input.resource;
  return exchangeBuiltinIssuerToken(app, body);
}

export async function t09CimdCodeGrant(
  app: BuiltinIssuerInjectApp,
  cookie: string,
  options: {
    readonly resource?: string | null;
    readonly clientId?: string;
    readonly redirectUri?: string;
    readonly authorizeMethod?: 'GET' | 'POST';
    readonly scope?: string;
  } = {},
): Promise<{ readonly code: string; readonly verifier: string; readonly usedConsent: boolean }> {
  const pkce = createBuiltinIssuerPkce();
  const resource = options.resource === null ? undefined : (options.resource ?? BUILTIN_ISSUER_TEST_AUDIENCE);
  const clientId = options.clientId ?? T09_CIMD_CLIENT_ID;
  const redirectUri = options.redirectUri ?? T09_CIMD_REDIRECT;
  const scope = options.scope ?? T09_CIMD_SCOPE_SPACE;
  const authorize = await t09Authorize(app, {
    clientId,
    cookie,
    challenge: pkce.challenge,
    redirectUri,
    method: options.authorizeMethod,
    scope,
    ...(resource === undefined ? {} : { resource }),
  });
  if (authorize.location === null) {
    throw new Error(`CIMD authorize produced no redirect (${authorize.statusCode}): ${authorize.body}`);
  }
  const redirected = new URL(authorize.location, T09_TRUSTED_ORIGIN);
  let callback = authorize.location;
  const usedConsent = redirected.pathname.endsWith('/consent');
  if (usedConsent) {
    callback = await t09ConsentApprove(app, {
      cookie,
      oauthQuery: redirected.search.startsWith('?') ? redirected.search.slice(1) : redirected.search,
      scope,
    });
  }
  const code = new URL(callback, redirectUri).searchParams.get('code');
  if (code === null || code.length === 0) {
    throw new Error(`consent did not return an authorization code: ${callback}`);
  }
  return { code, verifier: pkce.verifier, usedConsent };
}

export async function t09RegisterDcrClient(
  app: BuiltinIssuerInjectApp,
  options: { readonly clientName?: string; readonly redirectUri?: string } = {},
): Promise<{ readonly clientId: string; readonly redirectUri: string }> {
  const redirectUri = options.redirectUri ?? T09_DCR_REDIRECT;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/oauth2/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      client_name: options.clientName ?? T09_DCR_CLIENT_NAME,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      application_type: 'native',
    }),
  });
  if (response.statusCode !== 200 && response.statusCode !== 201) {
    throw new Error(`DCR failed (${response.statusCode}): ${response.body}`);
  }
  const body = response.json() as { client_id?: unknown };
  if (typeof body.client_id !== 'string' || body.client_id.length === 0) {
    throw new Error(`DCR response missing client_id: ${response.body}`);
  }
  return { clientId: body.client_id, redirectUri };
}

export async function t09DcrCodeGrant(
  app: BuiltinIssuerInjectApp,
  cookie: string,
  registered: { readonly clientId: string; readonly redirectUri: string },
): Promise<{ readonly code: string; readonly verifier: string; readonly usedConsent: boolean }> {
  const pkce = createBuiltinIssuerPkce();
  const authorize = await t09Authorize(app, {
    clientId: registered.clientId,
    cookie,
    challenge: pkce.challenge,
    resource: BUILTIN_ISSUER_TEST_AUDIENCE,
    redirectUri: registered.redirectUri,
  });
  if (authorize.location === null) {
    throw new Error(`DCR authorize produced no redirect (${authorize.statusCode}): ${authorize.body}`);
  }
  const redirected = new URL(authorize.location, T09_TRUSTED_ORIGIN);
  let callback = authorize.location;
  const usedConsent = redirected.pathname.endsWith('/consent');
  if (usedConsent) {
    callback = await t09ConsentApprove(app, {
      cookie,
      oauthQuery: redirected.search.startsWith('?') ? redirected.search.slice(1) : redirected.search,
    });
  }
  const code = new URL(callback, registered.redirectUri).searchParams.get('code');
  if (code === null || code.length === 0) {
    throw new Error(`DCR consent did not return an authorization code: ${callback}`);
  }
  return { code, verifier: pkce.verifier, usedConsent };
}

export function t09InspectAccessToken(token: string): {
  readonly segments: number;
  readonly alg: string;
  readonly claims: ReturnType<typeof decodeJwt>;
} {
  const header = decodeProtectedHeader(token);
  return {
    segments: token.split('.').length,
    alg: typeof header.alg === 'string' ? header.alg : '',
    claims: decodeJwt(token),
  };
}

export async function t09LoadIssuerPrivateKey(
  pool: Pool,
  secret: string,
): Promise<{ readonly privateKey: KeyLike | Uint8Array; readonly kid: string; readonly alg: string }> {
  const row = await pool.query<{ id: string; alg: string | null; privateKey: string }>(
    `select id, alg, "privateKey" from auth_jwks order by "createdAt" desc limit 1`,
  );
  const key = row.rows[0];
  if (key === undefined) throw new Error('auth_jwks has no issuer key');
  const decrypted = await symmetricDecrypt({ key: secret, data: JSON.parse(key.privateKey) as string });
  const alg = key.alg ?? 'RS256';
  return { privateKey: await importJWK(JSON.parse(decrypted) as JWK, alg), kid: key.id, alg };
}

export async function t09SignWrongAudJwt(input: {
  readonly pool: Pool;
  readonly secret: string;
  readonly subject: string;
  readonly clientId: string;
}): Promise<string> {
  const key = await t09LoadIssuerPrivateKey(input.pool, input.secret);
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    client_id: input.clientId,
    scope: T09_CIMD_SCOPE_SPACE,
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setIssuer(BUILTIN_ISSUER_TEST_ISSUER)
    .setSubject(input.subject)
    .setAudience('https://evil.example.test/collections/-/mcp')
    .setJti(`t09-wrong-aud-${randomUUID()}`)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(key.privateKey);
}

export function t09McpJsonRpc(method: string, id: number | string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'known-t09-cimd', version: '1.0.0' },
      },
      ...params,
    },
  });
}

export async function t09PostMcp(
  origin: string,
  method: string,
  id: number | string,
  options: {
    readonly authorization?: string;
    readonly params?: Record<string, unknown>;
    readonly accept?: string;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  } = {},
): Promise<Response> {
  return mcpHttpPost(
    `${origin}/collections/-/mcp`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': method,
      'mcp-protocol-version': '2026-07-28',
      accept: options.accept ?? 'application/json;q=1, text/event-stream;q=0.5',
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
      ...options.extraHeaders,
    }, T09_TRUSTED_ORIGIN),
    t09McpJsonRpc(method, id, options.params ?? {}),
  );
}

export function t09InvalidToken(response: Response, body: { error?: { code?: string } }): boolean {
  const challenge = response.headers.get('www-authenticate') ?? '';
  return response.status === 401
    && /Bearer error="invalid_token"/u.test(challenge)
    && body.error?.code === 'authentication_required';
}

export function t09IsRevokedError(error: unknown): boolean {
  return error instanceof McpOauthVerificationError && error.reason === 'revoked';
}

export async function t09WaitNextUnixSecond(issuedAt: number): Promise<void> {
  const remainingMs = ((issuedAt + 1) * 1_000) - Date.now();
  if (remainingMs <= 0) return;
  await waitForRealTime(remainingMs, 'cross the JWT issued-at second boundary');
}

export interface T09SseEvent {
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly error?: Readonly<Record<string, unknown>>;
}

export function t09CreateSseReader(response: Response): {
  readonly next: (timeoutMs?: number) => Promise<T09SseEvent | null>;
  readonly close: () => void;
} {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SSE response has no body');
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  let pendingRead: Promise<void> | null = null;

  function readChunk(): Promise<void> {
    if (pendingRead !== null) return pendingRead;
    pendingRead = reader.read()
      .then((result) => {
        if (result.done) {
          done = true;
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
      })
      .finally(() => {
        pendingRead = null;
      });
    return pendingRead;
  }

  return {
    async next(timeoutMs = 3_000): Promise<T09SseEvent | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const separator = buffer.indexOf('\n\n');
        if (separator >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice('data: '.length);
          if (data !== undefined) return JSON.parse(data) as T09SseEvent;
          continue;
        }
        if (done) return null;
        await withRealTimeout(
          readChunk(),
          Math.max(0, deadline - Date.now()),
          'timed out waiting for SSE event',
        );
      }
      throw new Error('timed out waiting for SSE event');
    },
    close() {
      if (done) return;
      void reader.cancel().catch(() => undefined);
    },
  };
}

export function t09StubMcpProjections(): {
  readonly collection: Phase4bMcpCollectionResourceProjection;
  readonly snapshot: Phase4bMcpSnapshotResourceProjection;
  readonly node: Phase4bMcpNodeResourceProjection;
} {
  const cache = Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
  return {
    collection: Object.freeze({
      async listResources() {
        return Object.freeze({ resources: Object.freeze([]) });
      },
      async readResource() {
        return Object.freeze({
          contents: Object.freeze([
            Object.freeze({
              mimeType: 'application/vnd.collection-protocol.collection+json',
              text: '{"ok":true}',
              provenance: Object.freeze({ origin: 'internal' as const }),
            }),
          ]),
        });
      },
      async cacheForList() { return cache; },
      async cacheForRead() { return cache; },
    }),
    snapshot: Object.freeze({
      async readResource() { throw new McpResourceNotFoundError(); },
      async readPage() { throw new McpResourceNotFoundError(); },
      async cacheForRead() { return cache; },
    }),
    node: Object.freeze({
      async readResource() { throw new McpResourceNotFoundError(); },
      async cacheForRead() { return cache; },
    }),
  };
}
