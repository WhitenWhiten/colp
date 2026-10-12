import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  applyBatchCaptureCas,
  applyRestoreCas,
  type FaviconBatchCasPorts,
} from '../../../src/modules/collections/application/favicon-batch-execution.js';
import type {
  FaviconJobItemRow,
  FaviconSourceRestoreRow,
} from '../../../src/modules/collections/application/favicon-batch-policy.js';
import type { FaviconJobRecord } from '../../../src/modules/collections/application/favicon-job.js';
import type { FaviconJobClaim, FaviconFetchedImage } from '../../../src/modules/collections/application/favicon-job-execution.js';

const NOW = new Date('2026-09-17T00:00:00.000Z');

function claim(overrides: Partial<FaviconJobClaim> = {}): FaviconJobClaim {
  return {
    jobId: 'job-1',
    leaseOwner: 'lease-owner-1',
    accountId: 'account-1',
    ownerSubjectId: 'subject-1',
    operation: 'fill_missing',
    status: 'running',
    attempts: 1,
    collectionId: 'collection-1',
    nodeId: 'node-1',
    sourceUrl: 'https://favicone.com/example.com',
    sourceRevision: '1',
    policyRevision: '2',
    nodeResourceRevision: 'r1',
    objectId: null,
    ...overrides,
  };
}

