import { sql, type Kysely, type Migration } from 'kysely';

/**
 * T-03 / ADR D3 one-shot backfill: mapped business accounts take
 * `subject_id = auth_user_account_map.auth_user_id` so JWT `sub` (Better Auth
 * user.id) equals `accounts.subject_id` without changing verifier lookup.
 *
 * Dry-run collision query runs first. If any mapped target already belongs
 * to a different account, RAISE EXCEPTION aborts the whole DO block (no
 * partial apply). Unmapped accounts are not in the UPDATE and stay
 * byte-identical. Already-aligned mapped rows are skipped (`IS DISTINCT
 * FROM`), so a second `up` is a no-op.
 *
 * `down` is developer-only and a no-op: reversing would steal later
 * application writes and undo D3 alignment.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $backfill$
    DECLARE
      collisions bigint;
    BEGIN
      SELECT count(*) INTO collisions
      FROM auth_user_account_map m
      INNER JOIN accounts a ON a.id = m.account_id
      WHERE a.subject_id IS DISTINCT FROM m.auth_user_id
        AND EXISTS (
          SELECT 1 FROM accounts other
          WHERE other.subject_id = m.auth_user_id
            AND other.id <> a.id
        );
      IF collisions > 0 THEN
        RAISE EXCEPTION 'accounts_subject_id_backfill refused: % mapped target subject_id(s) already belong to a different account',
          collisions;
      END IF;

      UPDATE accounts a
         SET subject_id = m.auth_user_id
        FROM auth_user_account_map m
       WHERE a.id = m.account_id
         AND a.subject_id IS DISTINCT FROM m.auth_user_id;
    END
    $backfill$
  `.execute(db);
}

/** Data backfill cannot be undone without stealing later application writes. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // no-op
}

export const migration: Migration = { up, down };
export default migration;
