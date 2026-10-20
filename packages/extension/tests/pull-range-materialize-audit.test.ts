import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { detachScopeMount } from '../src/scope-commands.js';
import { projectNativeWaits } from '../src/native-wait.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import type { MappingInput } from '../src/sync-state-store.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { adapterRuntime } from './pull-adapter-audit-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

async function subtree(includeSeparator = false) {
  const f = await pullNativeWrapperFixture();
  f.native.seed({ id: '2', parentId: '1', index: 1, title: 'Source folder' });
  f.native.seed({ id: '5', parentId: '2', index: 0, title: 'Child folder' });
  f.native.seed({ id: '6', parentId: '5', index: 0, title: 'Grandchild', url: 'https://grandchild.test/' });
  f.native.seed({ id: '8', parentId: '1', index: 3, title: 'Destination' });
  const mappings: MappingInput[] = [
    { ...f.target, nodeKind: 'folder' as const, projection: { revision: 'target-r1', digest: 'target-folder',
      childrenRevision: 'target-c1', content: { title: 'Source folder' } } },
    { ...f.target, nativeId: '5', colpId: 'child-folder', parentNativeId: '2', parentColpId: 'target',
      nodeKind: 'folder' as const, projection: { revision: 'child-r1', digest: 'child-folder', childrenRevision: 'child-c1',
        content: { title: 'Child folder' } } },
    { ...f.target, nativeId: '6', colpId: 'grandchild', parentNativeId: '5', parentColpId: 'child-folder',
      projection: { revision: 'grand-r1', digest: 'grand', content: { title: 'Grandchild', url: 'https://grandchild.test/' } } },
    { ...f.target, nativeId: 'sidecar:separator', colpId: 'separator', parentNativeId: '5', parentColpId: 'child-folder',
      nodeKind: 'separator' as const, projection: { revision: 'sep-r1', digest: 'sep', content: {} } },
    { ...f.root, nativeId: '8', rootNativeId: '8', colpId: 'dest-root', mountId: 'dest-mount',
      projection: { revision: 'dest-r1', digest: 'dest', childrenRevision: 'dest-c1', content: { title: 'Destination' } } },
  ];
  for (const mapping of mappings) {
    if (mapping.nodeKind !== 'separator' || includeSeparator) await f.store.putMapping(f.scope, mapping);
  }
  await f.store.configureBrowserRoots(f.scope, { discovered: [{ nativeId: '1', ancestorNativeIds: [] },
    { nativeId: '8', ancestorNativeIds: ['1'] }, { nativeId: '3', ancestorNativeIds: ['1'] }],
  selectedNativeIds: ['1', '8'], privateNativeIds: ['3'], status: 'ready' });
  await f.store.setFirstRun(f.scope, 'completed');
  await f.store.putMountBinding(f.scope, { nativeRootId: '8', remoteMountNodeId: 'dest-root',
    mountId: 'dest-mount', status: 'active', materialized: true, customSourceKey: 'folder:8',
    boundaryVersion: (await f.store.getScope(f.scope))!.boundaryVersion! });
  await detachScopeMount(f.store, f.scope, 'mount');
  return f;
}
function moved(collectionId: string) {
  return pullFixtures.page({ events: [pullFixtures.mutationEvent({ kind: 'move', sequence: 91, collectionId,
    targetId: 'target', targetKind: 'folder', parentId: 'dest-root' })], nextCursor: 'moved-cursor', collectionRevision: 'moved-r1' });
}

