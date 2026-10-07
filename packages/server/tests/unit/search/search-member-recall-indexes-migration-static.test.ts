import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const migrationUrl = new URL(
  '../../../migrations/202608011200_search_member_recall_indexes.ts',
  import.meta.url,
);
const cleanupMigrationUrl = new URL(
  '../../../migrations/202609260500_drop_redundant_indexes.ts',
  import.meta.url,
);

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('R11 member-recall search index migration static contract', () => {
  test('adds member-compatible GINs, a member authority order index, and membership-set authority indexes without touching public indexes', async () => {
    const source = await readFile(migrationUrl, 'utf8');

    // Member-compatible collection GINs drop only the visibility restriction.
    assert.match(source, /CREATE INDEX collections_search_member_trgm_idx/i);
    assert.match(source, /USING gin \(search_text public\.gin_trgm_ops\)/i);
    assert.match(source, /WHERE deleted_at IS NULL AND allow_search_indexing/i);
    assert.match(source, /CREATE INDEX collections_search_member_vector_idx/i);
    assert.match(source, /USING gin \(search_vector\)/i);
    assert.match(source, /WHERE deleted_at IS NULL AND allow_search_indexing/i);

    // Member-compatible node GINs drop only the inherit-visibility restriction.
    assert.match(source, /CREATE INDEX nodes_search_member_trgm_idx/i);
    assert.match(source, /USING gin \(search_text public\.gin_trgm_ops\)/i);
    assert.match(source, /WHERE deleted_at IS NULL AND NOT is_root/i);
    assert.match(source, /CREATE INDEX nodes_search_member_vector_idx/i);
    assert.match(source, /USING gin \(search_vector\)/i);
    assert.match(source, /WHERE deleted_at IS NULL AND NOT is_root/i);

    // Member-compatible annotation GINs drop only the public-visibility restriction.
    assert.match(source, /CREATE INDEX annotations_search_member_trgm_idx/i);
    assert.match(source, /USING gin \(annotation_search_text public\.gin_trgm_ops\)/i);
    assert.match(source, /WHERE deleted_at IS NULL AND type <> 'reading_state'/i);
    assert.match(source, /CREATE INDEX annotations_search_member_vector_idx/i);
    assert.match(source, /USING gin \(annotation_search_vector\)/i);
    assert.match(source, /WHERE deleted_at IS NULL AND type <> 'reading_state'/i);

    // Annotation member authority order index mirrors the public authority order index
    // without the visibility='public' restriction.
    assert.match(source, /CREATE INDEX annotations_search_member_authority_order_idx/i);
    assert.match(source, /collection_id, subject_type COLLATE "C", subject_id COLLATE "C", id COLLATE "C"/i);
    assert.match(source, /WHERE deleted_at IS NULL AND type <> 'reading_state'/i);

    // Membership-set authority indexes keep the materialized actor collection set bounded.
    assert.match(source, /CREATE INDEX collections_search_member_owner_idx/i);
    assert.match(source, /ON collections \(owner_subject_id\)/i);
    assert.match(source, /WHERE deleted_at IS NULL/i);
    assert.match(source, /CREATE INDEX collection_members_search_member_subject_idx/i);
    assert.match(source, /ON collection_members \(subject_id\)/i);

    // down drops only this migration's objects, never the pre-existing public indexes.
    for (const name of [
      'collection_members_search_member_subject_idx', 'collections_search_member_owner_idx',
      'annotations_search_member_authority_order_idx', 'annotations_search_member_vector_idx',
      'annotations_search_member_trgm_idx', 'nodes_search_member_vector_idx',
      'nodes_search_member_trgm_idx', 'collections_search_member_vector_idx',
      'collections_search_member_trgm_idx',
    ]) {
      assert.match(source, new RegExp(`DROP INDEX IF EXISTS ${name}`, 'i'));
    }
    for (const publicName of [
      'collections_search_trgm_idx', 'collections_search_vector_idx', 'collections_search_authority_order_idx',
      'nodes_search_trgm_idx', 'nodes_search_vector_idx', 'nodes_search_authority_order_idx',
      'annotations_search_trgm_idx', 'annotations_search_vector_idx', 'annotations_search_authority_order_idx',
      'profile_handles_search_exact_prefix_idx', 'profile_handles_search_trgm_idx',
      'profiles_search_display_trgm_idx', 'profiles_search_display_vector_idx',
      'collections_search_profile_owner_idx',
    ]) {
      assert.doesNotMatch(source, new RegExp(`DROP INDEX IF EXISTS ${publicName}`, 'i'));
    }

    // Kysely runs migrations inside one transaction: no CONCURRENTLY and no forcing GUCs.
    assert.doesNotMatch(stripBlockComments(source), /CREATE INDEX CONCURRENTLY/i);
    assert.doesNotMatch(source, /enable_(seqscan|sort|indexscan|bitmapscan)/i);
    assert.match(source, /Kysely runs PostgreSQL migrations in one transaction/i);
  });

  test('the T-09 cleanup drops only the prefix-covered owner index and restores it verbatim on down', async () => {
    const source = await readFile(cleanupMigrationUrl, 'utf8');

    // collections_search_member_owner_idx (owner_subject_id) WHERE deleted_at
    // IS NULL is prefix-covered by collections_owned_live_updated_id_idx
    // (202607260100) with the identical live-rows predicate.
    assert.match(source, /DROP INDEX IF EXISTS collections_search_member_owner_idx/);

    // Every other R11 member index survives the cleanup.
    for (const name of [
      'collections_search_member_trgm_idx', 'collections_search_member_vector_idx',
      'nodes_search_member_trgm_idx', 'nodes_search_member_vector_idx',
      'annotations_search_member_trgm_idx', 'annotations_search_member_vector_idx',
      'annotations_search_member_authority_order_idx',
      'collection_members_search_member_subject_idx',
    ]) {
      assert.doesNotMatch(source, new RegExp(`DROP INDEX IF EXISTS ${name}\\b`, 'i'));
    }
    // The covering owned-list index itself is never touched.
    assert.doesNotMatch(source, /DROP INDEX IF EXISTS collections_owned_live_updated_id_idx/i);

    // The developer-only down restores the exact original R11 definition.
    assert.match(source,
      /CREATE INDEX collections_search_member_owner_idx\s+ON collections \(owner_subject_id\)\s+WHERE deleted_at IS NULL/);

    // Same transaction rules as every production migration.
    assert.doesNotMatch(stripBlockComments(source), /CREATE INDEX CONCURRENTLY/i);
    assert.doesNotMatch(source, /enable_(seqscan|sort|indexscan|bitmapscan)/i);
  });
});
