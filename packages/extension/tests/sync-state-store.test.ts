import { pendingLocalContentFields } from '../src/pull-queue-facts.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import {
  DATABASE_NAME, DATABASE_VERSION, SyncStateError, createSyncStateStore,
  type QueueOperation, type SyncScope, type PullEventInput,
} from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
const other = { ...scope, accountId: 'account-b', replicaId: 'replica-b' };
const operation = (opId = 'op-1'): Omit<QueueOperation, 'sequence' | 'scopeKey'> => ({
  opId, batchId: 'batch-1', idempotencyKey: 'idempotency-1', digest: `sha256:${opId}`,
  endpointIdentity: 'syncPush', mediaType: 'application/vnd.collection-protocol.sync+json',
  baseRevision: 'revision-0', operationRevision: 'revision-local-1', status: 'pending',
  retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node', targetId: 'node-1' },
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('P3-28 validation and isolated CRUD', () => {
  test('round-trips cloned scope, mapping, queue, receipt, cursor, intent and recovery records', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: ['root-a'] });
    await store.putMapping(scope, { nativeId: 'native-1', colpId: 'node-1', rootNativeId: 'root-a',
      projection: { revision: 'revision-0', digest: 'sha256:projection-0' } });
    const queued = await store.allocateSequenceAndEnqueue(scope, operation(), { allowUnstamped: true });
    await store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
      operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-1', resultDigest: 'sha256:result-1' });
    await store.publishCursor(scope, { cursor: 'cursor-1', checkpoint: 'checkpoint-1',
      evidence: { receiptId: 'receipt-1', operationDigest: queued.digest } });
    await store.createApplyIntent(scope, { intentId: 'intent-1', correlationId: 'correlation-1',
      operationId: 'remote-op-1', expected: { kind: 'change', nativeId: 'native-1' }, expiresAt: 20_000 });
    await store.stageRecoveryPage(scope, { snapshotId: 'snapshot-1', revision: 'revision-2',
      syncCursor: 'spc2.cursor-1', capability: 'bookmarks-v1',
      identityDigest: 'identity-1', rootNodeId: 'colp-recovered',
      page: 0, pageDigest: 'sha256:page-0', previousPageDigest: null, nextCursor: null, complete: true,
      nodes: [{ colpId: 'node-2', parentId: null, position: 'a', kind: 'Bookmark', payloadDigest: 'sha256:node-2' }] });
    const exported = await store.exportScope(scope);
    assert.equal(exported.queue[0]?.status, 'terminal');
    assert.equal(exported.receipts[0]?.operationDigest, queued.digest);
    assert.equal(exported.cursor?.cursor, 'cursor-1');
    assert.equal(exported.intents[0]?.correlationId, 'correlation-1');
    assert.equal(exported.recovery?.complete, true);
    exported.scope!.selectedRoots.push('mutated');
    assert.deepEqual((await store.getScope(scope))?.selectedRoots, ['root-a']);
    store.close();
  });

  test('strictly rejects unknown keys, unsafe/I-JSON values, oversized bytes and recursive secrets', async () => {
    const store = createSyncStateStore({ indexedDB, maxRecordBytes: 1024 });
    const invalid: unknown[] = [
      { ...scope, lifecycle: 'active', lease: { leaseId: 'x', expiresAt: 1 }, checkpoint: null,
        selectedRoots: [], unexpected: true },
      { ...scope, lifecycle: 'active', lease: { leaseId: 'x', expiresAt: Number.MAX_SAFE_INTEGER + 1 },
        checkpoint: null, selectedRoots: [] },
      { ...scope, lifecycle: 'active', lease: { leaseId: 'x', expiresAt: 1 }, checkpoint: null,
        selectedRoots: [], metadata: { nested: { refreshToken: 'forbidden' } } },
      { ...scope, lifecycle: 'active', lease: { leaseId: 'x', expiresAt: 1 }, checkpoint: null,
        selectedRoots: ['x'.repeat(2_000)] },
    ];
    for (const value of invalid) await assert.rejects(() => store.registerScope(value as never), SyncStateError);
    await assert.rejects(() => store.allocateSequenceAndEnqueue(scope, { ...operation(), payload: { value: NaN } }, { allowUnstamped: true }),
      /i_json_invalid/);
    await assert.rejects(() => store.allocateSequenceAndEnqueue(scope, { ...operation(), payload: { secret: 'x' } }, { allowUnstamped: true }),
      /secret_field_forbidden/);
  });

  test('refuses unstamped enqueue unless allowUnstamped is explicit', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await assert.rejects(() => store.allocateSequenceAndEnqueue(scope, operation()), /operation_validator_missing/);
    await assert.rejects(() => store.allocateSequenceAndEnqueue(scope, operation(), {
      validateOperation: () => true,
    }), /operation_validator_missing/);
    const queued = await store.allocateSequenceAndEnqueue(scope, operation(), { allowUnstamped: true });
    assert.equal(queued.sequence, 1);
    assert.equal(queued.digest, 'sha256:op-1');
    const stamped = await store.allocateSequenceAndEnqueue(scope, operation('op-stamp'), {
      validateOperation: () => true, digestOperation: () => 'sha256:stamped',
    });
    assert.equal(stamped.digest, 'sha256:stamped');
    assert.equal(stamped.payload.replicaId, scope.replicaId);
    assert.equal(stamped.payload.sequence, stamped.sequence);
  });

  test('isolates complete environment/server/account/profile/Collection/Replica scope', async () => {
    const store = createSyncStateStore({ indexedDB });
    for (const candidate of [scope, other]) await store.registerScope({ ...candidate, lifecycle: 'active',
      lease: { leaseId: `lease-${candidate.accountId}`, expiresAt: 100 }, checkpoint: null, selectedRoots: [] });
    await store.allocateSequenceAndEnqueue(scope, operation('same-op'), { allowUnstamped: true });
    await store.allocateSequenceAndEnqueue(other, operation('same-op'), { allowUnstamped: true });
    assert.equal((await store.listQueue(scope)).length, 1);
    assert.equal((await store.listQueue(other)).length, 1);
  });

  test('accepts an identical completed empty pull page replay but rejects payload reuse', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 100 },
      checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
    const page = { pageId: 'empty-page', previousCursor: 'cursor-0', nextCursor: 'cursor-0',
      collectionRevision: 'revision-0', pageDigest: 'sha256:empty-page', events: [], effectPages: [] };
    await store.stagePullPage(scope, page);
    await store.completePullPage(scope, page.pageId);
    await store.stagePullPage(scope, page);
    await assert.rejects(() => store.stagePullPage(scope, { ...page, pageDigest: 'sha256:changed' }),
      /pull_page_reuse/);
  });

  test.each(['operation', 'conflict'])('settles conflict content and its echo when a resolved %s fact commits', async (kind) => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
    const queued = await store.allocateSequenceAndEnqueue(scope, { ...operation('conflicted-op'),
      payload: { type: 'update_node_content', targetId: 'node-1', payload: {
        base: { title: 'Base', url: 'https://base.test/' },
        value: { title: 'Discarded', url: 'https://discarded.test/' },
      } } }, { allowUnstamped: true });
    const lease = await store.acquireLease(scope, 'owner-1', 100, 1_000);
    assert.equal(lease.outcome, 'acquired');
    await store.claimQueue(scope, 'owner-1', lease.fence, 100, queued.sequence);
    await store.settleClaimedPush(scope, queued.sequence, 'owner-1', lease.fence, {
      outcome: 'blocked', retry: { attempt: 0, notBefore: 100 }, recovery: { code: 'conflict_pending' },
      receipt: { opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-conflict',
        resultDigest: 'sha256:conflict', result: { results: [{ opId: queued.opId, status: 'conflicted',
          conflictId: 'conflict-1' }] } },
    });
    const event: PullEventInput = { eventId: 'event-conflict-resolved', cursor: 'cursor-1', operationId: 'resolution-op-1',
      effectId: 'effect-resolution-1', effectDigest: 'sha256:resolved', operationDigest: 'sha256:resolved',
      kind: 'node_content_updated', initialState: 'authority_committed' as const,
      payload: kind === 'conflict' ? { kind, conflict: { id: 'conflict-1', incomingOpId: queued.opId, status: 'resolved' } }
        : { cursor: 'cursor-1', kind, operation: { opId: 'resolution-op-1',
          dependencies: [queued.opId], source: { adapterProfile: 'known-conflict-resolution' } } } };
    await store.stagePullPage(scope, { pageId: 'resolved-page', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
      collectionRevision: 'revision-1', pageDigest: 'sha256:resolved-page', events: [event], effectPages: [] });
    await store.completePullPage(scope, 'resolved-page');
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
    assert.equal((await store.listQueue(scope))[0]?.echoApplied, true);
    assert.deepEqual(await pendingLocalContentFields(store, scope, { colpId: 'node-1', nativeId: 'native-1' }), {});
    // Simulate a terminal row left by an older extension, using the real Pull
    // decision and queue data while stripping only the newly introduced stamp.
    assert.deepEqual(await pendingLocalContentFields({
      listQueueByTarget: async (targetScope, targetId) => (await store.listQueueByTarget(targetScope, targetId))
        .map(({ echoApplied: _echo, ...row }) => row),
      listBookmarkEventsByNative: store.listBookmarkEventsByNative,
      pullOperationsCovered: store.pullOperationsCovered,
    }, scope, { colpId: 'node-1', nativeId: 'native-1' }), {});
    assert.equal((await store.exportScope(scope)).cursor?.cursor, 'cursor-1');
  });

  test('reuses a Pull correlation only after the prior browser mutation is authority committed', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
    const events = ['event-1', 'event-2'].map((eventId, ordinal) => ({ eventId, cursor: `cursor-${ordinal + 1}`,
      operationId: `remote-${ordinal + 1}`, effectId: `effect-${ordinal + 1}`, effectDigest: `sha256:effect-${ordinal + 1}`,
      operationDigest: `sha256:operation-${ordinal + 1}`, kind: 'node_content_updated', payload: {},
      initialState: 'staged' as const }));
    await store.stagePullPage(scope, { pageId: 'same-correlation-page', previousCursor: 'cursor-0',
      nextCursor: 'cursor-2', collectionRevision: 'revision-2', pageDigest: 'sha256:same-correlation',
      events, effectPages: [] });
    const intent = (eventId: string, operationId: string) => ({ intentId: `intent:${eventId}`,
      correlationId: 'same-correlation', operationId, eventId, effectId: `effect-${eventId.at(-1)}`,
      state: 'intent_prepared', expected: { kind: 'change', nativeId: 'native-1' }, expiresAt: Date.now() + 60_000,
      apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null });
    await store.preparePullIntent(scope, 'event-1', intent('event-1', 'remote-1'));
    await assert.rejects(() => store.preparePullIntent(scope, 'event-2', intent('event-2', 'remote-2')),
      /intent_correlation_active/);
    await store.markPullBrowserCallStarted(scope, 'event-1');
    await store.commitPullEvent(scope, 'event-1', {});
    assert.equal(await store.observeApplyIntentEvent(scope, 'same-correlation', {
      eventDigest: 'late-native-event',
    }), true);
    assert.equal((await store.findApplyIntent(scope, 'same-correlation'))?.state, 'authority_committed');
    await store.preparePullIntent(scope, 'event-2', intent('event-2', 'remote-2'));
    assert.equal((await store.findApplyIntent(scope, 'same-correlation'))?.intentId, 'intent:event-2');
  });

  test('settles an earlier projection receipt without overwriting a later durable local projection', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.putMapping(scope, { nativeId: 'native-1', colpId: 'node-1', rootNativeId: 'root',
      projection: { revision: 'local-2', digest: 'sha256:local-2' } });
    const first = await store.allocateSequenceAndEnqueue(scope, { ...operation('update-1'),
      operationRevision: 'local-1', payload: { type: 'update_node_content', targetId: 'node-1' } }, { allowUnstamped: true });
    await store.allocateSequenceAndEnqueue(scope, { ...operation('update-2'), operationRevision: 'local-2',
      payload: { type: 'update_node_content', targetId: 'node-1' } }, { allowUnstamped: true });
    const lease = await store.acquireLease(scope, 'owner-1', 100, 1_000); assert.equal(lease.outcome, 'acquired');
    await store.claimQueue(scope, 'owner-1', lease.fence, 100, first.sequence);
    await store.settleClaimedPush(scope, first.sequence, 'owner-1', lease.fence, { outcome: 'terminal',
      receipt: { opId: first.opId, operationDigest: first.digest, kind: 'terminal', receiptId: 'receipt-update-1',
        resultDigest: 'sha256:update-1', result: { results: [{ opId: first.opId, sequence: first.sequence,
          status: 'applied', targetId: 'node-1', revision: 'server-1' }] } },
      authoritativeProjection: { targetId: 'node-1', revision: 'server-1' } });
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
    assert.equal((await store.getMappingByColpId(scope, 'node-1'))?.projection.revision, 'local-2');
  });

  test('settles an exact Push receipt after Pull already applied its authoritative projection', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.putMapping(scope, { nativeId: 'native-1', colpId: 'node-1', rootNativeId: 'root',
      projection: { revision: 'server-1', digest: 'sha256:server-1' } });
    const queued = await store.allocateSequenceAndEnqueue(scope, { ...operation('update-1'),
      operationRevision: 'local-1', payload: { type: 'update_node_content', targetId: 'node-1' } }, { allowUnstamped: true });
    const lease = await store.acquireLease(scope, 'owner-1', 100, 1_000); assert.equal(lease.outcome, 'acquired');
    await store.claimQueue(scope, 'owner-1', lease.fence, 100, queued.sequence);
    await store.settleClaimedPush(scope, queued.sequence, 'owner-1', lease.fence, { outcome: 'terminal',
      receipt: { opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-update-1',
        resultDigest: 'sha256:update-1', result: { results: [{ opId: queued.opId, sequence: queued.sequence,
          status: 'applied', targetId: 'node-1', revision: 'server-1' }] } },
      authoritativeProjection: { targetId: 'node-1', revision: 'server-1' } });
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
    assert.equal((await store.exportScope(scope)).receipts[0]?.receiptId, 'receipt-update-1');
    assert.equal((await store.getMappingByColpId(scope, 'node-1'))?.projection.revision, 'server-1');
  });

  test('commits a Pull page without overwriting a projection backed by the durable local queue', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
    await store.putMapping(scope, { nativeId: 'native-1', colpId: 'node-1', rootNativeId: 'root',
      projection: { revision: 'local-2', digest: 'sha256:local-2' } });
    await store.allocateSequenceAndEnqueue(scope, { ...operation('local-2'), operationRevision: 'local-2',
      payload: { type: 'update_node_content', targetId: 'node-1' } }, { allowUnstamped: true });
    const event = { eventId: 'remote-event', cursor: 'cursor-1', operationId: 'remote-op', effectId: 'remote-effect',
      effectDigest: 'sha256:remote-effect', operationDigest: 'sha256:remote-op', kind: 'node_content_updated',
      payload: {}, initialState: 'staged' as const };
    await store.stagePullPage(scope, { pageId: 'advanced-local-page', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
      collectionRevision: 'revision-1', pageDigest: 'sha256:advanced-local-page', events: [event], effectPages: [] });
    await store.preparePullIntent(scope, event.eventId, { intentId: 'intent:remote-event', correlationId: 'remote-correlation',
      operationId: event.operationId, eventId: event.eventId, effectId: event.effectId, state: 'intent_prepared',
      expected: { kind: 'change', nativeId: 'native-1' }, expiresAt: Date.now() + 60_000,
      preStateDigest: 'sha256:server-old', nativeTargetId: 'native-1', apiPhase: 'intent_prepared',
      nativeEventEvidence: null, apiResultEvidence: null });
    await store.markPullBrowserCallStarted(scope, event.eventId);
    await store.commitPullEvent(scope, event.eventId, { mappings: [{ nativeId: 'native-1', colpId: 'node-1',
      rootNativeId: 'root', projection: { revision: 'server-1', digest: 'sha256:server-1' } }] });
    await store.completePullPage(scope, 'advanced-local-page');
    assert.equal((await store.getMappingByColpId(scope, 'node-1'))?.projection.revision, 'local-2');
    assert.equal((await store.exportScope(scope)).cursor?.cursor, 'cursor-1');
  });

  test('SYNC-F011 completePullPage finishes the current page among many historical pull events', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
    for (let index = 0; index < 40; index += 1) {
      const pageId = `hist-${index}`;
      const cursor = `cursor-${index}`;
      const next = `cursor-${index + 1}`;
      const event = { eventId: `hist-event-${index}`, cursor: next, operationId: `hist-op-${index}`,
        effectId: `hist-effect-${index}`, effectDigest: `sha256:hist-effect-${index}`,
        operationDigest: `sha256:hist-op-${index}`, kind: 'node_content_updated', payload: {},
        initialState: 'authority_committed' as const };
      await store.stagePullPage(scope, { pageId, previousCursor: cursor, nextCursor: next,
        collectionRevision: `revision-${index + 1}`, pageDigest: `sha256:${pageId}`, events: [event],
        effectPages: [] });
      await store.completePullPage(scope, pageId);
    }
    const live = { eventId: 'live-event', cursor: 'cursor-41', operationId: 'live-op', effectId: 'live-effect',
      effectDigest: 'sha256:live-effect', operationDigest: 'sha256:live-op', kind: 'node_content_updated',
      payload: {}, initialState: 'authority_committed' as const };
    await store.stagePullPage(scope, { pageId: 'live-page', previousCursor: 'cursor-40', nextCursor: 'cursor-41',
      collectionRevision: 'revision-41', pageDigest: 'sha256:live-page', events: [live], effectPages: [] });
    const pageRows = await store.listPullEventsByPage(scope, 'live-page');
    assert.equal(pageRows.length, 1);
    assert.equal(pageRows[0]?.eventId, 'live-event');
    await store.completePullPage(scope, 'live-page');
    assert.equal((await store.exportScope(scope)).cursor?.cursor, 'cursor-41');
    assert.equal((await store.listPullPages(scope, ['page_complete'])).length, 41);
  });

  test('SYNC-F011 advanced check finds the matching queue revision among many other rows', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
    await store.putMapping(scope, { nativeId: 'native-1', colpId: 'node-1', rootNativeId: 'root',
      projection: { revision: 'local-keep', digest: 'sha256:local-keep' } });
    for (let index = 0; index < 80; index += 1) {
      await store.allocateSequenceAndEnqueue(scope, { ...operation(`noise-${index}`),
        operationRevision: `noise-rev-${index}`,
        payload: { type: 'update_node_content', targetId: `noise-node-${index}` } }, { allowUnstamped: true });
    }
    await store.allocateSequenceAndEnqueue(scope, { ...operation('local-keep'), operationRevision: 'local-keep',
      payload: { type: 'update_node_content', targetId: 'node-1' } }, { allowUnstamped: true });
    const event = { eventId: 'remote-event', cursor: 'cursor-1', operationId: 'remote-op', effectId: 'remote-effect',
      effectDigest: 'sha256:remote-effect', operationDigest: 'sha256:remote-op', kind: 'node_content_updated',
      payload: {}, initialState: 'staged' as const };
    await store.stagePullPage(scope, { pageId: 'advanced-among-noise', previousCursor: 'cursor-0',
      nextCursor: 'cursor-1', collectionRevision: 'revision-1', pageDigest: 'sha256:advanced-among-noise',
      events: [event], effectPages: [] });
    await store.preparePullIntent(scope, event.eventId, { intentId: 'intent:remote-event',
      correlationId: 'remote-correlation', operationId: event.operationId, eventId: event.eventId,
      effectId: event.effectId, state: 'intent_prepared', expected: { kind: 'change', nativeId: 'native-1' },
      expiresAt: Date.now() + 60_000, preStateDigest: 'sha256:server-old', nativeTargetId: 'native-1',
      apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null });
    await store.markPullBrowserCallStarted(scope, event.eventId);
    await store.commitPullEvent(scope, event.eventId, { mappings: [{ nativeId: 'native-1', colpId: 'node-1',
      rootNativeId: 'root', projection: { revision: 'server-1', digest: 'sha256:server-1' } }] });
    await store.completePullPage(scope, 'advanced-among-noise');
    assert.equal((await store.getMappingByColpId(scope, 'node-1'))?.projection.revision, 'local-keep');
    assert.equal((await store.exportScope(scope)).cursor?.cursor, 'cursor-1');
  });
});

