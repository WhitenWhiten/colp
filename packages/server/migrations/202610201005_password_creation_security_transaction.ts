import { sql, type Kysely } from 'kysely';

/** Resetting an OAuth-only account creates a credential instead of updating one. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER auth_password_security_commit ON auth_accounts`.execute(db);
  await sql`CREATE TRIGGER auth_password_security_commit AFTER INSERT OR UPDATE OF password ON auth_accounts
    FOR EACH ROW EXECUTE FUNCTION commit_password_security_event()`.execute(db);
  await sql`DROP TRIGGER auth_password_oauth_revoke ON auth_accounts`.execute(db);
  await sql`CREATE TRIGGER auth_password_oauth_revoke AFTER INSERT OR UPDATE OF password ON auth_accounts
    FOR EACH ROW EXECUTE FUNCTION revoke_password_oauth_grants()`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER auth_password_security_commit ON auth_accounts`.execute(db);
  await sql`CREATE TRIGGER auth_password_security_commit AFTER UPDATE OF password ON auth_accounts
    FOR EACH ROW EXECUTE FUNCTION commit_password_security_event()`.execute(db);
  await sql`DROP TRIGGER auth_password_oauth_revoke ON auth_accounts`.execute(db);
  await sql`CREATE TRIGGER auth_password_oauth_revoke AFTER UPDATE OF password ON auth_accounts
    FOR EACH ROW EXECUTE FUNCTION revoke_password_oauth_grants()`.execute(db);
}
