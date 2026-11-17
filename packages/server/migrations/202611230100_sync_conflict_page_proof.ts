import { sql, type Kysely, type Migration } from 'kysely';

/**
 * A2-1/A2-3: server-side proof that every frozen open-conflict page was served,
 * and a receipt-retention policy that lets terminal Sessions be reclaimed.
 *
 * A2-1: the frozen `conflict_digest` is intentionally identical on every page,
 * so a client that fetched page 1 only could confirm the cut and advance the
 * recovery Ack past conflicts it never received. Each served non-empty page is
 * now recorded here with its offset, returned count and the digest of exactly
 * those rows. Confirmation requires the merged intervals to cover the frozen
 * cut contiguously from zero; a replayed page only re-proves its own interval.
 *
 * A2-3: `sync_sequence_receipts` are retained for the Replica lifetime so a
 * live Replica keeps replaying its receipts. Their Session FK used RESTRICT, so
 * every renewal left the superseded Session permanently undeletable. Receipts
 * are keyed operationally by (replica_id, sequence_scope, sequence_number) and
 * their session/lease columns are immutable provenance facts, not lookup keys;
 * releasing the FK therefore keeps live-Replica idempotency while allowing the
 * bounded terminal-Session retention pass to delete the superseded Session.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_bootstrap_snapshot_conflict_page_proofs (
    snapshot_id text NOT NULL REFERENCES sync_bootstrap_snapshots(snapshot_id) ON DELETE CASCADE,
    session_id text NOT NULL REFERENCES sync_sessions(session_id) ON DELETE RESTRICT,
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    page_offset integer NOT NULL CHECK (page_offset >= 0),
    returned_count integer NOT NULL CHECK (returned_count >= 1),
    page_digest text NOT NULL CHECK (page_digest ~ '^[0-9a-f]{64}$'),
    served_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (snapshot_id, session_id, page_offset, returned_count)
  )`.execute(db);
  await sql`CREATE INDEX sync_bootstrap_snapshot_conflict_page_proofs_session_idx
    ON sync_bootstrap_snapshot_conflict_page_proofs(session_id, snapshot_id)`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_bootstrap_snapshot_conflict_page_proof_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'snapshot open conflict page proofs are immutable';
    END $$`.execute(db);
  await sql`CREATE TRIGGER sync_bootstrap_snapshot_conflict_page_proofs_immutable
    BEFORE UPDATE ON sync_bootstrap_snapshot_conflict_page_proofs
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_bootstrap_snapshot_conflict_page_proof_update()`.execute(db);

  // A2-2 second-pass reclamation stays index-bounded instead of scanning all
  // retained (cursor IS NOT NULL) evidence to find the redacted remnants.
  await sql`CREATE INDEX sync_pull_cursor_evidence_redacted_cleanup_idx
    ON sync_pull_cursor_evidence(cursor_expires_at, replica_id) WHERE cursor IS NULL`.execute(db);

  // Sequence receipts stay replica-lifetime authority; their Session provenance
  // must not pin a superseded (terminal) Session row forever.
  await sql`ALTER TABLE sync_sequence_receipts
    DROP CONSTRAINT sync_sequence_receipt_session_fk`.execute(db);
}

/** Developer-only destructive rollback; production uses expand/migrate/contract. */
export async function down(db: Kysely<unknown>): Promise<void> {
  // Re-adding the FK cannot validate rows whose superseded Session was already
  // reclaimed by the retention pass, so the developer rollback installs it as
  // NOT VALID: new receipts keep the old enforcement without resurrecting rows.
  await sql`ALTER TABLE sync_sequence_receipts
    ADD CONSTRAINT sync_sequence_receipt_session_fk
    FOREIGN KEY (session_id, collection_id, replica_id, lease_generation)
    REFERENCES sync_sessions(session_id, collection_id, replica_id, lease_generation)
    ON DELETE RESTRICT NOT VALID`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_bootstrap_snapshot_conflict_page_proofs_immutable
    ON sync_bootstrap_snapshot_conflict_page_proofs`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_bootstrap_snapshot_conflict_page_proof_update()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_bootstrap_snapshot_conflict_page_proofs`.execute(db);
  await sql`DROP INDEX IF EXISTS sync_pull_cursor_evidence_redacted_cleanup_idx`.execute(db);
}

export const migration: Migration = { up, down };
