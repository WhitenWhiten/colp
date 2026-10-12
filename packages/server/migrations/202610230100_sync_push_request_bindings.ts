import { sql, type Kysely } from 'kysely';

/** Bind the whole HTTP request independently of its per-operation receipts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table sync_push_request_bindings (
    session_id text not null references sync_sessions(session_id) on delete cascade,
    endpoint_identity text not null,
    idempotency_key text not null check (length(idempotency_key) between 1 and 512),
    request_digest text not null,
    primary key (session_id, endpoint_identity, idempotency_key)
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table sync_push_request_bindings`.execute(db);
}
