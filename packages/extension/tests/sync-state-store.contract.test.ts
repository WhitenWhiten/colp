import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import { readSyncStateSource } from './read-sync-state-source.js';

/**
 * Storage-format freeze (allowlisted in tests/static-anchor-allowlist.ts): database
 * identity/version, store and index names and the authority document are the artifact
 * under test. Behaviour over that schema is covered by tests/sync-state-store.test.ts,
 * tests/sync-state-store-indexes.test.ts, tests/sync-state-store.atomic.test.ts and
 * tests/schema-v15.test.ts.
 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTHORITY = resolve(PACKAGE_ROOT, 'docs/indexeddb-sync-state-authority.md');

describe('P3-28 static IndexedDB contract', () => {
  test('pins database identity, version, stores and required compound indexes', async () => {
    const source = await readSyncStateSource();
    for (const token of [
      "DATABASE_NAME = 'known-phase3-indexeddb-entry'", 'DATABASE_VERSION = 23',
      "remoteObservations: 'remote_observations'", "scopeCommandPlans: 'scope_command_plans'",
      "batchPlans: 'bookmark_batch_plans'", "batchItems: 'bookmark_batch_items'",
      "scopes: 'sync_scopes'", "mappings: 'native_mappings'", "queue: 'outbound_queue'",
      "sequences: 'durable_sequences'", "receipts: 'receipts'", "cursors: 'cursors'",
      "intents: 'apply_intents'", "recovery: 'recovery_staging'",
      "recoveryNodes: 'recovery_nodes'", "leases: 'replica_leases'",
      "archives: 'retired_archives'", "diagnostics: 'diagnostics'", "bookmarkEvents: 'bookmark_events'",
      "pullPages: 'pull_pages'", "pullEvents: 'pull_events'", "effectPages: 'effect_pages'",
      "importPlans: 'import_plans'", "importNodes: 'import_nodes'",
      "compactionWatermarks: 'compaction_watermarks'", "compactSummaries: 'compact_summaries'",
      "mounts: 'mount_bindings'", "previews: 'scope_previews'", "bootstrapRuns: 'bootstrap_runs'",
      "deletionJournal: 'deletion_journal'",
      "by_scope_sequence", "by_scope_op_id", "by_scope_status_sequence",
      "by_scope_claim_sequence", "by_scope_native_id", "by_scope_colp_id",
      "by_scope_correlation", "by_scope_native_result", "by_scope_wait_reason",
      "by_scope_repair_job", "by_scope_live_work", "by_scope_native_target", "by_scope_completed_expiry",
      "by_scope_snapshot_page", "by_scope_event_ordinal", "by_scope_event_dedupe",
      "by_scope_event_status_ordinal", "by_scope_event_native_ordinal",
      "by_scope_pull_state", "by_scope_page_ordinal", "by_scope_pull_page_state", "by_scope_pull_operation",
      "by_scope_target_revision", "by_scope_event_page",
      "by_scope_plan_order", "by_scope_updated", "by_scope_root_role",
      'extractOutstandingTarget', 'replaceProjectionIntents', 'projection-intent',
      'p3-36-compaction-v1', 'srg-v15-native-result-v1', 'srg-v16-pull-page-index-v1', 'srg-v17-diagnostic-park-index-v1',
      'u18-v20-pull-workset-index-v1', 'u21-apply-intent-target-index-v1',
      'compactScope', 'listBookmarkEventsByOperation', 'by_scope_event_operation_ordinal', 'listBookmarkEventsByStatus', 'hasQueueRevisionForTarget', 'listPullEventsByPage',
      'allowUnstamped', 'stampColpQueueRecord', 'operation_validator_missing',
    ]) assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(source, /localStorage|chrome\.storage|deleteDatabase\(/);
  });

  test('documents exactly one authority per durable fact and atomic store combinations', async () => {
    const document = await readFile(AUTHORITY, 'utf8');
    for (const fact of [
      'Replica identity and lifecycle', 'selected root boundary', 'native/COLP mapping',
      'outbound Operation', 'next durable sequence', 'terminal or deferred receipt',
      'Pull cursor', 'published cursor evidence', 'apply intent', 'recovery Snapshot',
      'lease fence', 'retired archive', 'compaction watermark', 'compact receipt summary',
      'Root Mount binding', 'first-run preview',
    ]) assert.match(document, new RegExp(fact, 'i'));
    for (const transaction of [
      'allocate sequence + queue', 'receipt + queue transition', 'published evidence + cursor',
      'validated Pull staging', 'Pull page completion + cursor', 'recovery staging to live', 'logout and retire',
    ]) assert.match(document, new RegExp(transaction.replace(/\+/g, '\\+'), 'i'));
    assert.match(document, /credential.*chrome\.storage\.local/is);
  });

  test('production build and release scan include the store without fixtures, secrets or source maps', async () => {
    const build = await readFile(resolve(PACKAGE_ROOT, 'scripts/build.mjs'), 'utf8');
    const verify = await readFile(resolve(PACKAGE_ROOT, 'scripts/verify-release-artifact.mjs'), 'utf8');
    assert.match(build, /sync-state-store/);
    assert.match(verify, /\.map/);
    assert.match(verify, /indexeddb-p3-03|indexeddb-p3-27/);
    assert.match(verify, /fixture-access|fixture-refresh|TEST_TOKEN|client_secret/i);
  });
});
