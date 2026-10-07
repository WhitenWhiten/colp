import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607252100_sync_conflict_resolution.ts', import.meta.url);
const portUrl = new URL('../../../src/infrastructure/sync/sync-conflict-resolution-postgres.ts', import.meta.url);

test('P3-18 migration admits exactly one conditional resolution and durable bound receipts', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  for (const required of [
    'resolved_by_operation_id', 'resolved_by_principal_id', 'resolution', 'resolution_result_json',
    'sync_conflict_resolution_receipts', 'principal_id', 'conflict_id', 'conflict_revision',
    'idempotency_key', 'request_digest', 'result_json', 'completed_at',
  ]) assert.match(source, new RegExp(required, 'iu'), required);
  assert.match(source, /UNIQUE\s*\(resolved_by_operation_id\)/iu);
  assert.match(source, /PRIMARY KEY\s*\(principal_id\s*,\s*conflict_id\s*,\s*conflict_revision\s*,\s*idempotency_key\)/iu);
  assert.match(source, /status\s*=\s*'open'.*status\s*=\s*'resolved'/isu);
  assert.match(source, /to_jsonb\(NEW\).*to_jsonb\(OLD\)/isu);
  assert.match(source, /forbid_sync_conflict_resolution_receipt_mutation/iu);
  assert.match(source, /OLD\.completed_at IS NULL.*NEW\.completed_at IS NOT NULL/isu);
  assert.match(source, /RAISE EXCEPTION.*immutable/isu);
});

test('P3-18 PostgreSQL port uses one transaction, Canonical Mutation and a conditional final update', async () => {
  const source = await readFile(portUrl, 'utf8');
  for (const required of [
    'createCanonicalMutationApplication', 'createPostgresCanonicalMutationPorts',
    "insertInto('sync_conflict_resolution_receipts')", "updateTable('sync_conflicts')",
    "where('status', '=', 'open')", "where('revision', '=', command.conflictRevision)",
    'numUpdatedRows !== 1n', 'request_digest', 'result_json', 'resolved_by_operation_id',
    'resolved_by_principal_id', 'before_receipt_finalize',
  ]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), required);
  assert.doesNotMatch(source, /updateTable\('operations'\)|deleteFrom\('operations'\)/u);
  assert.doesNotMatch(source, /@know-n\/colp\/src|@know-n\/colp\/dist/u);
});
