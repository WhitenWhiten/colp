/**
 * T06 favicon lease fences + T08 retry/compensation regressions.
 *
 * Controlled-clock fakes only: a "slow" item is modelled by a fetch hook that
 * flips `state.job.leaseOwner` to the new worker (the exact effect of the
 * expiry sweep re-claiming the job). No real timers, no database.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  processFaviconBatchClaim,
  processFaviconBatchItem,
} from '../../../src/modules/collections/application/favicon-batch-execution.js';
import {
  processFaviconRefreshClaim,
  nextFaviconGcAttemptAt,
  FaviconFetchError,
  type FaviconRefreshExecutionPorts,
} from '../../../src/modules/collections/application/favicon-job-execution.js';
import { processFaviconGcClaim } from '../../../src/modules/collections/application/favicon-gc.js';
import {
  nextFaviconAttemptAt,
} from '../../../src/modules/collections/application/favicon-fetch-policy.js';
import {
  FAVICON_GC_MAX_ATTEMPTS,
} from '../../../src/modules/collections/application/favicon-job-execution.js';
import {
  FETCHED,
  NOW,
  makeBatchHarness,
  makeBinding,
  makeClaim,
  makeItem,
  makeSingleHarness,
} from './favicon-execution-fakes.js';

const NEW_WORKER = 'worker-new';

// ---------------------------------------------------------------------------
// T06 — batch item writes after a lease transfer
// ---------------------------------------------------------------------------

test('T06 batch: a slow item that outlives the lease cannot overwrite the new worker success', async () => {
  const harness = makeBatchHarness({
    batchSize: 2,
    onFetch(state) {
      // The item outlived the 60s lease; the expiry sweep re-claimed the job
      // and the new worker already completed node-1.
      state.job = { ...state.job, leaseOwner: NEW_WORKER };
      state.items.set('node-1', { ...makeItem(), status: 'succeeded' });
      state.binding = makeBinding('object-new-worker');
    },
  });
  const result = await processFaviconBatchClaim(harness.ports, makeClaim());
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'lease_lost' });
  assert.equal(harness.state.fetches, 1, 'the cycle stops at the first lost-fence item');
  assert.equal(harness.state.items.get('node-1')!.status, 'succeeded',
    'old worker must not replace the new worker item success');
  assert.equal(harness.state.items.get('node-2')!.status, 'pending',
    'the second item must not be processed after the lease was lost');
  assert.equal(harness.state.binding?.objectId, 'object-new-worker',
    'the new worker binding is never displaced by the stale claim');
  assert.ok(!harness.state.itemWrites.some((write) => write.startsWith('succeeded:')),
    'no stale success mark may be written');
  assert.equal(harness.state.updateBatches, 0);
});

test('T06 batch: after a lease transfer the old failure path cannot schedule a retry over the new worker state', async () => {
  const harness = makeBatchHarness({
    batchSize: 1,
    onFetch(state) {
      state.job = { ...state.job, leaseOwner: NEW_WORKER };
      state.items.set('node-1', { ...makeItem(), status: 'succeeded' });
    },
    fetcherThrows: new Error('transport down'),
  });
  const result = await processFaviconBatchClaim(harness.ports, makeClaim());
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'lease_lost' });
  assert.equal(harness.state.items.get('node-1')!.status, 'succeeded');
  assert.equal(harness.state.retryWrites.length, 0,
    'the unfenced pre-fix scheduleRetry would have rewritten the item as pending');
  assert.ok(!harness.state.itemWrites.some((write) => write.startsWith('retry:')),
    'no stale retry write may reach the item row');
});

test('T06 batch: after a lease transfer the old terminal-failure path cannot mark the item failed', async () => {
  const harness = makeBatchHarness({
    batchSize: 1,
    onFetch(state) {
      state.job = { ...state.job, leaseOwner: NEW_WORKER };
      state.items.set('node-1', { ...makeItem(), status: 'succeeded' });
    },
    fetcherThrows: new FaviconFetchError('unsafe_source', 'denied'),
  });
  const result = await processFaviconBatchClaim(harness.ports, makeClaim());
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'lease_lost' });
  assert.equal(harness.state.items.get('node-1')!.status, 'succeeded');
  assert.ok(!harness.state.itemWrites.some((write) => write.startsWith('failed:')),
    'no stale terminal mark may overwrite the new worker row');
});

test('T06 batch: a stale worker cannot delete the force-restore snapshot after losing the lease', async () => {
  const harness = makeBatchHarness({
    claim: { operation: 'restore_sources' },
    items: [makeItem({ status: 'pending' })],
    restore: {
      nodeId: 'node-1', collectionId: 'collection-1', accountId: 'account-1',
      originalSourceMode: 'online', originalObjectId: 'object-original',
      originalContentType: 'image/png', originalByteSize: 5,
      originalDigestSha256: null, sourceRevision: 1n, createdAt: NOW, updatedAt: NOW,
    },
    onItemRead(state) {
      // Between the initial verify's job read and its item read, the new
      // worker re-claimed the job and finished (superseded) the item.
      state.job = { ...state.job, leaseOwner: NEW_WORKER };
      state.items.set('node-1', { ...makeItem(), status: 'succeeded' });
    },
  });
  const result = await processFaviconBatchItem(
    harness.ports,
    makeClaim({ operation: 'restore_sources' }),
    makeItem(),
  );
  assert.equal(result, 'job_gone');
  assert.equal(harness.state.restoreDeletes, 0,
    'the restore snapshot the new owner still needs must survive the stale skip');
  assert.equal(harness.state.restore?.originalObjectId, 'object-original');
  assert.equal(harness.state.items.get('node-1')!.status, 'succeeded');
  assert.ok(!harness.state.itemWrites.includes('skipped:node-1'));
});

test('T06 batch: a stale worker cannot persist an object id after losing the lease', async () => {
  const harness = makeBatchHarness({
    batchSize: 1,
    onItemRead(state) {
      state.job = { ...state.job, leaseOwner: NEW_WORKER };
    },
  });
  const result = await processFaviconBatchItem(harness.ports, makeClaim(), makeItem());
  assert.equal(result, 'job_gone');
  assert.equal(harness.state.fetches, 0, 'no fetch starts once the allocation fence is lost');
  assert.ok(!harness.state.itemWrites.some((write) => write.startsWith('object-id:')),
    'the stale claim must not write a fresh object id');
});

test('T06 batch: renewal happens before every item and stops the cycle on loss', async () => {
  const harness = makeBatchHarness({
    batchSize: 2,
    onItemSucceeded(state, nodeId) {
      if (nodeId === 'node-1') state.job = { ...state.job, leaseOwner: NEW_WORKER };
    },
  });
  const result = await processFaviconBatchClaim(harness.ports, makeClaim());
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'lease_lost' });
  assert.equal(harness.state.renews.length, 2,
    'one renewal per attempted item, including the item that detects the takeover');
  assert.equal(harness.state.fetches, 1, 'the second item is never fetched');
  assert.equal(harness.state.items.get('node-2')!.status, 'pending');
  assert.equal(harness.state.updateBatches, 0);
});

test('T06 batch: per-item renewal keeps two normal items in one cycle', async () => {
  const harness = makeBatchHarness({ batchSize: 2 });
  const result = await processFaviconBatchClaim(harness.ports, makeClaim());
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'succeeded' });
  assert.equal(harness.state.renews.length, 2);
  assert.equal(harness.state.fetches, 2);
  assert.equal(harness.state.items.get('node-1')!.status, 'succeeded');
  assert.equal(harness.state.items.get('node-2')!.status, 'succeeded');
  assert.equal(harness.state.updateBatches, 1);
});

// ---------------------------------------------------------------------------
// T06 — single refresh job fences
// ---------------------------------------------------------------------------

test('T06 single: a lease transfer during a slow fetch blocks the stale binding CAS', async () => {
  const harness = makeSingleHarness({
    onFetch(state) {
      state.job = { ...state.job, leaseOwner: NEW_WORKER };
      state.binding = makeBinding('object-new-worker');
    },
  });
  const result = await processFaviconRefreshClaim(harness.ports, makeClaim({ operation: 'refresh_one' }));
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'lease_lost' });
  assert.deepEqual(harness.state.locks, ['job-1', 'job-1'],
    'allocation and CAS both fence under lockByJobId');
  assert.equal(harness.state.upserts, 0, 'the stale claim never binds its object');
  assert.equal(harness.state.successMarks, 0);
  assert.equal(harness.state.binding?.objectId, 'object-new-worker');
});

test('T06 single: a lease transfer before allocation cannot persist an object id', async () => {
  const harness = makeSingleHarness({
    onNodeRead(state) {
      state.job = { ...state.job, leaseOwner: NEW_WORKER };
    },
  });
  const result = await processFaviconRefreshClaim(harness.ports, makeClaim({ operation: 'refresh_one' }));
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'lease_lost' });
  assert.equal(harness.state.objectIdWrites, 0);
  assert.equal(harness.state.fetches, 0);
});

test('T06 single: a lease transfer before the failure write leaves the new owner state intact', async () => {
  const harness = makeSingleHarness({
    onFetch(state) {
      state.job = { ...state.job, leaseOwner: NEW_WORKER, status: 'succeeded' };
    },
    fetcherThrows: new Error('transport down'),
  });
  const result = await processFaviconRefreshClaim(harness.ports, makeClaim({ operation: 'refresh_one' }));
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'lease_lost' });
  assert.equal(harness.state.retryWrites.length, 0);
  assert.equal(harness.state.failedWrites.length, 0);
  assert.equal(harness.state.job.status, 'succeeded');
});

test('T06 single: the CAS path locks the job row before the owner check', async () => {
  const harness = makeSingleHarness();
  const result = await processFaviconRefreshClaim(harness.ports, makeClaim({ operation: 'refresh_one' }));
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'succeeded' });
  assert.deepEqual(harness.state.locks, ['job-1', 'job-1']);
  assert.equal(harness.state.upserts, 1);
  assert.equal(harness.state.successMarks, 1);
});

// ---------------------------------------------------------------------------
// T08 — retry attempt counting / first backoff step
// ---------------------------------------------------------------------------

test('T08 backoff: the first GC retry uses the first backoff step (no skipped step)', () => {
  const first = nextFaviconGcAttemptAt(1, [1, 2, 4], NOW);
  assert.equal(first.getTime(), NOW.getTime() + 1_000);
  assert.deepEqual(
    nextFaviconGcAttemptAt(2, [1, 2, 4], NOW),
    new Date(NOW.getTime() + 2_000),
  );
  assert.deepEqual(
    nextFaviconGcAttemptAt(FAVICON_GC_MAX_ATTEMPTS, [1, 2, 4], NOW),
    new Date(NOW.getTime() + 4_000),
    'the last schedule entry is the conservative floor',
  );
});

test('T08 backoff: single refresh and batch items share the 1-based attempt convention', async () => {
  assert.deepEqual(
    nextFaviconAttemptAt(1, 5, [1, 2, 4, 8, 16], NOW),
    new Date(NOW.getTime() + 1_000),
  );
  assert.equal(nextFaviconAttemptAt(5, 5, [1, 2, 4, 8, 16], NOW), null);
  assert.deepEqual(
    nextFaviconAttemptAt(4, 5, [1, 2, 4, 8, 16], NOW),
    new Date(NOW.getTime() + 8_000),
  );

  const single = makeSingleHarness({ fetcherThrows: new Error('transport down') });
  const result = await processFaviconRefreshClaim(single.ports, makeClaim({ operation: 'refresh_one' }));
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'retry_scheduled' });
  assert.deepEqual(single.state.retryWrites, [{
    attempts: 1, nextAttemptAt: new Date(NOW.getTime() + 1_000),
  }]);

  const batch = makeBatchHarness({
    batchSize: 1, items: [makeItem()], fetcherThrows: new Error('transport down'),
  });
  await processFaviconBatchClaim(batch.ports, makeClaim());
  assert.equal(batch.state.items.get('node-1')!.attempts, 1);
  assert.deepEqual(batch.state.items.get('node-1')!.nextAttemptAt, new Date(NOW.getTime() + 1_000));
  assert.equal(batch.state.retryWrites[0]?.attempts, 1);
});

test('T08 backoff: the max-attempt boundary fails instead of scheduling another retry', async () => {
  const batch = makeBatchHarness({
    batchSize: 1,
    items: [makeItem({ attempts: 4 })],
    fetcherThrows: new Error('transport down'),
  });
  await processFaviconBatchClaim(batch.ports, makeClaim());
  assert.equal(batch.state.items.get('node-1')!.status, 'failed');
  assert.equal(batch.state.items.get('node-1')!.attempts, 5);
  assert.equal(batch.state.retryWrites.length, 0);
});

test('T08 backoff: GC delete failure schedules the first step with attempts=1', async () => {
  const writes: Array<{ attempts: number; nextAttemptAt: Date; lastError: string }> = [];
  const result = await processFaviconGcClaim({
    store: { async delete() { throw new Error('r2 down'); } },
    repository: {
      async isObjectReferenced() { return false; },
      async markDeleted() { return true; },
      async scheduleRetry(input) {
        writes.push({ attempts: input.attempts, nextAttemptAt: input.nextAttemptAt, lastError: input.lastError });
        return true;
      },
    },
    backoffSeconds: [1, 2, 4],
    now: () => NOW,
  }, {
    objectId: 'object-1', leaseOwner: 'gc-1', nodeId: 'node-1',
    collectionId: 'collection-1', deletableAt: NOW, attempts: 0,
  });
  assert.equal(result.outcome, 'retry_scheduled');
  assert.deepEqual(writes, [{
    attempts: 1, nextAttemptAt: new Date(NOW.getTime() + 1_000), lastError: 'storage_delete_failed',
  }]);
});

test('T08 backoff: a still-referenced GC record also takes the first step', async () => {
  const writes: Array<{ attempts: number; nextAttemptAt: Date }> = [];
  const result = await processFaviconGcClaim({
    store: { async delete() { throw new Error('must not delete'); } },
    repository: {
      async isObjectReferenced() { return true; },
      async markDeleted() { return true; },
      async scheduleRetry(input) {
        writes.push({ attempts: input.attempts, nextAttemptAt: input.nextAttemptAt });
        return true;
      },
    },
    backoffSeconds: [1, 2, 4],
    now: () => NOW,
  }, {
    objectId: 'object-1', leaseOwner: 'gc-1', nodeId: 'node-1',
    collectionId: 'collection-1', deletableAt: NOW, attempts: 0,
  });
  assert.equal(result.outcome, 'reference_held');
  assert.deepEqual(writes, [{ attempts: 1, nextAttemptAt: new Date(NOW.getTime() + 1_000) }]);
});

// ---------------------------------------------------------------------------
// T08 — CAS-failure compensation must not retire a referenced object
// ---------------------------------------------------------------------------

test('T08 compensation: a CAS failure never retires the object that is already the live binding', async () => {
  const harness = makeSingleHarness({
    claim: { objectId: 'object-shared' },
    binding: makeBinding('object-shared'),
    onFetch(state) {
      // The node changed while the fetch was in flight: the CAS is terminal,
      // but the object is (and stays) the live binding.
      state.nodeRevision = 'rev-2';
    },
  });
  const result = await processFaviconRefreshClaim(harness.ports, makeClaim({
    operation: 'refresh_one', objectId: 'object-shared',
  }));
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'failed' });
  assert.equal(harness.state.retired.length, 0,
    'a referenced object must never enter the pending-deletion ledger');
  assert.equal(harness.state.binding?.objectId, 'object-shared');
});

test('T08 compensation: an unbound object from a failed CAS is ledgered as immediately deletable', async () => {
  const harness = makeSingleHarness({
    claim: { objectId: 'object-orphan' },
    binding: makeBinding('object-previous'),
    onFetch(state) {
      state.nodeRevision = 'rev-2';
    },
  });
  const result = await processFaviconRefreshClaim(harness.ports, makeClaim({
    operation: 'refresh_one', objectId: 'object-orphan',
  }));
  assert.deepEqual(result, { jobId: 'job-1', outcome: 'failed' });
  assert.deepEqual(harness.state.retired, [{
    objectId: 'object-orphan', deletableAt: NOW,
  }]);
  assert.equal(harness.state.binding?.objectId, 'object-previous');
});

test('T08 compensation: a fetched object is never deleted directly on CAS failure', async () => {
  const harness = makeSingleHarness({
    onFetch(state) {
      state.nodeRevision = 'rev-2';
    },
  });
  await processFaviconRefreshClaim(harness.ports, makeClaim({ operation: 'refresh_one' }));
  // The harness store has no delete method at all: if compensation tried a
  // direct delete this port would fail. It only ever records retirement.
  assert.equal(harness.state.retired.length, 1);
  assert.equal(harness.state.retired[0]!.deletableAt.getTime(), NOW.getTime());
});

// Keep the fetched fixture type-checked as the execution contract.
const _fetched: FaviconRefreshExecutionPorts['fetcher'] = async () => FETCHED;
void _fetched;