describe('P3-28 leases, recovery, corruption and archival', () => {
  test('renews an owned lease without changing its fence', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active',
      lease: { leaseId: 'lease', expiresAt: 99_999 }, checkpoint: null, selectedRoots: [] });
    const acquired = await store.acquireLease(scope, 'owner-a', 1_000, 1_000);
    const renewed = await store.renewLease(scope, 'owner-a', acquired.fence, 1_500, 5_000);
    assert.equal(renewed.expiresAt, 6_500);
    const contended = await store.acquireLease(scope, 'owner-b', 1_600, 1_000);
    assert.equal(contended.outcome, 'contended');
    await assert.rejects(() => store.renewLease(scope, 'owner-b', acquired.fence, 1_600, 1_000), /stale_fence/u);
  });
  test('arbitrates concurrent owners with a monotonic fence and rejects stale commits', async () => {
    const a = createSyncStateStore({ indexedDB }); const b = createSyncStateStore({ indexedDB }); await active(a);
    const [one, two] = await Promise.all([a.acquireLease(scope, 'owner-a', 100, 50), b.acquireLease(scope, 'owner-b', 100, 50)]);
    assert.equal([one, two].filter((result) => result.outcome === 'acquired').length, 1);
    const winner = one.outcome === 'acquired' ? one : two;
    await assert.rejects(() => a.claimQueue(scope, 'stale-owner', winner.fence + 1, 100, 10), /stale_fence/);
    const owner = winner.ownerId; const queued = await a.allocateSequenceAndEnqueue(scope, operation(), { allowUnstamped: true });
    await a.claimQueue(scope, owner, winner.fence, 100, 1);
    const replacement = await b.acquireLease(scope, 'replacement-owner', 200, 50);
    assert.equal(replacement.outcome, 'acquired');
    await assert.rejects(() => a.completeClaimedQueueWithReceipt(scope, queued.sequence, owner, winner.fence, {
      opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: 'stale-receipt',
      resultDigest: 'sha256:stale-result',
    }), /stale_fence/);
    assert.equal((await a.exportScope(scope)).receipts.length, 0);
  });

  test('requires a complete page chain before atomically swapping recovery staging into live mappings', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.putMapping(scope, { nativeId: 'native-root', colpId: 'old-root', rootNativeId: 'native-root',
      nodeKind: 'folder', projection: { revision: 'r1', digest: 'sha256:old-root' } });
    await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'native-root', ancestorNativeIds: [] }],
      selectedNativeIds: ['native-root'], privateNativeIds: [], status: 'ready' });
    await store.stageRecoveryPage(scope, { snapshotId: 's1', revision: 'r2', syncCursor: 'spc2.s1',
      capability: 'bookmarks-v1',
      identityDigest: 'identity-s1', rootNodeId: 'a', page: 0,
      pageDigest: 'sha256:p0', previousPageDigest: null, nextCursor: 'page-1', complete: false, nodes: [] });
    await assert.rejects(() => store.commitRecovery(scope, 's1'), /recovery_incomplete/);
    await store.stageRecoveryPage(scope, { snapshotId: 's1', revision: 'r2', syncCursor: 'spc2.s1',
      capability: 'recovery-capability',
      identityDigest: 'identity-s1', rootNodeId: 'a', page: 1,
      pageDigest: 'sha256:p1', previousPageDigest: 'sha256:p0', nextCursor: null, complete: true,
      nodes: [{ colpId: 'node-r', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:n',
        mapping: { nativeId: 'native-root', colpId: 'node-r', rootNativeId: 'native-root', nodeKind: 'folder',
          projection: { revision: 'r2', digest: 'sha256:new-root' } } }] });
    await store.commitRecovery(scope, 's1');
    const exported = await store.exportScope(scope);
    assert.equal((await store.getScope(scope))?.checkpoint?.serverRevision, 'r2');
    assert.equal(exported.recovery, null);
    assert.equal(exported.recoveryNodes.length, 0);
    assert.equal(exported.mappings[0]?.colpId, 'node-r');
    assert.deepEqual(exported.scope?.selectedRoots, ['node-r']);
  });

  test('atomically discards a rejected bootstrap Ack and persists the authority refresh freeze', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.putMapping(scope, { nativeId: 'native-root', colpId: 'old-root', rootNativeId: 'native-root',
      nodeKind: 'folder', projection: { revision: 'r1', digest: 'sha256:old-root' } });
    await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'native-root', ancestorNativeIds: [] }],
      selectedNativeIds: ['native-root'], privateNativeIds: [], status: 'ready' });
    await store.stageRecoveryPage(scope, { snapshotId: 'legacy-spc2', revision: 'r2',
      syncCursor: 'spc2.normal', capability: 'spc2.normal',
      identityDigest: 'identity-spc2', rootNodeId: 'root-r', page: 0, pageDigest: 'sha256:spc2',
      previousPageDigest: null, nextCursor: null, complete: true,
      nodes: [{ colpId: 'root-r', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:root-r',
        mapping: { nativeId: 'native-root', colpId: 'root-r', rootNativeId: 'native-root', nodeKind: 'folder',
          projection: { revision: 'r2', digest: 'sha256:root-r' } } }] });
    const ackBody = JSON.stringify({ sessionId: 'session-stale', cursor: 'spc2.normal', warnings: [] });
    await store.commitRecovery(scope, 'legacy-spc2', { intentId: 'bootstrap-spc2',
      sessionId: 'session-stale', idempotencyKey: 'bootstrap-spc2', endpointIdentity: 'syncAck',
      mediaType: 'application/json', body: ackBody, bodyDigest: createHash('sha256').update(ackBody).digest('hex') });
    await store.transitionEngine(scope, { phase: 'acking', updatedAt: 100, recoveryFrozen: true, notBefore: 0,
      sessionId: 'session-stale', lastPublishedCursor: 'spc2.normal', authorityRefreshRequired: false });

    await store.rejectBootstrapAckAndRequireAuthorityRefresh(scope, 'bootstrap-spc2', {
      sessionId: 'session-stale', updatedAt: 101, notBefore: 1_101, errorCode: 'stale_replica' });
    const exported = await store.exportScope(scope);
    assert.equal(exported.ackIntents.length, 0);
    assert.equal(exported.engine.phase, 'recovery'); assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, true);
    // A-05 (S5 / SR-06): the reject is a straight engine write, so it must re-state the
    // optional facts instead of dropping them. This assertion previously pinned the defect
    // (`lastPublishedCursor === undefined`, i.e. a rejected bootstrap Ack erased the cursor
    // the replica had already published); `lastPublishedCursor` is now inherited. The
    // stale-`expectedRevision` sibling of this case lives in
    // `tests/engine-transition-cas.test.ts` ("rejects a stale expected revision on the
    // bootstrap Ack reject…"), because this pre-existing 568-line suite has no granularity
    // baseline entry and the 600-line new-test limit left no room here.
    assert.equal(exported.engine.lastPublishedCursor, 'spc2.normal');
  });

  test('rejects an unnecessary active Session rebase without changing cursor, scope, or engine authority', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: 100, recoveryFrozen: false,
      authorityRefreshRequired: false, notBefore: 5_000, sessionId: 'session-active',
      lastPublishedCursor: 'cursor-0', lastAckedCursor: 'cursor-0' });
    const before = await store.exportScope(scope);
    await assert.rejects(() => store.rebaseActiveSessionAuthority(scope, {
      cursor: 'cursor-unrequested', serverRevision: 'revision-unrequested',
    }), /authority_rebase_not_required/);
    const after = await store.exportScope(scope);
    assert.deepEqual(after.scope, before.scope);
    assert.deepEqual(after.cursor, before.cursor);
    assert.deepEqual(after.engine, before.engine);
  });

  test('atomically adopts a reissued cursor when an expired lease resumes in the next generation', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: {
      leaseId: 'lease-generation-1', generation: '1', expiresAt: 100 },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old-generation' }, selectedRoots: [] });
    const queued = await store.allocateSequenceAndEnqueue(scope, operation('lease-rollover'), { allowUnstamped: true });
    await store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
      operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-lease-rollover',
      resultDigest: 'sha256:lease-rollover' });
    await store.publishCursor(scope, { cursor: 'cursor-old-generation', checkpoint: 'revision-old',
      evidence: { receiptId: 'receipt-lease-rollover', operationDigest: queued.digest } });
    await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: 100, recoveryFrozen: false,
      authorityRefreshRequired: false, notBefore: 5_000, sessionId: 'session-old-generation',
      lastPublishedCursor: 'cursor-old-generation', lastAckedCursor: 'cursor-old-generation',
      lastError: 'network_unavailable' });

    // Session renewal must not claim an unconsumed cursor as the local Ack.
    await store.registerScope({ ...scope, lifecycle: 'active', lease: {
      leaseId: 'lease-generation-1', generation: '1', expiresAt: 1_000 },
    checkpoint: { serverRevision: 'revision-advertised', cursor: 'cursor-advertised' }, selectedRoots: [] });
    assert.equal((await store.getScope(scope))?.checkpoint?.cursor, 'cursor-old-generation');
    assert.equal((await store.getCursor(scope))?.cursor, 'cursor-old-generation');

    await assert.rejects(() => store.registerScope({ ...scope, lifecycle: 'active', lease: {
      leaseId: 'lease-generation-2', generation: '2', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old-generation' }, selectedRoots: [] }),
    /lease_authority_invalid/);

    await store.registerScope({ ...scope, lifecycle: 'active', lease: {
      leaseId: 'lease-generation-2', generation: '2', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-new', cursor: 'cursor-new-generation' }, selectedRoots: [] });

    const exported = await store.exportScope(scope);
    assert.deepEqual(exported.scope?.checkpoint,
      { serverRevision: 'revision-new', cursor: 'cursor-new-generation' });
    assert.equal(exported.scope?.lease.generation, '2');
    assert.equal(exported.cursor?.cursor, 'cursor-new-generation');
    assert.equal(exported.engine.lastPublishedCursor, 'cursor-new-generation');
    assert.equal(exported.engine.lastAckedCursor, 'cursor-new-generation');
    assert.equal(exported.engine.lastError, undefined);
  });

  test.each(['spc2.activated-generation', 'spc2.completed-recovery'])(
    'atomically adopts the next generation after completed recovery Ack with cursor %s', async (activatedCursor) => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: {
      leaseId: 'recovery-lease-1', generation: '1', expiresAt: 100 },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' }, selectedRoots: [] });
    await store.putMapping(scope, { nativeId: 'native-root', colpId: 'old-root', rootNativeId: 'native-root',
      nodeKind: 'folder', projection: { revision: 'revision-old', digest: 'sha256:old-root' } });
    await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'native-root', ancestorNativeIds: [] }],
      selectedNativeIds: ['native-root'], privateNativeIds: [], status: 'ready' });
    const capability = 'src1.completed-recovery'; const snapshotId = 'completed-recovery-snapshot';
    const recoveredMapping = { nativeId: 'native-root', colpId: 'recovered-root', rootNativeId: 'native-root',
      nodeKind: 'folder' as const, projection: { revision: 'revision-recovered', digest: 'sha256:recovered-root' } };
    await store.stageRecoveryPage(scope, { snapshotId, sessionId: 'recovery-session',
      revision: 'revision-recovered', syncCursor: 'spc2.completed-recovery', capability,
      identityDigest: 'sha256:completed-recovery',
      rootNodeId: 'recovered-root', page: 0, pageDigest: 'sha256:completed-page', previousPageDigest: null,
      nextCursor: null, complete: true, nodes: [{ colpId: 'recovered-root', parentId: null, position: 'a',
        kind: 'Folder', payloadDigest: 'sha256:recovered-root', mapping: recoveredMapping }] });
    await store.finalizeRecoveryMappings(scope, snapshotId, [recoveredMapping]);
    const body = JSON.stringify({ sessionId: 'recovery-session', cursor: 'spc2.completed-recovery',
      recoveryCapability: capability, warnings: [] });
    await store.commitRecovery(scope, snapshotId, { intentId: 'completed-recovery-ack',
      sessionId: 'recovery-session', idempotencyKey: 'completed-recovery-ack', endpointIdentity: 'syncAck',
      mediaType: 'application/json', body, bodyDigest: createHash('sha256').update(body).digest('hex') });
    await store.transitionEngine(scope, { phase: 'bootstrap', updatedAt: 200, sessionId: 'recovery-session',
      recoveryFrozen: true, authorityRefreshRequired: true, notBefore: 0,
      lastPublishedCursor: 'spc2.completed-recovery', lastAckedCursor: 'spc2.completed-recovery' });

    const checkpoint = { cursor: activatedCursor, serverRevision: 'revision-recovered' };
    await assert.rejects(() => store.registerScope({ ...scope, lifecycle: 'active', lease: {
      leaseId: 'recovery-lease-2', generation: '2', expiresAt: 10_000 }, checkpoint, selectedRoots: [] }),
    /lease_authority_invalid/);
    await store.completeAckIntent(scope, 'completed-recovery-ack', { replicaId: scope.replicaId,
      ackedCursor: 'spc2.completed-recovery', ackedAt: '2026-07-30T00:00:00.000Z' });
    // An authority refresh between recovery Ack and activation must preserve
    // the exact completed Snapshot cursor/capability evidence.
    await store.registerScope({ ...scope, lifecycle: 'active', lease: {
      leaseId: 'recovery-lease-1', generation: '1', expiresAt: 1_000 },
    checkpoint: { cursor: 'spc2.unconsumed-advertisement', serverRevision: 'revision-advertised' }, selectedRoots: [] });
    assert.equal((await store.getScope(scope))?.checkpoint?.cursor, 'spc2.completed-recovery');
    await assert.rejects(() => store.registerScope({ ...scope, lifecycle: 'active', lease: {
      leaseId: 'recovery-lease-3', generation: '3', expiresAt: 10_000 }, checkpoint, selectedRoots: [] }),
    /lease_authority_invalid/);
    await store.registerScope({ ...scope, lifecycle: 'active', lease: {
      leaseId: 'recovery-lease-2', generation: '2', expiresAt: 10_000 }, checkpoint, selectedRoots: [] });
    await store.rebaseRecoveryCursor(scope, capability, checkpoint);

    const exported = await store.exportScope(scope);
    assert.equal(exported.scope?.lease.generation, '2');
    assert.deepEqual(exported.scope?.checkpoint, checkpoint);
    assert.equal(exported.cursor?.cursor, checkpoint.cursor);
    assert.equal(exported.engine.lastPublishedCursor, checkpoint.cursor);
    assert.equal(exported.engine.lastAckedCursor, checkpoint.cursor);
  });

  test('atomically rejects a bootstrap Ack issued by another Session without publishing recovery staging', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.putMapping(scope, { nativeId: 'native-root', colpId: 'old-root', rootNativeId: 'native-root',
      nodeKind: 'folder', projection: { revision: 'r1', digest: 'sha256:old-root' } });
    await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'native-root', ancestorNativeIds: [] }],
      selectedNativeIds: ['native-root'], privateNativeIds: [], status: 'ready' });
    await store.stageRecoveryPage(scope, { snapshotId: 'session-bound-snapshot', sessionId: 'session-issuing',
      revision: 'r2', syncCursor: 'src1.session-bound', capability: 'src1.session-bound',
      identityDigest: 'identity-session-bound', rootNodeId: 'root-r',
      page: 0, pageDigest: 'sha256:session-bound', previousPageDigest: null, nextCursor: null, complete: true,
      nodes: [{ colpId: 'root-r', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:root-r',
        mapping: { nativeId: 'native-root', colpId: 'root-r', rootNativeId: 'native-root', nodeKind: 'folder',
          projection: { revision: 'r2', digest: 'sha256:root-r' } } }] });
    const ackBody = JSON.stringify({ sessionId: 'session-other', cursor: 'src1.session-bound',
      recoveryCapability: 'src1.session-bound', warnings: [] });
    await assert.rejects(() => store.commitRecovery(scope, 'session-bound-snapshot', {
      intentId: 'bootstrap-session-bound', sessionId: 'session-other', idempotencyKey: 'bootstrap-session-bound',
      endpointIdentity: 'syncAck', mediaType: 'application/json', body: ackBody,
      bodyDigest: createHash('sha256').update(ackBody).digest('hex'),
    }), /snapshot_session_scope_mismatch/);
    const exported = await store.exportScope(scope);
    assert.equal(exported.scope?.checkpoint, null);
    assert.deepEqual(exported.mappings.map((item) => item.colpId), ['old-root']);
    assert.equal(exported.cursor, null); assert.equal(exported.ackIntents.length, 0);
    assert.equal(exported.recovery?.sessionId, 'session-issuing'); assert.equal(exported.recoveryNodes.length, 1);
  });

  test('discards only a pending pull Ack intent and frees the scope for a re-issued cursor intent', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-ack', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [] });
    const ackIntent = (sessionId: string, cursor: string) => {
      const body = JSON.stringify({ sessionId, cursor, warnings: [] });
      return { intentId: `ack-${cursor}`, kind: 'pull' as const, sessionId, cursor,
        idempotencyKey: `ack-${cursor}`, endpointIdentity: 'syncAck' as const,
        mediaType: 'application/json' as const, body,
        bodyDigest: createHash('sha256').update(body).digest('hex') };
    };
    await store.stagePullPage(scope, { pageId: 'page-1', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
      collectionRevision: 'revision-1', pageDigest: 'sha256:page-1', events: [] });
    await store.completePullPage(scope, 'page-1');
    const pending = await store.beginAckIntent(scope, ackIntent('session-a', 'cursor-1'));
    await assert.rejects(() => store.discardPullAckIntent(scope, 'missing-intent'), /pull_ack_discard_invalid/);
    await store.discardPullAckIntent(scope, pending.intentId);
    assert.equal(await store.getPendingAckIntent(scope), null);
    assert.equal((await store.listAckIntents(scope)).length, 0);
    assert.equal((await store.getCursor(scope))?.cursor, 'cursor-1');
    await store.stagePullPage(scope, { pageId: 'page-2', previousCursor: 'cursor-1', nextCursor: 'cursor-1-reissued',
      collectionRevision: 'revision-1', pageDigest: 'sha256:page-2', events: [] });
    await store.completePullPage(scope, 'page-2');
    const reissued = await store.beginAckIntent(scope, ackIntent('session-b', 'cursor-1-reissued'));
    await store.completeAckIntent(scope, reissued.intentId, { replicaId: scope.replicaId,
      ackedCursor: 'cursor-1-reissued', ackedAt: '2026-08-26T00:00:00.000Z' });
    await assert.rejects(() => store.discardPullAckIntent(scope, reissued.intentId), /pull_ack_discard_invalid/);
  });

  test('does not overwrite a later durable local projection during a repeated recovery cutover', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.putMapping(scope, { nativeId: 'native-root', colpId: 'root-r', rootNativeId: 'native-root',
      nodeKind: 'folder', projection: { revision: 'local-r3', digest: 'sha256:later-local' } });
    await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'native-root', ancestorNativeIds: [] }],
      selectedNativeIds: ['native-root'], privateNativeIds: [], status: 'ready' });
    await store.allocateSequenceAndEnqueue(scope, { ...operation('later-local'), operationRevision: 'local-r3',
      payload: { type: 'update_node_content', targetId: 'root-r' } }, { allowUnstamped: true });
    await store.stageRecoveryPage(scope, { snapshotId: 'retry-snapshot', revision: 'server-r2',
      syncCursor: 'src1.retry', capability: 'src1.retry', identityDigest: 'identity-retry', rootNodeId: 'root-r', page: 0,
      pageDigest: 'sha256:retry', previousPageDigest: null, nextCursor: null, complete: true,
      nodes: [{ colpId: 'root-r', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:server',
        mapping: { nativeId: 'native-root', colpId: 'root-r', rootNativeId: 'native-root', nodeKind: 'folder',
          projection: { revision: 'server-r2', digest: 'sha256:server' } } }] });
    await store.commitRecovery(scope, 'retry-snapshot');
    assert.equal((await store.getMappingByColpId(scope, 'root-r'))?.projection.revision, 'local-r3');
  });

  test('rebinds selected and private browser boundaries across recovery mapping replacement', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.putMapping(scope, { nativeId: 'native-selected', colpId: 'old-selected',
      rootNativeId: 'native-selected', nodeKind: 'folder',
      projection: { revision: 'r1', digest: 'sha256:old-selected' } });
    await store.putMapping(scope, { nativeId: 'native-private', colpId: 'old-private',
      rootNativeId: 'native-selected', nodeKind: 'folder', parentNativeId: 'native-selected',
      projection: { revision: 'r1', digest: 'sha256:old-private' } });
    const discovered = [{ nativeId: 'native-selected', ancestorNativeIds: [] },
      { nativeId: 'native-private', ancestorNativeIds: ['native-selected'] }];
    await store.configureBrowserRoots(scope, { discovered, selectedNativeIds: ['native-selected'],
      privateNativeIds: ['native-private'], status: 'ready' });
    await store.stageRecoveryPage(scope, { snapshotId: 'boundary-snapshot', revision: 'r2',
      syncCursor: 'src1.boundary', capability: 'src1.boundary', identityDigest: 'identity-boundary',
      rootNodeId: 'new-selected', page: 0,
      pageDigest: 'sha256:boundary', previousPageDigest: null, nextCursor: null, complete: true,
      nodes: [
        { colpId: 'new-selected', parentId: null, position: 'a', kind: 'Folder',
          payloadDigest: 'sha256:new-selected', mapping: { nativeId: 'native-selected', colpId: 'new-selected',
            rootNativeId: 'native-selected', nodeKind: 'folder',
            projection: { revision: 'r2', digest: 'sha256:new-selected' } } },
      ] });
    await store.commitRecovery(scope, 'boundary-snapshot');
    assert.deepEqual((await store.getScope(scope))?.selectedRoots, ['new-selected']);
    assert.deepEqual((await store.getScope(scope))?.privateRoots, ['old-private']);
    assert.equal((await store.getMappingByColpId(scope, 'old-private'))?.nativeId, 'native-private');
    assert.deepEqual(await store.reconcileBrowserRoots(scope, discovered), {
      selectedRoots: ['new-selected'], privateRoots: ['old-private'], rootStatus: 'ready',
    });
  });

  test('rolls back root authority atomically when configuration fails before commit', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    const before = await store.exportScope(scope);
    await assert.rejects(() => store.configureBrowserRoots(scope, {
      discovered: [{ nativeId: 'native-selected', ancestorNativeIds: [] }],
      selectedNativeIds: ['native-selected'], privateNativeIds: [], status: 'ready',
    }, { fault: 'after_mapping' }), /fault_injected/);
    const after = await store.exportScope(scope);
    assert.deepEqual(after.scope?.selectedRoots, before.scope?.selectedRoots);
    assert.deepEqual(after.mappings, before.mappings);
  });

  test('fails closed for future versions and corruption without deleting diagnostic data', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.injectCorruptionForTest('orphan_receipt', scope);
    await assert.rejects(() => store.auditIntegrity(), /corruption_detected/);
    assert.equal((await store.exportDiagnostics()).mode, 'diagnostic_read_only');
    store.close();
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION + 1);
    await new Promise<void>((resolve, reject) => { request.onupgradeneeded = () => undefined;
      request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error); });
    await assert.rejects(() => createSyncStateStore({ indexedDB }).open(), /future_schema/);
  });

  test('logout removes only active account authority and retirement remains read-only/exportable', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.registerScope({ ...other, lifecycle: 'active', lease: { leaseId: 'other', expiresAt: 100 },
      checkpoint: null, selectedRoots: [] });
    await store.allocateSequenceAndEnqueue(scope, operation(), { allowUnstamped: true });
    await store.retireScope(scope, { retiredAt: 200, reason: 'logout' });
    await store.cleanupAccount({ environment: scope.environment, serverId: scope.serverId,
      accountId: scope.accountId, browserProfileId: scope.browserProfileId });
    assert.equal((await store.getScope(other))?.accountId, other.accountId);
    const archive = await store.exportArchive(scope);
    assert.equal(archive.lifecycle, 'retired');
    await assert.rejects(() => store.allocateSequenceAndEnqueue(scope, operation('never'), { allowUnstamped: true }), /scope_not_found/);
    await assert.rejects(() => store.registerScope({ ...scope, lifecycle: 'active',
      lease: { leaseId: 'reused', expiresAt: 300 }, checkpoint: null, selectedRoots: [] }), /scope_retired/);
  });
});

async function active(store: ReturnType<typeof createSyncStateStore>) {
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 100 },
    checkpoint: null, selectedRoots: [] });
}
