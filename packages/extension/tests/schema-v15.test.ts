import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import {
  DATABASE_NAME, DATABASE_VERSION, createSyncStateStore, type SyncScope,
} from '../src/sync-state-store.js';
import { AUTHORITY_DIGEST, INDEXES, STORES } from '../src/sync-state/schema.js';
import { pageV15Backfill } from '../src/sync-state/v15-backfill.js';
import { readStoredNativeResult, readStoredReplayState } from '../src/native-call-result.js';
import { readSyncStateSource } from './read-sync-state-source.js';
import { scope } from './kns-03-bootstrap-harness.js';

describe('schema v15 native-result and live-work contract', () => {
  test('v14 to v15 preserves pending queue, receipts, intents, cursors, and mappings', async () => {
    const indexedDB = new IDBFactory();
    const fixture = await seedV14(indexedDB);
    const store = createSyncStateStore({ indexedDB });
    const database = await store.open();
    assert.equal(database.version, DATABASE_VERSION);
    assert.equal(DATABASE_VERSION, 21);
    const commands = database.transaction(STORES.boundaryCommands, 'readonly').objectStore(STORES.boundaryCommands);
    assert.ok(commands.indexNames.contains(INDEXES.boundaryCommandByState));
    assert.ok(database.transaction(STORES.pullPages, 'readonly').objectStore(STORES.pullPages)
      .indexNames.contains(INDEXES.pullPageByState));
    assert.ok(database.objectStoreNames.contains(STORES.intents));
    const intents = database.transaction(STORES.intents, 'readonly').objectStore(STORES.intents);
    assert.ok(intents.indexNames.contains(INDEXES.intentByNativeResult));
    assert.ok(intents.indexNames.contains(INDEXES.intentByWaitReason));
    assert.ok(intents.indexNames.contains(INDEXES.intentByRepairJob));
    assert.ok(intents.indexNames.contains(INDEXES.intentByLiveWork));
    const pullEvents = database.transaction(STORES.pullEvents, 'readonly').objectStore(STORES.pullEvents);
    assert.ok(pullEvents.indexNames.contains(INDEXES.pullEventByPage));
    const queueStore = database.transaction(STORES.queue, 'readonly').objectStore(STORES.queue);
    assert.ok(queueStore.indexNames.contains(INDEXES.queueByTargetRevision));
    const queued = await requestResult(
      database.transaction(STORES.queue, 'readonly').objectStore(STORES.queue)
        .index(INDEXES.queueByTargetRevision).get([fixture.queue.scopeKey, 'node-v14', 'revision-v14']),
    ) as { opId?: string } | undefined;
    assert.equal(queued?.opId, 'op-v14');

    const exported = await store.exportScope(scope);
    assert.deepEqual(exported.queue, [fixture.queue]);
    assert.deepEqual(exported.receipts, [fixture.receipt]);
    assert.equal(exported.intents[0]?.intentId, fixture.intent.intentId);
    assert.equal(exported.intents[0]?.correlationId, fixture.intent.correlationId);
    assert.deepEqual(exported.cursor, fixture.cursor);
    assert.deepEqual(exported.mappings, [fixture.mapping]);
    assert.equal(readStoredNativeResult(exported.intents[0]!), 'unknown');
    assert.equal(readStoredReplayState(exported.intents[0]!), 'unknown');
    assert.notEqual(readStoredNativeResult(exported.intents[0]!), 'applied_with_evidence');

    const metadata = await get(database, STORES.metadata, 'schema');
    assert.deepEqual(metadata, { key: 'schema', version: DATABASE_VERSION, authorityDigest: AUTHORITY_DIGEST });
    const backfill = await get(database, STORES.metadata, 'v15-backfill') as { status?: string };
    assert.equal(backfill.status, 'complete');
  });

  test.each([14, 20])('a v%s binary cannot reopen the current v21 database', async (oldVersion) => {
    const indexedDB = new IDBFactory();
    await seedV14(indexedDB);
    const store = createSyncStateStore({ indexedDB });
    await store.open();
    store.close();
    const request = indexedDB.open(DATABASE_NAME, oldVersion);
    const result = await new Promise<unknown>((resolve) => {
      request.onerror = () => resolve(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve(new Error(`v${oldVersion} binary unexpectedly opened v21 database`));
      };
    });
    assert.equal((result as DOMException).name, 'VersionError');
  });

  test('aborted v14 to v15 upgrade leaves the v14 queue readable', async () => {
    const indexedDB = new IDBFactory();
    const fixture = await seedV14(indexedDB);
    const failed = createSyncStateStore({ indexedDB, injectUpgradeFailure: true });
    await assert.rejects(() => failed.open(), /upgrade_failed/);
    const request = indexedDB.open(DATABASE_NAME, 14);
    const database = await requestResult(request);
    const queue = await get(database, 'outbound_queue', [fixture.queue.scopeKey, fixture.queue.sequence]);
    assert.equal((queue as { opId: string }).opId, 'op-v14');
    database.close();
  });

  test('onupgradeneeded does not cursor-scan queue or history', async () => {
    const source = await readSyncStateSource();
    const schema = await readFile(new URL('../src/sync-state/schema.ts', import.meta.url), 'utf8');
    assert.match(schema, /DATABASE_VERSION = 21/);
    const upgrade = source.match(/export function upgrade\([\s\S]*?\n\}/);
    assert.ok(upgrade);
    assert.doesNotMatch(upgrade[0]!, /objectStore\(STORES\.queue\)\.openCursor|objectStore\(STORES\.intents\)\.openCursor/);
    const indexes = source.match(/function ensureLiveIndexes\(tx: IDBTransaction\) \{[\s\S]*?\n\}/);
    assert.ok(indexes);
    assert.doesNotMatch(indexes[0]!, /openCursor|getAll\(|IDBKeyRange|fetch\(/);
    assert.match(indexes[0]!, /createIndex/);
    assert.match(indexes[0]!, /INDEXES\.pullEventByPage/);
    assert.match(indexes[0]!, /INDEXES\.pullEventByOperation/);
    assert.match(indexes[0]!, /INDEXES\.pullPageByState/);
    assert.match(indexes[0]!, /INDEXES\.queueByTargetRevision/);
  });

  test('export after v14 to v15 still round-trips live facts', async () => {
    const indexedDB = new IDBFactory();
    const fixture = await seedV14(indexedDB);
    const store = createSyncStateStore({ indexedDB });
    await store.open();
    const exported = await store.exportScope(scope);
    assert.equal(exported.queue[0]?.opId, fixture.queue.opId);
    assert.equal(exported.receipts[0]?.receiptId, fixture.receipt.receiptId);
    assert.equal(exported.intents[0]?.intentId, fixture.intent.intentId);
    const cursor = exported.cursor as { cursor?: string } | null;
    assert.equal(cursor?.cursor, fixture.cursor.cursor);
  });

  test('post-upgrade backfill pages unknown native results and no-ops when done', async () => {
    const indexedDB = new IDBFactory();
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({
      ...scope, lifecycle: 'active', lease: { leaseId: 'lease-v15', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [],
    });
    for (let index = 0; index < 5; index += 1) {
      await store.createApplyIntent(scope, {
        intentId: `intent-${index}`, correlationId: `correlation-${index}`,
        operationId: `op-${index}`, expected: { kind: 'create', nativeId: `native-${index}` },
        expiresAt: 20_000 + index,
      });
    }
    const first = await pageV15Backfill(store, 2);
    assert.equal(first.written, 2);
    assert.equal(first.done, false);
    const second = await pageV15Backfill(store, 2);
    assert.equal(second.written, 2);
    assert.equal(second.done, false);
    const third = await pageV15Backfill(store, 2);
    assert.equal(third.written, 1);
    assert.equal(third.done, true);
    const idle = await pageV15Backfill(store, 2);
    assert.equal(idle.written, 0);
    assert.equal(idle.done, true);
    const exported = await store.exportScope(scope);
    for (const intent of exported.intents) {
      assert.equal(readStoredNativeResult(intent), 'unknown');
      assert.notEqual(readStoredNativeResult(intent), 'applied_with_evidence');
    }
  });

  test('unique v15 intent indexes skip missing owner fields and keep unknown nativeResult rows distinct', async () => {
    const indexedDB = new IDBFactory();
    const fixture = await seedV14(indexedDB);
    const v14 = await requestResult(indexedDB.open(DATABASE_NAME, 14));
    const extra = { ...fixture.intent, intentId: 'intent-v14-b', correlationId: 'correlation-v14-b' };
    const seed = v14.transaction(STORES.intents, 'readwrite');
    seed.objectStore(STORES.intents).put(extra);
    await transactionComplete(seed);
    v14.close();

    const store = createSyncStateStore({ indexedDB });
    const database = await store.open();
    const intents = database.transaction(STORES.intents, 'readonly').objectStore(STORES.intents);
    assert.equal(await requestResult(intents.index(INDEXES.intentByLiveWork).count()), 0);
    assert.equal(await requestResult(intents.index(INDEXES.intentByWaitReason).count()), 0);
    assert.equal(await requestResult(intents.index(INDEXES.intentByRepairJob).count()), 0);
    assert.equal(await requestResult(intents.index(INDEXES.intentByNativeResult).count()), 2);
    assert.equal((await store.exportScope(scope)).intents.length, 2);

    const page = await pageV15Backfill(store, 10);
    assert.equal(page.done, true);
    assert.ok(page.written === 2 || page.written === 0);
    const filled = (await store.open()).transaction(STORES.intents, 'readonly').objectStore(STORES.intents);
    assert.equal(await requestResult(filled.index(INDEXES.intentByNativeResult).count()), 2);
    assert.equal(await requestResult(filled.index(INDEXES.intentByLiveWork).count()), 0);
  });

  test('live-work unique index collides only after owner fields are set', async () => {
    const indexedDB = new IDBFactory();
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({
      ...scope, lifecycle: 'active', lease: { leaseId: 'lease-live', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [],
    });
    const base = { expected: { kind: 'create', nativeId: 'native-live' }, expiresAt: 20_000 };
    await store.createApplyIntent(scope, { ...base, intentId: 'intent-a', correlationId: 'corr-a', operationId: 'op-a' });
    await store.createApplyIntent(scope, { ...base, intentId: 'intent-b', correlationId: 'corr-b', operationId: 'op-b' });
    await store.createApplyIntent(scope, {
      ...base, intentId: 'intent-c', correlationId: 'corr-c', operationId: 'op-c',
      nativeResult: 'unknown', waitReason: 'unknown',
    });
    await store.createApplyIntent(scope, {
      ...base, intentId: 'intent-d', correlationId: 'corr-d', operationId: 'op-d',
      nativeResult: 'unknown', waitReason: 'unknown',
    });
    await store.createApplyIntent(scope, {
      ...base, intentId: 'intent-e', correlationId: 'corr-e', operationId: 'op-e',
      liveWorkKind: 'create', colpId: 'node-1', substep: 'create',
    });
    await assert.rejects(() => store.createApplyIntent(scope, {
      ...base, intentId: 'intent-f', correlationId: 'corr-f', operationId: 'op-f',
      liveWorkKind: 'create', colpId: 'node-1', substep: 'create',
    }), /constraint/);
  });
});

interface V14Fixture {
  readonly queue: Record<string, unknown> & { readonly scopeKey: string; readonly sequence: number; readonly opId: string };
  readonly receipt: Record<string, unknown> & { readonly receiptId: string };
  readonly intent: Record<string, unknown> & { readonly intentId: string };
  readonly cursor: Record<string, unknown> & { readonly cursor: string };
  readonly mapping: Record<string, unknown>;
}

async function seedV14(indexedDB: IDBFactory): Promise<V14Fixture> {
  const request = indexedDB.open(DATABASE_NAME, 14);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore(STORES.scopes, { keyPath: 'scopeKey' });
    const mappings = db.createObjectStore(STORES.mappings, { keyPath: ['scopeKey', 'nativeId'] });
    mappings.createIndex('by_scope_native_id', ['scopeKey', 'nativeId'], { unique: true });
    mappings.createIndex('by_scope_colp_id', ['scopeKey', 'colpId'], { unique: true });
    const queue = db.createObjectStore(STORES.queue, { keyPath: ['scopeKey', 'sequence'] });
    queue.createIndex('by_scope_sequence', ['scopeKey', 'sequence'], { unique: true });
    queue.createIndex('by_scope_op_id', ['scopeKey', 'opId'], { unique: true });
    queue.createIndex('by_scope_status_sequence', ['scopeKey', 'status', 'sequence'], { unique: true });
    queue.createIndex('by_scope_claim_sequence', ['scopeKey', 'retry.ownerId', 'retry.fence', 'sequence']);
    db.createObjectStore(STORES.receipts, { keyPath: ['scopeKey', 'receiptId'] })
      .createIndex('by_scope_sequence', ['scopeKey', 'sequence'], { unique: true });
    db.createObjectStore(STORES.cursors, { keyPath: 'scopeKey' });
    const intents = db.createObjectStore(STORES.intents, { keyPath: ['scopeKey', 'intentId'] });
    intents.createIndex('by_scope_correlation', ['scopeKey', 'correlationId'], { unique: true });
    db.createObjectStore(STORES.metadata, { keyPath: 'key' });
  };
  const database = await requestResult(request);
  const key = scopeKeyOf(scope);
  const queue = {
    scopeKey: key, sequence: 10, opId: 'op-v14', batchId: 'batch-v14', idempotencyKey: 'idem-v14',
    digest: 'sha256:queue-v14', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-v13', operationRevision: 'revision-v14', status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: { type: 'create_node', targetId: 'node-v14' },
  };
  const receipt = {
    scopeKey: key, receiptId: 'receipt-v14', sequence: 9, opId: 'op-prior',
    operationDigest: 'sha256:receipt-v14', kind: 'terminal', resultDigest: 'sha256:result-v14',
  };
  const intent = {
    scopeKey: key, intentId: 'intent-v14', correlationId: 'correlation-v14',
    operationId: 'remote-v14', expected: { kind: 'create', nativeId: '' }, expiresAt: 14_000,
    state: 'browser_call_started',
  };
  const cursor = {
    scopeKey: key, cursor: 'cursor-v14', checkpoint: 'revision-v14',
    evidence: { receiptId: 'receipt-v14', operationDigest: 'sha256:receipt-v14' },
  };
  const mapping = {
    scopeKey: key, nativeId: 'native-v14', colpId: 'node-v14', rootNativeId: 'root-v14',
    projection: { revision: 'revision-v14', digest: 'sha256:mapping-v14' },
  };
  const scopeRecord = {
    ...scope, scopeKey: key, lifecycle: 'active', lease: { leaseId: 'lease-v14', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-v14', cursor: 'cursor-v14' }, selectedRoots: [],
  };
  const tx = database.transaction([
    STORES.scopes, STORES.queue, STORES.receipts, STORES.intents, STORES.cursors, STORES.mappings, STORES.metadata,
  ], 'readwrite');
  tx.objectStore(STORES.scopes).put(scopeRecord);
  tx.objectStore(STORES.queue).put(queue);
  tx.objectStore(STORES.receipts).put(receipt);
  tx.objectStore(STORES.intents).put(intent);
  tx.objectStore(STORES.cursors).put(cursor);
  tx.objectStore(STORES.mappings).put(mapping);
  tx.objectStore(STORES.metadata).put({ key: 'schema', version: 14, authorityDigest: 'p3-36-compaction-v1' });
  await transactionComplete(tx);
  database.close();
  return { queue, receipt, intent, cursor, mapping };
}

function scopeKeyOf(value: SyncScope) {
  return JSON.stringify([
    value.environment, value.serverId, value.serverOrigin, value.accountId,
    value.browserProfileId, value.collectionId, value.replicaId, value.generation,
  ]);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function get(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<unknown> {
  return requestResult(database.transaction(storeName, 'readonly').objectStore(storeName).get(key));
}
