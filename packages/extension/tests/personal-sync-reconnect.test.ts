import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createAuthorityFence, createExtensionWorkCoordinator, type WorkLane } from '../src/authority-fence.js';
import { createRememberedConnectionStore } from '../src/personal-sync-connection.js';
import { browserPersonalSyncPolicy } from '../src/personal-sync-policy.js';

const f = vi.hoisted(() => ({ target: null as string | null, restores: 0,
  binding: null as null | { replicaId: string; browserProfileId: string; generation: string },
  library: undefined as undefined | { id: string; title: string; library: true; rootNodeId: string;
    bookmarksBarId: string; otherBookmarksId: string },
  run: null as null | ((lane: WorkLane, work: () => Promise<unknown>) => Promise<unknown>),
  onAuth: () => {},
}));
vi.mock('../src/sw/runtime.js', () => ({ COLLECTION_BINDING: 'target', sw: {}, hasBookmarkPermission: async () => false,
  syncState: {}, store: {
    loadCredential: async () => ({ serverOrigin: 'https://known.test', subject: 'owner' }),
    loadBinding: async () => f.binding, assertWritable: async () => undefined,
    clearBinding: async () => undefined,
    restoreBinding: async (binding: NonNullable<typeof f.binding>) => { f.restores++; f.binding = binding; },
    fence: { capture: async () => ({ generation: 0 }) },
  }, workCoordinator: { run: (lane: WorkLane, work: () => Promise<unknown>) => {
    if (lane === 'auth') f.onAuth();
    return f.run!(lane, work);
  } },
}));
vi.mock('../src/sw/scope.js', () => ({ boundCollectionId: async () => f.target,
  currentSyncScope: async () => null, pushSessionAuthority: vi.fn(async () => undefined) }));
vi.mock('../src/sw/library.js', () => ({ fetchAccountLibrary: async () => f.library,
  verifyLibraryAvailability: async () => 'available' }));
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

test('reconnecting after a server reset publishes the new library and a fresh replica', async () => {
  vi.resetModules();
  const storage = new MemoryStorageArea(), coordinator = createExtensionWorkCoordinator(createAuthorityFence(storage));
  vi.stubGlobal('chrome', { storage: { local: storage } });
  f.target = null; f.binding = null; f.restores = 0; f.onAuth = () => {};
  f.run = (lane, work) => coordinator.run(lane, work);
  f.library = { id: 'rebuilt-library', title: 'Bookmarks', library: true,
    rootNodeId: 'rebuilt-root', bookmarksBarId: 'rebuilt-bar', otherBookmarksId: 'rebuilt-other' };
  const identity = { serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'old-library' };
  const remembered = createRememberedConnectionStore(storage);
  await remembered.write(identity, { version: 1, collectionId: identity.collectionId,
    binding: { replicaId: 'old-replica', browserProfileId: 'profile', generation: '1' } });
  const { browserPersonalSyncPolicy: currentPolicy } = await import('../src/personal-sync-policy.js');
  const policy = currentPolicy();
  await policy.write(identity, 'disconnected');
  const { personalSyncLifecycle: currentLifecycle } = await import('../src/sw/personal-sync.js');
  try {
    const lifecycle = currentLifecycle();
    const preview = await lifecycle.handle({ kind: 'known.personalSync.preview', action: 'resume' });
    assert.ok('token' in preview && 'revision' in preview);
    assert.equal(preview.collectionId, f.library.id);
    await lifecycle.handle({ kind: 'known.personalSync.change', action: 'resume', token: preview.token!,
      revision: preview.revision!, userGesture: true });
    const state = await storage.get(['target', 'known.sync.library.v1']);
    assert.equal(state.target, f.library.id);
    assert.deepEqual(state['known.sync.library.v1'], { accountId: identity.accountId,
      serverOrigin: identity.serverOrigin, status: 'ready', library: f.library });
    assert.equal(f.restores, 1);
    const restored = await remembered.read(identity);
    assert.ok(restored);
    assert.equal(restored.binding.browserProfileId, 'profile');
    assert.notEqual(restored.binding.replicaId, 'old-replica');
    assert.deepEqual(restored.binding, f.binding);
    assert.equal((await policy.read(identity)).collectionId, f.library.id);
    assert.equal((await policy.read(identity)).mode, 'enabled');
  } finally { vi.unstubAllGlobals(); }
});
