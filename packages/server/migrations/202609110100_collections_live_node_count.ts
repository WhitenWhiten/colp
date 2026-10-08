import { sql, type Kysely, type Migration } from 'kysely';

/**
 * P-04 expand-only: materialize live node counts on collections.
 * Directory reads `live_node_count` instead of a correlated `count(*)` on nodes.
 * The trigger is the canonical mutator (editor HTTP, sync, restore, soft-delete).
 * N-1 binaries ignore the column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE collections
      ADD COLUMN live_node_count integer NOT NULL DEFAULT 0
      CONSTRAINT collections_live_node_count_non_negative CHECK (live_node_count >= 0)
  `.execute(db);
  await sql`
    UPDATE collections AS c
       SET live_node_count = (
         SELECT count(*)::int
           FROM nodes AS n
          WHERE n.collection_id = c.id
            AND n.deleted_at IS NULL
       )
  `.execute(db);
  await sql`
    CREATE FUNCTION collections_apply_live_node_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $live_node_count$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.deleted_at IS NULL THEN
          UPDATE collections
             SET live_node_count = live_node_count + 1
           WHERE id = NEW.collection_id;
        END IF;
        RETURN NEW;
      ELSIF TG_OP = 'DELETE' THEN
        IF OLD.deleted_at IS NULL THEN
          UPDATE collections
             SET live_node_count = live_node_count - 1
           WHERE id = OLD.collection_id;
        END IF;
        RETURN OLD;
      ELSE
        IF OLD.collection_id IS DISTINCT FROM NEW.collection_id THEN
          IF OLD.deleted_at IS NULL THEN
            UPDATE collections
               SET live_node_count = live_node_count - 1
             WHERE id = OLD.collection_id;
          END IF;
          IF NEW.deleted_at IS NULL THEN
            UPDATE collections
               SET live_node_count = live_node_count + 1
             WHERE id = NEW.collection_id;
          END IF;
        ELSIF (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL) THEN
          IF NEW.deleted_at IS NULL THEN
            UPDATE collections
               SET live_node_count = live_node_count + 1
             WHERE id = NEW.collection_id;
          ELSE
            UPDATE collections
               SET live_node_count = live_node_count - 1
             WHERE id = NEW.collection_id;
          END IF;
        END IF;
        RETURN NEW;
      END IF;
    END
    $live_node_count$
  `.execute(db);
  await sql`
    CREATE TRIGGER nodes_live_node_count
    AFTER INSERT OR DELETE OR UPDATE OF deleted_at, collection_id
    ON nodes
    FOR EACH ROW
    EXECUTE FUNCTION collections_apply_live_node_count()
  `.execute(db);
  // Count updates rewrite collections.live_node_count only. The deferred
  // root-lifecycle constraint trigger must not fire on those writes: a
  // soft-deleted root would otherwise be checked against a still-live
  // collection row from the count bump, and fail closed (23514).
  await sql`DROP TRIGGER IF EXISTS collections_root_lifecycle_integrity ON collections`.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER collections_root_lifecycle_integrity
    AFTER INSERT OR UPDATE OF deleted_at, root_node_id ON collections
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION validate_collection_root_lifecycle()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS collections_root_lifecycle_integrity ON collections`.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER collections_root_lifecycle_integrity
    AFTER INSERT OR UPDATE ON collections
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION validate_collection_root_lifecycle()
  `.execute(db);
  await sql`DROP TRIGGER IF EXISTS nodes_live_node_count ON nodes`.execute(db);
  await sql`DROP FUNCTION IF EXISTS collections_apply_live_node_count()`.execute(db);
  await sql`ALTER TABLE collections DROP COLUMN IF EXISTS live_node_count`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
