import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';

/**
 * Arms the single-owner trigger (migration `202610230400_colp_single_owner_guard`)
 * and reports whether the owner account still has to be created.
 */
export async function prepareColpInstance(
  db: Kysely<DatabaseSchema>,
  input: { readonly singleOwner: boolean },
): Promise<{ readonly ownerMissing: boolean }> {
  await sql`
    INSERT INTO colp_instance_settings (singleton, single_owner, updated_at)
    VALUES (true, ${input.singleOwner}, current_timestamp)
    ON CONFLICT (singleton) DO UPDATE
      SET single_owner = EXCLUDED.single_owner, updated_at = current_timestamp
  `.execute(db);
  const users = await sql<{ count: string }>`SELECT count(*)::text AS count FROM auth_users`.execute(db);
  return { ownerMissing: users.rows[0]?.count === '0' };
}

/** The first-run line an operator greps for in `docker compose logs server`. */
export function firstRunMessage(origin: string, setupToken: string): string {
  return `First run: no owner account yet. Open ${origin}/register and enter setup token ${setupToken}`
    + ', or run: docker compose exec server colp-server create-user --username <name>';
}
