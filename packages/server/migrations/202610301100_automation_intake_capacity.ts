import { sql, type Kysely } from 'kysely';

/** M1 runnable admission limits; not a worker-policy/model budget subsystem. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE automation_intake_reservations (
      run_id text PRIMARY KEY REFERENCES automation_runs(id) ON DELETE CASCADE,
      owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      rule_id text NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE, admission_day date NOT NULL
    );
    CREATE INDEX automation_intake_daily_rule ON automation_intake_reservations(owner_id,rule_id,admission_day);
    CREATE TABLE automation_intake_delays (
      run_id text PRIMARY KEY REFERENCES automation_runs(id) ON DELETE CASCADE,
      available_at timestamptz NOT NULL
    );
    CREATE TABLE automation_intake_wakes (
      owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE, available_at timestamptz NOT NULL,
      PRIMARY KEY(owner_id,collection_id,available_at)
    );
    INSERT INTO automation_intake_reservations(run_id,owner_id,rule_id,admission_day)
      SELECT r.id,r.owner_id,v.rule_id,(r.created_at AT TIME ZONE 'UTC')::date
      FROM automation_runs r JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
      WHERE r.kind='intake' AND (r.state='completed'
        OR EXISTS (SELECT 1 FROM automation_effect_receipts e WHERE e.run_id=r.id));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE automation_intake_wakes, automation_intake_delays, automation_intake_reservations`.execute(db);
}
