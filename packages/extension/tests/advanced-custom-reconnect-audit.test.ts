import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { buildAdvancedPlan } from '../src/bootstrap/advanced-plan.js';
import { activateAdvancedPlan, captureAdvancedCreate, executeActiveAdvancedPlan,
  projectAdvancedSnapshot } from '../src/bootstrap/advanced-run.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createSyncStateStore, type JsonObject, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import type { AdvancedNativeApi } from '../src/bootstrap/advanced-local-executor.js';
import type { LocalNodeFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { honestChrome } from './kns-05-pull-harness.js';

test('advanced reconnect preserves an active custom mount and never adopts an earlier same-content user create', async () => {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  const scope: SyncScope = { environment: 'production', serverId: 'advanced-custom', serverOrigin: 'https://known.example',
    accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
  const native = honestChrome(); native.seed({ id: '0', title: '' });
  native.seed({ id: 'custom', parentId: '0', title: 'Selected', index: 0 });
  const api: AdvancedNativeApi = {
    get: async id => (await native.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
    getChildren: async id => (await native.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })),
    create: async input => { const created = await native.create(input); return (await api.get(created.id))[0]!; },
    update: async (id, changes) => { await native.update(id, changes); return (await api.get(id))[0]!; },
    move: async (id, destination) => { await native.move(id, destination); return (await api.get(id))[0]!; },
    remove: id => native.remove(id),
  };
  try {
    await store.registerScope({ ...scope, lifecycle: 'active', rootStatus: 'ready', firstRun: 'none',
      lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
      checkpoint: { cursor: 'before', serverRevision: 'before' }, selectedRoots: ['remote-custom'] });
    await store.putMapping(scope, { nativeId: 'custom', colpId: 'remote-custom', rootNativeId: 'custom',
      nodeKind: 'folder', mountId: 'existing-custom', rootRole: 'custom', parentColpId: 'library',
      projection: { revision: 'custom-r1', digest: 'custom', childrenRevision: 'custom-c1', content: { title: 'Selected' } } });
    const roots = { discovered: [{ nativeId: 'custom', ancestorNativeIds: [] }],
      selectedNativeIds: ['custom'], privateNativeIds: [], status: 'ready' as const };
    await store.configureBrowserRoots(scope, roots);
    const boundaryVersion = (await store.getScope(scope))!.boundaryVersion!;
    const mounts = [{ nativeRootId: 'custom', remoteMountNodeId: 'remote-custom', customSourceKey: 'folder:custom' }];
    await store.putMountBinding(scope, { ...mounts[0]!, mountId: 'existing-custom', status: 'active',
      materialized: true, boundaryVersion });
    const binding = await store.getMountBinding(scope, 'existing-custom');
    const remote: RemoteNodeFact[] = [
      { nodeId: 'library', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'library-r1', childrenRevision: 'library-c1' },
      { nodeId: 'remote-custom', parentId: 'library', kind: 'folder', title: 'Selected', revision: 'custom-r1', childrenRevision: 'custom-c1' },
      { nodeId: 'cloud-bookmark', parentId: 'remote-custom', kind: 'bookmark', title: 'Cloud', url: 'https://cloud.test/', revision: 'cloud-r1' },
    ];
    const local: LocalNodeFact[] = [{ nativeId: 'custom', mountNativeRootId: 'custom', parentNativeId: '0', kind: 'folder', title: 'Selected' }];
    const plan = buildAdvancedPlan({ scope, confirmationId: 'reviewed-custom', mode: 'download', boundaryVersion,
      treeDigest: 'frozen-native-tree', remoteSnapshotId: 'snapshot', remoteRevision: 'snapshot-r1', remoteCursor: 'snapshot-cursor',
      mounts, local, remote, mappings: [{ nativeId: 'custom', colpId: 'remote-custom' }], rootNodeId: 'library' });
    const committed = await store.commitAdvancedPlan(scope, { planId: plan.planId, now: Date.now(),
      metadata: { mode: 'download', mounts, confirmationId: 'reviewed-custom', treeDigest: 'frozen-native-tree',
        boundaryVersion, discovered: roots.discovered, selectedNativeIds: roots.selectedNativeIds, excludedNativeIds: [] },
      steps: JSON.parse(JSON.stringify([
        ...remote.map(fact => ({ kind: 'snapshot-fact', fact,
          nativeId: plan.matched.find(pair => pair.nodeId === fact.nodeId)?.nativeId ?? null })), ...plan.steps,
      ])) as JsonObject[] });
    await activateAdvancedPlan(store, scope, committed);
    expect(await store.getMountBinding(scope, 'existing-custom')).toEqual(binding);
    const staged: MappingInput[] = remote.map(fact => ({ nativeId: `recovery:${fact.nodeId}`, colpId: fact.nodeId,
      rootNativeId: 'recovery:library', nodeKind: fact.kind,
      ...(fact.parentId ? { parentColpId: fact.parentId } : {}), projection: { revision: fact.revision, digest: fact.nodeId,
        ...(fact.childrenRevision ? { childrenRevision: fact.childrenRevision } : {}),
        content: { title: fact.title, ...(fact.url ? { url: fact.url } : {}), ...(fact.folderRole ? { folderRole: fact.folderRole } : {}) } } }));
    const projected = await projectAdvancedSnapshot(store, scope, staged);
    expect(projected?.find(row => row.colpId === 'remote-custom')).toMatchObject({ nativeId: 'custom', parentColpId: 'library', rootRole: 'custom' });
    expect(projected?.find(row => row.colpId === 'library')).toBeDefined();
    for (const mapping of projected ?? []) await store.putMapping(scope, mapping);

    // The browser delivers a real user create before the confirmed local step
    // starts. Identical content is not evidence that this is the plan's result.
    const external = await api.create({ parentId: 'custom', index: 0, title: 'Cloud', url: 'https://cloud.test/' });
    expect(await captureAdvancedCreate(store, scope, external.id, external)).toBe(false);
    expect((await store.readAdvancedPlan(scope, plan.planId))?.steps.every(step => step.evidence?.observedNativeIds === undefined)).toBe(true);
    await executeActiveAdvancedPlan(store, scope, api);
    const cloud = (await store.getMappingByColpId(scope, 'cloud-bookmark'))!;
    expect(cloud.nativeId).not.toBe(external.id);
    expect(native.getNode(cloud.nativeId)).toMatchObject({ parentId: 'custom', title: 'Cloud', url: 'https://cloud.test/' });
    expect(native.getNode(external.id)).toMatchObject({ parentId: 'custom', title: 'Cloud', url: 'https://cloud.test/' });
    expect(native.calls.filter(call => call.kind === 'create')).toHaveLength(2);
    expect((await store.readAdvancedPlan(scope, plan.planId))?.plan.state).toBe('completed');
    const events = createBookmarkEventQueue({ scope, store, api, autoFlush: false });
    expect((await events.created(external.id, (await api.get(external.id))[0]!)).outcome).toBe('staged');
    await events.flush();
    expect(await store.listQueue(scope)).toEqual([expect.objectContaining({ status: 'pending', payload: expect.objectContaining({ type: 'create_node' }) })]);
    expect(await captureAdvancedCreate(store, scope, external.id, external)).toBe(false);
    expect((await store.getMappingByColpId(scope, 'cloud-bookmark'))?.nativeId).toBe(cloud.nativeId);
  } finally { store.close(); }
});
