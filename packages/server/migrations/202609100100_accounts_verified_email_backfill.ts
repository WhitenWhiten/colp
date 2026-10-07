import { sql, type Kysely, type Migration } from 'kysely';

/**
 * S-03 one-shot backfill: verified Better Auth users whose product
 * `accounts.email` is still null (mapping exists, account active) receive
 * the normalized `auth_users.email`. Conflicts on `accounts_email_unique`
 * are skipped and logged — never stolen. Expand-only data repair.
 *
 * `down` is developer-only and a no-op: reversing would null emails that
 * later application writes may also have filled.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $backfill$
    DECLARE
      skipped bigint;
    BEGIN
      SELECT count(*) INTO skipped
      FROM accounts a
      INNER JOIN auth_user_account_map m ON m.account_id = a.id
      INNER JOIN "auth_users" u ON u.id = m.auth_user_id
      WHERE u."emailVerified" = true
        AND a.email IS NULL
        AND a.status = 'active'
        AND a.deleted_at IS NULL
        AND length(btrim(u.email)) > 0
        AND EXISTS (
          SELECT 1 FROM accounts other
          WHERE other.email = lower(btrim(u.email))
            AND other.id <> a.id
        );
      IF skipped > 0 THEN
        RAISE NOTICE 'accounts_verified_email_backfill skipped % conflict row(s); not stealing accounts_email_unique', skipped;
      END IF;

      UPDATE accounts a
         SET email = lower(btrim(u.email))
        FROM auth_user_account_map m
        INNER JOIN "auth_users" u ON u.id = m.auth_user_id
       WHERE a.id = m.account_id
         AND u."emailVerified" = true
         AND a.email IS NULL
         AND a.status = 'active'
         AND a.deleted_at IS NULL
         AND length(btrim(u.email)) > 0
         AND NOT EXISTS (
           SELECT 1 FROM accounts other
           WHERE other.email = lower(btrim(u.email))
             AND other.id <> a.id
         );
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
