import { sql, type Kysely } from 'kysely';

/** Finish pre-upgrade partially committed deletions; never resurrect a tombstone. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM auth_verifications v USING auth_user_account_map m, accounts a
    WHERE v.value = m.auth_user_id AND m.account_id = a.id AND a.status = 'deleted'`.execute(db);
  await sql`DELETE FROM auth_users u USING auth_user_account_map m, accounts a
    WHERE u.id = m.auth_user_id AND m.account_id = a.id AND a.status = 'deleted'`.execute(db);
}
export async function down(): Promise<void> {
  // Credentials removed on an approved account deletion cannot be reconstructed.
}
