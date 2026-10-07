import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('shared-list collection_updated_at migration is expand-only with recency index and triggers', () => {
  const source = readFileSync(
    new URL('../../../migrations/202609120100_collection_members_shared_list_updated.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /collection_updated_at/u);
  assert.match(source, /ADD COLUMN collection_updated_at/u);
  assert.match(source, /CREATE INDEX collection_members_shared_list_updated_idx/u);
  assert.match(source, /CREATE TRIGGER collection_members_copy_collection_updated_at/u);
  assert.match(source, /BEFORE INSERT OR UPDATE OF collection_id/u);
  assert.match(source, /CREATE TRIGGER collections_fanout_collection_updated_at/u);
  assert.match(source, /AFTER UPDATE OF updated_at/u);
  assert.match(source, /CREATE FUNCTION collection_members_copy_collection_updated_at/u);
  assert.match(source, /CREATE FUNCTION collections_fanout_collection_updated_at/u);
  assert.match(source, /Index Scan on `collection_members_shared_list_updated_idx`/u);
  assert.match(source, /DROP INDEX IF EXISTS collection_members_shared_list_updated_idx/u);
  assert.match(source, /DROP TRIGGER IF EXISTS collection_members_copy_collection_updated_at ON collection_members/u);
  assert.match(source, /DROP TRIGGER IF EXISTS collections_fanout_collection_updated_at ON collections/u);
  assert.match(source, /DROP FUNCTION IF EXISTS collection_members_copy_collection_updated_at/u);
  assert.match(source, /DROP FUNCTION IF EXISTS collections_fanout_collection_updated_at/u);
  assert.match(source, /DROP COLUMN IF EXISTS collection_updated_at/u);
  assert.doesNotMatch(source, /DROP INDEX IF EXISTS collection_members_shared_list_idx/u);
  assert.doesNotMatch(source, /DROP COLUMN IF EXISTS (?!collection_updated_at)/u);
  assert.doesNotMatch(source, /DROP TABLE/u);
  assert.doesNotMatch(source, /sql\.raw/u);
  assert.doesNotMatch(stripBlockComments(source), /CREATE INDEX CONCURRENTLY/i);
});
