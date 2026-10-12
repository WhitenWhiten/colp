/**
 * FO-08 favicon job worker loop: the claim sweep must never exceed the
 * configured concurrency. `runOnce` first reclaims overdue RUNNING jobs, then
 * fills the remaining slots with due PENDING jobs — the pending batch is
 * capped at `concurrency - overdueCount`, so total in-flight claims ≤
 * concurrency (before, two independent `limit: concurrency` fetches could
 * process up to 2x the bound at once).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  FaviconJobWorkerLoop,
  type FaviconJobClaim,
  type FaviconJobWorkerLoopOptions,
  type FaviconJobWorkerRepository,
} from '../../../src/infrastructure/collections/index.js';

function claim(jobId: string): FaviconJobClaim {
  return Object.freeze({
    jobId,
    leaseOwner: 'loop-unit-worker',
    accountId: 'account-loop-unit',
    ownerSubjectId: 'subject-loop-unit',
    operation: 'fill_missing',
    status: 'running',
    attempts: 0,
    collectionId: 'coll-loop-unit',
    nodeId: 'node-loop-unit',
    sourceUrl: 'https://provider.example.test/host',
    sourceRevision: '1',
    policyRevision: '1',
    nodeResourceRevision: 'res-loop-unit',
    objectId: null,
  } satisfies FaviconJobClaim);
}

interface FakeJobRepository {
  readonly repository: FaviconJobWorkerRepository;
  readonly expireCalls: Array<{ limit: number }>;
  readonly claimCalls: Array<{ limit: number }>;
}

function fakeJobRepository(overrides: {
  readonly overdue?: readonly FaviconJobClaim[];
  readonly pending?: readonly FaviconJobClaim[];
} = {}): FakeJobRepository {
  const expireCalls: Array<{ limit: number }> = [];
  const claimCalls: Array<{ limit: number }> = [];
  const worker: FaviconJobWorkerRepository['worker'] = {
    async markRunning() { return false; },
    async scheduleRetry() { return false; },
    async markFailed() { return false; },
    async markSucceeded() { return false; },
    async updateBatch() { return false; },
    async renewLease() { return false; },
  };
  return {
    expireCalls,
    claimCalls,
    repository: {
      async expireOverdue(input) { expireCalls.push({ limit: input.limit }); return [...(overrides.overdue ?? [])]; },
      async claimDue(input) { claimCalls.push({ limit: input.limit }); return [...(overrides.pending ?? [])]; },
      worker,
    },
  };
}

function makeLoop(repository: FaviconJobWorkerRepository, concurrency = 2): FaviconJobWorkerLoop {
  // The job loop never touches the GC repository or the verify runner when
  // every claim fails markRunning (the processClaim fast path); the casts
  // stand in for those unused seams.
  const options = {
    repository,
    gc: { claimDue: async () => [], repository: {} } as unknown as FaviconJobWorkerLoopOptions['gc'],
    verify: { run: async () => { throw new Error('unused in this unit test'); } } as unknown as FaviconJobWorkerLoopOptions['verify'],
    fetcher: async () => { throw new Error('unused in this unit test'); },
    store: {
      async get() { return null; },
      async put() {},
      async delete() {},
    },
    logger: { info() {}, warn() {}, error() {} },
    concurrency,
    pollIntervalMs: 1_000,
    leaseDurationMs: 60_000,
    gcPollIntervalMs: 60_000,
    gcLeaseDurationMs: 120_000,
    batchSize: 100,
    options: {
      maxAttempts: 5,
      backoffSeconds: [1, 2] as readonly number[],
      retentionSeconds: 31_536_000,
      maxBytes: 65_536,
      maxDecompressedBytes: 65_536 * 64,
      fetchTimeoutMs: 10_000,
      maxRedirects: 3,
    },
  } satisfies Omit<FaviconJobWorkerLoopOptions, 'workerId'> & { workerId?: string };
  return new FaviconJobWorkerLoop(options);
}

describe('FaviconJobWorkerLoop.runOnce (FO-08 concurrency bound)', () => {
  test('an overdue sweep filling every slot skips the pending batch entirely', async () => {
    const fake = fakeJobRepository({ overdue: [claim('overdue-1'), claim('overdue-2')] });
    const loop = makeLoop(fake.repository, 2);
    assert.equal(await loop.runOnce(), true);
    assert.deepEqual(fake.expireCalls, [{ limit: 2 }]);
    assert.deepEqual(fake.claimCalls, [], 'no pending claim may exceed the configured concurrency');
  });

  test('the pending batch is capped at the remaining slots after the overdue sweep', async () => {
    const fake = fakeJobRepository({ overdue: [claim('overdue-1')], pending: [claim('pending-1')] });
    const loop = makeLoop(fake.repository, 2);
    assert.equal(await loop.runOnce(), true);
    assert.deepEqual(fake.expireCalls, [{ limit: 2 }]);
    assert.deepEqual(fake.claimCalls, [{ limit: 1 }],
      'total in-flight claims (overdue + pending) must never exceed concurrency');
  });

  test('no overdue claims: the whole concurrency goes to the pending batch', async () => {
    const fake = fakeJobRepository({ pending: [claim('pending-1'), claim('pending-2')] });
    const loop = makeLoop(fake.repository, 2);
    assert.equal(await loop.runOnce(), true);
    assert.deepEqual(fake.expireCalls, [{ limit: 2 }]);
    assert.deepEqual(fake.claimCalls, [{ limit: 2 }]);
  });

  test('nothing due: runOnce reports no work', async () => {
    const fake = fakeJobRepository();
    const loop = makeLoop(fake.repository, 2);
    assert.equal(await loop.runOnce(), false);
    assert.deepEqual(fake.expireCalls, [{ limit: 2 }]);
    assert.deepEqual(fake.claimCalls, [{ limit: 2 }]);
  });
});