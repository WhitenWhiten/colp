import { sql, type Kysely, type Migration } from 'kysely';

/** P3-23 expand: Collection purge authority, durable identity watermarks, and fenced job leases. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_collection_purge_state (
    collection_id text REFERENCES collections(id) ON DELETE RESTRICT,
    purged_through_commit_ordinal bigint NOT NULL DEFAULT 0 CHECK (purged_through_commit_ordinal >= 0),
    purged_through_stream_kind smallint NOT NULL DEFAULT 0 CHECK (purged_through_stream_kind IN (0,1)),
    purged_through_stable_id text NOT NULL DEFAULT '',
    state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
    lease_owner text,
    lease_token text,
    lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    lease_expires_at timestamptz,
    attempt_count bigint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_attempt_at timestamptz,
    last_completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (collection_id),
    CONSTRAINT sync_collection_purge_state_tuple_check CHECK (
      (purged_through_commit_ordinal = 0 AND purged_through_stream_kind = 0
        AND purged_through_stable_id = '')
      OR (purged_through_commit_ordinal > 0 AND length(purged_through_stable_id) BETWEEN 1 AND 512)
    ),
    CONSTRAINT sync_collection_purge_state_lease_check CHECK (
      (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND length(lease_owner) BETWEEN 1 AND 128
        AND lease_token IS NOT NULL AND length(lease_token) BETWEEN 1 AND 128
        AND lease_expires_at IS NOT NULL)
    )
  )`.execute(db);
  await sql`CREATE INDEX sync_collection_purge_state_claim_idx
    ON sync_collection_purge_state(lease_expires_at, updated_at, collection_id)`.execute(db);
  await sql`CREATE FUNCTION enforce_sync_collection_purge_state_revision()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.purged_through_commit_ordinal, NEW.purged_through_stream_kind,
          NEW.purged_through_stable_id COLLATE "C") IS DISTINCT FROM
         (OLD.purged_through_commit_ordinal, OLD.purged_through_stream_kind,
          OLD.purged_through_stable_id COLLATE "C") THEN
        IF NEW.state_revision <> OLD.state_revision + 1 OR
           (NEW.purged_through_commit_ordinal, NEW.purged_through_stream_kind,
            NEW.purged_through_stable_id COLLATE "C") <=
           (OLD.purged_through_commit_ordinal, OLD.purged_through_stream_kind,
            OLD.purged_through_stable_id COLLATE "C") THEN
          RAISE EXCEPTION 'Sync Collection purge boundary must advance with one revision'
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.state_revision <> OLD.state_revision THEN
        RAISE EXCEPTION 'Sync Collection purge revision requires a boundary advance'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_collection_purge_state_revision_fence
    BEFORE UPDATE ON sync_collection_purge_state
    FOR EACH ROW EXECUTE FUNCTION enforce_sync_collection_purge_state_revision()`.execute(db);
  await sql`CREATE FUNCTION create_sync_collection_purge_state()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO sync_collection_purge_state(collection_id) VALUES (NEW.id);
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER collections_create_sync_purge_state
    AFTER INSERT ON collections FOR EACH ROW EXECUTE FUNCTION create_sync_collection_purge_state()`.execute(db);

  await sql`CREATE TABLE sync_purged_node_id_watermarks (
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    target_id text NOT NULL REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    delete_commit_ordinal bigint NOT NULL CHECK (delete_commit_ordinal > 0),
    delete_revision text NOT NULL CHECK (length(delete_revision) BETWEEN 1 AND 128),
    delete_operation_id text NOT NULL,
    purge_state_revision bigint NOT NULL CHECK (purge_state_revision > 0),
    purged_at timestamptz NOT NULL,
    PRIMARY KEY (collection_id, target_id),
    CONSTRAINT sync_purged_node_id_watermarks_operation_fk
      FOREIGN KEY (delete_operation_id, collection_id, delete_commit_ordinal)
      REFERENCES operations(operation_id, collection_id, commit_ordinal) ON DELETE RESTRICT
  )`.execute(db);
  await sql`CREATE INDEX sync_purged_node_id_watermarks_boundary_idx
    ON sync_purged_node_id_watermarks(collection_id, delete_commit_ordinal, target_id)`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_purged_node_id_watermark_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'purged Node identity watermarks are immutable' USING ERRCODE = '23514';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_purged_node_id_watermarks_immutable
    BEFORE UPDATE OR DELETE ON sync_purged_node_id_watermarks
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_purged_node_id_watermark_mutation()`.execute(db);

  await sql`DROP TRIGGER sync_tombstoned_nodes_immutable ON nodes`.execute(db);
  await sql`DROP FUNCTION forbid_sync_tombstoned_node_resurrection()`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_tombstoned_node_resurrection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE candidate_collection_id text;
    DECLARE candidate_id text;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        candidate_collection_id := NEW.collection_id;
        candidate_id := NEW.id;
      ELSE
        candidate_collection_id := OLD.collection_id;
        candidate_id := OLD.id;
      END IF;
      IF EXISTS (
        SELECT 1 FROM sync_node_tombstones tombstone
        WHERE tombstone.collection_id = candidate_collection_id
          AND tombstone.target_id = candidate_id
      ) OR EXISTS (
        SELECT 1 FROM sync_purged_node_id_watermarks watermark
        WHERE watermark.collection_id = candidate_collection_id
          AND watermark.target_id = candidate_id
      ) THEN
        RAISE EXCEPTION 'sync deleted Node identity must not be resurrected or mutated'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_tombstoned_nodes_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON nodes
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_tombstoned_node_resurrection()`.execute(db);

  await sql`ALTER TABLE sync_node_tombstones
    ADD COLUMN payload_purged_at timestamptz,
    ADD COLUMN purge_state_revision bigint CHECK (purge_state_revision IS NULL OR purge_state_revision > 0),
    ADD CONSTRAINT sync_node_tombstones_payload_purge_check CHECK (
      (payload_purged_at IS NULL AND purge_state_revision IS NULL)
      OR (payload_purged_at IS NOT NULL AND purge_state_revision IS NOT NULL
        AND payload_json->'extensions' = '{}'::jsonb)
    )`.execute(db);
  await sql`DROP TRIGGER sync_node_tombstones_immutable ON sync_node_tombstones`.execute(db);
  await sql`DROP FUNCTION forbid_sync_node_tombstone_mutation()`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_node_tombstone_mutation()
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
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_node_tombstones_immutable
    BEFORE UPDATE OR DELETE ON sync_node_tombstones
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_node_tombstone_mutation()`.execute(db);
  await sql`CREATE INDEX sync_node_tombstones_purge_candidate_idx
    ON sync_node_tombstones(collection_id, delete_commit_ordinal, operation_id, target_id)
    INCLUDE (purge_after, delete_revision, affected_count)
    WHERE payload_purged_at IS NULL`.execute(db);

  await sql`INSERT INTO sync_collection_purge_state(collection_id)
    SELECT collection.id FROM collections AS collection ON CONFLICT DO NOTHING`.execute(db);
}

/** Developer-only destructive rollback after P3-23 workers and readers are drained. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS collections_create_sync_purge_state ON collections`.execute(db);
  await sql`DROP FUNCTION IF EXISTS create_sync_collection_purge_state()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_collection_purge_state_revision_fence
    ON sync_collection_purge_state`.execute(db);
  await sql`DROP FUNCTION IF EXISTS enforce_sync_collection_purge_state_revision()`.execute(db);
  await sql`DROP INDEX IF EXISTS sync_node_tombstones_purge_candidate_idx`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_node_tombstones_immutable ON sync_node_tombstones`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_node_tombstone_mutation()`.execute(db);
  await sql`ALTER TABLE sync_node_tombstones DROP CONSTRAINT IF EXISTS sync_node_tombstones_payload_purge_check,
    DROP COLUMN IF EXISTS payload_purged_at, DROP COLUMN IF EXISTS purge_state_revision`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_node_tombstone_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'sync Node Tombstone is immutable' USING ERRCODE = '23514';
    END $$`.execute(db);
  await sql`CREATE TRIGGER sync_node_tombstones_immutable BEFORE UPDATE OR DELETE ON sync_node_tombstones
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_node_tombstone_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_tombstoned_nodes_immutable ON nodes`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_tombstoned_node_resurrection()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_purged_node_id_watermarks`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_purged_node_id_watermark_mutation()`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_tombstoned_node_resurrection()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS (SELECT 1 FROM sync_node_tombstones tombstone
        WHERE tombstone.collection_id = OLD.collection_id AND tombstone.target_id = OLD.id) THEN
        RAISE EXCEPTION 'sync tombstoned Node must not be resurrected or mutated' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$`.execute(db);
  await sql`CREATE TRIGGER sync_tombstoned_nodes_immutable BEFORE UPDATE OR DELETE ON nodes
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_tombstoned_node_resurrection()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_collection_purge_state`.execute(db);
}

export const migration: Migration = { up, down };
