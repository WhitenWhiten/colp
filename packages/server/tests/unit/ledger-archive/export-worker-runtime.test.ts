import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';

import {
  type LedgerArchiveExportClaim,
  type LedgerArchiveExportJob,
  type LedgerArchiveExportJobRepository,
} from '../../../src/infrastructure/database/ledger-archive-export-job-repository.js';
import { createLedgerArchiveExportWorker } from '../../../src/infrastructure/ledger-archive/export-worker.js';

test('concurrent ticks share one claim pass and a crashed export becomes retryable', async () => {
  const harness = repositoryHarness();
  const worker = createLedgerArchiveExportWorker({
    jobs: harness.repository,
    leaseOwner: 'runtime-test',
    exportSegment: async () => { throw new Error('provider disconnected'); },
  });
  const [left, right] = await Promise.all([worker.tick(), worker.tick()]);
  assert.equal(left, true);
  assert.equal(right, true);
  assert.equal(harness.claimCalls, 1);
  assert.deepEqual(harness.outcomes, ['retry:archive_export_failed']);
});

test('stop aborts and drains an in-flight claim without leaving the runtime running', async () => {
  const harness = repositoryHarness();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const worker = createLedgerArchiveExportWorker({
    jobs: harness.repository,
    leaseOwner: 'runtime-stop-test',
    pollIntervalMs: 10,
    exportSegment: async (_segmentId, signal) => {
      entered();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    },
  });
  worker.start();
  await started;
  await worker.stop();
  assert.equal(worker.isRunning(), false);
  assert.deepEqual(harness.outcomes, ['retry:archive_worker_stopped']);
});

test('lease timeout aborts the exporter and records a stable retry class', async () => {
  const harness = repositoryHarness();
  const worker = createLedgerArchiveExportWorker({
    jobs: harness.repository,
    leaseOwner: 'runtime-timeout-test',
    leaseDurationMs: 1_000,
    exportSegment: async (_segmentId, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
      });
    },
  });
  assert.equal(await worker.tick(), true);
  assert.deepEqual(harness.outcomes, ['retry:archive_lease_timeout']);
});

test.each(['loop', 'manual'] as const)('stop during pending %s claim releases work without starting export', async (mode) => {
  const harness = repositoryHarness();
  let entered!: () => void;
  let release!: () => void;
  const claiming = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let exports = 0;
  const worker = createLedgerArchiveExportWorker({
    jobs: { ...harness.repository, async claimDue(input) {
      entered();
      await gate;
      return harness.repository.claimDue(input);
    } },
    leaseOwner: 'stop-claim',
    exportSegment: async () => { exports++; },
  });
  const tick = mode === 'manual' ? worker.tick() : undefined;
  if (mode === 'loop') worker.start();
  await claiming;
  const stopped = worker.stop();
  release();
  await stopped;
  await tick;
  assert.equal(exports, 0);
  assert.equal(worker.isRunning(), false);
  assert.deepEqual(harness.outcomes, ['retry:archive_worker_stopped']);
});

function repositoryHarness(): {
  readonly repository: LedgerArchiveExportJobRepository;
  readonly outcomes: string[];
  readonly claimCalls: number;
} {
  const outcomes: string[] = [];
  let claimCalls = 0;
  const claim = fixtureClaim();
  let claimed = false;
  const repository: LedgerArchiveExportJobRepository = {
    async enqueue() { throw new Error('unused'); },
    async get() { return undefined; },
    async getBySegment() { return undefined; },
    async list() { return []; },
    async claimDue() {
      claimCalls += 1;
      if (claimed) return [];
      claimed = true;
      return [claim];
    },
    async succeed() { outcomes.push('succeeded'); return claim; },
    async retry(_claim, errorClass) { outcomes.push(`retry:${errorClass}`); return outcome('retryable'); },
    async fail(_claim, errorClass) { outcomes.push(`failed:${errorClass}`); return outcome('failed'); },
  };
  return {
    repository,
    outcomes,
    get claimCalls() { return claimCalls; },
  };
}

function fixtureClaim(): LedgerArchiveExportClaim {
  return outcome('running') as LedgerArchiveExportClaim;
}

function outcome(status: LedgerArchiveExportJob['status']): LedgerArchiveExportJob {
  const now = new Date();
  return Object.freeze({
    jobId: randomUUID(), segmentId: randomUUID(), status, attemptCount: 1,
    leaseOwner: status === 'running' ? 'runtime-test' : null,
    leaseToken: 1n, leaseExpiresAt: status === 'running' ? new Date(now.getTime() + 60_000) : null,
    availableAt: now, lastErrorClass: null, createdAt: now, startedAt: now,
    completedAt: status === 'failed' ? now : null, updatedAt: now,
  });
}
