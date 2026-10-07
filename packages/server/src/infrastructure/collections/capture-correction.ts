import { sql, type Kysely } from 'kysely';
import { canonicalCommandFingerprint, assertCanonicalCommandId } from '../../modules/commands/index.js';
import { assertValidNodeTags, CaptureError, type CaptureRuntime } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { createClassificationCanonicalPorts } from './classification-canonical-ports.js';
import { mutateCaptureContent } from './capture-undo.js';
import { captureDecisionView, captureResultLocation } from './capture-view.js';
import { appendCaptureFeedback } from './capture-feedback.js';
import { databaseNow } from '../database/time.js';

export function captureCorrection(db: Kysely<DatabaseSchema>, options: Parameters<typeof createClassificationCanonicalPorts>[1]): CaptureRuntime['correct'] {
  return async (actor, collectionId, decisionId, commandId, ifMatch, selection) => {
    assertCanonicalCommandId(commandId); const tags = assertValidNodeTags(selection.tags);
    const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: `/capture/${decisionId}/correct`,
      mediaType: 'application/json', body: { ...selection, tags }, conditions: { ifMatch } });
    return createUnitOfWork(db).execute(async ({ transaction: tx }) => {
      const ports = createClassificationCanonicalPorts(tx, options);
      const collection = await ports.collections.lockForUpdate(collectionId);
      if (!collection || collection.deletedAt || collection.ownerSubjectId !== actor.subjectId) throw new CaptureError('resource_not_found');
      const row = await tx.selectFrom('bookmark_capture_decisions').selectAll().where('id', '=', decisionId)
        .where('account_id', '=', actor.principalId).where('collection_id', '=', collectionId).forUpdate().executeTakeFirst();
      if (!row) throw new CaptureError('resource_not_found');
      const prior = await tx.selectFrom('bookmark_capture_edits').selectAll().where('account_id', '=', actor.principalId).where('command_id', '=', commandId).executeTakeFirst();
      if (prior) { if (prior.fingerprint !== fingerprint) throw new CaptureError('command_id_reused'); return prior.result_json; }
      const before = await ports.nodes.getNode(collectionId, row.node_id);
      const result = await captureResultLocation(ports, collectionId, collection.title, await mutateCaptureContent(ports, { collectionId, nodeId: row.node_id, parentId: selection.parentId, tags,
        principalId: actor.principalId, ifMatch }));
      const next = await tx.updateTable('bookmark_capture_decisions').set({ current_result_json: result,
        reason: result.operationIds.length ? 'classification_corrected' : row.reason, revision: row.revision + 1 })
        .where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
      if (result.operationIds.length && row.result_json && before?.parentId) {
        await appendCaptureFeedback(tx, row, row.feedback_revision, { eventId: commandId, kind: 'correction_applied',
          nodeRevision: row.result_json.etag, occurredAt: (await databaseNow(tx)).toISOString(),
          learningEligible: selection.learningEligible === true, evidenceGeneration: selection.evidenceGeneration ?? -1 },
        { beforeParentId: before.parentId, afterParentId: result.parentId, beforeTags: before.tags ?? [], afterTags: result.tags });
      }
      const view = captureDecisionView(await tx.selectFrom('bookmark_capture_decisions').selectAll().where('id', '=', next.id).executeTakeFirstOrThrow());
      await tx.insertInto('bookmark_capture_edits').values({ account_id: actor.principalId, decision_id: row.id, command_id: commandId,
        fingerprint, result_json: view, created_at: sql<Date>`clock_timestamp()` }).execute();
      return view;
    });
  };
}
