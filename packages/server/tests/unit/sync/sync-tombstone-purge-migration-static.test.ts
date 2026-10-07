import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607252400_sync_tombstone_purge.ts', import.meta.url);
const coordinatorUrl = new URL('../../../src/infrastructure/sync/sync-tombstone-purge-postgres.ts', import.meta.url);
const replicaUrl = new URL('../../../src/infrastructure/sync/replica-postgres.ts', import.meta.url);
const retentionContractUrl = new URL('../../../migrations/202609030100_sync_tombstone_retention_contract.ts', import.meta.url);
const configSyncUrl = new URL('../../../src/bootstrap/config-sync.ts', import.meta.url);
const configUrl = new URL('../../../src/bootstrap/config.ts', import.meta.url);
const manifestUrl = new URL('../../../src/modules/publication/application/manifest-candidate.ts', import.meta.url);

test('P3-23 migration creates collection-scoped purge authority and fenced job state', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  for (const fragment of [
    'CREATE TABLE sync_collection_purge_state',
    'purged_through_commit_ordinal',
    'purged_through_stream_kind',
    'purged_through_stable_id',
    'state_revision',
    'lease_token',
    'lease_generation',
    'lease_expires_at',
    'attempt_count',
    'sync_collection_purge_state_revision_fence',
    'CREATE TABLE sync_purged_node_id_watermarks',
    'delete_commit_ordinal',
    'delete_revision',
    'purge_state_revision',
  ]) assert.match(source, new RegExp(fragment, 'u'));
  assert.match(source, /PRIMARY KEY\s*\(collection_id\)/u);
  assert.match(source, /PRIMARY KEY\s*\(collection_id, target_id\)/u);
  assert.match(source, /sync_collection_purge_state_tuple_check/u);
  assert.match(source, /sync_collection_purge_state_lease_check/u);
  assert.match(source, /sync_purged_node_id_watermarks_immutable/u);
  assert.match(source, /forbid_sync_tombstoned_node_resurrection/u);
  assert.match(source, /FROM sync_purged_node_id_watermarks watermark/u);
  assert.match(source, /BEFORE INSERT OR UPDATE OR DELETE ON nodes/u);
});

test('P3-23 purge and new Replica creation serialize on the Collection authority row', async () => {
  const [coordinator, replica] = await Promise.all([
    readFile(coordinatorUrl, 'utf8'), readFile(replicaUrl, 'utf8'),
  ]);
  assert.match(coordinator, /selectFrom\('collections'\)[\s\S]*?forUpdate\(\)/u);
  assert.match(replica, /forUpdate\('collections'\)/u);
  assert.match(coordinator, /replica\.status='active'/u);
  assert.match(coordinator, /checkpoint_commit_ordinal === null/u);
  assert.match(coordinator, /checkpoint_stable_id/u);
  assert.match(coordinator, /FOR SHARE OF replica/u);
});

test('P3-23 migration supports bounded eligibility and permits only payload compaction', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.match(source, /sync_node_tombstones_purge_candidate_idx/u);
  assert.match(source, /collection_id, delete_commit_ordinal, operation_id, target_id/u);
  assert.match(source, /extensions/u);
  assert.match(source, /payload_json/u);
  assert.match(source, /forbid_sync_node_tombstone_mutation/u);
  assert.match(source, /OLD\.payload_json/u);
  assert.doesNotMatch(source, /DELETE FROM\s+(?:sync_node_tombstones|operations|audit_events|resource_id_ledger)/iu);
  assert.doesNotMatch(source, /native_id|bookmark_title|bookmark_url/iu);
});

test('FIX-L-034 forward migration restores the 30-day CHECK without purging existing rows', async () => {
  const source = await readFile(retentionContractUrl, 'utf8');
  assert.match(source, /DROP CONSTRAINT IF EXISTS sync_node_tombstones_check/u);
  assert.match(source, /DROP CONSTRAINT IF EXISTS sync_node_tombstones_purge_after_check/u);
  assert.match(source, /ADD CONSTRAINT sync_node_tombstones_purge_after_check/u);
  assert.match(source, /CHECK \(purge_after >= deleted_at \+ interval '30 days'\)/u);
  assert.match(source, /NOT VALID/u);
  assert.doesNotMatch(source, /DELETE FROM|UPDATE sync_node_tombstones/iu);
});

test('FIX-L-034 config parsing and the Manifest enforce the shared 30-day floor', async () => {
  const [config, facade, manifest] = await Promise.all([
    readFile(configSyncUrl, 'utf8'), readFile(configUrl, 'utf8'), readFile(manifestUrl, 'utf8'),
  ]);
  assert.match(config, /TOMBSTONE_RETENTION_BOUNDS\.minSeconds/u);
  assert.match(facade, /loadSyncSessionConfig/u);
  assert.match(manifest, /TOMBSTONE_RETENTION_BOUNDS\.minSeconds/u);
  assert.match(manifest, /cursorRetentionSeconds < TOMBSTONE_RETENTION_BOUNDS\.minSeconds/u);
});
