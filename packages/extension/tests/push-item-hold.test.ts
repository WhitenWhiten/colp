import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { replicaIssuesFromQueue } from '../src/sw/replica-health-report.js';
import type { JsonObject } from '../src/sync-state-store.js';
import { installOutboundPushIndexedDb, json, operation, scope, setup } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

test('a save set aside for its deleted folder holds only what depends on it, and the next save uploads', async () => {
  const fixture = await setup({ createPlacement: 'top' });
  const { store } = fixture;
  // The saved folder is gone on the server.
  await store.putRemoteObservation(scope, { colpId: 'root-push', remoteRevision: 'deleted-r1',
    cursor: 'cursor-deleted', kind: 'tombstone', payload: { deleted: true },
    sourceDigest: 'sha256:deleted-parent', observedAt: 20 });
  // An edit of the held save and a bookmark created inside it depend on it; another save does not.
  await enqueue('op-edit', { ...operation, type: 'update_node_content', targetId: 'pending-op-push-1',
    baseRevision: 'local-event-push-1', payload: { base: { title: 'Public' }, value: { title: 'Edited' } } });
  await enqueue('op-child', { ...operation, payload: { parentId: 'pending-op-push-1',
    node: { kind: 'bookmark', title: 'Child', url: 'https://example.test/child' } } });
  await enqueue('op-other', { ...operation, payload: { parentId: 'root-other',
    node: { kind: 'bookmark', title: 'Other', url: 'https://example.test/other' } } });
  const sent: string[] = [];
  const worker = createOutboundPushWorker({ ...fixture.options, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
    const op = body.operations[0]!; sent.push(op.opId);
    return json(200, { batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence, status: 'applied',
      targetId: `node-${op.opId}`, revision: 'revision-1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
  } });
  assert.equal((await worker.drain()).outcome, 'terminal');
  assert.deepEqual(sent, ['op-other']);
  const rows = await store.listQueue(scope);
  assert.deepEqual(rows.map((row) => [row.opId, row.status, row.recovery?.code]), [
    ['op-push-1', 'set_aside', 'create_placement_parent_deleted'],
    ['op-edit', 'set_aside', 'dependency_hold'], ['op-child', 'set_aside', 'dependency_hold'],
    ['op-other', 'terminal', undefined]]);
  assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
  assert.deepEqual(replicaIssuesFromQueue(rows).map((issue) => issue.code),
    ['create_placement_parent_deleted', 'dependency_hold', 'dependency_hold']);
  // Nothing releases the dependants while the save they wait for is held.
  assert.deepEqual(await store.releaseSettledHolds(scope), []);
  // A decision cannot clear identity/placement proof and replay the old bytes.
  await assert.rejects(store.releaseSetAsideQueue(scope, [rows[0]!.sequence]), /recapture_required/);
  assert.deepEqual(await store.releaseSettledHolds(scope), []);
  store.close();

  async function enqueue(opId: string, payload: JsonObject) {
    await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`,
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
      status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: { ...payload, opId } },
    { validateOperation: () => true, digestOperation: (value) => `sha256:${String(value.opId)}-${String(value.sequence)}` });
  }
});
