import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import { cooldownIsPending, hasConflictBarrier, hasRecoverableQueueWork, hasRejectedBarrier,
  queueStatusProjection } from '../src/engine-public-stability.js';
import { readServiceWorkerGraph } from './service-worker-graph.js';

describe('P3-38 public engine stability facts', () => {
  test('compares Session and durable cooldown deadlines as epoch milliseconds', () => {
    const now = 10_000;
    for (const [label, sessionNotBefore, errorCode, engineNotBefore, expected] of [
      ['idle sleeping', 0, undefined, 40_000, false],
      ['expired Session cooldown', 9_999, undefined, 0, false],
      ['Session cooldown boundary', 10_000, undefined, 0, false],
      ['future Session cooldown', 10_001, undefined, 0, true],
      ['expired durable error backoff', 0, 'rate_limited', 9_999, false],
      ['durable error backoff boundary', 0, 'rate_limited', 10_000, false],
      ['future durable error backoff', 0, 'rate_limited', 10_001, true],
      ['future normal poll deadline', 0, undefined, 40_000, false],
    ] as const) {
      assert.equal(cooldownIsPending({ now, sessionNotBefore, errorCode, engineNotBefore }), expected, label);
    }
  });

  test('fails closed for malformed epoch millisecond facts', () => {
    const valid = { now: 10_000, sessionNotBefore: 0, errorCode: undefined, engineNotBefore: 0 };
    for (const [label, patch] of [
      ['missing now', { now: undefined }],
      ['NaN now', { now: Number.NaN }],
      ['negative now', { now: -1 }],
      ['missing Session deadline', { sessionNotBefore: undefined }],
      ['NaN Session deadline', { sessionNotBefore: Number.NaN }],
      ['negative Session deadline', { sessionNotBefore: -1 }],
      ['missing engine deadline', { engineNotBefore: undefined }],
      ['NaN engine deadline', { engineNotBefore: Number.NaN }],
      ['negative engine deadline', { engineNotBefore: -1 }],
      ['unsafe engine deadline', { engineNotBefore: Number.MAX_SAFE_INTEGER + 1 }],
    ] as const) {
      assert.equal(cooldownIsPending({ ...valid, ...patch }), true, label);
    }
  });

  test('accepts real epoch millisecond values beyond the current wall clock', () => {
    const now = Date.now(); const future = now + 60_000;
    assert.equal(cooldownIsPending({ now, sessionNotBefore: future,
      errorCode: undefined, engineNotBefore: 0 }), true);
    assert.equal(cooldownIsPending({ now: future, sessionNotBefore: now,
      errorCode: 'network_unavailable', engineNotBefore: future }), false);
  });

  test('only terminal and rejected queue records are settled', () => {
    assert.equal(hasRecoverableQueueWork([]), false);
    assert.equal(hasRecoverableQueueWork([{ status: 'terminal' }, { status: 'rejected' }]), false);
    for (const status of ['pending', 'claimed', 'deferred', 'unknown', 'gap', 'blocked']) {
      assert.equal(hasRecoverableQueueWork([{ status }]), true, status);
    }
    assert.equal(hasRecoverableQueueWork([{}]), true, 'unknown status fails closed');
  });

  test('a conflict barrier is exactly a blocked row waiting for conflict resolution', () => {
    assert.equal(hasConflictBarrier([]), false);
    assert.equal(hasConflictBarrier([{ status: 'blocked', recovery: { code: 'conflict_pending' } }]), true);
    // Other blocked causes (sequence_blocked) and other statuses are not
    // conflicts; the UI must not claim one.
    assert.equal(hasConflictBarrier([{ status: 'blocked', recovery: { code: 'sequence_blocked' } }]), false);
    assert.equal(hasConflictBarrier([{ status: 'pending', recovery: { code: 'conflict_pending' } }]), false);
    assert.equal(hasConflictBarrier([{ status: 'blocked' }]), false);
  });

  test('projects rejected, conflict, and recoverable queue rows into a public status', () => {
    assert.equal(hasRejectedBarrier([]), false);
    assert.equal(hasRejectedBarrier([{ status: 'rejected' }]), true);
    assert.equal(queueStatusProjection([]), 'idle');
    assert.equal(queueStatusProjection([{ status: 'rejected' }]), 'rejected');
    assert.equal(queueStatusProjection([{ status: 'pending' }]), 'syncing');
    assert.equal(queueStatusProjection([{ status: 'blocked', recovery: { code: 'conflict_pending' } }]), 'conflict');
  });

  test('the status surfaces translate the conflict barrier into user language', async () => {
    const worker = await readServiceWorkerGraph();
    assert.match(worker, /conflictPending/);
    assert.match(worker, /hasConflictBarrier/);
    const draft = await readFile(new URL('../src/first-run-draft.ts', import.meta.url), 'utf8');
    // The draft projects the engine's conflict barrier into a typed status ...
    assert.match(draft, /engine\.conflictPending\) return 'review-conflicts'/);
    // ... and that status is rendered as user copy, never as the raw code.
    const status = await readFile(new URL('../src/sync-status.ts', import.meta.url), 'utf8');
    assert.match(status, /'review-conflicts': t\('sync_reviewConflicts', 'Review conflicts'\)/);
    const firstRun = await readFile(new URL('../src/sync-label.ts', import.meta.url), 'utf8');
    assert.match(firstRun, /hasPendingWork/);
  });
});
