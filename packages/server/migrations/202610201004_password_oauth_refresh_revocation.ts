import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION revoke_password_oauth_grants() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.password IS DISTINCT FROM OLD.password THEN
      UPDATE auth_oauth_refresh_token SET revoked=clock_timestamp() WHERE "userId"=NEW."userId" AND revoked IS NULL;
      UPDATE auth_oauth_access_token SET revoked=clock_timestamp() WHERE "userId"=NEW."userId" AND revoked IS NULL;
    END IF;
    RETURN NEW;
  END $$`.execute(db);
  await sql`CREATE TRIGGER auth_password_oauth_revoke AFTER UPDATE OF password ON auth_accounts
    FOR EACH ROW EXECUTE FUNCTION revoke_password_oauth_grants()`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER auth_password_oauth_revoke ON auth_accounts`.execute(db);
  await sql`DROP FUNCTION revoke_password_oauth_grants()`.execute(db);
}
