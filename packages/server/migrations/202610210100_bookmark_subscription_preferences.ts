import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table bookmark_preferences
    add column subscription_on_unfollow text not null default 'keep' check (subscription_on_unfollow in ('keep', 'remove')),
    add column subscription_on_unsubscribe text not null default 'keep' check (subscription_on_unsubscribe in ('keep', 'remove')),
    add column subscription_default_check_interval_minutes integer default 15 check (subscription_default_check_interval_minutes in (5, 15, 60)),
    add column subscription_default_digest_mode text not null default 'latest' check (subscription_default_digest_mode in ('latest', 'recent')),
    add column subscription_default_edition_limit integer not null default 10 check (subscription_default_edition_limit between 1 and 20)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table bookmark_preferences
    drop column subscription_default_edition_limit,
    drop column subscription_default_digest_mode,
    drop column subscription_default_check_interval_minutes,
    drop column subscription_on_unsubscribe,
    drop column subscription_on_unfollow`.execute(db);
}
