import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { IDBFactory, IDBCursor } from 'fake-indexeddb';
import { beforeEach, describe, test, vi } from 'vitest';
import {
  evaluateEventCompactEligibility, evaluateQueueCompactEligibility,
} from '../src/sync-compaction.js';
import {
  DATABASE_NAME, DATABASE_VERSION, SyncStateError, createSyncStateStore,
  type QueueOperation, type SyncScope,
} from '../src/sync-state-store.js';
import { readSyncStateSource } from './read-sync-state-source.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('sync compaction predicates', () => {
  test('refuses queue compact when receipt or cursor evidence is missing', () => {
    const queued = {
      status: 'terminal', sequence: 1, opId: 'op-1', digest: 'sha256:op-1', payload: { type: 'create_node' },
    };
    assert.equal(evaluateQueueCompactEligibility({ queued, hasReceipt: false, hasCursor: true }).ok, false);
    assert.equal(evaluateQueueCompactEligibility({ queued, hasReceipt: true, hasCursor: false }).ok, false);
    assert.equal(evaluateQueueCompactEligibility({ queued, hasReceipt: true, hasCursor: true }).ok, true);
    assert.equal(evaluateQueueCompactEligibility({
      queued: { ...queued, status: 'pending' }, hasReceipt: true, hasCursor: true,
    }).ok, false);
    assert.equal(evaluateQueueCompactEligibility({
      queued: { ...queued, payload: { compacted: true }, attempt: undefined },
      hasReceipt: true, hasCursor: true,
    }).ok, false);
  });

  test('refuses event compact until the bound queue row is terminal', () => {
    const event = {
      status: 'processed' as const, eventId: 'event-1', ordinal: 1, opId: 'op-1', dedupeKey: 'd',
      details: { type: 'create' },
    };
    assert.equal(evaluateEventCompactEligibility({ event, queued: undefined }).ok, false);
    const terminal = { status: 'terminal', sequence: 1, opId: 'op-1', digest: 'sha256:op-1', payload: {} };
    for (const incomplete of [{ ...event, status: 'pending' }, { ...event, opId: null }]) {
      assert.deepEqual(evaluateEventCompactEligibility({ event: incomplete, queued: terminal }),
        { ok: false, reason: 'event_not_processed' });
    }
    assert.equal(evaluateEventCompactEligibility({
      event, queued: { status: 'pending', sequence: 1, opId: 'op-1', digest: 'sha256:op-1', payload: {} },
    }).ok, false);
    assert.equal(evaluateEventCompactEligibility({
      event, queued: { status: 'terminal', sequence: 1, opId: 'op-1', digest: 'sha256:op-1', payload: {} },
    }).ok, true);
    assert.equal(evaluateEventCompactEligibility({
      event: { ...event, details: { compacted: true } },
      queued: { status: 'terminal', sequence: 1, opId: 'op-1', digest: 'sha256:op-1', payload: {} },
    }).ok, false);
  });
});

