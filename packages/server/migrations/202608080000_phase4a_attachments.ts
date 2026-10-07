import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import {
  ALLOWED_OBSERVED_METADATA_KEYS,
  ATTACHMENTS_CONSTRAINT_NAMES,
} from '../src/modules/attachments/attachments-ledger-contract.js';

const C = ATTACHMENTS_CONSTRAINT_NAMES;

/**
 * P4A-I07 production expand migration: `upload_intents`, `blob_records`,
 * `blob_generations`, and the permanent key-uniqueness authority
 * `generation_keys`.
 *
 * This is the single production DDL source. The retired I04 spike schema
 * is deliberately NOT reused here. Design:
 *
 * - `generation_keys` is an append-only, immutable permanent authority: its
 *   rows are never updated or deleted (trigger, SQLSTATE 23514), and `key` /
 *   `key_fingerprint` / `generation_id` are each permanently unique. A
 *   physical key can never be reissued after body deletion, business-state
 *   archiving, or application restart.
 * - `blob_generations` binds the physical generation to its blob and key. Its
 *   identity columns (generation_id, blob_id, bucket, key, key_fingerprint)
 *   cannot be rebound, and an insert must exactly match the `generation_keys`
 *   binding for the same generation_id (triggers, SQLSTATE 23514). The
 *   one-active-per-blob partial unique index enforces at most one `active`
 *   generation (SQLSTATE 23505), and the deferred current-generation FK lets
 *   the blob pointer move inside the same transaction as the CAS.
 * - Provider metadata is bound only as the fixed columns
 *   `observed_content_type` + parallel allowlist-checked `observed_metadata_keys`
 *   / `observed_metadata_values` arrays — never a raw JSON provider response.
 * - `blob_generations_cleanup_candidate_idx` is the bounded candidate index
 *   backing the keyset cleanup claim over `(created_at, generation_id)`.
 *
 * Expand-only: all business columns are nullable/defaulted so N/N-1 binaries
 * that predate the attachment writers are unaffected. `down()` rolls back
 * cleanly (this is the last migration and there are no later readers yet).
 */
const METADATA_ALLOWLIST_ARRAY = ALLOWED_OBSERVED_METADATA_KEYS.map((key) => `'${key}'`).join(', ');

