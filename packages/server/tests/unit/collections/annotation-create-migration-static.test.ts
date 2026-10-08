import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607250100_annotations.ts', import.meta.url);
const rolloutUrl = new URL('../../../migrations/README.md', import.meta.url);

test('annotation expand migration owns canonical rows without cascade semantics', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  for (const column of [
    'id', 'collection_id', 'subject_type', 'subject_id', 'creator_principal_id',
    'type', 'visibility', 'resource_revision', 'created_at', 'updated_at',
    'deleted_at', 'deleted_commit_ordinal', 'payload_json',
  ]) assert.match(source, new RegExp(`\\b${column}\\b`, 'u'));

  assert.match(source, /CREATE TABLE annotations/u);
  assert.match(source, /REFERENCES resource_id_ledger\(resource_id\) ON DELETE RESTRICT/u);
  assert.match(source, /REFERENCES collections\(id\) ON DELETE RESTRICT/u);
  assert.match(source, /subject_type IN \('collection','node'\)/u);
  assert.match(source, /type IN \('note','summary','tldr','highlight','rating','custom'\)/u);
  assert.match(source, /visibility IN \('public','unlisted','protected','private'\)/u);
  assert.match(source, /annotations_live_subject_count_idx/u);
  assert.match(source, /annotations_live_collection_updated_idx/u);
  assert.match(source, /collection_mutation_projection_resources_resource_type_check/u);
  assert.match(source, /resource_type IN \('collection', 'node', 'annotation'\)/u);
  assert.match(source, /WHERE deleted_at IS NULL/u);
  assert.doesNotMatch(source, /ON DELETE CASCADE/u);
});

test('annotation rollout documents expand-first N/N-1 deployment and rollback order', async () => {
  const source = await readFile(rolloutUrl, 'utf8');
  assert.match(source, /Annotation canonical create rollout/u);
  assert.match(source, /202607250100_annotations\.ts/u);
  assert.match(source, /N\/N-1/u);
  assert.match(source, /expand/u);
  assert.match(source, /rollback the writer before migrating down/u);
});
