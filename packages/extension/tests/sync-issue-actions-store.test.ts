import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { pullLocalActions, pushLocalActions } from '../src/sync-issue-local-actions.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { ack, json as pullJson, pullEventsPage, scope as pullScope, setup as setupPull } from './durable-sync-engine-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import {
  installOutboundPushIndexedDb, json, problem, scope, setup, setupMove,
} from './outbound-push-worker-harness.js';

/**
 * K5, B-07/C-04: closing an item from this browser. Dismiss keeps this browser's version and
 * deletes nothing that was not already refused; a create, a delete and a change that waits for
 * another are not dismissed from here.
 */
installOutboundPushIndexedDb();

const refusal = (operationId: string) => (_url: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { batchId: string };
  return Promise.resolve(json(200, { batchId: body.batchId, results: [{ opId: operationId, sequence: 1, status: 'rejected',
    code: 'resource_id_unavailable', warnings: [] }], serverCursor: 'sync-unchanged' }));
};

describe('uploads the server refused', () => {
  test('a refused move is dismissed: the issue closes, the row stays as history, the mapping is untouched', async () => {
    const f = await setupMove();
    try {
      await createOutboundPushWorker({ ...f.options, fetch: async () => problem(400, 'move_not_allowed', { retryable: false }) }).drain();
      const row = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      assert.equal(row.status, 'rejected');
      assert.deepEqual(pushLocalActions(row), ['dismiss']);
      assert.equal((await readOpenSyncIssues(f.store, scope)).total, 1);
      const before = await f.store.getMappingByColpId(scope, 'node-bookmark');

      const outcome = await f.store.dismissQueueIssues(scope, ['op-push-1']);

      assert.deepEqual(outcome, { closed: ['op-push-1'], refused: [] });
      assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0);
      const after = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      assert.deepEqual([after.status, after.recovery?.code], ['rejected', 'dismissed']);
      assert.deepEqual(after.payload, row.payload, 'the refused change itself is kept as history');
      assert.deepEqual(await f.store.getMappingByColpId(scope, 'node-bookmark'), before);
      assert.deepEqual(await f.store.dismissQueueIssues(scope, ['op-push-1']), { closed: [], refused: ['op-push-1'] }, 'a second press finds nothing open');
    } finally { f.store.close(); }
  });

  test('a refusal that consumed its sequence is dismissed too, and its receipt stays', async () => {
    const f = await setupMove();
    try {
      await createOutboundPushWorker({ ...f.options, fetch: refusal('op-push-1') }).drain();
      const issues = await f.store.listConsumedQueueIssues(scope);
      assert.equal(issues.length, 1);
      assert.deepEqual(pushLocalActions(issues[0]!), ['dismiss']);

      const outcome = await f.store.dismissQueueIssues(scope, ['op-push-1']);

      assert.deepEqual(outcome.closed, ['op-push-1']);
      assert.deepEqual(await f.store.listConsumedQueueIssues(scope), []);
      assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0);
      assert.equal((await f.store.getQueueReceipt(scope, 1))?.kind, 'terminal', 'the server\'s answer is kept');
      assert.equal((await f.store.getQueueByOpId(scope, 'op-push-1'))?.status, 'terminal');
    } finally { f.store.close(); }
  });

  test('a change held for its own problem is dismissed, a change held for a decision is tried again instead', async () => {
    const f = await setupMove();
    try {
      await f.store.setAsideQueue(scope, [1], 'secret_field_forbidden');
      const held = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      assert.deepEqual(pushLocalActions(held), ['dismiss']);
      assert.deepEqual(pushLocalActions({ ...held, recovery: { code: 'create_placement_unproven' } }), ['retry']);

      assert.deepEqual((await f.store.dismissQueueIssues(scope, ['op-push-1'])).closed, ['op-push-1']);

      const row = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      assert.deepEqual([row.status, row.recovery?.code], ['rejected', 'dismissed']);
      assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0);
    } finally { f.store.close(); }
  });

  test('a create is never dismissed from here; a held one is tried again after the bookmark is fixed', async () => {
    const f = await setup();
    try {
      await f.store.setAsideQueue(scope, [1], 'secret_field_forbidden');
      const held = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      assert.deepEqual(pushLocalActions(held), ['retry']);
      assert.deepEqual(await f.store.dismissQueueIssues(scope, ['op-push-1']), { closed: [], refused: ['op-push-1'] });
      assert.equal((await f.store.getQueueByOpId(scope, 'op-push-1'))?.status, 'set_aside', 'untouched');
      assert.equal((await readOpenSyncIssues(f.store, scope)).total, 1);
    } finally { f.store.close(); }
  });

  test('a change that waits for another follows it: no action of its own, and it is refused if asked', async () => {
    const f = await setupMove();
    try {
      const { scopeKey: _key, sequence: _sequence, ...input } = f.queued;
      const second = await f.store.allocateSequenceAndEnqueue(scope, { ...input, opId: 'op-push-2', batchId: 'batch-2',
        idempotencyKey: 'idempotency-2', digest: 'sha256:operation-2', payload: { ...input.payload, opId: 'op-push-2', sequence: 2 } },
      { allowUnstamped: true });
      await f.store.setAsideQueue(scope, [1], 'secret_field_forbidden');
      const waiting = (await f.store.getQueueByOpId(scope, second.opId))!;
      assert.equal(waiting.recovery?.code, 'dependency_hold');
      assert.deepEqual(pushLocalActions(waiting), []);
      assert.deepEqual(await f.store.dismissQueueIssues(scope, [second.opId]), { closed: [], refused: [second.opId] });

      // Closing the holder leaves the follower for the next pass to release, as for any settled holder.
      await f.store.dismissQueueIssues(scope, ['op-push-1']);
      assert.equal((await f.store.getQueueByOpId(scope, second.opId))?.status, 'set_aside');
    } finally { f.store.close(); }
  });

  test('a conflict is settled in the Sync center, not here', async () => {
    const f = await setupMove();
    try {
      const row = (await f.store.getQueueByOpId(scope, 'op-push-1'))!;
      assert.deepEqual(pushLocalActions({ ...row, status: 'blocked', recovery: { code: 'conflict_pending' } }), []);
      assert.deepEqual(pushLocalActions({ ...row, status: 'blocked', recovery: { code: 'sequence_blocked' }, attempt: { startedAt: 1, body: '{}' } as never }),
        ['retry']);
    } finally { f.store.close(); }
  });
});

