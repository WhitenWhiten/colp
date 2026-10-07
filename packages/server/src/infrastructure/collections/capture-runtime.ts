import { captureDecisionView, captureResultLocation, captureSuggestionPath } from './capture-view.js';
import { lockCaptureIdentity } from './capture-identity.js';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { assertCanonicalCommandId, canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { applyClassificationContent } from '../../modules/collections/index.js';
import { CAPTURE_POLICY_VERSION, CaptureError, type CaptureActor, type CaptureDecisionInput, type CaptureTagMode,
  type CapturePreview, type CaptureRuntime } from '../../modules/collections/index.js';
import { APPROVED_CAPTURE_FOLDER_CALIBRATION, captureFolderGate, type CaptureFolderCalibration } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { createClassificationCanonicalPorts } from './classification-canonical-ports.js';
import { createClassificationVocabularyPort } from './classification-confirmation-postgres.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { mutateCaptureContent } from './capture-undo.js';
import { APPROVED_CLASSIFICATION_AUTO_CALIBRATION, eligibleAutoCalibration, selectClassificationAutoTags,
  CLASSIFICATION_POLICY } from '../../modules/collections/index.js';
import type { ClassificationDeploymentIdentity } from './classification-provider-factory.js';
import { captureCorrection } from './capture-correction.js';
import { captureFeedback } from './capture-feedback.js';
import { chooseCaptureTie, type CaptureModelFolder } from './capture-tie.js';
import { normalizeClassificationHostname, type CapturePriorEvaluation } from '../../modules/collections/index.js';


export function createCaptureRuntime(db: Kysely<DatabaseSchema>, preview: CapturePreview, options: {
  readonly enabled: boolean;
  /** Tag suggestions at all; the saving browser's tag mode decides whether a capture asks for them. */
  readonly tagsEnabled?: boolean;
  /** The calibrated automatic-tag policy that older clients (no tag mode) still get. */
  readonly autoTagsEnabled?: boolean;
  readonly priorEnabled?: boolean;
  readonly priorEvaluation?: CapturePriorEvaluation | null;
  readonly onPriorError?: () => void;
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  /** Internal evaluation seam; production always uses the frozen approval artifact. */
  readonly calibration?: CaptureFolderCalibration | null;
  /** Calibration binding; null when the deployment runs an unpinned (alias) model. */
  readonly identity?: ClassificationDeploymentIdentity | null;
}): CaptureRuntime {
  const calibration = options.calibration === undefined ? APPROVED_CAPTURE_FOLDER_CALIBRATION : options.calibration;
  const identity = options.identity ?? null;
  // Automatic means automatic: when the feature is on, the classifier's folder decision is applied
  // without a human confirmation (the user can still change it afterwards). An approved calibration
  // for the deployed model only raises the bar; its absence no longer blocks automatic filing.
  const available = () => options.enabled;
  const calibrated = () => identity !== null && captureFolderGate(calibration, identity);
  const tagsAvailable = () => options.tagsEnabled === true && options.autoTagsEnabled === true && identity !== null && eligibleAutoCalibration(APPROVED_CLASSIFICATION_AUTO_CALIBRATION,
    { ...identity, policyVersion: CLASSIFICATION_POLICY.version,
      promptVersion: CLASSIFICATION_POLICY.promptVersion, candidateVersion: CLASSIFICATION_POLICY.candidateVersion });
  /** What this capture does with tags: the browser's choice, or the calibrated policy for clients that do not say. */
  const tagMode = (input: CaptureDecisionInput): CaptureTagMode => options.tagsEnabled !== true ? 'off'
    : input.tagMode ?? (tagsAvailable() ? 'add' : 'off');
  const unit = createUnitOfWork(db);
  async function owned(actor: CaptureActor, collectionId: string, id: string) {
    return db.selectFrom('bookmark_capture_decisions as d').innerJoin('collections as c', 'c.id', 'd.collection_id')
      .selectAll('d').where('d.id', '=', id).where('d.account_id', '=', actor.principalId)
      .where('c.owner_subject_id', '=', actor.subjectId).where('c.id', '=', collectionId).where('c.deleted_at', 'is', null).executeTakeFirst();
  }
  async function admit(actor: CaptureActor, collectionId: string, commandId: string, input: CaptureDecisionInput) {
    const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: `/api/v1/collections/${collectionId}/capture-decisions`,
      mediaType: 'application/json', body: input });
    return unit.execute(async ({ transaction: tx }) => {
      await lockCaptureIdentity(tx, actor.principalId, input.captureId);
      const ports = createClassificationCanonicalPorts(tx, options);
      const collection = await ports.collections.lockForUpdate(collectionId);
      if (!collection || collection.deletedAt || collection.ownerSubjectId !== actor.subjectId) throw new CaptureError('resource_not_found');
      const prior = await tx.selectFrom('bookmark_capture_decisions').selectAll().where('account_id', '=', actor.principalId)
        .where(eb => eb.or([eb('capture_id', '=', input.captureId), eb('command_id', '=', commandId)])).executeTakeFirst();
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.command_id !== commandId) throw new CaptureError('command_id_reused');
        return prior;
      }
      const node = await ports.nodes.getNode(collectionId, input.nodeId);
      if (!node || node.deletedAt || node.kind !== 'bookmark' || !node.parentId) throw new CaptureError('resource_not_found');
      if (`"${node.resourceRevision}"` !== input.nodeEtag) throw new CaptureError('precondition_failed');
      const report = await tx.selectFrom('bookmark_capture_tasks').selectAll().where('account_id', '=', actor.principalId).where('capture_id', '=', input.captureId).executeTakeFirst();
      if (report && (report.collection_id !== collectionId || report.report_json.nodeId && report.report_json.nodeId !== input.nodeId
        || report.report_json.url && report.report_json.url !== node.url)) throw new CaptureError('command_id_reused');
      const preferences = await tx.selectFrom('bookmark_preferences').select('capture_mode').where('account_id', '=', actor.principalId).forUpdate().executeTakeFirst();
      const existingAuto = await tx.selectFrom('collection_classification_tag_jobs').select('id')
        .where('collection_id', '=', collectionId).where('node_id', '=', input.nodeId).executeTakeFirst();
      // Serializing on account preferences makes this cap shared across devices and collections.
      const reserved = await sql<{ points: string }>`SELECT coalesce(sum((input_json->'billing'->>'maxPoints')::bigint), 0)::text AS points
        FROM bookmark_capture_decisions WHERE account_id=${actor.principalId} AND (status <> 'manual' OR execution_id IS NOT NULL)
          AND created_at > clock_timestamp() - interval '24 hours'`.execute(tx);
      const reason = preferences?.capture_mode !== 'automatic' ? 'automatic_mode_disabled'
        : existingAuto ? 'existing_auto_tag_execution' : !available() ? 'capture_policy_unavailable' : null;
      const cappedReason = reason ?? (BigInt(reserved.rows[0]?.points ?? '0') + BigInt(input.billing.maxPoints) > BigInt(input.periodPoints)
        ? 'period_credit_limit' : null);
      return tx.insertInto('bookmark_capture_decisions').values({ id: randomUUID(), account_id: actor.principalId,
        owner_subject_id: actor.subjectId, capture_id: input.captureId, collection_id: collectionId, node_id: input.nodeId,
        command_id: commandId, fingerprint, input_json: input, original_parent_id: node.parentId, original_url: node.url,
        original_hostname: normalizeClassificationHostname(node.url ?? ''),
        original_tags: sql<readonly string[]>`${JSON.stringify(node.tags ?? [])}::jsonb`, execution_command_id: randomUUID(), execution_id: null, apply_command_id: null,
        status: cappedReason ? 'manual' : 'waiting', reason: cappedReason, revision: 0, suggestion_json: null, result_json: null,
        feedback_revision: 0, effective_feedback: null, effective_event_id: null,
        created_at: sql<Date>`clock_timestamp()`, applied_at: null, current_result_json: null, undo_command_id: null, undo_result_json: null, undone_at: null }).returningAll().executeTakeFirstOrThrow();
    });
  }
  async function settle(row: import('./capture-records.js').CaptureDecisionTable, receipt: { body: Uint8Array; status: number }) {
        const result = JSON.parse(Buffer.from(receipt.body).toString('utf8')) as {
          folder?: CaptureModelFolder;
          tags?: { candidates: { tag: string; noul: number; selected?: boolean }[]; maxAutoTags: number };
          error?: { code: string };
        };
        const folder = result.folder;
        const accepted = available() && receipt.status === 200 && folder?.folderId && folder.decision !== 'later'
          && (!calibrated() || Number.isFinite(folder.confidence) && folder.confidence >= calibration!.threshold);
        const chosen = accepted ? await chooseCaptureTie(db, row, folder!, { enabled: options.priorEnabled, evaluation: options.priorEvaluation, onError: options.onPriorError, identity }) : null;
        const path = accepted ? await captureSuggestionPath(db, row.collection_id, chosen?.folderId ?? folder!.folderId!) : [];
        // The classifier's selected tags (above the suggestion bar, within maxAutoTags). An approved
        // calibration raises the bar for adding them, as it does for the folder.
        const mode = tagMode(row.input_json), candidates = result.tags?.candidates ?? [];
        const picked = mode === 'off' || !result.tags ? [] : tagsAvailable() ? selectClassificationAutoTags(candidates, {
          threshold: APPROVED_CLASSIFICATION_AUTO_CALIBRATION!.threshold, maxAdded: result.tags.maxAutoTags,
          existingTags: row.original_tags, vocabulary: candidates.map(candidate => candidate.tag),
        }) : candidates.filter(candidate => candidate.selected === true && !row.original_tags.includes(candidate.tag)).map(candidate => candidate.tag);
        const addTags = mode === 'add' ? picked : [], suggestedTags = mode === 'suggest' ? picked : [];
        const evidence = await db.selectFrom('classification_provider_executions').select('id')
          .where('principal_id', '=', row.account_id).where('command_id', '=', row.execution_command_id).executeTakeFirst();
        await db.updateTable('bookmark_capture_decisions').set({ status: accepted ? 'suggested' : 'manual',
          reason: accepted ? null : result.error?.code ?? 'low_confidence', execution_id: evidence?.id ?? null,
          suggestion_json: accepted ? { path, folderId: chosen?.folderId ?? folder!.folderId!, addTags, ...suggestedTags.length ? { suggestedTags } : {}, ...(chosen?.explanation ? { explanation: chosen.explanation, evidenceGeneration: chosen.evidenceGeneration } : {}) } : null,
          revision: sql<number>`revision + 1` }).where('id', '=', row.id).where('status', 'in', ['waiting', 'running']).execute();
  }
  async function viewStored(row: import('./capture-records.js').CaptureDecisionTable | null | undefined) {
    if (!row) return null;
    if (['waiting', 'running'].includes(row.status)) {
      const receipt = await db.selectFrom('product_command_receipts').select(['result_status', 'result_bytes'])
        .where('principal_id', '=', row.account_id).where('command_scope', '=', 'collections:classification-preview:v1')
        .where('command_id', '=', row.execution_command_id).where('completed_at', 'is not', null).executeTakeFirst();
      if (receipt?.result_bytes && receipt.result_status) {
        await settle(row, { body: receipt.result_bytes, status: receipt.result_status });
        row = (await owned({ principalId: row.account_id, subjectId: row.owner_subject_id }, row.collection_id, row.id))!;
      }
    }
    if (!row) return null;
    const execution = row.execution_id ? await db.selectFrom('classification_provider_executions').select('credit_charge_id')
      .where('id', '=', row.execution_id).where('principal_id', '=', row.account_id).executeTakeFirst() : null;
    return { ...captureDecisionView(row), creditChargeId: execution?.credit_charge_id ?? null };
  }
  return {
    correct: captureCorrection(db, options),
    feedback: captureFeedback(db),
    async undo(actor, collectionId, decisionId, commandId, ifMatch) {
      assertCanonicalCommandId(commandId);
      return unit.execute(async ({ transaction: tx }) => {
        const ports = createClassificationCanonicalPorts(tx, options);
        const collection = await ports.collections.lockForUpdate(collectionId);
        if (!collection || collection.deletedAt || collection.ownerSubjectId !== actor.subjectId) throw new CaptureError('resource_not_found');
        const row = await tx.selectFrom('bookmark_capture_decisions').selectAll().where('id', '=', decisionId)
          .where('account_id', '=', actor.principalId).where('collection_id', '=', collectionId).forUpdate().executeTakeFirst();
        if (!row || row.status !== 'applied') throw new CaptureError('resource_not_found');
        if (row.undo_result_json) {
          if (row.undo_command_id !== commandId || row.result_json?.etag !== ifMatch) throw new CaptureError('command_id_reused');
          return captureDecisionView(row);
        }
        if (row.result_json?.etag !== ifMatch) throw new CaptureError('precondition_failed');
        const result = await captureResultLocation(ports, collectionId, collection.title, await mutateCaptureContent(ports, { collectionId, nodeId: row.node_id, parentId: row.original_parent_id,
          tags: row.original_tags, principalId: actor.principalId, ifMatch }));
        return captureDecisionView(await tx.updateTable('bookmark_capture_decisions').set({ undo_command_id: commandId,
          undo_result_json: result, undone_at: sql<Date>`clock_timestamp()`, reason: 'classification_undone', revision: row.revision + 1 })
          .where('id', '=', row.id).returningAll().executeTakeFirstOrThrow());
      });
    },
    capabilities: () => ({ policyVersion: CAPTURE_POLICY_VERSION, automaticFolderAvailable: available(), automaticTagsAvailable: tagsAvailable() }),
    async get(actor, collectionId, decisionId) {
      return viewStored(await owned(actor, collectionId, decisionId));
    },
    async find(actor, collectionId, captureId) {
      const row = await db.selectFrom('bookmark_capture_decisions').select('id').where('account_id', '=', actor.principalId)
        .where('collection_id', '=', collectionId).where('capture_id', '=', captureId).executeTakeFirst();
      return row ? viewStored(await owned(actor, collectionId, row.id)) : null;
    },
    async classify(actor, collectionId, commandId, input, requestId) {
      assertCanonicalCommandId(commandId);
      let row = await admit(actor, collectionId, commandId, input);
      if (row.status !== 'waiting' && row.status !== 'running') return captureDecisionView(row);
      if (!available()) throw new CaptureError('capture_policy_unavailable');
      await db.updateTable('bookmark_capture_decisions').set({ status: 'running' }).where('id', '=', row.id)
        .where('status', '=', 'waiting').execute();
      const execution = await preview.preview({ actor, collectionId, commandId: row.execution_command_id, requestId,
        document: { source: 'extension', nodeId: input.nodeId, requested: { folder: true, tags: tagMode(input) !== 'off' }, billing: input.billing } });
      if (execution.kind === 'replay') await settle(row, execution.result);
      row = (await owned(actor, collectionId, row.id))!;
      if (!row) throw new CaptureError('resource_not_found');
      return captureDecisionView(row);
    },
    async apply(actor, collectionId, decisionId, commandId, ifMatch, controlGeneration, userInitiated = false) {
      return unit.execute(async ({ transaction: tx }) => {
        const ports = createClassificationCanonicalPorts(tx, options);
        const collection = await ports.collections.lockForUpdate(collectionId);
        if (!collection || collection.deletedAt || collection.ownerSubjectId !== actor.subjectId) throw new CaptureError('resource_not_found');
        const row = await tx.selectFrom('bookmark_capture_decisions').selectAll().where('id', '=', decisionId)
          .where('account_id', '=', actor.principalId).where('collection_id', '=', collectionId).forUpdate().executeTakeFirst();
        if (!row) throw new CaptureError('resource_not_found');
        if (row.input_json.nodeEtag !== ifMatch || row.input_json.controlGeneration !== controlGeneration) throw new CaptureError('precondition_failed');
        if (row.status === 'applied') {
          if (row.apply_command_id !== commandId || Boolean(row.suggestion_json?.appliedExplicitly) !== userInitiated) throw new CaptureError('command_id_reused');
          return captureDecisionView(row);
        }
        if (row.status !== 'suggested' || !row.suggestion_json || !available()) throw new CaptureError('capture_policy_unavailable');
        const preferences = await tx.selectFrom('bookmark_preferences').select(['capture_mode', 'learn_from_corrections']).where('account_id', '=', actor.principalId).forUpdate().executeTakeFirst();
        if (!userInitiated && preferences?.capture_mode !== 'automatic') throw new CaptureError('precondition_failed');
        if (row.suggestion_json.explanation) {
          const control = await tx.selectFrom('bookmark_capture_learning').select('generation').where('account_id', '=', actor.principalId).executeTakeFirst();
          if (preferences?.learn_from_corrections === false || (control?.generation ?? 0) !== row.suggestion_json.evidenceGeneration) throw new CaptureError('precondition_failed');
        }
        const result = await captureResultLocation(ports, collectionId, collection.title, await applyClassificationContent({ ...ports, vocabulary: createClassificationVocabularyPort(tx) }, {
          actor: { principalId: actor.principalId, principalType: 'account' }, collectionId, nodeId: row.node_id,
          ifMatch: row.input_json.nodeEtag, selection: row.suggestion_json,
        }));
        const applied = await tx.updateTable('bookmark_capture_decisions').set({ status: 'applied', reason: userInitiated ? 'suggestion_applied_explicitly' : null, suggestion_json: { ...row.suggestion_json, appliedExplicitly: userInitiated }, result_json: result, apply_command_id: commandId,
          revision: row.revision + 1, applied_at: sql<Date>`clock_timestamp()` }).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
        return captureDecisionView(applied);
      });
    },
  };
}
