import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import type { JsonObject } from '../src/sync-state-store.js';
import { fixture as batchFixture } from './outbound-push-batch-harness.js';
import { installOutboundPushIndexedDb, json, operation, scope, setup } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

/**
 * A-F7: a local upload policy (`subscription_upload_excluded`, the bootstrap boundary) runs in the
 * dispatch hook, after the attempt is bound and before any byte leaves. Because the row then
 * carried an attempt, `setAsideClaimedPush` refused it for ever: the refusal repeated at the head
 * of the lane, every later upload waited, and the only report was a "stalled upload" after eight
 * tries. An attempt this very drain bound and never sent owns no server sequence and now counts
 * like any other never-sent local failure; one from an earlier drain is never dropped.
 */
async function enqueue(store: Awaited<ReturnType<typeof setup>>['store'], opId: string, payload: JsonObject) {
  await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`,
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: { ...payload, opId } },
  { validateOperation: () => true, digestOperation: (value) => `sha256:${String(value.opId)}-${String(value.sequence)}` });
}
const other: JsonObject = { ...operation, payload: { parentId: 'root-other',
  node: { kind: 'bookmark', title: 'Other', url: 'https://example.test/other' } } };

function applied(init: RequestInit | undefined) {
  const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
  const op = body.operations[0]!;
  return json(200, { batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence, status: 'applied',
    targetId: `node-${op.opId}`, revision: 'revision-1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
}

describe('A-F7 a refusal before the request leaves is a never-sent failure', () => {
  test('a policy that refuses the head after its attempt is bound sets it aside and later changes upload', async () => {
    const f = await setup(); await enqueue(f.store, 'op-other', other);
    const sent: string[] = [];
    const worker = createOutboundPushWorker({ ...f.options,
      dispatch: async (queue, send) => {
        if (queue.opId === 'op-push-1') throw new Error('subscription_upload_excluded');
        return send();
      },
      fetch: async (_url, init) => { const response = applied(init);
        sent.push((JSON.parse(String(init?.body)) as { operations: Array<{ opId: string }> }).operations[0]!.opId);
        return response; } });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      assert.equal((await worker.drain()).outcome, 'unknown');
      const head = (await f.store.listQueue(scope)).find((row) => row.opId === 'op-push-1')!;
      assert.equal(head.status, 'unknown'); assert.equal(head.recovery?.code, 'subscription_upload_excluded');
      assert.equal(head.retry.attempt, attempt);
      assert.equal(head.attempt, undefined, 'the bytes that never left are not kept as a sent attempt');
      assert.deepEqual(sent, [], 'the lane waits while the head is still being retried');
      f.clock.now = head.retry.notBefore + 1;
    }
    assert.equal((await worker.drain()).outcome, 'terminal');
    const rows = await f.store.listQueue(scope);
    assert.deepEqual(rows.map((row) => [row.opId, row.status, row.recovery?.code]), [
      ['op-push-1', 'set_aside', 'subscription_upload_excluded'], ['op-other', 'terminal', undefined]]);
    assert.deepEqual(sent, ['op-other']);
    assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
    f.store.close();
  });

  test('an attempt from an earlier drain may have been received and is never dropped', async () => {
    const f = await setup(); let refuse = false; let calls = 0;
    const worker = createOutboundPushWorker({ ...f.options,
      dispatch: async (_queue, send) => { if (refuse) throw new Error('subscription_upload_excluded'); return send(); },
      fetch: async () => { calls += 1; throw new DOMException('timed out', 'AbortError'); } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const sent = (await f.store.listQueue(scope))[0]!;
    assert.equal(calls, 1);
    assert.ok(sent.attempt, 'the request left, so the exact bytes stay bound');
    const bound = JSON.stringify(sent.attempt);
    refuse = true;
    for (let drain = 1; drain <= 8; drain += 1) {
      f.clock.now = (await f.store.listQueue(scope))[0]!.retry.notBefore + 1;
      assert.equal((await worker.drain()).outcome, 'unknown');
    }
    const head = (await f.store.listQueue(scope))[0]!;
    assert.equal(head.status, 'unknown', 'a possibly-received change is not set aside');
    assert.equal(JSON.stringify(head.attempt), bound);
    assert.equal(calls, 1, 'and nothing was sent again');
    f.store.close();
  });

  test('a pause (a transient code) keeps the bound attempt instead of churning it', async () => {
    const f = await setup();
    const worker = createOutboundPushWorker({ ...f.options,
      dispatch: async () => { throw new Error('permission_required'); },
      fetch: async () => { throw new Error('unexpected_send'); } });
    for (let drain = 1; drain <= 7; drain += 1) {
      assert.equal((await worker.drain()).outcome, 'unknown');
      const head = (await f.store.listQueue(scope))[0]!;
      assert.equal(head.status, 'unknown'); assert.equal(head.recovery?.code, 'permission_required');
      assert.ok(head.attempt, 'it stays a plain retry');
      f.clock.now = head.retry.notBefore + 1;
    }
    f.store.close();
  });

  test('a first-run batch refused before it leaves drops every freshly bound attempt and the rows are held one by one', async () => {
    const f = await batchFixture(3, 3); let sends = 0;
    const refuse = async () => { throw new Error('subscription_upload_excluded'); };
    const worker = createOutboundPushWorker({ ...f.options, dispatch: refuse, dispatchBatch: refuse,
      fetch: async () => { sends += 1; throw new Error('unexpected_send'); } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const rows = await f.store.listQueue(scope);
    assert.deepEqual(rows.map((row) => [row.status, row.attempt === undefined, row.recovery?.code, row.retry.attempt]),
      [['unknown', true, 'subscription_upload_excluded', 1], ['unknown', true, 'subscription_upload_excluded', 1],
        ['unknown', true, 'subscription_upload_excluded', 1]]);
    for (let drain = 0; drain < 20; drain += 1) {
      const live = (await f.store.listQueue(scope)).filter((row) => row.status !== 'set_aside');
      if (live.length === 0) break;
      f.clock.now = Math.max(...live.map((row) => row.retry.notBefore)) + 1;
      await worker.drain();
    }
    const held = await f.store.listQueue(scope);
    assert.deepEqual(held.map((row) => [row.status, row.recovery?.code]),
      Array(3).fill(['set_aside', 'subscription_upload_excluded']));
    assert.equal(sends, 0, 'nothing ever left the browser');
    f.store.close();
  });
});
