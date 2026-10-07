import { createHash,randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { CLASSIFICATION_POLICY,type CanonicalDomainEvent } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresResourceIdLedgerPort } from '../database/resource-id-ledger.js';
import { CLASSIFICATION_AUTO_TAG_EVENT,CLASSIFICATION_AUTO_TAG_HANDLER } from '../outbox/classification-auto-tag.js';
/**
 * Canonical creation and this job/outbox intent commit together, before any provider work.
 * The upstream identity is resolved and gated when the job runs, never stamped here: job
 * creation has no view of the deployment configuration and must not invent one.
 */
export async function appendClassificationAutoTagJob(tx:DatabaseTransaction,event:CanonicalDomainEvent):Promise<void>{
  if(event.aggregateType!=='node'||event.eventType!=='resource.create'||!event.aggregateRevision)return;
  const current=await tx.selectFrom('nodes as n').innerJoin('collections as c','c.id','n.collection_id')
    .innerJoin('collection_classification_settings as s','s.collection_id','c.id').innerJoin('accounts as a','a.subject_id','c.owner_subject_id')
    .select(['c.owner_subject_id','a.id as principal_id','s.revision','s.provider_profile_id'])
    .where('n.id','=',event.aggregateId).where('n.collection_id','=',event.collectionId).where('n.kind','=','bookmark')
    .where('n.deleted_at','is',null).where('n.resource_revision','=',event.aggregateRevision).where('s.auto_tag_mode','=','auto').executeTakeFirst();
  if(!current)return;
  // Account automatic capture owns new-node classification; never schedule a second paid execution.
  const capture = await tx.selectFrom('bookmark_preferences').select('capture_mode').where('account_id', '=', current.principal_id).executeTakeFirst();
  if (capture?.capture_mode === 'automatic') return;
  const profile=current.provider_profile_id?await tx.selectFrom('classification_provider_profiles').select('revision').where('id','=',current.provider_profile_id).where('owner_subject_id','=',current.owner_subject_id).executeTakeFirst():null;
  const id=randomUUID();
  const job=await tx.insertInto('collection_classification_tag_jobs').values({id,collection_id:event.collectionId,node_id:event.aggregateId,
    source_operation_id:event.operationId,resource_revision:event.aggregateRevision,owner_subject_id:current.owner_subject_id,principal_id:current.principal_id,
    settings_revision:current.revision.toString(),profile_id:current.provider_profile_id,profile_revision:profile?String(profile.revision):null,
    policy_version:CLASSIFICATION_POLICY.version,
    prompt_version:CLASSIFICATION_POLICY.promptVersion,candidate_version:CLASSIFICATION_POLICY.candidateVersion,
    execution_command_id:randomUUID(),recompute_command_id:randomUUID(),apply_command_id:randomUUID(),outbox_id:null,status:'pending',
    failure_code:null,selected_tag_digest:null,expires_at:sql<Date>`clock_timestamp()+interval '24 hours'`,completed_at:null})
    .onConflict(conflict=>conflict.column('source_operation_id').doNothing()).returning('id').executeTakeFirst();
  if(!job)return;
  const outboxId=createHash('sha256').update(`classification-auto-tag:${event.domainEventId}`).digest('base64url');
  await createPostgresResourceIdLedgerPort(tx).reserve([{resourceId:outboxId,resourceType:'outbox'}]);
  await tx.insertInto('outbox_events').values({outbox_id:outboxId,domain_event_id:event.domainEventId,event_type:CLASSIFICATION_AUTO_TAG_EVENT,event_version:1,
    handler_name:CLASSIFICATION_AUTO_TAG_HANDLER,handler_mode:'delivery_each_event',aggregate_type:'node',aggregate_id:event.aggregateId,
    aggregate_scope:event.collectionId,aggregate_revision:event.aggregateRevision,commit_ordinal:event.commitOrdinal,payload_json:{jobId:id},state:'pending',
    attempt_count:0,available_at:sql<Date>`clock_timestamp()`,locked_until:null,lease_generation:0n,completed_at:null,last_error:null,
    occurred_at:sql<Date>`clock_timestamp()`,dead_lettered_at:null}).execute();
  await tx.updateTable('collection_classification_tag_jobs').set({outbox_id:outboxId}).where('id','=',id).execute();
}