const DDL_STATEMENTS: readonly string[] = [
  `create table generation_keys (
    generation_id text primary key,
    key text not null,
    key_fingerprint text not null,
    blob_id text not null,
    created_reason text not null default 'allocate'
      constraint ${C.generationKeysReasonCheck}
      check (created_reason in ('allocate', 'replacement')),
    created_at timestamptz not null default now(),
    constraint ${C.generationKeysKeyUnique} unique (key),
    constraint ${C.generationKeysFingerprintUnique} unique (key_fingerprint)
  )`,

  `create function forbid_generation_keys_mutation() returns trigger language plpgsql as $$
    begin
      raise exception 'generation_keys rows are immutable; physical keys are permanently bound'
        using errcode = '23514';
    end
  $$`,

  `create trigger generation_keys_immutable
    before update or delete on generation_keys
    for each row execute function forbid_generation_keys_mutation()`,

  `create table blob_records (
    blob_id text primary key,
    owner_subject_id text not null,
    logical_state text not null default 'issued'
      constraint ${C.blobRecordsLogicalStateCheck}
      check (logical_state in ('issued','uploaded','verifying','stored_private','attached_private','expired')),
    current_generation_id text,
    verified_size bigint check (verified_size is null or verified_size >= 0),
    verified_sha256 text check (verified_sha256 is null or verified_sha256 ~ '^[a-f0-9]{64}$'),
    media_type text,
    verification_policy_version text,
    retention_deadline timestamptz,
    finalize_lease_owner text,
    finalize_lease_expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint ${C.blobRecordsVerifiedFactsCheck}
      check (logical_state not in ('stored_private','attached_private')
        or (verified_size is not null and verified_sha256 is not null and media_type is not null))
  )`,

  `create table blob_generations (
    generation_id text primary key,
    blob_id text not null,
    bucket text not null,
    key text not null,
    key_fingerprint text not null,
    generation_state text not null default 'allocated'
      constraint ${C.blobGenerationsStateCheck}
      check (generation_state in
        ('allocated','observed','active','orphaned','retired','deletion_pending','deleted','contract_corrupt','quarantined')),
    observed_etag text,
    observed_size bigint check (observed_size is null or observed_size >= 0),
    observed_content_type text,
    observed_metadata_keys text[] not null default '{}',
    observed_metadata_values text[] not null default '{}',
    retire_reason text check (retire_reason is null or retire_reason in ('replaced','orphaned','expired')),
    cleanup_attempt_token text,
    cleanup_lease_owner text,
    cleanup_lease_expires_at timestamptz,
    cleanup_lease_generation bigint not null default 0 check (cleanup_lease_generation >= 0),
    confirmed_absent_at timestamptz,
    deleted_at timestamptz,
    contract_corrupt_at timestamptz,
    quarantined_at timestamptz,
    quarantined_reason text,
    created_at timestamptz not null default now(),
    constraint ${C.blobGenerationsBlobFk}
      foreign key (blob_id) references blob_records(blob_id) on delete restrict,
    constraint ${C.blobGenerationsGenerationKeyFk}
      foreign key (generation_id) references generation_keys(generation_id) on delete restrict,
    constraint ${C.blobGenerationsDeletedFactsCheck}
      check (generation_state <> 'deleted' or (confirmed_absent_at is not null and deleted_at is not null)),
    constraint ${C.blobGenerationsCorruptFactsCheck}
      check (generation_state <> 'contract_corrupt' or contract_corrupt_at is not null),
    constraint ${C.blobGenerationsQuarantineFactsCheck}
      check (generation_state <> 'quarantined' or (quarantined_at is not null and quarantined_reason is not null)),
    constraint ${C.blobGenerationsMetadataAllowlistCheck}
      check (observed_metadata_keys <@ array[${METADATA_ALLOWLIST_ARRAY}]::text[]),
    constraint ${C.blobGenerationsMetadataShapeCheck}
      check (cardinality(observed_metadata_keys) = cardinality(observed_metadata_values)),
    constraint ${C.blobGenerationsBlobGenerationUnique} unique (blob_id, generation_id),
    constraint ${C.blobGenerationsKeyUnique} unique (key),
    constraint ${C.blobGenerationsKeyFingerprintUnique} unique (key_fingerprint)
  )`,

  `create function forbid_blob_generation_rebind() returns trigger language plpgsql as $$
    begin
      if new.generation_id is distinct from old.generation_id
        or new.blob_id is distinct from old.blob_id
        or new.bucket is distinct from old.bucket
        or new.key is distinct from old.key
        or new.key_fingerprint is distinct from old.key_fingerprint then
        raise exception 'blob_generations identity is immutable; a generation/key can never be rebound'
          using errcode = '23514';
      end if;
      return new;
    end
  $$`,

  `create trigger blob_generations_identity_immutable
    before update of generation_id, blob_id, bucket, key, key_fingerprint on blob_generations
    for each row execute function forbid_blob_generation_rebind()`,

  `create function assert_blob_generation_binds_generation_keys() returns trigger language plpgsql as $$
    declare bound_key text;
            bound_fingerprint text;
    begin
      select key, key_fingerprint into bound_key, bound_fingerprint
        from generation_keys where generation_id = new.generation_id;
      if not found then
        raise exception 'blob_generations generation_id must exist in the permanent generation_keys authority'
          using errcode = '23514';
      end if;
      if new.key is distinct from bound_key or new.key_fingerprint is distinct from bound_fingerprint then
        raise exception 'blob_generations key must equal the permanent generation_keys binding'
          using errcode = '23514';
      end if;
      return new;
    end
  $$`,

  `create trigger blob_generations_key_binding
    before insert or update of generation_id, key, key_fingerprint on blob_generations
    for each row execute function assert_blob_generation_binds_generation_keys()`,

  `alter table blob_records
    add constraint ${C.blobRecordsCurrentGenerationFk}
    foreign key (blob_id, current_generation_id)
    references blob_generations(blob_id, generation_id) deferrable initially deferred`,

  `create unique index ${C.blobGenerationsOneActivePerBlob}
    on blob_generations (blob_id) where generation_state = 'active'`,

  `create index blob_generations_cleanup_candidate_idx
    on blob_generations (created_at, generation_id)
    where generation_state in ('retired', 'orphaned', 'deletion_pending')`,

  `create table upload_intents (
    intent_id text primary key,
    blob_id text not null,
    generation_id text not null,
    principal_id text not null,
    collection_id text not null,
    subject_identity text not null,
    expected_size bigint check (expected_size is null or expected_size >= 0),
    expected_sha256 text check (expected_sha256 is null or expected_sha256 ~ '^[a-f0-9]{64}$'),
    media_hint text,
    policy_revision text not null,
    idempotency_key text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    constraint ${C.uploadIntentsGenerationUnique} unique (generation_id),
    constraint ${C.uploadIntentsBlobFk}
      foreign key (blob_id) references blob_records(blob_id) on delete restrict,
    constraint ${C.uploadIntentsGenerationFk}
      foreign key (generation_id) references blob_generations(generation_id) on delete restrict,
    constraint ${C.uploadIntentsIdempotencyUnique} unique (blob_id, idempotency_key)
  )`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of DDL_STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw('drop table if exists upload_intents').execute(db);
  await sql.raw(`alter table if exists blob_records drop constraint if exists ${C.blobRecordsCurrentGenerationFk}`).execute(db);
  await sql.raw('drop table if exists blob_generations').execute(db);
  await sql.raw('drop table if exists blob_records').execute(db);
  await sql.raw('drop table if exists generation_keys').execute(db);
  await sql.raw('drop function if exists forbid_generation_keys_mutation()').execute(db);
  await sql.raw('drop function if exists forbid_blob_generation_rebind()').execute(db);
  await sql.raw('drop function if exists assert_blob_generation_binds_generation_keys()').execute(db);
}

const migration: Migration = { up, down };
export default migration;
