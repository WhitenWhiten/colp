import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const MIGRATION = new URL('../../../migrations/202607251900_sync_node_tombstones.ts', import.meta.url);
const PUSH_STACK = [
  new URL('../../../src/infrastructure/sync/sync-push-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-push-move-delete-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-push-repository-postgres.ts', import.meta.url),
];
const CANONICAL = new URL('../../../src/infrastructure/collections/canonical-mutation-postgres-ports.ts', import.meta.url);
const ROLLOUT = new URL('../../../migrations/README.md', import.meta.url);
const RETENTION = new URL('../../../migrations/202607310100_sync_tombstone_retention_config.ts', import.meta.url);
const CONSUME = new URL('../../../migrations/202610011800_nodes_folder_role_and_tombstone_consume.ts', import.meta.url);
const RESTORE = new URL('../../../src/infrastructure/sync/sync-node-restore-postgres.ts', import.meta.url);

describe('P3-15 durable Sync Node tombstone static contracts', () => {
  test('adds immutable per-Node membership with relational Operation and live Node authority', async () => {
    const source = await readFile(MIGRATION, 'utf8');
    assert.match(source, /CREATE TABLE sync_node_tombstones/i);
    assert.match(source, /PRIMARY KEY \(collection_id, target_id\)/i);
    assert.match(source, /REFERENCES nodes\(collection_id, id\) ON DELETE RESTRICT/i);
    assert.match(source, /REFERENCES sync_node_revision_history\(collection_id, resource_id, revision\)/i);
    assert.match(source, /REFERENCES operations\(operation_id, collection_id, commit_ordinal\)/i);
    assert.match(source, /delete_commit_ordinal bigint NOT NULL/i);
    assert.match(source, /purge_after timestamptz NOT NULL/i);
    assert.match(source, /immutable/i);
    assert.match(source, /IS NOT DISTINCT FROM/i);
    assert.match(source, /forbid_sync_tombstoned_node_resurrection/i);
    assert.doesNotMatch(source, /ON DELETE CASCADE/i);
    assert.doesNotMatch(source, /purged_through|acknowledged|recovery_required/i);
  });

  test('composes delete through the existing Sequence transaction and Canonical Mutation', async () => {
    const push = (await Promise.all(PUSH_STACK.map((url) => readFile(url, 'utf8')))).join('\n');
    const canonical = await readFile(CANONICAL, 'utf8');
    assert.match(push, /evaluateCanonicalNodeDelete/);
    assert.match(push, /transaction\.databaseTransaction/);
    assert.match(push, /createCanonicalMutationApplication/);
    assert.match(push, /createPostgresSyncNodeTombstonePort\(tx\)\.append\(/);
    assert.match(push, /deletedResourceRevisions/);
    assert.doesNotMatch(push, /coordinatePushTransaction|coordinateSessionBoundPush|applyPublisherOperations/);
    assert.match(canonical, /deleted_at is null/i);
    assert.doesNotMatch(canonical, /ON DELETE CASCADE/i);
  });

  test('documents expand-first retention and keeps purge, Ack and sync Profile out of P3-15', async () => {
    const source = await readFile(ROLLOUT, 'utf8');
    assert.match(source, /Sync durable Node tombstone rollout/i);
    assert.match(source, /202607251900_sync_node_tombstones/);
    assert.match(source, /minimum retention/i);
    assert.match(source, /rollback the writer before migrating down/i);
    assert.match(source, /does not implement (?:Ack|purge)/i);
  });

  test('P3-38 binds Sync tombstone retention to the advertised deployment contract', async () => {
    const [push, migration, rollout] = await Promise.all([
      Promise.all(PUSH_STACK.map((url) => readFile(url, 'utf8'))).then((parts) => parts.join('\n')),
      readFile(RETENTION, 'utf8'), readFile(ROLLOUT, 'utf8'),
    ]);
    assert.match(push, /tombstoneRetentionSeconds/u);
    assert.match(push, /resolveTombstoneRetentionMs/u);
    assert.match(push, /purgeAfter: new Date\(deletedAt\.getTime\(\) \+ tombstoneRetentionMs\)/u);
    assert.match(migration, /DROP CONSTRAINT IF EXISTS sync_node_tombstones_check/u);
    assert.match(migration, /DROP CONSTRAINT IF EXISTS sync_node_tombstones_purge_after_check/u);
    assert.match(migration, /CHECK \(purge_after >= deleted_at\)/u);
    assert.match(rollout, /SYNC_TOMBSTONE_RETENTION_SECONDS/u);
  });

  test('KNS-06 lets restore consume an unpurged tombstone and keeps purged rows', async () => {
    const [source, restore, canonical] = await Promise.all([
      readFile(CONSUME, 'utf8'), readFile(RESTORE, 'utf8'), readFile(CANONICAL, 'utf8'),
    ]);
    assert.match(source, /IF TG_OP = 'DELETE' THEN[\s\S]*OLD\.payload_purged_at IS NULL THEN[\s\S]*RETURN OLD/u);
    assert.match(source, /purged sync Node Tombstone must not be deleted/u);
    assert.match(source, /unpurged consume/u);
    assert.match(restore, /canonical\.execute[\s\S]*action: 'restore'/u);
    assert.doesNotMatch(restore, /deleteFrom\('sync_node_tombstones'\)/u);
    assert.match(canonical, /mutation\.action === 'restore'[\s\S]*deleteFrom\('sync_node_tombstones'\)[\s\S]*payload_purged_at',\s*'is',\s*null/u);
  });

  test('KNS-06 flushes deferred node constraints before CREATE INDEX', async () => {
    const source = await readFile(CONSUME, 'utf8');
    const updateAt = source.indexOf('UPDATE nodes');
    const flushAt = source.indexOf('SET CONSTRAINTS ALL IMMEDIATE');
    const indexAt = source.indexOf('CREATE UNIQUE INDEX nodes_live_special_folder_role_uidx');
    assert.ok(updateAt >= 0, 'backfill UPDATE nodes');
    assert.ok(flushAt > updateAt, 'SET CONSTRAINTS ALL IMMEDIATE after UPDATE nodes');
    assert.ok(indexAt > flushAt, 'CREATE UNIQUE INDEX after flushing deferred constraints');
  });

  test('FRR-05 recovered uniqueness is per parent and does not use CONCURRENTLY', async () => {
    const migration = new URL('../../../migrations/202610012100_recovered_unique_per_parent.ts', import.meta.url);
    const create = new URL('../../../src/infrastructure/sync/postgres/sync-recovered-create-postgres.ts', import.meta.url);
    const lookup = new URL('../../../src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts', import.meta.url);
    const [source, restore, recoveredCreate, recoveredLookup] = await Promise.all([
      readFile(migration, 'utf8'), readFile(RESTORE, 'utf8'), readFile(create, 'utf8'), readFile(lookup, 'utf8'),
    ]);
    assert.match(source, /DROP INDEX IF EXISTS nodes_live_special_folder_role_uidx/);
    assert.match(source, /folder_role IN \('bookmarks-bar','other-bookmarks','mobile-bookmarks'\)/);
    assert.match(source, /nodes_live_recovered_parent_uidx/);
    assert.match(source, /folder_role = 'recovered'/);
    assert.doesNotMatch(source, /CREATE UNIQUE INDEX CONCURRENTLY/i);
    assert.match(recoveredLookup, /parent_id = \$\{parentId\}[\s\S]*folder_role = 'recovered'/);
    assert.match(recoveredCreate, /mapSyncNodeCreateOperation/);
    assert.match(recoveredCreate, /syncCanonicalMutationInput/);
    assert.doesNotMatch(recoveredCreate, /invalidateSyncReplicasOnNodeMutation/);
    assert.doesNotMatch(restore, /INSERT INTO nodes/i);
  });
});
