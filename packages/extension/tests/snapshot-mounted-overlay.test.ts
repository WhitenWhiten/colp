import { expect, test } from 'vitest';
import { scope, setup, stores } from './snapshot-boundary-fixture.js';
import { createSyncStateStore, type MappingInput } from '../src/sync-state-store.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';

test('a fully materialized mounted snapshot does not rebind or recreate its structural parent and historical unselected sibling', async () => {
  const f = await setup();
  await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.chrome.api, staged: f.rows, freezeUnprovenIdentity: true });
  // The previous release could create this cloud sibling under the Bar. Its
  // native identity is preserved across upgrade; it is not current selection.
  const old = await f.chrome.api.create({ parentId: '1', title: 'Historical local copy', url: 'https://outside.example/' });
  const stored = (await f.store.getMappingByColpId(scope, 'outside'))!;
  const { scopeKey: _scopeKey, ...mapping } = stored;
  await f.store.putMapping(scope, { ...mapping, nativeId: old.id,
    projection: { ...mapping.projection, content: { title: 'Historical local copy', url: 'https://outside.example/' } } });
  const beforeNative = structuredClone([...f.chrome.nodes.values()]);
  const beforeIds = (await f.store.listMappings(scope)).map(row => [row.colpId, row.nativeId]);
  const staged = (await f.store.listMappings(scope)).map(row => row.colpId === 'outside' ? { ...row,
    projection: { ...row.projection, revision: 'outside-new', content: { title: 'Cloud changed again', url: 'https://outside.example/' } } } : row);
  f.store.close(); const reopened = createSyncStateStore({ indexedDB: f.indexedDB }); stores.push(reopened);
  const result = await recoverVerifiedOrFreeze({ scope, store: reopened, api: f.chrome.api, staged, freezeUnprovenIdentity: true });
  expect(result.map(row => [row.colpId, row.nativeId]).sort()).toEqual([...beforeIds].sort());
  expect([...f.chrome.nodes.values()]).toEqual(beforeNative);
  expect(f.chrome.creates).toBe(2); expect(await reopened.listQueue(scope)).toEqual([]);
  expect((await reopened.getMappingByColpId(scope, 'outside'))?.projection.content?.title).toBe('Historical local copy');
  expect((await reopened.getRemoteObservation(scope, 'outside'))?.payload.title).toBe('Cloud changed again');
});

async function materialized() {
  const f = await setup();
  await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.chrome.api, staged: f.rows, freezeUnprovenIdentity: true });
  return f;
}

async function addOtherMount(f: Awaited<ReturnType<typeof materialized>>) {
  const root = await f.chrome.api.create({ parentId: '1', title: 'Second selected root' });
  const child = await f.chrome.api.create({ parentId: root.id, title: 'Second child', url: 'https://second.example/' });
  const rootMapping: MappingInput = { colpId: 'other', nativeId: root.id, rootNativeId: root.id,
    parentColpId: 'bar', parentNativeId: '1', nodeKind: 'folder', mountId: 'other-mount',
    projection: { revision: 'other-r1', digest: 'other-d1', childrenRevision: 'other-c1', content: { title: 'Second selected root' } } };
  const childMapping: MappingInput = { colpId: 'other-child', nativeId: child.id, rootNativeId: root.id,
    parentColpId: 'other', parentNativeId: root.id, nodeKind: 'bookmark', mountId: 'other-mount',
    projection: { revision: 'other-child-r1', digest: 'other-child-d1', content: { title: 'Second child', url: 'https://second.example/' } } };
  await f.store.putMapping(scope, rootMapping); await f.store.putMapping(scope, childMapping);
  await f.store.putMountBinding(scope, { mountId: 'other-mount', nativeRootId: root.id, remoteMountNodeId: 'other',
    customSourceKey: 'second-source', boundaryVersion: '1', status: 'active', materialized: true });
  await f.store.configureBrowserRoots(scope, { selectedNativeIds: ['10', root.id], privateNativeIds: [], status: 'ready',
    discovered: [{ nativeId: '1', ancestorNativeIds: [] }, { nativeId: '10', ancestorNativeIds: ['1'] }, { nativeId: root.id, ancestorNativeIds: ['1'] }] });
  expect((await f.store.getScope(scope))?.selectedRoots).toEqual(['chosen', 'other']);
  return { root: root.id, child: child.id };
}

