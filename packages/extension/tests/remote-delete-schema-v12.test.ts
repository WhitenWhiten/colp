import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { createSyncStateStore, DATABASE_NAME, DATABASE_VERSION } from '../src/sync-state-store.js';
import { STORES } from '../src/sync-state/schema.js';
import { scope } from './kns-03-bootstrap-harness.js';

describe('schema v12 remote-delete migration contract', () => {
  test('upgrades a real v11 database without changing durable rows and starts new stores empty', async () => {
    const indexedDB = new IDBFactory();
    const fixture = await seedV11(indexedDB);
    const store = createSyncStateStore({ indexedDB });
    const database = await store.open();

    assert.equal(database.version, DATABASE_VERSION);
    assert.ok(database.objectStoreNames.contains(STORES.remoteDeletePolicies));
    assert.ok(database.objectStoreNames.contains(STORES.remoteDeleteDecisions));
    assert.ok(database.objectStoreNames.contains(STORES.localSyncExclusions));
    assert.equal(await count(database, STORES.remoteDeletePolicies), 0);
    assert.equal(await count(database, STORES.remoteDeleteDecisions), 0);
    assert.equal(await count(database, STORES.localSyncExclusions), 0);

    const exported = await store.exportScope(scope);
    assert.deepEqual(exported.scope, fixture.scopeRecord);
    assert.deepEqual(exported.queue, [fixture.queue]);
    assert.deepEqual(exported.mappings, [fixture.mapping]);
    assert.deepEqual(exported.advancedPlans, [fixture.plan]);
    assert.equal(exported.remoteDeletePolicy, null);
    assert.deepEqual(exported.remoteDeleteDecisions, []);
    assert.deepEqual(exported.localSyncExclusions, []);
  });

  test('a v11 binary cannot reopen a database after the v12 upgrade', async () => {
    const indexedDB = new IDBFactory();
    await seedV11(indexedDB);
    const store = createSyncStateStore({ indexedDB });
    await store.open();
    store.close();

    const request = indexedDB.open(DATABASE_NAME, 11);
    const result = await new Promise<unknown>((resolve) => {
      request.onerror = () => resolve(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve(new Error('v11 binary unexpectedly opened v12 database'));
      };
    });
    assert.equal((result as DOMException).name, 'VersionError');
  });
});

interface V11Fixture {
  readonly scopeRecord: Record<string, unknown>;
  readonly queue: Record<string, unknown>;
  readonly mapping: Record<string, unknown>;
  readonly plan: Record<string, unknown>;
}

async function seedV11(indexedDB: IDBFactory): Promise<V11Fixture> {
  const request = indexedDB.open(DATABASE_NAME, 11);
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
    db.createObjectStore(STORES.advancedPlans, { keyPath: ['scopeKey', 'planId'] });
    db.createObjectStore(STORES.advancedSteps, { keyPath: ['scopeKey', 'planId', 'order'] });
    db.createObjectStore(STORES.metadata, { keyPath: 'key' });
  };
  const database = await requestResult(request);
  const key = JSON.stringify([
    scope.environment, scope.serverId, scope.serverOrigin, scope.accountId,
    scope.browserProfileId, scope.collectionId, scope.replicaId, scope.generation,
  ]);
  const scopeRecord = {
    ...scope, scopeKey: key, lifecycle: 'active', lease: { leaseId: 'lease-v11', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-v11', cursor: 'cursor-v11' }, selectedRoots: [],
  };
  const queue = {
    scopeKey: key, sequence: 8, opId: 'op-v11', batchId: 'batch-v11', idempotencyKey: 'idem-v11',
    digest: 'sha256:queue-v11', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-v10', operationRevision: 'revision-v11', status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: { type: 'create_node', targetId: 'node-v11' },
  };
  const mapping = {
    scopeKey: key, nativeId: 'native-v11', colpId: 'node-v11', rootNativeId: 'root-v11',
    projection: { revision: 'revision-v11', digest: 'sha256:mapping-v11' },
  };
  const plan = {
    scopeKey: key, planId: 'plan-v11', digest: 'sha256:plan-v11', metadata: { mode: 'download' },
    stepCount: 0, state: 'completed', updatedAt: 11,
  };
  const transaction = database.transaction([
    STORES.scopes, STORES.queue, STORES.mappings, STORES.advancedPlans, STORES.metadata,
  ], 'readwrite');
  transaction.objectStore(STORES.scopes).put(scopeRecord);
  transaction.objectStore(STORES.queue).put(queue);
  transaction.objectStore(STORES.mappings).put(mapping);
  transaction.objectStore(STORES.advancedPlans).put(plan);
  transaction.objectStore(STORES.metadata).put({ key: 'schema', version: 11, authorityDigest: 'p3-36-compaction-v1' });
  await transactionComplete(transaction);
  database.close();
  return { scopeRecord, queue, mapping, plan };
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
