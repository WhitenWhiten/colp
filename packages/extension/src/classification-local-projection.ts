import type {ClassificationFolderInput,ClassificationTagUsage} from './generated/classification/classification-policy.js';
import {buildClassificationTaxonomy} from './generated/classification/classification-candidates.js';
import type {CompleteRemoteSnapshot} from './bootstrap/remote-snapshot.js';
import type {SyncScope,createSyncStateStore} from './sync-state-store.js';
import {scopeKey} from './sync-state/scope-key.js';
import {LOCAL_CLASSIFICATION_PROJECTION} from './classification-local-session.js';
export interface LocalClassificationProjection {
  readonly scopeKey:string;readonly authorityGeneration:number;readonly pulledAt:number;readonly cursor:string;
  readonly collectionId:string;readonly title:string;readonly summary:string|null;readonly contentRevision:string;
  readonly folders:readonly ClassificationFolderInput[];readonly tagUsage:readonly ClassificationTagUsage[];
}
export function classificationProjectionFromSnapshot(snapshot:CompleteRemoteSnapshot,scope:SyncScope,authorityGeneration:number,cursor:string,now:number):LocalClassificationProjection{
  const projection=snapshot.classificationProjection;
  if(!projection||projection.collection.id!==scope.collectionId||projection.nodes.length>10000
    ||new TextEncoder().encode(JSON.stringify(projection)).length>4*1024*1024)throw new Error('local_projection_incomplete');
  const folders:ClassificationFolderInput[]=[],tags=new Map<string,number>();
  for(const node of projection.nodes){
    if(node.kind==='folder')folders.push({id:node.id,parentId:node.parentId===projection.collection.rootNodeId?null:node.parentId,title:node.title??'',description:node.description??null});
    if(node.kind==='bookmark')for(const tag of node.tags??[])tags.set(tag,(tags.get(tag)??0)+1);
    if(!['root','folder','bookmark','separator'].includes(node.kind))throw new Error('local_projection_incomplete');
  }
  buildClassificationTaxonomy(folders);
  return {scopeKey:scopeKey(scope),authorityGeneration,pulledAt:now,cursor,collectionId:scope.collectionId,title:projection.collection.title,
    summary:projection.collection.summary??null,contentRevision:snapshot.revision,folders,tagUsage:[...tags].map(([tag,count])=>({tag,count}))};
}
export async function localProjectionIsQuiet(store:ReturnType<typeof createSyncStateStore>,scope:SyncScope){
  const engine=await store.getEngineState(scope);
  if(!engine||engine.recoveryFrozen||engine.authorityRefreshRequired||engine.lastError||!['sleeping','idle'].includes(engine.phase)
    ||!engine.lastAckedCursor||engine.lastAckedCursor!==engine.lastPublishedCursor)return false;
  if((await store.listBookmarkEventsByStatus(scope,'pending',0,1)).length||(await store.listProjectionIntents(scope)).some(intent=>intent.state!=='terminal'))return false;
  for(const status of ['pending','claimed','deferred','gap','blocked','unknown','rejected','set_aside'] as const)if((await store.listQueue(scope,status,0,1)).length)return false;
  if((await store.listImportPlans(scope)).some(plan=>plan.state!=='complete'))return false;
  return true;
}
export async function readLocalClassificationProjection(store:ReturnType<typeof createSyncStateStore>,scope:SyncScope,authorityGeneration:number,now=Date.now()){
  const projection=(await chrome.storage.session.get(LOCAL_CLASSIFICATION_PROJECTION))[LOCAL_CLASSIFICATION_PROJECTION] as LocalClassificationProjection|undefined;
  if(!projection||projection.scopeKey!==scopeKey(scope)||projection.authorityGeneration!==authorityGeneration||projection.collectionId!==scope.collectionId
    ||!Number.isFinite(projection.pulledAt)||now<projection.pulledAt||!await localProjectionIsQuiet(store,scope))throw new Error('local_projection_unavailable');
  const engine=await store.getEngineState(scope);
  if(engine?.lastAckedCursor!==projection.cursor)throw new Error('local_projection_unavailable');
  return projection;
}