function item(overrides: Partial<FaviconJobItemRow> = {}): FaviconJobItemRow {
  return {
    jobId: 'job-1',
    nodeId: 'node-1',
    collectionId: 'collection-1',
    sourceUrl: 'https://favicone.com/example.com',
    sourceRevision: 1n,
    nodeResourceRevision: 'r1',
    status: 'pending',
    errorReason: null,
    attempts: 0,
    nextAttemptAt: null,
    objectId: null,
    objectContentType: null,
    objectByteSize: null,
    objectDigestSha256: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function restore(): FaviconSourceRestoreRow {
  return {
    nodeId: 'node-1',
    collectionId: 'collection-1',
    accountId: 'account-1',
    originalSourceMode: 'online',
    originalObjectId: 'object-original',
    originalContentType: 'image/png',
    originalByteSize: 10,
    originalDigestSha256: null,
    sourceRevision: 1n,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function job(status: FaviconJobRecord['status'] = 'running'): FaviconJobRecord {
  return {
    jobId: 'job-1',
    accountId: 'account-1',
    ownerSubjectId: 'subject-1',
    operation: 'fill_missing',
    policyRevision: 2n,
    status,
    total: 1,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errorNodeId: null,
    errorReason: null,
    collectionId: 'collection-1',
    nodeId: 'node-1',
    sourceUrl: 'https://favicone.com/example.com',
    sourceRevision: 1n,
    nodeResourceRevision: 'r1',
    objectId: null,
    objectContentType: null,
    objectByteSize: null,
    objectDigestSha256: null,
    createdAt: NOW,
    updatedAt: NOW,
    leaseOwner: 'lease-owner-1',
};
}

interface CasTrace {
  lockedJobs: string[];
  bookmarkedNulls: number;
  upserts: number;
  metadataWrites: number;
  successMarks: number;
  retiredRecords: number;
  restoreUpserts: number;
}

/** CAS ports whose verify yields `ready` for the fixture facts above. */
function casPorts(options: {
  jobStatus?: FaviconJobRecord['status'];
  /** Race shape: what the pre-CAS verify read sees vs the CAS-time lock sees. */
  findStatus?: FaviconJobRecord['status'];
  lockStatus?: FaviconJobRecord['status'];
  existingBinding?: boolean;
} = {}): { tx: FaviconBatchCasPorts; trace: CasTrace } {
  const trace: CasTrace = {
    lockedJobs: [], bookmarkedNulls: 0, upserts: 0, metadataWrites: 0,
    successMarks: 0, retiredRecords: 0, restoreUpserts: 0,
  };
  const tx = {
    jobs: {
      findByJobId: async (jobId: string) => {
        if (jobId !== 'job-1') return null;
        return job(options.findStatus ?? options.jobStatus ?? 'running');
      },
      lockByJobId: async (jobId: string) => {
        trace.lockedJobs.push(jobId);
        if (jobId !== 'job-1') return null;
        return job(options.lockStatus ?? options.jobStatus ?? 'running');
      },
      insert: async () => undefined,
    },
    items: {
      findByJobAndNode: async () => item({ status: 'pending' }),
      setObjectMetadata: async () => { trace.metadataWrites += 1; },
      markSucceeded: async () => { trace.successMarks += 1; },
      markSkipped: async () => undefined,
      markFailed: async () => undefined,
      scheduleRetry: async () => undefined,
      setObjectId: async () => undefined,
    },
    collections: {
      lockForUpdate: async () => ({ deletedAt: null, ownerSubjectId: 'subject-1' }),
    },
    nodes: {
      getNode: async () => ({
        id: 'node-1', collectionId: 'collection-1', kind: 'bookmark',
        deletedAt: null, url: 'https://example.com/bookmark',
      }),
    },
    sources: {
      findByNodeId: async () => null,
      setMode: async () => undefined,
    },
    policies: {
      findByAccountId: async () => ({ revision: 2n }),
    },
    bookmarkIcons: {
      findByNodeId: async () => {
        trace.bookmarkedNulls += 1;
        return options.existingBinding === true
          ? { nodeId: 'node-1', collectionId: 'collection-1', objectId: 'object-old',
              contentType: 'image/png', byteSize: 5, digestSha256: Buffer.alloc(32), createdAt: NOW, updatedAt: NOW }
          : null;
      },
      upsert: async () => { trace.upserts += 1; },
    },
    gc: {
      recordRetired: async () => { trace.retiredRecords += 1; },
    },
    restores: {
      upsert: async () => { trace.restoreUpserts += 1; },
      findByNodeId: async () => null,
      deleteByNodeId: async () => undefined,
    },
  } as unknown as FaviconBatchCasPorts;
  return { tx, trace };
}

const fetched: FaviconFetchedImage = {
  body: Buffer.from('png-bytes'), mime: 'image/png', width: 16, height: 16,
};

test('FO-C-01: a superseded job can no longer bind its captured object', async () => {
  const { tx, trace } = casPorts({ jobStatus: 'superseded' });
  const verdict = await applyBatchCaptureCas(tx, claim(), item(), 'object-1', fetched, NOW, 86_400);
  assert.equal(verdict.kind, 'gone');
  assert.deepEqual(trace.lockedJobs, ['job-1']);
  assert.equal(trace.upserts, 0, 'superseded job must never write the binding');
  assert.equal(trace.metadataWrites, 0);
  assert.equal(trace.successMarks, 0);
  assert.equal(trace.retiredRecords, 0);
});

test('FO-C-01: a vanished job cannot bind either', async () => {
  const { tx, trace } = casPorts({ jobStatus: 'running' });
  const verdict = await applyBatchCaptureCas(tx, claim({ jobId: 'job-gone' }), item(), 'object-1', fetched, NOW, 86_400);
  assert.equal(verdict.kind, 'gone');
  assert.equal(trace.upserts, 0);
});

test('FO-C-01: an active job still binds exactly once (guard against over-restriction)', async () => {
  const { tx, trace } = casPorts({ jobStatus: 'running' });
  const verdict = await applyBatchCaptureCas(tx, claim(), item(), 'object-1', fetched, NOW, 86_400);
  assert.equal(verdict.kind, 'applied');
  assert.deepEqual(trace.lockedJobs, ['job-1']);
  assert.equal(trace.upserts, 1);
  assert.equal(trace.metadataWrites, 1);
  assert.equal(trace.successMarks, 1);
});

test('FO-C-01: job superseded between the verify read and the CAS commit must not bind (race shape)', async () => {
    // The genuine race FIXCHECK-2 asked for: the verify (jobs.findByJobId)
    // still saw the job running, but the job was superseded before the CAS
    // write phase. Pre-fix there was no CAS-time job gate, so verify passed
    // and the binding WAS written — the pre-fix code must fail this case.
    const { tx, trace } = casPorts({ findStatus: 'running', lockStatus: 'superseded' });
    const verdict = await applyBatchCaptureCas(tx, claim(), item(), 'object-1', fetched, NOW, 86_400);
    assert.equal(verdict.kind, 'gone');
    assert.equal(trace.upserts, 0, 'a job superseded before the CAS write must never bind');
    assert.equal(trace.metadataWrites, 0);
    assert.equal(trace.successMarks, 0);
  });

  test('FO-C-01: the restore CAS refuses a superseded job before binding the original', async () => {
  const { tx, trace } = casPorts({ jobStatus: 'superseded' });
  const verdict = await applyRestoreCas(tx, claim(), item(), restore(), NOW, 86_400);
  assert.equal(verdict.kind, 'gone');
  assert.equal(trace.upserts, 0, 'superseded restore must not re-bind the original');
});