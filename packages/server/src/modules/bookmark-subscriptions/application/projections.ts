import type { SubscriptionActor, SubscriptionTransactionPorts, SourceProjection } from './contracts.js';
import type { AccessCheck, NodeAccessCheck, SourceNodeRef, SourceRef, Mapping, ProjectionCheck, SnapshotDescriptor, NodePage } from '../domain/types.js';
import { digest, etag, fail, mappingConfig, object, revision, sourceRef, uuid } from './validation.js';
import { createSubscriptionCursorCodec } from './cursor.js';
export async function mappingAndSource(p:SubscriptionTransactionPorts,actor:SubscriptionActor,id:string) {
  const mapping=await p.store.getMapping(actor.accountId,id);if(!mapping)return fail('resource_not_found');
  const source=await p.store.getSubscription(actor.accountId,mapping.subscriptionId);if(!source)return fail('resource_not_found');return {mapping,source};
}
async function lifecycle(p:SubscriptionTransactionPorts,actor:SubscriptionActor,m:Mapping,subscriptionActive:boolean,actionId?:string) {
  if(actionId){const task=(await p.store.tasks(actor.accountId,{actionId})).find(t=>t.actionId===actionId&&t.mappingId===m.mappingId&&t.generation===m.generation&&t.effectiveAction==='keep');if(!task||await p.store.getReceipt(actor.accountId,task.actionId)||m.status!=='terminating')fail('resource_not_found');return true;}
  return m.status==='active'&&subscriptionActive;
}
export async function accessCheck(p:SubscriptionTransactionPorts,actor:SubscriptionActor,id:string,enabled:boolean,editionIds:string[],actionId?:string):Promise<AccessCheck> {
  const {mapping:m,source}=await mappingAndSource(p,actor,id);
  if(source.sourceType==='collection'&&editionIds.length)fail('invalid_query');
  const fence={mappingId:id,generation:m.generation,mappingRevision:m.revision,contentEnabled:enabled};
  if(!await lifecycle(p,actor,m,source.status==='active',actionId))return {...fence,authorityRevision:digest([m.revision,source.revision]),state:'terminated',next:'fetch_actions'};
  const check=await p.sources.check(actor,source,editionIds);
  return check.available?{...fence,authorityRevision:check.authorityRevision,state:'available',removeEditionIds:check.removeEditionIds}:{...fence,authorityRevision:check.authorityRevision,state:'unavailable',cleanup:'remove_managed',reason:'access_lost'};
}
export async function checkNodes(p:SubscriptionTransactionPorts,actor:SubscriptionActor,id:string,enabled:boolean,generation:string,nodes:SourceNodeRef[],actionId?:string):Promise<NodeAccessCheck> {
  const {mapping:m,source}=await mappingAndSource(p,actor,id);if(m.generation!==generation)fail('revision_conflict');
  const fence={mappingId:id,generation:m.generation,mappingRevision:m.revision,contentEnabled:enabled};
  if(!await lifecycle(p,actor,m,source.status==='active',actionId))return {...fence,authorityRevision:digest([m.revision,source.revision]),state:'terminated',next:'fetch_actions'};
  const check=await p.sources.check(actor,source,[],nodes);
  return check.available?{...fence,authorityRevision:check.authorityRevision,state:'available',requestDigest:digest(nodes),removeNodes:check.removeNodes}:{...fence,authorityRevision:check.authorityRevision,state:'unavailable',cleanup:'remove_managed',reason:'access_lost'};
}
export function describeProjection(projection:SourceProjection,mapping:Mapping|null) {
  const counts={nodes:projection.nodes.length,bookmarks:projection.nodes.filter(n=>n.role==='content'&&n.kind==='bookmark').length,editions:projection.editions.length,skipped:projection.skippedByReason.reduce((n,r)=>n+r.count,0)};
  const contentDigest=digest(projection.nodes);const projectionRevision=digest(['1',contentDigest,projection.contentRevision,projection.policyRevision,mapping]);
  return {projectionRevision,projectionEtag:etag(projectionRevision),policyRevision:projection.policyRevision,contentDigest,rootKey:projection.nodes[0]!.key,counts};
}
export async function projectionCheck(p:SubscriptionTransactionPorts,actor:SubscriptionActor,id:string):Promise<{value:ProjectionCheck;etag?:string}> {
  const {mapping:m,source}=await mappingAndSource(p,actor,id);
  if(m.status!=='active'||source.status!=='active')return {value:{state:'terminated',mappingId:id,generation:m.generation,next:'fetch_actions'}};
  const projection=await p.sources.project(actor,source,m.digestMode,m.editionLimit);
  if(!projection)return {value:{state:'unavailable',mappingId:id,generation:m.generation,cleanup:'remove_managed',authorityRevision:digest([m.revision,source.revision,'unavailable']),reason:'access_lost'}};
  const {projectionEtag,...fields}=describeProjection(projection,m);return {value:{state:'available',mappingId:id,generation:m.generation,...fields},etag:projectionEtag};
}
export async function createSnapshot(p:SubscriptionTransactionPorts,actor:SubscriptionActor,input:unknown):Promise<SnapshotDescriptor> {
  const b=object(input,['mappingId','expectedProjectionEtag','sourceType','sourceId','digestMode','editionLimit'],[]);let ref:SourceRef;let mapping:Mapping|null=null;let mode:Mapping['digestMode'];let limit:number|null;
  if(Object.hasOwn(b,'mappingId')) {object(b,['mappingId','expectedProjectionEtag']);const x=await mappingAndSource(p,actor,uuid(b.mappingId));mapping=x.mapping;ref=x.source;if(mapping.status!=='active'||x.source.status!=='active')fail('resource_not_found');mode=mapping.digestMode;limit=mapping.editionLimit;}
  else {object(b,['sourceType','sourceId','digestMode','editionLimit']);ref=sourceRef({sourceType:b.sourceType,sourceId:b.sourceId});mode=b.digestMode as Mapping['digestMode'];limit=b.editionLimit as number|null;mappingConfig(ref.sourceType,{digestMode:mode,editionLimit:limit});if(!await p.sources.get(actor,ref))fail('resource_not_found');}
  const projection=await p.sources.project(actor,ref,mode,limit);if(!projection)return fail('resource_not_found');
  const fields=describeProjection(projection,mapping);if(mapping&&b.expectedProjectionEtag!==fields.projectionEtag)fail('precondition_failed');
  const descriptor:SnapshotDescriptor={snapshotId:revision(),source:{sourceType:ref.sourceType,sourceId:ref.sourceId},mappingId:mapping?.mappingId??null,generation:mapping?.generation??null,digestMode:mode,editionLimit:limit,projectionVersion:'1',...fields,skippedByReason:projection.skippedByReason,editions:projection.editions,expiresAt:new Date((await p.now()).getTime()+900000).toISOString(),maxPageSize:200};
  await p.store.saveSnapshot(actor.accountId,descriptor,{...projection,...(mapping?{mappingRevision:mapping.revision}:{})});return descriptor;
}
export function projectionRefs(projection:SourceProjection):SourceNodeRef[] {
  return projection.nodes.filter(n=>n.role==='content').map(n=>{const a=JSON.parse(n.key) as string[];return a[0]==='collection'?{sourceCollectionId:a[1]!,nodeId:a[2]!,editionId:null}:{sourceCollectionId:a[3]!,nodeId:a[4]!,editionId:a[2]!};});
}
export async function authorizeSnapshot(p:SubscriptionTransactionPorts,actor:SubscriptionActor,id:string) {
  const stored=await p.store.getSnapshot(actor.accountId,id);if(!stored)return fail('resource_not_found');const d=stored.descriptor;
  if(d.mappingId){const {mapping,source}=await mappingAndSource(p,actor,d.mappingId);if(mapping.status!=='active'||source.status!=='active'||mapping.generation!==d.generation)fail('resource_not_found');if(mapping.revision!==stored.projection.mappingRevision)fail('snapshot_expired');}
  else if(!await p.sources.get(actor,d.source))fail('resource_not_found');
  const refs=projectionRefs(stored.projection);
  // This internal query is bounded by the saved 20k snapshot. Grouping by
  // collection lets the actor port authorize all identities in one bounded SQL
  // set; the external node-access endpoint retains its independent 128 budget.
  const check=await p.sources.check(actor,d.source,d.editions.map(e=>e.editionId),refs);
  if(!check.available||check.removeEditionIds.length||check.removeNodes.length)fail('resource_not_found');
  return stored;
}
export async function snapshotNodes(p:SubscriptionTransactionPorts,actor:SubscriptionActor,id:string,cursor:string|undefined,codec:ReturnType<typeof createSubscriptionCursorCodec>):Promise<NodePage> {
  const stored=await authorizeSnapshot(p,actor,id);const d=stored.descriptor;if(new Date(d.expiresAt)<=await p.now())fail('snapshot_expired');
  const scope='snapshot:'+id;const token=cursor?codec.decode(cursor,actor.accountId,scope,(await p.now()).getTime()):null;
  if(token&&token.filter.policyRevision!==d.policyRevision)fail('invalid_cursor');const start=token?Number(token.after):0;if(!Number.isInteger(start)||start<0||start>=stored.projection.nodes.length)fail('invalid_cursor');
  const page:NodePage={snapshotId:id,projectionRevision:d.projectionRevision,items:[],nextCursor:null,complete:false};
  const nodes=stored.projection.nodes;
  for(let i=start;i<Math.min(start+200,nodes.length);i++) {
    const last=i+1===nodes.length;const next=last?null:codec.encode({accountId:actor.accountId,scope,filter:{policyRevision:d.policyRevision},after:String(i+1),expiresAt:new Date(d.expiresAt).getTime()});
    const candidate={...page,items:[...page.items,nodes[i]!],nextCursor:next,complete:last};if(Buffer.byteLength(JSON.stringify(candidate))>262144){if(!page.items.length)fail('payload_too_large');break;}Object.assign(page,candidate);
  }
  return page;
}

/** Receipt descriptors outlive their bounded node cache. Reauthorization never renews TTL. */
export async function authorizeSnapshotReceipt(p:SubscriptionTransactionPorts,actor:SubscriptionActor,d:SnapshotDescriptor):Promise<void> {
  const stored=await p.store.getSnapshot(actor.accountId,d.snapshotId);
  if(stored){await authorizeSnapshot(p,actor,d.snapshotId);return;}
  if(d.mappingId){const {mapping,source}=await mappingAndSource(p,actor,d.mappingId);if(mapping.status!=='active'||source.status!=='active'||mapping.generation!==d.generation)fail('resource_not_found');}
  else if(!await p.sources.get(actor,d.source))fail('resource_not_found');
  const check=await p.sources.check(actor,d.source,d.editions.map(e=>e.editionId));
  if(!check.available||check.removeEditionIds.length)fail('resource_not_found');
}
