/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { DATABASE_NAME, DATABASE_VERSION, createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { readSyncStateSource } from './read-sync-state-source.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('IndexedDB v9 to v10', () => {
  test('preserves outbound_queue, native_mappings, and recovery_* rows byte-for-byte', async () => {
    const key = scopeKeyOf(scope);
    await seedV9(key);
    const before = await dump(indexedDB, 9, ['outbound_queue', 'native_mappings', 'recovery_staging', 'recovery_nodes']);
    const store = createSyncStateStore({ indexedDB });
    await store.open();
    const after = await dump(indexedDB, DATABASE_VERSION,
      ['outbound_queue', 'native_mappings', 'recovery_staging', 'recovery_nodes']);
    assert.deepEqual(after, before);
    const recorded = await store.getScope(scope);
    assert.equal(recorded?.legacyCanonicalRoot, 'colp-root-1');
    assert.equal(recorded?.firstRun, 'none');
    assert.equal(recorded?.mountMode, 'mounted-folder');
    assert.equal(recorded?.boundaryVersion, '0');
    assert.ok((await store.open()).objectStoreNames.contains('mount_bindings'));
  });

  test('fails closed when a v10 database is opened at version 9', async () => {
    await createSyncStateStore({ indexedDB }).open();
    const request = indexedDB.open(DATABASE_NAME, 9);
    await assert.rejects(() => requestValue(request), (error: unknown) => {
      assert.equal((error as Error).name, 'VersionError');
      return true;
    });
  });

  test('upgrade backfills sync_scopes only and does not cursor-scan queue or recovery stores', async () => {
    const source = await readSyncStateSource();
    const schema = await readFile(new URL('../src/sync-state/schema.ts', import.meta.url), 'utf8');
    assert.match(schema, /DATABASE_VERSION = 23/);
    assert.match(schema, /function backfillSyncScopesV10/);
    assert.match(schema, /oldVersion > DATABASE_VERSION/);
    const backfill = source.match(/function backfillSyncScopesV10\(tx: IDBTransaction\) \{[\s\S]*?\n\}/);
    assert.ok(backfill);
    assert.match(backfill[0]!, /objectStore\(STORES\.scopes\)/);
    assert.doesNotMatch(backfill[0]!, /outbound_queue|native_mappings|recovery_staging|bookmark_events/);
    const upgrade = source.match(/export function upgrade\([\s\S]*?\n\}/);
    assert.ok(upgrade);
    assert.doesNotMatch(upgrade[0]!, /objectStore\(STORES\.queue\)\.openCursor|objectStore\(STORES\.mappings\)\.openCursor/);
  });
});

function scopeKeyOf(value: SyncScope) {
  return JSON.stringify([
    value.environment, value.serverId, value.serverOrigin, value.accountId,
    value.browserProfileId, value.collectionId, value.replicaId, value.generation,
  ]);
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dump(factory: IDBFactory, version: number, stores: readonly string[]) {
  const db = await requestValue(factory.open(DATABASE_NAME, version));
  const tx = db.transaction([...stores], 'readonly');
  const result: Record<string, unknown[]> = {};
  for (const name of stores) result[name] = await readAll(tx.objectStore(name));
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
  return result;
}

function readAll(store: IDBObjectStore): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const values: unknown[] = [];
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) { resolve(values); return; }
      values.push(current.value);
      current.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

