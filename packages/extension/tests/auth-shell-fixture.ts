/**
 * Shared fixture for the P3-27 auth shell suites. Extracted from
 * auth-shell.test.ts so the suites stay under the test-granularity ceiling.
 */
import { createAuthController, type CookieChangeInfo, type CookiePort } from '../src/auth-controller.js';
import { SESSION_COOKIE_NAME } from '../src/auth-client.js';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import { parseBuildConfig } from '../src/config.js';
import type { BuildConfig, StoredCredential, StoredSession } from '../src/types.js';

export const EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
export const NOW = 1_785_139_200_000;
export const COOKIE_VALUE = 'baSessionToken.dGVzdHNpZ25hdHVyZQ==';
export function fixtureCredential(value: BuildConfig, now: number): StoredCredential { return { accessToken: COOKIE_VALUE,
  tokenType: 'Bearer', expiresAt: now + 300_000, scope: ['known.sync'], issuer: value.issuer,
  audience: value.audience, clientId: value.clientId, serverOrigin: value.serverOrigin,
  subject: 'auth-user-fixture', accountLabel: 'p3-27-extension@example.test' }; }
export function fixtureSession(now: number): StoredSession { return { sessionId: 'session-fixture', expiresAt: new Date(now + 300_000).toISOString(),
  credentialAuthorityDigest: 'a'.repeat(64),
  scope: 'collection', collection: { collectionId: 'collection-fixture', serverCursor: 'cursor-fixture', serverRevision: 'revision-fixture' },
  snapshotRequired: false,
  replicaLease: { leaseId: 'lease-fixture', generation: '1', state: 'active', expiresAt: new Date(now + 600_000).toISOString() } }; }
export function fixtureSessionResult(now: number) { const { snapshotRequired: _snapshotRequired,
  credentialAuthorityDigest: _credentialAuthorityDigest, ...stored } = fixtureSession(now); return { ...stored, serverTime: new Date(now).toISOString(),
  clockSkewMilliseconds: 0, acceptedProtocolVersion: '0.2', maxBatchOperations: 1, tombstoneRetentionSeconds: 86400,
  collection: { ...stored.collection, snapshotRequired: true }, replicaLease: { ...stored.replicaLease,
    lastSeenAt: new Date(now).toISOString(), acknowledgedCursor: null }, conversionPolicy: { alias: 'duplicate',
    separator: 'preserve_remote', unknownExtensions: 'sidecar' } }; }
export function fixtureSessionRequest() { return { protocolVersion: '0.2', replica: { replicaId: 'replica-fixture', name: 'Chromium',
  kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' }, capabilities: { read: true, write: true,
    events: true, separator: false, alias: false, annotations: 'sidecar', maxBatchOperations: 1 }, binding: { browserProfileId: 'profile-fixture',
      mountMode: 'mounted-folder', mountNativeId: 'pending-selection', generation: '1' } }, scope: 'collection', collection: {
    collectionId: 'collection-fixture', lastCursor: null, lastRevision: null, bootstrapMode: 'download' }, clientTime: new Date().toISOString() }; }

export function sessionJson(now: number, userId = 'auth-user-fixture', image?: string) {
  return {
    session: { id: 'ba-session-1', userId, expiresAt: new Date(now + 86_400_000).toISOString() },
    user: {
      id: userId, email: 'p3-27-extension@example.test', name: 'Fixture',
      ...(image ? { image } : {}),
    },
  };
}

export function setCookieResponse(body: unknown, cookieValue = COOKIE_VALUE, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookieValue)}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

export function memoryCookies(): CookiePort & { readonly values: Map<string, string>; readonly listeners: Set<(change: CookieChangeInfo) => void> } {
  const values = new Map<string, string>();
  const listeners = new Set<(change: CookieChangeInfo) => void>();
  return {
    values, listeners,
    async get(details) {
      const value = values.get(`${details.url}:${details.name}`);
      return value === undefined ? null : { value };
    },
    async set(details) {
      values.set(`${details.url}:${details.name}`, details.value);
      return { name: details.name, value: details.value };
    },
    async remove(details) {
      values.delete(`${details.url}:${details.name}`);
      return { url: details.url, name: details.name };
    },
    onChanged: {
      addListener(callback) { listeners.add(callback); },
      removeListener(callback) { listeners.delete(callback); },
    },
  };
}

