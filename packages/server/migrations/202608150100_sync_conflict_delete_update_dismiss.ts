import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FIX-M-015 (SYNC-R10) expand: per-type Conflict resolution menus.
 *
 * New Conflicts now advertise only executable resolutions. A `delete_update`
 * Conflict (a client update raced a server delete) advertises exactly
 * `["server"]` — dismiss keeps the tombstone and closes the Conflict; the
 * previous blanket menu advertised `both`/`incoming`/`custom` for a deleted
 * current where every choice 404'd, leaving the Conflict permanently open.
 *
 * The stored `allowed_resolutions` CHECK is relaxed to admit the new
 * `["server"]` menu (the three exact menus the code can write; N-1 binaries
 * that still write the historical menus keep working), and every existing
 * `delete_update` row is backfilled to `["server"]`. Only that column
 * changes: the original Conflict Pull event (`pull_wire_json`) is never
 * rewritten, and the immutability trigger is re-enabled unchanged afterwards.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_conflicts
    DROP CONSTRAINT IF EXISTS sync_conflicts_allowed_resolutions_check`.execute(db);

  // Backfill historical rows while no CHECK constrains the column: the
  // immutability trigger is relaxed only for this one-time correction, then
  // re-enabled unchanged (the trigger itself never permits this UPDATE, so
  // the re-enabled trigger still forbids any future menu mutation).
  await sql`ALTER TABLE sync_conflicts DISABLE TRIGGER sync_conflicts_immutable`.execute(db);
  try {
    await sql`UPDATE sync_conflicts SET allowed_resolutions = '["server"]'::jsonb
      WHERE conflict_type = 'delete_update'`.execute(db);
  } finally {
    await sql`ALTER TABLE sync_conflicts ENABLE TRIGGER sync_conflicts_immutable`.execute(db);
  }

  await sql`ALTER TABLE sync_conflicts
    ADD CONSTRAINT sync_conflicts_allowed_resolutions_check CHECK (
      allowed_resolutions = '["server"]'::jsonb
      OR allowed_resolutions = '["server","incoming","custom"]'::jsonb
      OR allowed_resolutions = '["server","incoming","custom","both"]'::jsonb
    )`.execute(db);
}

/**
 * Developer-only destructive rollback: the historical CHECK does not admit the
 * `["server"]` menu, so operators must drain every backfilled `delete_update`
 * Conflict (resolve or delete) before downgrading.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_conflicts
    DROP CONSTRAINT IF EXISTS sync_conflicts_allowed_resolutions_check`.execute(db);
  await sql`ALTER TABLE sync_conflicts
    ADD CONSTRAINT sync_conflicts_allowed_resolutions_check CHECK (
      allowed_resolutions = '["server","incoming","custom"]'::jsonb
      OR allowed_resolutions = '["server","incoming","custom","both"]'::jsonb
    )`.execute(db);
}

export const migration: Migration = { up, down };
