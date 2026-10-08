import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE classification_call_attempts ADD COLUMN IF NOT EXISTS reported_model_version text NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE classification_call_attempts DROP COLUMN IF EXISTS reported_model_version`.execute(db);
}
