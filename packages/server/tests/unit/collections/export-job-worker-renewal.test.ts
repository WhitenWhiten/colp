import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createExportJobWorkerRuntime } from '../../../src/infrastructure/collections/export-job-worker.js';

function gate<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('slow export renewal skips ticks and completion drains only the one in-flight call', async () => {
  const projectionStarted = gate<void>();
  const finishProjection = gate<void>();
  const finishRenewal = gate<boolean>();
  const now = new Date('2026-09-20T00:00:00Z');
  let calls = 0;
  let finished = false;
  const errors: object[] = [];
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const runtime = createExportJobWorkerRuntime({
    leaseDurationMs: 3_000,
    repository: {
      async expireOverdue() { return []; },
      async claimDue() {
        return [{ jobId: 'job', ownerSubjectId: 'owner', status: 'pending', objectKey: null,
          expiresAt: new Date(now.getTime() + 86_400_000), leaseOwner: 'generation-1' }];
      },
      worker: {
        async markRunning() { return true; },
        async markReady() { return true; },
        async markExpired() { return true; },
        async markFailed() { return true; },
        async renewLease() { calls++; return finishRenewal.promise; },
      },
    },
    projection: { async loadOwnedLiveTree() {
      projectionStarted.resolve();
      await finishProjection.promise;
      return [];
    } },
    store: { async put() {}, async get() { return null; }, async delete() {} },
    logger: { info() {}, warn(value) { errors.push(value); }, error(value) { errors.push(value); } },
    now: () => now,
  });
  const pending = runtime.loop.runOnce().then(result => { finished = true; return result; });
  try {
    await projectionStarted.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(calls, 1, 'ten ticks start only one blocked renewal');
    finishProjection.resolve();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(finished, false, 'completion waits for the current SQL call');
    assert.equal(vi.getTimerCount(), 0, 'completion has stopped future ticks');
    finishRenewal.resolve(true);
    assert.equal(await pending, true);
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(calls, 1, 'there is no queued renewal to drain after completion');
    assert.equal(vi.getTimerCount(), 0);
    assert.deepEqual(errors, []);
  } finally {
    finishProjection.resolve();
    finishRenewal.resolve(true);
    await pending;
    vi.useRealTimers();
  }
});