function seedV9(key: string): Promise<void> {
  const request = indexedDB.open(DATABASE_NAME, 9);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('sync_scopes', { keyPath: 'scopeKey' });
    const queue = db.createObjectStore('outbound_queue', { keyPath: ['scopeKey', 'sequence'] });
    queue.createIndex('by_scope_sequence', ['scopeKey', 'sequence'], { unique: true });
    queue.createIndex('by_scope_op_id', ['scopeKey', 'opId'], { unique: true });
    queue.createIndex('by_scope_status_sequence', ['scopeKey', 'status', 'sequence'], { unique: true });
    queue.createIndex('by_scope_claim_sequence', ['scopeKey', 'retry.ownerId', 'retry.fence', 'sequence']);
    const mappings = db.createObjectStore('native_mappings', { keyPath: ['scopeKey', 'nativeId'] });
    mappings.createIndex('by_scope_native_id', ['scopeKey', 'nativeId'], { unique: true });
    mappings.createIndex('by_scope_colp_id', ['scopeKey', 'colpId'], { unique: true });
    db.createObjectStore('recovery_staging', { keyPath: ['scopeKey', 'snapshotId'] });
    db.createObjectStore('recovery_nodes', { keyPath: ['scopeKey', 'snapshotId', 'colpId'] })
      .createIndex('by_scope_snapshot_page', ['scopeKey', 'snapshotId', 'page', 'colpId'], { unique: true });
    db.createObjectStore('durable_sequences', { keyPath: 'scopeKey' });
    db.createObjectStore('receipts', { keyPath: ['scopeKey', 'receiptId'] });
    db.createObjectStore('cursors', { keyPath: 'scopeKey' });
    db.createObjectStore('apply_intents', { keyPath: ['scopeKey', 'intentId'] });
    db.createObjectStore('replica_leases', { keyPath: 'scopeKey' });
    db.createObjectStore('retired_archives', { keyPath: ['scopeKey', 'retiredAt'] });
    db.createObjectStore('diagnostics', { keyPath: 'id' });
    db.createObjectStore('schema_metadata', { keyPath: 'key' });
    const events = db.createObjectStore('bookmark_events', { keyPath: ['scopeKey', 'eventId'] });
    events.createIndex('by_scope_event_ordinal', ['scopeKey', 'ordinal'], { unique: true });
    events.createIndex('by_scope_event_dedupe', ['scopeKey', 'dedupeKey'], { unique: true });
    events.createIndex('by_scope_event_status_ordinal', ['scopeKey', 'status', 'ordinal'], { unique: true });
    events.createIndex('by_scope_event_native_ordinal', ['scopeKey', 'nativeId', 'ordinal']);
    db.createObjectStore('pull_pages', { keyPath: ['scopeKey', 'pageId'] });
    db.createObjectStore('pull_events', { keyPath: ['scopeKey', 'eventId'] });
    db.createObjectStore('effect_pages', { keyPath: ['scopeKey', 'eventId', 'pageNumber'] });
    db.createObjectStore('sync_engine', { keyPath: 'scopeKey' });
    db.createObjectStore('ack_intents', { keyPath: ['scopeKey', 'intentId'] });
    db.createObjectStore('import_plans', { keyPath: ['scopeKey', 'planId'] });
    db.createObjectStore('import_nodes', { keyPath: ['scopeKey', 'planId', 'sourceNodeId'] });
    db.createObjectStore('compaction_watermarks', { keyPath: 'scopeKey' });
    db.createObjectStore('compact_summaries', { keyPath: ['scopeKey', 'kind', 'id'] });
  };
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(
        ['sync_scopes', 'outbound_queue', 'native_mappings', 'recovery_staging', 'recovery_nodes', 'schema_metadata'],
        'readwrite',
      );
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.objectStore('sync_scopes').put({
        ...scope, scopeKey: key, lifecycle: 'active',
        lease: { leaseId: 'lease-v9', expiresAt: 100 }, checkpoint: { serverRevision: 'rev-v9', cursor: 'cur-v9' },
        selectedRoots: ['colp-root-1'],
      });
      tx.objectStore('outbound_queue').put({
        scopeKey: key, sequence: 1, opId: 'op-v9', batchId: 'batch-v9', idempotencyKey: 'idem-v9',
        digest: 'sha256:op-v9', endpointIdentity: 'syncPush', mediaType: 'application/json',
        baseRevision: null, operationRevision: 'local-v9', status: 'pending',
        retry: { attempt: 0, notBefore: 0 }, payload: { type: 'create_node', preserved: true },
      });
      tx.objectStore('native_mappings').put({
        scopeKey: key, nativeId: 'native-v9', colpId: 'colp-root-1', rootNativeId: 'native-v9',
        projection: { revision: 'rev-v9', digest: 'sha256:map-v9' },
      });
      tx.objectStore('recovery_staging').put({
        scopeKey: key, snapshotId: 'snap-v9', sessionId: null, revision: 'rev-v9',
        syncCursor: 'spc2.snap-v9', identityDigest: 'id-v9', rootNodeId: 'colp-root-1',
        lastPage: 0, lastPageDigest: 'sha256:page-v9', nextCursor: null, complete: false,
      });
      tx.objectStore('recovery_nodes').put({
        scopeKey: key, snapshotId: 'snap-v9', page: 0, colpId: 'colp-node-v9', parentId: 'colp-root-1',
        position: '0', kind: 'Bookmark', payloadDigest: 'sha256:node-v9',
        mapping: { nativeId: 'native-node-v9', colpId: 'colp-node-v9', rootNativeId: 'native-v9',
          projection: { revision: 'rev-v9', digest: 'sha256:map-node-v9' } },
      });
      tx.objectStore('schema_metadata').put({ key: 'schema', version: 9, authorityDigest: 'p3-36-compaction-v1' });
    };
  });
}
