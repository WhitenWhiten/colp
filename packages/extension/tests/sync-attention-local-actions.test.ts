import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { OPEN_SYNC_ISSUE_CEILING, OPEN_SYNC_ISSUE_WARNING, issueCeilingWarning } from '../src/sync-issue-ceiling.js';
import { queueIssueCode, queueIssueId } from '../src/sync-issue-snapshot.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { ack, json as pullJson, pullEventsPage, scope as pullScope, setup as setupPull } from './durable-sync-engine-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { installOutboundPushIndexedDb, problem, scope, setup, setupMove } from './outbound-push-worker-harness.js';

/**
 * K5, A-F8/B-12: the Status card is given, for each item, exactly the actions this device can carry out
 * (the card never offers a button the worker would refuse), and is told when sync is close to stopping.
 */
installOutboundPushIndexedDb();

async function attention(store: Parameters<typeof handleSyncAttentionRequest>[0]['store'], forScope = scope, openIssues?: never) {
  const response = await handleSyncAttentionRequest({ scope: async () => forScope, store, ...(openIssues ? { openIssues } : {}) });
  assert.equal(response.ok, true);
  return response.ok ? response.attention : (undefined as never);
}

describe('the actions an item is given', () => {
  test('a refused move can be dismissed, under the id the Sync center knows it by', async () => {
    const f = await setupMove();
    try {
      await createOutboundPushWorker({ ...f.options, fetch: async () => problem(400, 'move_not_allowed', { retryable: false }) }).drain();
      const row = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      const { issues } = await attention(f.store);
      assert.equal(issues?.length, 1);
      assert.deepEqual(issues![0]!.localActions, ['dismiss']);
      assert.equal(issues![0]!.issueId, queueIssueId(row, queueIssueCode(row)));
    } finally { f.store.close(); }
  });

  test('a change held for a decision can be tried again; the Sync center is offered the same', async () => {
    const f = await setupMove();
    try {
      await f.store.setAsideQueue(scope, [1], 'create_placement_unproven');
      const [issue] = (await attention(f.store)).issues!;
      assert.deepEqual(issue!.localActions, ['retry']);
      assert.deepEqual(issue!.actions, ['retry']);
    } finally { f.store.close(); }
  });

  for (const code of ['push_request_refused', 'metadata_sync_disabled', 'queue_row_unreadable', 'push_attempt_bind_failed']) {
    test(`a change held as ${code} is an item that can be tried again, here and in the Sync center (stream 2)`, async () => {
      const f = await setupMove();
      try {
        await f.store.setAsideQueue(scope, [1], code);
        const [issue] = (await attention(f.store)).issues!;
        assert.equal(issue!.code, code);
        assert.deepEqual(issue!.localActions, ['retry']);
        assert.deepEqual(issue!.actions, ['retry']);
      } finally { f.store.close(); }
    });
  }

  test('a held create is tried again once the bookmark is fixed, and is never offered Dismiss', async () => {
    const f = await setup();
    try {
      await f.store.setAsideQueue(scope, [1], 'secret_field_forbidden');
      const [issue] = (await attention(f.store)).issues!;
      assert.deepEqual(issue!.localActions, ['retry']);
    } finally { f.store.close(); }
  });

  test('a change that waits for another one has none, and the one it waits for does', async () => {
    const f = await setupMove();
    try {
      const { scopeKey: _key, sequence: _sequence, ...input } = f.queued;
      await f.store.allocateSequenceAndEnqueue(scope, { ...input, opId: 'op-push-2', batchId: 'batch-2', idempotencyKey: 'idempotency-2',
        digest: 'sha256:operation-2', payload: { ...input.payload, opId: 'op-push-2', sequence: 2 } }, { allowUnstamped: true });
      await f.store.setAsideQueue(scope, [1], 'secret_field_forbidden');
      const { issues } = await attention(f.store);
      const byOp = (opId: string) => issues!.find(issue => issue.opId === opId)!;
      assert.deepEqual(byOp('op-push-1').localActions, ['dismiss']);
      assert.equal(byOp('op-push-2').localActions, undefined);
    } finally { f.store.close(); }
  });

  test('a remote item this browser set aside can be tried again or dismissed', async () => {
    const f = await setupPull({ useRealPullApplier: true });
    try {
      f.pullResponses.push(pullJson(200, pullEventsPage([pullFixtures.createEvent({ kind: 'Bookmark', sequence: 11,
        collectionId: pullScope.collectionId, parentId: 'unknown-folder' })], 'cursor-1')));
      f.ackResponses.push(pullJson(200, ack('cursor-1')));
      await f.engine.wake('manual');
      const { issues } = await attention(f.store, pullScope);
      assert.equal(issues?.length, 1);
      assert.deepEqual(issues![0]!.localActions, ['retry', 'dismiss']);
    } finally { f.store.close(); }
  });
});

describe('the line before sync stops', () => {
  test('the warning starts at 150 open items and carries the limit', () => {
    assert.equal(issueCeilingWarning(OPEN_SYNC_ISSUE_WARNING - 1), undefined);
    assert.deepEqual(issueCeilingWarning(OPEN_SYNC_ISSUE_WARNING), { open: 150, limit: OPEN_SYNC_ISSUE_CEILING });
    assert.deepEqual(issueCeilingWarning(201), { open: 201, limit: 200 });
  });

  test('the attention read carries it only near the ceiling', async () => {
    const f = await setupMove();
    try {
      const open = await readOpenSyncIssues(f.store, scope);
      assert.equal((await attention(f.store, scope, { ...open, operationalTotal: 149 } as never)).issueCeiling, undefined);
      assert.deepEqual((await attention(f.store, scope, { ...open, operationalTotal: 163 } as never)).issueCeiling, { open: 163, limit: 200 });
    } finally { f.store.close(); }
  });
});
