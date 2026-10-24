import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';

import { afterEach, test, vi } from 'vitest';
import { parseBuildConfig } from '../src/config.js';
import { MemoryStorageArea } from '../src/credential-store.js';

/**
 * W2B-P1-3: a browser restart (or an involuntary sign-out) leaves no credential in memory, only the account pin. A
 * different account signing in then used to inherit the previous account's replica, collection binding and library
 * state, because the sign-out cleanup only looked at a credential that was still in memory.
 */
const cleanups: Array<() => void> = [];
const mocks = vi.hoisted(() => ({ login: vi.fn(), wake: vi.fn(), clearAutomation: vi.fn(),
  credential: { current: undefined as unknown } }));

vi.mock('../src/auth-controller.js', () => ({
  createAuthController: () => ({
    login: mocks.login,
    ensureFreshCredential: async () => mocks.credential.current as never,
    status: async () => ({ status: 'connected' as const }),
    logout: async () => ({ status: 'signed_out' as const }),
    sendOtp: async () => undefined,
  }),
}));
vi.mock('../src/manifest-client.js', () => ({
  fetchSyncEndpoints: async () => ({
    syncSessions: 'https://known.example/v1/session', syncSnapshot: 'https://known.example/v1/snapshot',
    syncPush: 'https://known.example/v1/push', syncPull: 'https://known.example/v1/pull',
    syncAck: 'https://known.example/v1/ack', syncConflict: 'https://known.example/v1/conflicts/{conflictId}',
    syncEffectPages: 'https://known.example/v1/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example', syncRetire: 'https://known.example/v1/retire',
  }),
}));
vi.mock('../src/sw/engine.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/sw/engine.js')>(),
  scheduleSyncEngineWake: mocks.wake,
}));
vi.mock('../src/sw/automation.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/sw/automation.js')>(),
  clearAccountAutomation: mocks.clearAutomation,
}));

afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

async function restartedFixture(signingInAs: string) {
  vi.resetModules();
  const local = new MemoryStorageArea(), session = new MemoryStorageArea();
  vi.stubGlobal('chrome', {
    storage: { local, session: Object.assign(session, { setAccessLevel: vi.fn(async () => undefined) }) },
    runtime: { id: 'pplpnpegpnghcddhmpgkbfkdfadjiaen',
      getURL: (path: string) => `chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen/${path}` },
  });
  // The library cannot be discovered, so whatever collection binding is left afterwards was not re-established by sign-in.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  const runtime = await import('../src/sw/runtime.js');
  const scope = await import('../src/sw/scope.js');
  const api = await import('../src/sw/auth.js');
  cleanups.push(() => runtime.syncState.close());
  const config = parseBuildConfig(JSON.parse(await readFile('config/e2e-fixture.json', 'utf8')));
  runtime.sw.configPromise = Promise.resolve(config);
  const credential = (subject: string) => ({ accessToken: `token-${subject}`, tokenType: 'Bearer' as const, subject,
    accountLabel: subject, expiresAt: Date.now() + 3_600_000, scope: config.scopes, serverOrigin: config.serverOrigin,
    issuer: config.issuer, audience: config.audience, clientId: config.clientId });
  // The earlier account used this browser, then Chrome restarted: the secret area is empty, the pin and binding stay.
  const first = await runtime.store.fence.activate();
  await runtime.store.saveCredential(credential('account-a'), first.generation);
  const binding = await scope.bindingForRequest(first.generation);
  await local.set({ [runtime.COLLECTION_BINDING]: 'collection-of-a', 'known.sync.library.v1': { accountId: 'account-a' } });
  await runtime.store.clearCredential();
  const next = credential(signingInAs);
  mocks.login.mockImplementation(async () => {
    const activated = await runtime.store.activateAuthority();
    await runtime.store.saveCredential(next, activated.generation);
    mocks.credential.current = next;
    return { status: 'connected' as const };
  });
  mocks.wake.mockReturnValue(undefined);
  mocks.clearAutomation.mockResolvedValue(undefined);
  return { ...runtime, scope, api, local, binding, config };
}

const loginMessage = { kind: 'known.auth.login', method: 'password', userGesture: true,
  email: 'login@example.test', password: 'secret' } as const;

test('a different account signing in after a restart does not inherit the replica, collection or library state', async () => {
  const f = await restartedFixture('account-b');
  const response = await f.api.handle(loginMessage, await f.store.fence.capture());
  assert.equal(response.ok, true);
  assert.equal((await f.local.get(f.COLLECTION_BINDING))[f.COLLECTION_BINDING], undefined,
    'the earlier account\'s collection binding is gone');
  assert.equal((await f.local.get('known.sync.library.v1'))['known.sync.library.v1'], undefined);
  assert.equal(f.sw.bindingPromise, undefined, 'the memo of the earlier account\'s binding is forgotten');
  const next = await f.scope.bindingForRequest((await f.store.fence.read()).generation);
  assert.notEqual(next.replicaId, f.binding.replicaId);
  assert.deepEqual(mocks.clearAutomation.mock.calls[0]?.[0],
    { serverOrigin: f.config.serverOrigin, accountId: 'account-a' }, 'the earlier account\'s automation data goes too');
});

test('the same account signing in after a restart keeps its replica, collection and library state', async () => {
  const f = await restartedFixture('account-a');
  // The bound collection stays, so sign-in goes on to mint a Session; the unreachable server fails that step.
  await f.api.handle(loginMessage, await f.store.fence.capture());
  assert.equal((await f.local.get(f.COLLECTION_BINDING))[f.COLLECTION_BINDING], 'collection-of-a');
  assert.deepEqual(await f.store.loadBinding(), f.binding);
  assert.equal(mocks.clearAutomation.mock.calls.length, 0);
});

test('a stale memo of a removed binding is not used for the next request', async () => {
  const f = await restartedFixture('account-b');
  assert.ok(f.sw.bindingPromise, 'the earlier account\'s binding is memoised');
  await f.store.clearBinding();
  const next = await f.scope.bindingForRequest((await f.store.fence.read()).generation);
  assert.notEqual(next.replicaId, f.binding.replicaId, 'a removed binding is never handed out again');
  assert.deepEqual(await f.store.loadBinding(), next);
});