describe('remote items this browser set aside', () => {
  const create = (sequence: number, parentId: string) => pullFixtures.createEvent({ kind: 'Bookmark', sequence,
    collectionId: pullScope.collectionId, parentId });

  async function withIssue() {
    const f = await setupPull({ useRealPullApplier: true });
    f.pullResponses.push(pullJson(200, pullEventsPage([create(11, 'unknown-folder')], 'cursor-1')));
    f.ackResponses.push(pullJson(200, ack('cursor-1')));
    await f.engine.wake('manual');
    assert.deepEqual((await f.store.listPullIssues(pullScope)).map(issue => issue.nodeId), ['node-created-11']);
    return f;
  }

  test('dismissing one closes it, and later changes to the node apply again', async () => {
    const f = await withIssue();
    try {
      const issue = (await f.store.listPullIssues(pullScope))[0]!;
      assert.deepEqual(pullLocalActions(issue), ['retry', 'dismiss']);
      assert.equal((await readOpenSyncIssues(f.store, pullScope)).total, 1);

      assert.deepEqual(await f.store.dismissPullIssues(pullScope, [issue.nodeId]), { closed: [issue.nodeId], refused: [] });

      assert.deepEqual(await f.store.listPullIssues(pullScope), []);
      assert.equal((await readOpenSyncIssues(f.store, pullScope)).total, 0);
      assert.deepEqual(await f.store.dismissPullIssues(pullScope, [issue.nodeId]), { closed: [], refused: [issue.nodeId] });
    } finally { f.store.close(); }
  });

  test('a hold that a conflict decision settles is not dismissed from here', async () => {
    const f = await withIssue();
    try {
      const db = await f.store.open();
      const tx = db.transaction('diagnostics', 'readwrite');
      const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const request = tx.objectStore('diagnostics').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const issue = rows.find(row => row.kind === 'pull_issue')!;
      tx.objectStore('diagnostics').put({ ...issue, conflictOpIds: ['op-conflict'] });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
      const held = (await f.store.listPullIssues(pullScope))[0]!;
      assert.deepEqual(pullLocalActions(held), []);
      assert.deepEqual(await f.store.dismissPullIssues(pullScope, [held.nodeId]), { closed: [], refused: [held.nodeId] });
      assert.equal((await f.store.listPullIssues(pullScope)).length, 1);
    } finally { f.store.close(); }
  });

  test('an item whose bookmark is here by now closes by itself; an item that is not a create does not', async () => {
    const f = await withIssue();
    try {
      assert.equal(await f.store.closeLandedPullIssues(pullScope), 0, 'nothing is mapped yet');
      await f.store.putMapping(pullScope, { nativeId: 'native-landed', colpId: 'node-created-11', rootNativeId: 'root-native',
        nodeKind: 'bookmark', projection: { revision: 'r1', digest: 'sha256:landed', content: { title: 'Landed' } } });
      assert.equal(await f.store.closeLandedPullIssues(pullScope), 1);
      assert.deepEqual(await f.store.listPullIssues(pullScope), []);
    } finally { f.store.close(); }
  });

  test('a placeholder mapping, or an item about an update, is not landed', async () => {
    const f = await withIssue();
    try {
      await f.store.putMapping(pullScope, { nativeId: 'recovery:node-created-11', colpId: 'node-created-11', rootNativeId: 'root-native',
        nodeKind: 'bookmark', projection: { revision: 'r1', digest: 'sha256:placeholder', content: { title: 'Placeholder' } } });
      assert.equal(await f.store.closeLandedPullIssues(pullScope), 0, 'a placeholder is not the bookmark');
      await f.store.putMapping(pullScope, { nativeId: 'native-landed', colpId: 'node-created-11', rootNativeId: 'root-native',
        nodeKind: 'bookmark', projection: { revision: 'r1', digest: 'sha256:landed', content: { title: 'Landed' } } });
      const db = await f.store.open();
      const tx = db.transaction('pull_events', 'readwrite');
      const events = await new Promise<Array<Record<string, any>>>((resolve, reject) => {
        const request = tx.objectStore('pull_events').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const event = events.find(candidate => candidate.payload?.effect?.node?.id === 'node-created-11')!;
      tx.objectStore('pull_events').put({ ...event, payload: { ...event.payload, effect: { ...event.payload.effect, kind: 'node_content_updated' } } });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
      assert.equal(await f.store.closeLandedPullIssues(pullScope), 0, 'the node being here says nothing about whether the update was applied');
      assert.equal((await f.store.listPullIssues(pullScope)).length, 1);
    } finally { f.store.close(); }
  });
});
