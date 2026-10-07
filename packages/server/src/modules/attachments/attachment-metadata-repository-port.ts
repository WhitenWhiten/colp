/**
 * P4A-P02 transaction-bound owner-private Attachment metadata repository port.
 *
 * Every method REQUIRES a caller-provided transaction and never opens a new
 * connection. The port is generic over the transaction type so the module
 * never leaks Kysely/pg types; the PostgreSQL binding lives in
 * `src/infrastructure/database/attachment-metadata-postgres.ts`.
 *
 * The `attachments` row stores ONLY owner-private snapshot facts (sanitized
 * filename, media type, verified size, collection, owner, DB-clock bind time,
 * retirement/deletion facts). It never stores the R2 key, key fingerprint,
 * bucket, URL or any credential; blob/generation facts stay bound through the
 * `blob_records` FK + the `attachments_blob_binding` trigger.
 */
import type { PhaseBarrier } from './attachments-ledger-contract.js';

export type AttachmentLogicalState = 'attached_private' | 'retired' | 'deleted';

/** Read projection of one committed Attachment metadata row. */
export interface AttachmentMetadataFacts {
  readonly attachmentId: string;
  readonly blobId: string;
  readonly collectionId: string;
  readonly ownerSubjectId: string;
  readonly sanitizedFilename: string | null;
  readonly mediaType: string | null;
  readonly size: number | null;
  readonly logicalState: AttachmentLogicalState;
  /** DB-clock bind time written by the canonical assembly from the handoff binding. */
  readonly attachedAt: Date;
  readonly retiredAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InsertAttachmentMetadataInput {
  readonly attachmentId: string;
  readonly blobId: string;
  readonly collectionId: string;
  readonly ownerSubjectId: string;
  readonly sanitizedFilename: string | null;
  readonly mediaType: string | null;
  readonly size: number | null;
  readonly attachedAt: Date;
}

export type InsertAttachmentMetadataResult =
  | { outcome: 'inserted'; attachment: AttachmentMetadataFacts }
  | { outcome: 'already_exists'; attachment: AttachmentMetadataFacts }
  | { outcome: 'binding_conflict'; existingAttachmentId: string };

export type ReadAttachmentMetadataResult =
  | { outcome: 'found'; attachment: AttachmentMetadataFacts }
  | { outcome: 'not_found' };

export interface AttachmentMetadataRepositoryPortOptions {
  /** Deterministic test seam; defaults to a no-op barrier. */
  readonly barrier?: PhaseBarrier;
}

export interface AttachmentMetadataRepositoryPort<Transaction> {
  /**
   * Inserts the metadata row inside the caller's transaction. A duplicate on
   * the same blob returns `binding_conflict` (the committed row is re-read,
   * never guessed); a duplicate attachment id returns `already_exists` with
   * the committed row. All identity/constraint violations that are NOT a
   * same-row replay propagate as database failures.
   */
  insertAttachmentMetadata(
    transaction: Transaction,
    input: InsertAttachmentMetadataInput,
    options?: AttachmentMetadataRepositoryPortOptions,
  ): Promise<InsertAttachmentMetadataResult>;

  readAttachmentMetadataByBlobId(
    transaction: Transaction,
    blobId: string,
    options?: AttachmentMetadataRepositoryPortOptions,
  ): Promise<ReadAttachmentMetadataResult>;

  readAttachmentMetadataById(
    transaction: Transaction,
    attachmentId: string,
    options?: AttachmentMetadataRepositoryPortOptions,
  ): Promise<ReadAttachmentMetadataResult>;
}
