import { sql, type Kysely, type Migration } from 'kysely';

/**
 * BF-03: collections-owned bookmark_icons binding (1:1 with bookmark nodes).
 * Soft-delete of nodes does not fire ON DELETE CASCADE; application hooks and
 * the tombstone triggers below remove rows in the same transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE bookmark_icons (
      node_id         text PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      collection_id   text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
      object_id       uuid NOT NULL,
      content_type    text NOT NULL,
      byte_size       integer NOT NULL,
      digest_sha256   bytea NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT bookmark_icons_object_id_unique UNIQUE (object_id),
      CONSTRAINT bookmark_icons_content_type_canonical CHECK (
        content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/x-icon')
      ),
      CONSTRAINT bookmark_icons_byte_size_range CHECK (byte_size BETWEEN 1 AND 65536),
      CONSTRAINT bookmark_icons_digest_sha256_len CHECK (octet_length(digest_sha256) = 32)
    )
  `.execute(db);
  await sql`
    CREATE INDEX bookmark_icons_collection_id_idx
      ON bookmark_icons (collection_id)
  `.execute(db);
  await sql`
    CREATE FUNCTION bookmark_icons_require_live_bookmark() RETURNS trigger
    LANGUAGE plpgsql
    AS $bookmark_icons_kind$
    DECLARE
      n record;
    BEGIN
      SELECT kind, collection_id, deleted_at INTO n FROM nodes WHERE id = NEW.node_id;
      IF n IS NULL
         OR n.kind <> 'bookmark'
         OR n.collection_id IS DISTINCT FROM NEW.collection_id
         OR n.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'bookmark_icons requires a live bookmark node in the same collection'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $bookmark_icons_kind$
  `.execute(db);
  await sql`
    CREATE TRIGGER bookmark_icons_require_live_bookmark
    BEFORE INSERT OR UPDATE OF node_id, collection_id ON bookmark_icons
    FOR EACH ROW
    EXECUTE FUNCTION bookmark_icons_require_live_bookmark()
  `.execute(db);
  await sql`
    CREATE FUNCTION bookmark_icons_drop_on_node_tombstone() RETURNS trigger
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
    CREATE TRIGGER nodes_bookmark_icons_tombstone
    AFTER UPDATE OF deleted_at ON nodes
    FOR EACH ROW
    EXECUTE FUNCTION bookmark_icons_drop_on_node_tombstone()
  `.execute(db);
  await sql`
    CREATE FUNCTION bookmark_icons_drop_on_collection_tombstone() RETURNS trigger
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
  await sql`
    CREATE TRIGGER collections_bookmark_icons_tombstone
    AFTER UPDATE OF deleted_at ON collections
    FOR EACH ROW
    EXECUTE FUNCTION bookmark_icons_drop_on_collection_tombstone()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS collections_bookmark_icons_tombstone ON collections`.execute(db);
  await sql`DROP FUNCTION IF EXISTS bookmark_icons_drop_on_collection_tombstone()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS nodes_bookmark_icons_tombstone ON nodes`.execute(db);
  await sql`DROP FUNCTION IF EXISTS bookmark_icons_drop_on_node_tombstone()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS bookmark_icons_require_live_bookmark ON bookmark_icons`.execute(db);
  await sql`DROP FUNCTION IF EXISTS bookmark_icons_require_live_bookmark()`.execute(db);
  await sql`DROP TABLE IF EXISTS bookmark_icons`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