test.each([false, true])('nested range materialization resumes the confirmed subtree without reusing the old copy (mapping lost=%s)', async lost => {
  const f = await subtree();
  try {
    const first = await adapterRuntime(f, 'after_api_evidence');
    await first.applier.stage(moved(f.scope.collectionId));
    await expect(first.applier.resume()).rejects.toThrow('worker_crash');
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(1);
    if (lost) { await f.store.deleteMapping(f.scope, '5'); await f.store.deleteMapping(f.scope, '6'); }
    f.restart(); const runtime = await adapterRuntime(f); await runtime.applier.resume();
    const root = (await f.store.getMappingByColpId(f.scope, 'target'))!;
    const child = (await f.store.getMappingByColpId(f.scope, 'child-folder'))!;
    const grand = (await f.store.getMappingByColpId(f.scope, 'grandchild'))!;
    expect(root.nativeId).not.toBe('2'); expect(child.nativeId).not.toBe('5'); expect(grand.nativeId).not.toBe('6');
    expect(f.native.getNode(root.nativeId)?.parentId).toBe('8');
    expect(f.native.getNode(child.nativeId)).toMatchObject({ parentId: root.nativeId, title: 'Child folder' });
    expect(f.native.getNode(grand.nativeId)).toMatchObject({ parentId: child.nativeId, url: 'https://grandchild.test/' });
    expect(f.native.getNode('2')?.parentId).toBe('1'); expect(f.native.getNode('5')?.parentId).toBe('2');
    expect(f.native.getNode('6')?.parentId).toBe('5');
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(3);
    expect(f.native.calls.filter(call => call.kind === 'delete' || call.kind === 'move')).toEqual([]);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('moved-cursor');
    const observation = await f.store.getRemoteObservation(f.scope, 'grandchild');
    const source = (await f.store.getMountBinding(f.scope, 'mount'))!;
    expect(observation).toMatchObject({ pauseGeneration: source.pauseBaseline?.generation,
      pauseBoundaryVersion: source.pauseBaseline?.boundaryVersion, pauseCursor: source.pauseBaseline?.lastAppliedCursor });
    f.restart(); await (await adapterRuntime(f)).applier.resume();
    const queue = createBookmarkEventQueue({ store: f.store, scope: f.scope, api: {
      get: async id => (await f.native.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
      getChildren: async id => (await f.native.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })),
    }, autoFlush: false });
    await queue.recover(); await queue.flush();
    expect(await f.store.listQueue(f.scope)).toEqual([]);
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(3);
  } finally { f.close(); }
});

test('a separator inside the moved subtree keeps its sidecar identity without blocking real descendant materialization', async () => {
  const f = await subtree(true);
  try {
    const runtime = await adapterRuntime(f); await runtime.applier.stage(moved(f.scope.collectionId));
    await runtime.applier.resume();
    const child = (await f.store.getMappingByColpId(f.scope, 'child-folder'))!;
    expect(await f.store.getMappingByColpId(f.scope, 'separator')).toMatchObject({ nativeId: 'sidecar:separator',
      nodeKind: 'separator', rootNativeId: '8', parentNativeId: child.nativeId });
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(3);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('moved-cursor');
    expect(await f.store.listQueue(f.scope)).toEqual([]);
    f.restart(); await (await adapterRuntime(f)).applier.resume();
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(3);
  } finally { f.close(); }
});

test('a child call interrupted after Chrome creation waits without duplicating either the root or child', async () => {
  const f = await subtree();
  try {
    const create = f.native.create.bind(f.native); let calls = 0;
    vi.spyOn(f.native, 'create').mockImplementation(async input => {
      const result = await create(input);
      if (++calls === 2) throw new Error('worker_crash');
      return result;
    });
    const first = await adapterRuntime(f); await first.applier.stage(moved(f.scope.collectionId));
    await expect(first.applier.resume()).rejects.toThrow('worker_crash');
    f.restart(); await expect((await adapterRuntime(f)).applier.resume()).rejects.toThrow('native_result_unknown');
    const waits = await projectNativeWaits(f.store, f.scope);
    expect(waits).toHaveLength(1); expect(waits[0]?.colpId).toBe('child-folder');
    expect(calls).toBe(2); expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('moved-cursor');
    expect(f.native.getNode('2')?.parentId).toBe('1');
    f.restart(); await expect((await adapterRuntime(f)).applier.resume()).rejects.toThrow('native_result_unknown');
    expect(calls).toBe(2); expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});

test('an inconsistent native create return cannot reuse the old concrete source identity', async () => {
  const f = await subtree();
  try {
    // External-port fault: even a returned ID must not turn a copy into a
    // reassignment of the user's old, deliberately detached native folder.
    const raw = vi.spyOn(f.native, 'create').mockImplementationOnce(async () => ({ id: '2' }));
    const runtime = await adapterRuntime(f); await runtime.applier.stage(moved(f.scope.collectionId));
    await expect(runtime.applier.resume()).rejects.toThrow('native_result_unknown');
    expect(raw).toHaveBeenCalledOnce();
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe('2');
    expect(f.native.getNode('2')?.parentId).toBe('1'); expect(f.native.getNode('5')?.parentId).toBe('2');
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('moved-cursor');
  } finally { f.close(); }
});
