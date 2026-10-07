import { sql, type Kysely, type Migration } from 'kysely';

/** P3-13 expand: immutable canonical payload evidence for every observed Node revision. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_node_revision_history (
    collection_id text NOT NULL,
    resource_id text NOT NULL,
    revision text NOT NULL CHECK (
      length(revision) BETWEEN 1 AND 128 AND revision ~ '^[A-Za-z0-9._~-]+$'
    ),
    kind text NOT NULL CHECK (kind IN ('folder','bookmark','separator')),
    payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
    commit_ordinal bigint NOT NULL CHECK (commit_ordinal >= 0),
    operation_id text,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, resource_id, revision),
    CONSTRAINT sync_node_revision_history_node_fk
      FOREIGN KEY (collection_id, resource_id)
      REFERENCES nodes(collection_id, id) ON DELETE RESTRICT,
    CONSTRAINT sync_node_revision_history_operation_fk
      FOREIGN KEY (operation_id, collection_id)
      REFERENCES operations(operation_id, collection_id)
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT sync_node_revision_history_payload_binding CHECK (
      payload_json->>'resourceType' = 'node'
      AND payload_json->>'collectionId' = collection_id
      AND payload_json->>'id' = resource_id
      AND payload_json->>'resourceRevision' = revision
      AND payload_json->>'kind' = kind
    )
  )`.execute(db);
  await sql`CREATE INDEX sync_node_revision_history_retention_idx
    ON sync_node_revision_history(collection_id, resource_id, recorded_at, revision)`.execute(db);

  await sql`INSERT INTO sync_node_revision_history (
      collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id,recorded_at
    )
    SELECT n.collection_id,n.id,n.resource_revision,n.kind,n.payload_json,c.commit_ordinal,null,n.updated_at
    FROM nodes n JOIN collections c ON c.id=n.collection_id
    WHERE n.payload_json IS NOT NULL
      AND n.payload_authority_status='backfilled'
      AND n.payload_json->>'resourceType'='node'
      AND n.payload_json->>'collectionId'=n.collection_id
      AND n.payload_json->>'id'=n.id
      AND n.payload_json->>'resourceRevision'=n.resource_revision
      AND n.payload_json->>'kind'=n.kind
    ON CONFLICT (collection_id,resource_id,revision) DO NOTHING`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_node_revision_history_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'sync Node revision history is immutable' USING ERRCODE = '23514';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_node_revision_history_immutable
    BEFORE UPDATE OR DELETE ON sync_node_revision_history
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_node_revision_history_mutation()`.execute(db);
}

/** Developer-only destructive rollback after every P3-13 writer has been drained. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_node_revision_history_immutable ON sync_node_revision_history`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_node_revision_history_mutation()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_node_revision_history`.execute(db);
}

export const migration: Migration = { up, down };
