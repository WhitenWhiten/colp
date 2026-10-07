import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { ATTACHMENTS_CONSTRAINT_NAMES } from '../src/modules/attachments/attachments-ledger-contract.js';

const C = ATTACHMENTS_CONSTRAINT_NAMES;

/**
 * P4A-I13 expand migration: the future Attachment binding on `blob_records`.
 *
 * The transaction-bound finalize handoff (P4A-I13) is the ONLY writer of these
 * columns: it locks the `stored_private` blob row + current active generation
 * FOR UPDATE, verifies owner/generation/ETag/verified facts/expiry/policy, and
 * atomically writes the unique future Attachment binding facts together with
 * the `stored_private -> attached_private` transition in the CALLER'S same
 * transaction. It never creates a production Attachment row, Collection
 * content revision, Operation, Audit or Outbox row (those belong to the future
 * Canonical Mutation caller).
 *
 * Columns:
 * - `attachment_binding_id`: unique future Attachment identity (reserved by
 *   the caller's global `resource_id_ledger`). A full unique constraint makes a
 *   cross-blob reuse a permanent identity violation (SQLSTATE 23505 ->
 *   `attachment_binding_issued`).
 * - `attached_at`: DB-clock bound time (never a JS wall clock).
 * - `attachment_binding_generation_id` / `attachment_binding_etag` /
 *   `attachment_binding_policy_version`: immutable snapshot of exactly what
 *   was fenced at bind time.
 *
 * CHECKs (terminal-facts rules):
 * - `blob_records_attached_binding_facts_check`: an `attached_private` row
 *   MUST carry the full binding facts set — a terminal row can never be
 *   half-bound.
 * - `blob_records_attached_binding_generation_check`: the binding snapshot's
 *   generation must equal the CURRENT generation. Combined with the port
 *   refusing replacement of an attached blob, a committed binding can never
 *   point at a moved generation.
 *
 * Expand-only: all new columns are nullable so N/N-1 binaries that predate the
 * finalize writer are unaffected. `down()` rolls back cleanly.
 */
const DDL_STATEMENTS: readonly string[] = [
  `alter table blob_records
    add column attachment_binding_id text,
    add column attached_at timestamptz,
    add column attachment_binding_generation_id text,
    add column attachment_binding_etag text,
    add column attachment_binding_policy_version text,
    add constraint ${C.blobRecordsAttachmentBindingUnique} unique (attachment_binding_id),
    add constraint ${C.blobRecordsAttachedBindingFactsCheck}
      check (logical_state <> 'attached_private'
        or (attachment_binding_id is not null and attached_at is not null
            and attachment_binding_generation_id is not null
            and attachment_binding_etag is not null
            and attachment_binding_policy_version is not null)),
    add constraint ${C.blobRecordsAttachedBindingGenerationCheck}
      check (attachment_binding_generation_id is null
        or attachment_binding_generation_id = current_generation_id)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of DDL_STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`alter table blob_records drop constraint if exists ${C.blobRecordsAttachedBindingGenerationCheck}`).execute(db);
  await sql.raw(`alter table blob_records drop constraint if exists ${C.blobRecordsAttachedBindingFactsCheck}`).execute(db);
  await sql.raw(`alter table blob_records drop constraint if exists ${C.blobRecordsAttachmentBindingUnique}`).execute(db);
  await sql.raw('alter table blob_records drop column if exists attachment_binding_policy_version').execute(db);
  await sql.raw('alter table blob_records drop column if exists attachment_binding_etag').execute(db);
  await sql.raw('alter table blob_records drop column if exists attachment_binding_generation_id').execute(db);
  await sql.raw('alter table blob_records drop column if exists attached_at').execute(db);
  await sql.raw('alter table blob_records drop column if exists attachment_binding_id').execute(db);
}

const migration: Migration = { up, down };
export default migration;