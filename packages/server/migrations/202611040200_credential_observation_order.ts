import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> { await sql`CREATE SEQUENCE automation_credential_observation_order`.execute(db); }
export async function down(db: Kysely<unknown>): Promise<void> { await sql`DROP SEQUENCE automation_credential_observation_order`.execute(db); }
