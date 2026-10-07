import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607252200_sync_pull_stream.ts', import.meta.url);
const portUrl = new URL('../../../src/infrastructure/sync/postgres/sync-pull-postgres.ts', import.meta.url);
const pullPersistenceClusterUrls = [
  portUrl,
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-authority-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-cursor-codec-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-cursor-evidence.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-recovery-postgres.ts', import.meta.url),
];
const streamReaderUrl = new URL(
  '../../../src/infrastructure/sync/postgres/sync-operation-payload-reader.ts',
  import.meta.url,
);
const applicationUrl = new URL('../../../src/modules/sync/application/sync-pull.ts', import.meta.url);

async function readPullPersistenceCluster(): Promise<string> {
  return (await Promise.all(pullPersistenceClusterUrls.map((url) => readFile(url, 'utf8')))).join('\n');
}

test('P3-20 migration stores protocol Operation projection and matching keyset indexes', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.match(source, /ADD COLUMN sync_wire_json jsonb/iu);
  assert.match(source, /ADD COLUMN pull_wire_json jsonb/iu);
  assert.match(source, /GENERATED ALWAYS AS \(0\) STORED/iu);
  assert.match(source, /GENERATED ALWAYS AS \(1\) STORED/iu);
  assert.match(source, /operations_sync_pull_order_idx[\s\S]*collection_id\s*,\s*commit_ordinal\s*,\s*sync_stream_kind\s*,\s*operation_id COLLATE "C"/iu);
  assert.match(source, /sync_conflicts_pull_order_idx[\s\S]*collection_id\s*,\s*commit_ordinal\s*,\s*sync_stream_kind\s*,\s*conflict_id COLLATE "C"/iu);
  assert.match(source, /INCLUDE \(sync_wire_json\)/iu);
  assert.match(source, /INCLUDE \(pull_wire_json\)/iu);
  assert.match(source, /resolved_at'[\s\S]*'sync_stream_kind'/iu);
  assert.match(source, /WHERE sync_wire_json IS NOT NULL/iu);
  assert.match(source, /sync_conflicts_pull_order_idx/iu);
  assert.doesNotMatch(source, /updated_at|OFFSET/iu);
});

test('P3-20 PostgreSQL port imports the stream reader and keeps authority checks without private Conflict payload', async () => {
  const [source, application] = await Promise.all([
    readPullPersistenceCluster(), readFile(applicationUrl, 'utf8'),
  ]);
  assert.match(source, /from '\.\/sync-operation-payload-reader\.js'/u);
  assert.match(source, /readSyncPullStreamCut/u);
  for (const required of [
    "where('scope', '=', 'sync:pull')", "replica.status === 'active'",
    'lease_generation', 'policy_revision', 'capabilities_json.read',
  ]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), required);
  assert.doesNotMatch(source, /OFFSET|updated_at|private_payload_(?:ciphertext|iv|auth_tag|digest)/iu);
  assert.doesNotMatch(source, /@know-n\/colp\/(?:src|dist)/u);
  assert.match(source, /createValidatorRegistry/u);
  assert.match(application, /known\/sync\/pull-cursor\/v1/u);
  assert.match(application, /SYNC_PULL_STREAM_KIND_ORDER/u);
});

test('P3-20 stream reader owns the exact tuple comparator and UNION ALL order', async () => {
  const source = await readFile(streamReaderUrl, 'utf8');
  for (const required of [
    'commit_ordinal', 'stream_kind', 'stable_id', 'UNION ALL',
    'ORDER BY commit_ordinal, stream_kind, stable_id',
    '(operation.commit_ordinal, operation.sync_stream_kind, operation.operation_id COLLATE "C") >',
    '(conflict.commit_ordinal, conflict.sync_stream_kind, conflict.conflict_id COLLATE "C") >',
    'LIMIT ${limit + 1}',
  ]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), required);
  assert.doesNotMatch(source, /OFFSET|updated_at|private_payload_(?:ciphertext|iv|auth_tag|digest)/iu);
  assert.doesNotMatch(source, /OperationPayloadSource|archiveSource|readOperationPayload/u);
});
