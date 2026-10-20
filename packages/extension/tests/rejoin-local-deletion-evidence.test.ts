import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { deletionFixture } from './rejoin-decision-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { missingRejoinGroups, reconcileMissingRejoinDeletes, rejoinDeleteTitle,
  stageMissingRejoinDelete } from '../src/scope-rejoin-deletion.js';
import { snapshotMapping } from '../src/scope-rejoin-authority.js';
import type { RejoinOrderInput } from '../src/scope-rejoin-order.js';
import type { RemoteObservationRecord } from '../src/sync-state-store.js';

installKns05IndexedDb();
type Fixture = Awaited<ReturnType<typeof deletionFixture>>;
async function input(f: Fixture): Promise<RejoinOrderInput> {
  return { ...f.input(), mount: (await f.getStore().getMountBinding(scope, 'mount-bar'))! };
}

test('an unchanged complete cloud subtree stages one delete and retains its preimage through replay', async () => {
  const f = await deletionFixture(0);
  try {
    f.setFacts(f.snapshot().remoteFacts.map(row => row.nodeId === 'restore-folder'
      ? { ...row, revision: 'revision-old', title: 'Folder', childrenRevision: 'children-old' } : row));
    await f.compare();
    const [row] = await f.getStore().listQueue(scope); assert.ok(row);
    assert.equal(row.payload.type, 'delete_subtree'); assert.equal(row.payload.targetId, 'restore-folder');
    assert.equal(row.baseRevision, 'revision-old'); assert.equal(row.status, 'pending');
    const [plan] = (await f.getStore().listScopeCommandPlans(scope)).filter(row => row.rejoinDecision?.kind === 'local_delete');
    assert.ok(plan); assert.equal(plan.phase, 'applying'); assert.deepEqual(plan.dependencies, [row.opId]);
    assert.equal((await f.getStore().getMappingByColpId(scope, 'restore-folder'))!.nativeId, 'native-folder');
    const native = f.api.all(); const calls = [...f.api.calls];
    f.reopen(); await f.compare();
    assert.deepEqual(await f.getStore().listQueue(scope), [row]);
    const groups = await missingRejoinGroups(await input(f), await f.getStore().listMappings(scope), []);
    assert.equal(await stageMissingRejoinDelete(await input(f), groups[0]!), row.opId);
    assert.deepEqual(await f.getStore().listQueue(scope), [row]);
    assert.deepEqual(f.api.all(), native); assert.deepEqual(f.api.calls, calls);
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))!.status, 'detached');
  } finally { f.getStore().close(); }
});

test('when both local and authoritative cloud subtree are gone only stale missing mappings are retired', async () => {
  const f = await deletionFixture(0);
  try {
    f.setFacts(f.snapshot().remoteFacts.filter(row => row.nodeId === 'root-colp'));
    const native = f.api.all(); const calls = [...f.api.calls];
    await f.compare();
    assert.equal(await f.getStore().getMappingByColpId(scope, 'restore-folder'), null);
    assert.ok(await f.getStore().getMappingByColpId(scope, 'root-colp'));
    assert.deepEqual(await f.getStore().listQueue(scope), []);
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))!.status, 'active');
    assert.deepEqual(f.api.all(), native); assert.deepEqual(f.api.calls, calls);
  } finally { f.getStore().close(); }
});

test('a missing optimistic local projection remains unsettled instead of authorizing a cloud delete', async () => {
  const f = await deletionFixture(0);
  try {
    const { scopeKey: _key, ...mapping } = (await f.getStore().getMappingByColpId(scope, 'restore-folder'))!;
    await f.getStore().putMapping(scope, { ...mapping, projection: { ...mapping.projection,
      revision: 'local-unconfirmed', resourceRevision: 'local-unconfirmed' } });
    const result = await reconcileMissingRejoinDeletes(await input(f), await f.getStore().listMappings(scope), []);
    assert.equal(result.conflicts, 1); assert.equal(result.applied, 0);
    assert.deepEqual(await f.getStore().listQueue(scope), []);
    assert.equal((await f.getStore().getMappingByColpId(scope, 'restore-folder'))!.projection.revision, 'local-unconfirmed');
  } finally { f.getStore().close(); }
});

test.each([false, true])('partial remote observations changed=%s stay visible but cannot authorize deletion', async changed => {
  const f = await deletionFixture(0);
  try {
    const current = { ...await input(f), readRemoteSnapshot: undefined };
    const mappings = await f.getStore().listMappings(scope);
    const observations: RemoteObservationRecord[] = changed ? [{ scopeKey: mappings[0]!.scopeKey,
      colpId: 'restore-folder', remoteRevision: 'observed-new', cursor: 'observed-cursor', kind: 'content',
      payload: { title: 'Observed title' }, sourceDigest: 'observed-digest', observedAt: 1 }] : [];
    const [group] = await missingRejoinGroups(current, mappings, observations); assert.ok(group);
    assert.equal(group.remoteChanged, changed); assert.equal(rejoinDeleteTitle(group), 'Folder');
    await assert.rejects(stageMissingRejoinDelete(current, group), /rejoin_remote_order_unavailable/);
    const result = await reconcileMissingRejoinDeletes(current, mappings, observations);
    assert.equal(result.conflicts, 1); assert.equal(result.applied, 0);
    const plan = (await f.getStore().getScopeCommandPlan(scope, group.commandId))!;
    assert.equal(plan.phase, 'pending'); assert.equal(plan.rejoinDecision?.unavailable, true);
    assert.deepEqual(await f.getStore().listQueue(scope), []);
    assert.deepEqual(await f.getStore().listMappings(scope), mappings);
  } finally { f.getStore().close(); }
});

test('a still-live descendant moved out locally blocks deleting the old ancestor using cloud preimages', async () => {
  const f = await deletionFixture();
  try {
    const current = await input(f);
    f.api.seed({ id: 'rescued-child', parentId: 'native-root', title: f.children[0]!.title, url: f.children[0]!.url });
    await f.getStore().putMapping(scope, { ...snapshotMapping(f.children[0]!, current.mount), nativeId: 'rescued-child',
      parentNativeId: 'native-folder' });
    const mappings = await f.getStore().listMappings(scope);
    const [group] = await missingRejoinGroups(current, mappings, []); assert.ok(group?.blockedByLocalMove);
    await assert.rejects(stageMissingRejoinDelete(current, group), /rejoin_waiting_local_move/);
    assert.equal((await reconcileMissingRejoinDeletes(current, mappings, [])).conflicts, 1);
    const decision = (await f.getStore().getScopeCommandPlan(scope, group.commandId))!;
    assert.equal(decision.rejoinDecision?.blockedByLocalMove, true);
    assert.equal(f.api.getNode('rescued-child')?.parentId, 'native-root');
    assert.deepEqual(await f.getStore().listQueue(scope), []);
    assert.deepEqual(await f.getStore().listMappings(scope), mappings);
  } finally { f.getStore().close(); }
});

test('staging cannot invent a target after the complete snapshot has already removed it', async () => {
  const f = await deletionFixture(0);
  try {
    f.setFacts(f.snapshot().remoteFacts.filter(row => row.nodeId === 'root-colp'));
    const current = await input(f); const mappings = await f.getStore().listMappings(scope);
    const [group] = await missingRejoinGroups(current, mappings, []); assert.ok(group);
    await assert.rejects(stageMissingRejoinDelete(current, group), /preview_stale/);
    assert.deepEqual(await f.getStore().listQueue(scope), []);
    assert.deepEqual(await f.getStore().listMappings(scope), mappings);
  } finally { f.getStore().close(); }
});
