import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Enforce at most one non-null product email across accounts so trusted OIDC
 * email synchronization can fail closed on collision (application check + DB).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS accounts_email_idx`.execute(db);
  await sql`
    CREATE UNIQUE INDEX accounts_email_unique
    ON accounts(email)
    WHERE email IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS accounts_email_unique`.execute(db);
  await sql`
    CREATE INDEX accounts_email_idx
    ON accounts(email)
    WHERE email IS NOT NULL
  `.execute(db);
}

export const migration: Migration = { up, down };
