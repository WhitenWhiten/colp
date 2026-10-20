import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { listRejoinDecisions, resolveRejoinDecision, refreshRejoinDecisions } from '../src/scope-rejoin-decisions.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import type { CompleteRemoteSnapshot } from '../src/bootstrap/remote-snapshot.js';
import type { RemoteNodeFact } from '../src/bootstrap/matcher.js';
import type { RejoinChrome } from '../src/scope-rejoin-mutation.js';
import { setup, scope, indexedDB, nativeOrUndefined } from './kns-05-pull-harness.js';

export async function deletionFixture(count = 2, maxRecordBytes?: number) {
  const f = await setup(undefined, true, { maxRecordBytes });
  let store = f.store;
  await store.setFirstRun(scope, 'completed');
  await store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: true, status: 'active', rootRole: 'bookmarks-bar' });
  const { scopeKey: _key, ...root } = (await store.getMappingByNativeId(scope, 'native-root'))!;
  await store.putMapping(scope, { ...root, projection: { ...root.projection, childrenOrder: ['native-folder'] } });
  f.api.seed({ id: 'native-folder', parentId: 'native-root', index: 0, title: 'Folder' });
  await store.putMapping(scope, { nativeId: 'native-folder', colpId: 'restore-folder', rootNativeId: 'native-root',
    mountId: 'mount-bar', parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'folder',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'folder',
      childrenOrder: [], content: { title: 'Folder' } } });
  const children: RemoteNodeFact[] = Array.from({ length: count }, (_, index) => ({
    nodeId: `bookmark-${String(count - index).padStart(38, '0')}`, parentId: 'restore-folder', kind: 'bookmark',
    revision: `cloud-${index}`, title: `Cloud ${index}`, url: `https://example.test/${index}`,
    position: String(index).padStart(6, '0'),
  }));
  let facts: RemoteNodeFact[] = [
    { nodeId: 'root-colp', parentId: null, kind: 'folder', title: 'root-colp', revision: 'revision-old', childrenRevision: 'root-children-cloud' },
    { nodeId: 'restore-folder', parentId: 'root-colp', kind: 'folder', title: 'Cloud folder', revision: 'revision-cloud',
      childrenRevision: 'folder-children-cloud', position: '000000' }, ...children,
  ];
  const snapshot = (): CompleteRemoteSnapshot => ({ snapshotId: 'snapshot-current', revision: 'collection-cloud',
    syncCursor: 'cursor-cloud', remoteFacts: facts, pageCount: Math.ceil(facts.length / 100), identityDigest: 'sha256:snapshot' });
  const native: RejoinChrome = { getNative: id => nativeOrUndefined(f.api, id), getChildren: id => f.api.getChildren(id),
    createNative: value => f.api.create(value), updateNative: (id, value) => f.api.update(id, value),
    moveNative: (id, value) => f.api.move(id, value), removeNative: (id, tree) => tree ? f.api.removeTree(id) : f.api.remove(id),
    readRemoteSnapshot: async () => snapshot() };
  await detachScopeMount(store, scope, 'mount-bar');
  await f.api.removeTree('native-folder');
  const input = () => ({ ...native, store, scope });
  return { ...f, children, native, input, getStore: () => store, snapshot,
    setFacts: (value: RemoteNodeFact[]) => { facts = value; },
    reopen: () => { store.close(); store = createSyncStateStore({ indexedDB, ...(maxRecordBytes ? { maxRecordBytes } : {}) }); return store; },
    compare: () => rejoinScopeMount(store, scope, 'mount-bar', new Set(), [], native),
    list: () => listRejoinDecisions(input()), refresh: () => refreshRejoinDecisions(input()),
    resolve: async (choice: 'keep_remote' | 'delete_remote', chrome: Partial<RejoinChrome> = {}) => {
      const [decision] = await listRejoinDecisions(input());
      if (!decision) throw new Error('test_decision_missing');
      await resolveRejoinDecision({ ...input(), ...chrome }, { kind: 'known.sync.rejoinDecisions.resolve',
        commandId: decision.commandId, token: decision.token, choice, userGesture: true });
      return decision;
    },
    queue: () => createBookmarkEventQueue({ store, scope, autoFlush: false, api: {
      get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
      getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })),
    } }),
  };
}
