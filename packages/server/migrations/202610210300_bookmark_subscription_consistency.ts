import { sql, type Kysely } from 'kysely';
export async function up(db:Kysely<unknown>):Promise<void> {
  await sql.raw("create table bookmark_subscription_snapshot_guards (account_id text primary key references accounts(id) on delete cascade, revision uuid not null)").execute(db);
  await sql.raw("alter table bookmark_subscription_exit_previews add column selection_revision text").execute(db);
}
export async function down(db:Kysely<unknown>):Promise<void> {
  await db.schema.dropTable('bookmark_subscription_snapshot_guards').execute();
  await sql.raw("alter table bookmark_subscription_exit_previews drop column selection_revision").execute(db);
}
