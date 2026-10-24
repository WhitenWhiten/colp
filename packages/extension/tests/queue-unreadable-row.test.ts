import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { replicaIssuesFromQueue } from '../src/sync-issue-snapshot.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { ack, emptyPullPage, json, scope, setup } from './durable-sync-engine-harness.js';

/**
 * Rule C / A-F3 / W2C-05: one queue row that cannot be read stopped the whole engine
 * (`queue_state_invalid` is replica/stop; later manual wakes rejected, alarm wakes were inert, Status
 * said `state_unavailable`). A change that was never sent now leaves the lane as one item with its
 * opId and the raw record kept for diagnosis; a change the server may own makes only the push lane
 * wait, and Pull and Ack carry on.
 */
type Fixture = Awaited<ReturnType<typeof setup>>;
async function corrupt(f: Fixture, opId: string, mutate: (value: Record<string, unknown>) => void) {
  const db = await f.store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('outbound_queue', 'readwrite'); const store = tx.objectStore('outbound_queue');
    store.openCursor().onsuccess = (event: Event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result; if (!cursor) return;
      const value = cursor.value as Record<string, unknown>;
      if (value.opId === opId) { mutate(value); cursor.update(value); }
      cursor.continue();
    };
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
}
function attachWorker(f: Fixture, sent: string[]) {
  const session = async () => ({ credential: { accessToken: 't' }, session: { sessionId: f.sessionId, expiresAt: '2099-01-01T00:00:00Z',
    scope: 'collection' as const, acceptedProtocolVersion: '0.2' as const, snapshotRequired: false,
    collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
    replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active' as const, expiresAt: '2099-01-01T00:00:00Z' } } as never });
  const worker = createOutboundPushWorker({ scope, store: f.store, endpoints: async () => ({ syncPush: 'https://known.example/v1/push' } as never),
    sessions: { get: session }, now: () => f.clock.now, random: () => 0, ownerId: () => 'o', schedule: () => undefined,
    fetch: async (_url, init) => { const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
      const op = body.operations[0]!; sent.push(op.opId);
      return json(200, { batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence, status: 'applied',
        targetId: `node-${op.opId}`, revision: 'revision-1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' }); } });
  (f.push as { drain: unknown }).drain = (callback?: () => void) => worker.drain(callback);
}
async function wake(f: Fixture, reason: 'alarm' | 'manual', index: number) {
  f.pullResponses.push(json(200, emptyPullPage(`cursor-${index}`))); f.ackResponses.push(json(200, ack(`cursor-${index}`)));
  f.clock.now += 120_000;
  return f.engine.wake(reason);
}

describe('Rule C an unsent unreadable row is quarantined as one item', () => {
  test('the engine keeps going, the row is held with its opId and the raw record is archived', async () => {
    const f = await setup(); f.clock.now = Date.now(); const sent: string[] = [];
    await f.enqueue('op-good-1'); await f.enqueue('op-bad-2'); await f.enqueue('op-next-3', { sequence: 3 });
    await corrupt(f, 'op-bad-2', (value) => { value.endpointIdentity = 'weird'; });
    attachWorker(f, sent);
    for (const [index, reason] of (['alarm', 'alarm', 'manual', 'alarm'] as const).entries()) {
      const state = await wake(f, reason, index);
      assert.notEqual(state?.phase, 'error', `wake ${index}`);
    }
    assert.deepEqual(sent, ['op-good-1', 'op-next-3'], 'the unreadable row is stepped over, later changes upload');
    const rows = await f.store.listQueue(scope);
    assert.deepEqual(rows.map((row) => [row.opId, row.status, row.recovery?.code]), [
      ['op-good-1', 'terminal', undefined], ['op-bad-2', 'set_aside', 'queue_row_unreadable'], ['op-next-3', 'terminal', undefined]]);
    assert.equal(f.pullRequests.length, 4, 'Pull ran on every wake');
    // The raw record is kept for diagnosis.
    const diagnostics = (await f.store.exportDiagnostics()).records as Array<Record<string, unknown>>;
    const archived = diagnostics.find((row) => row.kind === 'queue_quarantine')!;
    assert.equal((archived.record as Record<string, unknown>).endpointIdentity, 'weird');
    assert.equal((archived.details as Record<string, unknown>).opId, 'op-bad-2');
    // Status works and names the item.
    const attention = await handleSyncAttentionRequest({ scope: async () => scope, store: f.store });
    assert.equal(attention.ok, true); if (!attention.ok) return;
    const item = (attention.attention.issues ?? []).find((issue) => issue.code === 'queue_row_unreadable' && issue.opId === 'op-bad-2');
    assert.ok(item);
    // The held item has an exit a person can use: Retry captures the bookmark again.
    assert.deepEqual(replicaIssuesFromQueue(await f.store.listQueue(scope, 'set_aside')).map((issue) => [issue.code, issue.actions]),
      [['queue_row_unreadable', ['retry']]]);
    assert.equal(attention.attention.terminal, false);
    f.store.close();
  });

  test('every read around the unreadable row works', async () => {
    const f = await setup(); await f.enqueue('op-a-1'); await f.enqueue('op-b-2'); await f.enqueue('op-c-3', { sequence: 3 });
    await corrupt(f, 'op-b-2', (value) => { value.retry = 'broken'; });
    assert.deepEqual((await f.store.listQueue(scope)).map((row) => row.opId), ['op-a-1', 'op-c-3']);
    assert.deepEqual((await f.store.listQueue(scope, 'pending')).map((row) => row.opId), ['op-a-1', 'op-c-3']);
    assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0);
    assert.deepEqual((await f.store.firstLaneQueue(scope))?.opId, 'op-a-1');
    f.store.close();
  });

  test('a held row that lost its reason is rewritten as a held item too', async () => {
    const f = await setup(); f.clock.now = Date.now(); const sent: string[] = [];
    await f.enqueue('op-held-1'); await f.enqueue('op-after-2');
    await f.store.setAsideQueue(scope, [1], 'native_parent_unreadable');
    await corrupt(f, 'op-held-1', (value) => { delete value.recovery; });
    attachWorker(f, sent);
    await wake(f, 'alarm', 0);
    assert.deepEqual(sent, ['op-after-2']);
    const rows = await f.store.listQueue(scope);
    assert.deepEqual(rows.map((row) => [row.opId, row.status, row.recovery?.code]),
      [['op-held-1', 'set_aside', 'queue_row_unreadable'], ['op-after-2', 'terminal', undefined]]);
    f.store.close();
  });
});

describe('Rule C a sent unreadable row makes only the push lane wait', () => {
  test('Pull and Ack continue, nothing behind the head is sent, the engine does not stop', async () => {
    const f = await setup(); f.clock.now = Date.now(); const sent: string[] = [];
    await f.enqueue('op-sent-1'); await f.enqueue('op-behind-2');
    // A change whose request left and whose answer was lost: the exact bytes stay bound (owner 'o' is the worker's).
    const lease = await f.store.acquireLease(scope, 'o', f.clock.now, 60_000);
    const claimed = (await f.store.claimNextQueue(scope, 'o', lease.fence!, f.clock.now))!;
    const body = JSON.stringify({ sessionId: 'session-engine', batchId: claimed.batchId, atomic: false, operations: [claimed.payload] });
    await f.store.bindPushAttempt(scope, claimed.sequence, 'o', lease.fence!, { sessionId: 'session-engine',
      batchId: claimed.batchId, idempotencyKey: claimed.idempotencyKey, endpointIdentity: 'syncPush',
      mediaType: 'application/json', body, bodyDigest: claimed.digest });
    await f.store.settleClaimedPush(scope, claimed.sequence, 'o', lease.fence!,
      { outcome: 'unknown', retry: { attempt: 2, notBefore: 0 }, recovery: { code: 'push_network_failed' } });
    await corrupt(f, 'op-sent-1', (value) => { value.endpointIdentity = 'weird'; });
    attachWorker(f, sent);
    for (const [index, reason] of (['alarm', 'manual', 'alarm'] as const).entries()) {
      const state = await wake(f, reason, index);
      assert.notEqual(state?.phase, 'error', `wake ${index}`);
    }
    assert.deepEqual(sent, [], 'the lane waits: a change behind a possibly-received one never overtakes it');
    assert.equal(f.pullRequests.length, 3, 'Pull ran on every wake');
    assert.equal((await f.store.getEngineState(scope))?.lastError, undefined);
    const behind = (await f.store.listQueue(scope)).find((row) => row.opId === 'op-behind-2')!;
    assert.equal(behind.status, 'pending');
    // The wait is visible: Status names the unreadable change instead of showing an idle lane.
    assert.deepEqual((await f.store.listUnreadableQueue(scope)).map((row) => [row.kind, row.opId, row.sequence]), [['sent', 'op-sent-1', 1]]);
    const attention = await handleSyncAttentionRequest({ scope: async () => scope, store: f.store });
    assert.equal(attention.ok, true); if (!attention.ok) return;
    assert.deepEqual((attention.attention.issues ?? []).map((issue) => [issue.direction, issue.code, issue.opId]), [['push', 'queue_head_unreadable', 'op-sent-1']]);
    assert.equal(attention.attention.issueCount, 1);
    assert.equal(attention.attention.queueProjection, 'syncing');
    f.store.close();
  });
});
