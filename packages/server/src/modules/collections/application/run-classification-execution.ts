import { rankClassificationHostnameTies,CLASSIFICATION_HOSTNAME_PRIOR_POLICY_VERSION } from './classification-hostname-prior.js';
import { canonicalCommandFingerprint, canonicalJson, type ProductCommandResult } from '../../commands/index.js';
import { ClassificationError, CLASSIFICATION_POLICY } from './classification-policy.js';
import { ClassificationProviderError, type BookmarkClassificationProvider } from './classification-provider.js';
import { classificationCallProvenNotAccepted, classificationFailureReceipt, type ClassificationExecutionStore } from './classification-execution.js';
import { decideClassificationFolder, decideClassificationTags } from './classification-decision.js';
import { buildClassificationCandidates, selectClassificationDescendants } from './classification-candidates.js';
import { normalizeClassificationBookmark, compileClassificationText } from './classification-text.js';
import { parseClassificationSettingsPatch } from './classification-settings.js';
import { CreditError } from '../../identity/index.js';

/** Provider work is outside every store transaction. Persist success before advancing a stage. */
export async function runClassificationExecution(store:ClassificationExecutionStore, provider:BookmarkClassificationProvider,
  id:string, options:{readonly enabled:()=>boolean;readonly signal?:AbortSignal;readonly onError:(code:string)=>void}):Promise<void> {
  const lease=await store.lease(id);if(!lease)return;
  const controller=new AbortController();
  const remaining=Math.min(15000,new Date(lease.deadlineAt).getTime()-Date.now());
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,remaining)),...(options.signal?[options.signal]:[])]);
  let heartbeatRunning=false;
  const heartbeat=setInterval(()=>{
    if(heartbeatRunning)return;heartbeatRunning=true;
    void store.heartbeat(lease).then(ok=>{if(!ok)controller.abort();}).catch(()=>{controller.abort();options.onError('heartbeat_failed');}).finally(()=>{heartbeatRunning=false;});
  },5000);
  heartbeat.unref();
  try{
    if(!options.enabled())throw new ClassificationProviderError('disabled');
    if(lease.providerId!==provider.id||lease.model!==provider.model||lease.policyVersion!==provider.policyVersion||lease.promptVersion!==provider.promptVersion)throw new ClassificationProviderError('configuration_changed');
    const saved=lease.context;
    if(saved.snapshot.collectionId!==lease.collectionId||saved.snapshot.settings.collectionId!==lease.collectionId)throw new ClassificationProviderError('contract_drift');
    const settings=saved.snapshot.settings;
    try{parseClassificationSettingsPatch({autoTagMode:settings.autoTagMode,maxAutoTags:settings.maxAutoTags,executionMode:settings.executionMode,providerProfileId:settings.providerProfileId},{auto:true,byok:true});}
    catch{throw new ClassificationProviderError('contract_drift');}
    const context={...saved,bookmark:normalizeClassificationBookmark(saved.bookmark),collection:{
      title:compileClassificationText(saved.snapshot.title,CLASSIFICATION_POLICY.titleBytes),
      summary:saved.snapshot.summary===null?null:compileClassificationText(saved.snapshot.summary,CLASSIFICATION_POLICY.summaryBytes)}};
    // Rebuild candidates after deserialization; never trust a persisted derived allowlist.
    const candidates=context.requested.folder||context.requested.tags?buildClassificationCandidates({bookmark:context.bookmark,
      folders:context.snapshot.folders,tagUsage:context.snapshot.tagUsage,existingTags:context.snapshot.node?.tags??[],requested:context.requested,
      rejectedFolderIds:context.rejectedFolderIds}):null;
    const emptyCoverage={policyVersion:CLASSIFICATION_POLICY.candidateVersion,l1Total:0,l1Included:0,descendantTotal:0,descendantIncluded:0,tagTotal:0,tagIncluded:0};
    const output=candidates?await provider.classify({...context,candidates},{executionId:id,deadlineAt:lease.deadlineAt,signal,calls:{
      async run(stage,chunk,input,send){
        if((stage==='tags'&&(!context.requested.tags||!candidates?.tagChunks[chunk]))
          ||(stage!=='tags'&&(!context.requested.folder||chunk!==0))||!['l1','l2','tags'].includes(stage))throw new ClassificationProviderError('contract_drift');
        if(!options.enabled())throw new ClassificationProviderError('disabled');
        if(signal.aborted)throw new ClassificationProviderError('deadline');
        const digest=canonicalCommandFingerprint({method:'CALL',route:`${stage}/${chunk}`,mediaType:'application/json',body:input});
        const cached=await store.prepare(lease,stage,chunk,digest);if(cached)return cached;
        if(signal.aborted)throw new ClassificationProviderError('deadline');
        await store.dispatch(lease,stage,chunk);
        // Any process/network failure beyond dispatch is conservatively unknown.
        let result;
        try{if(signal.aborted)throw new ClassificationProviderError('deadline');result=await send();}catch(error){
          if((error instanceof ClassificationProviderError||error instanceof ClassificationError)&&['credentials','contract_drift','deadline','rate_limited'].includes(error.code))
            await store.rejectCall(lease,stage,chunk,classificationCallProvenNotAccepted(error),
              error instanceof ClassificationProviderError?error.attempts:undefined);
          throw error;
        }
        if(signal.aborted)throw new ClassificationProviderError('outcome_unknown');
        await store.completeCall(lease,stage,chunk,result);
        return result;
      },
    }}):{l1:null,l2:null,tags:[],candidateCoverage:emptyCoverage,modelVersion:null};
    if(signal.aborted)throw new ClassificationProviderError('deadline');
    const providerFolder=candidates?decideClassificationFolder({candidates,bookmark:context.bookmark,requested:context.requested.folder,l1:output.l1,l2:output.l2,folderSelectionMode:context.folderSelectionMode}):null;
    if(!candidates&&(output.l1!==null||output.l2!==null))throw new ClassificationProviderError('contract_drift');
    const folder=provider.policyVersion===CLASSIFICATION_HOSTNAME_PRIOR_POLICY_VERSION?rankClassificationHostnameTies(providerFolder,context.snapshot.hostnameEvidence??[],context.bookmark.url):providerFolder;
    const coverage=folder?.l1FolderId&&candidates?selectClassificationDescendants(candidates,folder.l1FolderId,context.bookmark).coverage:candidates?.coverage
      ??emptyCoverage;
    if(canonicalJson(coverage)!==canonicalJson(output.candidateCoverage))throw new ClassificationProviderError('contract_drift');
    const tags=decideClassificationTags({candidates:candidates?.tags??[],existingTags:context.snapshot.node?.tags??[],output:output.tags,maxAdded:context.snapshot.settings.maxAutoTags});
    const body={contractVersion:'1.0.0',collectionId:lease.collectionId,source:{kind:context.snapshot.node?'node':'incoming',nodeId:context.snapshot.node?.id??null},
      taxonomyRevision:context.snapshot.contentRevision,candidateCoverage:output.candidateCoverage,folder,
      tags:{mode:context.requested.tags?'suggest':'off',candidates:tags.slice(0,15),maxAutoTags:context.snapshot.settings.maxAutoTags},
      provider:{providerId:provider.id,model:provider.model,policyVersion:provider.policyVersion,promptVersion:provider.promptVersion}};
    const result:ProductCommandResult={status:200,contractVersion:'1.0.0',mediaType:'application/json',
      stableHeaders:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'},body:Buffer.from(canonicalJson(body))};
    await store.finish(lease,'succeeded',result);
  }catch(error){
    // Financial uncertainty is retried through the original persisted task.
    // It cannot turn a possibly committed success into an automatic release.
    if(error instanceof CreditError){options.onError(error.code);throw error;}
    const code=error instanceof ClassificationProviderError||error instanceof ClassificationError?error.code:'outcome_unknown';
    options.onError(code);
    try{await store.finish(lease,code==='outcome_unknown'?'outcome_unknown':'failed',classificationFailureReceipt(lease.requestId,code),code);}
    catch{options.onError('terminal_write_deferred_to_reaper');}
  }finally{clearInterval(heartbeat);controller.abort();}
}
