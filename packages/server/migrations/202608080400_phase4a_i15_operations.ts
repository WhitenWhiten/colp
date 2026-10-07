import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * P4A-I15 expand migration: the durable attachment operations switch.
 *
 * `attachments_operations_switch` is a single-row durable switch (switch_id
 * 'global') with lease semantics that lets on-call safely:
 *  - stop admission (`admission_enabled=false` + `drain_verification=true`);
 *  - drain verification without killing a process (the switch row IS the
 *    durable state every process reads);
 *  - resume admission (row restored, lease cleared).
 *
 * Lease fencing: every transition is a single-row CAS fenced on
 * `lease_generation` (implemented in
 * `src/infrastructure/database/attachments-admission-switch-port.ts`), so a
 * stale operator can never overwrite a newer one. Fixed reason codes only
 * ('maintenance' | 'rotation' | 'incident'); draining requires a lease owner;
 * an enabled switch never holds a lease.
 *
 * Additive-only: a brand-new table cannot affect N/N-1 binaries that predate
 * it. `down()` drops the table cleanly.
 */
const DDL_STATEMENTS: readonly string[] = [
  `create table attachments_operations_switch (
    switch_id text primary key,
    admission_enabled boolean not null default true,
    drain_verification boolean not null default false,
    reason text,
    lease_owner text,
    lease_generation bigint not null default 0
      constraint attachments_operations_switch_lease_generation_check
      check (lease_generation >= 0),
    lease_expires_at timestamptz,
    updated_at timestamptz not null default now(),
    constraint attachments_operations_switch_reason_check
      check (reason is null or reason in ('maintenance', 'rotation', 'incident')),
    constraint attachments_operations_switch_drain_stops_admission_check
      check (not drain_verification or not admission_enabled),
    constraint attachments_operations_switch_enabled_lease_free_check
      check (not admission_enabled
        or (lease_owner is null and lease_expires_at is null and not drain_verification)),
    constraint attachments_operations_switch_drain_lease_facts_check
      check (not drain_verification
        or (lease_owner is not null and lease_expires_at is not null))
  )`,
  `insert into attachments_operations_switch (switch_id) values ('global')`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of DDL_STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw('drop table if exists attachments_operations_switch').execute(db);
}

const migration: Migration = { up, down };
export default migration;