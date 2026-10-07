import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { ATTACHMENTS_CONSTRAINT_NAMES } from '../src/modules/attachments/attachments-ledger-contract.js';

const C = ATTACHMENTS_CONSTRAINT_NAMES;

/**
 * P4A-P02 expand migration: the owner-private Attachment metadata table.
 *
 * `attachments` is the durable metadata row of a finalized private
 * Attachment. The Canonical Mutation assembly (P4A-P02) writes it in the SAME
 * transaction as the I13 finalize handoff (blob binding), the resource ID
 * ledger reservations, the Operation/Audit/Outbox rows and the Collection
 * commit-ordinal advance; the DB guarantees the invariants:
 *
 * - `attachment_id` is the ledger-reserved identity and MUST equal the
 *   committed `blob_records.attachment_binding_id` of the SAME blob
 *   (`attachments_blob_binding` trigger, SQLSTATE 23514): the metadata row
 *   can never point at a different binding, a different blob, a non-terminal
 *   blob state, or a different owner.
 * - `attachments_blob_id_unique` (named unique) plus the trigger make a
 *   second Attachment on the same blob a permanent identity violation; the
 *   binding itself is already globally unique on `blob_records`.
 * - the row carries ONLY owner-private snapshot facts: sanitized filename,
 *   media type and verified size. It NEVER stores the R2 key, key
 *   fingerprint, bucket, URL or any credential (the column set is pinned by
 *   the migration test), and the `sanitized_filename_check` rejects path
 *   separators, control characters, surrounding whitespace and over-long
 *   values at the database.
 * - retirement/deletion are terminal FACTS: `retired` requires `retired_at`,
 *   `deleted` requires `deleted_at`, and an `attached_private` row must be
 *   free of both timestamps.
 * - `collection_id` is a real FK to `collections(id)` and `attachment_id` a
 *   real FK to the immutable `resource_id_ledger`: an id that was never
 *   reserved, or a Collection that does not exist, cannot be bound.
 *
 * Additive-only: a brand-new table cannot affect N/N-1 binaries that predate
 * it (the previous head's read surface is untouched; proven by the P02
 * N/N-1 suite). `down()` drops the trigger/function/table cleanly (the
 * destructive rollback of attachment metadata is an application rollback
 * decision, not a data-preserving path).
 */
const DDL_STATEMENTS: readonly string[] = [
  `create table attachments (
    attachment_id text primary key,
    blob_id text not null,
    collection_id text not null,
    owner_subject_id text not null,
    sanitized_filename text,
    media_type text,
    size bigint,
    logical_state text not null default 'attached_private',
    attached_at timestamptz not null,
    retired_at timestamptz,
    deleted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint ${C.attachmentsLogicalStateCheck}
      check (logical_state in ('attached_private', 'retired', 'deleted')),
    constraint ${C.attachmentsSizeCheck}
      check (size is null or size >= 0),
    constraint ${C.attachmentsSanitizedFilenameCheck}
      check (sanitized_filename is null or (
        octet_length(sanitized_filename) between 1 and 255
        and sanitized_filename !~ '[/\\\\]'
        and sanitized_filename !~ '[[:cntrl:]]'
        and sanitized_filename = btrim(sanitized_filename)
      )),
    constraint ${C.attachmentsRetirementFactsCheck}
      check (logical_state <> 'retired' or retired_at is not null),
    constraint ${C.attachmentsDeletionFactsCheck}
      check (logical_state <> 'deleted' or deleted_at is not null),
    constraint ${C.attachmentsActiveStateFactsCheck}
      check (logical_state <> 'attached_private'
        or (retired_at is null and deleted_at is null)),
    constraint ${C.attachmentsLedgerFk}
      foreign key (attachment_id) references resource_id_ledger(resource_id) on delete restrict,
    constraint ${C.attachmentsBlobFk}
      foreign key (blob_id) references blob_records(blob_id) on delete restrict,
    constraint ${C.attachmentsCollectionFk}
      foreign key (collection_id) references collections(id) on delete restrict,
    constraint ${C.attachmentsBlobUnique}
      unique (blob_id)
  )`,

  `create function assert_attachment_binds_blob_records() returns trigger language plpgsql as $$
    declare blob_state text;
            bound_binding_id text;
            blob_owner text;
    begin
      select logical_state, attachment_binding_id, owner_subject_id
        into blob_state, bound_binding_id, blob_owner
        from blob_records where blob_id = new.blob_id;
      if not found then
        raise exception 'attachments blob_id must reference an existing blob_records row'
          using errcode = '23514';
      end if;
      if bound_binding_id is null or new.attachment_id is distinct from bound_binding_id then
        raise exception 'attachments attachment_id must equal the committed blob_records attachment binding id'
          using errcode = '23514';
      end if;
      if blob_state is distinct from 'attached_private' then
        raise exception 'attachments metadata requires the blob to be attached_private'
          using errcode = '23514';
      end if;
      if new.owner_subject_id is distinct from blob_owner then
        raise exception 'attachments owner_subject_id must equal the blob_records owner binding'
          using errcode = '23514';
      end if;
      return new;
    end
  $$`,

  `create trigger attachments_blob_binding
    before insert or update of attachment_id, blob_id, owner_subject_id on attachments
    for each row execute function assert_attachment_binds_blob_records()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of DDL_STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw('drop trigger if exists attachments_blob_binding on attachments').execute(db);
  await sql.raw('drop function if exists assert_attachment_binds_blob_records()').execute(db);
  await sql.raw('drop table if exists attachments').execute(db);
}

const migration: Migration = { up, down };
export default migration;
