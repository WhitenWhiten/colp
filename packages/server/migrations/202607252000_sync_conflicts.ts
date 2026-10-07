import { sql, type Kysely, type Migration } from 'kysely';

/** P3-17 expand: Pull-ready private Conflict authority for terminal Sync updates. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE UNIQUE INDEX sync_replicas_replica_collection_unique
    ON sync_replicas(replica_id, collection_id)`.execute(db);
  await sql`CREATE UNIQUE INDEX sync_session_bindings_session_collection_replica_unique
    ON sync_session_bindings(session_id, collection_id, replica_id)`.execute(db);
  await sql`CREATE TABLE sync_conflicts (
    conflict_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    session_id text NOT NULL REFERENCES sync_sessions(session_id) ON DELETE RESTRICT,
    operation_id text NOT NULL,
    target_id text NOT NULL,
    base_revision text NOT NULL CHECK (
      length(base_revision) BETWEEN 1 AND 128 AND base_revision ~ '^[A-Za-z0-9._~-]+$'
    ),
    trusted_base_revision text CHECK (
      trusted_base_revision IS NULL OR (
        length(trusted_base_revision) BETWEEN 1 AND 128
        AND trusted_base_revision ~ '^[A-Za-z0-9._~-]+$'
        AND trusted_base_revision = base_revision
      )
    ),
    current_revision text NOT NULL CHECK (
      length(current_revision) BETWEEN 1 AND 128 AND current_revision ~ '^[A-Za-z0-9._~-]+$'
    ),
    conflict_type text NOT NULL CHECK (conflict_type IN (
      'concurrent_field_update','unprovable_base','untrusted_base','delete_update'
    )),
    conflicting_fields jsonb NOT NULL CHECK (
      jsonb_typeof(conflicting_fields) = 'array'
      AND jsonb_array_length(conflicting_fields) > 0
      AND NOT jsonb_path_exists(conflicting_fields, '$[*] ? (@.type() != "string")')
    ),
    base_projection jsonb NOT NULL CHECK (jsonb_typeof(base_projection) = 'object'),
    current_projection jsonb NOT NULL CHECK (jsonb_typeof(current_projection) = 'object'),
    incoming_projection jsonb NOT NULL CHECK (jsonb_typeof(incoming_projection) = 'object'),
    private_payload_ciphertext bytea NOT NULL CHECK (octet_length(private_payload_ciphertext) > 0),
    private_payload_iv bytea NOT NULL CHECK (octet_length(private_payload_iv) = 12),
    private_payload_auth_tag bytea NOT NULL CHECK (octet_length(private_payload_auth_tag) = 16),
    private_payload_key_version integer NOT NULL CHECK (private_payload_key_version > 0),
    private_payload_digest text NOT NULL CHECK (private_payload_digest ~ '^[A-Za-z0-9_-]{43}$'),
    allowed_resolutions jsonb NOT NULL CHECK (
      allowed_resolutions = '["server","incoming","custom"]'::jsonb
      OR allowed_resolutions = '["server","incoming","custom","both"]'::jsonb
    ),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    revision text NOT NULL CHECK (
      length(revision) BETWEEN 1 AND 128 AND revision ~ '^[A-Za-z0-9._~-]+$'
    ),
    commit_ordinal bigint NOT NULL CHECK (commit_ordinal > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (operation_id),
    UNIQUE (collection_id, commit_ordinal, conflict_id),
    CONSTRAINT sync_conflicts_replica_collection_fk
      FOREIGN KEY (replica_id, collection_id)
      REFERENCES sync_replicas(replica_id, collection_id) ON DELETE RESTRICT,
    CONSTRAINT sync_conflicts_session_binding_fk
      FOREIGN KEY (session_id, collection_id, replica_id)
      REFERENCES sync_session_bindings(session_id, collection_id, replica_id) ON DELETE RESTRICT,
    CONSTRAINT sync_conflicts_operation_fk
      FOREIGN KEY (operation_id, collection_id)
      REFERENCES operations(operation_id, collection_id)
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT sync_conflicts_target_fk
      FOREIGN KEY (collection_id, target_id)
      REFERENCES nodes(collection_id, id) ON DELETE RESTRICT,
    CONSTRAINT sync_conflicts_trusted_base_revision_fk
      FOREIGN KEY (collection_id, target_id, trusted_base_revision)
      REFERENCES sync_node_revision_history(collection_id, resource_id, revision) ON DELETE RESTRICT,
    CONSTRAINT sync_conflicts_current_revision_fk
      FOREIGN KEY (collection_id, target_id, current_revision)
      REFERENCES sync_node_revision_history(collection_id, resource_id, revision) ON DELETE RESTRICT
  )`.execute(db);
  await sql`REVOKE SELECT (
    private_payload_ciphertext, private_payload_iv, private_payload_auth_tag,
    private_payload_key_version, private_payload_digest
  ) ON sync_conflicts FROM PUBLIC`.execute(db);
  await sql`CREATE INDEX sync_conflicts_pull_order_idx
    ON sync_conflicts(collection_id, commit_ordinal, conflict_id)`.execute(db);
  await sql`CREATE INDEX sync_conflicts_open_target_idx
    ON sync_conflicts(collection_id, target_id, commit_ordinal, conflict_id)
    WHERE status = 'open'`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_conflict_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'sync Conflict is immutable until canonical resolution support is deployed'
          USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION 'sync Conflict is immutable' USING ERRCODE = '23514';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_conflicts_immutable
    BEFORE UPDATE OR DELETE ON sync_conflicts
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_conflict_mutation()`.execute(db);
}

/** Developer-only destructive rollback after every P3-17 writer has been drained. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_conflicts_immutable ON sync_conflicts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_conflict_mutation()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_conflicts`.execute(db);
  await sql`DROP INDEX IF EXISTS sync_session_bindings_session_collection_replica_unique`.execute(db);
  await sql`DROP INDEX IF EXISTS sync_replicas_replica_collection_unique`.execute(db);
}

export const migration: Migration = { up, down };
