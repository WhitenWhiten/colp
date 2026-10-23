import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ReplicaExpiryJob } from '../../../src/infrastructure/sync/replica-expiry-job.js';

test('expiry batches do not overlap, stop drains the running batch, and errors remain retryable', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const errors: unknown[] = [], counts: number[] = [];
  const job = new ReplicaExpiryJob({ async expireDue({ limit }) {
    assert.equal(limit, 5);
    calls += 1;
    if (calls === 1) await gate;
    if (calls === 2) throw new Error('database temporarily unavailable');
    return { expiredReplicaIds: ['expired'] };
  } }, { intervalMs: 60_000, batchSize: 5, onError: error => errors.push(error), onResult: count => counts.push(count) });
  job.start();
  const sameBatch = job.tick();
  assert.equal(calls, 1);
  let stopped = false;
  const stop = job.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([stop, sameBatch]);
  await job.tick();
  await job.tick();
  assert.equal(calls, 3);
  assert.equal(errors.length, 1);
  assert.deepEqual(counts, [1, 1]);
});
