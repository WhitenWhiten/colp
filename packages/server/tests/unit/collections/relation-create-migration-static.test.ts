import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607250400_relations.ts', import.meta.url);
const rolloutUrl = new URL('../../../migrations/README.md', import.meta.url);

test('relation expand migration owns endpoint authority and explicit live-edge semantics', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  for (const column of [
    'id', 'collection_id', 'from_node_id', 'to_node_id', 'type', 'label',
    'visibility', 'resource_revision', 'created_at', 'updated_at', 'deleted_at',
    'deleted_commit_ordinal', 'payload_json',
  ]) assert.match(source, new RegExp(`\\b${column}\\b`, 'u'));

  assert.match(source, /CREATE TABLE relations/u);
  assert.match(source, /REFERENCES resource_id_ledger\(resource_id\) ON DELETE RESTRICT/u);
  assert.match(source, /REFERENCES collections\(id\) ON DELETE RESTRICT/u);
  assert.match(source, /from_node_id <> to_node_id/u);
  assert.match(source, /type IN \('related','precedes','follows','supports','contradicts','duplicate_of','derived_from','mentions','custom'\)/u);
  assert.match(source, /relations_live_semantic_edge_uidx/u);
  assert.match(source, /collection_id, from_node_id, to_node_id, type/u);
  assert.match(source, /WHERE deleted_at IS NULL/u);
  assert.match(source, /validate_relation_endpoints/u);
  assert.match(source, /resource_type IN \('collection', 'node', 'annotation', 'relation'\)/u);
  assert.doesNotMatch(source, /ON DELETE CASCADE/u);
});

test('relation rollout documents expand-first N/N-1 deployment, semantic identity and rollback order', async () => {
  const source = await readFile(rolloutUrl, 'utf8');
  assert.match(source, /Relation canonical create rollout/u);
  assert.match(source, /202607250400_relations\.ts/u);
  assert.match(source, /N\/N-1/u);
  assert.match(source, /\(collection_id, from_node_id, to_node_id, type\)/u);
  assert.match(source, /self relation/u);
  assert.match(source, /rollback the writer before migrating down/u);
});
