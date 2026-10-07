import type { ClassificationEvidencePort } from './classification-hostname-prior.js';
import { assertCanonicalCommandId,canonicalCommandFingerprint,type ProductCommandClaim } from '../../commands/index.js';
import { CollectionAuthorizationError,CollectionPreconditionError,NodeConflictError } from '../domain/index.js';
import { applyClassificationContent,validateClassificationContent,type ClassificationContentResult,type ClassificationVocabularyPort } from './classification-content.js';
import { parseClassificationRunApply,ClassificationRunConflictError,type ClassificationRun,type ClassificationRunActor,type ClassificationRunSnapshot } from './classification-run.js';
import { ClassificationError,CLASSIFICATION_POLICY } from './classification-policy.js';
import type { ClassificationSettingsStore } from './classification-settings.js';
import type { ProductCollectionCanonicalPorts } from './ports.js';

export interface ClassificationRunApplyResponse {
  readonly runId:string;readonly status:'applied';readonly appliedNodeIds:readonly string[];readonly receipts:readonly ClassificationContentResult[];
}
export interface ClassificationRunApplyInput {
  readonly actor:ClassificationRunActor;readonly collectionId:string;readonly runId:string;readonly commandId:string;readonly ifMatch:string;readonly document:unknown;
}
export interface ClassificationRunApplyPorts {
  readonly evidence?:ClassificationEvidencePort;
  readonly collection:ProductCollectionCanonicalPorts;readonly vocabulary:ClassificationVocabularyPort;readonly settings:ClassificationSettingsStore;
  readonly enabled:()=>boolean;readonly tagsEnabled:()=>boolean;
  readonly runs:{
    lock(input:{collectionId:string;runId:string;ownerSubjectId:string}):Promise<{run:ClassificationRun;snapshot:ClassificationRunSnapshot|null;settingsRevision:string;candidateVersion:string}|null>;
    markApplied(runId:string):Promise<string>;
    configurationMatches(run:ClassificationRun):boolean;
  };
}
export async function applyCollectionClassificationRun(ports:ClassificationRunApplyPorts,input:ClassificationRunApplyInput):Promise<Exclude<ProductCommandClaim,{kind:'claimed'}>>{
  const selections=parseClassificationRunApply(input.document);
  const binding={principalId:input.actor.principalId,commandScope:'collections:classification-run-apply:v1',commandId:assertCanonicalCommandId(input.commandId)};
  const fingerprint=canonicalCommandFingerprint({method:'POST',route:`/api/v1/collections/${input.collectionId}/classification-runs/${input.runId}/apply`,
    mediaType:'application/json',body:selections,conditions:{ifMatch:input.ifMatch}});
  const claim=await ports.collection.receipts.claim(binding,fingerprint);
  if(claim.kind!=='claimed')return claim;
  const collection=await ports.collection.collections.lockForUpdate(input.collectionId);
  if(!collection||collection.deletedAt!==null||collection.ownerSubjectId!==input.actor.subjectId)throw new CollectionAuthorizationError({outcome:'conceal',reasonCategory:'resource_missing'});
  const stored=await ports.runs.lock({collectionId:input.collectionId,runId:input.runId,ownerSubjectId:input.actor.subjectId});
  if(!stored?.snapshot)throw new ClassificationError('resource_not_found');
  const {run,snapshot}=stored;
  if(run.status!=='open')throw new ClassificationRunConflictError('Only an open classification run can be applied once.');
  if(input.ifMatch!==run.etag)throw new CollectionPreconditionError({currentEtag:run.etag});
  if(collection.contentRevision!==run.taxonomyRevision)throw new NodeConflictError('revision_conflict','Classification taxonomy changed.');
  const settings=await ports.settings.loadOwned({collectionId:input.collectionId,ownerSubjectId:input.actor.subjectId});
  if(settings?.revision!==stored.settingsRevision||stored.candidateVersion!==CLASSIFICATION_POLICY.candidateVersion||!ports.runs.configurationMatches(run))throw new NodeConflictError('revision_conflict','Classification configuration changed.');
  const vocabulary=new Set(snapshot.taxonomy.tagUsage.map(item=>item.tag));
  const actions=selections.map(selection=>{
    const action=run.actions.find(action=>action.actionId===selection.actionId&&action.status==='succeeded');
    if(!action||selection.addTags.some(tag=>!vocabulary.has(tag)))throw new ClassificationError('invalid_input');
    return {action,selection};
  });
  // Verify the complete selected set before the first canonical side effect.
  for(const {action,selection} of actions){
    const node=await ports.collection.nodes.getNode(input.collectionId,action.nodeId);
    if(!node||node.deletedAt!==null||node.parentId!==action.sourceParentId||`"${node.resourceRevision}"`!==action.nodeEtag) {
      throw new NodeConflictError('revision_conflict','A classified bookmark changed.');
    }
    await validateClassificationContent({...ports.collection,vocabulary:ports.vocabulary},{actor:{principalId:input.actor.principalId,principalType:'account'},
      collectionId:input.collectionId,nodeId:action.nodeId,ifMatch:action.nodeEtag,selection});
  }
  const receipts:ClassificationContentResult[]=[];
  const check=()=>{if(!ports.enabled()||actions.some(({selection})=>selection.addTags.length&&!ports.tagsEnabled()))throw new ClassificationError('resource_not_found');};
  for(const {action,selection} of actions){
    check();
    const result=await applyClassificationContent({...ports.collection,vocabulary:ports.vocabulary},{actor:{principalId:input.actor.principalId,principalType:'account'},
      collectionId:input.collectionId,nodeId:action.nodeId,ifMatch:action.nodeEtag,selection});
    receipts.push(result);
    await ports.evidence?.append({ownerSubjectId:input.actor.subjectId,collectionId:input.collectionId,nodeId:action.nodeId,folderId:selection.folderId,
      addTags:selection.addTags,source:'run_apply',commandId:input.commandId,taxonomyRevision:run.taxonomyRevision,operationId:result.operationIds[0]});
  }
  check();
  const etag=await ports.runs.markApplied(run.runId);
  const response:ClassificationRunApplyResponse={runId:run.runId,status:'applied',appliedNodeIds:receipts.map(receipt=>receipt.nodeId),receipts};
  const result={status:200,mediaType:'application/json',contractVersion:'1.0.0',body:Buffer.from(JSON.stringify(response)),
    stableHeaders:{etag,'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'}};
  await ports.collection.receipts.complete(binding,fingerprint,result);check();
  return {kind:'replay',result};
}
