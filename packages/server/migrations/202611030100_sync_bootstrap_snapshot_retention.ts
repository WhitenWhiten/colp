import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Reclaim expired bootstrap Snapshot evidence.
 *
 * Snapshot pages, capabilities and recovery Acks are only usable while the
 * Snapshot is live: every read, capability issuance and Ack loads the Snapshot
 * with `expires_at > current_timestamp`. Page evidence and expired capabilities
 * that outlive that fence therefore cannot validate a future recovery, but the
 * immutable-evidence triggers rejected every DELETE and the RESTRICT foreign
 * keys kept the Snapshot and all of its node rows forever. Allow only
 * expiry-fenced DELETEs here; Ack receipts stay immutable and continue to pin
 * their Snapshot for the Replica lifetime.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX sync_bootstrap_snapshots_expiry_cleanup_idx
    ON sync_bootstrap_snapshots(expires_at, snapshot_id)`.execute(db);
  await sql`CREATE INDEX sync_recovery_capabilities_snapshot_cleanup_idx
    ON sync_recovery_capabilities(snapshot_id, expires_at)`.execute(db);
  await sql`CREATE INDEX sync_recovery_ack_receipts_snapshot_cleanup_idx
    ON sync_recovery_ack_receipts(snapshot_id)`.execute(db);

  // The page-evidence trigger only needs the parent Snapshot's expiry fence.
  await sql`CREATE OR REPLACE FUNCTION allow_expired_sync_bootstrap_snapshot_page_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND EXISTS (
        SELECT 1 FROM sync_bootstrap_snapshots snapshot
        WHERE snapshot.snapshot_id = OLD.snapshot_id
          AND snapshot.expires_at <= current_timestamp
      ) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'Sync bootstrap Snapshot page evidence is immutable';
    END $$`.execute(db);
  await sql`DROP TRIGGER sync_bootstrap_snapshot_pages_immutable ON sync_bootstrap_snapshot_pages`.execute(db);
  await sql`CREATE TRIGGER sync_bootstrap_snapshot_pages_immutable
    BEFORE UPDATE OR DELETE ON sync_bootstrap_snapshot_pages
    FOR EACH ROW EXECUTE FUNCTION allow_expired_sync_bootstrap_snapshot_page_mutation()`.execute(db);

  // Capabilities expire independently; only an expired claim may be reclaimed.
  // The updater still permits only the consumed_at transition.
  await sql`CREATE OR REPLACE FUNCTION fence_sync_recovery_capability() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.expires_at <= current_timestamp THEN RETURN OLD; END IF;
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
}

/** Developer-only destructive rollback; production uses expand/migrate/contract. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION fence_sync_recovery_capability() RETURNS trigger LANGUAGE plpgsql AS $$
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

  await sql`DROP TRIGGER sync_bootstrap_snapshot_pages_immutable ON sync_bootstrap_snapshot_pages`.execute(db);
  await sql`CREATE TRIGGER sync_bootstrap_snapshot_pages_immutable
    BEFORE UPDATE OR DELETE ON sync_bootstrap_snapshot_pages
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_recovery_immutable_mutation()`.execute(db);
  await sql`DROP FUNCTION allow_expired_sync_bootstrap_snapshot_page_mutation()`.execute(db);

  await sql`DROP INDEX sync_recovery_ack_receipts_snapshot_cleanup_idx`.execute(db);
  await sql`DROP INDEX sync_recovery_capabilities_snapshot_cleanup_idx`.execute(db);
  await sql`DROP INDEX sync_bootstrap_snapshots_expiry_cleanup_idx`.execute(db);
}

export const migration: Migration = { up, down };
