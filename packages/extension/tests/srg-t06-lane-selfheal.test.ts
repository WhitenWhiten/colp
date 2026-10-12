import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import {
  installOutboundPushIndexedDb, json, operation, problem, scope, setup,
} from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

/**
 * F009: the server lane is authoritative. When a 409 `sequence_gap` proves the
 * lane is ahead of the local head (`expectedSequence > head.sequence`) the
 * client must raise its next allocation onto that lane instead of standing
 * still forever. Every case below enters through the production drain, and the
 * observable proof is the sequence the server actually receives plus the
 * durable queue rows.
 */
describe('F009 server lane ahead self-heal', () => {
  test('expected > head.sequence: survives are renumbered onto the server lane before the next push', async () => {
    const fixture = await setup();
    await enqueueExtra(fixture, 'op-push-2', 2);
    const gapWorker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(409, 'sequence_gap', { expectedSequence: 5 }) });
    assert.equal((await gapWorker.drain()).outcome, 'gap');
    assert.deepEqual((await fixture.store.listQueue(scope)).map((row) => [row.sequence, row.status]),
      [[1, 'gap'], [2, 'pending']]);

    const sent = await pushAll(fixture);
    // The lane evidence wins: both surviving rows moved up to 5/6 and the
    // server received exactly those sequences.
    assert.deepEqual(sent, [['op-push-1', 5], ['op-push-2', 6]]);
    const rows = await fixture.store.listQueue(scope);
    assert.deepEqual(rows.map((row) => [row.sequence, row.opId, row.status]),
      [[5, 'op-push-1', 'terminal'], [6, 'op-push-2', 'terminal']]);
    assert.equal(rows[0]!.payload.sequence, 5);
    assert.equal(rows[1]!.payload.sequence, 6);
    // The allocation floor advanced past the compacted block.
    const next = await enqueueExtra(fixture, 'op-push-3', 3);
    assert.equal(next.sequence, 7);
  });

  test('expected > head.sequence: terminal history below the lane stays untouched', async () => {
    const fixture = await setup();
    // op-1 is already applied on the lane; op-2 is the next pending row.
    assert.equal((await pushAll(fixture)).length, 1);
    assert.deepEqual((await fixture.store.listQueue(scope)).map((row) => [row.sequence, row.status]),
      [[1, 'terminal']]);
    await enqueueExtra(fixture, 'op-push-2', 2);
    const gapWorker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(409, 'sequence_gap', { expectedSequence: 3 }) });
    assert.equal((await gapWorker.drain()).outcome, 'gap');

    const sent = await pushAll(fixture);
    assert.deepEqual(sent, [['op-push-2', 3]]);
    assert.deepEqual((await fixture.store.listQueue(scope)).map((row) => [row.sequence, row.opId, row.status]),
      [[1, 'op-push-1', 'terminal'], [3, 'op-push-2', 'terminal']]);
  });

  test('expected === head.sequence: the barrier is cleared and that same sequence converges', async () => {
    const fixture = await setup();
    const gapWorker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(409, 'sequence_gap', { expectedSequence: 1 }) });
    assert.equal((await gapWorker.drain()).outcome, 'gap');
    assert.deepEqual((await fixture.store.listQueue(scope)).map((row) => [row.sequence, row.status]),
      [[1, 'gap']]);

    const sent = await pushAll(fixture);
    assert.deepEqual(sent, [['op-push-1', 1]]);
    assert.deepEqual((await fixture.store.listQueue(scope)).map((row) => [row.sequence, row.status]),
      [[1, 'terminal']]);
    // Idempotent: a further idle drain neither renumbers rows nor raises the
    // floor, so the next allocation still lands right after the healed row.
    assert.equal((await pushAll(fixture)).length, 0);
    const next = await enqueueExtra(fixture, 'op-push-2', 2);
    assert.equal(next.sequence, 2);
  });
});

async function enqueueExtra(fixture: Awaited<ReturnType<typeof setup>>, opId: string, sequence: number) {
  return fixture.store.allocateSequenceAndEnqueue(scope, { opId, batchId: `batch-${opId}`,
    idempotencyKey: `idempotency-${opId}`, digest: `sha256:operation-${opId}`, endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { ...operation, opId, sequence } }, { allowUnstamped: true });
}

/** Drains with a lane-faithful server: every operation is applied at the sequence it was sent with. */
async function pushAll(fixture: Awaited<ReturnType<typeof setup>>): Promise<Array<[string, number]>> {
  const sent: Array<[string, number]> = [];
  fixture.clock.now += 60_000;
  const worker = createOutboundPushWorker({ ...fixture.options, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
    const pushed = body.operations[0]!;
    sent.push([pushed.opId, pushed.sequence]);
    return json(200, { batchId: body.batchId, results: [{ opId: pushed.opId, sequence: pushed.sequence,
      status: 'applied', targetId: `server-${pushed.opId}`, revision: `revision-${pushed.sequence}`, cursor: 'cursor-1',
      warnings: [] }], serverCursor: 'cursor-1' });
  } });
  let outcome = await worker.drain();
  while (outcome.outcome === 'terminal') outcome = await worker.drain();
  return sent;
}
