import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bindStructureMapping, planCreated, planRestored } from '../src/pull-mount-apply.js';
import type { MappingInput, MountBindingRecord, createSyncStateStore } from '../src/sync-state-store.js';
import { installKns03IndexedDb, scope, setup } from './kns-03-bootstrap-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns03IndexedDb();
let store: ReturnType<typeof createSyncStateStore>;
beforeEach(async () => { store = (await setup()).store; });
afterEach(() => { store.close(); });

const mount: Omit<MountBindingRecord, 'scopeKey'> = {
  mountId: 'selected-mount', nativeRootId: 'selected-folder', remoteMountNodeId: 'remote-selected',
  boundaryVersion: '1', materialized: false, status: 'active', customSourceKey: 'folder:selected',
};
function created(folderRole: string, parentId = 'remote-root', replicaId = scope.replicaId) {
  const event = pullFixtures.createEvent({ kind: 'Folder', sequence: 7,
    collectionId: scope.collectionId, parentId, folderRole, replicaId });
  if (event.kind !== 'operation' || event.effect.kind !== 'node_created') throw new Error('create fixture required');
  return event as Extract<Parameters<typeof planCreated>[2], { operation: { type: 'create_node' } }>;
}
function mapping(colpId: string, extra: Partial<MappingInput> = {}): MappingInput {
  return { nativeId: `native-${colpId}`, colpId, nodeKind: 'folder', rootNativeId: mount.nativeRootId,
    projection: { revision: 'r1', digest: 'sha256:existing', content: { title: 'Existing' } }, ...extra };
}
async function ownCreate(terminal: boolean) {
  const row = await store.allocateSequenceAndEnqueue(scope, {
    opId: 'op-7', batchId: 'batch-7', idempotencyKey: 'key-7', digest: 'sha256:create',
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'r1',
    operationRevision: 'local-r1', status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { type: 'create_node' },
  }, { allowUnstamped: true });
  if (terminal) await store.completeQueueWithReceipt(scope, row.sequence, {
    opId: row.opId, operationDigest: row.digest, kind: 'terminal',
    receiptId: 'receipt-7', resultDigest: 'sha256:result',
  });
}

for (const explicitRole of [true, false]) {
  test(`a known special ancestor binds its existing native folder (explicit role=${explicitRole})`, async () => {
    await store.putMountBinding(scope, mount);
    const event = created('bookmarks-bar');
    const existing = mapping(event.effect.node.id, {
      parentNativeId: 'native-browser-root',
      ...(explicitRole ? { rootRole: 'bookmarks-bar' as const } : {}),
      projection: { revision: 'r1', digest: 'sha256:ancestor',
        content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } },
    });
    await store.putMapping(scope, existing);
    const plan = await planCreated(store, scope, event);
    expect(plan.kind).toBe('bind_structure');
    if (plan.kind !== 'bind_structure') throw new Error('structure binding required');
    const rebound = bindStructureMapping(event.effect.node, plan.mapping, 'remote-root', 'children-new');
    expect(rebound).toMatchObject({ nativeId: existing.nativeId, parentNativeId: 'native-browser-root',
      parentColpId: 'remote-root', rootNativeId: existing.rootNativeId,
      projection: { revision: event.effect.node.revision, childrenRevision: 'children-new' } });
    expect(rebound.rootRole).toBe(explicitRole ? 'bookmarks-bar' : undefined);
    expect(rebound.mountId).toBeUndefined();
    expect(await store.listMountBindings(scope)).toHaveLength(1);
  });
}

for (const scenario of ['settled', 'pending', 'peer', 'placeholder', 'bookmark'] as const) {
  test(`custom structural reuse requires our settled create and a real folder (${scenario})`, async () => {
    await store.putMountBinding(scope, mount);
    await ownCreate(scenario !== 'pending');
    const event = created('custom', 'remote-root', scenario === 'peer' ? 'peer-replica' : scope.replicaId);
    const existing = mapping(event.effect.node.id, {
      ...(scenario === 'placeholder' ? { nativeId: `recovery:${event.effect.node.id}` } : {}),
      ...(scenario === 'bookmark' ? { nodeKind: 'bookmark' as const } : {}),
    });
    await store.putMapping(scope, existing);
    const plan = await planCreated(store, scope, event);
    expect(plan.kind).toBe(scenario === 'settled' ? 'bind_structure' : 'skip_unmounted');
    if (plan.kind === 'bind_structure') {
      const rebound = bindStructureMapping(event.effect.node, plan.mapping, 'remote-root', null);
      expect(rebound.nativeId).toBe(existing.nativeId);
      expect(rebound.parentNativeId).toBeUndefined();
      expect(rebound.rootRole).toBeUndefined();
      expect(rebound.mountId).toBeUndefined();
    }
  });
}

for (const ownership of ['native-root', 'mount-id'] as const) {
  test(`Recovered uses the proven owning mount through ${ownership}`, async () => {
    await store.putMountBinding(scope, mount);
    await store.putMapping(scope, mapping('remote-parent', ownership === 'mount-id'
      ? { rootNativeId: 'legacy-root', mountId: mount.mountId } : {}));
    const plan = await planCreated(store, scope, created('recovered', 'remote-parent'));
    expect(plan).toMatchObject({ kind: 'recovered_folder', mount: { mountId: mount.mountId } });
  });
}

test('a collection root never proves ownership of Recovered in the only selected mount', async () => {
  await store.putMountBinding(scope, mount);
  await store.putMapping(scope, mapping('remote-root', {
    projection: { revision: 'r1', digest: 'sha256:root', content: { title: '', folderRole: 'root' } },
  }));
  expect(await planCreated(store, scope, created('recovered'))).toEqual({ kind: 'skip_unmounted' });
});

test('restore waits for missing authority and keeps virtual or detached parents out of Chrome', async () => {
  expect(await planRestored(store, scope, 'missing')).toEqual({ kind: 'need_authority' });
  await store.putMapping(scope, mapping('virtual-parent', { nativeId: 'sidecar:parent' }));
  expect(await planRestored(store, scope, 'virtual-parent')).toEqual({ kind: 'skip_unmounted' });
  await store.putMountBinding(scope, { ...mount, status: 'detached' });
  expect(await planRestored(store, scope, mount.remoteMountNodeId!)).toEqual({ kind: 'skip_unmounted' });
});
