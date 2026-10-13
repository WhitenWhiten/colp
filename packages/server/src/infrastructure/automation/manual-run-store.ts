import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { RunOncePreview } from '@know-n/colp/automation';
import { AutomationError,parseContract,type AutomationActor,type AutomationPorts } from '../../modules/automation/index.js';
import type { RunOnceService } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { manualConfiguration,previewManualRun,type ManualSnapshot } from './manual-preview-store.js';
import { lockPlacementCollection,canonicalPlacementMove } from './canonical-placement.js';
import { recordPlacementHistory } from './placement-history-store.js';
import { initializeRunTasks,advanceRunTasks } from './task-scheduler.js';
import { reserveIntakeAdmission } from './intake-capacity.js';
import { createPostgresCollectionVersionStore } from '../collections/index.js';
import { captureCollectionTreeVersion } from '../../modules/collections/index.js';
interface PreviewRow { id:string;digest:string;snapshot_json:ManualSnapshot;result_json:RunOncePreview;expires_at:Date;run_id:string|null }
const stale=()=>new AutomationError('automation_stale_input','Run-once preview changed or expired; refresh the preview.');
export function createManualRunStore(tx:DatabaseTransaction,ports:AutomationPorts,actor:AutomationActor,serverUuid:string):RunOnceService {
  return {preview:(id,input)=>previewManualRun(tx,ports,actor,serverUuid,id,input),async start(ruleId,body){
    const input=parseContract('RunOnceStartInput',body);
    const row=(await sql<PreviewRow>`SELECT * FROM automation_manual_previews WHERE id=${input.previewId} AND owner_id=${actor.accountId} AND rule_id=${ruleId} FOR UPDATE`.execute(tx)).rows[0];
    if(!row || row.digest!==input.previewDigest) throw stale();
    const snapshot=row.snapshot_json,{inspected,digest}=await manualConfiguration(ports,actor,ruleId,snapshot.input);
    if(row.run_id) {const previous=await ports.runs.load(row.run_id);if(!previous)throw stale();return previous.view;}
    if(!row.result_json.canStart || row.expires_at<=await ports.now() || digest!==snapshot.configurationDigest) throw stale();
    if((await ports.settings.get(actor.accountId)).paused) throw new AutomationError('automation_paused','Resume before starting the preview.');
    const collection=await lockPlacementCollection(tx,actor,snapshot.collectionId);
    if(collection.content_revision!==snapshot.collectionRevision) throw stale();
    for(const member of snapshot.members){
      const node=await tx.selectFrom('nodes').select(['resource_revision','deleted_at']).where('collection_id','=',snapshot.collectionId).where('id','=',member.event.nodeId).executeTakeFirst();
      if(!node || node.deleted_at || node.resource_revision!==member.revision) throw stale();
    }
    const selected=snapshot.members.filter(m=>['matched','placed','preserved'].includes(m.plan.kind));
    const parentId=randomUUID();
    await insert(parentId,snapshot,selected.map(m=>m.event.eventId),{collectionId:snapshot.collectionId,manualSelection:true,plan:{kind:'matched'},causationRoot:parentId});
    if(!await reserveIntakeAdmission(tx,{runId:parentId,ownerId:actor.accountId,ruleId,collectionId:snapshot.collectionId,maxRunsPerDay:snapshot.definition.policy.maxRunsPerDay}))
      throw new AutomationError('automation_command_conflict','Daily run capacity reached; start again with a current preview after capacity is available.');
    if(selected.some(m=>m.plan.kind==='placed')){
      const versions=createPostgresCollectionVersionStore(tx),before=await versions.getOwnedLive(snapshot.collectionId,actor.subjectId);
      if(!before)throw stale();
      await captureCollectionTreeVersion({versions,clock:{now:()=>new Date()}},{accountId:actor.accountId,collection:before,kind:'pre_mutation',cause:`automation:${ruleId}`,label:'Before explicit run-once placement'});
    }
    for(const member of selected){
      const id=randomUUID();
      await insert(id,snapshot,[member.event.eventId],{collectionId:snapshot.collectionId,nodeId:member.event.nodeId,sourceRevision:member.revision,
        parentRunId:parentId,causationRoot:parentId,plan:member.plan});
      if(member.plan.kind==='placed'){
        const current=await tx.selectFrom('nodes').select('parent_id').where('id','=',member.event.nodeId).where('collection_id','=',snapshot.collectionId).executeTakeFirstOrThrow();
        if(current.parent_id!==member.plan.folder.nodeId){
          const moved=await canonicalPlacementMove(tx,actor,{collectionId:snapshot.collectionId,nodeId:member.event.nodeId,parentId:member.plan.folder.nodeId,expectedRevision:member.revision,runId:id,stage:'intake'});
          await recordPlacementHistory(tx,actor,serverUuid,id,moved.operationId);
        }
      }
      if(snapshot.input.tasks==='all' && snapshot.definition.tasks.length){await initializeRunTasks(tx,actor,id);await advanceRunTasks(tx,actor,serverUuid,id);}
    }
    await sql`UPDATE automation_manual_previews SET run_id=${parentId} WHERE id=${row.id}`.execute(tx);
    return (await ports.runs.load(parentId))!.view;
  }};
  async function insert(id:string,s:ManualSnapshot,members:string[],explanation:Record<string,unknown>){
    await sql`INSERT INTO automation_runs(id,owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,state,explanation_json)
      VALUES(${id},${actor.accountId},'manual',${s.ruleRevisionId},${s.bindingSetId},${s.bindingRevision}::bigint,${s.policyRevision},${JSON.stringify(members)}::jsonb,'completed',${JSON.stringify(explanation)}::jsonb)`.execute(tx);
  }
}
