// The service-worker auth handler, credential store, library discovery and
// authority lanes are real. Only HTTP and browser-owned ports are fixtures.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import type { AuthExtensionRequest } from '../src/types.js';
import { config, EXTENSION_ID, EXTENSION_ORIGIN, fixtureSessionResult, manifest, memoryCookies, sessionJson, setCookieResponse } from './auth-shell-fixture.js';

let f: Awaited<ReturnType<typeof mount>>;
beforeEach(async () => { f = await mount(); });
afterEach(async () => {
  try { if (f) await f.close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); }
});

async function mount() {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const local = new MemoryStorageArea(), session = new MemoryStorageArea(), cookies = memoryCookies();
  const build = config(), origin = build.serverOrigin;
  const controls = { loginStatus: 200, otpStatus: 200, otpThrowsValue: false,
    libraryStatus: 404, libraryWait: undefined as Promise<void> | undefined, accountId: 'account-a' };
  const calls: Array<{ method: string; url: string; body?: unknown }> = [], unexpected: string[] = [];
  const nativeWrite = vi.fn(async () => { throw new Error('auth must not mutate bookmarks'); });
  vi.stubGlobal('chrome', { runtime: { id: EXTENSION_ID, getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`,
    getManifest: () => ({ version: '1.0.0' }), sendMessage: vi.fn(async () => undefined) },
    storage: { local, session: Object.assign(session, { setAccessLevel: vi.fn(async () => undefined) }),
      managed: { get: async () => ({}) } }, cookies,
    permissions: { contains: async () => false }, tabs: { create: vi.fn(async () => undefined) },
    alarms: { create: vi.fn(async () => undefined), clear: vi.fn(async () => true) },
    bookmarks: { create: nativeWrite, remove: nativeWrite, removeTree: nativeWrite, update: nativeWrite, move: nativeWrite,
      getTree: async () => [] },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined },
  });
  const library = { id: 'http-library', title: 'Bookmarks', library: true, rootNodeId: 'http-root',
    bookmarksBarId: 'http-bar', otherBookmarksId: 'http-other' };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input), method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });
    if (method === 'POST' && url === `${origin}/api/v1/auth/sign-in/email`) return controls.loginStatus === 200
      ? setCookieResponse({ user: { id: controls.accountId } }) : Response.json({ code: 'invalid_credentials' }, { status: controls.loginStatus });
    if (method === 'GET' && url === `${origin}/api/v1/auth/get-session`) return Response.json(sessionJson(Date.now(), controls.accountId));
    if (method === 'GET' && url === `${origin}/api/v1/session`) return Response.json({ authenticated: true });
    if (method === 'GET' && url === `${origin}/api/v1/me`) return Response.json({ profile: { avatarUrl: null } });
    if (method === 'POST' && url === `${origin}/api/v1/auth/email-otp/send-verification-otp`) {
      if (controls.otpThrowsValue) throw 'port_lost'; // Browser ports can reject non-Error values.
      return controls.otpStatus === 200 ? Response.json({ ok: true })
        : Response.json({ code: 'rate_limited' }, { status: controls.otpStatus });
    }
    if (method === 'POST' && url === `${origin}/api/v1/auth/sign-out`) return new Response(null, { status: 200 });
    if (method === 'GET' && url === `${origin}/colp/v0.1/sync/library`) {
      await controls.libraryWait;
      return controls.libraryStatus === 200 ? Response.json(library) : new Response(null, { status: controls.libraryStatus });
    }
    if (method === 'GET' && url === `${origin}/.well-known/collection-protocol`) return Response.json(manifest(origin));
    if (method === 'POST' && url === `${origin}/v1/session`) return Response.json({ ...fixtureSessionResult(Date.now()),
      collection: { collectionId: library.id, serverCursor: 'cursor-http', serverRevision: 'revision-http', snapshotRequired: false } }, { status: 201 });
    if (method === 'DELETE' && url === `${origin}/extensions/sync-retire`) return new Response(null, { status: 204 });
    // This auth fixture exposes no replica-health feature. Its explicit 404
    // exercises the normal unsupported response without acknowledging sync work.
    if (method === 'POST' && url === `${origin}/colp/v0.1/sync/replica-health`) return new Response(null, { status: 404 });
    unexpected.push(`${method} ${url}`); throw new Error(`Undeclared auth HTTP ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const runtime = await import('../src/sw/runtime.js'); runtime.sw.configPromise = Promise.resolve(build);
  const api = await import('../src/sw/auth.js');
  const dispatch = (request: AuthExtensionRequest) => runtime.workCoordinator.run('auth', context => api.handle(request, context));
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await runtime.workCoordinator.drain();
    await (await import('../src/bookmark-subscriptions/runtime.js')).wakeSubscriptions('startup');
    await (await import('../src/sw/replica-health.js')).reportReplicaHealth();
  };
  return { ...runtime, dispatch, calls, unexpected, fetcher, controls, local, cookies, nativeWrite, library, origin, settle,
    login: () => dispatch({ kind: 'known.auth.login', method: 'password', userGesture: true, email: 'user@example.test', password: 'secret' }),
    async close() {
      await settle();
      await (await import('../src/bookmark-subscriptions/store.js')).subscriptionStore.close();
      (await import('../src/automation/indexeddb-store.js')).automationDatabase().close();
      runtime.syncState.close();
      expect(unexpected).toEqual([]);
    },
  };
}

test('a signed-out status is local and successful OTP delivery does not invent a credential or sync scope', async () => {
  expect(await f.dispatch({ kind: 'known.auth.status' })).toMatchObject({ ok: true, state: { status: 'signed_out' } });
  expect(f.calls).toEqual([]);
  expect(await f.dispatch({ kind: 'known.auth.send-otp', email: 'user@example.test', userGesture: true }))
    .toMatchObject({ ok: true, state: { status: 'signed_out' } });
  expect(f.calls).toEqual([{ method: 'POST', url: `${f.origin}/api/v1/auth/email-otp/send-verification-otp`,
    body: { email: 'user@example.test', type: 'sign-in' } }]);
  expect(await f.store.loadCredential()).toBeNull(); expect(await f.store.loadSession()).toBeNull();
  expect(f.nativeWrite).not.toHaveBeenCalled();
});

test.each(['http', 'port'] as const)('OTP %s failures retain signed-out state and report a specific retryable failure', async fault => {
  f.controls.otpStatus = 429; f.controls.otpThrowsValue = fault === 'port';
  const result = await f.dispatch({ kind: 'known.auth.send-otp', email: 'user@example.test', userGesture: true });
  expect(result).toMatchObject({ ok: false, state: { status: 'signed_out' },
    error: fault === 'port' ? 'offline' : 'rate_limited' });
  expect(await f.store.loadCredential()).toBeNull();
  expect(f.calls).toHaveLength(1);
});

test('a rejected password does not publish library or session authority', async () => {
  f.controls.loginStatus = 401;
  expect(await f.login()).toMatchObject({ ok: false, error: 'invalid_credentials', state: { status: 'error' } });
  expect(await f.store.loadCredential()).toBeNull(); expect(await f.store.loadSession()).toBeNull();
  expect((await f.local.get(f.COLLECTION_BINDING))[f.COLLECTION_BINDING]).toBeUndefined();
  expect(f.calls).toHaveLength(1);
});

test('an unsupported library keeps a real cookie login usable, and status does not wait for rediscovery', async () => {
  expect(await f.login()).toMatchObject({ ok: true, state: { status: 'connected', errorCode: 'sync_unsupported' } });
  expect((await f.store.loadCredential())?.subject).toBe('account-a');
  expect(await f.store.loadSession()).toBeNull();
  let release!: () => void;
  f.controls.libraryWait = new Promise(resolve => { release = resolve; });
  try {
    const status = await f.dispatch({ kind: 'known.auth.status' });
    expect(status).toMatchObject({ ok: true, state: { status: 'connected', errorCode: 'sync_unsupported' } });
    expect(f.calls.filter(call => call.url === `${f.origin}/v1/session`)).toEqual([]);
  } finally { release(); await f.settle(); }
  const refresh = await f.dispatch({ kind: 'known.auth.refresh' });
  expect(refresh).toMatchObject({ ok: true, state: { status: 'connected', errorCode: 'sync_unsupported' } });
  expect(await f.store.loadSession()).toBeNull();
  expect(f.nativeWrite).not.toHaveBeenCalled();
});

test('retry discovers a newly supported library, stores one session, and logout clears both durable authorities', async () => {
  await f.login(); f.controls.libraryStatus = 200;
  const refresh = await f.dispatch({ kind: 'known.auth.refresh' });
  expect(refresh).toMatchObject({ ok: true, state: { status: 'connected' } });
  const session = await f.store.loadSession();
  expect(session?.collection.collectionId).toBe(f.library.id);
  expect((await f.local.get(f.COLLECTION_BINDING))[f.COLLECTION_BINDING]).toBe(f.library.id);
  const scope = await (await import('../src/sw/scope.js')).currentSyncScope();
  expect((await f.syncState.getScope(scope))?.lifecycle).toBe('active');
  await f.settle();
  expect(f.calls.filter(call => call.url === `${f.origin}/v1/session`)).toHaveLength(1);
  expect(await f.dispatch({ kind: 'known.auth.status' })).toMatchObject({ ok: true, state: { status: 'connected' } });
  await f.settle();
  expect(f.calls.filter(call => call.url === `${f.origin}/v1/session`)).toHaveLength(1);
  const logout = await f.dispatch({ kind: 'known.auth.logout', userGesture: true });
  expect(logout).toMatchObject({ ok: true, state: { status: 'signed_out' } });
  expect(await f.store.loadCredential()).toBeNull(); expect(await f.store.loadSession()).toBeNull();
  expect((await f.local.get(f.COLLECTION_BINDING))[f.COLLECTION_BINDING]).toBeUndefined();
  expect(await f.syncState.getScope(scope)).toBeNull();
  expect(f.cookies.values.size).toBe(0);
  expect(f.calls.filter(call => call.method === 'DELETE' && call.url.endsWith('/extensions/sync-retire'))).toHaveLength(1);
  expect(f.nativeWrite).not.toHaveBeenCalled();
});

test('a failed background discovery is reported without changing the completed local sign-in', async () => {
  await f.login(); f.controls.libraryStatus = 503;
  const errors = vi.spyOn(console, 'error');
  const credential = await f.store.loadCredential();
  expect(await f.dispatch({ kind: 'known.auth.status' })).toMatchObject({ ok: true, state: { status: 'connected' } });
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('[known] background task failed (auth.bind-library)',
    expect.objectContaining({ message: 'library_unavailable' })));
  expect(await f.store.loadCredential()).toEqual(credential);
  expect(await f.store.loadSession()).toBeNull();
  expect(f.calls.filter(call => call.url === `${f.origin}/v1/session`)).toEqual([]);
  f.controls.libraryStatus = 404;
  expect(await f.dispatch({ kind: 'known.auth.refresh' })).toMatchObject({ ok: true, state: { status: 'connected', errorCode: 'sync_unsupported' } });
});

test('a save-context cleanup failure is observable while logout still revokes credential and cookie authority', async () => {
  await f.login();
  const remove = f.local.remove.bind(f.local), errors = vi.spyOn(console, 'error');
  vi.spyOn(f.local, 'remove').mockImplementation(async keys => {
    if (keys === 'known.sync.save-context.v1') throw new Error('storage_unavailable');
    await remove(keys);
  });
  expect(await f.dispatch({ kind: 'known.auth.logout', userGesture: true })).toMatchObject({ ok: true, state: { status: 'signed_out' } });
  expect(errors).toHaveBeenCalledWith('[known] background task failed (auth.clear-save-context)',
    expect.objectContaining({ message: 'storage_unavailable' }));
  expect(await f.store.loadCredential()).toBeNull(); expect(await f.store.loadSession()).toBeNull();
  expect((await f.store.fence.read()).revoked).toBe(true);
  expect(f.cookies.values.size).toBe(0);
  expect((await f.local.get(f.COLLECTION_BINDING))[f.COLLECTION_BINDING]).toBeUndefined();
  expect(f.nativeWrite).not.toHaveBeenCalled();
});
