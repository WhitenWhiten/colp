/**
 * Shared helpers for the P4A-P02 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * Builds on the I13 seed helpers (PRODUCTION ledger to `stored_private` via
 * allocate -> completeUploadCas -> claimVerification -> completeVerification)
 * and adds:
 * - a production-shaped Collection + root bootstrap (resource_id_ledger +
 *   collections + nodes rows) so the P02 canonical finalize assembly can lock
 *   and authorize a REAL Collection (the attachments row carries an FK to
 *   collections(id) and the assembly bumps the collection commit ordinal);
 * - deterministic `FinalizeAttachmentInput` builders derived from the I13
 *   fixture identities;
 * - side-effect re-reads (Attachment metadata row, blob binding, Operation,
 *   Audit, Outbox, resource ledger, collection ordinal) used by the rollback /
 *   commit-unknown / replay / race assertions.
 *
 * Re-reads are raw reads ONLY. Every WRITE path in the suites goes through
 * production ports (I13 ledger seed + the P02 canonical assembly); no test
 * writes the target `attachments` row or the finalize side effects directly.
 */
import { sql } from 'kysely';
import { createPostgresAttachmentCanonicalMutationPorts, createUnitOfWork } from '../../src/infrastructure/database/index.js';
import type { DatabaseRuntime, DatabaseTransaction } from '../../src/infrastructure/database/index.js';
import type {
  AttachmentCanonicalMutationPort,
  FinalizeAttachmentInput,
  FinalizeAttachmentResult,
} from '../../src/modules/attachments/index.js';
import {
  I13_MEDIA_TYPE,
  I13_POLICY_VERSION,
  I13_PRINCIPAL_OWNER,
  i13Body,
  seedStoredPrivate,
  sha256HexBytes,
  slotOf,
} from './phase4a-i13-test-helpers.js';
import type { I07MigrationRuntime } from './phase4a-i07-test-helpers.js';
import { identityFor } from './phase4a-i07-test-helpers.js';

export const P02_SUBJECT_OWNER = 'p02-subject-owner';
export const P02_PRINCIPAL_OWNER = 'p02-principal-owner';
export const P02_OTHER_SUBJECT = 'p02-other-subject';
export const P02_COLLECTION_A = 'p02-collection-a';
export const P02_COLLECTION_B = 'p02-collection-b';
export const P02_COLLECTION_C = 'p02-collection-c';
export const P02_COLLECTION_OTHER = 'p02-collection-other-owner';

export interface P02CollectionSeedOptions {
  readonly ownerSubjectId?: string;
  readonly title?: string;
}

/**
 * Bootstraps a production-shaped Collection (ledger + collections row + root
 * node) so the canonical finalize assembly can lock/authorize it and the
 * `attachments.collection_id` FK can reference it. Mirrors the Phase 1
 * bootstrap shape (deferred root constraints are satisfied inside one
 * transaction).
 */
export async function seedP02Collection(
  runtime: I07MigrationRuntime['runtime'],
  collectionId: string,
  options: P02CollectionSeedOptions = {},
): Promise<void> {
  const rootId = `${collectionId}-root`;
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    await sql`
      insert into resource_id_ledger (resource_id, resource_type)
      values (${collectionId}, 'collection'), (${rootId}, 'node')
    `.execute(transaction);
    await sql`
      insert into collections
        (id, owner_subject_id, title, summary, kind, visibility, root_node_id,
         resource_revision, content_revision, policy_revision, publication_slug,
         published_at, allow_search_indexing, created_at, updated_at)
      values (${collectionId}, ${options.ownerSubjectId ?? P02_SUBJECT_OWNER},
         ${options.title ?? 'P02 attachment collection'}, 'p02 summary', 'bookmarks',
         'private', ${rootId}, 'r1', 'c1', 'p1', null, null, false, now(), now())
    `.execute(transaction);
    await sql`
      insert into nodes
        (id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision, created_at, updated_at)
      values (${rootId}, ${collectionId}, null, 'folder', true, 'Root', null, null, '[]'::jsonb,
         'inherit', null, 'r1', 'ch1', now(), now())
    `.execute(transaction);
  });
}