describe('sync compaction store', () => {
  test('compacts terminal queue payload only after receipt and published cursor exist', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    const queued = await store.allocateSequenceAndEnqueue(scope, operation('op-1'), { allowUnstamped: true });
    const refused = await store.compactScope(scope, { now: 1_000 });
    assert.equal(refused.compactedQueue, 0);
    assert.equal((await store.listQueue(scope))[0]?.payload.type, 'update_node');
    await store.completeQueueWithReceipt(scope, queued.sequence, receipt(queued));
    assert.equal((await store.compactScope(scope, { now: 1_000 })).compactedQueue, 0);
    await store.publishCursor(scope, {
      cursor: 'cursor-1', checkpoint: 'checkpoint-1',
      evidence: { receiptId: 'receipt-1', operationDigest: queued.digest },
    });
    const report = await store.compactScope(scope, { now: 2_000 });
    assert.equal(report.compactedQueue, 1);
    const compacted = (await store.listQueue(scope))[0]!;
    assert.equal(compacted.payload.compacted, true);
    assert.equal(compacted.payload.type, 'update_node');
    assert.equal(compacted.attempt, undefined);
    const exported = await store.exportScope(scope);
    assert.equal(exported.compactSummaries.length, 1);
    assert.equal(exported.compactionWatermark?.queueThroughSequence, queued.sequence);
    assert.equal(exported.queue[0]?.payload.compacted, true);
    const again = await store.compactScope(scope, { now: 3_000 });
    assert.equal(again.compactedQueue, 0);
    assert.equal(again.watermark.remainingEligible, false);
  });

  test('cursor continuation failure rejects and rolls back instead of leaving compaction pending', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    const queued = await store.allocateSequenceAndEnqueue(scope, operation('op-cursor'), { allowUnstamped: true });
    await store.completeQueueWithReceipt(scope, queued.sequence, receipt(queued, 'receipt-cursor'));
    await store.publishCursor(scope, { cursor: 'cursor-cursor', checkpoint: 'checkpoint-1',
      evidence: { receiptId: 'receipt-cursor', operationDigest: queued.digest } });
    const continuation = vi.spyOn(IDBCursor.prototype, 'continue').mockImplementationOnce(() => {
      throw new Error('cursor_continue_failed');
    });
    try { await assert.rejects(store.compactScope(scope)); }
    finally { continuation.mockRestore(); }
    assert.equal((await store.listQueue(scope))[0]?.payload.compacted, undefined);
    assert.equal((await store.exportScope(scope)).compactSummaries.length, 0);
    assert.equal((await store.compactScope(scope)).compactedQueue, 1);
  });

  test('rolls back summary, payload strip and watermark together when faulted', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    const queued = await store.allocateSequenceAndEnqueue(scope, operation('op-fault'), { allowUnstamped: true });
    await store.completeQueueWithReceipt(scope, queued.sequence, receipt(queued, 'receipt-fault'));
    await store.publishCursor(scope, {
      cursor: 'cursor-fault', checkpoint: 'checkpoint-1',
      evidence: { receiptId: 'receipt-fault', operationDigest: queued.digest },
    });
    for (const fault of ['after_summary', 'after_delete', 'after_watermark'] as const) {
      await assert.rejects(() => store.compactScope(scope, { now: 3_000, fault }), SyncStateError);
      const live = (await store.listQueue(scope))[0]!;
      assert.equal(live.payload.type, 'update_node');
      assert.equal(live.payload.compacted, undefined);
      assert.equal((await store.exportScope(scope)).compactSummaries.length, 0);
      assert.equal((await store.exportScope(scope)).compactionWatermark, null);
    }
    const report = await store.compactScope(scope, { now: 4_000 });
    assert.equal(report.compactedQueue, 1);
  });

  test('pending identity lookups stay on the status index after compacting processed events', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    const queued = await store.allocateSequenceAndEnqueue(scope, operation('op-processed'), { allowUnstamped: true });
    await store.completeQueueWithReceipt(scope, queued.sequence, receipt(queued, 'receipt-processed'));
    await store.publishCursor(scope, {
      cursor: 'cursor-processed', checkpoint: 'checkpoint-1',
      evidence: { receiptId: 'receipt-processed', operationDigest: queued.digest },
    });
    const db = await store.open();
    const key = (await store.getScope(scope))!.scopeKey;
    const tx = db.transaction(['bookmark_events'], 'readwrite');
    tx.objectStore('bookmark_events').add({
      scopeKey: key, eventId: 'event-processed', ordinal: 1, status: 'processed', opId: queued.opId,
      dedupeKey: 'dedupe-processed', occurredAt: '2026-08-30T00:00:00.000Z', kind: 'change',
      nativeId: 'native-processed', details: { bulky: 'x'.repeat(1_000) },
    });
    tx.objectStore('bookmark_events').add({
      scopeKey: key, eventId: 'event-pending', ordinal: 2, status: 'pending', opId: null,
      dedupeKey: 'dedupe-pending', occurredAt: '2026-08-30T00:00:01.000Z', kind: 'change',
      nativeId: 'native-pending', details: { live: true },
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    const report = await store.compactScope(scope, { now: 5_000 });
    assert.equal(report.compactedEvents, 1);
    assert.deepEqual((await store.listBookmarkEventsByStatus(scope, 'pending')).map((row) => row.eventId),
      ['event-pending']);
    assert.equal((await store.getBookmarkEvent(scope, 'event-processed'))?.details.compacted, true);
    assert.equal((await store.getBookmarkEvent(scope, 'event-pending'))?.details.live, true);
    assert.equal((await store.getQueueByOpId(scope, queued.opId))?.status, 'terminal');
  });

  test('compacts a fixed batch of 200 and leaves remaining eligible rows for the next idle run', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    const db = await store.open();
    const key = (await store.getScope(scope))!.scopeKey;
    const tx = db.transaction(['outbound_queue', 'durable_sequences', 'receipts', 'cursors', 'bookmark_events'],
      'readwrite');
    const queue = tx.objectStore('outbound_queue');
    const receipts = tx.objectStore('receipts');
    const events = tx.objectStore('bookmark_events');
    for (let sequence = 1; sequence <= 250; sequence += 1) {
      const opId = `op-batch-${sequence}`;
      queue.add({
        scopeKey: key, sequence, opId, batchId: `batch-${sequence}`, idempotencyKey: `key-${sequence}`,
        digest: `sha256:${opId}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
        baseRevision: 'revision-0', operationRevision: `local-${sequence}`, status: 'terminal',
        retry: { attempt: 1, notBefore: 0 }, payload: { type: 'update_node', targetId: 'node-1' },
      });
      receipts.add({
        scopeKey: key, receiptId: `receipt-batch-${sequence}`, sequence, opId, operationDigest: `sha256:${opId}`,
        kind: 'terminal', resultDigest: `sha256:r-${sequence}`,
      });
      events.add({
        scopeKey: key, eventId: `event-batch-${sequence}`, ordinal: sequence, status: 'processed', opId,
        dedupeKey: `dedupe-batch-${sequence}`, occurredAt: '2026-08-30T00:00:00.000Z', kind: 'change',
        nativeId: `native-batch-${sequence}`, details: { bulky: true },
      });
    }
    tx.objectStore('durable_sequences').put({ scopeKey: key, next: 251 });
    tx.objectStore('cursors').put({
      scopeKey: key, cursor: 'cursor-batch', checkpoint: 'checkpoint-1',
      evidence: { receiptId: 'receipt-batch-250', operationDigest: 'sha256:op-batch-250' },
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    const first = await store.compactScope(scope, { now: 8_000, batch: 200 });
    assert.equal(first.compactedQueue, 200);
    assert.equal(first.compactedEvents, 200);
    assert.equal(first.watermark.remainingEligible, true);
    const second = await store.compactScope(scope, { now: 9_000, batch: 200 });
    assert.equal(second.compactedQueue, 50);
    assert.equal(second.compactedEvents, 50);
    assert.equal(second.watermark.remainingEligible, false);
  }, 20_000);

  test('retire and account cleanup drop compaction watermarks and summaries', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    const queued = await store.allocateSequenceAndEnqueue(scope, operation('op-retire'), { allowUnstamped: true });
    await store.completeQueueWithReceipt(scope, queued.sequence, receipt(queued, 'receipt-retire'));
    await store.publishCursor(scope, {
      cursor: 'cursor-retire', checkpoint: 'checkpoint-1',
      evidence: { receiptId: 'receipt-retire', operationDigest: queued.digest },
    });
    assert.equal((await store.compactScope(scope, { now: 6_000 })).compactedQueue, 1);
    const key = (await store.getScope(scope))!.scopeKey;
    await store.retireScope(scope, { retiredAt: 7_000, reason: 'logout' });
    const db = await store.open();
    assert.equal(await requestValue(db.transaction('compaction_watermarks').objectStore('compaction_watermarks').get(key)),
      undefined);
    const summaries = db.transaction('compact_summaries').objectStore('compact_summaries');
    assert.equal(await requestValue(summaries.get([key, 'queue', queued.opId])), undefined);
  });

  test('account cleanup drops compaction watermarks with the live scope', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    const queued = await store.allocateSequenceAndEnqueue(scope, operation('op-cleanup'), { allowUnstamped: true });
    await store.completeQueueWithReceipt(scope, queued.sequence, receipt(queued, 'receipt-cleanup'));
    await store.publishCursor(scope, {
      cursor: 'cursor-cleanup', checkpoint: 'checkpoint-1',
      evidence: { receiptId: 'receipt-cleanup', operationDigest: queued.digest },
    });
    assert.equal((await store.compactScope(scope, { now: 8_000 })).compactedQueue, 1);
    const key = (await store.getScope(scope))!.scopeKey;
    await store.cleanupAccount({
      environment: scope.environment, serverId: scope.serverId, accountId: scope.accountId,
      browserProfileId: scope.browserProfileId,
    });
    const db = await store.open();
    assert.equal(await requestValue(db.transaction('compaction_watermarks').objectStore('compaction_watermarks').get(key)),
      undefined);
  });

  test('upgrades a v8 fixture by adding compaction stores and event indexes without scanning rows', async () => {
    const key = JSON.stringify([
      scope.environment, scope.serverId, scope.serverOrigin, scope.accountId,
      scope.browserProfileId, scope.collectionId, scope.replicaId, scope.generation,
    ]);
    await seedV8(key);
    const store = createSyncStateStore({ indexedDB });
    const queued = (await store.listQueue(scope))[0];
    assert.equal(queued?.payload.type, 'create_node');
    const db = await store.open();
    assert.equal(db.version, DATABASE_VERSION);
    assert.ok(db.objectStoreNames.contains('compaction_watermarks'));
    assert.ok(db.objectStoreNames.contains('compact_summaries'));
    const events = db.transaction('bookmark_events').objectStore('bookmark_events');
    assert.ok(events.indexNames.contains('by_scope_event_status_ordinal'));
    assert.ok(events.indexNames.contains('by_scope_event_native_ordinal'));
    assert.equal((await store.getBookmarkEvent(scope, 'event-v8'))?.nativeId, 'native-v8');
  });
});

describe('sync compaction upgrade contract', () => {
  test('v8 to current upgrade only createIndex/createObjectStore for live indexes and does not cursor-scan queue rows', async () => {
    const source = await readSyncStateSource();
    const compaction = await readFile(new URL('../src/sync-compaction.ts', import.meta.url), 'utf8');
    const queue = await readFile(new URL('../src/bookmark-event-queue.ts', import.meta.url), 'utf8');
    const engine = await readFile(new URL('../src/durable-sync-engine.ts', import.meta.url), 'utf8');
    assert.match(source, /DATABASE_VERSION = 22/);
    assert.match(source, /p3-36-compaction-v1/);
    assert.match(source, /srg-v15-native-result-v1/);
    assert.match(source, /compactionWatermarks: 'compaction_watermarks'/);
    assert.match(source, /compactSummaries: 'compact_summaries'/);
    assert.match(source, /by_scope_event_status_ordinal/);
    assert.match(source, /function ensureLiveIndexes/);
    const indexes = source.match(/function ensureLiveIndexes\(tx: IDBTransaction\) \{[\s\S]*?\n\}/);
    assert.ok(indexes);
    assert.doesNotMatch(indexes[0]!, /openCursor|getAll\(|IDBKeyRange/);
    assert.match(source, /if \(oldVersion === 1 \|\| oldVersion === 2\) migrateP303/);
    assert.match(queue, /listBookmarkEventsByStatus/);
    assert.match(queue, /resolveEventIdentityTokens/);
    const resolver = await readFile(new URL('../src/bookmark-event-resolve.ts', import.meta.url), 'utf8');
    assert.match(resolver, /getBookmarkEvent/);
    assert.match(engine, /compactScope/);
    assert.match(engine, /firstLaneQueue\(options\.scope\)/);
    assert.match(compaction, /COMPACTION_BATCH = 200/);
  });
});

function operation(opId: string): Omit<QueueOperation, 'sequence' | 'scopeKey'> {
  return {
    opId, batchId: `batch-${opId}`, idempotencyKey: `idem-${opId}`, digest: `sha256:${opId}`,
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'revision-0',
    operationRevision: 'revision-local-1', status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { type: 'update_node', targetId: 'node-1' },
  };
}

function receipt(queued: QueueOperation, receiptId = 'receipt-1') {
  return {
    opId: queued.opId, operationDigest: queued.digest, kind: 'terminal' as const,
    receiptId, resultDigest: `sha256:${receiptId}`,
  };
}

async function active(store: ReturnType<typeof createSyncStateStore>) {
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [],
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function seedV8(key: string): Promise<void> {
  const request = indexedDB.open(DATABASE_NAME, 8);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('sync_scopes', { keyPath: 'scopeKey' });
    const queue = db.createObjectStore('outbound_queue', { keyPath: ['scopeKey', 'sequence'] });
    queue.createIndex('by_scope_sequence', ['scopeKey', 'sequence'], { unique: true });
    queue.createIndex('by_scope_op_id', ['scopeKey', 'opId'], { unique: true });
    queue.createIndex('by_scope_status_sequence', ['scopeKey', 'status', 'sequence'], { unique: true });
    queue.createIndex('by_scope_claim_sequence', ['scopeKey', 'retry.ownerId', 'retry.fence', 'sequence']);
    db.createObjectStore('durable_sequences', { keyPath: 'scopeKey' });
    db.createObjectStore('receipts', { keyPath: ['scopeKey', 'receiptId'] })
      .createIndex('by_scope_sequence', ['scopeKey', 'sequence'], { unique: true });
    db.createObjectStore('cursors', { keyPath: 'scopeKey' });
    const events = db.createObjectStore('bookmark_events', { keyPath: ['scopeKey', 'eventId'] });
    events.createIndex('by_scope_event_ordinal', ['scopeKey', 'ordinal'], { unique: true });
    events.createIndex('by_scope_event_dedupe', ['scopeKey', 'dedupeKey'], { unique: true });
    db.createObjectStore('schema_metadata', { keyPath: 'key' });
    for (const name of [
      'native_mappings', 'apply_intents', 'recovery_staging', 'recovery_nodes', 'replica_leases',
      'retired_archives', 'diagnostics', 'pull_pages', 'pull_events', 'effect_pages', 'sync_engine',
      'ack_intents', 'import_plans', 'import_nodes',
    ]) {
      if (name === 'native_mappings') db.createObjectStore(name, { keyPath: ['scopeKey', 'nativeId'] });
      else if (name === 'apply_intents') db.createObjectStore(name, { keyPath: ['scopeKey', 'intentId'] });
      else if (name === 'recovery_staging') db.createObjectStore(name, { keyPath: ['scopeKey', 'snapshotId'] });
      else if (name === 'recovery_nodes') db.createObjectStore(name, { keyPath: ['scopeKey', 'snapshotId', 'colpId'] });
      else if (name === 'replica_leases' || name === 'sync_engine') db.createObjectStore(name, { keyPath: 'scopeKey' });
      else if (name === 'retired_archives') db.createObjectStore(name, { keyPath: ['scopeKey', 'retiredAt'] });
      else if (name === 'diagnostics') db.createObjectStore(name, { keyPath: 'id' });
      else if (name === 'pull_pages') db.createObjectStore(name, { keyPath: ['scopeKey', 'pageId'] });
      else if (name === 'pull_events') db.createObjectStore(name, { keyPath: ['scopeKey', 'eventId'] });
      else if (name === 'effect_pages') db.createObjectStore(name, { keyPath: ['scopeKey', 'eventId', 'pageNumber'] });
      else if (name === 'ack_intents') db.createObjectStore(name, { keyPath: ['scopeKey', 'intentId'] });
      else if (name === 'import_plans') db.createObjectStore(name, { keyPath: ['scopeKey', 'planId'] });
      else db.createObjectStore(name, { keyPath: ['scopeKey', 'planId', 'sourceNodeId'] });
    }
  };
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(
        ['sync_scopes', 'outbound_queue', 'durable_sequences', 'bookmark_events', 'schema_metadata'],
        'readwrite',
      );
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.objectStore('sync_scopes').put({
        ...scope, scopeKey: key, lifecycle: 'active',
        lease: { leaseId: 'lease-v8', expiresAt: 100 }, checkpoint: null, selectedRoots: [],
      });
      tx.objectStore('outbound_queue').put({
        scopeKey: key, sequence: 1, opId: 'op-v8', batchId: 'batch-v8', idempotencyKey: 'idem-v8',
        digest: 'sha256:op-v8', endpointIdentity: 'syncPush', mediaType: 'application/json',
        baseRevision: null, operationRevision: 'local-v8', status: 'pending',
        retry: { attempt: 0, notBefore: 0 }, payload: { type: 'create_node' },
      });
      tx.objectStore('durable_sequences').put({ scopeKey: key, next: 2 });
      tx.objectStore('bookmark_events').put({
        scopeKey: key, eventId: 'event-v8', ordinal: 1, status: 'pending', opId: null,
        dedupeKey: 'dedupe-v8', occurredAt: '2026-08-30T00:00:00.000Z', kind: 'change',
        nativeId: 'native-v8', details: { preserved: true },
      });
      tx.objectStore('schema_metadata').put({ key: 'schema', version: 8, authorityDigest: 'p3-35-bookmark-import-v1' });
    };
  });
}
