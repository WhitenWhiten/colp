import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

import { OPERATION_ARCHIVE_RELATION } from '../../../src/infrastructure/ledger-archive/production-sources.js';

const migrationUrl = new URL(
  '../../../migrations/202610010400_sync_history_floors.ts', import.meta.url,
);
const currentBindingUrl = new URL(
  '../../../migrations/202610010800_ledger_payload_purge_jobs.ts', import.meta.url,
);
const repositoryUrl = new URL(
  '../../../src/infrastructure/database/sync-history-floor-repository.ts', import.meta.url,
);

test('Sync history floor is expand-only, operation-only and fail-closed', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  for (const required of [
    'CREATE TABLE sync_history_floors',
    'floor_stream_kind smallint NOT NULL DEFAULT 0 CHECK (floor_stream_kind = 0)',
    "archive.ledger_family <> 'operation'",
    "archive.source_relation <> 'public.operations'", // historical expand; current binding is Q-009 registry
    "archive.source_scope <> 'collection:' || NEW.collection_id",
    "archive.source_key_kind <> 'bigint'",
    "archive.source_key_comparator <> 'signed-bigint-ascending-v1'",
    'lower(archive.source_key_bounds) <> 1',
    'upper(archive.source_key_bounds) <> NEW.floor_commit_ordinal + 1',
    'archive.row_count <> NEW.floor_commit_ordinal',
    'archive.source_bytes <= 0',
    'archive.archive_schema_version <> 1',
    'operation.sync_wire_json IS NOT NULL',
    "archive.state NOT IN (",
    'sync_history_floors_boundary_missing',
    'sync_history_floors_archive_not_verified',
    'sync_history_floors_binding_mismatch',
    'sync_history_floors_active_replica_behind',
    'LOCK TABLE sync_replicas IN SHARE MODE',
    'BEFORE TRUNCATE ON sync_history_floors',
  ]) assert.ok(source.includes(required), required);
  assert.doesNotMatch(source, /DELETE\s+FROM\s+(operations|sync_node_revision_history|sync_ack_receipts)/iu);
  assert.doesNotMatch(source, /UPDATE\s+sync_collection_purge_state/iu);
});

test('current history-floor binding uses the registry operation archive relation', async () => {
  const source = await readFile(currentBindingUrl, 'utf8');
  assert.ok(source.includes(`sql.raw("'${OPERATION_ARCHIVE_RELATION}'")`));
  assert.match(source, /OR archive.source_relation <> \$\{sourceRelation\}/u);
});

test('repository is CAS-only and exposes no archive or source deletion primitive', async () => {
  const source = await readFile(repositoryUrl, 'utf8');
  assert.match(source, /state_revision=state_revision\+1/iu);
  assert.match(source, /AND state_revision=\$\{BigInt\(input\.expectedStateRevision\)\}/u);
  assert.match(source, /LOCK TABLE sync_replicas IN SHARE MODE/iu);
  assert.doesNotMatch(source, /DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|DETACH\s+PARTITION/iu);
});
