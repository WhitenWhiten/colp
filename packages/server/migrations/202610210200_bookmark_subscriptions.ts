import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  const statements = [
    "create table bookmark_subscriptions (id text primary key, account_id text not null references accounts(id) on delete cascade, source_type text not null check(source_type in ('collection','digest_series')), source_id text not null, status text not null check(status in ('active','terminated')), created_at timestamptz not null, document jsonb not null, unique(account_id,id))",
    "create unique index bookmark_subscriptions_active_source on bookmark_subscriptions(account_id,source_type,source_id) where status='active'",
    "create table bookmark_subscription_mappings (id uuid primary key, account_id text not null references accounts(id) on delete cascade, subscription_id text not null, source_type text not null, source_id text not null, profile_id uuid not null, status text not null check(status in ('active','terminating','detached')), created_at timestamptz not null, document jsonb not null, foreign key(account_id,subscription_id) references bookmark_subscriptions(account_id,id), unique(account_id,id))",
    "create unique index bookmark_subscription_live_mapping on bookmark_subscription_mappings(account_id,source_type,source_id,profile_id) where status<>'detached'",
    "create index bookmark_subscription_mapping_list on bookmark_subscription_mappings(account_id,created_at desc,id)",
    "create table bookmark_subscription_exit_previews (id uuid primary key, account_id text not null references accounts(id) on delete cascade, expires_at timestamptz not null, document jsonb not null)",
    "create table bookmark_subscription_actions (id uuid primary key, account_id text not null references accounts(id) on delete cascade, mapping_id uuid not null, generation text not null, profile_id uuid not null, sequence bigint generated always as identity unique, document jsonb not null, receipt jsonb, unique(mapping_id,generation), foreign key(account_id,mapping_id) references bookmark_subscription_mappings(account_id,id))",
    "create index bookmark_subscription_pending_actions on bookmark_subscription_actions(account_id,profile_id,sequence) where receipt is null",
    "create table bookmark_subscription_snapshots (id uuid primary key, account_id text not null references accounts(id) on delete cascade, expires_at timestamptz not null, size_bytes integer not null check(size_bytes>=0), descriptor jsonb not null, projection jsonb not null)",
    "create index bookmark_subscription_snapshot_expiry on bookmark_subscription_snapshots(account_id,expires_at)"
  ];
  for (const statement of statements) await sql.raw(statement).execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['bookmark_subscription_snapshots','bookmark_subscription_actions','bookmark_subscription_exit_previews','bookmark_subscription_mappings','bookmark_subscriptions']) await db.schema.dropTable(table).execute();
}
