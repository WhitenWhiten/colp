import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { ISSUE_DEPENDENCY_STORES, transactionIssueDependencies } from '../src/sync-state/issue-dependencies.js';
import { INDEXES, STORES } from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { createSyncStateStore, type JsonObject, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
const other = { ...scope, accountId: 'account-b' } as SyncScope;
const WATCHED = new Set<string>([STORES.mappings, STORES.diagnostics, STORES.intents, STORES.pullEvents,
  STORES.bookmarkEvents, STORES.pullPages, STORES.remoteDeleteDecisions]);

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });
afterEach(() => { vi.restoreAllMocks(); });

function record(bucket: Record<string, number>, name: string) { bucket[name] = (bucket[name] ?? 0) + 1; }

/** Reads are counted by store/index and the range they used; whole-store reads are rejected. */
function installReadObserver() {
  const empty = () => ({
    storeGetAll: {} as Record<string, number>, indexGetAll: {} as Record<string, number>,
    storeGet: {} as Record<string, number>, indexGet: {} as Record<string, number>,
    storeCursor: {} as Record<string, number>, indexCursor: {} as Record<string, number>,
    rows: {} as Record<string, number>, unranged: [] as string[],
  });
  let counts = empty();
  const storeGetAll = IDBObjectStore.prototype.getAll;
  const indexGetAll = IDBIndex.prototype.getAll;
  const storeGet = IDBObjectStore.prototype.get;
  const indexGet = IDBIndex.prototype.get;
  const storeCursor = IDBObjectStore.prototype.openCursor;
  const indexCursor = IDBIndex.prototype.openCursor;
  vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
    record(counts.storeGetAll, this.name);
    if (WATCHED.has(this.name)) throw new Error(`whole_store_read:${this.name}`);
    return storeGetAll.apply(this, args);
  });
  vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
    record(counts.indexGetAll, this.objectStore.name);
    if (WATCHED.has(this.objectStore.name)) throw new Error(`whole_index_read:${this.objectStore.name}`);
    return indexGetAll.apply(this, args);
  });
  vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
    record(counts.storeGet, this.name);
    const request = storeGet.apply(this, args);
    request.addEventListener('success', () => { if (request.result !== undefined) record(counts.rows, this.name); });
    return request;
  });
  vi.spyOn(IDBIndex.prototype, 'get').mockImplementation(function (this: IDBIndex, ...args) {
    record(counts.indexGet, `${this.objectStore.name}:${this.name}`);
    const request = indexGet.apply(this, args);
    request.addEventListener('success', () => { if (request.result !== undefined) record(counts.rows, this.objectStore.name); });
    return request;
  });
  vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args) {
    record(counts.storeCursor, this.name);
    if (WATCHED.has(this.name)) counts.unranged.push(`store:${this.name}:${String(args[0] === null || args[0] === undefined)}`);
    const request = storeCursor.apply(this, args);
    request.addEventListener('success', () => { if (request.result) record(counts.rows, this.name); });
    return request;
  });
  vi.spyOn(IDBIndex.prototype, 'openCursor').mockImplementation(function (this: IDBIndex, ...args) {
    record(counts.indexCursor, `${this.objectStore.name}:${this.name}`);
    if (WATCHED.has(this.objectStore.name)) {
      if (args[0] === null || args[0] === undefined) throw new Error(`unranged_index_cursor:${this.objectStore.name}`);
      counts.unranged.push(`index:${this.objectStore.name}:ok`);
    }
    const request = indexCursor.apply(this, args);
    request.addEventListener('success', () => { if (request.result) record(counts.rows, this.objectStore.name); });
    return request;
  });
  return {
    reset() { counts = empty(); },
    snapshot() { return { ...counts, rows: { ...counts.rows }, indexGet: { ...counts.indexGet },
      storeGet: { ...counts.storeGet }, storeCursor: { ...counts.storeCursor } }; },
  };
}

