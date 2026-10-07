import { sql, type Kysely } from 'kysely';

/**
 * KNS-06 expand: dual-write `nodes.folder_role` from payload, unique live
 * special-role mounts, and allow DELETE of an un-purged Sync tombstone so
 * restore can consume it (Live/Tombstone exclusive).
 *
 * Order is expand → backfill → verify → flush deferred constraints →
 * trigger → unique index.
 * `down` is developer-only and destructive for the new column/index.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE nodes ADD COLUMN folder_role text NULL`.execute(db);
  await sql`
    UPDATE nodes
       SET folder_role = NULLIF(payload_json->>'folderRole', '')
     WHERE folder_role IS DISTINCT FROM NULLIF(payload_json->>'folderRole', '')
  `.execute(db);
  await sql`
    DO $verify$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM nodes
         WHERE folder_role IS DISTINCT FROM NULLIF(payload_json->>'folderRole', '')
      ) THEN
        RAISE EXCEPTION 'nodes.folder_role backfill does not match payload_json';
      END IF;
    END
    $verify$;
  `.execute(db);
  // The backfill queues DEFERRABLE FK / constraint-trigger events on nodes.
  // PostgreSQL then refuses CREATE INDEX (55006 pending trigger events).
  await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(db);
  await sql`
    CREATE FUNCTION sync_nodes_folder_role_from_payload()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.payload_json IS NULL THEN
        NEW.folder_role := NULL;
      ELSE
        NEW.folder_role := NULLIF(NEW.payload_json->>'folderRole', '');
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER nodes_folder_role_from_payload
      BEFORE INSERT OR UPDATE OF payload_json ON nodes
      FOR EACH ROW EXECUTE FUNCTION sync_nodes_folder_role_from_payload()
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX nodes_live_special_folder_role_uidx
      ON nodes (collection_id, folder_role)
      WHERE deleted_at IS NULL
        AND folder_role IN ('bookmarks-bar','other-bookmarks','mobile-bookmarks','recovered')
  `.execute(db);

  await sql`DROP TRIGGER sync_node_tombstones_immutable ON sync_node_tombstones`.execute(db);
  await sql`DROP FUNCTION forbid_sync_node_tombstone_mutation()`.execute(db);
  await sql`
    CREATE FUNCTION forbid_sync_node_tombstone_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.payload_purged_at IS NULL THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'purged sync Node Tombstone must not be deleted'
          USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'UPDATE'
        AND OLD.payload_purged_at IS NULL AND NEW.payload_purged_at IS NOT NULL
        AND OLD.purge_state_revision IS NULL AND NEW.purge_state_revision IS NOT NULL
        AND NEW.payload_json = jsonb_set(OLD.payload_json, '{extensions}', '{}'::jsonb, true)
        AND (to_jsonb(NEW) - ARRAY['payload_json','payload_purged_at','purge_state_revision']::text[])
          = (to_jsonb(OLD) - ARRAY['payload_json','payload_purged_at','purge_state_revision']::text[])
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'sync Node Tombstone is immutable outside one payload purge or unpurged consume'
        USING ERRCODE = '23514';
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER sync_node_tombstones_immutable
      BEFORE UPDATE OR DELETE ON sync_node_tombstones
      FOR EACH ROW EXECUTE FUNCTION forbid_sync_node_tombstone_mutation()
  `.execute(db);
}

/** Developer-only destructive rollback after KNS-06 writers are drained. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_node_tombstones_immutable ON sync_node_tombstones`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_node_tombstone_mutation()`.execute(db);
  await sql`
    CREATE FUNCTION forbid_sync_node_tombstone_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE'
        AND OLD.payload_purged_at IS NULL AND NEW.payload_purged_at IS NOT NULL
        AND OLD.purge_state_revision IS NULL AND NEW.purge_state_revision IS NOT NULL
        AND NEW.payload_json = jsonb_set(OLD.payload_json, '{extensions}', '{}'::jsonb, true)
        AND (to_jsonb(NEW) - ARRAY['payload_json','payload_purged_at','purge_state_revision']::text[])
          = (to_jsonb(OLD) - ARRAY['payload_json','payload_purged_at','purge_state_revision']::text[])
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'sync Node Tombstone is immutable outside one payload purge transition'
        USING ERRCODE = '23514';
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER sync_node_tombstones_immutable
      BEFORE UPDATE OR DELETE ON sync_node_tombstones
      FOR EACH ROW EXECUTE FUNCTION forbid_sync_node_tombstone_mutation()
  `.execute(db);
  await sql`DROP INDEX IF EXISTS nodes_live_special_folder_role_uidx`.execute(db);
  await sql`DROP TRIGGER IF EXISTS nodes_folder_role_from_payload ON nodes`.execute(db);
  await sql`DROP FUNCTION IF EXISTS sync_nodes_folder_role_from_payload()`.execute(db);
  await sql`ALTER TABLE nodes DROP COLUMN IF EXISTS folder_role`.execute(db);
}
