import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FO-07 review: tombstoned nodes/collections must feed the favicon GC ledger.
 *
 * `bookmark_icons` had tombstone triggers that deleted the binding rows
 * outright, so deleting a bookmark (or a whole collection) silently orphaned
 * its immutable object: no `favicon_pending_deletions` row was ever written and
 * the R2 object leaked forever. The GC only ever collected objects retired by
 * a binding replacement.
 *
 * The triggers now record the retired binding FIRST, then delete it, with
 * `deletable_at = now() + FAVICON_HISTORY_RETENTION_SECONDS`. That constant is
 * pinned to exactly 31536000 by config parsing (`parseConstInt`), and one year
 * strictly covers the 30-day sync trash window as well, so a record is never
 * claimable while the trash could still reference the object. The value is
 * inlined because a migration cannot read application config; changing the
 * pinning constant requires a follow-up migration.
 *
 * The triggers stay in place for every writer (Product canonical delete,
 * recursive subtree delete, sync tombstone purge), including the raw
 * `update nodes set deleted_at = ...` statements the canonical ports issue.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION bookmark_icons_drop_on_node_tombstone() RETURNS trigger
    LANGUAGE plpgsql
    AS $bookmark_icons_node_tombstone$
    BEGIN
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        INSERT INTO favicon_pending_deletions (
          object_id, node_id, collection_id, retired_at, deletable_at,
          attempts, last_error, next_attempt_at, lease_owner, lease_until, created_at
        )
        SELECT bi.object_id, bi.node_id, bi.collection_id, current_timestamp,
               current_timestamp + interval '31536000 seconds',
               0, NULL, current_timestamp + interval '31536000 seconds', NULL, NULL,
               current_timestamp
        FROM bookmark_icons bi
        WHERE bi.node_id = NEW.id
        ON CONFLICT (object_id) DO NOTHING;
        DELETE FROM bookmark_icons WHERE node_id = NEW.id;
      END IF;
      RETURN NEW;
    END
    $bookmark_icons_node_tombstone$
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION bookmark_icons_drop_on_collection_tombstone() RETURNS trigger
    LANGUAGE plpgsql
    AS $bookmark_icons_collection_tombstone$
    BEGIN
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        INSERT INTO favicon_pending_deletions (
          object_id, node_id, collection_id, retired_at, deletable_at,
          attempts, last_error, next_attempt_at, lease_owner, lease_until, created_at
        )
        SELECT bi.object_id, bi.node_id, bi.collection_id, current_timestamp,
               current_timestamp + interval '31536000 seconds',
               0, NULL, current_timestamp + interval '31536000 seconds', NULL, NULL,
               current_timestamp
        FROM bookmark_icons bi
        WHERE bi.collection_id = NEW.id
        ON CONFLICT (object_id) DO NOTHING;
        DELETE FROM bookmark_icons WHERE collection_id = NEW.id;
      END IF;
      RETURN NEW;
    END
    $bookmark_icons_collection_tombstone$
  `.execute(db);
}

/** Developer-only rollback: restore the binding-only tombstone triggers. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION bookmark_icons_drop_on_node_tombstone() RETURNS trigger
    LANGUAGE plpgsql
    AS $bookmark_icons_node_tombstone$
    BEGIN
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        DELETE FROM bookmark_icons WHERE node_id = NEW.id;
      END IF;
      RETURN NEW;
    END
    $bookmark_icons_node_tombstone$
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION bookmark_icons_drop_on_collection_tombstone() RETURNS trigger
    LANGUAGE plpgsql
    AS $bookmark_icons_collection_tombstone$
    BEGIN
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        DELETE FROM bookmark_icons WHERE collection_id = NEW.id;
      END IF;
      RETURN NEW;
    END
    $bookmark_icons_collection_tombstone$
  `.execute(db);
}
