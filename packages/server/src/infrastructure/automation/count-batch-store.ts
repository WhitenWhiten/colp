import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationDigest,bindingSemanticDigest,type RoleBindings,type EventFacts,type RuleDefinition } from '@know-n/colp/automation';
import type { AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { initializeRunTasks,advanceRunTasks } from './task-scheduler.js';
export interface BatchMember {eventId:string;nodeId:string;revision:string;ordinal:string}
export interface BatchPin {revisionId:string;ruleId:string;epoch:string;bindingSetId:string;bindingRevision:string;policyRevision:string|null;definition:RuleDefinition}
/** Source cursor, dedup identity, exact membership, remainder, run and jobs share the caller's transaction. */
export async function admitCountMember(tx:DatabaseTransaction,actor:AutomationActor,serverUuid:string,pin:BatchPin,event:EventFacts,revision:string,url:string):Promise<void>{
  const trigger=pin.definition.trigger;if(trigger.mode!=='countBatch')throw new Error('Count trigger required');
  const configuration=(await sql<{space_id:string;values_json:RoleBindings}>`SELECT s.space_id,b.values_json
    FROM automation_aggregation_spaces s JOIN automation_binding_revisions b ON b.binding_set_id=${pin.bindingSetId}
      AND b.revision=${pin.bindingRevision}::bigint WHERE s.revision_id=${pin.revisionId}`.execute(tx)).rows[0]!;
  const space=configuration.space_id;
  const identity=automationDigest({kind:trigger.partition,key:trigger.partition==='folder'?event.bookmark.parent?.nodeId ?? '':trigger.partition==='collection'?event.collectionId:pin.ruleId,
    binding:bindingSemanticDigest(configuration.values_json)});
  const legacy=(await sql<{partition_key:string}>`SELECT partition_key FROM automation_aggregate_state
    WHERE rule_revision_id=${space} AND epoch=${pin.epoch}::bigint AND partition_identity=${identity}
    ORDER BY (jsonb_array_length(remainder_json)>0) DESC,partition_key LIMIT 1 FOR UPDATE`.execute(tx)).rows[0];
  const partition=legacy?.partition_key ?? identity;
  let distinctKey=event.nodeId;
  if(trigger.distinctBy==='normalizedUrl'){
    const normalized=new URL(url);normalized.hash='';normalized.hostname=normalized.hostname.toLowerCase().replace(/\.+$/,'');distinctKey=automationDigest({normalizer:'batch-url/v1',url:normalized.href});
  }
  const member:BatchMember={eventId:event.eventId,nodeId:event.nodeId,revision,ordinal:event.commitOrdinal};
  await sql`INSERT INTO automation_aggregate_state(rule_revision_id,epoch,partition_key,sequence,remainder_json,partition_identity)
    VALUES(${space},${pin.epoch}::bigint,${partition},0,'[]',${identity}) ON CONFLICT DO NOTHING`.execute(tx);
  const aggregate=(await sql<{sequence:string;remainder_json:BatchMember[]}>`SELECT sequence::text,remainder_json FROM automation_aggregate_state
    WHERE rule_revision_id=${space} AND epoch=${pin.epoch}::bigint AND partition_key=${partition} FOR UPDATE`.execute(tx)).rows[0]!;
  const duplicate=(await sql`SELECT 1 FROM automation_batch_members m JOIN automation_aggregate_state a
    USING(rule_revision_id,epoch,partition_key) WHERE m.rule_revision_id=${space} AND m.epoch=${pin.epoch}::bigint
    AND a.partition_identity=${identity} AND m.distinct_key=${distinctKey} LIMIT 1`.execute(tx)).rows.length>0;
  if(duplicate)return;
  const added=(await sql`INSERT INTO automation_batch_members(rule_revision_id,epoch,partition_key,distinct_key,source_event_id,member_json)
    VALUES(${space},${pin.epoch}::bigint,${partition},${distinctKey},${event.eventId},${JSON.stringify(member)}::jsonb) ON CONFLICT DO NOTHING RETURNING source_event_id`.execute(tx)).rows;
  if(!added.length)return;
  const remainder=[...aggregate.remainder_json,member];let sequence=BigInt(aggregate.sequence);
  while(remainder.length>=trigger.count){
    const batch=remainder.splice(0,trigger.count),id=randomUUID(),first=batch[0]!;sequence++;
    await sql`INSERT INTO automation_runs(id,owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,state,explanation_json)
      VALUES(${id},${actor.accountId},'batch',${pin.revisionId},${pin.bindingSetId},${pin.bindingRevision}::bigint,${pin.policyRevision},${JSON.stringify(batch.map(m=>m.eventId))}::jsonb,'completed',
      ${JSON.stringify({collectionId:event.collectionId,nodeId:first.nodeId,sourceRevision:first.revision,plan:{kind:'matched'},epoch:pin.epoch,sequence:String(sequence),partition,memberSources:batch,causationRoot:id})}::jsonb)`.execute(tx);
    await sql`UPDATE automation_batch_members SET run_id=${id} WHERE rule_revision_id=${space} AND epoch=${pin.epoch}::bigint
      AND partition_key=${partition} AND source_event_id IN (${sql.join(batch.map(m=>sql`${m.eventId}`))}) AND run_id IS NULL`.execute(tx);
    await sql`UPDATE automation_admission_receipts SET run_id=${id} WHERE rule_revision_id IN (SELECT revision_id FROM automation_aggregation_spaces WHERE space_id=${space}) AND source_event_id IN (${sql.join(batch.map(m=>sql`${m.eventId}`))}) AND stage=${pin.definition.on==='intake.completed'?'intake.completed':'intake'}`.execute(tx);
    await initializeRunTasks(tx,actor,id);await advanceRunTasks(tx,actor,serverUuid,id);
  }
  await sql`UPDATE automation_aggregate_state SET sequence=${String(sequence)}::bigint,remainder_json=${JSON.stringify(remainder)}::jsonb
    WHERE rule_revision_id=${space} AND epoch=${pin.epoch}::bigint AND partition_key=${partition}`.execute(tx);
}