test('complete mounted Snapshot deletion removes the actual selected child but preserves structural and unselected facts', async () => {
  const f = await materialized(), child = (await f.store.getMappingByColpId(scope, 'inside'))!;
  const staged = (await f.store.listMappings(scope)).filter(row => row.colpId !== 'inside');
  const result = await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.chrome.api, staged, freezeUnprovenIdentity: true });
  expect(f.chrome.nodes.has(child.nativeId)).toBe(false);
  expect(await f.store.getMappingByColpId(scope, 'inside')).toBeNull();
  expect(result.map(row => row.colpId).sort()).toEqual(['bar', 'chosen', 'outside']);
  expect(f.chrome.nodes.get('10')).toMatchObject({ title: 'Selected', parentId: '1' });
  expect(f.chrome.creates).toBe(1); expect(await f.store.listQueue(scope)).toEqual([]);
  expect((await f.store.listProjectionIntents(scope)).filter(row => row.kind === 'delete')).toEqual([
    expect.objectContaining({ kind: 'delete', colpId: 'inside', state: 'terminal' }),
  ]);
});

test('deletions for both active mounts remain in one durable plan across a native failure and reopen', async () => {
  const f = await materialized(), other = await addOtherMount(f);
  const first = (await f.store.getMappingByColpId(scope, 'inside'))!;
  const staged = (await f.store.listMappings(scope)).filter(row => !['inside', 'other-child'].includes(row.colpId));
  f.chrome.crashOn.remove = 1;
  await expect(recoverVerifiedOrFreeze({ scope, store: f.store, api: f.chrome.api, staged, freezeUnprovenIdentity: true })).rejects.toThrow('chrome_crash');
  const planned = (await f.store.listProjectionIntents(scope)).filter(row => row.kind === 'delete');
  expect(planned.map(row => row.colpId).sort()).toEqual(['inside', 'other-child']);
  expect(planned.some(row => row.state === 'recovery')).toBe(true);
  f.store.close(); const reopened = createSyncStateStore({ indexedDB: f.indexedDB }); stores.push(reopened);
  await recoverVerifiedOrFreeze({ scope, store: reopened, api: f.chrome.api, staged, freezeUnprovenIdentity: true });
  expect(f.chrome.nodes.has(first.nativeId)).toBe(false); expect(f.chrome.nodes.has(other.child)).toBe(false);
  expect(f.chrome.nodes.has('10')).toBe(true); expect(f.chrome.nodes.has(other.root)).toBe(true);
  expect((await reopened.listProjectionIntents(scope)).filter(row => row.kind === 'delete').every(row => row.state === 'terminal')).toBe(true);
  expect(f.chrome.creates).toBe(3); expect(await reopened.listQueue(scope)).toEqual([]);
});

test('an identity moved between two selected mounts is never treated as a fresh create or a deletion from its old mount', async () => {
  const f = await materialized(), other = await addOtherMount(f);
  const first = (await f.store.getMappingByColpId(scope, 'inside'))!, before = f.chrome.creates;
  const staged = (await f.store.listMappings(scope)).map(row => row.colpId === 'inside'
    ? { ...row, parentColpId: 'other', parentNativeId: other.root } : row);
  await expect(recoverVerifiedOrFreeze({ scope, store: f.store, api: f.chrome.api, staged, freezeUnprovenIdentity: true }))
    .rejects.toThrow('snapshot_placement_boundary');
  expect(f.chrome.creates).toBe(before);
  expect(f.chrome.nodes.get(first.nativeId)).toMatchObject({ title: 'inside', parentId: '10' });
  expect((await f.store.getMappingByColpId(scope, 'inside'))?.nativeId).toBe(first.nativeId);
  expect((await f.store.listProjectionIntents(scope)).filter(row => row.colpId === 'inside' && row.state !== 'terminal')).toEqual([
    expect.objectContaining({ kind: 'move', state: 'recovery', nativeId: first.nativeId }),
  ]);
  expect(await f.store.listQueue(scope)).toEqual([]);
});

