import { sql, type Kysely, type Migration } from 'kysely';

/**
 * R11 member-recall search indexes.
 *
 * Authenticated member recall must not fall back to a broad scan after escaping the
 * public partial GINs. This expand migration adds:
 *
 * - member-compatible GINs for collections/nodes/annotations whose partial predicate
 *   drops the `visibility='public'` (collections/annotations) or `visibility='inherit'`
 *   (nodes) restriction, so the member-authorized recall branches stay index-backed;
 * - an annotation member authority order index mirroring the existing public
 *   `annotations_search_authority_order_idx` without the visibility restriction, so a
 *   membership-driven annotation walk stays bounded;
 * - membership-set authority indexes (`collections.owner_subject_id`,
 *   `collection_members.subject_id`) so the materialized actor collection set is built
 *   with bounded index lookups instead of scanning the collections/membership relations.
 *
 * The public branches continue to use the existing partial GINs unchanged.
 * Kysely runs PostgreSQL migrations in one transaction — CREATE INDEX CONCURRENTLY is unavailable.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX collections_search_member_trgm_idx
    ON collections USING gin (search_text public.gin_trgm_ops)
    WHERE deleted_at IS NULL AND allow_search_indexing`.execute(db);
  await sql`CREATE INDEX collections_search_member_vector_idx
    ON collections USING gin (search_vector)
    WHERE deleted_at IS NULL AND allow_search_indexing`.execute(db);
  await sql`CREATE INDEX nodes_search_member_trgm_idx
    ON nodes USING gin (search_text public.gin_trgm_ops)
    WHERE deleted_at IS NULL AND NOT is_root`.execute(db);
  await sql`CREATE INDEX nodes_search_member_vector_idx
    ON nodes USING gin (search_vector)
    WHERE deleted_at IS NULL AND NOT is_root`.execute(db);
  await sql`CREATE INDEX annotations_search_member_trgm_idx
    ON annotations USING gin (annotation_search_text public.gin_trgm_ops)
    WHERE deleted_at IS NULL AND type <> 'reading_state'`.execute(db);
  await sql`CREATE INDEX annotations_search_member_vector_idx
    ON annotations USING gin (annotation_search_vector)
    WHERE deleted_at IS NULL AND type <> 'reading_state'`.execute(db);
  await sql`CREATE INDEX annotations_search_member_authority_order_idx
    ON annotations (collection_id, subject_type COLLATE "C", subject_id COLLATE "C", id COLLATE "C")
    WHERE deleted_at IS NULL AND type <> 'reading_state'`.execute(db);
  await sql`CREATE INDEX collections_search_member_owner_idx
    ON collections (owner_subject_id)
    WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX collection_members_search_member_subject_idx
    ON collection_members (subject_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collection_members_search_member_subject_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_search_member_owner_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS annotations_search_member_authority_order_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS annotations_search_member_vector_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS annotations_search_member_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS nodes_search_member_vector_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS nodes_search_member_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_search_member_vector_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_search_member_trgm_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