/** Soft-deletes a seeded collection together with its root node. */
export async function deleteP02Collection(
  runtime: I07MigrationRuntime['runtime'],
  collectionId: string,
): Promise<void> {
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    await sql`
      update nodes set deleted_at = now(), updated_at = now()
      where collection_id = ${collectionId} and is_root
    `.execute(transaction);
    await sql`
      update collections set deleted_at = now(), updated_at = now()
      where id = ${collectionId}
    `.execute(transaction);
  });
}

/**
 * Deterministic P02 canonical finalize input derived from an I13 fixture
 * identity. The blob must have been seeded to `stored_private` on
 * `options.collectionId` with `options.ownerSubjectId` (see
 * `seedStoredPrivate`), otherwise the assembly rejects.
 */
export function p02FinalizeInput(
  id: ReturnType<typeof identityFor>,
  overrides: Partial<FinalizeAttachmentInput> = {},
): FinalizeAttachmentInput {
  const body = i13Body(slotOf(id));
  return {
    blobId: id.blobId,
    attachmentId: `p02-attachment-${id.generationId}`,
    operationId: `p02-operation-${id.generationId}`,
    collectionId: P02_COLLECTION_A,
    ownerSubjectId: P02_SUBJECT_OWNER,
    sanitizedFilename: `photo-${slotOf(id)}.png`,
    expectedGenerationId: id.generationId,
    expectedEtag: `"etag-${id.generationId}"`,
    verifiedSize: body.byteLength,
    verifiedSha256: sha256HexBytes(body),
    mediaType: I13_MEDIA_TYPE,
    policyRevision: I13_POLICY_VERSION,
    actorPrincipalId: P02_PRINCIPAL_OWNER,
    ...overrides,
  };
}

/** Narrow unit-of-work adapter: every execute opens a NEW transaction. */
export function p02Uow(runtime: DatabaseRuntime) {
  return {
    execute<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result> {
      return createUnitOfWork(runtime.db).execute(({ transaction }) => callback(transaction));
    },
  };
}

/**
 * Runs the production canonical finalize assembly inside a fresh transaction.
 * Per-call barrier options are passed through.
 */
export function finalizeInTx(
  runtime: DatabaseRuntime,
  assembly: AttachmentCanonicalMutationPort<DatabaseTransaction>,
  input: FinalizeAttachmentInput,
  options: { barrier?: { arriveAndWait(name: string): Promise<void> } } = {},
): Promise<FinalizeAttachmentResult> {
  return createUnitOfWork(runtime.db).execute(({ transaction }) =>
    assembly.finalizeAttachment(transaction, input, options));
}

// ---------------------------------------------------------------------------
// Side-effect re-reads (assertions only)
// ---------------------------------------------------------------------------

export interface P02AttachmentRow {
  readonly attachmentId: string;
  readonly blobId: string;
  readonly collectionId: string;
  readonly ownerSubjectId: string;
  readonly sanitizedFilename: string | null;
  readonly mediaType: string | null;
  readonly size: number | null;
  readonly logicalState: string;
  readonly attachedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
}

interface P02AttachmentSqlRow {
  attachment_id: string;
  blob_id: string;
  collection_id: string;
  owner_subject_id: string;
  sanitized_filename: string | null;
  media_type: string | null;
  size: string | null;
  logical_state: string;
  attached_at: Date | null;
  retired_at: Date | null;
  deleted_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
}

