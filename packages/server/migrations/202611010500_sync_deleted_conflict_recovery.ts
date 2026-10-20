import { sql, type Kysely, type Migration } from 'kysely';

/** Expand before deploying the resolver. New delete/update conflicts retain
 * the complete incoming edit and offer a recovered copy. Historical encrypted
 * payloads may lack that content, so their immutable menus are not rewritten. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_conflicts DROP CONSTRAINT sync_conflicts_allowed_resolutions_check`.execute(db);
  await sql`ALTER TABLE sync_conflicts ADD CONSTRAINT sync_conflicts_allowed_resolutions_check CHECK (
    allowed_resolutions = '["server"]'::jsonb
    OR allowed_resolutions = '["server","incoming"]'::jsonb
    OR allowed_resolutions = '["server","incoming","custom"]'::jsonb
    OR allowed_resolutions = '["server","incoming","custom","both"]'::jsonb
  )`.execute(db);
}

/** No data rewrite on downgrade: refuse while new recovery menus are retained. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM sync_conflicts WHERE allowed_resolutions='["server","incoming"]'::jsonb) THEN
      RAISE EXCEPTION 'down refused: retained delete conflict recovery menus require the expanded schema';
    END IF;
  END $$`.execute(db);
  await sql`ALTER TABLE sync_conflicts DROP CONSTRAINT sync_conflicts_allowed_resolutions_check`.execute(db);
  await sql`ALTER TABLE sync_conflicts ADD CONSTRAINT sync_conflicts_allowed_resolutions_check CHECK (
    allowed_resolutions = '["server"]'::jsonb
    OR allowed_resolutions = '["server","incoming","custom"]'::jsonb
    OR allowed_resolutions = '["server","incoming","custom","both"]'::jsonb
  )`.execute(db);
}

export const migration: Migration = { up, down };
