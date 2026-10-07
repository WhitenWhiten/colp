import { sql,type Kysely,type Selectable } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { ClassificationAutoTagJobTable } from '../database/classification-auto-tag-table.js';
import { createUnitOfWork,type DatabaseTransaction,type UnitOfWorkOptions } from '../database/unit-of-work.js';
import { OutboxDeliveryError,type OutboxHandlerContext } from '../outbox/router.js';
import { CLASSIFICATION_AUTO_TAG_EVENT,CLASSIFICATION_AUTO_TAG_HANDLER } from '../outbox/classification-auto-tag.js';
export type ClassificationAutoJob=Selectable<ClassificationAutoTagJobTable>;
export const autoJobTerminal=(job:ClassificationAutoJob)=>!['pending','running'].includes(job.status);
export async function fenceClassificationAutoAttempt(tx:DatabaseTransaction,job:ClassificationAutoJob,context:OutboxHandlerContext):Promise<void>{
  context.signal.throwIfAborted();
  if(!context.attempt||job.outbox_id!==context.attempt.outboxId)throw new OutboxDeliveryError('permanent','classification_auto_attempt_mismatch');
  const result=await sql`UPDATE outbox_events SET locked_until=locked_until WHERE outbox_id=${context.attempt.outboxId}
    AND state='leased' AND lease_generation=${context.attempt.leaseGeneration}::bigint AND locked_until>clock_timestamp()
    AND domain_event_id=${context.envelope.event_id} AND event_type=${CLASSIFICATION_AUTO_TAG_EVENT}
    AND handler_name=${CLASSIFICATION_AUTO_TAG_HANDLER} AND event_version=1 AND handler_mode='delivery_each_event'`.execute(tx);
  if(Number(result.numAffectedRows??0)!==1)throw new OutboxDeliveryError('retryable','classification_auto_lease_lost');
}
export function createClassificationAutoJobStore(db:Kysely<DatabaseSchema>,options:Pick<UnitOfWorkOptions,'cancelBackend'>={}){
  return {
    async read(id:string){return await db.selectFrom('collection_classification_tag_jobs').selectAll().where('id','=',id).executeTakeFirst()??null;},
    async mark(job:ClassificationAutoJob,context:OutboxHandlerContext,status:ClassificationAutoJob['status'],failureCode:string|null){
      return createUnitOfWork(db,{...options,signal:context.signal}).execute(async({transaction:tx})=>{
        const current=await tx.selectFrom('collection_classification_tag_jobs').selectAll().where('id','=',job.id).forUpdate().executeTakeFirstOrThrow();
        if(autoJobTerminal(current))return false;
        await tx.updateTable('collection_classification_tag_jobs').set({status,failure_code:failureCode,
          completed_at:status==='running'?null:sql<Date>`clock_timestamp()`}).where('id','=',job.id).execute();
        await fenceClassificationAutoAttempt(tx,current,context);return true;
      });
    },
  };
}
