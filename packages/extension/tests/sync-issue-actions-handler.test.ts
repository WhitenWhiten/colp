import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { validSyncIssueActionRequest } from '../src/sw/messages.js';
import { handleSyncIssueAction, type SyncIssueActionDeps } from '../src/sw/sync-issue-actions.js';
import { pullIssueId, queueIssueCode, queueIssueId } from '../src/sync-issue-snapshot.js';
import type { QueueOperation } from '../src/sync-state-store.js';
import { SYNC_ISSUE_ACTION_MAX } from '../src/sync-issue-local-actions.js';
import { installOutboundPushIndexedDb, problem, scope, setup, setupMove } from './outbound-push-worker-harness.js';

/**
 * K5: the worker side of Try again and Dismiss. Items are named by the display ids the card shows;
 * each is looked up again, and one that is gone or does not offer the action is skipped, never forced.
 */
installOutboundPushIndexedDb();

const idOf = (row: QueueOperation) => queueIssueId(row, queueIssueCode(row));

function deps(f: { store: SyncIssueActionDeps['store'] }, over: Partial<SyncIssueActionDeps> = {}) {
  const calls = { wakes: 0, ran: 0 };
  const value: SyncIssueActionDeps = { scope: async () => scope, store: f.store,
    run: async work => { calls.ran += 1; return work(); },
    recapture: () => async () => ({ operations: [] }),
    wake: () => { calls.wakes += 1; }, ...over };
  return { value, calls };
}

describe('Dismiss', () => {
  test('closes what offers it, skips what is gone or does not, and says how many', async () => {
    const f = await setupMove();
    try {
      await createOutboundPushWorker({ ...f.options, fetch: async () => problem(400, 'move_not_allowed', { retryable: false }) }).drain();
      const row = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      const { value, calls } = deps(f);

      const first = await handleSyncIssueAction(value, { kind: 'known.sync.issue.act', action: 'dismiss', issueIds: [idOf(row), 'not-an-open-item'] });

      assert.deepEqual(first, { ok: true, done: 1, skipped: 1, failed: 0 });
      assert.equal(calls.ran, 1, 'the queue change ran in the engine lane');
      assert.equal(calls.wakes, 0, 'nothing was released, so no pass is started');
      const again = await handleSyncIssueAction(value, { kind: 'known.sync.issue.act', action: 'dismiss', issueIds: [idOf(row)] });
      assert.deepEqual(again, { ok: true, done: 0, skipped: 1, failed: 0 }, 'a second press finds nothing open');
    } finally { f.store.close(); }
  });

  test('an item that does not offer it is skipped: a create, and a change held for a decision', async () => {
    const f = await setup();
    try {
      await f.store.setAsideQueue(scope, [1], 'secret_field_forbidden');
      const held = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      const { value } = deps(f);
      const result = await handleSyncIssueAction(value, { kind: 'known.sync.issue.act', action: 'dismiss', issueIds: [idOf(held)] });
      assert.deepEqual(result, { ok: true, done: 0, skipped: 1, failed: 0 });
      assert.equal((await f.store.getQueueByOpId(scope, 'op-push-1'))?.status, 'set_aside');
    } finally { f.store.close(); }
  });

  test('pull items are named by their own ids and closed in one call with the rest', async () => {
    const f = await setupMove();
    try {
      await f.store.setAsideQueue(scope, [1], 'secret_field_forbidden');
      const held = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      const { value } = deps(f);
      const result = await handleSyncIssueAction(value, { kind: 'known.sync.issue.act', action: 'dismiss',
        issueIds: [idOf(held), pullIssueId('node-nobody-has')] });
      assert.deepEqual(result, { ok: true, done: 1, skipped: 1, failed: 0 });
    } finally { f.store.close(); }
  });
});

