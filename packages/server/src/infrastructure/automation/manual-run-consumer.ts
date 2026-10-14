import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { OutboxHandlerContext } from '../outbox/router.js';
import { AUTOMATION_MANUAL_HANDLER } from '../outbox/automation-manual.js';
import { executeManualChunk, stopManualPending, type ManualPendingRun } from './manual-run-chunks.js';

/** A durable continuation, fenced by the original Outbox lease. Each call owns
 * one short transaction; completed children make redelivery/crash recovery safe.
 */
export function createManualRunConsumer(db: Kysely<DatabaseSchema>, serverUuid: string,
  options: { runtimeEnabled?: boolean; workerEnabled?: boolean } = {}) {
  return async (context: OutboxHandlerContext): Promise<boolean> => db.transaction().execute(async tx => {
    const { ownerId, collectionId, runId } = context.envelope.payload;
    if (!context.attempt || context.signal.aborted || typeof ownerId !== 'string'
      || typeof collectionId !== 'string' || typeof runId !== 'string') throw new Error('Manual continuation lease required');
    if (options.runtimeEnabled === false) { await fence(tx, context, 5000); return true; }
    const owner = await tx.selectFrom('accounts').select(['id','subject_id','status','deleted_at'])
      .where('id', '=', ownerId).forUpdate().executeTakeFirst();
    const parent = (await sql<ManualPendingRun>`SELECT r.id,r.state,r.held,r.explanation_json->>'collectionId' AS collection_id,
      coalesce((r.explanation_json->>'manualTasks')::boolean,false) AS run_tasks,v.definition_json,b.values_json
      FROM automation_runs r JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
      JOIN automation_binding_revisions b ON b.binding_set_id=r.binding_set_id AND b.revision=r.binding_revision
      WHERE r.id=${runId} AND r.owner_id=${ownerId} AND r.kind='manual'
        AND r.explanation_json->>'manualSelection'='true' AND r.explanation_json->>'manualPending'='true'
      FOR UPDATE OF r`.execute(tx)).rows[0];
    let more = false, pauseMs = 250;
    if (parent && parent.state !== 'cancelled') {
      if (parent.collection_id !== collectionId) throw new Error('Manual continuation collection mismatch');
      if (!owner || owner.status !== 'active' || owner.deleted_at) {
        await stopManualPending(tx, parent.id, 'Owner is unavailable; completed effects were retained.');
      } else {
        const settings = await tx.selectFrom('automation_settings').select('paused').where('owner_id', '=', ownerId).executeTakeFirst();
        if (parent.held || settings?.paused || (parent.run_tasks && options.workerEnabled === false)) {
          more = true; pauseMs = 5000;
        } else {
          more = await executeManualChunk(tx, { accountId: owner.id, subjectId: owner.subject_id }, serverUuid, parent);
        }
      }
    }
    await fence(tx, context, more ? pauseMs : undefined);
    return more;
  });
}

async function fence(tx: DatabaseTransaction, context: OutboxHandlerContext, delayMs?: number) {
  const row = await tx.selectFrom('outbox_events').select('outbox_id').where('outbox_id', '=', context.attempt!.outboxId)
    .where('domain_event_id', '=', context.envelope.event_id).where('handler_name', '=', AUTOMATION_MANUAL_HANDLER)
    .where('state', '=', 'leased').where('lease_generation', '=', BigInt(context.attempt!.leaseGeneration))
    .where('locked_until', '>', sql<Date>`clock_timestamp()`)
    .where('payload_json', '=', context.envelope.payload as Record<string, unknown>).forUpdate().executeTakeFirst();
  if (!row || context.signal.aborted) throw new Error('Manual continuation lease lost');
  if (delayMs !== undefined) await tx.updateTable('outbox_events').set({
    available_at: sql<Date>`clock_timestamp()+${delayMs}*interval '1 millisecond'`,
  }).where('outbox_id', '=', row.outbox_id).execute();
}
