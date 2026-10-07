import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table bookmark_preferences
    add column ai_tag_mode text not null default 'suggest' check (ai_tag_mode in ('off', 'suggest', 'add'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table bookmark_preferences drop column ai_tag_mode`.execute(db);
}
