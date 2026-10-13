import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { appendAutomationResume } from '../outbox/automation-ingest.js';

interface IntakeReservation {
  runId: string;
  ownerId: string;
  ruleId: string;
  collectionId: string;
  maxRunsPerDay: number;
}

/**
 * Caller holds the Owner account lock. Reservations belong to the logical rule
 * and UTC admission day, not a replaceable revision. Retry and continuePinned
 * cannot spend twice. Reservation, effect and source cursor commit together.
 */
export async function reserveIntakeAdmission(tx: DatabaseTransaction, input: IntakeReservation): Promise<boolean> {
  const existing = (await sql`SELECT run_id FROM automation_intake_reservations WHERE run_id=${input.runId}`.execute(tx)).rows;
  if (existing.length) return true;
  const window = (await sql<{ day: string; next_day: Date }>`WITH instant AS MATERIALIZED (
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS day
  ) SELECT day::text,((day+1)::timestamp AT TIME ZONE 'UTC') AS next_day FROM instant`.execute(tx)).rows[0]!;
  const used = Number((await sql<{ count: string }>`SELECT count(*) FROM automation_intake_reservations
    WHERE owner_id=${input.ownerId} AND rule_id=${input.ruleId} AND admission_day=${window.day}::date`.execute(tx)).rows[0]!.count);
  if (used >= input.maxRunsPerDay) {
    const delayed = await sql`INSERT INTO automation_intake_delays(run_id,available_at)
      VALUES (${input.runId},${window.next_day}) ON CONFLICT (run_id) DO UPDATE SET available_at=EXCLUDED.available_at
      WHERE automation_intake_delays.available_at IS DISTINCT FROM EXCLUDED.available_at RETURNING run_id`.execute(tx);
    if (delayed.rows.length) {
      const explanation = `Daily run limit reached. Original work is retained and will be reconsidered at ${window.next_day.toISOString()} under its pinned rule and binding; explicit holds and newer manual edits still win.`;
      await sql`UPDATE automation_runs SET state='waiting',revision=revision+1,updated_at=clock_timestamp(),
        explanation_json=explanation_json || ${JSON.stringify({ explanation, admissionDeferredUntil: window.next_day.toISOString() })}::jsonb
        WHERE id=${input.runId} AND owner_id=${input.ownerId}`.execute(tx);
    }
    const wake = await sql`INSERT INTO automation_intake_wakes(owner_id,collection_id,available_at)
      VALUES (${input.ownerId},${input.collectionId},${window.next_day}) ON CONFLICT DO NOTHING RETURNING owner_id`.execute(tx);
    if (wake.rows.length) await appendAutomationResume(tx, input.collectionId, window.next_day);
    return false;
  }
  await sql`INSERT INTO automation_intake_reservations(run_id,owner_id,rule_id,admission_day)
    VALUES (${input.runId},${input.ownerId},${input.ruleId},${window.day}::date)`.execute(tx);
  const cleared = await sql`DELETE FROM automation_intake_delays WHERE run_id=${input.runId} RETURNING run_id`.execute(tx);
  if (cleared.rows.length) {
    await sql`UPDATE automation_runs SET revision=revision+1,updated_at=clock_timestamp(),
      explanation_json=explanation_json-'admissionDeferredUntil'-'explanation'
      WHERE id=${input.runId} AND owner_id=${input.ownerId}`.execute(tx);
  }
  return true;
}

/**
 * A verified receipt records an already-committed device effect, not a new server
 * effect request. Keep real history above capacity and count the unique run
 * against later server admissions. Offline effects cannot be retroactively capped.
 */
export async function recordObservedIntakeAdmission(tx: DatabaseTransaction, input: {
  runId: string; ownerId: string; ruleId: string;
}): Promise<void> {
  await sql`INSERT INTO automation_intake_reservations(run_id,owner_id,rule_id,admission_day)
    VALUES (${input.runId},${input.ownerId},${input.ruleId},(clock_timestamp() AT TIME ZONE 'UTC')::date)
    ON CONFLICT (run_id) DO NOTHING`.execute(tx);
  await sql`DELETE FROM automation_intake_delays WHERE run_id=${input.runId}`.execute(tx);
}

export async function clearConsumedIntakeWakes(tx: DatabaseTransaction, ownerId: string, collectionId: string): Promise<void> {
  await sql`DELETE FROM automation_intake_wakes WHERE owner_id=${ownerId} AND collection_id=${collectionId}
    AND available_at <= clock_timestamp()`.execute(tx);
  await sql`DELETE FROM automation_intake_delays d USING automation_runs r
    WHERE r.id=d.run_id AND r.owner_id=${ownerId} AND r.state NOT IN ('waiting','running')`.execute(tx);
}
