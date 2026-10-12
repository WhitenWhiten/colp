import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { DATABASE_NAME, DATABASE_VERSION, createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { STORES } from '../src/sync-state/schema.js';
import { exclusionSourceKind } from '../src/sync-state/scope-facts-repository.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('S-01 durable facts schema v14', () => {
  test('upgrades v13 without rewriting queue or mapping rows', async () => {
    const fixture = await seedV13(indexedDB);
    const store = createSyncStateStore({ indexedDB });
    const database = await store.open();
    assert.equal(database.version, DATABASE_VERSION);
    assert.ok(database.objectStoreNames.contains(STORES.remoteObservations));
    assert.ok(database.objectStoreNames.contains(STORES.scopeCommandPlans));
    const exported = await store.exportScope(scope);
    assert.deepEqual(exported.queue, [fixture.queue]);
    assert.deepEqual(exported.mappings, [fixture.mapping]);
    assert.deepEqual(exported.remoteObservations, []);
    assert.deepEqual(exported.scopeCommandPlans, []);
  });

  test('range-exit commits observation, exclusion, and mapping drop together', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({
      ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [],
    });
    await store.putMapping(scope, {
      nativeId: 'native-1', colpId: 'node-1', rootNativeId: 'native-root',
      projection: { revision: 'r1', digest: 'sha256:landed' },
    });
    await store.commitRangeExitFacts(scope, {
      observation: {
        colpId: 'node-1', remoteRevision: 'r2', cursor: 'c1', kind: 'placement',
        payload: { parentId: 'other-colp' }, sourceDigest: 'sha256:obs', observedAt: 20,
      },
      exclusion: {
        nativeId: 'native-1', decisionId: 'cmd-range-1', rootNativeId: 'native-root',
        generation: 1, sourceKind: 'range_exit', priorColpId: 'node-1',
      },
      dropMappingNativeId: 'native-1',
      command: {
        commandId: 'cmd-range-1', kind: 'rangeExit', confirmationVersion: '1',
        baselineDigest: 'sha256:base', phase: 'applying', dependencies: [], updatedAt: 20,
        mountId: 'mount-bar',
      },
    });
    assert.equal(await store.getMappingByNativeId(scope, 'native-1'), null);
    const observation = await store.getRemoteObservation(scope, 'node-1');
    assert.equal(observation?.remoteRevision, 'r2');
    const exclusion = await store.getLocalSyncExclusion(scope, 'native-1');
    assert.equal(exclusionSourceKind(exclusion!), 'range_exit');
    assert.equal(exclusion?.decisionId, 'cmd-range-1');
    assert.equal((await store.getScopeCommandPlan(scope, 'cmd-range-1'))?.phase, 'applying');
  });

  test('mount pause baseline persists without rewriting other mount fields', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({
      ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [],
    });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
      boundaryVersion: '1', materialized: true, status: 'detached', rootRole: 'bookmarks-bar',
    });
    const recorded = await store.putMountPauseBaseline(scope, 'mount-bar', {
      generation: 1, boundaryVersion: '1', lastAppliedCursor: 'c0', completeness: 'complete',
    });
    assert.equal(recorded.status, 'detached');
    assert.equal(recorded.pauseBaseline?.lastAppliedCursor, 'c0');
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.pauseBaseline?.completeness, 'complete');
  });

  test('a v13 binary cannot reopen a v14 database', async () => {
    await createSyncStateStore({ indexedDB }).open();
    const request = indexedDB.open(DATABASE_NAME, 13);
    const result = await new Promise<unknown>((resolve) => {
      request.onerror = () => resolve(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve(new Error('v13 binary unexpectedly opened v14 database'));
      };
    });
    assert.equal((result as DOMException).name, 'VersionError');
  });
});

async function seedV13(factory: IDBFactory) {
  const request = factory.open(DATABASE_NAME, 13);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore(STORES.scopes, { keyPath: 'scopeKey' });
    db.createObjectStore(STORES.mappings, { keyPath: ['scopeKey', 'nativeId'] });
    db.createObjectStore(STORES.queue, { keyPath: ['scopeKey', 'sequence'] });
    db.createObjectStore(STORES.metadata, { keyPath: 'key' });
  };
  const database = await requestResult(request);
  const key = JSON.stringify([
    scope.environment, scope.serverId, scope.serverOrigin, scope.accountId,
    scope.browserProfileId, scope.collectionId, scope.replicaId, scope.generation,
  ]);
  const scopeRecord = {
    ...scope, scopeKey: key, lifecycle: 'active', lease: { leaseId: 'lease-v13', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-v13', cursor: 'cursor-v13' }, selectedRoots: [],
  };
  const queue = {
    scopeKey: key, sequence: 9, opId: 'op-v13', batchId: 'batch-v13', idempotencyKey: 'idem-v13',
    digest: 'sha256:queue-v13', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-v12', operationRevision: 'revision-v13', status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: { type: 'create_node', targetId: 'node-v13' },
  };
  const mapping = {
    scopeKey: key, nativeId: 'native-v13', colpId: 'node-v13', rootNativeId: 'root-v13',
    projection: { revision: 'revision-v13', digest: 'sha256:mapping-v13' },
  };
  const tx = database.transaction([STORES.scopes, STORES.queue, STORES.mappings, STORES.metadata], 'readwrite');
  tx.objectStore(STORES.scopes).put(scopeRecord);
  tx.objectStore(STORES.queue).put(queue);
  tx.objectStore(STORES.mappings).put(mapping);
  tx.objectStore(STORES.metadata).put({ key: 'schema', version: 13, authorityDigest: 'p3-36-compaction-v1' });
  await transactionComplete(tx);
  database.close();
  return { queue, mapping };
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
