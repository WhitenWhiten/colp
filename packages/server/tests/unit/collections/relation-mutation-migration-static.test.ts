import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607250500_relation_mutation_cascade.ts', import.meta.url);
const rolloutUrl = new URL('../../../migrations/README.md', import.meta.url);

test('P2B-11 removes the temporary endpoint delete blocker only after canonical cascade exists', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.match(source, /DROP TRIGGER IF EXISTS nodes_live_relation_integrity ON nodes/u);
  assert.match(source, /DROP FUNCTION IF EXISTS prevent_live_relation_endpoint_delete/u);
  assert.match(source, /canonical Relation cascade/u);
  assert.doesNotMatch(source, /ON DELETE CASCADE/u);
});

test('P2B-11 rollout fixes lock order, cascade evidence and rollback boundary', async () => {
  const source = await readFile(rolloutUrl, 'utf8');
  assert.match(source, /Relation update and delete rollout/u);
  assert.match(source, /Collection.*Relation.*Node/u);
  assert.match(source, /canonical cascade/u);
  assert.match(source, /drain all N-1 Node mutation writers/u);
  assert.match(source, /ID ledger/u);
  assert.match(source, /rollback the writer before restoring/u);
});
