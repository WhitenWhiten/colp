import { sql, type Kysely } from 'kysely';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { CaptureError, projectCaptureRating, type CaptureRuntime, type CaptureFeedbackInput,
  type CaptureFeedbackKind, type CaptureFeedbackReceipt } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import type { CaptureDecisionTable, CaptureFeedbackTable } from './capture-records.js';
import { createClassificationCanonicalPorts } from './classification-canonical-ports.js';

export function captureFeedback(db: Kysely<DatabaseSchema>): CaptureRuntime['feedback'] {
  return (actor, collectionId, decisionId, expectedRevision, event) => createUnitOfWork(db).execute(async ({ transaction: tx }) => {
    const ports = createClassificationCanonicalPorts(tx);
    const collection = await ports.collections.lockForUpdate(collectionId);
    if (!collection || collection.deletedAt || collection.ownerSubjectId !== actor.subjectId) throw new CaptureError('resource_not_found');
    const row = await tx.selectFrom('bookmark_capture_decisions').selectAll().where('id', '=', decisionId)
      .where('account_id', '=', actor.principalId).where('collection_id', '=', collectionId).forUpdate().executeTakeFirst();
    if (!row?.result_json || row.result_json.etag !== event.nodeRevision) throw new CaptureError('resource_not_found');
    return appendCaptureFeedback(tx, row, expectedRevision, event);
  });
}

export async function appendCaptureFeedback(tx: DatabaseTransaction, row: CaptureDecisionTable, expectedRevision: number,
  input: Omit<CaptureFeedbackInput, 'kind'> & { readonly kind: CaptureFeedbackKind }, correction: CaptureFeedbackTable['correction_json'] = null): Promise<CaptureFeedbackReceipt> {
  const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: `/capture/${row.id}/feedback`, mediaType: 'application/json',
    body: { ...input, correction }, conditions: { ifMatch: String(expectedRevision) } });
  const prior = await tx.selectFrom('bookmark_capture_feedback').selectAll().where('account_id', '=', row.account_id)
    .where('event_id', '=', input.eventId).executeTakeFirst();
  if (prior) { if (prior.fingerprint !== fingerprint) throw new CaptureError('command_id_reused'); return prior.receipt_json; }
  const effective = projectCaptureRating(row.effective_feedback, input.kind, expectedRevision, row.feedback_revision);
  const preference = await tx.selectFrom('bookmark_preferences').select('learn_from_corrections').where('account_id', '=', row.account_id).forUpdate().executeTakeFirst();
  await tx.insertInto('bookmark_capture_learning').values({ account_id: row.account_id, generation: 0, cleared_at: null })
    .onConflict(c => c.column('account_id').doNothing()).execute();
  const learning = await tx.selectFrom('bookmark_capture_learning').selectAll().where('account_id', '=', row.account_id).forUpdate().executeTakeFirstOrThrow();
  const eligible = input.learningEligible && preference?.learn_from_corrections !== false
    && input.evidenceGeneration === learning.generation && ['explicit_positive', 'correction_applied'].includes(input.kind);
  const revision = row.feedback_revision + 1;
  const receipt: CaptureFeedbackReceipt = { eventId: input.eventId, revision, effectiveFeedback: effective, learningEligible: eligible };
  await tx.insertInto('bookmark_capture_feedback').values({ account_id: row.account_id, event_id: input.eventId,
    decision_id: row.id, capture_id: row.capture_id, node_revision: input.nodeRevision, kind: input.kind, revision,
    fingerprint, occurred_at: new Date(input.occurredAt), received_at: sql<Date>`clock_timestamp()`, learning_eligible: eligible,
    evidence_generation: learning.generation, correction_json: correction, receipt_json: receipt }).execute();
  const changed = effective !== row.effective_feedback || input.kind === 'correction_applied'
    || (input.kind === 'explicit_positive' && expectedRevision === row.feedback_revision);
  await tx.updateTable('bookmark_capture_decisions').set({ feedback_revision: revision, effective_feedback: effective,
    effective_event_id: effective === null ? null : changed ? input.eventId : row.effective_event_id }).where('id', '=', row.id).execute();
  return receipt;
}
