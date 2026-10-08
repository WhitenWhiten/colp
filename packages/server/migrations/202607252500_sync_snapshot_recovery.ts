import { sql, type Kysely, type Migration } from 'kysely';

/** P3-24 expand: durable stale-recovery claims, page evidence and immutable Bootstrap Ack receipts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_recovery_capabilities (
    capability_digest text PRIMARY KEY CHECK (capability_digest ~ '^[0-9a-f]{64}$'),
    session_id text NOT NULL REFERENCES sync_sessions(session_id) ON DELETE RESTRICT,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    old_lease_generation bigint NOT NULL CHECK (old_lease_generation > 0),
    purge_commit_ordinal bigint NOT NULL CHECK (purge_commit_ordinal >= 0),
    purge_stream_kind smallint NOT NULL CHECK (purge_stream_kind IN (0,1)),
    purge_stable_id text NOT NULL,
    snapshot_id text NOT NULL REFERENCES sync_bootstrap_snapshots(snapshot_id) ON DELETE RESTRICT,
    snapshot_revision text NOT NULL,
    snapshot_page_count integer NOT NULL CHECK (snapshot_page_count > 0),
    snapshot_node_count integer NOT NULL CHECK (snapshot_node_count >= 0),
    snapshot_cursor text NOT NULL,
    purpose text NOT NULL CHECK (purpose = 'sync-recovery-bootstrap-ack'),
    version smallint NOT NULL CHECK (version = 1),
    key_version text NOT NULL CHECK (key_version ~ '^[A-Za-z0-9_-]{1,64}$'),
    issued_at timestamptz NOT NULL DEFAULT current_timestamp,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    CHECK (expires_at > issued_at),
    UNIQUE (session_id, snapshot_id, old_lease_generation),
    UNIQUE (replica_id, capability_digest),
    FOREIGN KEY (replica_id, old_lease_generation)
      REFERENCES sync_replica_generations(replica_id, lease_generation) ON DELETE RESTRICT
  )`.execute(db);
  await sql`CREATE INDEX sync_recovery_capabilities_scope_idx ON sync_recovery_capabilities
    (replica_id, collection_id, old_lease_generation, expires_at)`.execute(db);
  await sql`CREATE FUNCTION fence_sync_recovery_capability() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Sync recovery capability claim is immutable';
      END IF;
      IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR
         NEW.capability_digest IS DISTINCT FROM OLD.capability_digest OR
         NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR
         NEW.replica_id IS DISTINCT FROM OLD.replica_id OR NEW.collection_id IS DISTINCT FROM OLD.collection_id OR
         NEW.old_lease_generation IS DISTINCT FROM OLD.old_lease_generation OR
         NEW.purge_commit_ordinal IS DISTINCT FROM OLD.purge_commit_ordinal OR
         NEW.purge_stream_kind IS DISTINCT FROM OLD.purge_stream_kind OR
         NEW.purge_stable_id IS DISTINCT FROM OLD.purge_stable_id OR
         NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.snapshot_revision IS DISTINCT FROM OLD.snapshot_revision OR
         NEW.snapshot_page_count IS DISTINCT FROM OLD.snapshot_page_count OR
         NEW.snapshot_node_count IS DISTINCT FROM OLD.snapshot_node_count OR
         NEW.snapshot_cursor IS DISTINCT FROM OLD.snapshot_cursor OR NEW.purpose IS DISTINCT FROM OLD.purpose OR
         NEW.version IS DISTINCT FROM OLD.version OR NEW.key_version IS DISTINCT FROM OLD.key_version OR
         NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'Sync recovery capability claim is immutable';
      END IF;
      RETURN NEW;
    END $$`.execute(db);
  await sql`CREATE TRIGGER sync_recovery_capabilities_fenced BEFORE UPDATE OR DELETE ON sync_recovery_capabilities
    FOR EACH ROW EXECUTE FUNCTION fence_sync_recovery_capability()`.execute(db);

  await sql`CREATE TABLE sync_bootstrap_snapshot_pages (
    snapshot_id text NOT NULL REFERENCES sync_bootstrap_snapshots(snapshot_id) ON DELETE RESTRICT,
    session_id text NOT NULL REFERENCES sync_sessions(session_id) ON DELETE RESTRICT,
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    old_lease_generation bigint NOT NULL CHECK (old_lease_generation > 0),
    page_sequence integer NOT NULL CHECK (page_sequence > 0),
    page_start_offset integer NOT NULL CHECK (page_start_offset >= 0),
    page_end_offset integer NOT NULL CHECK (page_end_offset >= page_start_offset),
    complete boolean NOT NULL,
    response_digest text NOT NULL CHECK (length(response_digest) BETWEEN 1 AND 128),
    served_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (snapshot_id, page_sequence),
    UNIQUE (snapshot_id, page_start_offset),
    FOREIGN KEY (replica_id, old_lease_generation)
      REFERENCES sync_replica_generations(replica_id, lease_generation) ON DELETE RESTRICT
  )`.execute(db);

  await sql`CREATE TABLE sync_recovery_ack_receipts (
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    idempotency_key text NOT NULL,
    principal_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    request_digest text NOT NULL,
    capability_digest text NOT NULL REFERENCES sync_recovery_capabilities(capability_digest) ON DELETE RESTRICT,
    session_id text NOT NULL REFERENCES sync_sessions(session_id) ON DELETE RESTRICT,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    snapshot_id text NOT NULL REFERENCES sync_bootstrap_snapshots(snapshot_id) ON DELETE RESTRICT,
    snapshot_revision text NOT NULL,
    old_lease_generation bigint NOT NULL CHECK (old_lease_generation > 0),
    new_lease_generation bigint NOT NULL CHECK (new_lease_generation > old_lease_generation),
    new_lease_id text NOT NULL,
    result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
    result_digest text NOT NULL,
    completed_at timestamptz NOT NULL,
    PRIMARY KEY (replica_id, idempotency_key),
    UNIQUE (replica_id, capability_digest),
    UNIQUE (replica_id, new_lease_generation),
    CHECK (new_lease_generation > old_lease_generation)
  )`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_recovery_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Sync recovery evidence and receipt are immutable'; END $$`.execute(db);
  for (const table of ['sync_bootstrap_snapshot_pages', 'sync_recovery_ack_receipts'] as const) {
    await sql.raw(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION forbid_sync_recovery_immutable_mutation()`).execute(db);
  }
}

/** Developer-only destructive rollback; production uses expand/migrate/contract. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_recovery_ack_receipts_immutable ON sync_recovery_ack_receipts`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_bootstrap_snapshot_pages_immutable ON sync_bootstrap_snapshot_pages`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_recovery_immutable_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_recovery_capabilities_fenced ON sync_recovery_capabilities`.execute(db);
  await sql`DROP FUNCTION IF EXISTS fence_sync_recovery_capability()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_recovery_ack_receipts`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_bootstrap_snapshot_pages`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_recovery_capabilities`.execute(db);
}

export const migration: Migration = { up, down };
