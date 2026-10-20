import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import type { RejoinChrome } from '../src/scope-rejoin-mutation.js';
import { setup, scope, nativeOrUndefined } from './kns-05-pull-harness.js';

export async function rejoinFixture() {
  const f = await setup();
  await f.store.setFirstRun(scope, 'completed');
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar' });
  const { scopeKey: _key, ...root } = (await f.store.getMappingByNativeId(scope, 'native-root'))!;
  await f.store.putMapping(scope, { ...root, projection: { ...root.projection,
    childrenOrder: ['native-node', 'native-child'] } });
  for (const nativeId of ['native-node', 'native-child']) {
    const { scopeKey: _scopeKey, ...child } = (await f.store.getMappingByNativeId(scope, nativeId))!;
    await f.store.putMapping(scope, { ...child, parentColpId: 'root-colp' });
  }
  const eventApi = {
    get: async (id: string) => (await f.api.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
    getChildren: async (id: string) => (await f.api.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })),
  };
  const queue = createBookmarkEventQueue({ scope, store: f.store, api: eventApi, autoFlush: false });
  const native: RejoinChrome = {
    getNative: id => nativeOrUndefined(f.api, id), getChildren: id => f.api.getChildren(id),
    updateNative: (id, changes) => f.api.update(id, changes),
    moveNative: (id, changes) => f.api.move(id, changes),
    removeNative: (id, tree) => tree ? f.api.removeTree(id) : f.api.remove(id),
    createNative: details => f.api.create(details),
  };
  return { ...f, queue, native, eventApi };
}
