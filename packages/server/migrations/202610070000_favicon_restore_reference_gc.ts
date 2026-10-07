import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FO-C-03: close the GC leak of force-window restore references.
 *
 * When a node/collection is deleted inside an apply_force_online window (or
 * the account is deleted), the `favicon_source_restores` row referencing the
 * ORIGINAL object vanishes — via the consume path (restore_sources job),
 * the node/collection tombstone (which never touched restore rows), or the
 * account FK cascade — while the referenced original object never entered
 * `favicon_pending_deletions`. The GC worker treats a restore-referenced
 * object as a hard reference (`isObjectReferenced`), so the original leaked
 * forever after its reference record disappeared.
 *
 * Fix, all in this migration:
 *  1. An AFTER DELETE trigger on favicon_source_restores ledgers
 *     `original_object_id` into `favicon_pending_deletions` (standard one-year
 *     retention, ON CONFLICT DO NOTHING). This covers the consume path AND
 *     the account-deletion FK cascade (row-level AFTER DELETE triggers fire
 *     on cascaded deletes). If the object was NOT re-bound (restore never
 *     ran) it becomes claimable; if it WAS re-bound, the GC's
 *     isObjectReferenced recheck skips it — safe by construction.
 *  2. The node/collection tombstone functions additionally delete the
 *     node's/collection's `favicon_source_restores` rows, which fires the
 *     same trigger — the tombstoned original is now reclaimed too.
 *
 * `down` removes the trigger and restores the original tombstone bodies.
 * `up` is re-entrant (CREATE OR REPLACE + DROP TRIGGER IF EXISTS).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION favicon_source_restores_retire_original_on_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $favicon_source_restores_delete$
    BEGIN
      IF OLD.original_object_id IS NOT NULL THEN
        -- Only release the original when it is no longer the live binding.
        -- A restore_sources consume re-binds the original (applyRestoreCas
        -- upserts bookmark_icons with original_object_id before the restore
        -- row is deleted), so a pending row here would be permanently
        -- referenced and the GC worker would spin on it forever.
        INSERT INTO favicon_pending_deletions (
          object_id, node_id, collection_id, retired_at, deletable_at,
          attempts, last_error, next_attempt_at, lease_owner, lease_until, created_at
        )
        SELECT OLD.original_object_id, OLD.node_id, OLD.collection_id, current_timestamp,
               current_timestamp + interval '31536000 seconds',
               0, NULL, current_timestamp + interval '31536000 seconds', NULL, NULL,
               current_timestamp
        WHERE NOT EXISTS (
          SELECT 1 FROM bookmark_icons bi WHERE bi.object_id = OLD.original_object_id
        )
        ON CONFLICT (object_id) DO NOTHING;
      END IF;
      RETURN OLD;
    END
    $favicon_source_restores_delete$
  `.execute(db);
  await sql`DROP TRIGGER IF EXISTS favicon_source_restores_retire_original ON favicon_source_restores`.execute(db);
  await sql`
    CREATE TRIGGER favicon_source_restores_retire_original
    AFTER DELETE ON favicon_source_restores FOR EACH ROW
    EXECUTE FUNCTION favicon_source_restores_retire_original_on_delete()
  `.execute(db);

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
        -- FO-C-03: tombstoned nodes must also release their force-restore
        -- reference (fires the retire trigger above).
        DELETE FROM favicon_source_restores WHERE node_id = NEW.id;
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
        -- FO-C-03: collection tombstone releases every restore reference.
        DELETE FROM favicon_source_restores WHERE collection_id = NEW.id;
      END IF;
      RETURN NEW;
    END
    $bookmark_icons_collection_tombstone$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS favicon_source_restores_retire_original ON favicon_source_restores`.execute(db);
  await sql`DROP FUNCTION IF EXISTS favicon_source_restores_retire_original_on_delete()`.execute(db);
  // Restore the pre-FO-C-03 tombstone bodies (202610012700 originals).
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

export const migration: Migration = { up, down };
export default migration;