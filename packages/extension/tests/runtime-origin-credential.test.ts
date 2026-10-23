import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { afterEach, test, vi } from 'vitest';
import { RUNTIME_ORIGIN_KEY, resolveRuntimeConfig } from '../src/config.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { authErrorCopy } from '../src/auth-error-copy.js';
import { credentialGatedFetch } from '../src/server-origin-permission.js';
import { createSyncSession } from '../src/session-client.js';
import { createSyncEffectAuthority } from '../src/sync-effect-authority.js';
import type { SyncEndpoints } from '../src/manifest-client.js';
import type { SyncScope } from '../src/sync-state-store.js';
import {
  COOKIE_VALUE, EXTENSION_ID, config as buildConfig, fixtureCredential, fixtureSession,
  memoryCookies, setCookieResponse, sessionJson,
} from './auth-shell-fixture.js';

/**
 * A saved or managed HTTPS origin is not trusted until chrome.permissions.contains
 * says this install already has that host. Manifest host_permissions make contains
 * return true, so the built-in server is the same check, not a bypass.
 */
const granted = new Set<string>();
const checked: string[][] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  granted.clear();
  checked.length = 0;
  vi.unstubAllGlobals();
  vi.resetModules();
});

type Call = { readonly url: string; readonly init?: RequestInit };

function leaked(call: Call): boolean {
  const headers = new Headers(call.init?.headers);
  const body = typeof call.init?.body === 'string' ? call.init.body : '';
  return headers.has('authorization') || headers.has('cookie') || call.init?.credentials === 'include'
    || /"password"\s*:/u.test(body);
}

function recordFetch(handler?: (url: string) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler ? handler(url) : new Response(null, { status: 500 });
  });
  return calls;
}

function authResponse(url: string): Response {
  if (url.includes('/sign-in/email') || url.includes('/sign-in/username')) {
    return setCookieResponse({ user: { id: 'auth-user-fixture' } });
  }
  if (url.includes('/get-session')) return Response.json(sessionJson(Date.now()));
  if (url.endsWith('/api/v1/session')) return Response.json({ authenticated: true, csrfToken: 'csrf-fixture' });
  if (url.endsWith('/api/v1/me')) return new Response(null, { status: 404 });
  return new Response(null, { status: 404 });
}

function permissionsChrome(extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    permissions: {
      contains: async (query: { origins?: string[] }) => {
        const origins = query.origins ?? [];
        checked.push(origins);
        return origins.every((origin) => granted.has(origin));
      },
    },
  };
}

