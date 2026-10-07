import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const MIGRATION = new URL('../../../migrations/202607251700_sync_node_create.ts', import.meta.url);
const PUSH_STACK = [
  new URL('../../../src/infrastructure/sync/sync-push-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts', import.meta.url),
];
const CONFIG_SYNC = new URL('../../../src/bootstrap/config-sync.ts', import.meta.url);
const CONFIG = new URL('../../../src/bootstrap/config.ts', import.meta.url);
const ROLLOUT = new URL('../../../migrations/README.md', import.meta.url);

describe('P3-12 canonical Sync Node create static contract', () => {
  test('expands canonical Node authority for Separator without adding another mutation ledger', async () => {
    const source = await readFile(MIGRATION, 'utf8');
    assert.match(source, /P3-12 expand/i);
    assert.match(source, /nodes.*separator/is);
    assert.match(source, /CHECK.*folder.*bookmark.*separator/is);
    assert.doesNotMatch(source, /CREATE TABLE\s+(?:sync_)?(?:node_mutations|sync_operations|sync_receipts)/i);
    assert.match(source, /developer-only destructive rollback/i);
  });

  test('composes the create evaluator through Sequence transaction and never imports Push coordinator', async () => {
    const source = (await Promise.all(PUSH_STACK.map((url) => readFile(url, 'utf8')))).join('\n');
    assert.match(source, /createCanonicalMutationApplication/);
    assert.match(source, /transaction\.databaseTransaction/);
    assert.match(source, /operationIdClaimOwner/);
    assert.match(source, /canonical_node_create/);
    assert.match(source, /evaluateUnsupportedSyncOperation/);
    assert.doesNotMatch(source, /coordinatePushTransaction|coordinateSessionBoundPush|applyPublisherOperations/);
  });

  test('managed bookmark writes are explicit deployment config and default fail closed', async () => {
    const source = await readFile(CONFIG_SYNC, 'utf8');
    assert.match(source, /SYNC_MANAGED_BOOKMARK_WRITES/);
    assert.match(source, /managedBookmarkWrites/);
    assert.match(source, /\?\? 'false'/);
    const facade = await readFile(CONFIG, 'utf8');
    assert.match(facade, /loadSyncSessionConfig/);
  });

  test('documents expand-first rollout and non-data-preserving downgrade', async () => {
    const source = await readFile(ROLLOUT, 'utf8');
    assert.match(source, /Sync canonical Node create rollout/i);
    assert.match(source, /202607251700_sync_node_create/);
    assert.match(source, /N\/N-1/i);
    assert.match(source, /rollback the writer before migrating down/i);
  });
});
