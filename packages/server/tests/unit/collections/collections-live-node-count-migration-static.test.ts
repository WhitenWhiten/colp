import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

test('live_node_count migration is expand-only with a nodes trigger and no unrelated drops', () => {
  const source = readFileSync(
    new URL('../../../migrations/202609110100_collections_live_node_count.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /live_node_count/u);
  assert.match(source, /CREATE TRIGGER nodes_live_node_count/u);
  assert.match(source, /AFTER INSERT OR DELETE OR UPDATE OF deleted_at, collection_id/u);
  assert.match(source, /CREATE FUNCTION collections_apply_live_node_count/u);
  assert.match(source, /ADD COLUMN live_node_count/u);
  assert.match(source, /CHECK \(live_node_count >= 0\)/u);
  assert.match(source, /DROP TRIGGER IF EXISTS nodes_live_node_count ON nodes/u);
  assert.match(source, /DROP FUNCTION IF EXISTS collections_apply_live_node_count/u);
  assert.match(source, /DROP COLUMN IF EXISTS live_node_count/u);
  assert.match(source, /DROP TRIGGER IF EXISTS collections_root_lifecycle_integrity ON collections/u);
  assert.match(source, /AFTER INSERT OR UPDATE OF deleted_at, root_node_id ON collections/u);
  assert.doesNotMatch(source, /DROP COLUMN IF EXISTS (?!live_node_count)/u);
  assert.doesNotMatch(source, /owner_subject_id/u);
  assert.doesNotMatch(source, /DROP TABLE/u);
  assert.doesNotMatch(source, /sql\.raw/u);
});
