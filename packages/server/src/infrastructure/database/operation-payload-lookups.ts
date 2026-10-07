import { sql } from 'kysely';
import type { DatabaseTransaction } from './unit-of-work.js';

export type AttachmentOperationType = 'attachment.finalized' | 'attachment.retired';

export interface AttachmentOperationPayloadFacts {
  readonly operation_id: string;
  readonly collection_id: string;
  /** PostgreSQL int8 is text under the default pg parser. */
  readonly commit_ordinal: bigint | string;
  readonly attachment_id: string;
  readonly blob_id: string;
}

export async function findLatestAttachmentOperationByCommandId(
  transaction: DatabaseTransaction,
  operationType: AttachmentOperationType,
  commandId: string,
): Promise<AttachmentOperationPayloadFacts | null> {
  const result = await sql<AttachmentOperationPayloadFacts>`
    SELECT operation.operation_id, operation.collection_id, operation.commit_ordinal,
      fact.attachment_id, fact.blob_id
    FROM operations operation JOIN operation_lookup_facts fact
      ON fact.operation_id=operation.operation_id
    WHERE fact.operation_type=${operationType}
      AND fact.command_id=${commandId}
    ORDER BY operation.commit_ordinal DESC LIMIT 1`.execute(transaction);
  return result.rows[0] ?? null;
}

export async function findLatestAttachmentOperationByAttachmentId(
  transaction: DatabaseTransaction,
  operationType: AttachmentOperationType,
  collectionId: string,
  attachmentId: string,
): Promise<AttachmentOperationPayloadFacts | null> {
  const result = await sql<AttachmentOperationPayloadFacts>`
    SELECT operation.operation_id, operation.collection_id, operation.commit_ordinal,
      fact.attachment_id, fact.blob_id
    FROM operations operation JOIN operation_lookup_facts fact
      ON fact.operation_id=operation.operation_id
    WHERE fact.operation_type=${operationType} AND fact.collection_id=${collectionId}
      AND fact.attachment_id=${attachmentId}
    ORDER BY operation.commit_ordinal DESC LIMIT 1`.execute(transaction);
  return result.rows[0] ?? null;
}
