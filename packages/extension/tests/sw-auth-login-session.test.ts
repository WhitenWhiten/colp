import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { AuthorityFencedError } from '../src/authority-fence.js';
import { parseBuildConfig } from '../src/config.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import type { StoredSession } from '../src/types.js';

/**
 * `known.auth.login` must not delete the Session it just minted.
 *
 * The handler runs under the authority generation the MESSAGE arrived with, and
 * logging in activates a new one (`auth-controller` persistSession ->
 * `activateAuthority`). Passing the handler's own context generation to
 * `ensureSyncScope` therefore threw `AuthorityFencedError`, and the catch around
 * it cleared the Session the lane had just saved: every login minted a Session,
 * discarded it, and left the engine to mint again on its next wake — double the
 * `lifecycle_revision` churn the lane exists to avoid — and the scope import
 * never ran. No behavioural test covered `src/sw/auth.ts` at all.
 *
 * Generation is live now, but any `ensureSyncScope` failure used to take the
 * same cleanup: clear the Session the lane had just written, then answer
 * `{ ok: true }`. The handler must answer `{ ok: false, state, error }` and
 * leave that Session stored.
 */
const cleanups: Array<() => void> = [];
const mocks = vi.hoisted(() => ({ login: vi.fn(), session: vi.fn(), wake: vi.fn(),
  credential: { current: undefined as unknown } }));

vi.mock('../src/auth-controller.js', () => ({
  createAuthController: () => ({
    login: mocks.login,
    // The lane refreshes the credential before deciding whether to mint; hand it
    // the one this fixture persisted.
    ensureFreshCredential: async () => mocks.credential.current as never,
    status: async () => ({ status: 'connected' as const }),
    logout: async () => ({ status: 'signed_out' as const }),
    sendOtp: async () => undefined,
  }),
}));
vi.mock('../src/session-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/session-client.js')>(),
  createSyncSession: mocks.session,
}));
vi.mock('../src/manifest-client.js', () => ({
  fetchSyncEndpoints: async () => ({
    syncSessions: 'https://known.example/v1/session',
    syncSnapshot: 'https://known.example/v1/snapshot',
    syncPush: 'https://known.example/v1/push',
    syncPull: 'https://known.example/v1/pull',
    syncAck: 'https://known.example/v1/ack',
    syncConflict: 'https://known.example/v1/conflicts/{conflictId}',
    syncEffectPages: 'https://known.example/v1/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example',
    syncRetire: 'https://known.example/v1/retire',
  }),
}));
vi.mock('../src/sw/engine.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/sw/engine.js')>(),
  scheduleSyncEngineWake: mocks.wake,
}));

afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

async function loginFixture() {
  vi.resetModules();
  const local = new MemoryStorageArea();
  const session = new MemoryStorageArea();
  const setAccessLevel = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', {
    storage: { local, session: Object.assign(session, { setAccessLevel }) },
    runtime: { id: 'pplpnpegpnghcddhmpgkbfkdfadjiaen',
      getURL: (path: string) => `chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen/${path}` },
  });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  const runtime = await import('../src/sw/runtime.js');
  const api = await import('../src/sw/auth.js');
  cleanups.push(() => runtime.syncState.close());
  const config = parseBuildConfig(JSON.parse(await readFile('config/e2e-fixture.json', 'utf8')));
  runtime.sw.configPromise = Promise.resolve(config);
  const binding = await runtime.store.getOrCreateBinding(0);
  const credential = { accessToken: 'login-test-credential', tokenType: 'Bearer' as const,
    subject: 'login-account', accountLabel: 'Login test', expiresAt: Date.now() + 3_600_000,
    scope: config.scopes, serverOrigin: config.serverOrigin, issuer: config.issuer,
    audience: config.audience, clientId: config.clientId };
  await runtime.store.saveCredential(credential);
  mocks.credential.current = credential;
  await local.set({ [runtime.COLLECTION_BINDING]: 'login-collection' });
  const minted: StoredSession = { sessionId: 'minted-1', expiresAt: '2099-01-01T00:00:00Z',
    scope: 'collection', credentialAuthorityDigest: 'digest-1', acceptedProtocolVersion: '0.2',
    snapshotRequired: false,
    collection: { collectionId: 'login-collection', serverCursor: 'cursor0', serverRevision: 'r0' },
    replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } };
  mocks.session.mockResolvedValue(minted);
  mocks.wake.mockReturnValue(undefined);
  // A real login persists the session and ACTIVATES a new authority generation.
  mocks.login.mockImplementation(async () => {
    const activated = await runtime.store.activateAuthority();
    await runtime.store.saveCredential(credential, activated.generation);
    mocks.credential.current = credential;
    return { status: 'connected' as const };
  });
  return { ...runtime, api, local, binding, credential, minted, config };
}