function mapping(index: number, scopeKeyValue: string) {
  return { scopeKey: scopeKeyValue, nativeId: `native-${index}`, colpId: `colp-${index}`,
    rootNativeId: 'native-root', projection: { revision: `r-${index}`, digest: `sha256:${index}` } };
}
function event(index: number, scopeKeyValue: string, status = 'processed', overrides: Record<string, unknown> = {}) {
  return { scopeKey: scopeKeyValue, eventId: `event-${index}`, dedupeKey: `dedupe-${index}`,
    occurredAt: '2026-10-01T00:00:00.000Z', kind: 'change', nativeId: `native-${index}`,
    details: { payload: { title: 'history' } }, ordinal: index, status, opId: status === 'processed' ? `op-${index}` : null,
    ...overrides };
}
function write(store: ReturnType<typeof createSyncStateStore>, rows: (db: IDBDatabase, key: string) => void,
  names: readonly string[]) {
  return store.open().then((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...names], 'readwrite');
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error as Error); tx.onabort = () => reject(tx.error as Error);
    rows(db, '');
  }));
}

async function seed(store: ReturnType<typeof createSyncStateStore>, key: string, key2: string, history: number) {
  const db = await store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORES.scopes, STORES.mappings, STORES.diagnostics, STORES.intents,
      STORES.pullEvents, STORES.bookmarkEvents, STORES.pullPages, STORES.remoteDeleteDecisions], 'readwrite');
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error as Error); tx.onabort = () => reject(tx.error as Error);
    const mappings = tx.objectStore(STORES.mappings);
    mappings.put({ scopeKey: key, nativeId: 'native-root', colpId: 'root-r', rootNativeId: 'native-root',
      projection: { revision: 'root-r', digest: 'sha256:root-r' } });
    mappings.put({ scopeKey: key, nativeId: 'native-parent', colpId: 'parent-r', parentNativeId: 'native-root',
      rootNativeId: 'native-root', projection: { revision: 'parent-r', digest: 'sha256:parent-r' } });
    mappings.put({ scopeKey: key, nativeId: 'native-child', colpId: 'child-r', parentNativeId: 'native-parent',
      rootNativeId: 'native-root', projection: { revision: 'child-r', digest: 'sha256:child-r' } });
    mappings.put({ scopeKey: key, nativeId: 'native-blocked', colpId: 'blocked-colp', rootNativeId: 'native-root',
      projection: { revision: 'blocked-r', digest: 'sha256:blocked-r' } });
    mappings.put({ scopeKey: key, nativeId: 'native-local', colpId: 'local-r', rootNativeId: 'native-root',
      projection: { revision: 'local-r', digest: 'sha256:local-r' } });
    mappings.put({ scopeKey: key, nativeId: 'native-context', colpId: 'context-parent', rootNativeId: 'native-root',
      projection: { revision: 'context-r', digest: 'sha256:context-r' } });
    for (let index = 0; index < history; index += 1) {
      mappings.put(mapping(index, key));
      mappings.put(mapping(index, key2));
    }
    const diagnostics = tx.objectStore(STORES.diagnostics);
    diagnostics.put({ id: `pull-issue:${key}:child-r`, scopeKey: key, kind: 'pull_issue', nodeId: 'child-r',
      code: 'remote_node_missing', eventId: 'evt-pull' });
    diagnostics.put({ id: `local-issue:${key}:permission_required:native-local`, scopeKey: key, kind: 'local_issue',
      nativeId: 'native-local', code: 'permission_required' });
    diagnostics.put({ id: `ingress:${key}:park:evt-parked`, scopeKey: key, kind: 'ingress', code: 'park:evt-parked',
      park: { eventId: 'evt-parked', state: 'open', code: 'dependency_pending', attempts: 1,
        at: '2026-10-01T00:00:00.000Z', dependencyOpId: 'op-blocker', dependencyEventId: 'evt-pre' }, parked: 'marker' });
    diagnostics.put({ id: `ingress:${key}:park:evt-automatic`, scopeKey: key, kind: 'ingress',
      code: 'park:evt-automatic',
      park: { eventId: 'evt-automatic', state: 'parked', code: 'permission_required', attempts: 1,
        at: '2026-10-01T00:00:00.000Z' }, parked: 'marker' });
    diagnostics.put({ id: `pull-issue:${key2}:child-r`, scopeKey: key2, kind: 'pull_issue', nodeId: 'other-scope-root' });
    for (let index = 0; index < history; index += 1) {
      diagnostics.put({ id: `pull-terminal:${key}:op-${index}`, scopeKey: key, kind: 'pull_terminal_fact', opId: `op-${index}` });
      diagnostics.put({ id: `pull-terminal:${key2}:op-${index}`, scopeKey: key2, kind: 'pull_terminal_fact', opId: `op-${index}` });
    }
    const events = tx.objectStore(STORES.bookmarkEvents);
    events.put({ scopeKey: key, eventId: 'evt-parked', dedupeKey: 'd-parked', occurredAt: '2026-10-01T00:00:00.000Z',
      kind: 'change', nativeId: 'native-parked', details: { title: 'Parked' }, ordinal: 900_000, status: 'pending', opId: null });
    events.put({ scopeKey: key, eventId: 'evt-automatic', dedupeKey: 'd-automatic', occurredAt: '2026-10-01T00:00:00.000Z',
      kind: 'change', nativeId: 'native-local', details: { title: 'Automatic' }, ordinal: 900_001, status: 'pending', opId: null });
    events.put({ scopeKey: key, eventId: 'evt-pre', dedupeKey: 'd-pre', occurredAt: '2026-10-01T00:00:00.000Z',
      kind: 'change', nativeId: 'native-parked', details: {}, ordinal: 900_002, status: 'processed', opId: 'op-pre' });
    events.put({ scopeKey: key, eventId: 'evt-context', dedupeKey: 'd-context', occurredAt: '2026-10-01T00:00:00.000Z',
      kind: 'move', nativeId: 'native-child', details: { context: { sourceParentNativeId: 'native-context',
        targetParentNativeId: 'native-parent' } }, ordinal: 900_003, status: 'processed', opId: 'op-history-context' });
    for (let index = 0; index < history; index += 1) {
      events.put(event(index, key));
      events.put(event(index, key2));
    }
    const intents = tx.objectStore(STORES.intents);
    intents.put({ scopeKey: key, intentId: 'intent-open', correlationId: 'corr-open', operationId: 'op-open',
      expected: { kind: 'change', nativeId: 'native-child' }, expiresAt: 1_000, nativeResult: 'result_unknown',
      eventId: 'evt-await', colpId: 'child-r', nativeTargetId: 'native-child' });
    intents.put({ scopeKey: key, intentId: 'intent-stale', correlationId: 'corr-stale', operationId: 'op-stale',
      expected: { kind: 'change', nativeId: 'native-stale' }, expiresAt: 1_000, nativeResult: 'result_unknown',
      eventId: 'evt-staged', colpId: 'stale-colp' });
    for (let index = 0; index < history; index += 1) {
      intents.put({ scopeKey: key, intentId: `intent-${index}`, correlationId: `corr-${index}`,
        operationId: `op-intent-${index}`, expected: { kind: 'change', nativeId: `native-${index}` },
        expiresAt: 1_000, nativeResult: 'applied_with_evidence' });
    }
    const pullEvents = tx.objectStore(STORES.pullEvents);
    pullEvents.put({ scopeKey: key, eventId: 'evt-await', state: 'awaiting_confirmation', pageId: 'page-blocked',
      ordinal: 1, operationId: 'op-await', effectId: 'effect-await', effectDigest: 'sha256:await',
      operationDigest: 'sha256:await-op', kind: 'node_content_updated', cursor: 'cursor-1', payload: {} });
    pullEvents.put({ scopeKey: key, eventId: 'evt-staged', state: 'staged', pageId: 'page-staged',
      ordinal: 2, operationId: 'op-staged', effectId: 'effect-staged', effectDigest: 'sha256:staged',
      operationDigest: 'sha256:staged-op', kind: 'node_content_updated', cursor: 'cursor-1', payload: {} });
    pullEvents.put({ scopeKey: key, eventId: 'evt-blocked', state: 'blocked', pageId: 'page-blocked',
      ordinal: 3, operationId: 'op-blocked', effectId: 'effect-blocked', effectDigest: 'sha256:blocked',
      operationDigest: 'sha256:blocked-op', kind: 'node_created', cursor: 'cursor-2',
      payload: { effect: { node: { id: 'blocked-node' } } } });
    for (let index = 0; index < history; index += 1) {
      pullEvents.put({ scopeKey: key, eventId: `pull-event-${index}`, state: 'authority_committed',
        pageId: `page-${index}`, ordinal: index + 1, operationId: `pull-op-${index}`,
        effectId: `pull-effect-${index}`, effectDigest: `sha256:${index}`, operationDigest: `sha256:${index}`,
        kind: 'node_content_updated', cursor: `cursor-${index}`, payload: {} });
      pullEvents.put({ scopeKey: key2, eventId: `pull-event-${index}`, state: 'authority_committed',
        pageId: `page-${index}`, ordinal: index + 1, operationId: `pull-op-${index}`,
        effectId: `pull-effect-${index}`, effectDigest: `sha256:${index}`, operationDigest: `sha256:${index}`,
        kind: 'node_content_updated', cursor: `cursor-${index}`, payload: {} });
    }
    const pages = tx.objectStore(STORES.pullPages);
    pages.put({ scopeKey: key, pageId: 'page-blocked', previousCursor: 'cursor-1', nextCursor: 'cursor-2',
      collectionRevision: 'r', pageDigest: 'sha256:blocked-page', state: 'blocked' });
    for (let index = 0; index < history; index += 1) {
      pages.put({ scopeKey: key, pageId: `page-${index}`, previousCursor: `cursor-${index}`,
        nextCursor: `cursor-${index + 1}`, collectionRevision: `r-${index}`, pageDigest: `sha256:${index}`,
        state: 'page_complete' });
      pages.put({ scopeKey: key2, pageId: `page-${index}`, previousCursor: `cursor-${index}`,
        nextCursor: `cursor-${index + 1}`, collectionRevision: `r-${index}`, pageDigest: `sha256:${index}`,
        state: 'page_complete' });
    }
    const decisions = tx.objectStore(STORES.remoteDeleteDecisions);
    decisions.put({ scopeKey: key, decisionId: 'decision-open', eventId: 'evt-decision', pageId: 'page-decision',
      operationId: 'op-decision', effectId: 'effect-decision', effectDigest: 'sha256:decision',
      targetId: 'decision-target', deleteRevision: 'rev', generation: 1, nativeIds: ['native-decision'],
      nodeKind: 'bookmark', title: 'Decision', policy: 'sync', action: 'apply', state: 'pending',
      casVersion: 1, updatedAt: 1 });
    decisions.put({ scopeKey: key2, decisionId: 'decision-open-other', eventId: 'evt-decision-other',
      pageId: 'page-decision', operationId: 'op-decision-other', effectId: 'effect-decision-other',
      effectDigest: 'sha256:decision-other', targetId: 'other-scope-target', deleteRevision: 'rev', generation: 1,
      nativeIds: [], nodeKind: 'bookmark', title: 'Other', policy: 'sync', action: 'apply', state: 'pending',
      casVersion: 1, updatedAt: 1 });
    decisions.put({ scopeKey: key, decisionId: 'decision-applied', eventId: 'evt-decision-applied',
      pageId: 'page-decision', operationId: 'op-decision-applied', effectId: 'effect-decision-applied',
      effectDigest: 'sha256:decision-applied', targetId: 'applied-target', deleteRevision: 'rev', generation: 1,
      nativeIds: [], nodeKind: 'bookmark', title: 'Applied', policy: 'sync', action: 'apply', state: 'applied',
      casVersion: 1, updatedAt: 1 });
    for (let index = 0; index < history; index += 1) {
      decisions.put({ scopeKey: key, decisionId: `decision-${index}`, eventId: `evt-d-${index}`,
        pageId: 'page', operationId: `op-d-${index}`, effectId: `effect-d-${index}`,
        effectDigest: `sha256:d-${index}`, targetId: `target-${index}`, deleteRevision: 'rev', generation: 1,
        nativeIds: [], nodeKind: 'bookmark', title: 'History', policy: 'sync', action: 'apply',
        state: 'applied', casVersion: 1, updatedAt: 1 });
    }
  });
}

