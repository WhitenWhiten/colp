/**
 * FO-03 favicon bulk policy pure functions: strategy transitions, fill
 * target selection, force coverage/restore records, batch paging/aggregates
 * and terminal-state computation. No I/O — the DB candidates/worker loops are
 * covered by the integration suite.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  DEFAULT_FAVICON_PROVIDER_TEMPLATE,
  type FaviconPolicyPatch,
  type FaviconPolicyRow,
} from '../../../src/modules/collections/index.js';
import {
  aggregateFaviconBatchItems,
  buildFaviconBatchJobItems,
  buildFaviconRestoreItems,
  faviconBatchTerminalStatus,
  faviconPolicyBatchTrigger,
  type FaviconBatchCandidate,
  type FaviconJobItemRow,
  type FaviconSourceRestoreRow,
} from '../../../src/modules/collections/index.js';

const PINNED_TIME = new Date('2026-09-14T00:00:00.000Z');

function policy(overrides: Partial<FaviconPolicyRow> = {}): FaviconPolicyRow {
  return {
    accountId: 'account-fo03-unit',
    newDefault: 'capture',
    providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE,
    fillMissing: false,
    forceAllOnline: false,
    revision: 3n,
    updatedAt: PINNED_TIME,
    ...overrides,
  };
}

function candidate(overrides: Partial<FaviconBatchCandidate> = {}): FaviconBatchCandidate {
  return {
    nodeId: 'node-1',
    collectionId: 'coll-1',
    url: 'https://example.org/page',
    nodeResourceRevision: 'res-1',
    sourceMode: null,
    sourceRevision: 1n,
    hasBinding: false,
    ...overrides,
  };
}

describe('faviconPolicyBatchTrigger (policy change → durable job)', () => {
  test('force on → apply_force_online; force off → restore_sources', () => {
    assert.equal(
      faviconPolicyBatchTrigger(policy(), { forceAllOnline: true }), 'apply_force_online');
    assert.equal(
      faviconPolicyBatchTrigger(policy({ forceAllOnline: true }), { forceAllOnline: false }),
      'restore_sources');
    // Force-off wins over any other trigger in the same patch.
    assert.equal(
      faviconPolicyBatchTrigger(policy({ forceAllOnline: true }),
        { forceAllOnline: false, fillMissing: true }),
      'restore_sources');
  });

  test('online default activation → refresh_online; template change under online → refresh_online', () => {
    assert.equal(faviconPolicyBatchTrigger(policy(), { newDefault: 'online' }), 'refresh_online');
    assert.equal(
      faviconPolicyBatchTrigger(policy({ newDefault: 'online' }),
        { providerTemplate: 'https://icons.example.test/{hostname}' }),
      'refresh_online');
    // Template change alone (online not active) triggers nothing.
    assert.equal(
      faviconPolicyBatchTrigger(policy(),
        { providerTemplate: 'https://icons.example.test/{hostname}' }),
      null);
    // No-op online keeps nothing.
    assert.equal(faviconPolicyBatchTrigger(policy({ newDefault: 'online' }), { newDefault: 'online' }), null);
  });

  test('fillMissing on → fill_missing; off/no-op → null', () => {
    assert.equal(faviconPolicyBatchTrigger(policy(), { fillMissing: true }), 'fill_missing');
    assert.equal(faviconPolicyBatchTrigger(policy({ fillMissing: true }), { fillMissing: true }), null);
    assert.equal(faviconPolicyBatchTrigger(policy({ fillMissing: true }), { fillMissing: false }), null);
    // newDefault change (non-online) alone triggers nothing.
    assert.equal(faviconPolicyBatchTrigger(policy(), { newDefault: 'none' }), null);
  });
});

describe('buildFaviconBatchJobItems (fill/refresh target selection)', () => {
  test('resolves the provider URL and carries the async identity', () => {
    const items = buildFaviconBatchJobItems({
      jobId: 'job-1',
      candidates: [
        candidate({ nodeId: 'n1', url: 'https://Example.org/a', sourceRevision: 2n }),
        candidate({ nodeId: 'n2', url: 'https://two.example.org/b', nodeResourceRevision: 'res-9' }),
      ],
      policy: policy(),
      now: PINNED_TIME,
    });
    assert.deepEqual(items.map((item) => item.nodeId), ['n1', 'n2']);
    assert.equal(items[0]!.sourceUrl, 'https://favicone.com/example.org');
    assert.equal(items[0]!.sourceRevision, 2n);
    assert.equal(items[0]!.jobId, 'job-1');
    assert.equal(items[1]!.nodeResourceRevision, 'res-9');
    assert.equal(items[1]!.createdAt, PINNED_TIME);
  });

  test('excludes candidates whose hostname cannot be safely resolved', () => {
    const items = buildFaviconBatchJobItems({
      jobId: 'job-1',
      candidates: [
        candidate({ nodeId: 'ok', url: 'https://ok.example.org/x' }),
        candidate({ nodeId: 'ip', url: 'https://10.0.0.1/x' }),
        candidate({ nodeId: 'ftp', url: 'ftp://host.example.org/x' }),
        candidate({ nodeId: 'userinfo', url: 'https://user:pass@example.org/x' }),
        candidate({ nodeId: 'local', url: 'https://svc.internal/x' }),
        candidate({ nodeId: 'broken', url: 'not-a-url' }),
      ],
      policy: policy(),
      now: PINNED_TIME,
    });
    assert.deepEqual(items.map((item) => item.nodeId), ['ok']);
  });

  test('uses the account provider template (custom), not the default', () => {
    const items = buildFaviconBatchJobItems({
      jobId: 'job-1',
      candidates: [candidate({ url: 'https://host.example.org/x' })],
      policy: policy({ providerTemplate: 'https://icons.example.com/{hostname}.ico' }),
      now: PINNED_TIME,
    });
    assert.equal(items[0]!.sourceUrl, 'https://icons.example.com/host.example.org.ico');
  });
});

describe('buildFaviconRestoreItems (force-off recoverable overwrite)', () => {
  test('maps restore rows to items with the original source revision', () => {
    const rows: FaviconSourceRestoreRow[] = [{
      nodeId: 'n1', collectionId: 'c1', accountId: 'a1', originalSourceMode: 'uploaded',
      originalObjectId: 'obj-1', originalContentType: 'image/png', originalByteSize: 10,
      originalDigestSha256: Buffer.alloc(32, 1), sourceRevision: 2n,
      createdAt: PINNED_TIME, updatedAt: PINNED_TIME,
    }];
    const items = buildFaviconRestoreItems({ jobId: 'job-r', rows, now: PINNED_TIME });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.nodeId, 'n1');
    assert.equal(items[0]!.sourceRevision, 2n);
    assert.equal(items[0]!.sourceUrl, '');
  });
});

describe('aggregateFaviconBatchItems + terminal status (batch paging / counters)', () => {
  function item(status: FaviconJobItemRow['status'], nextAttemptAt: Date | null = null): Pick<FaviconJobItemRow, 'status' | 'nextAttemptAt'> {
    return { status, nextAttemptAt };
  }
  const now = PINNED_TIME;

  test('counters reflect ALL items; pending items drive the resume instant', () => {
    const agg = aggregateFaviconBatchItems([
      item('succeeded'), item('succeeded'), item('failed'),
      item('skipped'), item('pending', new Date(now.getTime() + 4_000)), item('pending'),
    ]);
    assert.deepEqual(agg, {
      total: 6, succeeded: 2, failed: 1, skipped: 1, pendingCount: 2,
      nextAttemptAt: new Date(now.getTime() + 4_000),
    });
  });

  test('a capped cycle leaves pending items and the job resumes', () => {
    const firstCycle = aggregateFaviconBatchItems([
      item('succeeded'), item('succeeded'), item('pending'), item('pending'),
    ]);
    assert.equal(firstCycle.succeeded, 2);
    assert.equal(firstCycle.pendingCount, 2);
    assert.equal(firstCycle.nextAttemptAt, null, 'due items stay claimable immediately');
    const drained = aggregateFaviconBatchItems([
      item('succeeded'), item('succeeded'), item('succeeded'), item('succeeded'),
    ]);
    assert.equal(drained.pendingCount, 0);
    assert.equal(drained.nextAttemptAt, null);
  });

  test('terminal status: all-success / all-failed / mixed partial', () => {
    assert.equal(faviconBatchTerminalStatus({ succeeded: 4, failed: 0, skipped: 0 }), 'succeeded');
    assert.equal(faviconBatchTerminalStatus({ succeeded: 0, failed: 4, skipped: 0 }), 'failed');
    assert.equal(faviconBatchTerminalStatus({ succeeded: 3, failed: 1, skipped: 0 }), 'partial');
    assert.equal(faviconBatchTerminalStatus({ succeeded: 0, failed: 0, skipped: 4 }), 'partial');
    assert.equal(faviconBatchTerminalStatus({ succeeded: 0, failed: 0, skipped: 0 }), 'succeeded');
  });
});

describe('FaviconPolicyPatch type guards (parse-level)', () => {
  test('patch union shape composes with the trigger', () => {
    const multi: FaviconPolicyPatch = { newDefault: 'online', fillMissing: true, forceAllOnline: false };
    assert.equal(faviconPolicyBatchTrigger(policy(), multi), 'refresh_online');
    const force: FaviconPolicyPatch = { fillMissing: true, forceAllOnline: true };
    assert.equal(faviconPolicyBatchTrigger(policy(), force), 'apply_force_online');
  });
});