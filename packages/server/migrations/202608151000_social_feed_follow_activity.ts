import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FIX-M-024 expand-only Follow-activity Feed contract: the kind may be unbound from a
 * Collection, but every follow_activity item must bind a deterministic Follow recheck key
 * and carry no Collection or publication revision. Existing collection_change rows keep
 * the original binding and positive commit ordinal.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE social_feed_items
    ALTER COLUMN collection_id DROP NOT NULL,
    ALTER COLUMN publication_revision DROP NOT NULL`.execute(db);
  // Evidence-seeded follow_activity rows carried the legacy Collection-bound shape; convert
  // them to the Follow recheck binding before the new constraints validate the table. The
  // transition guard is lifted only for this bounded rewrite and re-armed immediately.
  await sql`DROP TRIGGER social_feed_items_transition_guard ON social_feed_items`.execute(db);
  await sql`UPDATE social_feed_items
       set collection_id=null,
           publication_revision=null,
           source_commit_ordinal=0,
           discoverability_recheck_key='follow:' || actor_profile_id || ':' || recipient_profile_id
     where kind='follow_activity'
       and (collection_id is not null or publication_revision is not null
         or source_commit_ordinal <> 0
         or discoverability_recheck_key
           <> 'follow:' || actor_profile_id || ':' || recipient_profile_id)`.execute(db);
  await sql`CREATE TRIGGER social_feed_items_transition_guard
    BEFORE INSERT OR UPDATE ON social_feed_items FOR EACH ROW
    EXECUTE FUNCTION guard_social_feed_item_transition()`.execute(db);
  await sql`ALTER TABLE social_feed_items
    DROP CONSTRAINT IF EXISTS social_feed_items_source_commit_ordinal_check,
    DROP CONSTRAINT IF EXISTS social_feed_items_recheck_binding,
    DROP CONSTRAINT IF EXISTS social_feed_items_discoverability_recheck_key_check,
    ADD CONSTRAINT social_feed_items_commit_ordinal_check
      CHECK (source_commit_ordinal >= 0),
    ADD CONSTRAINT social_feed_items_kind_shape CHECK (
      (kind = 'collection_change' AND source_commit_ordinal > 0
        AND publication_revision IS NOT NULL)
      OR
      (kind = 'follow_activity' AND source_commit_ordinal = 0
        AND publication_revision IS NULL)
    ),
    ADD CONSTRAINT social_feed_items_recheck_binding CHECK (
      (kind = 'collection_change' AND collection_id IS NOT NULL
        AND discoverability_recheck_key = 'publication.collection:' || collection_id)
      OR
      (kind = 'follow_activity' AND collection_id IS NULL
        AND discoverability_recheck_key = 'follow:' || actor_profile_id || ':' || recipient_profile_id)
    ),
    ADD CONSTRAINT social_feed_items_recheck_key_length CHECK (
      length(discoverability_recheck_key) BETWEEN 1 AND 1024
    )`.execute(db);
}

/**
 * Developer-only rollback of the expand-only Follow-activity contract.
 * Drain FIX-M-024 Feed writers and delete follow_activity rows before migrating down;
 * the original NOT NULL columns reject unbound rows.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE social_feed_items
    DROP CONSTRAINT IF EXISTS social_feed_items_recheck_binding,
    DROP CONSTRAINT IF EXISTS social_feed_items_kind_shape,
    DROP CONSTRAINT IF EXISTS social_feed_items_commit_ordinal_check,
    DROP CONSTRAINT IF EXISTS social_feed_items_recheck_key_length,
    ADD CONSTRAINT social_feed_items_source_commit_ordinal_check
      CHECK (source_commit_ordinal > 0),
    ADD CONSTRAINT social_feed_items_recheck_binding CHECK (
      discoverability_recheck_key = 'publication.collection:' || collection_id
    ),
    ADD CONSTRAINT social_feed_items_discoverability_recheck_key_check CHECK (
      length(discoverability_recheck_key) BETWEEN 1 AND 512
    )`.execute(db);
  await sql`ALTER TABLE social_feed_items
    ALTER COLUMN collection_id SET NOT NULL,
    ALTER COLUMN publication_revision SET NOT NULL`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
