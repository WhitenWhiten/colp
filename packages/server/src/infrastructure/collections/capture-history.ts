import { sql, type Kysely } from 'kysely';
import { canonicalCommandFingerprint, assertCanonicalCommandId } from '../../modules/commands/index.js';
import { CAPTURE_REPORT_IDENTITY_FIELDS, CaptureError, aggregateCaptures, captureNeedsAttention, type CaptureHistoryRuntime, type CaptureHistoryQuery,
  type CaptureActor, type CaptureHistoryItem, type CaptureReport, type CaptureStatisticFact, type CaptureTaskProgress } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { captureDecisionView } from './capture-view.js';
import { captureHistoryRetention } from './capture-retention.js';
import { lockCaptureIdentity } from './capture-identity.js';

/**
 * The mutable half of a report — everything except capture identity, which the
 * table columns own. Persisting the identity fields in `report_json` as well
 * created two authorities: a legacy or hand-edited document could disagree with
 * its row, and the reader had to silently pick a winner.
 */
function taskProgress(report: CaptureReport): CaptureTaskProgress {
  const progress: Record<string, unknown> = { ...report };
  for (const field of CAPTURE_REPORT_IDENTITY_FIELDS) delete progress[field];
  return progress as unknown as CaptureTaskProgress;
}

/**
 * The ONE identity authority: columns first, with any legacy identity keys
 * lingering inside `report_json` dropped before they can be surfaced.
 */
function taskReport(row: {
  capture_id: string; collection_id: string; device_id: string; revision: number; started_at: Date;
  report_json: CaptureTaskProgress;
}): CaptureReport {
  const progress: Record<string, unknown> = { ...row.report_json };
  for (const field of CAPTURE_REPORT_IDENTITY_FIELDS) delete progress[field];
  return { ...(progress as unknown as CaptureTaskProgress), captureId: row.capture_id,
    collectionId: row.collection_id, deviceId: row.device_id, revision: row.revision,
    startedAt: row.started_at.toISOString() };
}

