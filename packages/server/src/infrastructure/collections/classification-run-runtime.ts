import { CreditError } from '../../modules/identity/index.js';
import { decodeClassificationRunSnapshot } from './classification-run-records.js';
import { createClassificationRunApply } from './classification-run-apply.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { Kysely } from 'kysely';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { loadClassificationContext,runClassificationExecution,CLASSIFICATION_POLICY,
  type BookmarkClassificationProvider,type ClassificationActionFailure,type ClassificationExecutionSeed,type ClassificationRunRuntime } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { UnitOfWorkOptions } from '../database/unit-of-work.js';
import { createClassificationRunCommands } from './classification-run-commands.js';
import { createClassificationRunJobs,type ClassificationRunLease } from './classification-run-jobs.js';
import { createPostgresClassificationExecutionStore } from './classification-execution-postgres.js';
import type { ClassificationRunBillingOptions } from './classification-run-billing.js';

export function createPostgresClassificationRunRuntime(db:Kysely<DatabaseSchema>,provider:BookmarkClassificationProvider,
  options:ClassificationRunBillingOptions&{readonly priorEnabled?:boolean;readonly profilesEnabled?:()=>boolean;readonly idGenerator?:()=>string;readonly enabled:()=>boolean;readonly tagsEnabled:()=>boolean;readonly onError:(code:string)=>void;readonly reportSourceInvalidation?:ReportSourceInvalidationOutboxPort;readonly cancelBackend?:UnitOfWorkOptions['cancelBackend']}):ClassificationRunRuntime {
  const jobs=createClassificationRunJobs(db,options);
  const executionOptions={managedAdmissionEnabled:options.managedAdmissionEnabled,credits:options.credits,
    creditEnabled:options.creditEnabled,cancelBackend:options.cancelBackend};
  const executions=createPostgresClassificationExecutionStore(db,executionOptions);
  const stopping=new AbortController(),active=new Map<string,Promise<void>>();
  let timer:ReturnType<typeof setInterval>|undefined,pollTask:Promise<void>|null=null;
  async function processRun(id:string){
    const lease=await jobs.lease(id);if(!lease)return;
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,stopping.signal]);
    let heartbeatBusy=false;
    const heartbeat=setInterval(()=>{
      if(heartbeatBusy)return;heartbeatBusy=true;
      void jobs.heartbeat(lease).then(ok=>{if(!ok)controller.abort();},()=>controller.abort()).finally(()=>{heartbeatBusy=false;});
    },5000);heartbeat.unref();
    try{
      const row=lease.row;
      if(!options.enabled()){await jobs.stopRun(lease,'disabled');return;}
      if(row.provider_id!==provider.id||row.model!==provider.model||row.policy_version!==provider.policyVersion
        ||row.prompt_version!==provider.promptVersion||row.candidate_version!==CLASSIFICATION_POLICY.candidateVersion){await jobs.stopRun(lease,'configuration_changed');return;}
      const actions=await jobs.actions(lease);let next=0;
      await Promise.all(Array.from({length:Math.min(4,actions.length)},async()=>{
        while(!signal.aborted&&next<actions.length&&Date.now()<row.deadline_at.getTime()){
          const action=actions[next++]!;
          if(!options.enabled()){await jobs.stopRun(lease,'disabled');return;}
          if(!await jobs.markRunning(lease,action.action_id))return;
          await processAction(lease,action,signal);
        }
      }));
    }finally{clearInterval(heartbeat);controller.abort();await jobs.release(lease);}
  }
  async function processAction(lease:ClassificationRunLease,action:Awaited<ReturnType<typeof jobs.actions>>[number],signal:AbortSignal){
    const snapshot=decodeClassificationRunSnapshot(lease.row.snapshot_json)!,node=snapshot.nodes.find(node=>node.id===action.node_id);
    if(!node){await jobs.finishAction(lease,action.action_id,null,'contract_drift');return;}
    const mapFailure=(code:string):ClassificationActionFailure=>({deadline:'provider_timeout',outcome_unknown:'outcome_unknown',
      contract_drift:'contract_drift',budget_exhausted:'budget_exhausted',context_limit:'context_limit'} as Record<string,ClassificationActionFailure>)[code]??'provider_unavailable';
    let failure:ClassificationActionFailure='provider_unavailable';
    try{
      const context=await loadClassificationContext({collectionId:lease.row.collection_id,ownerSubjectId:lease.row.owner_subject_id,
        preview:{source:'web',nodeId:node.id,requested:snapshot.requested},tagsEnabled:options.tagsEnabled()},
      {loadSnapshot:async()=>({...snapshot.taxonomy,node})});
      const seed:ClassificationExecutionSeed={binding:{principalId:lease.row.principal_id,commandScope:'collections:classification-run-action:v1',commandId:action.execution_command_id},
        collectionId:lease.row.collection_id,ownerSubjectId:lease.row.owner_subject_id,requestId:action.execution_command_id,
        fingerprint:canonicalCommandFingerprint({method:'CLASSIFY',route:`${lease.row.id}/${action.action_id}`,mediaType:'application/json',body:{nodeId:node.id,etag:action.node_etag}}),
        context:context!,providerId:provider.id,model:provider.model,policyVersion:provider.policyVersion,promptVersion:provider.promptVersion,
        deadlineAt:new Date(Math.min(lease.row.deadline_at.getTime(),Date.now()+20000)).toISOString(),
        billingMode:lease.row.billing_mode,billingOwnerKind:'action' as const,creditChargeId:action.credit_charge_id,
        ...(lease.row.billing_mode==='managed'&&lease.row.price_version!==null?{billing:{priceVersion:lease.row.price_version,maxPoints:Number(lease.row.quoted_points)},source:'batch' as const}:{}),
      };
      let admission=await executions.lookup(seed);
      if(!admission){
        for(let attempt=0;attempt<4;attempt++){
          try{admission=await executions.admit(seed);break;}
          catch(error){
            if((error as {code?:string}).code!=='budget_exhausted'||attempt===3)throw error;
            // No call has been dispatched. Reuse the same command while allowing
            // short admission-lock contention to clear; never retry provider work.
            await delay(25,undefined,{signal});
          }
        }
      }
      if(!admission)return;
      if(admission.kind==='accepted'||admission.kind==='in_progress'){
        const execution=await db.selectFrom('classification_provider_executions').select('id').where('principal_id','=',seed.binding.principalId)
          .where('command_scope','=',seed.binding.commandScope).where('command_id','=',seed.binding.commandId).executeTakeFirst();
        if(!execution)return;
        await runClassificationExecution(executions,provider,execution.id,{enabled:()=>options.enabled()&&!signal.aborted,signal,onError:code=>{
          failure=mapFailure(code);options.onError(`action.${code}`);
        }});
        await executions.reap();admission=await executions.lookup(seed);
      }
      if(!admission||admission.kind==='accepted'||admission.kind==='in_progress')return;
      if(!options.enabled()){await jobs.stopRun(lease,'disabled');return;}
      if(admission.kind==='replay'&&admission.result.status===200){
        const decision=JSON.parse(Buffer.from(admission.result.body).toString('utf8')) as Record<string,unknown>;
        await jobs.finishAction(lease,action.action_id,decision,null);return;
      }
      const terminal=await db.selectFrom('classification_provider_executions').select('failure_code').where('principal_id','=',seed.binding.principalId)
        .where('command_scope','=',seed.binding.commandScope).where('command_id','=',seed.binding.commandId).executeTakeFirst();
      if(terminal?.failure_code)failure=mapFailure(terminal.failure_code);
      const unknown=await db.selectFrom('classification_provider_executions as e').innerJoin('classification_call_attempts as a','a.execution_id','e.id')
        .select('e.id').where('e.command_id','=',seed.binding.commandId).where('a.state','in',['unknown','dispatching']).executeTakeFirst();
      await jobs.finishAction(lease,action.action_id,null,unknown?'outcome_unknown':failure);
    }catch(error){
      if(error instanceof CreditError)throw error;
      options.onError('action.failed');
      if(signal.aborted)return;
      // Admission rejects happen before provider dispatch and can be published as failures.
      const code=(error as {code?:string})?.code;
      await jobs.finishAction(lease,action.action_id,null,code==='budget_exhausted'||code==='context_limit'?code:failure);
    }
  }
  async function poll(){
    try{
      await jobs.reap();await executions.reap();
      for(const id of await jobs.pending()){
        if(stopping.signal.aborted||active.size>=2)break;
        if(active.has(id))continue;
        const task=processRun(id).catch(()=>options.onError('worker_failed')).finally(()=>{active.delete(id);});active.set(id,task);
      }
    }catch{options.onError('poll_failed');}
  }
  const tick=()=>{if(!pollTask&&!stopping.signal.aborted)pollTask=poll().finally(()=>{pollTask=null;});};
  return {...createClassificationRunCommands(db,provider,{cancelBackend:options.cancelBackend,idGenerator:options.idGenerator,priorEnabled:options.priorEnabled,managedAdmissionEnabled:options.managedAdmissionEnabled,credits:options.credits,creditEnabled:options.creditEnabled}),apply:createClassificationRunApply(db,provider,options),
    start(){if(timer)return;timer=setInterval(tick,5000);timer.unref();tick();},
    async stop(){stopping.abort();if(timer)clearInterval(timer);await pollTask;await Promise.allSettled(active.values());await jobs.reap();},
  };
}
