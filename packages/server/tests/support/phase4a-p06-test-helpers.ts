/**
 * P4A-P06 shared helpers for the focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * Provides:
 *  - the P06 fixture constants (owner/editor/outsider/foreign collections);
 *  - state-driving wrappers over the PRODUCTION ledger ports
 *    (seedP04StoredPrivate / Issued / Uploaded / Verifying / Expired), so the
 *    finalize route observes genuine ledger states — no test SQL manufactures
 *    a success path;
 *  - `finalizeHeaders`: the real mutation gate (session cookie + Origin +
 *    CSRF + Known-Command-Id) every finalize request must carry;
 *  - deterministic re-reads of the canonical finalize side effects (the
 *    Operation row keyed by the persisted commandId, the attachment row, the
 *    committed binding facts, the ordinal) used by the replay / rollback /
 *    commit-unknown / restart assertions;
 *  - `expectedP06AttachmentId`: the deterministic attachment identity the
 *    production use case derives from (principalId, blobId, commandId) —
 *    asserting it proves the idempotency binding is stable across replays.
 *
 * Re-reads are raw reads ONLY. Every WRITE path in the suites goes through
 * production ports; no test writes the target `attachments` row or the
 * finalize side effects directly (the negative controls only corrupt the
 * precondition facts the route must reject).
 */
import { sql } from 'kysely';
import type { DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { computeFinalizeAttachmentId } from '../../src/modules/attachments/index.js';
import {
  seedP04Expired,
  seedP04Issued,
  seedP04StoredPrivate,
  seedP04Uploaded,
  seedP04Verifying,
} from './phase4a-p04-test-helpers.js';
import { seedP03Collection } from './phase4a-p03-test-helpers.js';
import { identityFor, type I07MigrationRuntime } from './phase4a-i07-test-helpers.js';
import type { AuthenticatedTestClient } from './product-http-harness.js';

export const P06_ORIGIN = 'https://app.known.example';
export const P06_ISSUER = 'https://issuer.example';
export const P06_COLLECTION_A = 'p06-collection-a';
export const P06_COLLECTION_B = 'p06-collection-b';
export const P06_COLLECTION_C = 'p06-collection-c';
export const P06_COLLECTION_OTHER = 'p06-collection-other-owner';

/** The actor facts the blob ledger binds (session subject + account id). */
export interface P06BlobOwner {
  readonly subjectId: string;
  readonly principalId: string;
}

export function p06BlobOwnerOf(client: AuthenticatedTestClient): P06BlobOwner {
  return { subjectId: client.subjectId, principalId: client.accountId };
}

export async function seedP06Collection(
  runtime: I07MigrationRuntime['runtime'],
  options: {
    readonly collectionId: string;
    readonly ownerSubjectId: string;
    readonly members?: ReadonlyArray<{ readonly subjectId: string; readonly role: 'owner' | 'editor' | 'viewer' }>;
  },
): Promise<void> {
  await seedP03Collection(runtime, {
    collectionId: options.collectionId,
    ownerSubjectId: options.ownerSubjectId,
    members: options.members,
  });
}

/** Real mutation gate headers every finalize request must carry. */
export function finalizeHeaders(client: AuthenticatedTestClient, commandId: string): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: P06_ORIGIN,
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Production state seeds (logical states driven through the REAL ledger ports)
// ---------------------------------------------------------------------------

export function seedP06StoredPrivate(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  owner: P06BlobOwner,
  collectionId = P06_COLLECTION_A,
): ReturnType<typeof seedP04StoredPrivate> {
  return seedP04StoredPrivate(runtime, id, { owner, collectionId });
}

export function seedP06Issued(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  owner: P06BlobOwner,
  collectionId = P06_COLLECTION_A,
): ReturnType<typeof seedP04Issued> {
  return seedP04Issued(runtime, id, { owner, collectionId });
}

export function seedP06Uploaded(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  owner: P06BlobOwner,
  collectionId = P06_COLLECTION_A,
): ReturnType<typeof seedP04Uploaded> {
  return seedP04Uploaded(runtime, id, { owner, collectionId });
}

export function seedP06Verifying(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  owner: P06BlobOwner,
  collectionId = P06_COLLECTION_A,
): ReturnType<typeof seedP04Verifying> {
  return seedP04Verifying(runtime, id, { owner, collectionId });
}

export function seedP06Expired(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  owner: P06BlobOwner,
  collectionId = P06_COLLECTION_A,
): ReturnType<typeof seedP04Expired> {
  return seedP04Expired(runtime, id, { owner, collectionId });
}

// ---------------------------------------------------------------------------
// Deterministic attachment identity (the production idempotency binding)
// ---------------------------------------------------------------------------

export function expectedP06AttachmentId(principalId: string, blobId: string, commandId: string): string {
  return computeFinalizeAttachmentId(principalId, blobId, commandId);
}

// ---------------------------------------------------------------------------
// Side-effect re-reads (assertions only)
// ---------------------------------------------------------------------------

export interface P06FinalizeOperationRow {
  readonly operationId: string;
  readonly attachmentId: string;
  readonly blobId: string;
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly actorPrincipalId: string | null;
  readonly payloadJson: Record<string, unknown>;
}

interface P06FinalizeOperationSqlRow {
  operation_id: string;
  collection_id: string;
  commit_ordinal: bigint;
  payload_json: Record<string, unknown>;
  actor_principal_id: string | null;
}

/**
 * The committed finalize Operation for a Known-Command-Id (the use case
 * persists the commandId in the operation payload). Returns null when the
 * command never committed.
 */
export async function readP06FinalizeOperationByCommandId(
  runtime: DatabaseRuntime,
  commandId: string,
): Promise<P06FinalizeOperationRow | null> {
  const rows = await sql<P06FinalizeOperationSqlRow>`
    select operation.operation_id, operation.collection_id, operation.commit_ordinal,
      payload.payload_json, operation.actor_principal_id
    from operation_lookup_facts fact
    join operations operation on operation.operation_id=fact.operation_id
    join operation_payloads payload on payload.operation_id=fact.operation_id
    where fact.operation_type = 'attachment.finalized'
      and fact.command_id = ${commandId}
    order by operation.commit_ordinal desc
    limit 1
  `.execute(runtime.db);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    operationId: row.operation_id,
    attachmentId: String(row.payload_json['attachmentId'] ?? ''),
    blobId: String(row.payload_json['blobId'] ?? ''),
    collectionId: row.collection_id,
    commitOrdinal: BigInt(row.commit_ordinal),
    actorPrincipalId: row.actor_principal_id,
    payloadJson: row.payload_json,
  };
}

