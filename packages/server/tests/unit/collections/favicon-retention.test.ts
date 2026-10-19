/**
 * T07: favicon GC retention is per-command/per-worker explicit configuration.
 * No process-global window, no implicit 365-day fallback.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  captureBookmarkFavicon,
  clearCapturedBookmarkFavicon,
  type FaviconHelperCapturePorts,
} from '../../../src/modules/collections/application/favicon-helper-capture.js';
import {
  setBookmarkFaviconSource,
  type SetBookmarkFaviconSourcePorts,
} from '../../../src/modules/collections/application/favicon-icon-source.js';
import {
  FaviconRetentionConfigError,
  processFaviconRefreshClaim,
} from '../../../src/modules/collections/application/favicon-job-execution.js';
import {
  FaviconJobWorkerLoop,
  type FaviconJobWorkerLoopOptions,
} from '../../../src/infrastructure/collections/favicon-worker.js';
import {
  FETCHED,
  NOW,
  makeBinding,
  makeClaim,
  makeSingleHarness,
} from './favicon-execution-fakes.js';

const captureInput = {
  actor: { principalId: 'account-1', subjectId: 'subject-1' },
  commandId: '11111111-1111-4111-8111-111111111111',
  collectionId: 'collection-1',
  nodeId: 'node-1',
  body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  contentType: 'image/png',
  productOrigin: 'https://app.example.test',
  expectedSourceEtag: '"favicon-source:rev-1:1"',
  expectedPolicyRevision: 2n,
};

test('T07: helper capture fails before touching any port when retention is absent', async () => {
  await assert.rejects(
    () => captureBookmarkFavicon({} as FaviconHelperCapturePorts, captureInput),
    (error: unknown) => error instanceof FaviconRetentionConfigError,
  );
  await assert.rejects(
    () => clearCapturedBookmarkFavicon({} as FaviconHelperCapturePorts, captureInput),
    (error: unknown) => error instanceof FaviconRetentionConfigError,
  );
});

test('T07: source-mode switch fails before touching any port when retention is absent', async () => {
  await assert.rejects(
    () => setBookmarkFaviconSource({} as SetBookmarkFaviconSourcePorts, {
      ...captureInput,
      expectedEtag: '"favicon-source:rev-1:1"',
      sourceMode: 'none',
    }),
    (error: unknown) => error instanceof FaviconRetentionConfigError,
  );
});

test('T07: two worker executions keep their own configured retention windows', async () => {
  const short = makeSingleHarness({
    binding: makeBinding('object-old'), retentionSeconds: 42,
  });
  const long = makeSingleHarness({
    binding: makeBinding('object-old'), retentionSeconds: 420,
  });

  const first = await processFaviconRefreshClaim(short.ports, makeClaim({ operation: 'refresh_one' }));
  assert.deepEqual(first, { jobId: 'job-1', outcome: 'succeeded' });
  assert.deepEqual(short.state.retired, [{
    objectId: 'object-old', deletableAt: new Date(NOW.getTime() + 42_000),
  }]);

  const second = await processFaviconRefreshClaim(long.ports, makeClaim({ operation: 'refresh_one' }));
  assert.deepEqual(second, { jobId: 'job-1', outcome: 'succeeded' });
  assert.deepEqual(long.state.retired, [{
    objectId: 'object-old', deletableAt: new Date(NOW.getTime() + 420_000),
  }], 'the long-window worker is not affected by the short one (and vice versa)');
  assert.equal(short.state.retired[0]!.deletableAt.getTime(), NOW.getTime() + 42_000);
});

function makeWorkerOptions(retentionSeconds: number | undefined): FaviconJobWorkerLoopOptions {
  return {
    repository: {
      async claimDue() { return []; },
      async expireOverdue() { return []; },
      worker: {
        async markRunning() { return false; },
        async scheduleRetry() { return false; },
        async markFailed() { return false; },
        async markSucceeded() { return false; },
        async updateBatch() { return false; },
        async renewLease() { return false; },
      },
    },
    gc: {
      async claimDue() { return []; },
      repository: {
        async isObjectReferenced() { return false; },
        async markDeleted() { return false; },
        async scheduleRetry() { return false; },
      },
    },
    verify: { async run() { throw new Error('unused'); } },
    fetcher: async () => FETCHED,
    store: {
      async get() { return null; },
      async put() { return undefined; },
      async delete() { return undefined; },
    },
    logger: { info() {}, warn() {}, error() {} },
    options: {
      maxAttempts: 5,
      backoffSeconds: [1, 2, 4],
      retentionSeconds: retentionSeconds as number,
      maxBytes: 65_536,
      maxDecompressedBytes: 65_536 * 64,
      fetchTimeoutMs: 10_000,
      maxRedirects: 3,
    },
  };
}

test('T07: worker construction requires an explicit retention window', () => {
  assert.doesNotThrow(() => new FaviconJobWorkerLoop(makeWorkerOptions(42)));
  assert.throws(
    () => new FaviconJobWorkerLoop(makeWorkerOptions(undefined)),
    (error: unknown) => error instanceof FaviconRetentionConfigError,
  );
});

test('T07: constructing a worker never changes an API command retention', async () => {
  new FaviconJobWorkerLoop(makeWorkerOptions(42));
  const api = makeSingleHarness({ binding: makeBinding('object-old'), retentionSeconds: 600 });
  await processFaviconRefreshClaim(api.ports, makeClaim({ operation: 'refresh_one' }));
  assert.deepEqual(api.state.retired, [{
    objectId: 'object-old', deletableAt: new Date(NOW.getTime() + 600_000),
  }]);
});