test('a scope failure during login keeps the minted Session and reports failure', async () => {
  const f = await loginFixture();
  // The Session lane calls `ensureSyncScope` as a local binding and must still
  // mint. Only the export this handler imports is the follow-up import.
  const scope = await import('../src/sw/scope.js');
  const failedScope = vi.spyOn(scope, 'ensureSyncScope').mockRejectedValue(new AuthorityFencedError());
  try {
    const before = await f.store.fence.capture();
    const response = await f.api.handle({ kind: 'known.auth.login', method: 'password', userGesture: true,
      email: 'login@example.test', password: 'secret' }, { generation: before.generation, signal: new AbortController().signal });

    assert.equal(response.ok, false);
    if (response.ok) assert.fail('scope failure must not report success');
    assert.equal(response.error, 'authority_fenced');
    assert.equal(response.state.status, 'error');
    assert.equal(response.state.errorCode, 'authority_fenced');
    assert.equal((await f.store.loadSession())?.sessionId, 'minted-1');
    assert.equal(mocks.session.mock.calls.length, 1, 'a scope failure must not mint a second Session');
  } finally {
    failedScope.mockRestore();
  }
});

test('a login keeps the Session the lane minted for it', async () => {
  const f = await loginFixture();
  const before = await f.store.fence.capture();
  await f.api.handle({ kind: 'known.auth.login', method: 'password', userGesture: true,
    email: 'login@example.test', password: 'secret' }, { generation: before.generation, signal: new AbortController().signal });

  const stored = await f.store.loadSession();
  assert.equal(stored?.sessionId, 'minted-1',
    'the Session minted during login must survive the handler');
  assert.equal(mocks.session.mock.calls.length, 1, 'login must mint exactly one Session');
  const after = await f.store.fence.capture();
  assert.ok(after.generation > before.generation, 'the login activated a new authority generation');
  assert.equal(await f.store.loadCredential().then((value) => value?.subject), 'login-account');
});

const library = { id: 'login-collection', title: 'Bookmarks', library: true,
  rootNodeId: 'login-root', bookmarksBarId: 'login-bar', otherBookmarksId: 'login-other' };

test('signing in again establishes a sync scope with the production policy gate enabled', async () => {
  const f = await loginFixture();
  const { browserPersonalSyncPolicy } = await import('../src/personal-sync-policy.js');
  const { configurePersonalSyncTransport } = await import('../src/personal-sync-fetch.js');
  const policy = browserPersonalSyncPolicy();
  configurePersonalSyncTransport(policy);
  vi.stubGlobal('fetch', async () => Response.json(library));
  const response = await f.api.handle({ kind: 'known.auth.login', method: 'password', userGesture: true,
    email: 'login@example.test', password: 'secret' }, await f.store.fence.capture());
  assert.equal(response.ok, true);
  assert.equal((await f.store.loadSession())?.sessionId, 'minted-1');
  const { currentSyncScope } = await import('../src/sw/scope.js');
  assert.equal((await currentSyncScope()).collectionId, library.id);
});

test('signing in again preserves an explicit user pause', async () => {
  const f = await loginFixture();
  const { browserPersonalSyncPolicy } = await import('../src/personal-sync-policy.js');
  const { configurePersonalSyncTransport } = await import('../src/personal-sync-fetch.js');
  const policy = browserPersonalSyncPolicy();
  configurePersonalSyncTransport(policy);
  const identity = { serverOrigin: f.credential.serverOrigin, accountId: f.credential.subject, collectionId: library.id };
  const paused = await policy.write(identity, 'paused', 'user');
  vi.stubGlobal('fetch', async () => Response.json(library));
  const response = await f.api.handle({ kind: 'known.auth.login', method: 'password', userGesture: true,
    email: 'login@example.test', password: 'secret' }, await f.store.fence.capture());
  assert.equal(response.ok, true);
  assert.deepEqual(await policy.read(identity), paused);
  assert.equal(mocks.session.mock.calls.length, 0);
});

test('sign-in automatically binds the library and stores the root from its response', async () => {
  const f = await loginFixture();
  await f.local.remove(f.COLLECTION_BINDING);
  const fetcher = vi.fn(async () => Response.json(library)); vi.stubGlobal('fetch', fetcher);
  const authority = await f.store.fence.capture();
  const response = await f.api.handle({ kind: 'known.auth.login', method: 'password', userGesture: true,
    email: 'login@example.test', password: 'secret' }, authority);
  assert.equal(response.ok, true);
  assert.equal((await f.local.get(f.COLLECTION_BINDING))[f.COLLECTION_BINDING], library.id);
  const saved = (await f.local.get('known.sync.library.v1'))['known.sync.library.v1'] as { library: typeof library };
  assert.equal(saved.library.rootNodeId, library.rootNodeId);
  assert.ok(fetcher.mock.calls.length >= 1);
  assert.equal(mocks.session.mock.calls.length, 1);
});

test('an unsupported server keeps sign-in usable and does not mint a sync session', async () => {
  const f = await loginFixture();
  await f.local.remove(f.COLLECTION_BINDING);
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
  const response = await f.api.handle({ kind: 'known.auth.login', method: 'password', userGesture: true,
    email: 'login@example.test', password: 'secret' }, await f.store.fence.capture());
  assert.equal(response.ok, true);
  assert.equal(response.state.status, 'connected');
  assert.equal(response.state.errorCode, 'sync_unsupported');
  assert.equal((await f.local.get(f.COLLECTION_BINDING))[f.COLLECTION_BINDING], undefined);
  assert.equal(mocks.session.mock.calls.length, 0);
});
