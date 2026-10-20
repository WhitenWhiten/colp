import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { nativeChromeFacts } from '../src/sw/native-chrome.js';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { deletionFixture } from './rejoin-decision-harness.js';
import { rejectedOrderFixture } from './rejoin-rejected-harness.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { installKns05IndexedDb, scope, type Kns05Chrome } from './kns-05-pull-harness.js';

installKns05IndexedDb();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function scheduleDuringProductionGuard(mutate: () => Promise<void>) {
  let armed = false, injected = false;
  const pendingOperations = subscriptionStore.pendingOperations;
  vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
    const result = await pendingOperations();
    if (armed && !injected) { injected = true; await mutate(); }
    return result;
  });
  return { arm: () => { armed = true; }, injected: () => injected };
}

function supportedRoot(api: Kns05Chrome) {
  api.seed({ id: '0', title: '' });
  api.seed({ ...api.getNode('native-root'), parentId: '0', folderType: 'bookmarks-bar' });
}

test('production rejoin remove must preserve an edit committed during its final subscription read', async () => {
  const f = await rejoinFixture();
  try {
    await detachScopeMount(f.store, scope, 'mount-bar');
    const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
    await f.store.putRemoteObservation(scope, { colpId: 'node-1', remoteRevision: 'cloud-delete', kind: 'tombstone',
      cursor: 'cloud-delete', payload: { deleted: true }, observedAt: 1, sourceDigest: 'sha256:cloud-delete',
      pauseGeneration: scope.generation, pauseBoundaryVersion: mount.pauseBaseline!.boundaryVersion,
      pauseCursor: mount.pauseBaseline!.lastAppliedCursor });
    let removes = 0;
    vi.stubGlobal('chrome', { bookmarks: { ...f.api, remove: async (id: string) => { removes++; return f.api.remove(id); } } });
    const race = scheduleDuringProductionGuard(() => f.api.update('native-node', { title: 'New edit before remove' }));
    const production = nativeChromeFacts();
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      removeNative: (id, tree) => { race.arm(); return production.removeNative(id, tree); },
    });
    expect(race.injected()).toBe(true);
    expect.soft(removes).toBe(0);
    expect.soft(f.api.getNode('native-node')?.title).toBe('New edit before remove');
  } finally { f.store.close(); }
});

test('production rejoin move must preserve a user move committed during its final subscription read', async () => {
  const f = await rejoinFixture();
  try {
    supportedRoot(f.api);
    for (const id of ['remote-dest', 'user-dest']) {
      f.api.seed({ id, parentId: 'native-root', title: id });
      await f.store.putMapping(scope, { nativeId: id, colpId: `${id}-colp`, rootNativeId: 'native-root',
        parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'folder', projection: {
          revision: 'revision-old', digest: id, childrenRevision: `${id}-children`, content: { title: id } } });
    }
    await detachScopeMount(f.store, scope, 'mount-bar');
    const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
    await f.store.putRemoteObservation(scope, { colpId: 'node-1', remoteRevision: 'cloud-move', kind: 'placement',
      cursor: 'cloud-move', payload: { parentId: 'remote-dest-colp' }, observedAt: 1, sourceDigest: 'sha256:cloud-move',
      pauseGeneration: scope.generation, pauseBoundaryVersion: mount.pauseBaseline!.boundaryVersion,
      pauseCursor: mount.pauseBaseline!.lastAppliedCursor });
    let moves = 0;
    vi.stubGlobal('chrome', { bookmarks: { ...f.api,
      move: async (id: string, placement: { parentId: string; index: number }) => { moves++; return f.api.move(id, placement); } } });
    const race = scheduleDuringProductionGuard(() => f.api.move('native-node', { parentId: 'user-dest', index: 0 }));
    const production = nativeChromeFacts();
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
      moveNative: (id, placement) => { race.arm(); return production.moveNative(id, placement); },
    });
    expect(race.injected()).toBe(true);
    expect.soft(moves).toBe(0);
    expect.soft(f.api.getNode('native-node')?.parentId).toBe('user-dest');
  } finally { f.store.close(); }
});

test('production rejoin order must preserve a new order committed inside the move wrapper', async () => {
  const f = await rejectedOrderFixture();
  try {
    supportedRoot(f.api);
    await f.compare();
    const userOrder = ['native-b', 'native-a', 'native-d', 'native-c'];
    let moves = 0;
    vi.stubGlobal('chrome', { bookmarks: { ...f.api,
      move: async (id: string, placement: { parentId: string; index: number }) => { moves++; return f.api.move(id, placement); } } });
    const race = scheduleDuringProductionGuard(async () => {
      for (const [index, id] of userOrder.entries()) await f.api.move(id, { parentId: 'native-root', index });
    });
    const production = nativeChromeFacts();
    await f.resolve('keep_remote_order', {
      moveNative: (id, placement) => { race.arm(); return production.moveNative(id, placement); },
    });
    expect(race.injected()).toBe(true);
    expect.soft(moves).toBe(0);
    expect.soft((await f.api.getChildren('native-root')).map(node => node.id)).toEqual(userOrder);
  } finally { f.getStore().close(); }
});

test('production rejoin restore must not create in a parent excluded during its native wrapper', async () => {
  const f = await deletionFixture();
  try {
    supportedRoot(f.api);
    await f.compare();
    let creates = 0;
    vi.stubGlobal('chrome', { bookmarks: { ...f.api,
      create: async (input: { parentId?: string; index?: number; title?: string; url?: string }) => {
        creates++; return f.api.create(input);
      } } });
    const race = scheduleDuringProductionGuard(async () => {
      await f.getStore().putLocalSyncExclusion(scope, { nativeId: 'native-root', rootNativeId: 'native-root',
        generation: scope.generation, priorColpId: 'root-colp', decisionId: 'private-during-restore' });
    });
    const production = nativeChromeFacts();
    await f.resolve('keep_remote', {
      createNative: input => { race.arm(); return production.createNative(input); },
    });
    expect(race.injected()).toBe(true);
    expect.soft(creates).toBe(0);
    expect.soft(f.api.calls.filter(row => row.kind === 'create')).toEqual([]);
  } finally { f.getStore().close(); }
});
