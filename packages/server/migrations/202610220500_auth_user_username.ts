import { sql, type Kysely, type Migration } from 'kysely';

/**
 * G2 expand: Better Auth username plugin column on auth_users.
 *
 * `username({ displayUsername: false })` adds one nullable unique `username`
 * and no `displayUsername`. The unique index name matches the library alter
 * path (`auth_users_username_uidx`) so a later getMigrations expand does not
 * create a second index. Multiple NULLs stay allowed for email-only rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE "auth_users" ADD COLUMN "username" text`.execute(db);
  await sql`CREATE UNIQUE INDEX "auth_users_username_uidx" ON "auth_users" ("username")`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $guard$
    DECLARE
      named_users bigint;
    BEGIN
      SELECT count(*) INTO named_users FROM "auth_users" WHERE "username" IS NOT NULL;
      IF named_users > 0 THEN
        RAISE EXCEPTION 'auth_user_username down refused: % auth_users rows have a username; production rollback keeps the column.',
          named_users;
      END IF;
    END
  $guard$`.execute(db);
  await sql`DROP INDEX IF EXISTS "auth_users_username_uidx"`.execute(db);
  await sql`ALTER TABLE "auth_users" DROP COLUMN IF EXISTS "username"`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
