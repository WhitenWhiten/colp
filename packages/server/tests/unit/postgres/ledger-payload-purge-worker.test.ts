import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const applyBatch = vi.hoisted(() => vi.fn());
vi.mock('../../../src/infrastructure/database/ledger-payload-purge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/infrastructure/database/ledger-payload-purge.js')>(),
  applyLedgerPayloadPurgeBatch: applyBatch,
}));

import { LedgerPayloadPurgeError } from '../../../src/infrastructure/database/ledger-payload-purge.js';
import {
  runLedgerPayloadPurgeWorkerOnce,
  serializeLedgerPayloadPurgeJob,
} from '../../../src/infrastructure/database/ledger-payload-purge-worker.js';
import type {
  LedgerPayloadPurgeJob,
  LedgerPayloadPurgeJobClaim,
  LedgerPayloadPurgeJobRepository,
} from '../../../src/infrastructure/database/ledger-payload-purge-job-repository.js';
import type { UnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';

const claim: LedgerPayloadPurgeJobClaim = Object.freeze({
  jobId: '11111111-1111-4111-8111-111111111111',
  segmentId: '22222222-2222-4222-8222-222222222222',
  family: 'operation',
  scopeKey: 'collection:test',
  lowerBound: 1n,
  upperBound: 11n,
  floorCommitOrdinal: 10n,
  floorTieBreaker: 'operation-10',
  floorRevision: 1n,
  status: 'running',
  attemptCount: 2,
  leaseOwner: 'worker-a',
  leaseToken: 3n,
  leaseExpiresAt: new Date('2026-09-01T01:00:00.000Z'),
  availableAt: new Date('2026-09-01T00:00:00.000Z'),
  lastErrorClass: null,
  deletedRowCount: 4n,
  createdAt: new Date('2026-08-31T00:00:00.000Z'),
  startedAt: new Date('2026-09-01T00:00:01.000Z'),
  completedAt: null,
  updatedAt: new Date('2026-09-01T00:00:02.000Z'),
});

function harness(claimResult: LedgerPayloadPurgeJobClaim | null = claim) {
  const jobs = {
    claimSegment: vi.fn(async () => claimResult ?? undefined),
    retry: vi.fn(async () => ({ ...claim, status: 'retryable' })),
  } as unknown as LedgerPayloadPurgeJobRepository;
  const transaction = { marker: 'transaction' };
  const unitOfWork: UnitOfWork = {
    execute: vi.fn(async (callback) => callback({ transaction: transaction as never })),
  };
  return { jobs, transaction, unitOfWork };
}

function input(value: ReturnType<typeof harness>, overrides: Record<string, unknown> = {}) {
  return {
    jobs: value.jobs,
    unitOfWork: value.unitOfWork,
    segmentId: claim.segmentId,
    confirmedSegmentId: claim.segmentId,
    leaseOwner: 'worker-a',
    nodeEnvironment: 'development',
    destructiveMode: 'development',
    ...overrides,
  };
}

beforeEach(() => {
  applyBatch.mockReset();
});

test('returns frozen not_due and uses the bounded default lease without opening a transaction', async () => {
  const value = harness(null);
  const outcome = await runLedgerPayloadPurgeWorkerOnce(input(value));

  assert.deepEqual(outcome, { kind: 'not_due', segmentId: claim.segmentId });
  assert.equal(Object.isFrozen(outcome), true);
  assert.deepEqual(vi.mocked(value.jobs.claimSegment).mock.calls[0]?.[0], {
    segmentId: claim.segmentId, leaseOwner: 'worker-a', leaseDurationMs: 300_000,
  });
  assert.equal(vi.mocked(value.unitOfWork.execute).mock.calls.length, 0);
});

test('applies one transaction batch and returns only the stable progress receipt', async () => {
  const value = harness();
  applyBatch.mockResolvedValue({
    jobId: claim.jobId, segmentId: claim.segmentId, family: claim.family,
    status: 'retryable', deletedThisBatch: 5n, deletedTotal: 9n,
  });

  const outcome = await runLedgerPayloadPurgeWorkerOnce(input(value, {
    leaseDurationMs: 45_000, batchSize: 5,
  }));

  assert.deepEqual(outcome, {
    kind: 'applied', segmentId: claim.segmentId, jobId: claim.jobId,
    status: 'retryable', deletedThisBatch: 5n, deletedTotal: 9n,
  });
  assert.equal(Object.isFrozen(outcome), true);
  assert.deepEqual(vi.mocked(value.jobs.claimSegment).mock.calls[0]?.[0], {
    segmentId: claim.segmentId, leaseOwner: 'worker-a', leaseDurationMs: 45_000,
  });
  assert.deepEqual(applyBatch.mock.calls[0], [value.transaction, {
    claim,
    confirmedSegmentId: claim.segmentId,
    nodeEnvironment: 'development',
    destructiveMode: 'development',
    batchSize: 5,
  }]);
  assert.equal(vi.mocked(value.jobs.retry).mock.calls.length, 0);
});

test.each([
  ['typed purge error', new LedgerPayloadPurgeError('invalid_batch_size', 'bad batch'), 'invalid_batch_size'],
  ['safe stableCode', Object.assign(new Error('provider'), { stableCode: 'provider_timeout' }), 'provider_timeout'],
  ['unsafe stableCode', Object.assign(new Error('provider'), { stableCode: 'INVALID-CODE' }), 'unexpected_failure'],
  ['unknown value', 'boom', 'unexpected_failure'],
] as const)('releases a failed claim with a stable retry class for %s', async (
  _label,
  error,
  expectedClass,
) => {
  const value = harness();
  applyBatch.mockRejectedValue(error);

  const outcome = await runLedgerPayloadPurgeWorkerOnce(input(value, { retryDelayMs: 12_345 }));

  assert.deepEqual(outcome, {
    kind: 'retryable', segmentId: claim.segmentId, jobId: claim.jobId,
    errorClass: expectedClass,
  });
  assert.equal(Object.isFrozen(outcome), true);
  assert.deepEqual(vi.mocked(value.jobs.retry).mock.calls[0], [claim, expectedClass, 12_345]);
});

test('serializes bigint and optional date fields into a frozen JSON-safe operations record', () => {
  const serialized = serializeLedgerPayloadPurgeJob(claim);
  assert.deepEqual(serialized, {
    jobId: claim.jobId,
    segmentId: claim.segmentId,
    family: 'operation',
    scopeKey: 'collection:test',
    lowerBound: '1',
    upperBound: '11',
    status: 'running',
    attemptCount: 2,
    leaseToken: '3',
    leaseExpiresAt: '2026-09-01T01:00:00.000Z',
    deletedRowCount: '4',
    availableAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    lastErrorClass: null,
  });
  assert.equal(Object.isFrozen(serialized), true);

  const completed: LedgerPayloadPurgeJob = {
    ...claim,
    status: 'succeeded',
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: new Date('2026-09-01T02:00:00.000Z'),
  };
  assert.equal(serializeLedgerPayloadPurgeJob(completed).leaseExpiresAt, null);
  assert.equal(serializeLedgerPayloadPurgeJob(completed).completedAt, '2026-09-01T02:00:00.000Z');
});