async function graphFor(history: number, observer: ReturnType<typeof installReadObserver>) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'rev', cursor: 'cursor' }, selectedRoots: [] });
  const recorded = (await store.getScope(scope))!; const key = recorded.scopeKey; const key2 = scopeKey(other);
  await seed(store, key, key2, history);
  const db = await store.open();
  observer.reset();
  const tx = db.transaction([...ISSUE_DEPENDENCY_STORES, STORES.queue], 'readonly');
  const graph = await transactionIssueDependencies(tx.objectStore(STORES.queue), key);
  const parents = {
    child: await graph.parents.parentOf('child-r'),
    missing: await graph.parents.parentOf('absent-r'),
  };
  const operationParents = await graph.operationParents.get('op-history-context');
  await transactionDone(tx);
  return { store, key, key2, graph, counts: observer.snapshot(), parents, operationParents };
}

import { transactionDone } from '../src/sync-state/idb.js';

test('dependency graph reads only real issues, holders and ancestor edges across large history', async () => {
  const observer = installReadObserver();
  const small = await graphFor(200, observer);
  const large = await graphFor(2_000, observer);
  try {
    for (const item of [small, large]) {
      assert.ok(item.graph.roots.has('child-r'), 'pull issue root');
      assert.ok(item.graph.roots.has('blocked-node'), 'blocked page node');
      assert.ok(item.graph.roots.has('decision-target'), 'open remote delete decision');
      assert.ok(item.graph.roots.has('local-r'), 'local issue native mapped through its mapping');
      assert.ok(item.graph.roots.has('child-r'), 'open native wait colp id');
      assert.ok(!item.graph.roots.has('stale-colp'), 'a closed native wait does not hold the lane');
      assert.ok(!item.graph.roots.has('other-scope-root'), 'cross-scope issue is excluded');
      assert.ok(!item.graph.roots.has('other-scope-target'), 'cross-scope decision is excluded');
      assert.deepEqual([...item.graph.decisions].map((row) => row.targetId), ['decision-target']);
      assert.deepEqual([...item.graph.prerequisiteOpIds].sort(), ['op-blocker', 'op-pre']);
      assert.deepEqual(item.parents, { child: { known: true, parent: 'parent-r' }, missing: { known: false, parent: null } });
      assert.deepEqual(item.operationParents, ['context-parent', 'parent-r']);
      assert.deepEqual(item.graph.independentRoots.has('decision-target'), false);
    }
    // History growth changes neither the request count nor the rows read.
    assert.deepEqual(large.counts.rows, small.counts.rows);
    assert.deepEqual(large.counts.indexGet, small.counts.indexGet);
    assert.deepEqual(large.counts.storeGet, small.counts.storeGet);
    assert.equal(small.counts.storeGetAll[STORES.mappings] ?? 0, 0);
    assert.equal(small.counts.storeGetAll[STORES.bookmarkEvents] ?? 0, 0);
    assert.equal(small.counts.storeCursor[STORES.bookmarkEvents] ?? 0, 0);
    assert.equal(small.counts.storeCursor[STORES.mappings] ?? 0, 0);
    assert.equal(small.counts.storeCursor[STORES.diagnostics] ?? 0, 0);
    assert.equal(small.counts.storeCursor[STORES.pullPages] ?? 0, 0);
    assert.equal(small.counts.storeCursor[STORES.remoteDeleteDecisions] ?? 0, 0);
    for (const name of WATCHED) assert.ok((small.counts.rows[name] ?? 0) <= 20, `${name} rows bounded`);
    console.log(JSON.stringify({ case: 'issue-dependency-reads', history: [200, 2_000],
      counts: small.counts.rows }));
  } finally { small.store.close(); large.store.close(); }
});