async function boot(storage?: { readonly local?: Record<string, unknown>; readonly managed?: Record<string, unknown> }) {
  for (const close of cleanups.splice(0)) close();
  vi.resetModules();
  const local = new MemoryStorageArea();
  const managed = new MemoryStorageArea();
  const session = new MemoryStorageArea();
  if (storage?.local) await local.set(storage.local);
  if (storage?.managed) await managed.set(storage.managed);
  vi.stubGlobal('chrome', permissionsChrome({
    storage: { local, managed, session: Object.assign(session, { setAccessLevel: async () => undefined }) },
    runtime: { id: EXTENSION_ID, getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}` },
    cookies: memoryCookies(),
  }));
  const runtime = await import('../src/sw/runtime.js');
  runtime.sw.configPromise = Promise.resolve(buildConfig());
  const scope = await import('../src/sw/scope.js');
  cleanups.push(() => runtime.syncState.close());
  return { runtime, scope };
}

const PASSWORD = 'dev-runtime-auth-password';

async function signIn(origin: string, storage?: { readonly local?: Record<string, unknown>; readonly managed?: Record<string, unknown> }) {
  const loaded = await (await boot(storage)).scope.loadConfig();
  assert.equal(loaded.serverOrigin, origin);
  const calls = recordFetch(authResponse);
  const auth = (await import('../src/sw/scope.js')).createRuntimeAuth(loaded);
  const state = await auth.login({ method: 'password', email: 'person@example.test', password: PASSWORD });
  return { state, calls, loaded };
}

function endpoints(origin: string): SyncEndpoints {
  return {
    syncSessions: `${origin}/v1/session`, syncSnapshot: `${origin}/v1/snapshot`,
    syncPush: `${origin}/v1/push`, syncPull: `${origin}/v1/pull`, syncAck: `${origin}/v1/ack`,
    syncConflict: `${origin}/v1/conflicts/{conflictId}`,
    syncEffectPages: `${origin}/v1/effects/{effectId}/pages/{pageNumber}`,
    effectPageAuthority: origin, syncRetire: `${origin}/v1/retire`,
  };
}

test('an unauthorized saved https origin does not receive the password', async () => {
  const { state, calls } = await signIn('https://evil.example', { local: { [RUNTIME_ORIGIN_KEY]: 'https://evil.example' } });
  assert.equal(state.status, 'error');
  assert.equal(state.errorCode, 'server_configuration_failed');
  assert.equal(authErrorCopy(state.errorCode), 'Check the server address and allow access before signing in.');
  assert.equal(calls.filter(leaked).length, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(checked, [['https://evil.example/*']]);
});

test('a managed https origin is checked even when the saved origin is granted', async () => {
  granted.add('https://colp.example/*');
  const { state, calls } = await signIn('https://evil.example', {
    managed: { serverOrigin: 'https://evil.example' },
    local: { [RUNTIME_ORIGIN_KEY]: 'https://colp.example' },
  });
  assert.equal(state.status, 'error');
  assert.equal(state.errorCode, 'server_configuration_failed');
  assert.equal(calls.length, 0);
  assert.deepEqual(checked, [['https://evil.example/*']]);
});

test('a granted optional origin and a manifest host both receive the password', async () => {
  granted.add('https://colp.example/*');
  const optional = await signIn('https://colp.example', { local: { [RUNTIME_ORIGIN_KEY]: 'https://colp.example' } });
  assert.equal(optional.state.status, 'connected');
  const password = optional.calls.find((call) => typeof call.init?.body === 'string' && call.init.body.includes(PASSWORD));
  assert.ok(password);
  assert.equal(new URL(password.url).origin, 'https://colp.example');
  assert.equal(password.init?.credentials, 'include');
  for (const call of optional.calls.filter(leaked)) assert.equal(new URL(call.url).origin, 'https://colp.example');

  granted.clear();
  checked.length = 0;
  granted.add('https://known.example/*');
  const builtin = await signIn('https://known.example');
  assert.equal(builtin.state.status, 'connected');
  const pinned = builtin.calls.find((call) => typeof call.init?.body === 'string' && call.init.body.includes(PASSWORD));
  assert.ok(pinned);
  assert.equal(new URL(pinned.url).origin, 'https://known.example');
});

test('a granted managed origin receives the password', async () => {
  granted.add('https://policy.example/*');
  const { state, calls } = await signIn('https://policy.example', { managed: { serverOrigin: 'https://policy.example' } });
  assert.equal(state.status, 'connected');
  const password = calls.find((call) => typeof call.init?.body === 'string' && call.init.body.includes(PASSWORD));
  assert.ok(password);
  assert.equal(new URL(password.url).origin, 'https://policy.example');
});

test('the pinned origin is refused when contains does not grant it', async () => {
  const { state, calls } = await signIn('https://known.example');
  assert.equal(state.status, 'error');
  assert.equal(state.errorCode, 'server_configuration_failed');
  assert.equal(calls.length, 0);
});

test('a cookie refresh is not sent until the origin is granted', async () => {
  const deniedCalls = recordFetch(authResponse);
  const denied = await boot({ local: { [RUNTIME_ORIGIN_KEY]: 'https://evil.example' } });
  const deniedConfig = await denied.scope.loadConfig();
  const deniedAuth = denied.scope.createRuntimeAuth(deniedConfig);
  await denied.runtime.store.saveCredential({ ...fixtureCredential(deniedConfig, Date.now()), expiresAt: Date.now() + 3_600_000 });
  await assert.rejects(() => deniedAuth.ensureFreshCredential(true), /server_configuration_failed/);
  assert.equal(deniedCalls.filter(leaked).length, 0);

  granted.add('https://evil.example/*');
  const allowedCalls = recordFetch(authResponse);
  const allowed = await boot({ local: { [RUNTIME_ORIGIN_KEY]: 'https://evil.example' } });
  const allowedConfig = await allowed.scope.loadConfig();
  const allowedAuth = allowed.scope.createRuntimeAuth(allowedConfig);
  await allowed.runtime.store.saveCredential({ ...fixtureCredential(allowedConfig, Date.now()), expiresAt: Date.now() + 3_600_000 });
  const fresh = await allowedAuth.ensureFreshCredential(true);
  assert.equal(fresh.serverOrigin, 'https://evil.example');
  const cookieCall = allowedCalls.find((call) => new Headers(call.init?.headers).has('cookie'));
  assert.ok(cookieCall);
  const cookie = new Headers(cookieCall.init?.headers).get('cookie') ?? '';
  assert.match(cookie, /^__Host-known_session=/);
  assert.equal(decodeURIComponent(cookie.slice('__Host-known_session='.length).split(';')[0] ?? ''), COOKIE_VALUE);
  assert.equal(new URL(cookieCall.url).origin, 'https://evil.example');
});

test('an unauthorized origin receives no bearer session, retire, or sync request', async () => {
  vi.stubGlobal('chrome', permissionsChrome());
  const origin = 'https://evil.example';
  const sessionCalls = recordFetch();
  const credential = fixtureCredential(resolveRuntimeConfig(buildConfig(), origin), Date.now());
  await assert.rejects(() => createSyncSession({
    endpoints: endpoints(origin), credential, request: { protocolVersion: '0.2' },
  }), /server_configuration_failed/);
  assert.equal(sessionCalls.length, 0);

  const { scope } = await boot();
  const retireCalls = recordFetch(async () => new Response(null, { status: 204 }));
  await assert.rejects(() => scope.retire(endpoints(origin), credential, fixtureSession(Date.now())),
    /server_configuration_failed/);
  assert.equal(retireCalls.length, 0);

  const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
  const syncScope: SyncScope = {
    environment: 'production', serverId: origin, serverOrigin: origin, accountId: 'account',
    browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1,
  };
  const effects = createSyncEffectAuthority({
    scope: syncScope, api: {} as never, context: { generation: 1, signal: new AbortController().signal },
    currentScope: async () => syncScope, assertWritable: async () => undefined, fetch: inner,
  });
  await assert.rejects(() => effects.fetch(`${origin}/v1/pull`, {
    method: 'POST', headers: { Authorization: 'Bearer sync-secret' }, body: '{}',
  }), /server_configuration_failed/);
  assert.equal(inner.mock.calls.length, 0);

  granted.add(`${origin}/*`);
  const allowedSession = recordFetch();
  await assert.rejects(() => createSyncSession({
    endpoints: endpoints(origin), credential, request: { protocolVersion: '0.2' },
  }));
  assert.equal(allowedSession.length, 1);
  assert.equal(new Headers(allowedSession[0]?.init?.headers).get('authorization'), `Bearer ${COOKIE_VALUE}`);
  assert.equal(new URL(allowedSession[0]!.url).origin, origin);

  const retireAllowed = recordFetch(async () => new Response(null, { status: 204 }));
  await scope.retire(endpoints(origin), credential, fixtureSession(Date.now()));
  assert.equal(new Headers(retireAllowed[0]?.init?.headers).get('authorization'), `Bearer ${COOKIE_VALUE}`);
  assert.equal(new URL(retireAllowed[0]!.url).origin, origin);

  await effects.fetch(`${origin}/v1/pull`, {
    method: 'POST', headers: { Authorization: 'Bearer sync-secret' }, body: '{}',
  });
  assert.equal(inner.mock.calls.length, 1);
  assert.equal(new Headers(inner.mock.calls[0]?.[1]?.headers).get('authorization'), 'Bearer sync-secret');
});

test('an uncredentialed manifest read is not blocked by a missing host grant', async () => {
  vi.stubGlobal('chrome', permissionsChrome());
  const calls = recordFetch(async () => new Response('{}', { status: 200 }));
  await credentialGatedFetch(fetch)('https://evil.example/.well-known/collection-protocol', {
    cache: 'no-store', headers: { Accept: 'application/json' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls.filter(leaked).length, 0);
  assert.equal(checked.length, 0);
});

test('http runtime origins stay limited to loopback', () => {
  assert.throws(() => resolveRuntimeConfig(buildConfig(), 'http://192.168.1.20:8080'), /HTTPS is required/);
  assert.throws(() => resolveRuntimeConfig(buildConfig(), 'http://203.0.113.10:8080'), /HTTPS is required/);
  assert.equal(resolveRuntimeConfig(buildConfig(), 'http://127.0.0.1:8080').serverOrigin, 'http://127.0.0.1:8080');
  assert.equal(resolveRuntimeConfig(buildConfig(), 'http://localhost:8080').serverOrigin, 'http://localhost:8080');
  assert.equal(resolveRuntimeConfig(buildConfig(), 'http://[::1]:8080').serverOrigin, 'http://[::1]:8080');
});
