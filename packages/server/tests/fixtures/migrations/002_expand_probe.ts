import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`insert into phase0_migration_order (ordinal) values (2)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from phase0_migration_order where ordinal = 2`.execute(db);
}
