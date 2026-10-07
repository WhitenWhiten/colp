import { sql, type Kysely } from 'kysely';

/**
 * A logical call records how many provider dispatches it needed. A rate-limited
 * dispatch is provably not accepted, so one retry is allowed and the row must be
 * able to carry 2 instead of the previous 0..1 bound. Unknown outcomes still never
 * resend and never exceed the dispatches already recorded.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE classification_call_attempts DROP CONSTRAINT IF EXISTS classification_call_attempts_attempt_number_check,
    ADD CONSTRAINT classification_call_attempts_attempt_number_check CHECK(attempt_number BETWEEN 0 AND 5)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE classification_call_attempts SET attempt_number=1 WHERE attempt_number>1`.execute(db);
  await sql`ALTER TABLE classification_call_attempts DROP CONSTRAINT IF EXISTS classification_call_attempts_attempt_number_check,
    ADD CONSTRAINT classification_call_attempts_attempt_number_check CHECK(attempt_number BETWEEN 0 AND 1)`.execute(db);
}
