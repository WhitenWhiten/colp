import { t } from '../i18n.js';
import type { ExitBatch, ExitPreview, Mapping } from './contracts.js';
import type { SubscriptionCommand } from './commands.js';
import type { AccountScope, LocalMapping, CompletedCopy, CopyCandidate } from './local-types.js';
import type { MaintenanceContext } from './maintenance.js';
import { subscriptionStore as db } from './store.js';
import { maintenance, subscriptionNative as native, localMapping, refreshMapping, markFailure, wakeSubscriptions } from './runtime.js';
import { withMapping } from './coordination.js';
import { digest } from './projection.js';
import { fingerprint } from './native.js';

type LocalNode = {id:string;title:string;url?:string;parentId?:string;index?:number};
interface RecoveryIntent {
  token:string;scope:AccountScope;mappingId:string;generation:string;epoch:number;used:boolean;expiresAt:number;
  action:'restore'|'copy_detach';parentNativeId?:string;index?:number;tree:LocalNode[];treeDigest:string;
  exitPreview?:ExitPreview;exitCommandId:string;copyTaskId:string;result?:unknown;
}
function sameScope(a:AccountScope,b:AccountScope){return a.serverOrigin===b.serverOrigin&&a.accountId===b.accountId&&a.profileId===b.profileId&&a.authorityGeneration===b.authorityGeneration;}
export async function nativePath(id:string):Promise<string[]>{const path:string[]=[];const seen=new Set<string>();let next:string|undefined=id;while(next){if(seen.has(next)||seen.size>256)throw new Error('native_identity_uncertain');seen.add(next);const node=await native.read(next);if(!node)throw new Error('target_missing');if(node.title)path.unshift(node.title);next=node.parentId;}return path;}
async function localTree(row:LocalMapping):Promise<LocalNode[]>{
  const evidence=(await db.all('nodes')).filter(n=>n.mappingId===row.id&&!n.copyTaskId);const result:LocalNode[]=[];const seen=new Set<string>();
  const roots=[...(row.rootNativeId?[row.rootNativeId]:[]),...evidence.map(n=>n.nativeId)];
  for(const id of roots){if(seen.has(id))continue;const root=await native.read(id);if(!root)continue;const stack=[root];while(stack.length){const n=stack.pop()!;if(seen.has(n.id))continue;seen.add(n.id);if(result.length>=20000)throw new Error('local_copy_too_large');result.push({id:n.id,title:n.title,...(n.url?{url:n.url}:{}),parentId:n.parentId,index:n.index});if(!n.url)stack.push(...(await native.children(n.id)).reverse());}}
  return result;
}
async function ensureCopy(ctx:MaintenanceContext,row:LocalMapping,intent:RecoveryIntent){
  const completed=(await db.get('meta','copy-receipt:'+intent.copyTaskId))?.value as CompletedCopy|undefined;
  if(completed){
    if(digest(await localTree(row))!==intent.treeDigest)throw new Error('preview_changed');
    if(!await verifyCopy(completed))throw new Error('local_copy_changed');
    return {rootNativeId:completed.rootNativeId,count:completed.count};
  }
  if(!intent.tree.length)return undefined;
  // This transaction reserves the whole copy, including its wrapper, before any native write.
  await db.reserveCopy(row.id,intent.copyTaskId,row.applyEpoch,intent.tree.length+1);
  const parentId=await native.preservation(row);const wrapper=await native.createLocal(row,'copy:'+intent.copyTaskId+':root',{parentId,title:row.localAlias+' · 本地副本'},{taskId:intent.copyTaskId});
  const owned=(await db.all('nodes')).filter(n=>n.mappingId===row.id&&!n.copyTaskId);const byId=new Map(owned.map(n=>[n.nativeId,n]));const targets=new Map<string,string>();
  for(let offset=0;offset<intent.tree.length;offset+=32){
    const batch=intent.tree.slice(offset,offset+32);
    const sourceNodes=batch.flatMap(node=>{const source=byId.get(node.id);return source&&!source.personalCopy?[source.node]:[];});
    // Recheck this copy batch now; only the final full scan can authorize conversion.
    if(!await maintenance.accessWhileLocked(ctx,row,undefined,false,sourceNodes))throw new Error('source_unavailable');
    for(const node of batch){
      await ctx.assertCurrent();await native.assertToken(row,true);const current=await native.read(node.id);
      if(!current||fingerprint(current)!==fingerprint(node)||current.parentId!==node.parentId)throw new Error('preview_changed');
      const parent=node.parentId?targets.get(node.parentId):undefined;
      const copy=await native.createLocal(row,'copy:'+intent.copyTaskId+':'+node.id,{parentId:parent??wrapper.id,title:node.title,...(node.url?{url:node.url}:{})},{taskId:intent.copyTaskId,source:byId.get(node.id)});
      targets.set(node.id,copy.id);
    }
  }
  if(!await maintenance.accessWhileLocked(ctx,row))throw new Error('source_unavailable');
  if(digest(await localTree(row))!==intent.treeDigest)throw new Error('preview_changed');
  const scan=(await db.get('meta','scan:'+row.id))?.value as {scanId?:string}|undefined;if(!scan?.scanId)throw new Error('keep_proof_incomplete');
  const copies=(await db.all('nodes')).filter(n=>n.copyTaskId===intent.copyTaskId);
  for(const copy of copies){const current=await native.read(copy.nativeId);if(!current||fingerprint(current)!==copy.fingerprint||current.parentId!==copy.parentNativeId)throw new Error('local_copy_changed');}
  await ctx.assertCurrent();await db.completeCopy(row.id,intent.copyTaskId,row.applyEpoch,scan.scanId,intent.tree.length+1,wrapper.id,{scope:ctx.scope,treeDigest:intent.treeDigest});
  return {rootNativeId:wrapper.id,count:intent.tree.length+1};
}
async function verifyCopy(receipt:CompletedCopy):Promise<boolean>{
  if(!receipt.nodes||receipt.nodes.length!==receipt.count||!receipt.nodes.some(n=>n.nativeId===receipt.rootNativeId))return false;
  for(const node of receipt.nodes){
    const current=await native.read(node.nativeId);
    if(!current||fingerprint(current)!==node.fingerprint||current.parentId!==node.parentNativeId)return false;
  }
  return true;
}
async function reusableCopy(ctx:MaintenanceContext,row:LocalMapping,treeDigest:string){
  const candidate=(await db.get('meta','copy-candidate:'+row.id))?.value as CopyCandidate|undefined;
  if(!candidate||!sameScope(candidate.scope,ctx.scope)||candidate.generation!==row.mapping.generation||candidate.treeDigest!==treeDigest)return;
  const receipt=(await db.get('meta','copy-receipt:'+candidate.taskId))?.value as CompletedCopy|undefined;
  if(receipt&&await verifyCopy(receipt))return {taskId:candidate.taskId,receipt};
}
async function restore(ctx:MaintenanceContext,row:LocalMapping,intent:RecoveryIntent){
  const mapping=(await ctx.client.request<Mapping>('/me/bookmark-subscription-mappings/'+row.id)).data;
  if(mapping.status!=='active'||mapping.generation!==row.mapping.generation)throw new Error('generation_mismatch');
  if(!row.rootNativeId||!await native.read(row.rootNativeId)){if(!intent.parentNativeId)throw new Error('recovery_target_required');await native.writableParent(intent.parentNativeId);}
  const nodes=(await db.all('nodes')).filter(n=>n.mappingId===row.id&&!n.copyTaskId);
  for (const owned of nodes) {
    const current = await native.read(owned.nativeId);
    if (!current) {
      await db.remove('nodes', owned.id);
      continue;
    }
    // The verified copy preserves these edits. Placement changes only location:
    // its receipt must retain the observed content until source refresh replaces it.
    const restored = {
      ...owned,
      fingerprint: fingerprint(current),
      node: { ...owned.node, title: current.title, url: current.url },
    };
    if (restored.fingerprint !== owned.fingerprint || restored.fingerprint !== fingerprint(owned.node)) {
      await db.put('nodes', restored);
    }
    if (restored.node.role !== 'root' && current.parentId !== restored.parentNativeId
      && restored.parentNativeId && await native.read(restored.parentNativeId)) {
      await native.restorePlacement(row, restored, restored.parentNativeId, restored.index);
    }
  }
  const root=(await db.all('nodes')).find(n=>n.mappingId===row.id&&!n.copyTaskId&&n.node.role==='root');
  let mountIndex=intent.parentNativeId?intent.index:row.mountIndex;
  if(root&&intent.parentNativeId){await native.writableParent(intent.parentNativeId);mountIndex=await native.updateRoot(row,root,row.localAlias,intent.parentNativeId,intent.index);}
  return db.changeMapping(row.id,m=>({...m,mapping,enabled:true,applyEpoch:m.applyEpoch+1,rootNativeId:root?.nativeId,mountParentNativeId:intent.parentNativeId??m.mountParentNativeId,mountIndex,projectionEtag:undefined,staged:undefined,state:'initializing',error:undefined}));
}
export async function recoveryCommand(ctx:MaintenanceContext,c:SubscriptionCommand,requestId:string):Promise<{handled:boolean;data?:unknown}>{
  if(c.kind==='recoveryPreview'){
    if(!c.expectedGeneration)throw new Error('generation_required');const row=await localMapping(ctx,c.mappingId,c.expectedGeneration);if(row.cleanup||row.state==='detached'||row.state==='terminating')throw new Error('cleanup_pending');
    if(c.parentNativeId)await native.writableParent(c.parentNativeId);
    const tree=await localTree(row);const root=row.rootNativeId?await native.read(row.rootNativeId):undefined;
    if(c.action==='restore'&&!root&&!c.parentNativeId)throw new Error('recovery_target_required');if(c.action==='copy_detach'&&!tree.length)throw new Error('target_missing');
    const treeDigest=digest(tree);
    const reusable=c.action==='copy_detach'?await reusableCopy(ctx,row,treeDigest):undefined;
    const exitPreview=c.action==='copy_detach'?(await ctx.client.request<ExitPreview>('/me/bookmark-subscription-exit-previews',{method:'POST',commandId:requestId,body:{trigger:'unsubscribe',target:{kind:'mapping',mappingId:row.id}}})).data:undefined;
    const token=crypto.randomUUID(),expiresAt=Date.now()+300000;const intent:RecoveryIntent={token,scope:ctx.scope,mappingId:row.id,generation:row.mapping.generation,epoch:row.applyEpoch,used:false,expiresAt,action:c.action,parentNativeId:c.parentNativeId,index:c.index,tree,treeDigest,exitPreview,exitCommandId:crypto.randomUUID(),copyTaskId:reusable?.taskId??crypto.randomUUID()};
    await db.put('meta',{id:'recovery:'+token,value:intent});const configured=(await db.get('meta','preservation:'+JSON.stringify([ctx.scope.serverOrigin,ctx.scope.accountId])))?.value;
    const defaults=(await db.get('meta','directories:'+JSON.stringify([ctx.scope.serverOrigin,ctx.scope.accountId,ctx.scope.profileId])))?.value as {preservationParentNativeId?:string}|undefined;
    const preservationPath=reusable?await nativePath(reusable.receipt.rootNativeId):typeof configured==='string'?await nativePath(configured):[...await nativePath(defaults?.preservationParentNativeId??row.mountParentNativeId),t('subscription_backupFolderName','Know-N backup')];
    return {handled:true,data:{token,expiresAt,action:c.action,copyCount:tree.length,copyReused:Boolean(reusable),preservationPath,exitPreview,targetRequired:!root}};
  }
  if(c.kind!=='recoveryConfirm')return {handled:false};
  let intent=(await db.get('meta','recovery:'+c.token))?.value as RecoveryIntent|undefined;
  if(!intent||!sameScope(intent.scope,ctx.scope))throw new Error('preview_invalid');if(intent.result)return {handled:true,data:intent.result};if(!intent.used&&intent.expiresAt<=Date.now())throw new Error('preview_expired');
  const key='recovery:'+c.token;const result=await withMapping(intent.mappingId,async()=>{
    intent=(await db.get('meta',key))?.value as RecoveryIntent;if(intent.result)return intent.result;
    let row=await localMapping(ctx,intent.mappingId,intent.generation);if(!intent.used&&digest(await localTree(row))!==intent.treeDigest)throw new Error('preview_changed');
    intent=await db.beginIntent<RecoveryIntent>(key);row=await localMapping(ctx,intent.mappingId,intent.generation);if(row.applyEpoch!==intent.epoch)throw new Error('apply_epoch_changed');
    await native.recover(row);if(!await maintenance.accessWhileLocked(ctx,row))throw new Error('source_unavailable');const copy=await ensureCopy(ctx,row,intent);
    let data:unknown;
    if(intent.action==='restore'){row=await restore(ctx,row,intent);data={local:row,copy};}
    else {if(!copy||!intent.exitPreview)throw new Error('local_copy_incomplete');const exitBatch=(await ctx.client.request<ExitBatch>('/me/bookmark-subscription-exits',{method:'POST',commandId:intent.exitCommandId,body:{previewId:intent.exitPreview.previewId}})).data;data={local:await localMapping(ctx,row.id),copy,exitBatch};}
    await ctx.assertCurrent();await db.put('meta',{id:key,value:{...intent,result:data}});return data;
  });
  const local=await localMapping(ctx,intent.mappingId);if(intent.action==='restore'){try{await refreshMapping(ctx,local);}catch(error){await markFailure(local,error);}}else void wakeSubscriptions('management');
  return {handled:true,data:{...(result as object),local:await localMapping(ctx,intent.mappingId)}};
}
