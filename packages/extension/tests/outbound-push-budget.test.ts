import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { hasFreshPushQueueHead } from '../src/push-work-budget.js';
import { fixture, success } from './outbound-push-batch-harness.js';
import { installOutboundPushIndexedDb, scope } from './outbound-push-worker-harness.js';
installOutboundPushIndexedDb();

// Seeding and settling 520 IndexedDB rows can exceed 20s with V8 coverage on CI.
// The injected clock tests the drain budget; wall time only limits the test runner.
test('a fast backlog uses the drain budget past 100 operations and still has a hard ceiling', async () => {
  const f = await fixture(520); const sizes: number[] = [];
  const worker = createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
    const body = String(init?.body); sizes.push(JSON.parse(body).operations.length); return success(body);
  } });
  try {
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(sizes.reduce((total, size) => total + size, 0), 500);
    assert.ok(sizes.every(size => size <= 50));
    assert.equal((await f.store.listQueue(scope, 'pending')).length, 20);
    assert.equal(await hasFreshPushQueueHead(f.store, scope, f.clock.now), true);
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal((await f.store.listQueue(scope, 'terminal', 0, 1000)).length, 520);
    assert.equal(await hasFreshPushQueueHead(f.store, scope, f.clock.now), false);
  } finally { f.store.close(); }
}, 60_000);

test('a fresh suffix does not schedule immediate wakes past an exact-retry head', async () => {
  const f = await fixture(2, 1);
  try {
    assert.equal(await hasFreshPushQueueHead(f.store, scope, f.clock.now), true);
    const worker = createOutboundPushWorker({ ...f.options, fetch: async () => { throw new TypeError('response lost'); } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    assert.equal((await f.store.listQueue(scope, 'pending')).length, 1);
    assert.equal(await hasFreshPushQueueHead(f.store, scope, f.clock.now), false);
    f.clock.now += 60_000;
    assert.equal(await hasFreshPushQueueHead(f.store, scope, f.clock.now), false);
  } finally { f.store.close(); }
});

test('time-bounds a drain so a large fresh upload yields for Pull and resumes in order', async () => {
  const f = await fixture(40); const sizes: number[] = []; const sequences: number[] = [];
  const worker = createOutboundPushWorker({ ...f.options, initialBatchOperations: 5,
    fetch: async (_url, init) => {
      const body = String(init?.body); const operations = JSON.parse(body).operations;
      sizes.push(operations.length); sequences.push(...operations.map((op: { sequence: number }) => op.sequence));
      f.clock.now += operations.length * 1_000; return success(body);
    } });
  try {
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.deepEqual(sizes, [5, 5, 5, 5]);
    assert.equal((await f.store.listQueue(scope, 'pending')).length, 20);
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.deepEqual(sequences, Array.from({ length: 40 }, (_, index) => index + 1));
  } finally { f.store.close(); }
});

test('shrinks later batches when per-operation latency increases', async () => {
  const f = await fixture(25); const sizes: number[] = [];
  const worker = createOutboundPushWorker({ ...f.options, initialBatchOperations: 5,
    drainBudgetMilliseconds: 100_000, leaseDurationMilliseconds: 120_000,
    fetch: async (_url, init) => {
      const body = String(init?.body); const count = JSON.parse(body).operations.length;
      sizes.push(count); f.clock.now += count * (sizes.length === 1 ? 1_000 : 2_000); return success(body);
    } });
  try {
    await worker.drain();
    assert.deepEqual(sizes.slice(0, 4), [5, 5, 2, 2]);
    assert.equal((await f.store.listQueue(scope, 'terminal')).length, 25);
  } finally { f.store.close(); }
});
