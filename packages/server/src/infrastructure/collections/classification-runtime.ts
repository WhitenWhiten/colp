import { pruneClassificationEvidence } from './classification-evidence-postgres.js';
import { observeClassificationWork } from './classification-metrics.js';
import type { Kysely } from 'kysely';
import { assertCanonicalCommandId,canonicalCommandFingerprint } from '../../modules/commands/index.js';
import type { AccountCreditsPort } from '../../modules/identity/index.js';
import { loadClassificationContext,parseClassificationPreviewInput,runClassificationExecution,ClassificationError,ClassificationProviderError,
  type BookmarkClassificationProvider,type ClassificationPreviewRuntime,type ClassificationExecutionSeed } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresClassificationExecutionStore } from './classification-execution-postgres.js';
import { createPostgresClassificationTaxonomyReadPort } from './classification-taxonomy-read.js';

export function createPostgresClassificationRuntime(db:Kysely<DatabaseSchema>,provider:BookmarkClassificationProvider,
  options:{readonly priorEnabled?:boolean;readonly enabled:boolean;readonly tagsEnabled:boolean;readonly onError:(code:string)=>void;readonly onGauge?:(name:string,value:number)=>void;readonly cancelBackend?:(pid:number)=>Promise<boolean>;
    readonly managedAdmissionEnabled?:boolean;readonly observeCredits?:()=>Promise<void>;readonly creditEnabled?:boolean;readonly credits?:(transaction:DatabaseTransaction,accountId:string)=>AccountCreditsPort}):ClassificationPreviewRuntime {
  const store=createPostgresClassificationExecutionStore(db,{managedAdmissionEnabled:options.managedAdmissionEnabled,creditEnabled:options.creditEnabled,credits:options.credits,cancelBackend:options.cancelBackend});
  const stopping=new AbortController();const active=new Map<string,Promise<void>>();let timer:ReturnType<typeof setInterval>|undefined;let polling=false;let pollTask:Promise<void>|null=null;
  let observationTask:Promise<void>|null=null;
  const run=(id:string)=>{
    const current=active.get(id);if(current)return current;
    const task=runClassificationExecution(store,provider,id,{enabled:()=>options.enabled&&!stopping.signal.aborted,signal:stopping.signal,onError:options.onError})
      .finally(()=>{active.delete(id);});active.set(id,task);return task;
  };
  async function poll(){
    if(polling||stopping.signal.aborted)return;polling=true;
    try{await pruneClassificationEvidence(db);const reaped=await store.reap();if(reaped)options.onError('deadline_reaped');
      if(options.onGauge)await observeClassificationWork(db,options.onGauge);for(const id of await store.pending()){if(stopping.signal.aborted||active.size>=2)break;
      void run(id).catch(()=>options.onError('worker_execution_failed'));
    }}catch{options.onError('worker_poll_failed');}finally{polling=false;}
  }
  const tick=()=>{
    if(stopping.signal.aborted)return;
    if(!pollTask)pollTask=poll().finally(()=>{pollTask=null;});
    // Financial observation has its own single-flight task; growing history
    // must not delay recovery or dispatch, and shutdown still drains both.
    if(options.observeCredits&&!observationTask)observationTask=Promise.resolve()
      .then(()=>options.observeCredits!()).catch(()=>options.onError('credit_observation_failed'))
      .finally(()=>{observationTask=null;});
  };
  return {
    async preview(input){
      const deadlineAt=new Date(Date.now()+20000).toISOString();
      const signal=AbortSignal.timeout(20000);
      const admissionStore=createPostgresClassificationExecutionStore(db,{signal,cancelBackend:options.cancelBackend,
        managedAdmissionEnabled:options.managedAdmissionEnabled,creditEnabled:options.creditEnabled,credits:options.credits});
      const reads=createPostgresClassificationTaxonomyReadPort(db,{signal,cancelBackend:options.cancelBackend,priorEnabled:options.priorEnabled});
      const work=async()=>{
      const document=parseClassificationPreviewInput(input.document);
      const commandId=assertCanonicalCommandId(input.commandId);
      const binding={principalId:input.actor.principalId,commandScope:'collections:classification-preview:v1',commandId};
      const fingerprint=canonicalCommandFingerprint({method:'POST',route:`/api/v1/collections/${input.collectionId}/classification/preview`,mediaType:'application/json',body:document});
      const base={binding,fingerprint,ownerSubjectId:input.actor.subjectId,collectionId:input.collectionId};
      const existing=await admissionStore.lookup(base);if(existing)return existing;
      const context=await loadClassificationContext({...base,preview:document,tagsEnabled:options.tagsEnabled},reads);
      if(!context)throw new ClassificationError('resource_not_found');
      const seed:ClassificationExecutionSeed={...base,context,requestId:input.requestId,deadlineAt,providerId:provider.id,model:provider.model,
        policyVersion:provider.policyVersion,promptVersion:provider.promptVersion,billing:document.billing,
        source:document.source==='console'?'system':document.source};
      const admission=await admissionStore.admit(seed);if(admission.kind!=='accepted')return admission;
      await run(admission.executionId);
      await store.reap();
      return await store.lookup(base)??{kind:'in_progress',retryAfterSeconds:1};
      };
      return new Promise((resolve,reject)=>{
        const abort=()=>reject(new ClassificationProviderError('deadline'));
        signal.addEventListener('abort',abort,{once:true});
        void work().then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
      });
    },
    start(){if(timer)return;timer=setInterval(tick,5000);timer.unref();tick();},
    async stop(){stopping.abort();if(timer)clearInterval(timer);await Promise.all([pollTask,observationTask]);await Promise.allSettled([...active.values()]);await store.reap();},
  };
}
