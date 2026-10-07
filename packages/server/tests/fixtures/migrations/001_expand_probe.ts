import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table phase0_migration_order (ordinal integer primary key)`.execute(db);
  await sql`insert into phase0_migration_order (ordinal) values (1)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table phase0_migration_order`.execute(db);
}