function mapAttachmentRow(row: P02AttachmentSqlRow): P02AttachmentRow {
  return {
    attachmentId: row.attachment_id,
    blobId: row.blob_id,
    collectionId: row.collection_id,
    ownerSubjectId: row.owner_subject_id,
    sanitizedFilename: row.sanitized_filename,
    mediaType: row.media_type,
    size: row.size === null ? null : Number(row.size),
    logicalState: row.logical_state,
    attachedAt: row.attached_at,
    retiredAt: row.retired_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function readAttachmentRow(
  runtime: DatabaseRuntime,
  blobId: string,
): Promise<P02AttachmentRow | null> {
  const rows = await sql<P02AttachmentSqlRow>`
    select attachment_id, blob_id, collection_id, owner_subject_id, sanitized_filename,
           media_type, size::text, logical_state, attached_at, retired_at, deleted_at,
           created_at, updated_at
    from attachments where blob_id = ${blobId}
  `.execute(runtime.db);
  if (rows.rows.length === 0) return null;
  return mapAttachmentRow(rows.rows[0]!);
}

export interface P02OperationRow {
  readonly operationId: string;
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly operationType: string;
  readonly payloadJson: Record<string, unknown>;
  readonly actorPrincipalId: string | null;
}

interface P02OperationSqlRow {
  operation_id: string;
  collection_id: string;
  commit_ordinal: bigint;
  operation_type: string;
  payload_json: Record<string, unknown>;
  actor_principal_id: string | null;
}

export async function readOperationRow(
  runtime: DatabaseRuntime,
  operationId: string,
): Promise<P02OperationRow | null> {
  const rows = await sql<P02OperationSqlRow>`
    select operation.operation_id, operation.collection_id, operation.commit_ordinal,
           operation.operation_type, payload.payload_json, operation.actor_principal_id
    from operations operation join operation_payloads payload using (operation_id)
    where operation.operation_id = ${operationId}
  `.execute(runtime.db);
  if (rows.rows.length === 0) return null;
  const row = rows.rows[0]!;
  return {
    operationId: row.operation_id,
    collectionId: row.collection_id,
    commitOrdinal: BigInt(row.commit_ordinal),
    operationType: row.operation_type,
    payloadJson: row.payload_json,
    actorPrincipalId: row.actor_principal_id,
  };
}

export interface P02AuditRow {
  readonly operationId: string;
  readonly collectionId: string;
  readonly principalId: string | null;
  readonly eventType: string;
  readonly detailsJson: Record<string, unknown>;
}

interface P02AuditSqlRow {
  operation_id: string;
  collection_id: string;
  principal_id: string | null;
  event_type: string;
  details_json: Record<string, unknown>;
}

export async function readAuditRow(
  runtime: DatabaseRuntime,
  operationId: string,
): Promise<P02AuditRow | null> {
  const rows = await sql<P02AuditSqlRow>`
    select event.operation_id, event.collection_id, event.principal_id, event.event_type,
           payload.details_json
    from audit_events event join audit_event_payloads payload on payload.event_id = event.id
    where event.operation_id = ${operationId}
  `.execute(runtime.db);
  if (rows.rows.length === 0) return null;
  const row = rows.rows[0]!;
  return {
    operationId: row.operation_id,
    collectionId: row.collection_id,
    principalId: row.principal_id,
    eventType: row.event_type,
    detailsJson: row.details_json,
  };
}

export interface P02OutboxRow {
  readonly outboxId: string;
  readonly domainEventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly handlerName: string;
  readonly handlerMode: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateScope: string | null;
  readonly commitOrdinal: bigint | null;
  readonly payloadJson: Record<string, unknown>;
  readonly state: string;
}

interface P02OutboxSqlRow {
  outbox_id: string;
  domain_event_id: string;
  event_type: string;
  event_version: number;
  handler_name: string;
  handler_mode: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_scope: string | null;
  commit_ordinal: bigint | null;
  payload_json: Record<string, unknown>;
  state: string;
}

/**
 * Outbox rows of the FINALIZE event for the given blob (the verification
 * seed rows share the blob aggregate id, so the handler name is the filter).
 */
export async function readOutboxRows(
  runtime: DatabaseRuntime,
  blobId: string,
): Promise<P02OutboxRow[]> {
  const rows = await sql<P02OutboxSqlRow>`
    select outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
           aggregate_type, aggregate_id, aggregate_scope, commit_ordinal, payload_json, state
    from outbox_events
    where aggregate_id = ${blobId}
      and handler_name = 'attachments_finalize_attachment'
    order by available_at, outbox_id
  `.execute(runtime.db);
  return rows.rows.map((row) => ({
    outboxId: row.outbox_id,
    domainEventId: row.domain_event_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    handlerName: row.handler_name,
    handlerMode: row.handler_mode,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateScope: row.aggregate_scope,
    commitOrdinal: row.commit_ordinal === null ? null : BigInt(row.commit_ordinal),
    payloadJson: row.payload_json,
    state: row.state,
  }));
}

/** All resource_ids currently committed in the immutable ledger. */
export async function readLedgerIds(runtime: DatabaseRuntime): Promise<string[]> {
  const rows = await sql<{ resource_id: string }>`
    select resource_id from resource_id_ledger order by resource_id
  `.execute(runtime.db);
  return rows.rows.map((row) => row.resource_id);
}

export interface P02CollectionRow {
  readonly commitOrdinal: bigint;
  readonly updatedAt: Date | null;
  readonly deletedAt: Date | null;
}

export async function readP02CollectionRow(
  runtime: DatabaseRuntime,
  collectionId: string,
): Promise<P02CollectionRow | null> {
  const rows = await sql<{ commit_ordinal: bigint; updated_at: Date | null; deleted_at: Date | null }>`
    select commit_ordinal, updated_at, deleted_at from collections where id = ${collectionId}
  `.execute(runtime.db);
  if (rows.rows.length === 0) return null;
  const row = rows.rows[0]!;
  return { commitOrdinal: BigInt(row.commit_ordinal), updatedAt: row.updated_at, deletedAt: row.deleted_at };
}

/**
 * Full finalize side-effect snapshot used by rollback / replay assertions:
 * Attachment metadata rows for the attachment, the blob binding facts,
 * Operation / Audit / Outbox rows for the operation, the collection ordinal,
 * and the complete immutable ledger id set. A rolled-back transaction must
 * leave ALL of these byte-identical.
 */
export interface P02FinalizeSideEffects {
  readonly attachments: P02AttachmentRow[];
  readonly blob: {
    logicalState: string;
    currentGenerationId: string | null;
    attachmentBindingId: string | null;
    attachedAt: Date | null;
    attachmentBindingGenerationId: string | null;
    attachmentBindingEtag: string | null;
    attachmentBindingPolicyVersion: string | null;
  } | null;
  readonly operations: P02OperationRow[];
  readonly audits: P02AuditRow[];
  readonly outbox: P02OutboxRow[];
  readonly collection: P02CollectionRow | null;
  readonly ledger: string[];
}

export async function readFinalizeSideEffects(
  runtime: DatabaseRuntime,
  blobId: string,
  attachmentId: string,
  operationId: string,
): Promise<P02FinalizeSideEffects> {
  const blobRows = await sql<P02BlobSqlRow>`
    select logical_state, current_generation_id, attachment_binding_id, attached_at,
           attachment_binding_generation_id, attachment_binding_etag, attachment_binding_policy_version
    from blob_records where blob_id = ${blobId}
  `.execute(runtime.db);
  const blobRow = blobRows.rows[0];
  const operationRows = await sql<P02OperationSqlRow>`
    select operation.operation_id, operation.collection_id, operation.commit_ordinal,
           operation.operation_type, payload.payload_json, operation.actor_principal_id
    from operations operation join operation_payloads payload using (operation_id)
    where operation.operation_id = ${operationId}
  `.execute(runtime.db);
  const auditRows = await sql<P02AuditSqlRow>`
    select event.operation_id, event.collection_id, event.principal_id, event.event_type,
           payload.details_json
    from audit_events event join audit_event_payloads payload on payload.event_id = event.id
    where event.operation_id = ${operationId}
  `.execute(runtime.db);
  const attachmentRows = await sql<P02AttachmentSqlRow>`
    select attachment_id, blob_id, collection_id, owner_subject_id, sanitized_filename,
           media_type, size::text, logical_state, attached_at, retired_at, deleted_at,
           created_at, updated_at
    from attachments where attachment_id = ${attachmentId}
  `.execute(runtime.db);
  const outboxRows = await sql<P02OutboxSqlRow>`
    select outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
           aggregate_type, aggregate_id, aggregate_scope, commit_ordinal, payload_json, state, available_at
    from outbox_events
    where aggregate_id = ${blobId}
      and handler_name = 'attachments_finalize_attachment'
    order by available_at, outbox_id
  `.execute(runtime.db);
  const ledgerRows = await sql<{ resource_id: string }>`
    select resource_id from resource_id_ledger order by resource_id
  `.execute(runtime.db);
  const operation = operationRows.rows[0];
  const collection = operation
    ? await readP02CollectionRow(runtime, operation.collection_id)
    : null;
  return {
    attachments: attachmentRows.rows.map(mapAttachmentRow),
    blob: blobRow
      ? {
        logicalState: blobRow.logical_state,
        currentGenerationId: blobRow.current_generation_id,
        attachmentBindingId: blobRow.attachment_binding_id,
        attachedAt: blobRow.attached_at,
        attachmentBindingGenerationId: blobRow.attachment_binding_generation_id,
        attachmentBindingEtag: blobRow.attachment_binding_etag,
        attachmentBindingPolicyVersion: blobRow.attachment_binding_policy_version,
      }
      : null,
    operations: operationRows.rows.map((row) => ({
      operationId: row.operation_id,
      collectionId: row.collection_id,
      commitOrdinal: BigInt(row.commit_ordinal),
      operationType: row.operation_type,
      payloadJson: row.payload_json,
      actorPrincipalId: row.actor_principal_id,
    })),
    audits: auditRows.rows.map((row) => ({
      operationId: row.operation_id,
      collectionId: row.collection_id,
      principalId: row.principal_id,
      eventType: row.event_type,
      detailsJson: row.details_json,
    })),
    outbox: outboxRows.rows.map((row) => ({
      outboxId: row.outbox_id,
      domainEventId: row.domain_event_id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      handlerName: row.handler_name,
      handlerMode: row.handler_mode,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateScope: row.aggregate_scope,
      commitOrdinal: row.commit_ordinal === null ? null : BigInt(row.commit_ordinal),
      payloadJson: row.payload_json,
      state: row.state,
    })),
    collection,
    ledger: ledgerRows.rows.map((row) => row.resource_id),
  };
}

interface P02BlobSqlRow {
  logical_state: string;
  current_generation_id: string | null;
  attachment_binding_id: string | null;
  attached_at: Date | null;
  attachment_binding_generation_id: string | null;
  attachment_binding_etag: string | null;
  attachment_binding_policy_version: string | null;
}

/**
 * Convenience: seeds the blob to `stored_private` bound to the P02 owner and
 * the given P02 collection (the intent's collection must equal the finalize
 * input's collection, enforced by the assembly). Pass-through options mirror
 * the I13 seed (ownerSubjectId / principalId / retentionExpired).
 */
export async function seedP02StoredPrivate(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  collectionId = P02_COLLECTION_A,
  options: {
    readonly ownerSubjectId?: string;
    readonly principalId?: string;
    readonly retentionExpired?: boolean;
  } = {},
): Promise<{ body: Uint8Array; digest: string }> {
  return seedStoredPrivate(runtime, id, {
    ownerSubjectId: options.ownerSubjectId ?? P02_SUBJECT_OWNER,
    principalId: options.principalId ?? P02_PRINCIPAL_OWNER,
    collectionId,
    retentionExpired: options.retentionExpired,
  });
}

export { createPostgresAttachmentCanonicalMutationPorts, identityFor };
