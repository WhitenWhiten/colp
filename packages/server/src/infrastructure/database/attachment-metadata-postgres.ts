/**
 * P4A-P02 transaction-bound PostgreSQL Attachment metadata repository.
 *
 * Every method REQUIRES the caller-provided transaction and never opens a new
 * connection. The `attachments` row is the expand-migration metadata surface
 * (202608080500_phase4a_p02_attachment_metadata): owner-private snapshot
 * facts only — no R2 key, URL, credential or unsanitized filename (the DB
 * CHECK + trigger are the durable backstop). The reads resolve through the
 * unique blob binding index / primary key (query-plan proven by the P02
 * suite); the insert maps a same-blob duplicate to `binding_conflict` and a
 * same-id duplicate to `already_exists` by RE-READING the committed row
 * (never guessing from the exception).
 */
import { sql } from 'kysely';
import type { DatabaseTransaction } from './unit-of-work.js';
import { DatabaseOperationError, classifyDatabaseError } from './errors.js';
import {
  ATTACHMENTS_CONSTRAINT_NAMES,
  NOOP_BARRIER,
  type PhaseBarrier,
} from '../../modules/attachments/index.js';
import type {
  AttachmentMetadataFacts,
  AttachmentMetadataRepositoryPort,
  AttachmentMetadataRepositoryPortOptions,
  InsertAttachmentMetadataInput,
  InsertAttachmentMetadataResult,
  ReadAttachmentMetadataResult,
} from '../../modules/attachments/index.js';

const C = ATTACHMENTS_CONSTRAINT_NAMES;

interface AttachmentSqlRow {
  attachment_id: string;
  blob_id: string;
  collection_id: string;
  owner_subject_id: string;
  sanitized_filename: string | null;
  media_type: string | null;
  size: string | null;
  logical_state: 'attached_private' | 'retired' | 'deleted';
  attached_at: Date;
  retired_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const METADATA_COLUMNS = sql`attachment_id, blob_id, collection_id, owner_subject_id,
  sanitized_filename, media_type, size::text, logical_state, attached_at, retired_at,
  deleted_at, created_at, updated_at`;

function mapAttachmentRow(row: AttachmentSqlRow): AttachmentMetadataFacts {
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

function barrierOf(options: AttachmentMetadataRepositoryPortOptions | undefined): PhaseBarrier {
  return options?.barrier ?? NOOP_BARRIER;
}

function classifyInsertViolation(error: unknown): DatabaseOperationError | null {
  const classified = error instanceof DatabaseOperationError
    ? error
    : classifyDatabaseError(error, false);
  if (classified.kind === 'unique_violation') return classified;
  return null;
}

async function readByBlobId(
  tx: DatabaseTransaction,
  blobId: string,
): Promise<ReadAttachmentMetadataResult> {
  const rows = await sql<AttachmentSqlRow>`
    select ${METADATA_COLUMNS} from attachments where blob_id = ${blobId}
  `.execute(tx);
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  return { outcome: 'found', attachment: mapAttachmentRow(rows.rows[0]!) };
}

async function readById(
  tx: DatabaseTransaction,
  attachmentId: string,
): Promise<ReadAttachmentMetadataResult> {
  const rows = await sql<AttachmentSqlRow>`
    select ${METADATA_COLUMNS} from attachments where attachment_id = ${attachmentId}
  `.execute(tx);
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  return { outcome: 'found', attachment: mapAttachmentRow(rows.rows[0]!) };
}

async function insertAttachmentMetadata(
  tx: DatabaseTransaction,
  input: InsertAttachmentMetadataInput,
  options: AttachmentMetadataRepositoryPortOptions = {},
): Promise<InsertAttachmentMetadataResult> {
  // Hard runtime guard: this port is transaction-bound by contract.
  if (!tx) throw new Error('attachment_metadata_requires_transaction');
  const barrier = barrierOf(options);
  try {
    const inserted = await sql<AttachmentSqlRow>`
      insert into attachments
        (attachment_id, blob_id, collection_id, owner_subject_id, sanitized_filename,
         media_type, size, logical_state, attached_at, created_at, updated_at)
      values (${input.attachmentId}, ${input.blobId}, ${input.collectionId},
        ${input.ownerSubjectId}, ${input.sanitizedFilename}, ${input.mediaType},
        ${input.size}, 'attached_private', ${input.attachedAt}, now(), now())
      returning ${METADATA_COLUMNS}
    `.execute(tx);
    await barrier.arriveAndWait('attachment_metadata_inserted');
    return { outcome: 'inserted', attachment: mapAttachmentRow(inserted.rows[0]!) };
  } catch (error) {
    const violation = classifyInsertViolation(error);
    if (violation !== null && violation.constraint === C.attachmentsBlobUnique) {
      const existing = await readByBlobId(tx, input.blobId);
      if (existing.outcome === 'found') {
        return { outcome: 'binding_conflict', existingAttachmentId: existing.attachment.attachmentId };
      }
    }
    if (violation !== null && violation.constraint === 'attachments_pkey') {
      const existing = await readById(tx, input.attachmentId);
      if (existing.outcome === 'found') {
        return { outcome: 'already_exists', attachment: existing.attachment };
      }
    }
    throw error;
  }
}

export function createPostgresAttachmentMetadataRepository(): AttachmentMetadataRepositoryPort<DatabaseTransaction> {
  return {
    insertAttachmentMetadata,
    readAttachmentMetadataByBlobId: readByBlobId,
    readAttachmentMetadataById: readById,
  };
}
