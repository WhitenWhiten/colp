import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { pendingLocalContentFields } from '../src/pull-queue-facts.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('P3-28 pull history pruning', () => {
  test('REVIEW: pruning an applied echo must not resurrect a terminal edit as pending', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active',
      lease: { leaseId: 'lease-1', expiresAt: Date.parse('2099-01-01') },
      checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
    const queued = await store.allocateSequenceAndEnqueue(scope, {
      opId: 'old-local-update', batchId: 'batch-old', idempotencyKey: 'key-old',
      digest: 'sha256:old', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'revision-0', operationRevision: 'local-old', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId: 'node-1',
        payload: { base: { title: 'Original' }, value: { title: 'Old local title' } } },
    }, { allowUnstamped: true });
    await store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
      operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-old', resultDigest: 'sha256:result' });
    await store.stagePullPage(scope, { pageId: 'page-1', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
      collectionRevision: 'revision-1', pageDigest: 'sha256:p1', effectPages: [], events: [{
        eventId: 'own-echo', cursor: 'cursor-1', operationId: queued.opId, effectId: queued.opId,
        effectDigest: 'sha256:effect', operationDigest: queued.digest, kind: 'node_content_updated',
        payload: {}, initialState: 'authority_committed',
      }] });
    await store.completePullPage(scope, 'page-1');
    const mapping = { colpId: 'node-1', nativeId: 'native-1' };
    assert.deepEqual(await pendingLocalContentFields(store, scope, mapping), {});
    await new Promise(resolve => setTimeout(resolve, 5));
    await store.stagePullPage(scope, { pageId: 'page-2', previousCursor: 'cursor-1', nextCursor: 'cursor-2',
      collectionRevision: 'revision-2', pageDigest: 'sha256:p2', effectPages: [], events: [] });
    await store.completePullPage(scope, 'page-2');
    assert.equal(await store.prunePullHistory(scope, 1), 1);
    assert.deepEqual(await pendingLocalContentFields(store, scope, mapping), {},
      'an acknowledged historical title must never become a protected local overlay again');
  });

  test('multiple retention chunks preserve the newest tail and repeated pruning is stable', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
    for (let n = 1; n <= 30; n += 1) {
      await store.stagePullPage(scope, { pageId: `page-${String(n).padStart(2, '0')}`,
        previousCursor: `cursor-${n - 1}`, nextCursor: `cursor-${n}`, collectionRevision: `r-${n}`,
        pageDigest: `sha256:${n}`, events: [], effectPages: [] });
      await store.completePullPage(scope, `page-${String(n).padStart(2, '0')}`);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    await store.prunePullHistory(scope, 3);
    assert.deepEqual((await store.listPullPages(scope)).map(page => page.pageId), ['page-28', 'page-29', 'page-30']);
    assert.equal(await store.prunePullHistory(scope, 3), 0);
  });

  test('prunes completed pull history beyond the keep tail and keeps live pages', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
    const committedEvent = (eventId: string, cursor: string) => ({ eventId, cursor,
      operationId: `remote-${eventId}`, effectId: `effect-${eventId}`, effectDigest: `sha256:${eventId}`,
      operationDigest: `sha256:${eventId}-op`, kind: 'node_content_updated', payload: {},
      initialState: 'authority_committed' as const });
    await store.stagePullPage(scope, { pageId: 'page-1', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
      collectionRevision: 'revision-1', pageDigest: 'sha256:page-1', events: [committedEvent('e1', 'cursor-1')],
      effectPages: [{ eventId: 'e1', effectId: 'effect-e1', pageNumber: 1, pageDigest: 'sha256:effect-1',
        previousPageDigest: null, payload: {} }] });
    await store.completePullPage(scope, 'page-1');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    await store.stagePullPage(scope, { pageId: 'page-2', previousCursor: 'cursor-1', nextCursor: 'cursor-2',
      collectionRevision: 'revision-2', pageDigest: 'sha256:page-2', events: [committedEvent('e2', 'cursor-2')],
      effectPages: [] });
    await store.completePullPage(scope, 'page-2');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    await store.stagePullPage(scope, { pageId: 'page-3', previousCursor: 'cursor-2', nextCursor: 'cursor-3',
      collectionRevision: 'revision-3', pageDigest: 'sha256:page-3', events: [committedEvent('e3', 'cursor-3')],
      effectPages: [] });
    await store.completePullPage(scope, 'page-3');
    await store.stagePullPage(scope, { pageId: 'page-live', previousCursor: 'cursor-3', nextCursor: 'cursor-4',
      collectionRevision: 'revision-4', pageDigest: 'sha256:page-live', events: [committedEvent('e4', 'cursor-4')],
      effectPages: [] });
    await assert.rejects(() => store.prunePullHistory(scope, 0), /limit_exceeded/);
    assert.equal(await store.prunePullHistory(scope, 2), 1);
    const completed = (await store.listPullPages(scope, ['page_complete'])).map((page) => page.pageId);
    assert.deepEqual(completed.sort(), ['page-2', 'page-3']);
    assert.deepEqual((await store.listPullPages(scope, ['staged'])).map((page) => page.pageId), ['page-live']);
    const events = await store.listPullEvents(scope);
    assert.deepEqual(events.map((event) => event.eventId).sort(), ['e2', 'e3', 'e4']);
    assert.equal(await store.getPullEvent(scope, 'e1'), null);
    const exported = await store.exportScope(scope);
    assert.equal(exported.effectPages.length, 0);
    assert.equal(exported.cursor?.cursor, 'cursor-3');
  });
});