test('an enqueue in a scope with large unrelated history reads a fixed set of rows', async () => {
  const observer = installReadObserver();
  const results: Array<{ history: number; rows: Record<string, number>; reads: Record<string, number> }> = [];
  for (const history of [300, 3_000]) {
    const store = createSyncStateStore({ indexedDB: new IDBFactory() });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'rev', cursor: 'cursor' }, selectedRoots: [] });
    const key = (await store.getScope(scope))!.scopeKey;
    await seed(store, key, scopeKey(other), history);
    observer.reset();
    await store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-new', batchId: 'batch-new', idempotencyKey: 'key-new', digest: 'sha256:new',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'local-new', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { type: 'update_node_content', targetId: 'colp-unrelated', baseRevision: null,
        payload: { base: { title: 'Before' }, value: { title: 'After' } } } as unknown as JsonObject,
    }, { allowUnstamped: true });
    const counts = observer.snapshot();
    results.push({ history, rows: counts.rows, reads: counts.indexCursor });
    store.close();
  }
  console.log(JSON.stringify({ case: 'enqueue-issue-dependency-reads', evidence: results }));
  assert.deepEqual(results[1]!.rows, results[0]!.rows);
  // Only the two live park markers, one awaiting confirmation and one stale
  // event state are read; nothing scales with the unrelated history.
  assert.ok((results[0]!.rows[STORES.bookmarkEvents] ?? 0) <= 3);
  assert.ok((results[0]!.rows[STORES.pullEvents] ?? 0) <= 4);
  assert.ok((results[0]!.rows[STORES.pullPages] ?? 0) <= 1);
  assert.ok((results[0]!.rows[STORES.remoteDeleteDecisions] ?? 0) <= 2);
  assert.ok((results[0]!.rows[STORES.mappings] ?? 0) <= 3);
});
