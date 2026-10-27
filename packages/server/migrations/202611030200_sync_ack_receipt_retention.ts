import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Allow terminal Pull Ack receipts to release their retained Pull evidence.
 *
 * An Ack receipt is immutable while its Session or Replica can still replay the
 * Ack. Once the Session is terminated or the Replica is retired, authority
 * lookup rejects every replay, but the receipt's RESTRICT foreign key keeps the
 * cursor evidence and page evidence (and therefore the evidence cleanup guards)
 * alive forever. Permit only terminal-Session/Replica deletes here; live
 * receipts stay immutable.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX sync_ack_receipts_session_cleanup_idx
    ON sync_ack_receipts(session_id, completed_at, principal_id, idempotency_key)`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION guard_sync_ack_receipt_retention() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND (
        EXISTS (SELECT 1 FROM sync_sessions session
          WHERE session.session_id = OLD.session_id AND session.status = 'terminated')
        OR EXISTS (SELECT 1 FROM sync_replicas replica
          WHERE replica.replica_id = OLD.replica_id AND replica.status = 'retired')
      ) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'Sync Pull Ack receipt is immutable outside terminal Session/Replica cleanup';
    END $$`.execute(db);
  await sql`DROP TRIGGER sync_ack_receipts_immutable ON sync_ack_receipts`.execute(db);
  await sql`CREATE TRIGGER sync_ack_receipts_immutable
    BEFORE UPDATE OR DELETE ON sync_ack_receipts
    FOR EACH ROW EXECUTE FUNCTION guard_sync_ack_receipt_retention()`.execute(db);
}

/** Developer-only destructive rollback; production uses expand/migrate/contract. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER sync_ack_receipts_immutable ON sync_ack_receipts`.execute(db);
  await sql`CREATE TRIGGER sync_ack_receipts_immutable
    BEFORE UPDATE OR DELETE ON sync_ack_receipts
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_ack_authority_mutation()`.execute(db);
  await sql`DROP FUNCTION guard_sync_ack_receipt_retention()`.execute(db);
  await sql`DROP INDEX sync_ack_receipts_session_cleanup_idx`.execute(db);
}

export const migration: Migration = { up, down };
