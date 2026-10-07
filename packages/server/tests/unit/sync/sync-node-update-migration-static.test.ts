import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const MIGRATION = new URL('../../../migrations/202607251800_sync_node_revision_history.ts', import.meta.url);
const PUSH_STACK = [
  new URL('../../../src/infrastructure/sync/sync-push-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts', import.meta.url),
];
const EVALUATOR = new URL('../../../src/modules/sync/sync-node-update.ts', import.meta.url);
const CANONICAL = new URL('../../../src/infrastructure/collections/canonical-mutation-postgres-ports.ts', import.meta.url);
const ROLLOUT = new URL('../../../migrations/README.md', import.meta.url);

describe('P3-13 typed update static contracts', () => {
  test('adds immutable Collection-scoped revision payload history with expand backfill', async () => {
    const source = await readFile(MIGRATION, 'utf8');
    assert.match(source, /CREATE TABLE sync_node_revision_history/i);
    assert.match(source, /PRIMARY KEY \(collection_id, resource_id, revision\)/i);
    assert.match(source, /REFERENCES nodes\(collection_id, id\)/i);
    assert.match(source, /DEFERRABLE INITIALLY DEFERRED/i);
    assert.match(source, /INSERT INTO sync_node_revision_history[\s\S]*SELECT[\s\S]*payload_json/i);
    assert.match(source, /immutable/i);
    assert.doesNotMatch(source, /CREATE TABLE\s+(?:sync_)?conflicts/i);
  });

  test('loads Base and Current in the Sequence transaction and invokes public COLP merge', async () => {
    const push = (await Promise.all(PUSH_STACK.map((url) => readFile(url, 'utf8')))).join('\n');
    const evaluator = await readFile(EVALUATOR, 'utf8');
    assert.match(push, /evaluateCanonicalNodeUpdate/);
    assert.match(push, /transaction\.databaseTransaction/);
    assert.match(push, /sync_node_revision_history/);
    assert.match(push, /forUpdate\(\)/);
    assert.match(push, /evaluateSyncNodeUpdate/);
    assert.match(evaluator, /validateSyncTypedUpdateOperationPayload/);
    assert.match(evaluator, /mergeSyncTypedUpdate/);
    assert.match(evaluator, /sync_conflict_pending/);
    assert.doesNotMatch(push, /coordinatePushTransaction|coordinateSessionBoundPush|applyPublisherOperations/);
    const canonical = await readFile(CANONICAL, 'utf8');
    assert.match(canonical, /sync_node_revision_history/);
    assert.match(canonical, /mutation\.fields!\.extensions/);
  });

  test('documents expand compatibility, retention, and writer-first rollback', async () => {
    const source = await readFile(ROLLOUT, 'utf8');
    assert.match(source, /Sync typed Node update rollout/i);
    assert.match(source, /202607251800_sync_node_revision_history/);
    assert.match(source, /N\/N-1/i);
    assert.match(source, /immutable/i);
    assert.match(source, /rollback the writer before migrating down/i);
  });
});
