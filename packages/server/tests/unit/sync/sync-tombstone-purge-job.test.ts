import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  SyncTombstonePurgeJob,
  type PostgresSyncTombstonePurgeCoordinator,
} from '../../../src/infrastructure/sync/index.js';

test('P3-23 job is non-reentrant and can retry after a crash', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const coordinator = {
    async runBatch() {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
      if (calls === 2) throw new Error('injected crash');
      return { collectionId: null, purgedCount: 0,
        purgedThrough: { commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' },
        hasMore: false };
    },
  } as unknown as PostgresSyncTombstonePurgeCoordinator;
  const errors: unknown[] = [];
  const job = new SyncTombstonePurgeJob(coordinator, { intervalMs: 60_000,
    onError(error) { errors.push(error); } });
  const first = job.tick();
  await Promise.resolve();
  await job.tick();
  assert.equal(calls, 1);
  release?.();
  await first;
  await job.tick();
  assert.equal(errors.length, 1);
  await job.tick();
  assert.equal(calls, 3);
});
