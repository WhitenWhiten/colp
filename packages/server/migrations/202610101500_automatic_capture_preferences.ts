import { sql, type Kysely, type Migration } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE bookmark_preferences
    ADD COLUMN capture_mode text NOT NULL DEFAULT 'manual' CHECK (capture_mode IN ('manual', 'automatic')),
    ADD COLUMN result_panel_auto_dismiss_ms integer NOT NULL DEFAULT 3000
      CHECK (result_panel_auto_dismiss_ms = 0 OR result_panel_auto_dismiss_ms BETWEEN 3000 AND 30000),
    ADD COLUMN learn_from_corrections boolean NOT NULL DEFAULT true,
    ADD COLUMN resume_classification_when_online boolean NOT NULL DEFAULT true`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE bookmark_preferences DROP COLUMN capture_mode, DROP COLUMN result_panel_auto_dismiss_ms,
    DROP COLUMN learn_from_corrections, DROP COLUMN resume_classification_when_online`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
