import { sql, type Kysely } from 'kysely';
/** Durable possession proofs, independent of access-token and Sync Session expiry. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_replica_report_authorities (
    proof_digest text PRIMARY KEY CHECK (proof_digest ~ '^[a-f0-9]{64}$'),
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE CASCADE,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    device_id text NOT NULL,
    browser_profile_id text NOT NULL,
    browser_generation text NOT NULL,
    credential_issuer text NOT NULL,
    oauth_client_id text NOT NULL,
    account_security_epoch bigint NOT NULL,
    created_at timestamptz NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX sync_replica_report_authorities_replica_idx ON sync_replica_report_authorities(replica_id)`.execute(db);
  // Compatibility: previously issued opaque Session IDs are already available
  // only to that installation. Preserve their possession proof without a new Session.
  await sql`INSERT INTO sync_replica_report_authorities
    SELECT encode(sha256(convert_to(session.session_id, 'UTF8')), 'hex'), session.replica_id, session.account_id,
      replica.device_id, replica.browser_profile_id, replica.browser_generation,
      session.credential_issuer, session.oauth_client_id, session.account_security_epoch, session.issued_at
    FROM sync_sessions session JOIN sync_replicas replica ON replica.replica_id = session.replica_id
    WHERE session.status = 'active' AND replica.status <> 'retired'`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE sync_replica_report_authorities`.execute(db);
}
