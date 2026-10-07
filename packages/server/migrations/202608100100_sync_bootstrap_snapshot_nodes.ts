import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FIX-M-014 (SYNC-R09) expand: versioned paged bootstrap Snapshot storage.
 *
 * New materialisations write a small header (collection, parent revisions,
 * node count) in `snapshot_json` plus one immutable, stable-order row per Node
 * in `sync_bootstrap_snapshot_nodes`; page reads fetch only the requested
 * range instead of parsing and cloning the whole document (O(N²/P) -> O(N)).
 *
 * Legacy v1 rows keep the full inline document and remain readable through a
 * versioned read path until they expire; the Snapshot row immutability guard
 * is relaxed only for DELETE of already-expired rows so bounded cleanup can
 * reclaim header + node-row bytes. Apply the expand before deploying the
 * paged reader; N-1 binaries continue to read `snapshot_json` verbatim.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_bootstrap_snapshots
    ADD COLUMN storage_version smallint NOT NULL DEFAULT 1 CHECK (storage_version IN (1,2)),
    ADD COLUMN node_count integer CHECK (node_count >= 0)`.execute(db);

  await sql`CREATE TABLE sync_bootstrap_snapshot_nodes (
    snapshot_id text NOT NULL REFERENCES sync_bootstrap_snapshots(snapshot_id) ON DELETE CASCADE,
    node_index integer NOT NULL CHECK (node_index >= 0),
    node_json jsonb NOT NULL,
    PRIMARY KEY (snapshot_id, node_index)
  )`.execute(db);

  // Expiry cleanup is the only DELETE allowance: rows are immutable while
  // live, and every maintenance DELETE re-checks the same expiry predicate.
  await sql`CREATE OR REPLACE FUNCTION forbid_sync_bootstrap_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND OLD.expires_at <= current_timestamp THEN RETURN OLD; END IF;
      IF TG_OP = 'DELETE' OR OLD.completed_at IS NOT NULL OR
         NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR
         NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.collection_id IS DISTINCT FROM OLD.collection_id OR
         NEW.replica_id IS DISTINCT FROM OLD.replica_id OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation OR
         NEW.policy_revision IS DISTINCT FROM OLD.policy_revision OR NEW.content_revision IS DISTINCT FROM OLD.content_revision OR
         NEW.binding_mode IS DISTINCT FROM OLD.binding_mode OR NEW.binding_root_node_id IS DISTINCT FROM OLD.binding_root_node_id OR
         NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json OR NEW.bootstrap_cursor IS DISTINCT FROM OLD.bootstrap_cursor OR
         NEW.cursor_key_id IS DISTINCT FROM OLD.cursor_key_id OR NEW.storage_version IS DISTINCT FROM OLD.storage_version OR
         NEW.node_count IS DISTINCT FROM OLD.node_count OR
         NEW.generated_at IS DISTINCT FROM OLD.generated_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
         OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL THEN
        RAISE EXCEPTION 'Sync bootstrap Snapshot authority is immutable';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
}

/** Developer-only destructive rollback; production uses expand/migrate/contract. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS sync_bootstrap_snapshot_nodes`.execute(db);
  await sql`ALTER TABLE sync_bootstrap_snapshots DROP COLUMN IF EXISTS node_count,
    DROP COLUMN IF EXISTS storage_version`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION forbid_sync_bootstrap_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
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
}

export const migration: Migration = { up, down };