export function fixtureController(options: {
  readonly config: BuildConfig; readonly store?: ReturnType<typeof createCredentialStore>;
  readonly now?: () => number; readonly failure?: 'invalid_credentials' | 'offline' | 'cookie_missing';
  readonly refresh?: 'success' | 'authentication_required' | 'missing_session' | 'offline' | 'rotated_cookie' | 'hidden_rotated_cookie' | 'stale_header_rotation' | 'rejected_predecessor';
  readonly logout?: 'success' | 'retire_failure';
  readonly avatar?: string;
  readonly profileAvatar?: string;
}) {
  const store = options.store ?? createCredentialStore(new MemoryStorageArea(), options.now ?? (() => NOW));
  const calls: string[] = [];
  const cookies = memoryCookies();
  const fetcher: typeof fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith('/sign-out')) { calls.push('sign-out'); return new Response(null, { status: 200 }); }
    if (href.endsWith('/get-session')) {
      calls.push('get-session');
      if (options.refresh === 'authentication_required') return new Response(null, { status: 401 });
      if (options.refresh === 'rejected_predecessor') {
        const successor = 'rotated-session.dGVzdHNpZ25hdHVyZQ==';
        if (calls.filter((call) => call === 'get-session').length === 1) {
          cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, successor);
          return new Response(null, { status: 401 });
        }
        const requestCookie = new Headers(init?.headers).get('cookie') ?? '';
        return requestCookie.includes(encodeURIComponent(successor))
          ? Response.json(sessionJson(options.now?.() ?? NOW))
          : new Response(null, { status: 401 });
      }
      if (options.refresh === 'missing_session') return Response.json(null);
      if (options.refresh === 'offline' || options.failure === 'offline') throw new TypeError('Failed to fetch');
      if (options.refresh === 'rotated_cookie') {
        return setCookieResponse(sessionJson(options.now?.() ?? NOW, 'auth-user-fixture', options.avatar), 'rotated-session.dGVzdHNpZ25hdHVyZQ==');
      }
      if (options.refresh === 'hidden_rotated_cookie' || options.refresh === 'stale_header_rotation') {
        const successor = 'rotated-session.dGVzdHNpZ25hdHVyZQ==';
        if (calls.filter((call) => call === 'get-session').length === 1) {
          cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, successor);
          const session = sessionJson(options.now?.() ?? NOW);
          return options.refresh === 'stale_header_rotation'
            ? setCookieResponse(session, COOKIE_VALUE)
            : Response.json(session);
        }
        const requestCookie = new Headers(init?.headers).get('cookie') ?? '';
        return requestCookie.includes(encodeURIComponent(successor))
          ? Response.json(sessionJson(options.now?.() ?? NOW))
          : new Response(null, { status: 401 });
      }
      return Response.json(sessionJson(options.now?.() ?? NOW, 'auth-user-fixture', options.avatar));
    }
    if (href.endsWith('/api/v1/session')) {
      return Response.json({ authenticated: true, csrfToken: 'csrf-fixture' });
    }
    if (href.endsWith('/api/v1/me')) {
      if (options.profileAvatar) {
        return Response.json({ account: { id: 'auth-user-fixture' }, profile: { avatarUrl: options.profileAvatar } });
      }
      return new Response(null, { status: 404 });
    }
    if (href.endsWith('/sign-in/email')) {
      calls.push('sign-in');
      if (options.failure === 'offline') throw new TypeError('Failed to fetch');
      if (options.failure === 'invalid_credentials') {
        return Response.json({ code: 'invalid_credentials' }, { status: 401 });
      }
      if (options.failure === 'cookie_missing') return Response.json({ ok: true });
      return setCookieResponse({ user: { id: 'auth-user-fixture' } });
    }
    return new Response(null, { status: 404 });
  };
  const instance: ReturnType<typeof createAuthController> & { fixtureCalls: string[]; cookies: ReturnType<typeof memoryCookies> } =
    Object.assign(createAuthController({
      config: options.config, store, now: options.now ?? (() => NOW), origin: EXTENSION_ORIGIN,
      cookies, fetch: fetcher,
      retire: async () => {
        calls.push('retire');
        if (options.logout === 'retire_failure') throw new Error('retire_failed');
      },
    }), { fixtureCalls: calls, cookies });
  return instance;
}

export function config(environment: 'development' | 'staging' | 'production' = 'production') {
  return parseBuildConfig({
    environment,
    extensionId: EXTENSION_ID,
    serverOrigin: environment === 'production' ? 'https://known.example' : 'https://dev.known.example',
    manifestUrl: environment === 'production'
      ? 'https://known.example/.well-known/collection-protocol'
      : 'https://dev.known.example/.well-known/collection-protocol',
    issuer: environment === 'production' ? 'https://known.example/' : 'https://dev.known.example/',
    authorizationEndpoint: environment === 'production'
      ? 'https://known.example/api/v1/auth/sign-in/email'
      : 'https://dev.known.example/api/v1/auth/sign-in/email',
    tokenEndpoint: environment === 'production'
      ? 'https://known.example/api/v1/auth/get-session'
      : 'https://dev.known.example/api/v1/auth/get-session',
    jwksUri: environment === 'production'
      ? 'https://known.example/.well-known/jwks.json'
      : 'https://dev.known.example/.well-known/jwks.json',
    revocationEndpoint: environment === 'production'
      ? 'https://known.example/api/v1/auth/sign-out'
      : 'https://dev.known.example/api/v1/auth/sign-out',
    clientId: 'known-chromium-extension', audience: 'known-sync-api',
    scopes: ['openid', 'offline_access', 'known.sync'],
    allowedAlgorithms: ['RS256'], refreshBeforeExpirySeconds: 60,
  });
}

export function manifest(origin = 'https://known.example') {
  return {
    protocol: 'https://know-n.com/colp/spec/0.2', protocolVersions: ['0.1', '0.2'],
    syncEffectPages: `${origin}/v1/effects/{effectId}/pages/{pageNumber}`,
    serverId: `${origin}/`, serverUuid: '019f97ff-1111-7111-8111-111111111111', title: 'Known',
    mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/sync/`, profiles: ['core'],
      endpoints: {
        syncSessions: `${origin}/v1/session`, syncSnapshot: `${origin}/v1/snapshot`,
        syncPush: `${origin}/v1/push`, syncPull: `${origin}/v1/pull`,
        syncAck: `${origin}/v1/ack`, syncConflict: `${origin}/v1/conflicts/{conflictId}`,
      },
      features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] }, sync: { multiCollectionSessions: false } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10000, minPollIntervalSeconds: 10,
        recommendedPollIntervalSeconds: 30, maxSyncBatchOperations: 1,
        idempotencyRetentionSeconds: 86400, syncCursorRetentionSeconds: 2592000 },
      'https://known.example/extensions/sync-retire': { href: `${origin}/extensions/sync-retire`, method: 'DELETE',
        requestBody: false, successStatus: 204,
        requiredHeaders: ['Authorization', 'Origin', 'Known-Sync-Session', 'Idempotency-Key'] },
    }],
  };
}
