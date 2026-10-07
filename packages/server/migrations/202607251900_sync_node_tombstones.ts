import { sql, type Kysely, type Migration } from 'kysely';

/** P3-15 expand: durable per-Node deletion membership and Pull-ready Tombstone facts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE UNIQUE INDEX operations_operation_collection_ordinal_unique
    ON operations(operation_id, collection_id, commit_ordinal)`.execute(db);
  await sql`CREATE TABLE sync_node_tombstones (
    collection_id text NOT NULL,
    target_id text NOT NULL,
    root_target_id text NOT NULL,
    operation_id text NOT NULL,
    scope text NOT NULL CHECK (scope IN ('single','subtree')),
    delete_revision text NOT NULL CHECK (
      length(delete_revision) BETWEEN 1 AND 128
      AND delete_revision ~ '^[A-Za-z0-9._~-]+$'
    ),
    delete_commit_ordinal bigint NOT NULL CHECK (delete_commit_ordinal > 0),
    delete_cursor text NOT NULL CHECK (
      length(delete_cursor) BETWEEN 1 AND 128
      AND delete_cursor ~ '^[A-Za-z0-9._~-]+$'
    ),
    deleted_at timestamptz NOT NULL,
    purge_after timestamptz NOT NULL CHECK (purge_after >= deleted_at + interval '30 days'),
    affected_count integer NOT NULL CHECK (affected_count > 0),
    payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, target_id),
    UNIQUE (operation_id, target_id),
    CONSTRAINT sync_node_tombstones_target_fk
      FOREIGN KEY (collection_id, target_id)
      REFERENCES nodes(collection_id, id) ON DELETE RESTRICT,
    CONSTRAINT sync_node_tombstones_root_fk
      FOREIGN KEY (collection_id, root_target_id)
      REFERENCES nodes(collection_id, id) ON DELETE RESTRICT,
    CONSTRAINT sync_node_tombstones_revision_fk
      FOREIGN KEY (collection_id, target_id, delete_revision)
      REFERENCES sync_node_revision_history(collection_id, resource_id, revision)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT sync_node_tombstones_operation_fk
      FOREIGN KEY (operation_id, collection_id, delete_commit_ordinal)
      REFERENCES operations(operation_id, collection_id, commit_ordinal)
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT sync_node_tombstones_payload_binding CHECK (
      payload_json->>'resourceType' IS NOT DISTINCT FROM 'node'
      AND payload_json->>'collectionId' IS NOT DISTINCT FROM collection_id
      AND payload_json->>'targetId' IS NOT DISTINCT FROM target_id
      AND payload_json->>'rootTargetId' IS NOT DISTINCT FROM root_target_id
      AND payload_json->>'operationId' IS NOT DISTINCT FROM operation_id
      AND payload_json->>'scope' IS NOT DISTINCT FROM scope
      AND payload_json->>'deleteRevision' IS NOT DISTINCT FROM delete_revision
      AND payload_json->>'deleteCommitOrdinal' IS NOT DISTINCT FROM delete_commit_ordinal::text
      AND payload_json->>'affectedCount' IS NOT DISTINCT FROM affected_count::text
    )
  )`.execute(db);
  await sql`CREATE INDEX sync_node_tombstones_retention_idx
    ON sync_node_tombstones(purge_after, delete_commit_ordinal, collection_id, target_id)`.execute(db);
  await sql`CREATE INDEX sync_node_tombstones_operation_idx
    ON sync_node_tombstones(collection_id, operation_id, target_id)`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_node_tombstone_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'sync Node Tombstone is immutable' USING ERRCODE = '23514';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_node_tombstones_immutable
    BEFORE UPDATE OR DELETE ON sync_node_tombstones
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_node_tombstone_mutation()`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_tombstoned_node_resurrection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM sync_node_tombstones tombstone
        WHERE tombstone.collection_id = OLD.collection_id
          AND tombstone.target_id = OLD.id
      ) THEN
        RAISE EXCEPTION 'sync tombstoned Node must not be resurrected or mutated'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_tombstoned_nodes_immutable
    BEFORE UPDATE OR DELETE ON nodes
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_tombstoned_node_resurrection()`.execute(db);
}

/** Developer-only destructive rollback after every P3-15 writer has been drained. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_tombstoned_nodes_immutable ON nodes`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_tombstoned_node_resurrection()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_node_tombstones_immutable ON sync_node_tombstones`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_node_tombstone_mutation()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_node_tombstones`.execute(db);
  await sql`DROP INDEX IF EXISTS operations_operation_collection_ordinal_unique`.execute(db);
}

export const migration: Migration = { up, down };