export function createCaptureHistory(db: Kysely<DatabaseSchema>, onRetentionError: () => void = () => undefined): CaptureHistoryRuntime {
  const reads = createUnitOfWork(db, { isolationLevel: 'repeatable read' });
  async function page(tx: DatabaseTransaction, actor: CaptureActor, input: CaptureHistoryQuery, limit: number): Promise<CaptureHistoryItem[]> {
    let query = tx.selectFrom('bookmark_capture_tasks as t').innerJoin('collections as c', 'c.id', 't.collection_id')
      .selectAll('t').where('t.account_id', '=', actor.principalId).where('c.owner_subject_id', '=', actor.subjectId)
      .where('c.deleted_at', 'is', null).where('t.started_at', '>=', new Date(input.from)).where('t.started_at', '<', new Date(input.to))
      .where(sql<boolean>`coalesce(t.report_json->>'url','') <> ''`);
    if (input.deviceId) query = query.where('t.device_id', '=', input.deviceId);
    if (input.collectionId) query = query.where('t.collection_id', '=', input.collectionId);
    if (input.source) query = query.where(sql<boolean>`t.report_json->>'source' = ${input.source}`);
    if (input.day) query = query.where(sql<boolean>`to_char(t.started_at AT TIME ZONE ${input.timezone}, 'YYYY-MM-DD') = ${input.day}`);
    if (input.captureId) query = query.where('t.capture_id', '=', input.captureId);
    if (input.q) query = query.where(sql<boolean>`position(lower(${input.q}) in lower((t.report_json->>'title') || ' ' || (t.report_json->>'url'))) > 0`);
    if (input.before) query = query.where(sql<boolean>`(t.started_at, t.capture_id) < (${new Date(input.before[0])}, ${input.before[1]})`);
    const rows = await query.orderBy('t.started_at', 'desc').orderBy('t.capture_id', 'desc').limit(limit).execute();
    const decisions = rows.length ? await tx.selectFrom('bookmark_capture_decisions').selectAll().where('account_id', '=', actor.principalId)
      .where('capture_id', 'in', rows.map(row => row.capture_id)).execute() : [];
    const byCapture = new Map(decisions.map(decision => [decision.capture_id, decision]));
    return rows.map(row => {
      const report = taskReport(row);
      const decision = byCapture.get(row.capture_id);
      return { report, decision: decision ? captureDecisionView(decision) : null, fact: { captureId: row.capture_id,
        revision: row.revision, createdAt: row.started_at.getTime(), disposition: report.disposition, save: report.save,
        automaticIntent: report.automaticIntent, originalApplied: Boolean(decision?.applied_at && !decision.suggestion_json?.appliedExplicitly), feedback: decision?.effective_feedback ?? null,
        sync: report.sync, reason: report.reason, needsAttention: captureNeedsAttention(report.save, report.sync, report.reason) } };
    });
  }
  return {
    ...captureHistoryRetention(db, onRetentionError),
    async report(actor, commandId, report) {
      assertCanonicalCommandId(commandId);
      return createUnitOfWork(db).execute(async ({ transaction: tx }) => {
        await lockCaptureIdentity(tx, actor.principalId, report.captureId);
        const collection = await tx.selectFrom('collections').select('id').where('id', '=', report.collectionId)
          .where('owner_subject_id', '=', actor.subjectId).where('deleted_at', 'is', null).executeTakeFirst();
        if (!collection) throw new CaptureError('resource_not_found');
        const decision = await tx.selectFrom('bookmark_capture_decisions').select(['collection_id', 'node_id', 'original_url'])
          .where('account_id', '=', actor.principalId).where('capture_id', '=', report.captureId).executeTakeFirst();
        if (decision && (decision.collection_id !== report.collectionId || report.nodeId && report.nodeId !== decision.node_id
          || decision.original_url && decision.original_url !== report.url)) throw new CaptureError('command_id_reused');
        if (report.nodeId) {
          const node = await tx.selectFrom('nodes').select('id').where('id', '=', report.nodeId).where('collection_id', '=', report.collectionId).executeTakeFirst();
          if (!node) throw new CaptureError('resource_not_found');
        }
        const receipts = createPostgresProductCommandReceiptPort(tx), binding = { principalId: actor.principalId,
          commandScope: 'capture:report:v1', commandId };
        const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: '/api/v1/me/bookmark-captures', mediaType: 'application/json', body: report });
        const claim = await receipts.claim(binding, fingerprint);
        if (claim.kind === 'replay') return JSON.parse(Buffer.from(claim.result.body).toString()) as { captureId: string; revision: number };
        if (claim.kind !== 'claimed') throw new CaptureError('command_id_reused');
        const prior = await tx.selectFrom('bookmark_capture_tasks').selectAll().where('account_id', '=', actor.principalId)
          .where('capture_id', '=', report.captureId).forUpdate().executeTakeFirst();
        // Identity is immutable per capture. A second report that changes any of
        // it is a conflicting command, not progress: silently coercing deviceId
        // to the stored value hid the conflict and let two authorities disagree.
        if (prior && (prior.collection_id !== report.collectionId || prior.device_id !== report.deviceId
          || prior.started_at.toISOString() !== new Date(report.startedAt).toISOString())) throw new CaptureError('command_id_reused');
        const progress = taskProgress(report);
        const values = { account_id: actor.principalId, capture_id: report.captureId, collection_id: report.collectionId,
          device_id: report.deviceId, revision: report.revision, started_at: new Date(report.startedAt), report_json: progress,
          received_at: sql<Date>`clock_timestamp()` };
        await tx.insertInto('bookmark_capture_tasks').values(values).onConflict(c => c.columns(['account_id', 'capture_id'])
          .doUpdateSet({ revision: report.revision, report_json: progress, received_at: sql<Date>`clock_timestamp()` })
          .where('bookmark_capture_tasks.revision', '<', report.revision)).execute();
        const accepted = await tx.selectFrom('bookmark_capture_tasks').select('revision')
          .where('account_id', '=', actor.principalId).where('capture_id', '=', report.captureId).executeTakeFirstOrThrow();
        const result = { captureId: report.captureId, revision: accepted.revision };
        await receipts.complete(binding, fingerprint, { status: 200, mediaType: 'application/json', contractVersion: '1.0.0',
          body: Buffer.from(JSON.stringify(result)), stableHeaders: { 'cache-control': 'private, no-store', 'content-type': 'application/json' } });
        return result;
      });
    },
    history(actor, query) {
      return reads.execute(async ({ transaction: tx }) => {
        const items = await page(tx, actor, query, 51), last = items[49];
        return { items: items.slice(0, 50), next: items.length > 50 && last ? [last.report.startedAt, last.report.captureId] as const : null,
          updatedAt: new Date().toISOString() };
      });
    },
    aggregate(actor, query) {
      return reads.execute(async ({ transaction: tx }) => {
        await sql`SET LOCAL statement_timeout = '2000ms'`.execute(tx);
        const rows = await sql<CaptureStatisticFact & { reason: string | null }>`SELECT t.capture_id AS "captureId", t.revision,
          (extract(epoch FROM t.started_at) * 1000)::double precision AS "createdAt", t.report_json->>'disposition' AS disposition,
          t.report_json->>'save' AS save, (t.report_json->>'automaticIntent')::boolean AS "automaticIntent",
          d.applied_at IS NOT NULL AND NOT coalesce((d.suggestion_json->>'appliedExplicitly')::boolean,false) AS "originalApplied", d.effective_feedback AS feedback,
          t.report_json->>'sync' AS sync, t.report_json->>'reason' AS reason,
          (extract(epoch FROM ((t.report_json->>'savedAt')::timestamptz-t.started_at))*1000)::double precision AS "saveDurationMs",
          (extract(epoch FROM ((t.report_json->>'classificationAppliedAt')::timestamptz-(t.report_json->>'savedAt')::timestamptz))*1000)::double precision AS "classificationDurationMs"
          FROM bookmark_capture_tasks t JOIN collections c ON c.id=t.collection_id
          LEFT JOIN bookmark_capture_decisions d ON d.account_id=t.account_id AND d.capture_id=t.capture_id AND d.collection_id=t.collection_id
          WHERE t.account_id=${actor.principalId} AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL
            AND t.started_at>=${new Date(query.from)} AND t.started_at<${new Date(query.to)}
            ${query.deviceId ? sql`AND t.device_id=${query.deviceId}` : sql``}
            ${query.collectionId ? sql`AND t.collection_id=${query.collectionId}` : sql``}
            ${query.source ? sql`AND t.report_json->>'source'=${query.source}` : sql``}
            ${query.day ? sql`AND to_char(t.started_at AT TIME ZONE ${query.timezone}, 'YYYY-MM-DD')=${query.day}` : sql``}
            ${query.q ? sql`AND position(lower(${query.q}) in lower((t.report_json->>'title') || ' ' || (t.report_json->>'url'))) > 0` : sql``}
          LIMIT 100001`.execute(tx);
        if (rows.rows.length > 100000) throw new CaptureError('invalid_request');
        return aggregateCaptures(rows.rows.map(row => ({ ...row, needsAttention: captureNeedsAttention(row.save, row.sync, row.reason) })), { ...query, now: Date.now() });
      });
    },
  };
}
