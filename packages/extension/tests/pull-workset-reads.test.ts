import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { pendingLocalContentFields } from '../src/pull-queue-facts.js';
import { createPullApplier } from '../src/pull-applier.js';
import { ordinaryPullEventAllowed, readPullApplyAuthority } from '../src/pull-authority-apply.js';
import type { PullApplierOptions } from '../src/pull-applier-types.js';
import { requestValue, transactionDone } from '../src/sync-state/idb.js';
import {
  AUTHORITY_DIGEST, DATABASE_NAME, DATABASE_VERSION, INDEXES, STORES, upgrade,
} from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
/** The states `resumeApply` passes to `listPullEvents`. */
const RESUME_STATES = ['staged', 'intent_prepared', 'browser_call_started', 'native_event_observed',
  'authority_committed'] as const;

const stores: Array<ReturnType<typeof createSyncStateStore>> = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });

function observeReads() {
  const counts = {
    pullEventRows: 0, pullPagePointReads: 0, pullPageIndexRows: 0,
    pullEventStoreCursors: 0, pullPageStoreCursors: 0, queueRows: 0, bookmarkRows: 0,
    pullPageStoreRows: 0, intentStoreCursors: 0, diagnosticStoreCursors: 0,
    intentPointReads: 0, diagnosticPointReads: 0,
  };
  const indexCursor = IDBIndex.prototype.openCursor;
  const storeCursor = IDBObjectStore.prototype.openCursor;
  const get = IDBObjectStore.prototype.get;
  vi.spyOn(IDBIndex.prototype, 'openCursor').mockImplementation(function (this: IDBIndex, query, direction) {
    const request = indexCursor.call(this, query, direction);
    const storeName = this.objectStore.name;
    request.addEventListener('success', () => {
      if (!request.result) return;
      if (storeName === STORES.pullEvents) counts.pullEventRows += 1;
      if (storeName === STORES.pullPages) counts.pullPageIndexRows += 1;
      if (storeName === STORES.queue) counts.queueRows += 1;
      if (storeName === STORES.bookmarkEvents) counts.bookmarkRows += 1;
    });
    return request;
  });
  vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === STORES.pullEvents) counts.pullEventStoreCursors += 1;
    if (this.name === STORES.pullPages) counts.pullPageStoreCursors += 1;
    if (this.name === STORES.intents) counts.intentStoreCursors += 1;
    if (this.name === STORES.diagnostics) counts.diagnosticStoreCursors += 1;
    const request = storeCursor.apply(this, args);
    if (this.name === STORES.pullPages) request.addEventListener('success', () => {
      if (request.result) counts.pullPageStoreRows += 1;
    });
    return request;
  });
  vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
    const request = get.call(this, key);
    if (this.name === STORES.pullPages) {
      request.addEventListener('success', () => { if (request.result) counts.pullPagePointReads += 1; });
    }
    if (this.name === STORES.intents) counts.intentPointReads += 1;
    if (this.name === STORES.diagnostics) counts.diagnosticPointReads += 1;
    return request;
  });
  return counts;
}

