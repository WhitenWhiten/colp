import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FO-01: account-scoped favicon policy singleton (`account_favicon_policies`)
 * and the per-node icon source state (`bookmark_icon_sources`).
 *
 * The policy row is lazily created by the first CAS write; before any row
 * exists the application exposes virtual defaults (revision=1). `new_default`
 * in FO-01 can only be written as capture/none; online closes with FO-02 and
 * fill/force with FO-03, so no API path in FO-01 may persist a policy this
 * project cannot consume yet (the columns exist so later tasks only migrate
 * data, never schema meaning).
 *
 * `bookmark_icon_sources.source_mode` types 'uploaded' via the real Product
 * upload and 'none' via the explicit Product delete; PUT can only write
 * inherit/none. 'online' is reserved for FO-02 and nothing writes it in FO-01.
 * Soft-deletes of nodes/collections remove rows in the same transaction
 * through the tombstone triggers below (mirrors bookmark_icons).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE account_favicon_policies (
      account_id        text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      new_default       text NOT NULL DEFAULT 'capture'
                        CONSTRAINT account_favicon_policies_new_default CHECK (
                          new_default IN ('capture', 'online', 'none')
                        ),
      provider_template text NOT NULL,
      fill_missing      boolean NOT NULL DEFAULT false,
      force_all_online  boolean NOT NULL DEFAULT false,
      revision          bigint NOT NULL DEFAULT 1
                        CONSTRAINT account_favicon_policies_revision CHECK (revision >= 1),
      updated_at        timestamptz NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE TABLE bookmark_icon_sources (
      node_id       text PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
      source_mode   text NOT NULL
                    CONSTRAINT bookmark_icon_sources_mode CHECK (
                      source_mode IN ('inherit', 'online', 'uploaded', 'none')
                    ),
      revision      bigint NOT NULL
                    CONSTRAINT bookmark_icon_sources_revision CHECK (revision >= 1),
      updated_at    timestamptz NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX bookmark_icon_sources_collection_id_idx
      ON bookmark_icon_sources (collection_id)
  `.execute(db);
  await sql`
    CREATE FUNCTION bookmark_icon_sources_require_live_bookmark() RETURNS trigger
    LANGUAGE plpgsql
    AS $bookmark_icon_sources_kind$
    DECLARE
      n record;
    BEGIN
      SELECT kind, collection_id, deleted_at INTO n FROM nodes WHERE id = NEW.node_id;
      IF n IS NULL
         OR n.kind <> 'bookmark'
         OR n.collection_id IS DISTINCT FROM NEW.collection_id
         OR n.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'bookmark_icon_sources requires a live bookmark node in the same collection'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $bookmark_icon_sources_kind$
  `.execute(db);
  await sql`
    CREATE TRIGGER bookmark_icon_sources_require_live_bookmark
    BEFORE INSERT OR UPDATE OF node_id, collection_id ON bookmark_icon_sources
    FOR EACH ROW
    EXECUTE FUNCTION bookmark_icon_sources_require_live_bookmark()
  `.execute(db);
  await sql`
    CREATE FUNCTION bookmark_icon_sources_drop_on_node_tombstone() RETURNS trigger
    LANGUAGE plpgsql
    AS $bookmark_icon_sources_node_tombstone$
    BEGIN
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        DELETE FROM bookmark_icon_sources WHERE node_id = NEW.id;
      END IF;
      RETURN NEW;
    END
    $bookmark_icon_sources_node_tombstone$
  `.execute(db);
  await sql`
    CREATE TRIGGER nodes_bookmark_icon_sources_tombstone
    AFTER UPDATE OF deleted_at ON nodes
    FOR EACH ROW
    EXECUTE FUNCTION bookmark_icon_sources_drop_on_node_tombstone()
  `.execute(db);
  await sql`
    CREATE FUNCTION bookmark_icon_sources_drop_on_collection_tombstone() RETURNS trigger
    LANGUAGE plpgsql
    AS $bookmark_icon_sources_collection_tombstone$
    BEGIN
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        DELETE FROM bookmark_icon_sources WHERE collection_id = NEW.id;
      END IF;
      RETURN NEW;
    END
    $bookmark_icon_sources_collection_tombstone$
  `.execute(db);
  await sql`
    CREATE TRIGGER collections_bookmark_icon_sources_tombstone
    AFTER UPDATE OF deleted_at ON collections
    FOR EACH ROW
    EXECUTE FUNCTION bookmark_icon_sources_drop_on_collection_tombstone()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS collections_bookmark_icon_sources_tombstone ON collections`.execute(db);
  await sql`DROP FUNCTION IF EXISTS bookmark_icon_sources_drop_on_collection_tombstone()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS nodes_bookmark_icon_sources_tombstone ON nodes`.execute(db);
  await sql`DROP FUNCTION IF EXISTS bookmark_icon_sources_drop_on_node_tombstone()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS bookmark_icon_sources_require_live_bookmark ON bookmark_icon_sources`.execute(db);
  await sql`DROP FUNCTION IF EXISTS bookmark_icon_sources_require_live_bookmark()`.execute(db);
  await sql`DROP TABLE IF EXISTS bookmark_icon_sources`.execute(db);
  await sql`DROP TABLE IF EXISTS account_favicon_policies`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;