describe('Try again', () => {
  test('releases a held change from a fresh capture and starts a pass', async () => {
    const f = await setupMove();
    try {
      await f.store.setAsideQueue(scope, [1], 'create_placement_unproven');
      const held = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      const { value, calls } = deps(f);

      const result = await handleSyncIssueAction(value, { kind: 'known.sync.issue.act', action: 'retry', issueIds: [idOf(held)] });

      assert.deepEqual(result, { ok: true, done: 1, skipped: 0, failed: 0, woke: true });
      assert.equal(calls.wakes, 1);
      const old = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      assert.deepEqual([old.status, old.recovery?.code], ['rejected', 'recaptured'], 'the old bytes stay as history');
    } finally { f.store.close(); }
  });

  test('says which code stopped it when the capture cannot be made, and leaves the item as it was', async () => {
    const f = await setupMove();
    try {
      await f.store.setAsideQueue(scope, [1], 'create_placement_unproven');
      const held = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      const { value, calls } = deps(f, { recapture: () => async () => { throw new Error('operation_schema_invalid'); } });

      const result = await handleSyncIssueAction(value, { kind: 'known.sync.issue.act', action: 'retry', issueIds: [idOf(held)] });

      assert.deepEqual(result, { ok: true, done: 0, skipped: 0, failed: 1, code: 'operation_schema_invalid' });
      assert.equal(calls.wakes, 0);
      assert.equal((await f.store.getQueueByOpId(scope, 'op-push-1'))?.status, 'set_aside');
    } finally { f.store.close(); }
  });

  test('sends an upload the server keeps blocking again with its bytes unchanged', async () => {
    const f = await setupMove();
    try {
      await createOutboundPushWorker({ ...f.options, fetch: async () => problem(409, 'sequence_blocked', { expectedSequence: 1 }) }).drain();
      const blocked = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      assert.equal(blocked.recovery?.code, 'sequence_blocked');
      const { value, calls } = deps(f);

      const result = await handleSyncIssueAction(value, { kind: 'known.sync.issue.act', action: 'retry', issueIds: [idOf(blocked)] });

      assert.deepEqual(result, { ok: true, done: 1, skipped: 0, failed: 0, woke: true });
      assert.equal(calls.wakes, 1);
      assert.equal((await f.store.getQueueByOpId(scope, 'op-push-1'))?.attempt?.body, blocked.attempt?.body, 'the same request body');
    } finally { f.store.close(); }
  });

  test('is refused for an item that does not offer it', async () => {
    const f = await setupMove();
    try {
      await f.store.setAsideQueue(scope, [1], 'secret_field_forbidden');
      const held = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      const { value } = deps(f);
      const result = await handleSyncIssueAction(value, { kind: 'known.sync.issue.act', action: 'retry', issueIds: [idOf(held)] });
      assert.deepEqual(result, { ok: true, done: 0, skipped: 1, failed: 0 });
    } finally { f.store.close(); }
  });
});

describe('the request', () => {
  test('is one of two actions on one to 250 display ids, and nothing else', () => {
    const ok = { kind: 'known.sync.issue.act', action: 'dismiss', issueIds: ['a1b2'] };
    assert.equal(validSyncIssueActionRequest(ok), true);
    assert.equal(validSyncIssueActionRequest({ ...ok, action: 'retry' }), true);
    assert.equal(validSyncIssueActionRequest({ ...ok, issueIds: Array.from({ length: SYNC_ISSUE_ACTION_MAX }, (_, i) => `id${i}`) }), true);
    for (const bad of [null, [], {}, { ...ok, action: 'release' }, { ...ok, action: 'delete' }, { ...ok, issueIds: [] }, { ...ok, issueIds: 'a1b2' },
      { ...ok, issueIds: Array.from({ length: SYNC_ISSUE_ACTION_MAX + 1 }, (_, i) => `id${i}`) }, { ...ok, issueIds: [''] },
      { ...ok, issueIds: ['has space'] }, { ...ok, issueIds: [42] }, { ...ok, issueIds: ['x'.repeat(129)] },
      { ...ok, scope: {} }, { ...ok, force: true }, { kind: 'known.sync.engine.retry' }]) {
      assert.equal(validSyncIssueActionRequest(bad), false, JSON.stringify(bad).slice(0, 80));
    }
  });

  test('says so when this browser is not connected, or the store cannot be read', async () => {
    const f = await setupMove();
    try {
      const request = { kind: 'known.sync.issue.act' as const, action: 'dismiss' as const, issueIds: ['a1b2'] };
      assert.deepEqual(await handleSyncIssueAction(deps(f, { scope: async () => { throw new Error('not_connected'); } }).value, request),
        { ok: false, error: 'not_connected' });
      f.store.close();
      const broken = { ...f.store, listQueue: async () => { throw new Error('indexeddb_unavailable'); } };
      assert.deepEqual(await handleSyncIssueAction(deps({ store: broken as never }).value, request), { ok: false, error: 'indexeddb_unavailable' });
    } finally { f.store.close(); }
  });
});