test.each(['detached', 'pending', 'private', 'unselected', 'missing-root'])
('globally missing nodes cannot be deleted through a %s native boundary', async variant => {
  const f = await materialized(), target = (await f.store.getMappingByColpId(scope, 'inside'))!;
  if (variant === 'private') {
    await f.store.configureBrowserRoots(scope, { selectedNativeIds: ['10'], privateNativeIds: ['10'], status: 'ready',
      discovered: [{ nativeId: '1', ancestorNativeIds: [] }, { nativeId: '10', ancestorNativeIds: ['1'] }] });
    expect((await f.store.getScope(scope))?.privateRoots).toEqual(['chosen']);
  } else if (variant === 'unselected') {
    await f.chrome.api.move(target.nativeId, { parentId: '1' });
    const { scopeKey: _scopeKey, ...mapping } = target;
    await f.store.putMapping(scope, { ...mapping, parentColpId: 'bar', parentNativeId: '1', rootNativeId: '1', mountId: undefined });
  } else if (variant === 'missing-root') await f.store.deleteMapping(scope, '10');
  else {
    const { scopeKey: _scopeKey, ...mount } = (await f.store.getMountBinding(scope, 'selected-mount'))!;
    await f.store.putMountBinding(scope, { ...mount, status: variant === 'pending' ? 'pending' : 'detached' });
  }
  const staged = (await f.store.listMappings(scope)).filter(row => row.colpId !== 'inside');
  const before = structuredClone([...f.chrome.nodes.values()]);
  await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.chrome.api, staged, freezeUnprovenIdentity: true });
  expect([...f.chrome.nodes.values()]).toEqual(before);
  expect((await f.store.getMappingByColpId(scope, 'inside'))?.nativeId).toBe(target.nativeId);
  expect((await f.store.listProjectionIntents(scope)).some(row => row.kind === 'delete')).toBe(false);
  expect(f.chrome.creates).toBe(1); expect(await f.store.listQueue(scope)).toEqual([]);
});

test('the absence of an entire mounted remote root still deletes its confirmed children without removing the local mount folder', async () => {
  const f = await materialized(), child = (await f.store.getMappingByColpId(scope, 'inside'))!;
  const staged = (await f.store.listMappings(scope)).filter(row => !['chosen', 'inside'].includes(row.colpId));
  await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.chrome.api, staged, freezeUnprovenIdentity: true });
  expect(f.chrome.nodes.has(child.nativeId)).toBe(false);
  expect(f.chrome.nodes.get('10')).toMatchObject({ title: 'Selected', parentId: '1' });
  expect((await f.store.listProjectionIntents(scope)).filter(row => row.kind === 'delete').map(row => row.colpId)).toEqual(['inside']);
  expect(f.chrome.creates).toBe(1);
});


test('a globally absent node with an outstanding local edit retains its exact mapping, queue identity, and native value', async () => {
  const f = await materialized(), target = (await f.store.getMappingByColpId(scope, 'inside'))!;
  await f.chrome.api.update(target.nativeId, { title: 'Unsent local edit' });
  const queued = await f.store.allocateSequenceAndEnqueue(scope, {
    opId: 'local-edit', batchId: 'local-batch', idempotencyKey: 'local-key', digest: 'sha256:local-edit',
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: target.projection.revision,
    operationRevision: 'local-edit', status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { type: 'update_node_content', targetId: 'inside',
      payload: { base: { title: 'inside' }, value: { title: 'Unsent local edit' } } },
  }, { allowUnstamped: true });
  const staged = (await f.store.listMappings(scope)).filter(row => row.colpId !== 'inside');
  const result = await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.chrome.api, staged, freezeUnprovenIdentity: true });
  expect(f.chrome.nodes.get(target.nativeId)).toMatchObject({ title: 'Unsent local edit', parentId: '10' });
  expect(result.find(row => row.colpId === 'inside')).toMatchObject({ nativeId: target.nativeId });
  expect(await f.store.getMappingByColpId(scope, 'inside')).toEqual(target);
  expect(await f.store.listQueue(scope)).toEqual([queued]);
  expect(await f.store.getQueueReceipt(scope, queued.sequence)).toBeNull();
  expect((await f.store.listProjectionIntents(scope)).filter(row => row.kind === 'delete')).toEqual([]);
  expect(f.chrome.creates).toBe(1);
});
