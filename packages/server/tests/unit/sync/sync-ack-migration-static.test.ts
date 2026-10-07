import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607252300_sync_acknowledgements.ts', import.meta.url);

test('P3-22 migration owns immutable issued cursor evidence and Ack receipts', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  for (const fragment of [
    'CREATE TABLE sync_pull_cursor_evidence',
    'cursor_digest',
    'session_id',
    'replica_id',
    'collection_id',
    'lease_generation',
    'policy_revision',
    'cursor_expires_at',
    'upper_commit_ordinal',
    'upper_stream_kind',
    'upper_stable_id',
    'collection_revision',
    'page_limit',
    'purge_commit_ordinal',
    'CREATE TABLE sync_ack_receipts',
    'request_digest',
    'result_json',
    'completed_at',
    'sync_pull_cursor_evidence_immutable',
    'sync_ack_receipts_immutable',
  ]) assert.match(source, new RegExp(fragment, 'u'));
  assert.match(source, /UNIQUE\s*\(replica_id, cursor_digest\)/u);
  assert.match(source, /FOREIGN KEY\s*\(\s*session_id, principal_id, collection_id, replica_id, lease_generation, cursor_digest\s*\)/u);
  assert.match(source, /PRIMARY KEY\s*\(principal_id, idempotency_key\)/u);
  assert.doesNotMatch(source, /authorization|credential_digest|secret_digest|bookmark|native_id|url\b/iu);
});

test('P3-22 migration adds the full monotonic Replica checkpoint tuple', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.match(source, /checkpoint_stream_kind/u);
  assert.match(source, /checkpoint_stable_id/u);
  assert.match(source, /sync_replicas_checkpoint_tuple_check/u);
  assert.match(source, /CREATE INDEX sync_pull_cursor_evidence_scope_tuple_idx/u);
  assert.match(source, /Developer-only destructive rollback/u);
});
