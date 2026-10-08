import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { appendReportSourceInvalidation } from '../outbox/report-source-invalidation-producer.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';

/** Emit the typed report fence for a conflict-resolution commit. */
export async function appendConflictReportSourceInvalidation(
  port: ReportSourceInvalidationOutboxPort | undefined,
  transaction: DatabaseTransaction,
  input: {
    readonly operationId: string;
    readonly collectionId: string;
    readonly commitOrdinal: bigint;
    readonly contentRevision: string;
    readonly policyRevision: string;
  },
): Promise<void> {
  await appendReportSourceInvalidation(port, transaction, {
    domainEventId: `sync:conflict-dismissed:${input.operationId}`,
    collectionId: input.collectionId,
    eventType: 'sync.conflict.dismissed',
    eventVersion: 1,
    commitOrdinal: input.commitOrdinal,
    payload: {
      contentRevision: input.contentRevision,
      policyRevision: input.policyRevision,
    },
    aggregateRevision: input.contentRevision,
  });
}
