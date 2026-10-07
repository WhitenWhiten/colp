import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Historical runs have no provable discovery revision. Leave them NULL so
  // claim revalidates their occurrence under the locked current schedule.
  await sql.raw('ALTER TABLE digest_runs ADD COLUMN IF NOT EXISTS schedule_revision text '
    + 'CHECK (schedule_revision IS NULL OR length(schedule_revision) BETWEEN 1 AND 128)').execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Expand-only: keep the column available during an application rollback.
}
