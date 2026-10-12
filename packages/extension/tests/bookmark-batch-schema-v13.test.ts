import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { createSyncStateStore, DATABASE_NAME, DATABASE_VERSION } from '../src/sync-state-store.js';
import { STORES } from '../src/sync-state/schema.js';
import { scope } from './kns-03-bootstrap-harness.js';

describe('schema v13 bookmark-batch migration contract', () => {
  test('upgrades a real v12 database without changing durable rows and starts batch stores empty', async () => {
    const indexedDB = new IDBFactory();
    const fixture = await seedV12(indexedDB);
    const store = createSyncStateStore({ indexedDB });
    const database = await store.open();

    assert.equal(database.version, DATABASE_VERSION);
    assert.ok(database.objectStoreNames.contains(STORES.batchPlans));
    assert.ok(database.objectStoreNames.contains(STORES.batchItems));
    assert.equal(await count(database, STORES.batchPlans), 0);
    assert.equal(await count(database, STORES.batchItems), 0);

    const exported = await store.exportScope(scope);
    assert.deepEqual(exported.scope, fixture.scopeRecord);
    assert.deepEqual(exported.queue, [fixture.queue]);
    assert.deepEqual(exported.mappings, [fixture.mapping]);
    assert.deepEqual(exported.remoteDeleteDecisions, [fixture.decision]);
    assert.deepEqual(exported.batchPlans, []);
    assert.deepEqual(exported.batchItems, []);
  });

  test('a v12 binary cannot reopen a database after the v13 upgrade', async () => {
    const indexedDB = new IDBFactory();
    await seedV12(indexedDB);
    const store = createSyncStateStore({ indexedDB });
    await store.open();
    store.close();

    const request = indexedDB.open(DATABASE_NAME, 12);
    const result = await new Promise<unknown>((resolve) => {
      request.onerror = () => resolve(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve(new Error('v12 binary unexpectedly opened v13 database'));
      };
    });
    assert.equal((result as DOMException).name, 'VersionError');
  });
});

interface V12Fixture {
  readonly scopeRecord: Record<string, unknown>;
  readonly queue: Record<string, unknown>;
  readonly mapping: Record<string, unknown>;
  readonly decision: Record<string, unknown>;
}

async function seedV12(indexedDB: IDBFactory): Promise<V12Fixture> {
  const request = indexedDB.open(DATABASE_NAME, 12);
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
    const decisions = db.createObjectStore(STORES.remoteDeleteDecisions, { keyPath: ['scopeKey', 'decisionId'] });
    decisions.createIndex('by_scope_remote_delete_state', ['scopeKey', 'state', 'decisionId'], { unique: true });
    decisions.createIndex('by_scope_remote_delete_event', ['scopeKey', 'eventId'], { unique: true });
    db.createObjectStore(STORES.metadata, { keyPath: 'key' });
  };
  const database = await requestResult(request);
  const key = JSON.stringify([
    scope.environment, scope.serverId, scope.serverOrigin, scope.accountId,
    scope.browserProfileId, scope.collectionId, scope.replicaId, scope.generation,
  ]);
  const scopeRecord = {
    ...scope, scopeKey: key, lifecycle: 'active', lease: { leaseId: 'lease-v12', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-v12', cursor: 'cursor-v12' }, selectedRoots: [],
  };
  const queue = {
    scopeKey: key, sequence: 8, opId: 'op-v12', batchId: 'batch-v12', idempotencyKey: 'idem-v12',
    digest: 'sha256:queue-v12', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-v11', operationRevision: 'revision-v12', status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: { type: 'create_node', targetId: 'node-v12' },
  };
  const mapping = {
    scopeKey: key, nativeId: 'native-v12', colpId: 'node-v12', rootNativeId: 'root-v12',
    projection: { revision: 'revision-v12', digest: 'sha256:mapping-v12' },
  };
  const decision = {
    scopeKey: key, decisionId: 'rdd-v12', eventId: 'ev-v12', pageId: 'page-v12',
    operationId: 'op-del-v12', effectId: 'eff-v12', effectDigest: 'sha256:eff-v12',
    targetId: 'node-del', deleteRevision: 'revision-del', generation: 1, nativeIds: ['native-del'],
    nodeKind: 'bookmark', title: 'Parked', policy: 'confirm', action: 'pending', state: 'pending',
    casVersion: 1, updatedAt: 12,
  };
  const transaction = database.transaction([
    STORES.scopes, STORES.queue, STORES.mappings, STORES.remoteDeleteDecisions, STORES.metadata,
  ], 'readwrite');
  transaction.objectStore(STORES.scopes).put(scopeRecord);
  transaction.objectStore(STORES.queue).put(queue);
  transaction.objectStore(STORES.mappings).put(mapping);
  transaction.objectStore(STORES.remoteDeleteDecisions).put(decision);
  transaction.objectStore(STORES.metadata).put({ key: 'schema', version: 12, authorityDigest: 'p3-36-compaction-v1' });
  await transactionComplete(transaction);
  database.close();
  return { scopeRecord, queue, mapping, decision };
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

function count(database: IDBDatabase, storeName: string): Promise<number> {
  return requestResult(database.transaction(storeName, 'readonly').objectStore(storeName).count());
}
