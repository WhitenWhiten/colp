import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { DATABASE_NAME, createSyncStateStore } from '../src/sync-state-store.js';

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('P3-28 legacy migration and upgrade rollback', () => {
  test('upgrades real P3-03 v2 and P3-27 preformal fixtures without losing pending facts', async () => {
    const legacy = JSON.parse(await readFile(new URL('./fixtures/indexeddb-p3-03-v2.json', import.meta.url), 'utf8'));
    const preformal = JSON.parse(await readFile(new URL('./fixtures/indexeddb-p3-27-preformal.json', import.meta.url), 'utf8'));
    await createSyncStateStore({ indexedDB }).seedLegacyForMigration(legacy);
    const store = createSyncStateStore({ indexedDB }); await store.open();
    const imported = await store.importPreformalBinding(preformal);
    assert.equal((await store.listQueue(imported)).length, 0);
    const legacyExport = await store.exportLegacyDiagnostic();
    assert.equal(legacyExport.unackedQueue[0]?.opId, 'op-legacy-41');
    assert.equal(legacyExport.receipts[0]?.receiptId, 'receipt-legacy-41');
    assert.equal(legacyExport.intents[0]?.intentId, 'intent-legacy');
    const database = await store.open();
    // Independently maintained store list. Do not derive from production
    // STORES — this assertion is the check that schema and tests stay in sync.
    // v15 adds apply_intents indexes and schema_metadata `v15-backfill`, not a store.
    assert.deepEqual(Array.from(database.objectStoreNames), ['ack_intents', 'apply_intents',
      'bookmark_batch_items', 'bookmark_batch_plans', 'bookmark_events',
      'bootstrap_advanced_plans', 'bootstrap_advanced_steps', 'bootstrap_runs', 'classification_confirmation_intents', 'compact_summaries', 'compaction_watermarks', 'cursors', 'deletion_journal',
      'diagnostics', 'durable_sequences',
      'effect_pages', 'import_nodes', 'import_plans', 'local_sync_exclusions', 'mount_bindings', 'native_mappings', 'outbound_queue',
      'pull_events', 'pull_pages', 'receipts', 'recovery_nodes', 'recovery_staging', 'remote_delete_decisions',
      'remote_delete_members', 'remote_delete_policies', 'remote_observations', 'replica_leases',
      'retired_archives', 'schema_metadata', 'scope_command_plans', 'scope_previews', 'sync_engine', 'sync_scopes']);
  });

  test('upgrades the real P3-03 v1 object store through the same preservation bridge', async () => {
    const legacy = JSON.parse(await readFile(new URL('./fixtures/indexeddb-p3-03-v1.json', import.meta.url), 'utf8'));
    await createSyncStateStore({ indexedDB }).seedLegacyForMigration(legacy);
    const store = createSyncStateStore({ indexedDB }); await store.open();
    const exported = await store.exportLegacyDiagnostic();
    assert.equal(exported.unackedQueue[0]?.sequence, 41);
    assert.equal(exported.receipts[0]?.operationDigest, 'sha256:phase3-fixed-operation');
    assert.equal(exported.intents[0]?.correlationId, 'native-correlation-41');
  });

  test('aborted upgrade leaves the old database version and unacked state readable for diagnosis', async () => {
    const legacy = JSON.parse(await readFile(new URL('./fixtures/indexeddb-p3-03-v2.json', import.meta.url), 'utf8'));
    await createSyncStateStore({ indexedDB }).seedLegacyForMigration(legacy);
    const failed = createSyncStateStore({ indexedDB, injectUpgradeFailure: true });
    await assert.rejects(() => failed.open(), /upgrade_failed/);
    const diagnostic = await failed.exportLegacyDiagnostic();
    assert.equal(diagnostic.unackedQueue[0]?.opId, 'op-legacy-41');
    assert.equal(diagnostic.receipts[0]?.receiptId, 'receipt-legacy-41');
    const request = indexedDB.open(DATABASE_NAME, 2);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = database.transaction('replica_state', 'readonly');
    const read = tx.objectStore('replica_state').get(['server-legacy', 'collection-legacy', 'replica-legacy']);
    const preserved = await new Promise<any>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
    });
    assert.equal(preserved.queuedOperation.opId, 'op-legacy-41'); database.close();
  });
});
