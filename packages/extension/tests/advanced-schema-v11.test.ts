import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { createSyncStateStore, DATABASE_NAME, DATABASE_VERSION } from '../src/sync-state-store.js';
import { AUTHORITY_DIGEST, STORES } from '../src/sync-state/schema.js';
import { scope } from './kns-03-bootstrap-harness.js';

describe('schema v11 advanced bootstrap migration contract', () => {
  test('upgrades a real v10 database without changing durable rows and starts new stores empty', async () => {
    const indexedDB = new IDBFactory();
    const fixture = await seedV10(indexedDB);
    const store = createSyncStateStore({ indexedDB });
    const database = await store.open();

    assert.equal(database.version, DATABASE_VERSION);
    assert.ok(database.objectStoreNames.contains(STORES.advancedPlans));
    assert.ok(database.objectStoreNames.contains(STORES.advancedSteps));
    assert.equal(await count(database, STORES.advancedPlans), 0);
    assert.equal(await count(database, STORES.advancedSteps), 0);

    const exported = await store.exportScope(scope);
    assert.deepEqual(exported.scope, fixture.scopeRecord);
    assert.deepEqual(exported.queue, [fixture.queue]);
    assert.deepEqual(exported.mappings, [fixture.mapping]);
    assert.deepEqual(exported.recovery, fixture.recovery);
    assert.deepEqual(exported.recoveryNodes, [fixture.recoveryNode]);
    assert.deepEqual(exported.advancedPlans, []);
    assert.deepEqual(exported.advancedSteps, []);

    const metadata = await get(database, STORES.metadata, 'schema');
    assert.deepEqual(metadata, { key: 'schema', version: DATABASE_VERSION, authorityDigest: AUTHORITY_DIGEST });
  });

  test('a v10 binary cannot reopen a database after the v11 upgrade', async () => {
    const indexedDB = new IDBFactory();
    await seedV10(indexedDB);
    const store = createSyncStateStore({ indexedDB });
    await store.open();
    store.close();

    const request = indexedDB.open(DATABASE_NAME, 10);
    const result = await new Promise<unknown>((resolve) => {
      request.onerror = () => resolve(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve(new Error('v10 binary unexpectedly opened v11 database'));
      };
    });
    assert.equal((result as DOMException).name, 'VersionError');
  });
});

interface V10Fixture {
  readonly scopeRecord: Record<string, unknown>;
  readonly queue: Record<string, unknown>;
  readonly mapping: Record<string, unknown>;
  readonly recovery: Record<string, unknown>;
  readonly recoveryNode: Record<string, unknown>;
}

async function seedV10(indexedDB: IDBFactory): Promise<V10Fixture> {
  const request = indexedDB.open(DATABASE_NAME, 10);
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
    db.createObjectStore(STORES.recovery, { keyPath: ['scopeKey', 'snapshotId'] });
    const recoveryNodes = db.createObjectStore(STORES.recoveryNodes, { keyPath: ['scopeKey', 'snapshotId', 'colpId'] });
    recoveryNodes.createIndex('by_scope_snapshot_page', ['scopeKey', 'snapshotId', 'page', 'colpId'], { unique: true });
    const events = db.createObjectStore(STORES.bookmarkEvents, { keyPath: ['scopeKey', 'eventId'] });
    events.createIndex('by_scope_event_ordinal', ['scopeKey', 'ordinal'], { unique: true });
    events.createIndex('by_scope_event_dedupe', ['scopeKey', 'dedupeKey'], { unique: true });
    db.createObjectStore(STORES.metadata, { keyPath: 'key' });
  };
  const database = await requestResult(request);
  const key = JSON.stringify([
    scope.environment, scope.serverId, scope.serverOrigin, scope.accountId,
    scope.browserProfileId, scope.collectionId, scope.replicaId, scope.generation,
  ]);
  const scopeRecord = {
    ...scope, scopeKey: key, lifecycle: 'active', lease: { leaseId: 'lease-v10', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-v10', cursor: 'cursor-v10' }, selectedRoots: [],
  };
  const queue = {
    scopeKey: key, sequence: 7, opId: 'op-v10', batchId: 'batch-v10', idempotencyKey: 'idem-v10',
    digest: 'sha256:queue-v10', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-v9', operationRevision: 'revision-v10', status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: { type: 'create_node', targetId: 'node-v10', bytes: 'q'.repeat(4096) },
  };
  const mapping = {
    scopeKey: key, nativeId: 'native-v10', colpId: 'node-v10', rootNativeId: 'root-v10',
    projection: { revision: 'revision-v10', digest: 'sha256:mapping-v10', content: { bytes: 'm'.repeat(4096) } },
  };
  const recovery = {
    scopeKey: key, snapshotId: 'snapshot-v10', sessionId: null, revision: 'revision-v10', syncCursor: 'cursor-v10',
    identityDigest: 'sha256:identity-v10', rootNodeId: 'root-v10', lastPage: 0,
    lastPageDigest: 'sha256:page-v10', nextCursor: null, complete: false, bytes: 'r'.repeat(4096),
  };
  const recoveryNode = {
    scopeKey: key, snapshotId: 'snapshot-v10', page: 0, colpId: 'node-v10', parentId: null, position: '0',
    kind: 'Bookmark', payloadDigest: 'sha256:payload-v10',
    mapping: { nativeId: 'native-v10', colpId: 'node-v10', rootNativeId: 'root-v10',
      projection: { revision: 'revision-v10', digest: 'sha256:mapping-v10', content: { bytes: 'm'.repeat(4096) } } },
  };
  const transaction = database.transaction([
    STORES.scopes, STORES.queue, STORES.mappings, STORES.recovery, STORES.recoveryNodes, STORES.metadata,
  ], 'readwrite');
  transaction.objectStore(STORES.scopes).put(scopeRecord);
  transaction.objectStore(STORES.queue).put(queue);
  transaction.objectStore(STORES.mappings).put(mapping);
  transaction.objectStore(STORES.recovery).put(recovery);
  transaction.objectStore(STORES.recoveryNodes).put(recoveryNode);
  transaction.objectStore(STORES.metadata).put({ key: 'schema', version: 10, authorityDigest: 'p3-35-bookmark-import-v1' });
  await transactionComplete(transaction);
  database.close();
  return { scopeRecord, queue, mapping, recovery, recoveryNode };
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

function count(database: IDBDatabase, storeName: string): Promise<number> {
  return requestResult(database.transaction(storeName, 'readonly').objectStore(storeName).count());
}
