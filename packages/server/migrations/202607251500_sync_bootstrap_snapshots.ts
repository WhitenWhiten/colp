import { sql, type Kysely, type Migration } from 'kysely';

/** P3-09 expand: immutable, transactionally fenced bootstrap Snapshot materialisations. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_kind_check`.execute(db);
  await sql`ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_title_check`.execute(db);
  await sql`ALTER TABLE nodes ALTER COLUMN title DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('folder','bookmark','separator')),
    ADD CONSTRAINT nodes_title_check CHECK (
      (kind = 'separator' AND title IS NULL AND url IS NULL) OR
      (kind <> 'separator' AND title IS NOT NULL AND length(title) BETWEEN 1 AND 512)
    )`.execute(db);

  await sql`CREATE TABLE sync_bootstrap_snapshots (
    snapshot_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    session_id text NOT NULL REFERENCES sync_sessions(session_id) ON DELETE RESTRICT,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    lease_generation bigint NOT NULL CHECK (lease_generation > 0),
    policy_revision text NOT NULL,
    content_revision text NOT NULL,
    binding_mode text NOT NULL CHECK (binding_mode IN ('whole-profile','mounted-folder')),
    binding_root_node_id text NOT NULL,
    snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
    bootstrap_cursor text NOT NULL,
    cursor_key_id text NOT NULL CHECK (cursor_key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    generated_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    completed_at timestamptz,
    CONSTRAINT sync_bootstrap_snapshot_expiry CHECK (expires_at > generated_at),
    CONSTRAINT sync_bootstrap_snapshot_completion_window CHECK (
      completed_at IS NULL OR (completed_at >= generated_at AND completed_at < expires_at)
    ),
    CONSTRAINT sync_bootstrap_snapshot_session_scope_fk
      FOREIGN KEY (session_id, account_id, collection_id, replica_id)
      REFERENCES sync_sessions(session_id, account_id, collection_id, replica_id) ON DELETE RESTRICT,
    CONSTRAINT sync_bootstrap_snapshot_generation_fk
      FOREIGN KEY (replica_id, lease_generation)
      REFERENCES sync_replica_generations(replica_id, lease_generation) ON DELETE RESTRICT,
    CONSTRAINT sync_bootstrap_snapshot_root_fk
      FOREIGN KEY (collection_id, binding_root_node_id)
      REFERENCES nodes(collection_id, id) ON DELETE RESTRICT,
    UNIQUE (session_id, content_revision, policy_revision, lease_generation, binding_root_node_id)
  )`.execute(db);
  await sql`CREATE INDEX sync_bootstrap_snapshots_session_idx
    ON sync_bootstrap_snapshots(session_id, expires_at, snapshot_id)`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_bootstrap_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR OLD.completed_at IS NOT NULL OR
         NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR
         NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.collection_id IS DISTINCT FROM OLD.collection_id OR
         NEW.replica_id IS DISTINCT FROM OLD.replica_id OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation OR
         NEW.policy_revision IS DISTINCT FROM OLD.policy_revision OR NEW.content_revision IS DISTINCT FROM OLD.content_revision OR
         NEW.binding_mode IS DISTINCT FROM OLD.binding_mode OR NEW.binding_root_node_id IS DISTINCT FROM OLD.binding_root_node_id OR
         NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json OR NEW.bootstrap_cursor IS DISTINCT FROM OLD.bootstrap_cursor OR
         NEW.cursor_key_id IS DISTINCT FROM OLD.cursor_key_id OR
         NEW.generated_at IS DISTINCT FROM OLD.generated_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
         OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL THEN
        RAISE EXCEPTION 'Sync bootstrap Snapshot authority is immutable';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_bootstrap_snapshots_immutable BEFORE UPDATE OR DELETE ON sync_bootstrap_snapshots
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_bootstrap_snapshot_mutation()`.execute(db);
}

/** Developer-only destructive rollback; production uses expand/migrate/contract. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_bootstrap_snapshots_immutable ON sync_bootstrap_snapshots`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_bootstrap_snapshot_mutation()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_bootstrap_snapshots`.execute(db);
  await sql`ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_kind_check`.execute(db);
  await sql`ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_title_check`.execute(db);
  await sql`ALTER TABLE nodes ALTER COLUMN title SET NOT NULL`.execute(db);
  await sql`ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('folder','bookmark')),
    ADD CONSTRAINT nodes_title_check CHECK (length(title) BETWEEN 1 AND 512)`.execute(db);
}

export const migration: Migration = { up, down };
