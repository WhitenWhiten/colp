import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { replicaIssuesFromQueue } from '../src/sw/replica-health-report.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import type { JsonObject } from '../src/sync-state-store.js';
import { installOutboundPushIndexedDb, json, operation, scope, setup } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

/**
 * A change that fails in this browser before it is ever sent (its native parent
 * cannot be read, its bytes cannot be bound) owns no server sequence. Retrying
 * it forever at the head of the lane held every later upload and told nobody.
 */
test('a change that keeps failing locally before it is sent is set aside, reported, and later changes upload', async () => {
  const fixture = await setup();
  const { store } = fixture;
  await enqueue('op-other', { ...operation, payload: { parentId: 'root-other',
    node: { kind: 'bookmark', title: 'Other', url: 'https://example.test/other' } } });
  const sent: string[] = [];
  const worker = createOutboundPushWorker({ ...fixture.options,
    assertUploadAllowed: async (queue) => { if (queue.opId === 'op-push-1') throw new Error('native_parent_unreadable'); },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
      const op = body.operations[0]!; sent.push(op.opId);
      return json(200, { batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence, status: 'applied',
        targetId: `node-${op.opId}`, revision: 'revision-1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
    } });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal((await worker.drain()).outcome, 'unknown');
    const head = (await store.listQueue(scope)).find((row) => row.opId === 'op-push-1')!;
    assert.equal(head.status, 'unknown'); assert.equal(head.recovery?.code, 'native_parent_unreadable');
    assert.equal(head.retry.attempt, attempt); assert.equal(head.attempt, undefined);
    assert.deepEqual(sent, [], 'the lane waits while the head is still being retried');
    fixture.clock.now = head.retry.notBefore + 1;
  }
  // The fifth identical local failure ends the retries: the change leaves the lane as one item.
  assert.equal((await worker.drain()).outcome, 'terminal');
  const rows = await store.listQueue(scope);
  assert.deepEqual(rows.map((row) => [row.opId, row.status, row.recovery?.code]), [
    ['op-push-1', 'set_aside', 'native_parent_unreadable'], ['op-other', 'terminal', undefined]]);
  assert.deepEqual(sent, ['op-other']);
  assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
  const open = await readOpenSyncIssues(store, scope);
  assert.equal(open.total, 1);
  const [issue] = replicaIssuesFromQueue(open.queue);
  assert.equal(issue?.code, 'native_parent_unreadable');
  assert.equal(issue?.direction, 'push');
  assert.deepEqual(issue?.actions, ['retry'], 'a fresh capture goes through the same checks again');
  // Nothing replays the old bytes; Retry needs a fresh native capture like every other held change.
  await assert.rejects(store.releaseSetAsideQueue(scope, [rows[0]!.sequence]), /recapture_required/);
  store.close();

  async function enqueue(opId: string, payload: JsonObject) {
    await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`,
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
      status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: { ...payload, opId } },
    { validateOperation: () => true, digestOperation: (value) => `sha256:${String(value.opId)}-${String(value.sequence)}` });
  }
});

test('a pause is never blamed on the change at the head', async () => {
  const fixture = await setup();
  const { store } = fixture;
  const worker = createOutboundPushWorker({ ...fixture.options,
    assertUploadAllowed: async () => { throw new Error('permission_required'); },
    fetch: async () => { throw new Error('unexpected_send'); } });
  await drainRepeatedly(worker, store, fixture.clock, 'permission_required');
  store.close();
});

test('an authority problem is never blamed on the change at the head', async () => {
  const fixture = await setup();
  const { store } = fixture;
  const worker = createOutboundPushWorker({ ...fixture.options,
    sessions: { async get() { throw new Error('session_unavailable_now'); } },
    fetch: async () => { throw new Error('unexpected_send'); } });
  await drainRepeatedly(worker, store, fixture.clock, 'session_unavailable_now');
  store.close();
});

async function drainRepeatedly(worker: ReturnType<typeof createOutboundPushWorker>,
  store: Awaited<ReturnType<typeof setup>>['store'], clock: { now: number }, code: string) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    assert.equal((await worker.drain()).outcome, 'unknown', code);
    const head = (await store.listQueue(scope))[0]!;
    assert.equal(head.status, 'unknown', code); assert.equal(head.recovery?.code, code);
    assert.equal(head.retry.attempt, attempt);
    clock.now = head.retry.notBefore + 1;
  }
  assert.equal((await readOpenSyncIssues(store, scope)).total, 0, code);
}
