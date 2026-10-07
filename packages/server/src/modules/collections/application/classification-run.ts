import type { ClassificationTaxonomySnapshot } from './classification-context.js';
import type { ClassificationRequested } from './classification-policy.js';
import { parseClassificationBillingConsent, type ClassificationBillingConsent } from './classification-billing.js';
import { ClassificationError } from './classification-policy.js';
import { isClassificationOpaqueId, parseClassificationConfirmation, type ClassificationContentSelection } from './classification-content.js';
import type { ProductCommandClaim } from '../../commands/index.js';

export interface ClassificationRunCreate {
  readonly sourceFolderIds:readonly string[];readonly nodeIds:readonly string[];
  readonly requested:ClassificationRequested;readonly maxItems:number;readonly billing?:ClassificationBillingConsent;
}
export interface ClassificationRunBookmark extends NonNullable<ClassificationTaxonomySnapshot['node']> {
  readonly parentId:string;readonly createdAt:string;
}
export interface ClassificationRunSnapshot {
  readonly taxonomy:ClassificationTaxonomySnapshot;readonly nodes:readonly ClassificationRunBookmark[];
  readonly requested:ClassificationRequested;
}
export type ClassificationRunStatus='queued'|'running'|'open'|'applied'|'failed'|'cancelled'|'expired';
export type ClassificationActionFailure='provider_timeout'|'provider_unavailable'|'contract_drift'|'outcome_unknown'
  |'budget_exhausted'|'context_limit'|'deadline_exceeded'|'cancelled';
export interface ClassificationRunAction {
  readonly actionId:string;readonly nodeId:string;readonly nodeEtag:string;readonly sourceParentId:string;
  readonly status:'pending'|'running'|'succeeded'|'failed';
  readonly decision:Record<string,unknown>|null;readonly failureCode:ClassificationActionFailure|null;
  readonly creditChargeId?:string|null;
}
export interface ClassificationCreditUsage {
  readonly mode:'managed'|'byok'|'legacy_free';readonly priceVersion:string|null;readonly quotedPoints:number;
  readonly reservedPoints:number;readonly chargedPoints:number;readonly releasedPoints:number;
}
export interface ClassificationRun {
  readonly runId:string;readonly etag:string;
  readonly status:ClassificationRunStatus;readonly failureCode:'stale_snapshot'|'configuration_changed'|'all_actions_failed'|null;
  readonly taxonomyRevision:string;
  readonly provider:{readonly providerId:string;readonly model:string;readonly policyVersion:string;readonly promptVersion:string};
  readonly createdAt:string;readonly deadlineAt:string;readonly expiresAt:string;
  readonly actions:readonly ClassificationRunAction[];
  readonly creditUsage?:ClassificationCreditUsage;
}
export interface ClassificationRunSelection extends ClassificationContentSelection {readonly actionId:string}
export class ClassificationRunConflictError extends Error {}
export interface ClassificationRunActor {readonly principalId:string;readonly subjectId:string}
export type ClassificationRunCommandOutcome=Exclude<ProductCommandClaim,{kind:'claimed'}>;
export interface ClassificationRunRuntime {
  create(input:{actor:ClassificationRunActor;collectionId:string;commandId:string;requestId:string;document:unknown}):Promise<ClassificationRunCommandOutcome>;
  get(input:{actor:ClassificationRunActor;collectionId:string;runId:string}):Promise<ClassificationRun>;
  cancel(input:{actor:ClassificationRunActor;collectionId:string;runId:string;commandId:string;ifMatch:string;document:unknown}):Promise<ClassificationRunCommandOutcome>;
  apply(input:import('./classification-run-apply.js').ClassificationRunApplyInput):Promise<ClassificationRunCommandOutcome>;
  start():void;stop():Promise<void>;
}
const invalid=()=>new ClassificationError('invalid_input');
function ids(value:unknown):readonly string[]{
  if(!Array.isArray(value)||value.length>50||value.some(id=>!isClassificationOpaqueId(id))||new Set(value).size!==value.length)throw invalid();
  return value;
}
export function parseClassificationRunCreate(value:unknown):ClassificationRunCreate {
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
  const raw=value as Record<string,unknown>;
  if(!Object.hasOwn(raw,'requested')||!Object.hasOwn(raw,'maxItems')||Object.keys(raw).some(key=>!['sourceFolderIds','nodeIds','requested','maxItems','billing'].includes(key)))throw invalid();
  const sourceFolderIds=ids(Object.hasOwn(raw,'sourceFolderIds')?raw.sourceFolderIds:[]),nodeIds=ids(Object.hasOwn(raw,'nodeIds')?raw.nodeIds:[]);
  if(!sourceFolderIds.length&&!nodeIds.length)throw invalid();
  if(!Number.isInteger(raw.maxItems)||Number(raw.maxItems)<1||Number(raw.maxItems)>50)throw invalid();
  const requested=raw.requested as Record<string,unknown>|null;
  if(!requested||typeof requested!=='object'||Array.isArray(requested)||Object.keys(requested).length!==2
    ||typeof requested.folder!=='boolean'||typeof requested.tags!=='boolean'||!requested.folder&&!requested.tags)throw invalid();
  const billing=Object.hasOwn(raw,'billing')?parseClassificationBillingConsent(raw.billing):undefined;
  return {sourceFolderIds,nodeIds,requested:{folder:requested.folder,tags:requested.tags},maxItems:Number(raw.maxItems),...(billing===undefined?{}:{billing})};
}
export function selectClassificationRunNodes(input:ClassificationRunCreate,tree:{rootId:string;folders:ClassificationTaxonomySnapshot['folders'];bookmarks:readonly ClassificationRunBookmark[]}) {
  const parents=new Map(tree.folders.map(folder=>[folder.id,folder.parentId??tree.rootId]));
  if(input.sourceFolderIds.some(id=>id!==tree.rootId&&!parents.has(id))||input.nodeIds.some(id=>!tree.bookmarks.some(node=>node.id===id)))throw new ClassificationError('resource_not_found');
  const selected=new Set(input.nodeIds),sources=new Set(input.sourceFolderIds);
  const inSource=(node:ClassificationRunBookmark)=>{
    let parent:string|undefined=node.parentId;const seen=new Set<string>();
    while(parent&&!seen.has(parent)){if(sources.has(parent))return true;seen.add(parent);parent=parents.get(parent);}
    return false;
  };
  return tree.bookmarks.filter(node=>selected.has(node.id)||inSource(node)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)
    ||(a.id<b.id?-1:a.id>b.id?1:0)).slice(0,input.maxItems);
}
export function parseClassificationRunApply(value:unknown):readonly ClassificationRunSelection[]{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1)throw invalid();
  const selections=(value as {selections?:unknown}).selections;
  if(!Array.isArray(selections)||!selections.length||selections.length>50)throw invalid();
  const result=selections.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).length!==3||!isClassificationOpaqueId(item.actionId))throw invalid();
    return {actionId:item.actionId,...parseClassificationConfirmation({folderId:item.folderId,addTags:item.addTags})};
  });
  if(new Set(result.map(item=>item.actionId)).size!==result.length)throw invalid();return result;
}
