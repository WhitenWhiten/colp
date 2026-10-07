import { sql, type Kysely, type Migration } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE bookmark_capture_decisions ADD COLUMN feedback_revision integer NOT NULL DEFAULT 0,
    ADD COLUMN effective_feedback text, ADD COLUMN effective_event_id text`.execute(db);
  await sql`CREATE TABLE bookmark_capture_learning (
    account_id text PRIMARY KEY REFERENCES accounts(id), generation integer NOT NULL DEFAULT 0, cleared_at timestamptz
  )`.execute(db);
  await sql`CREATE TABLE bookmark_capture_feedback (
    account_id text NOT NULL REFERENCES accounts(id), event_id text NOT NULL,
    decision_id text NOT NULL REFERENCES bookmark_capture_decisions(id), capture_id text NOT NULL,
    node_revision text NOT NULL, kind text NOT NULL CHECK (kind IN ('explicit_positive','explicit_negative','correction_applied','implicit_positive','dismissed_unrated','not_presented','withdrawn')),
    revision integer NOT NULL, fingerprint text NOT NULL, occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    learning_eligible boolean NOT NULL, evidence_generation integer NOT NULL, correction_json jsonb,
    receipt_json jsonb NOT NULL, PRIMARY KEY(account_id, event_id), UNIQUE(decision_id, revision)
  )`.execute(db);
  await sql`CREATE INDEX capture_feedback_learning ON bookmark_capture_feedback(account_id, evidence_generation, received_at) WHERE learning_eligible`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE bookmark_capture_feedback, bookmark_capture_learning`.execute(db);
  await sql`ALTER TABLE bookmark_capture_decisions DROP COLUMN feedback_revision, DROP COLUMN effective_feedback, DROP COLUMN effective_event_id`.execute(db);
}
export const migration: Migration = { up, down };
export default migration;
