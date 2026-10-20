import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test } from 'vitest';
import { createSyncStateStore, type ScopeCommandPlanRecord, type SyncScope } from '../src/sync-state-store.js';
import { validateScopeCommandPlan } from '../src/sync-state/scope-command-record.js';

const scope: SyncScope = { environment: 'production', serverId: 'server-facts', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
async function setup() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); stores.push(store);
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [] });
  return store;
}
const command = { commandId: 'review', kind: 'rejoin' as const, confirmationVersion: '1', baselineDigest: null,
  phase: 'confirmed' as const, dependencies: ['dependency'], updatedAt: 1 };
const observation = { colpId: 'node', remoteRevision: 'r1', cursor: 'c1', kind: 'content' as const,
  payload: { title: 'Current' }, sourceDigest: 'sha256:current', observedAt: 1 };

for (const [patch, code] of [
  [{ kind: 'restore' }, 'command_kind_invalid'], [{ phase: 'complete' }, 'command_phase_invalid'],
  [{ dependencies: 'dependency' }, 'command_dependencies_invalid'],
  [{ rejoinDecision: [] }, 'command_decision_invalid'], [{ rejoinDecision: null }, 'command_decision_invalid'],
  [{ rejoinDecision: 'server' }, 'command_decision_invalid'],
] as const) test(`invalid scope command ${code}/${JSON.stringify(patch)} cannot replace a durable decision`, async () => {
  const store = await setup(); await store.putScopeCommandPlan(scope, command);
  const before = await store.getScopeCommandPlan(scope, command.commandId);
  await assert.rejects(store.putScopeCommandPlan(scope, { ...command, ...patch } as unknown as ScopeCommandPlanRecord),
    new RegExp(code));
  store.close();
  assert.deepEqual(await store.getScopeCommandPlan(scope, command.commandId), before);
  assert.equal((await store.listScopeCommandPlans(scope)).length, 1);
});

test('a foreign embedded scope is rejected by the record decoder', () => {
  assert.throws(() => validateScopeCommandPlan('current-scope', { ...command, scopeKey: 'other-scope' }, 10_000),
    /command_scope_invalid/);
});

test('in-flight command retries retain the first decision and reject a different confirmation', async () => {
  const store = await setup(); const first = await store.beginScopeCommandPlan(scope, command);
  assert.deepEqual(await store.beginScopeCommandPlan(scope, { ...command, dependencies: ['changed'], updatedAt: 2 }), first);
  for (const patch of [{ confirmationVersion: '2' }, { kind: 'detach' as const }]) {
    await assert.rejects(store.beginScopeCommandPlan(scope, { ...command, ...patch }), /command_in_flight/);
    assert.deepEqual(await store.getScopeCommandPlan(scope, command.commandId), first);
  }
  for (const phase of ['active', 'failed'] as const) {
    await store.putScopeCommandPlan(scope, { ...command, phase });
    const next = await store.beginScopeCommandPlan(scope, { ...command, confirmationVersion: phase, updatedAt: 3 });
    assert.equal(next.confirmationVersion, phase);
    assert.equal(next.phase, 'confirmed');
  }
});

for (const [patch, code] of [
  [{ kind: 'unknown' }, 'observation_kind_invalid'], [{ payload: [] }, 'observation_payload_invalid'],
  [{ payload: null }, 'observation_payload_invalid'], [{ payload: 'title' }, 'observation_payload_invalid'],
  [{ pauseGeneration: 1 }, 'observation_pause_invalid'],
  [{ pauseGeneration: 1, pauseBoundaryVersion: 'b1' }, 'observation_pause_invalid'],
  [{ pauseBoundaryVersion: 'b1', pauseCursor: 'c0' }, 'observation_pause_invalid'],
] as const) test(`invalid remote observation ${code}/${JSON.stringify(patch)} leaves the prior fact intact`, async () => {
  const store = await setup(); await store.putRemoteObservation(scope, observation);
  const before = await store.getRemoteObservation(scope, observation.colpId);
  await assert.rejects(store.putRemoteObservation(scope, { ...observation, ...patch } as never), new RegExp(code));
  store.close();
  assert.deepEqual(await store.getRemoteObservation(scope, observation.colpId), before);
});

test('deleting observations is empty-safe, scoped and deduplicated', async () => {
  const store = await setup(); await store.putRemoteObservation(scope, observation);
  await store.putRemoteObservation(scope, { ...observation, colpId: 'other' });
  await store.deleteRemoteObservations(scope, []);
  assert.equal((await store.listRemoteObservations(scope)).length, 2);
  await store.deleteRemoteObservations(scope, ['node', 'node', 'missing']);
  assert.equal(await store.getRemoteObservation(scope, 'node'), null);
  assert.equal((await store.getRemoteObservation(scope, 'other'))?.remoteRevision, 'r1');
});

test('tombstone identity repair requires current evidence and rolls back an occupied virtual identity', async () => {
  const store = await setup();
  const mapping = { nativeId: 'native', colpId: 'node', rootNativeId: 'root', parentNativeId: 'root', parentColpId: 'root-node',
    projection: { revision: 'r0', digest: 'sha256:node', content: { title: 'Retained locally' } } };
  await store.putMapping(scope, mapping);
  const target = { nativeId: mapping.nativeId, colpId: mapping.colpId };
  assert.equal(await store.commitTombstoneMappingRepair(scope, target), false);
  await store.putRemoteObservation(scope, observation);
  assert.equal(await store.commitTombstoneMappingRepair(scope, target), false);
  await store.putRemoteObservation(scope, { ...observation, kind: 'tombstone', remoteRevision: 'r2', cursor: 'c2' });
  assert.equal(await store.commitTombstoneMappingRepair(scope, { ...target, nativeId: 'missing' }), false);
  await store.putMapping(scope, { ...mapping, nativeId: 'other-native', colpId: 'other-node' });
  assert.equal(await store.commitTombstoneMappingRepair(scope, { ...target, nativeId: 'other-native' }), false);
  const exclusion = { nativeId: 'native', priorColpId: 'node', decisionId: 'delete', rootNativeId: 'root',
    generation: 1, sourceKind: 'remote_delete' as const };
  for (const patch of [{ nativeId: 'other-native' }, { priorColpId: 'other-node' }, { generation: 2 },
    { sourceKind: 'range_exit' as const }]) {
    await assert.rejects(store.commitTombstoneMappingRepair(scope, { ...target, exclusion: { ...exclusion, ...patch } }),
      /exclusion_source_invalid/);
  }
  await store.putMapping(scope, { ...mapping, nativeId: 'unmounted:node', colpId: 'occupied' });
  const before = await store.exportScope(scope);
  await assert.rejects(store.commitTombstoneMappingRepair(scope, { ...target, exclusion }), /constraint/);
  assert.deepEqual(await store.exportScope(scope), before);
  await store.deleteMapping(scope, 'unmounted:node');
  assert.equal(await store.commitTombstoneMappingRepair(scope, { ...target, exclusion }), true);
  store.close();
  assert.equal(await store.getMappingByNativeId(scope, 'native'), null);
  assert.equal((await store.getMappingByNativeId(scope, 'unmounted:node'))?.parentNativeId, 'unmounted:root-node');
  assert.equal((await store.getLocalSyncExclusion(scope, 'native'))?.priorColpId, 'node');
  assert.equal(await store.commitTombstoneMappingRepair(scope, target), false);
});
