import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * P4A-I09 expand migration: verification lease + policy facts on
 * `blob_records`.
 *
 * The verification worker takes a durable lease on the blob record when it
 * CASes `uploaded -> verifying`: `verification_lease_owner` (the outbox row),
 * `verification_lease_generation` (the outbox `lease_generation` token), and
 * `verification_lease_expires_at` (DB clock + lease TTL). Every later CAS
 * (`verifying -> stored_private`, corruption -> `expired`) is fenced by the
 * lease token, so an old-lease late result can never commit and a stolen
 * lease aborts the old worker.
 *
 * Expand-only: all new columns are nullable/defaulted so N/N-1 binaries that
 * predate the verification writer are unaffected. The checks are additive:
 * a `verifying` row must carry lease facts and a `stored_private` /
 * `attached_private` row must carry a verification policy version (the
 * existing verified-facts CHECK already requires size/digest/media).
 */
const DDL_STATEMENTS: readonly string[] = [
  `alter table blob_records
    add column verification_lease_owner text,
    add column verification_lease_generation bigint not null default 0
      constraint blob_records_verification_lease_generation_check
      check (verification_lease_generation >= 0),
    add column verification_lease_expires_at timestamptz,
    add constraint blob_records_verifying_lease_facts_check
      check (logical_state <> 'verifying'
        or (verification_lease_owner is not null and verification_lease_expires_at is not null)),
    add constraint blob_records_verified_policy_check
      check (logical_state not in ('stored_private','attached_private')
        or verification_policy_version is not null)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of DDL_STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw('alter table blob_records drop constraint if exists blob_records_verified_policy_check').execute(db);
  await sql.raw('alter table blob_records drop constraint if exists blob_records_verifying_lease_facts_check').execute(db);
  await sql.raw('alter table blob_records drop constraint if exists blob_records_verification_lease_generation_check').execute(db);
  await sql.raw('alter table blob_records drop column if exists verification_lease_expires_at').execute(db);
  await sql.raw('alter table blob_records drop column if exists verification_lease_generation').execute(db);
  await sql.raw('alter table blob_records drop column if exists verification_lease_owner').execute(db);
}

const migration: Migration = { up, down };
export default migration;
