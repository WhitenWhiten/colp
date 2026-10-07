import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { LEDGER_CAPACITY_TARGETS } from '../../../src/infrastructure/database/ledger-capacity.js';
import {
  collectMigrationAppendHeavyComments,
  defaultMigrationDirectory,
  diffAppendHeavyCompleteness,
  parseAppendHeavyCommentedTables,
} from '../../../src/infrastructure/database/ledger-append-heavy-completeness.js';
import { LEDGER_RETENTION_POLICIES } from '../../../src/infrastructure/database/ledger-retention-policy.js';

test('capacity and retention views are generated from one append-authority table set', () => {
  assert.deepEqual(
    LEDGER_CAPACITY_TARGETS.map((target) => `${target.tableName}:${target.family}`),
    LEDGER_RETENTION_POLICIES.map((policy) => `${policy.tableName}:${policy.family}`),
  );
});

test('migration comments and the typed registry are a closed pair', () => {
  const commented = collectMigrationAppendHeavyComments(defaultMigrationDirectory());
  assert.deepEqual(diffAppendHeavyCompleteness(commented), []);
  assert.deepEqual([...commented].sort(),
    [...LEDGER_CAPACITY_TARGETS.map((target) => target.tableName)].sort());
});

test('deleting a registry row or adding a synthetic append-heavy table fails completeness', () => {
  const registered = LEDGER_CAPACITY_TARGETS.map((target) => target.tableName);
  const commented = [...registered];
  assert.ok(diffAppendHeavyCompleteness(commented, registered.slice(1))
    .some((issue) => issue.code === 'unregistered_append_heavy_table'));
  assert.ok(diffAppendHeavyCompleteness([...commented, 'synthetic_append_heavy'], registered)
    .some((issue) => issue.code === 'unregistered_append_heavy_table'
      && issue.tableName === 'synthetic_append_heavy'));
  assert.ok(diffAppendHeavyCompleteness(commented.slice(1), registered)
    .some((issue) => issue.code === 'registered_table_missing_comment'));
});

test('comment parser reads literal COMMENT ON TABLE contracts', async () => {
  const source = await readFile(new URL(
    '../../../migrations/202610011300_ledger_append_heavy_comments.ts', import.meta.url,
  ), 'utf8');
  const tables = parseAppendHeavyCommentedTables(source);
  assert.ok(tables.includes('sync_pull_page_evidence'));
  assert.ok(tables.includes('sync_node_tombstones'));
  assert.equal(tables.length, LEDGER_CAPACITY_TARGETS.length);
});