/** Number of committed finalize Operations for a Known-Command-Id. */
export async function p06FinalizeOperationCount(runtime: DatabaseRuntime, commandId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count
    from operation_lookup_facts
    where operation_type = 'attachment.finalized'
      and command_id = ${commandId}
  `.execute(runtime.db);
  return Number(rows.rows[0]!.count);
}

/** Whether a blob still carries its verification outbox rows (non-finalize). */
export async function p06BlobOutboxHandlerNames(runtime: DatabaseRuntime, blobId: string): Promise<string[]> {
  const rows = await sql<{ handler_name: string }>`
    select distinct handler_name from outbox_events where aggregate_id = ${blobId} order by handler_name
  `.execute(runtime.db);
  return rows.rows.map((row) => row.handler_name);
}

/** The blob's committed binding snapshot (null when still stored_private). */
export async function readP06BlobBinding(
  runtime: DatabaseRuntime,
  blobId: string,
): Promise<{
  logicalState: string;
  attachmentBindingId: string | null;
  attachmentBindingGenerationId: string | null;
  attachedAt: Date | null;
} | null> {
  const rows = await sql<{
    logical_state: string;
    attachment_binding_id: string | null;
    attachment_binding_generation_id: string | null;
    attached_at: Date | null;
  }>`
    select logical_state, attachment_binding_id, attachment_binding_generation_id, attached_at
    from blob_records where blob_id = ${blobId}
  `.execute(runtime.db);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    logicalState: row.logical_state,
    attachmentBindingId: row.attachment_binding_id,
    attachmentBindingGenerationId: row.attachment_binding_generation_id,
    attachedAt: row.attached_at,
  };
}
