import { sql, type Kysely } from 'kysely';
import { assertCanonicalCommandId, canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { CaptureError, eligibleCapturePrior, APPROVED_CAPTURE_PRIOR_EVALUATION,
  type CaptureActor, type CaptureLearningView } from '../../modules/collections/index.js';
import type { ClassificationDeploymentIdentity } from './classification-provider-factory.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
export function createCaptureLearning(db: Kysely<DatabaseSchema>, priorEnabled: boolean, identity: ClassificationDeploymentIdentity | null = null) {
  async function get(actor: CaptureActor): Promise<CaptureLearningView> {
    return createUnitOfWork(db, { isolationLevel: 'repeatable read' }).execute(async ({ transaction: tx }) => {
    const control = await tx.selectFrom('bookmark_capture_learning').selectAll().where('account_id', '=', actor.principalId).executeTakeFirst();
    const preference = await tx.selectFrom('bookmark_preferences').select('learn_from_corrections').where('account_id', '=', actor.principalId).executeTakeFirst();
    if (preference?.learn_from_corrections === false) return { generation: control?.generation ?? 0, clearedAt: control?.cleared_at?.toISOString() ?? null,
      enabled: false, priorAvailable: false, records: [] };
    const rows = await tx.selectFrom('bookmark_capture_feedback as e').innerJoin('bookmark_capture_decisions as d', 'd.id', 'e.decision_id')
      .innerJoin('collections as c', 'c.id', 'd.collection_id').leftJoin('nodes as f', join => join.on(sql<boolean>`f.id=coalesce(d.current_result_json->>'parentId',d.result_json->>'parentId')`).onRef('f.collection_id', '=', 'd.collection_id'))
      .select(['d.original_hostname', 'd.result_json', 'd.current_result_json', 'e.kind', 'e.received_at', 'f.deleted_at', 'f.id as folder_id'])
      .where('e.account_id', '=', actor.principalId).where('c.owner_subject_id', '=', actor.subjectId).where('c.deleted_at', 'is', null)
      .whereRef('e.event_id', '=', 'd.effective_event_id').where('e.learning_eligible', '=', true).where('e.evidence_generation', '=', control?.generation ?? 0)
      .where('e.received_at', '>', new Date(Date.now() - 180 * 86400000)).orderBy('e.received_at', 'desc').limit(50).execute();
    return { generation: control?.generation ?? 0, clearedAt: control?.cleared_at?.toISOString() ?? null,
      enabled: true, priorAvailable: priorEnabled && identity !== null && eligibleCapturePrior(APPROVED_CAPTURE_PRIOR_EVALUATION, identity),
      records: rows.map(row => ({ hostname: row.original_hostname ?? 'Unknown source', kind: row.kind,
        beforePath: row.result_json?.path ?? [], afterPath: row.current_result_json?.path ?? row.result_json?.path ?? [],
        receivedAt: row.received_at.toISOString(), available: Boolean(row.folder_id) && row.deleted_at === null })) };
    });
  }
  async function clear(actor: CaptureActor, commandId: string, expectedGeneration: number) {
    assertCanonicalCommandId(commandId);
    return createUnitOfWork(db).execute(async ({ transaction: tx }) => {
      const receipts = createPostgresProductCommandReceiptPort(tx), binding = { principalId: actor.principalId, commandScope: 'capture:clear-memory:v1', commandId };
      const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: '/api/v1/me/capture-learning/clear', mediaType: 'application/json', body: {}, conditions: { ifMatch: String(expectedGeneration) } });
      const claim = await receipts.claim(binding, fingerprint);
      if (claim.kind === 'replay') return JSON.parse(Buffer.from(claim.result.body).toString()) as { generation: number; clearedAt: string };
      if (claim.kind !== 'claimed') throw new CaptureError('command_id_reused');
      await tx.selectFrom('bookmark_preferences').select('revision').where('account_id', '=', actor.principalId).forUpdate().execute();
      await tx.insertInto('bookmark_capture_learning').values({ account_id: actor.principalId, generation: 0, cleared_at: null }).onConflict(c => c.column('account_id').doNothing()).execute();
      const prior = await tx.selectFrom('bookmark_capture_learning').selectAll().where('account_id', '=', actor.principalId).forUpdate().executeTakeFirstOrThrow();
      if (prior.generation !== expectedGeneration) throw new CaptureError('precondition_failed');
      // Keep only erasure identities for legacy command replay; remove its memory payload.
      await sql`INSERT INTO classification_evidence_erasure(owner_subject_id,source,command_id,node_id)
        SELECT owner_subject_id,source,command_id,node_id FROM collection_classification_evidence WHERE owner_subject_id=${actor.subjectId}
        ON CONFLICT DO NOTHING`.execute(tx);
      await tx.deleteFrom('collection_classification_evidence').where('owner_subject_id', '=', actor.subjectId).execute();
      const next = await tx.updateTable('bookmark_capture_learning').set({ generation: prior.generation + 1, cleared_at: sql<Date>`clock_timestamp()` })
        .where('account_id', '=', actor.principalId).returningAll().executeTakeFirstOrThrow();
      const result = { generation: next.generation, clearedAt: next.cleared_at!.toISOString() };
      await receipts.complete(binding, fingerprint, { status: 200, contractVersion: '1.0.0', mediaType: 'application/json',
        body: Buffer.from(JSON.stringify(result)), stableHeaders: { etag: `"capture-learning-${result.generation}"`, 'cache-control': 'private, no-store', 'content-type': 'application/json' } });
      return result;
    });
  }
  return { get, clear };
}