async function activeStore() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  stores.push(store);
  await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-1', expiresAt: Date.parse('2099-01-01') },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
  return store;
}
function committedEvent(id: string, cursor: string, operationId = `op-${id}`) {
  return { eventId: id, cursor, operationId, effectId: `effect-${id}`, effectDigest: `sha256:${id}`,
    operationDigest: `sha256:${id}-op`, kind: 'node_content_updated', payload: {},
    initialState: 'authority_committed' as const };
}
async function completeHistory(store: ReturnType<typeof createSyncStateStore>, count: number) {
  for (let n = 1; n <= count; n += 1) {
    await store.stagePullPage(scope, {
      pageId: `hist-${String(n).padStart(4, '0')}`, previousCursor: `cursor-${n - 1}`, nextCursor: `cursor-${n}`,
      collectionRevision: `r-${n}`, pageDigest: `sha256:${n}`, effectPages: [],
      events: [committedEvent(`hist-event-${n}`, `cursor-${n}`)],
    });
    await store.completePullPage(scope, `hist-${String(n).padStart(4, '0')}`);
  }
}
async function stagePending(store: ReturnType<typeof createSyncStateStore>, history: number, pending: number) {
  await store.stagePullPage(scope, {
    pageId: 'pending-page', previousCursor: `cursor-${history}`, nextCursor: 'cursor-pending',
    collectionRevision: 'r-pending', pageDigest: 'sha256:pending', effectPages: [],
    events: Array.from({ length: pending }, (_, index) => ({
      eventId: `pending-${index}`, cursor: 'cursor-pending', operationId: `pending-op-${index}`,
      effectId: `pending-effect-${index}`, effectDigest: 'sha256:pending', operationDigest: 'sha256:pending-op',
      kind: 'node_content_updated', payload: {},
    })),
  });
}
function contentOp(opId: string, targetId: string, title: string) {
  return { opId, batchId: `batch-${opId}`, idempotencyKey: `key-${opId}`, digest: `sha256:${opId}`,
    endpointIdentity: 'syncPush' as const, mediaType: 'application/json' as const, baseRevision: 'revision-0',
    operationRevision: `local-${opId}`, status: 'pending' as const, retry: { attempt: 0, notBefore: 0 },
    payload: { type: 'update_node_content', targetId, payload: { base: { title: 'Original' }, value: { title } } } };
}
function ackIntent(cursor: string) {
  const body = JSON.stringify({ sessionId: 'session-a', cursor, warnings: [] });
  return { intentId: `ack-${cursor}`, kind: 'pull' as const, sessionId: 'session-a', cursor,
    idempotencyKey: `ack-${cursor}`, endpointIdentity: 'syncAck' as const, mediaType: 'application/json' as const,
    body, bodyDigest: createHash('sha256').update(body).digest('hex') };
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

function applyOptions(store: ReturnType<typeof createSyncStateStore>): PullApplierOptions {
  const unexpected = async (): Promise<never> => { throw new Error('unexpected native call'); };
  return { store, scope,
    session: { sessionId: 'session-a', collectionId: scope.collectionId, acceptedProtocolVersion: '0.2',
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/{pageNumber}', effectPageAuthority: 'https://known.example',
    api: { get: unexpected, getChildren: unexpected, create: unexpected, update: unexpected,
      move: unexpected, remove: unexpected, removeTree: unexpected },
  };
}

test('full resume reads no completed history when the pending set is empty', async () => {
  for (const historyPages of [40, 120]) {
    const store = await activeStore();
    await completeHistory(store, historyPages);
    const counts = observeReads();
    await createPullApplier(applyOptions(store)).resume();
    vi.restoreAllMocks();
    assert.equal(counts.pullPageStoreRows, 0);
    assert.equal(counts.pullPageStoreCursors, 0);
    assert.equal(counts.pullPageIndexRows, 0);
    assert.equal(counts.pullEventRows, 0);
    assert.equal(counts.intentStoreCursors, 0);
    assert.equal(counts.diagnosticStoreCursors, 0);
    assert.equal(counts.intentPointReads, 0);
    assert.equal(counts.diagnosticPointReads, 0);
    console.log(JSON.stringify({ case: 'full-resume-empty-workset', historyPages, ...counts }));
  }
});

test('authority reads only unfinished page facts and finds their stamps beyond diagnostic export limits', async () => {
  const store = await activeStore();
  await completeHistory(store, 40);
  await stagePending(store, 40, 1);
  await store.preparePullIntent(scope, 'pending-0', {
    intentId: 'intent:pending-0', correlationId: 'correlation-pending-0', operationId: 'pending-op-0',
    eventId: 'pending-0', effectId: 'pending-effect-0', state: 'intent_prepared',
    expected: { kind: 'change', nativeId: 'native-1' }, expiresAt: Date.now() + 60_000, generation: scope.generation,
  });
  const prior = await store.getApplyIntent(scope, 'intent:pending-0');
  assert.ok(prior);
  const db = await store.open();
  const tx = db.transaction([STORES.diagnostics, STORES.intents], 'readwrite');
  const done = transactionDone(tx);
  for (let index = 0; index < 1_100; index++) {
    tx.objectStore(STORES.diagnostics).put({ id: `a-old-${index}`, scopeKey: scopeKey(scope), kind: 'history' });
    tx.objectStore(STORES.intents).put({ ...prior, intentId: `old-${index}`, correlationId: `old-correlation-${index}`,
      eventId: `old-event-${index}`, state: 'page_complete' });
  }
  await done;
  await store.putScopeDiagnostic(scope, { kind: 'pull_page_authority', code: 'pending-page',
    details: { pageId: 'pending-page', authorityGeneration: scope.generation + 1 } });
  const counts = observeReads();
  const authority = await readPullApplyAuthority(applyOptions(store));
  vi.restoreAllMocks();
  assert.deepEqual(authority.pages.map(page => page.pageId), ['pending-page']);
  assert.deepEqual([...authority.intents.keys()], ['intent:pending-0']);
  assert.equal(authority.attached.size, 0, 'a mismatched generation must not attach even beyond the first 1000 diagnostics');
  assert.equal(ordinaryPullEventAllowed(authority, { pageId: 'pending-page', intentId: 'intent:pending-0' }), false);
  assert.equal(counts.pullPageStoreCursors, 0);
  assert.equal(counts.intentStoreCursors, 0);
  assert.equal(counts.diagnosticStoreCursors, 0);
  assert.equal(counts.pullPageIndexRows, 1);
  assert.equal(counts.pullEventRows, 1);
  assert.equal(counts.intentPointReads, 1);
  assert.equal(counts.diagnosticPointReads, 1);
});

test('resume reads stay on the pending set as completed history grows', async () => {
  const evidence = [];
  for (const [historyEvents, pendingEvents] of [[40, 3], [120, 3], [120, 7]] as const) {
    const store = await activeStore();
    await completeHistory(store, historyEvents);
    await stagePending(store, historyEvents, pendingEvents);
    const counts = observeReads();
    const events = await store.listPullEvents(scope, RESUME_STATES);
    const staged = await store.listPullPages(scope, ['staged']);
    vi.restoreAllMocks();
    assert.deepEqual(events.map((event) => event.eventId),
      Array.from({ length: pendingEvents }, (_, index) => `pending-${index}`));
    assert.deepEqual(staged.map((page) => page.pageId), ['pending-page']);
    const measured = { historyEvents, pendingEvents, ...counts };
    evidence.push(measured);
    assert.equal(counts.pullEventRows, pendingEvents);
    assert.equal(counts.pullPagePointReads, 1);
    assert.equal(counts.pullPageIndexRows, 1);
    assert.equal(counts.pullEventStoreCursors, 0);
    assert.equal(counts.pullPageStoreCursors, 0);
    assert.ok(counts.pullEventRows < historyEvents);
  }
  assert.equal(evidence[1]!.pullEventRows, evidence[0]!.pullEventRows);
  assert.ok(evidence[1]!.historyEvents > evidence[0]!.historyEvents);
  assert.ok(evidence[2]!.pullEventRows > evidence[1]!.pullEventRows);
  console.log(JSON.stringify({ case: 'u18-resume-reads', evidence }));
});

test('confirmation probe stops at the first awaiting row and does not read completed history', async () => {
  const store = await activeStore();
  await completeHistory(store, 80);
  const empty = observeReads();
  assert.equal(await store.hasPullEventsAwaitingConfirmation(scope), false);
  const emptyRows = empty.pullEventRows;
  vi.restoreAllMocks();
  await store.stagePullPage(scope, {
    pageId: 'wait-page', previousCursor: 'cursor-80', nextCursor: 'cursor-wait',
    collectionRevision: 'r-wait', pageDigest: 'sha256:wait', effectPages: [],
    events: [0, 1, 2, 3].map((index) => ({
      eventId: `wait-${index}`, cursor: 'cursor-wait', operationId: `wait-op-${index}`,
      effectId: `wait-effect-${index}`, effectDigest: 'sha256:wait', operationDigest: 'sha256:wait-op',
      kind: 'node_content_updated', payload: {},
    })),
  });
  for (const index of [0, 1, 2, 3]) {
    await store.preparePullIntent(scope, `wait-${index}`, {
      intentId: `intent:wait-${index}`, correlationId: `correlation-wait-${index}`, operationId: `wait-op-${index}`,
      eventId: `wait-${index}`, effectId: `wait-effect-${index}`, state: 'intent_prepared',
      expected: { kind: 'change', nativeId: 'native-1' }, expiresAt: Date.now() + 60_000,
      apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null,
    });
    await store.persistApplyIntentFacts(scope, `intent:wait-${index}`, { eventState: 'awaiting_confirmation' });
  }
  const probe = observeReads();
  assert.equal(await store.hasPullEventsAwaitingConfirmation(scope), true);
  vi.restoreAllMocks();
  assert.equal(emptyRows, 0);
  assert.equal(empty.pullEventStoreCursors, 0);
  assert.equal(probe.pullEventRows, 1);
  assert.equal(probe.pullEventStoreCursors, 0);
  console.log(JSON.stringify({ case: 'u18-confirmation-probe', historyEvents: 80, awaitingEvents: 4,
    emptyRows, matchingRows: probe.pullEventRows }));
});

test('cross-page order follows the cursor chain, not pageId or eventId', async () => {
  const store = await activeStore();
  await store.stagePullPage(scope, {
    pageId: 'page-b', previousCursor: 'cursor-0', nextCursor: 'cursor-b',
    collectionRevision: 'r-b', pageDigest: 'sha256:b', effectPages: [],
    events: [
      committedEvent('e-b', 'cursor-b', 'op-b'),
      { ...committedEvent('e-a', 'cursor-b', 'op-a') },
    ],
  });
  await store.completePullPage(scope, 'page-b');
  await store.stagePullPage(scope, {
    pageId: 'page-a', previousCursor: 'cursor-b', nextCursor: 'cursor-a',
    collectionRevision: 'r-a', pageDigest: 'sha256:a', effectPages: [],
    events: [committedEvent('e-page-a', 'cursor-a', 'op-page-a')],
  });
  assert.deepEqual((await store.listPullEvents(scope)).map((event) => event.eventId), ['e-b', 'e-a', 'e-page-a']);
});

test('event and byte budgets drop completed pages and keep unconfirmed, unknown, and pending ack evidence', async () => {
  const budget = await activeStore();
  for (const id of ['page-1', 'page-2', 'page-3', 'page-4']) {
    const previous = id === 'page-1' ? 'cursor-0' : `cursor-${Number(id.at(-1)) - 1}`;
    await budget.stagePullPage(scope, {
      pageId: id, previousCursor: previous, nextCursor: `cursor-${id.at(-1)}`,
      collectionRevision: id, pageDigest: `sha256:${id}`, effectPages: [],
      events: [committedEvent(id, `cursor-${id.at(-1)}`)],
    });
    await budget.completePullPage(scope, id);
    await pause();
  }
  assert.equal(await budget.prunePullHistory(scope, 10, { maxEvents: 2 }), 2);
  assert.deepEqual((await budget.listPullPages(scope, ['page_complete'])).map((page) => page.pageId).sort(),
    ['page-3', 'page-4']);

  const bytes = await activeStore();
  for (const id of ['old', 'mid', 'new']) {
    const previous = id === 'old' ? 'cursor-0' : id === 'mid' ? 'cursor-old' : 'cursor-mid';
    const next = `cursor-${id}`;
    await bytes.stagePullPage(scope, {
      pageId: id, previousCursor: previous, nextCursor: next, collectionRevision: id, pageDigest: `sha256:${id}`,
      effectPages: [], events: [committedEvent(id, next)],
    });
    await bytes.completePullPage(scope, id);
    await pause();
  }
  assert.equal(await bytes.prunePullHistory(scope, 10, { maxBytes: 1 }), 2);
  assert.deepEqual((await bytes.listPullPages(scope, ['page_complete'])).map((page) => page.pageId), ['new']);

  const live = await activeStore();
  await completeHistory(live, 3);
  await live.stagePullPage(scope, {
    pageId: 'live-call', previousCursor: 'cursor-3', nextCursor: 'cursor-live',
    collectionRevision: 'r-live', pageDigest: 'sha256:live', effectPages: [],
    events: [{ eventId: 'live-event', cursor: 'cursor-live', operationId: 'live-op', effectId: 'live-effect',
      effectDigest: 'sha256:live', operationDigest: 'sha256:live-op', kind: 'node_content_updated', payload: {} }],
  });
  await live.preparePullIntent(scope, 'live-event', {
    intentId: 'intent:live-event', correlationId: 'correlation-live', operationId: 'live-op', eventId: 'live-event',
    effectId: 'live-effect', state: 'intent_prepared', expected: { kind: 'change', nativeId: 'native-1' },
    expiresAt: Date.now() + 60_000, apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null,
  });
  await live.markPullBrowserCallStarted(scope, 'live-event');
  await live.prunePullHistory(scope, 1, { maxEvents: 1, maxBytes: 1 });
  assert.equal((await live.getPullEvent(scope, 'live-event'))?.state, 'browser_call_started');
  assert.ok((await live.listPullPages(scope)).some((page) => page.pageId === 'live-call'));

  const unknown = await activeStore();
  await unknown.stagePullPage(scope, {
    pageId: 'drop', previousCursor: 'cursor-0', nextCursor: 'cursor-drop', collectionRevision: 'r-drop',
    pageDigest: 'sha256:drop', effectPages: [], events: [committedEvent('drop-event', 'cursor-drop')],
  });
  await unknown.completePullPage(scope, 'drop');
  await pause();
  await unknown.stagePullPage(scope, {
    pageId: 'unknown', previousCursor: 'cursor-drop', nextCursor: 'cursor-unknown', collectionRevision: 'r-unknown',
    pageDigest: 'sha256:unknown', effectPages: [],
    events: [{ eventId: 'unknown-event', cursor: 'cursor-unknown', operationId: 'unknown-op', effectId: 'unknown-effect',
      effectDigest: 'sha256:unknown', operationDigest: 'sha256:unknown-op', kind: 'node_content_updated', payload: {} }],
  });
  await unknown.preparePullIntent(scope, 'unknown-event', {
    intentId: 'intent:unknown-event', correlationId: 'correlation-unknown', operationId: 'unknown-op',
    eventId: 'unknown-event', effectId: 'unknown-effect', state: 'intent_prepared',
    expected: { kind: 'change', nativeId: 'native-1' }, expiresAt: Date.now() + 60_000,
    apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null,
  });
  await unknown.commitPullEvent(scope, 'unknown-event', {});
  await unknown.completePullPage(scope, 'unknown');
  await unknown.persistApplyIntentFacts(scope, 'intent:unknown-event', {
    nativeResult: 'result_unknown', replayState: 'unknown',
  });
  await pause();
  await unknown.stagePullPage(scope, {
    pageId: 'newest', previousCursor: 'cursor-unknown', nextCursor: 'cursor-newest', collectionRevision: 'r-newest',
    pageDigest: 'sha256:newest', effectPages: [], events: [committedEvent('newest-event', 'cursor-newest')],
  });
  await unknown.completePullPage(scope, 'newest');
  await unknown.prunePullHistory(scope, 1, { maxEvents: 1, maxBytes: 1 });
  assert.equal(await unknown.getPullEvent(scope, 'drop-event'), null);
  assert.equal((await unknown.getPullEvent(scope, 'unknown-event'))?.state, 'page_complete');
  assert.equal((await unknown.findApplyIntent(scope, 'correlation-unknown'))?.nativeResult, 'result_unknown');

  const acked = await activeStore();
  await acked.stagePullPage(scope, {
    pageId: 'ack-old', previousCursor: 'cursor-0', nextCursor: 'cursor-ack-old', collectionRevision: 'r-ack-old',
    pageDigest: 'sha256:ack-old', effectPages: [], events: [committedEvent('ack-old-event', 'cursor-ack-old')],
  });
  await acked.completePullPage(scope, 'ack-old');
  await pause();
  await acked.stagePullPage(scope, {
    pageId: 'ack-page', previousCursor: 'cursor-ack-old', nextCursor: 'cursor-ack', collectionRevision: 'r-ack',
    pageDigest: 'sha256:ack', effectPages: [], events: [committedEvent('ack-event', 'cursor-ack')],
  });
  await acked.completePullPage(scope, 'ack-page');
  await acked.beginAckIntent(scope, ackIntent('cursor-ack'));
  await pause();
  await acked.stagePullPage(scope, {
    pageId: 'ack-new', previousCursor: 'cursor-ack', nextCursor: 'cursor-ack-new', collectionRevision: 'r-ack-new',
    pageDigest: 'sha256:ack-new', effectPages: [], events: [committedEvent('ack-new-event', 'cursor-ack-new')],
  });
  await acked.completePullPage(scope, 'ack-new');
  await acked.prunePullHistory(scope, 1, { maxEvents: 1, maxBytes: 1 });
  assert.equal(await acked.getPullEvent(scope, 'ack-old-event'), null);
  assert.ok(await acked.getPullEvent(scope, 'ack-event'));
  assert.equal((await acked.listAckIntents(scope)).filter((intent) => intent.state === 'pending').length, 1);
});

test('local overlay reads the target queue and native inbox, not retained pull history', async () => {
  const store = await activeStore();
  await completeHistory(store, 40);
  const echoed = await store.allocateSequenceAndEnqueue(scope, contentOp('echo-op', 'node-1', 'Echo title'),
    { allowUnstamped: true });
  await store.completeQueueWithReceipt(scope, echoed.sequence, { opId: echoed.opId, operationDigest: echoed.digest,
    kind: 'terminal', receiptId: 'receipt-echo', resultDigest: 'sha256:echo' });
  await store.stagePullPage(scope, {
    pageId: 'echo-page', previousCursor: 'cursor-40', nextCursor: 'cursor-echo', collectionRevision: 'r-echo',
    pageDigest: 'sha256:echo', effectPages: [], events: [committedEvent('echo-event', 'cursor-echo', echoed.opId)],
  });
  await store.completePullPage(scope, 'echo-page');
  await store.allocateSequenceAndEnqueue(scope, contentOp('local-op', 'node-1', 'Local title'), { allowUnstamped: true });
  for (let index = 0; index < 25; index += 1) {
    await store.allocateSequenceAndEnqueue(scope, contentOp(`other-op-${index}`, 'node-other', 'Other title'),
      { allowUnstamped: true });
    await store.stageBookmarkEvent(scope, {
      eventId: `other-draft-${index}`, dedupeKey: `other-draft-${index}`, kind: 'change', nativeId: `other-${index}`,
      occurredAt: '2026-10-03T00:00:00.000Z', details: { draft: { type: 'update_node_content', targetId: 'node-other',
        payload: { base: { title: 'Original' }, value: { title: 'Other draft' } } } },
    });
  }
  await store.stageBookmarkEvent(scope, {
    eventId: 'local-draft', dedupeKey: 'local-draft', kind: 'change', nativeId: 'native-1',
    occurredAt: '2026-10-03T00:00:00.000Z', details: { draft: { type: 'update_node_content', targetId: 'node-1',
      payload: { base: { url: 'https://old.example' }, value: { url: 'https://local.example' } } } },
  });
  const counts = observeReads();
  const fields = await pendingLocalContentFields(store, scope, { colpId: 'node-1', nativeId: 'native-1' });
  vi.restoreAllMocks();
  assert.deepEqual(fields, { title: 'Local title', url: 'https://local.example' });
  assert.equal(counts.queueRows, 2);
  assert.equal(counts.bookmarkRows, 1);
  assert.equal(counts.pullEventRows, 0);
  assert.equal(counts.pullEventStoreCursors, 0);
  console.log(JSON.stringify({ case: 'u18-local-overlay-reads', historyEvents: 40, otherQueueRows: 25,
    otherInboxRows: 25, ...counts }));
});

test('v19 upgrade adds the workset indexes without rewriting pull rows, and versionchange is not blocked', async () => {
  const indexedDB = new IDBFactory();
  const key = scopeKey(scope);
  const page = { scopeKey: key, pageId: 'kept', state: 'page_complete', previousCursor: 'c0', nextCursor: 'c1',
    collectionRevision: 'r1', pageDigest: 'sha256:kept', eventCount: 1, completedAt: 5 };
  const event = { scopeKey: key, eventId: 'kept-event', pageId: 'kept', ordinal: 0, state: 'page_complete',
    operationId: 'kept-op', cursor: 'c1', effectId: 'effect', effectDigest: 'd', operationDigest: 'o',
    kind: 'node_content_updated', payload: {} };
  const opened = indexedDB.open(DATABASE_NAME, 19);
  opened.onupgradeneeded = () => {
    const tx = opened.transaction!;
    upgrade(opened.result, tx, 0, 256 * 1024);
    const pages = tx.objectStore(STORES.pullPages);
    const events = tx.objectStore(STORES.pullEvents);
    if (pages.indexNames.contains(INDEXES.pullPageByState)) pages.deleteIndex(INDEXES.pullPageByState);
    if (events.indexNames.contains(INDEXES.pullEventByOperation)) events.deleteIndex(INDEXES.pullEventByOperation);
    pages.add(page); events.add(event);
    tx.objectStore(STORES.metadata).put({ key: 'schema', version: 19, authorityDigest: 'bsr-v19-bookmark-operation-index-v1' });
  };
  const prior = await new Promise<IDBDatabase>((resolve, reject) => {
    opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error);
  });
  assert.equal(prior.version, 19);
  prior.close();
  const store = createSyncStateStore({ indexedDB });
  stores.push(store);
  const db = await store.open();
  assert.equal(db.version, DATABASE_VERSION);
  const storedPage = await requestValue(db.transaction(STORES.pullPages).objectStore(STORES.pullPages).get([key, 'kept']));
  const storedEvent = await requestValue(db.transaction(STORES.pullEvents).objectStore(STORES.pullEvents).get([key, 'kept-event']));
  assert.deepEqual(storedPage, page);
  assert.deepEqual(storedEvent, event);
  const byState = await requestValue(db.transaction(STORES.pullPages).objectStore(STORES.pullPages)
    .index(INDEXES.pullPageByState).get([key, 'page_complete', 'kept']));
  const byOperation = await requestValue(db.transaction(STORES.pullEvents).objectStore(STORES.pullEvents)
    .index(INDEXES.pullEventByOperation).get([key, 'kept-op']));
  assert.equal((byState as { pageId: string }).pageId, 'kept');
  assert.equal((byOperation as { eventId: string }).eventId, 'kept-event');
  assert.deepEqual(await requestValue(db.transaction(STORES.metadata).objectStore(STORES.metadata).get('schema')),
    { key: 'schema', version: DATABASE_VERSION, authorityDigest: AUTHORITY_DIGEST });
  const next = indexedDB.open(DATABASE_NAME, DATABASE_VERSION + 1);
  next.onupgradeneeded = () => undefined;
  const result = await Promise.race([
    new Promise((resolve, reject) => {
      next.onsuccess = () => { next.result.close(); resolve('opened'); };
      next.onerror = () => reject(next.error);
    }),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 1_000)),
  ]);
  assert.equal(result, 'opened');
});
