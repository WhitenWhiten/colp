import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createAuthorityFence, createExtensionWorkCoordinator, type WorkLane } from '../src/authority-fence.js';
import { createRememberedConnectionStore } from '../src/personal-sync-connection.js';
import { browserPersonalSyncPolicy } from '../src/personal-sync-policy.js';

const f = vi.hoisted(() => ({ target: null as string | null, restores: 0,
  run: null as null | ((lane: WorkLane, work: () => Promise<unknown>) => Promise<unknown>),
  onAuth: () => {},
}));
vi.mock('../src/sw/runtime.js', () => ({ COLLECTION_BINDING: 'target', sw: {}, hasBookmarkPermission: async () => false,
  syncState: {}, store: {
    loadCredential: async () => ({ serverOrigin: 'https://known.test', subject: 'owner' }),
    loadBinding: async () => null, assertWritable: async () => undefined,
    clearBinding: async () => undefined,
    restoreBinding: async () => { f.restores++; },
    fence: { capture: async () => ({ generation: 0 }) },
  }, workCoordinator: { run: (lane: WorkLane, work: () => Promise<unknown>) => {
    if (lane === 'auth') f.onAuth();
    return f.run!(lane, work);
  } },
}));
vi.mock('../src/sw/scope.js', () => ({ boundCollectionId: async () => f.target,
  currentSyncScope: async () => null, pushSessionAuthority: vi.fn() }));
vi.mock('../src/sw/collections.js', () => ({ verifyCollectionAvailability: async () => 'available' }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/sw/capture.js', () => ({ captureStore: {} }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: vi.fn() }));
vi.mock('../src/sw/bookmarks.js', () => ({ recoverBookmarkEventsAfterEngineSettles: vi.fn() }));
import { personalSyncLifecycle } from '../src/sw/personal-sync.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
test('Resume rechecks policy inside the actual worker auth lane before restoring a binding', async () => {
  const storage = new MemoryStorageArea(), coordinator = createExtensionWorkCoordinator(createAuthorityFence(storage));
  vi.stubGlobal('chrome', { storage: { local: storage } });
  f.run = (lane, work) => coordinator.run(lane, work);
  const identity = { serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'one' };
  await createRememberedConnectionStore(storage).write(identity, { version: 1, collectionId: 'one',
    binding: { replicaId: 'fresh', browserProfileId: 'profile', generation: '1' } });
  const policy = browserPersonalSyncPolicy(); await policy.write(identity, 'paused');
  const lifecycle = personalSyncLifecycle(), blocker = deferred(), entered = deferred(), queued = deferred();
  const occupyingAuth = coordinator.run('auth', async () => { entered.resolve(); await blocker.promise; });
  await entered.promise; f.onAuth = queued.resolve;
  const command = async (action: 'resume' | 'disconnect') => {
    const preview = await lifecycle.handle({ kind: 'known.personalSync.preview', action });
    assert.ok('token' in preview && 'revision' in preview);
    return { kind: 'known.personalSync.change' as const, action, token: preview.token!, revision: preview.revision!, userGesture: true as const };
  };
  try {
    const resume = lifecycle.handle(await command('resume'));
    const refused = assert.rejects(resume, /preview_stale/);
    await queued.promise;
    const disconnectQueued = deferred(); f.onAuth = disconnectQueued.resolve;
    const disconnect = lifecycle.handle(await command('disconnect'));
    await disconnectQueued.promise;
    assert.equal((await policy.read(identity)).mode, 'disconnected');
    blocker.resolve(); await occupyingAuth; await refused; await disconnect;
    assert.equal(f.restores, 0);
    assert.equal((await storage.get('target')).target, undefined);
  } finally { blocker.resolve(); await occupyingAuth; vi.unstubAllGlobals(); }
});
