import { t } from '../i18n.js';
import { isUnsupportedBookmarkFolder } from '../bookmark-folder-policy.js';
import { classifyBookmarkApiFailure } from '../bookmark-api-error.js';
import { withSubscriptionCreate } from './barrier.js';
import type { ProjectionNode } from './contracts.js';
import type { LocalMapping, NativeOperation, OwnedNode } from './local-types.js';
import { SETTLED_OPERATION_MAX, type SubscriptionStore } from './store.js';
import { digest, nodeRef } from './projection.js';
import { isPreservationCreate, preservationKey } from './preservation-journal.js';
import { moveDestination } from './native-placement.js';
export interface NativeApi { get(id:string):Promise<chrome.bookmarks.BookmarkTreeNode[]>;getChildren(id:string):Promise<chrome.bookmarks.BookmarkTreeNode[]>; create(input:Parameters<typeof chrome.bookmarks.create>[0]):Promise<chrome.bookmarks.BookmarkTreeNode>;update(id:string,input:Parameters<typeof chrome.bookmarks.update>[1]):Promise<chrome.bookmarks.BookmarkTreeNode>;move(id:string,input:Parameters<typeof chrome.bookmarks.move>[1]):Promise<chrome.bookmarks.BookmarkTreeNode>;remove(id:string):Promise<void> }
export const fingerprint=(n:{title:string;url?:string})=>digest({title:n.title,url:n.url??null});
export const NATIVE_BATCH_SIZE = 128;
export function createNativeExecutor(db:SubscriptionStore,api:NativeApi){
  let settledSincePrune = 0;
  async function read(id:string){try{const nodes=await api.get(id);if(nodes.length!==1)throw new Error('native_identity_uncertain');return nodes[0]!;}catch(error){if(classifyBookmarkApiFailure(error)==='not_found')return undefined;throw error;}}
  async function assertToken(row:LocalMapping,cleanup=false){const current=await db.get('tokens',row.id);if(!current||current.generation!==row.mapping.generation||current.applyEpoch!==row.applyEpoch||(!cleanup&&(!current.enabled||current.cleanup)))throw new Error('apply_epoch_changed');}
  async function execute<T extends chrome.bookmarks.BookmarkTreeNode|void>(row:LocalMapping,op:NativeOperation,call:()=>Promise<T>,cleanup=false){
    await assertToken(row,cleanup);await db.put('operations',op);await assertToken(row,cleanup);await db.changeOperation(op.id,{phase:'issued'});
    let result:T;
    try { result=await call(); } catch(error) {
      // Chrome rejects an invalid move index before mutation. Retire only this
      // explicit rejection; a lost reply must remain uncertain during recovery.
      if(op.kind==='move'&&error instanceof Error&&/^Index out of bounds\.?$/.test(error.message)) {
        await db.changeOperation(op.id,{phase:'received',settled:true,eventConsumed:true,observedOutcome:'not_applied'});
      }
      throw error;
    }
    const received=await db.changeOperation(op.id,{phase:'received',resultId:result?.id??op.nativeId,resultParentNativeId:result?.parentId,resultIndex:result?.index});
    // A late native receipt must commit its ownership effect before epoch rejection.
    await settleReceived(row, received);
    await assertToken(row,cleanup);return result;
  }
  async function settleReceived(row: LocalMapping, op: NativeOperation) {
    if (op.settled) return;
    const token = await db.get('tokens', row.id);
    if (!token || token.generation !== op.generation) throw new Error('generation_mismatch');
    if (isPreservationCreate(op)) {
      await db.settlePreservation(op.id);
      return;
    }
    if (op.kind === 'remove' && op.nativeId) {
      const node = await db.nodeForNative(op.nativeId);
      if (node?.mappingId === row.id && node.generation === op.generation) {
        await db.remove('nodes', node.id);
      }
    } else if (op.node && op.resultId) {
      // Existing rows can contain the pre-update/pre-move evidence. Reapply the
      // recorded result, including a root pointer interrupted after its node write.
      // Do not infer success from the current native title or position.
      await own(row, {...op.node,index:op.resultIndex??op.node.index}, op.resultId, op.resultParentNativeId??op.parentNativeId, op);
    }
    await db.changeOperation(op.id, { settled: true });
    // Pruning reads the whole journal, so once per settle made a large copy quadratic.
    // Every SETTLED_OPERATION_MAX settles keeps it bounded; maintenance cleanup prunes too.
    if (++settledSincePrune >= SETTLED_OPERATION_MAX) { settledSincePrune = 0; await db.pruneSettledOperations(); }
  }
  async function own(row:LocalMapping,node:ProjectionNode,nativeId:string,parentNativeId?:string,op?:Pick<NativeOperation,'ownershipKey'|'copyTaskId'|'personalCopy'>){const key=op?.ownershipKey??node.key;const record:OwnedNode={id:JSON.stringify([row.id,row.mapping.generation,key]),mappingId:row.id,generation:row.mapping.generation,key,nativeId,parentNativeId,index:node.index,fingerprint:fingerprint(node),node,ref:op?.personalCopy?undefined:nodeRef(node,row.source),copyTaskId:op?.copyTaskId,personalCopy:op?.personalCopy};await db.put('nodes',record);if(node.role==='root'&&!op?.copyTaskId)await db.changeMapping(row.id,m=>m.mapping.generation===row.mapping.generation?{...m,rootNativeId:nativeId}:m);}
  const operation=(row:LocalMapping,kind:NativeOperation['kind'],rest:Partial<NativeOperation>):NativeOperation=>({id:crypto.randomUUID(),mappingId:row.id,generation:row.mapping.generation,applyEpoch:row.applyEpoch,kind,phase:'prepared',createdAt:Date.now(),...rest});
  async function move(row:LocalMapping,current:chrome.bookmarks.BookmarkTreeNode,parentId:string,index:number,node?:ProjectionNode,cleanup=false,purpose?:NativeOperation['purpose']){
    const destination=moveDestination(current,parentId,index);
    const result=await execute(row,operation(row,'move',{nativeId:current.id,node,parentNativeId:parentId,targetIndex:index,purpose}),()=>api.move(current.id,destination),cleanup);
    if(!result)throw new Error('native_identity_uncertain');
    return result;
  }
  async function create(row:LocalMapping,node:ProjectionNode,parentId:string){return withSubscriptionCreate(async()=>{
    const pending=(await db.pendingOperations()).find(o=>o.mappingId===row.id&&o.kind==='create'&&o.node?.key===node.key&&o.phase!=='received');
    if(pending)throw new Error('recovery_identity_uncertain');
    if(node.role==='root')await writableParent(parentId);const target=await read(parentId);if(!target||target.url||target.unmodifiable)throw new Error('recovery_target_invalid');
    const parent=node.parentKey===null?undefined:await db.get('nodes',JSON.stringify([row.id,row.mapping.generation,node.parentKey]));const protectedParent=parent?.nativeId===parentId;
    if(node.role!=='root'&&!protectedParent)throw new Error('projection_parent_missing');
    const children=protectedParent?undefined:await api.getChildren(parentId);const count=children?.length??await db.nodeChildrenCount(parentId);const index=Math.min(node.index,count);
    const op=operation(row,'create',{node,parentNativeId:parentId,targetIndex:index,protectedParent,beforeIds:children?.map(c=>c.id)});
    return await execute(row,op,()=>api.create({parentId,index,title:node.title,...(node.url?{url:node.url}:{})}));
  });}
  async function update(row: LocalMapping, owned: OwnedNode, node: ProjectionNode, parentId: string) {
    let current = (await api.get(owned.nativeId))[0];
    if (!current) throw new Error('target_missing');
    if (fingerprint(current) !== owned.fingerprint) throw new Error('readonly_content_changed');
    if (fingerprint(current) !== fingerprint(node)) {
      // update changes content only. Its receipt must not claim a future move,
      // including when the worker stops after this receipt has settled.
      const updated = { ...node, parentKey: owned.node.parentKey, index: current.index ?? owned.index };
      current = await execute(row, operation(row, 'update', {
        nativeId: owned.nativeId, node: updated, parentNativeId: current.parentId,
      }), () => api.update(owned.nativeId, { title: node.title, ...(node.url ? { url: node.url } : {}) }));
    }
    if (current.parentId !== parentId || current.index !== node.index) {
      current = await move(row, current, parentId, node.index, node);
    }
    await own(row, { ...node, index: current.index ?? node.index }, owned.nativeId, current.parentId ?? parentId);
    return owned.nativeId;
  }
  async function recoverPreservation(key: string) {
    for (const op of (await db.pendingOperations()).filter(isPreservationCreate)) {
      if (op.localKey !== undefined && op.localKey !== key) continue;
      const owner = await db.get('mappings', op.mappingId);
      if (!owner || preservationKey(owner.scope) !== key) {
        if (op.localKey === key) throw new Error('recovery_identity_uncertain');
        continue;
      }
      if (owner.mapping.generation !== op.generation) throw new Error('generation_mismatch');
      if (op.phase === 'prepared') { await db.remove('operations', op.id); continue; }
      if (op.phase === 'received') await settleReceived(owner, op);
      else { await quarantineUnknownCreate(owner, op); throw new Error('recovery_identity_uncertain'); }
    }
  }
  async function preservation(row: LocalMapping): Promise<string> {
    return withSubscriptionCreate(async () => {
      await assertToken(row, true);
      const key = preservationKey(row.scope);
      // A directory is shared by this account's mappings. Recover its receipt
      // before another mapping can create a replacement after a worker restart.
      await recoverPreservation(key);
      await assertToken(row, true);
      const saved = await db.get('meta', key);
      if (typeof saved?.value === 'string') {
        const folder = await read(saved.value);
        if (!folder || folder.url || folder.unmodifiable) throw new Error('recovery_target_invalid');
        await writableParent(folder.id);
        return folder.id;
      }
      const defaults = (await db.get('meta', 'directories:' + JSON.stringify([row.scope.serverOrigin, row.scope.accountId, row.scope.profileId])))?.value as { preservationParentNativeId?: string } | undefined;
      const parentId = defaults?.preservationParentNativeId ?? row.mountParentNativeId;
      await writableParent(parentId);
      const op = operation(row, 'create', { purpose: 'preservation', localKey: key, parentNativeId: parentId, beforeIds: (await api.getChildren(parentId)).map(node => node.id) });
      const folder = await execute(row, op, () => api.create({ parentId, title: t('subscription_backupFolderName', 'Know-N backup') }), true);
      if (!folder) throw new Error('native_identity_uncertain');
      return folder.id;
    });
  }
  async function preserve(row:LocalMapping,id:string,cleanup=false){
    await assertToken(row,cleanup);
    const verify=[id];const checked=new Set<string>();
    while(verify.length){const candidate=verify.pop()!;if(checked.has(candidate))throw new Error('native_identity_uncertain');checked.add(candidate);const current=await read(candidate);if(!current)throw new Error('target_missing');const source=await db.nodeForNative(candidate);if(source&&(source.mappingId!==row.id||(!source.personalCopy&&fingerprint(current)===source.fingerprint)))throw new Error('recovery_identity_uncertain');if(!current.url)verify.push(...(await api.getChildren(candidate)).map(n=>n.id));}

    // Exclude before moving, so move callbacks and old upload retries remain isolated.
    await db.put('exclusions',{id,nativeId:id,reason:'preserved',accountId:row.scope.accountId,serverOrigin:row.scope.serverOrigin});
    const parentId=await preservation(row);await execute(row,operation(row,'move',{nativeId:id,parentNativeId:parentId}),()=>api.move(id,{parentId}),cleanup);
    const stack=[id];const ids=new Set<string>();while(stack.length){const next=stack.pop()!;ids.add(next);const node=await read(next);if(node&&!node.url)for(const child of await api.getChildren(next))if(!ids.has(child.id))stack.push(child.id);}
    for(const nativeId of ids){const n=await db.nodeForNative(nativeId);if(n?.mappingId===row.id)await db.remove('nodes',n.id);}
    await db.put('diagnostics',{id:crypto.randomUUID(),scope:row.scope,mappingId:row.id,reasonCode:'readonly_content_changed',resolution:'preserved',preservedNativeId:id,nativeId:id,origin:'recovery',time:Date.now(),count:1});
  }
  async function removeOwned(row:LocalMapping,selected:Set<string>,cleanup=false,beforeBatch?:()=>Promise<void>){
    const nodes=(await db.nodesForMapping(row.id)).filter(n=>n.generation===row.mapping.generation);const byId=new Map(nodes.map(n=>[n.nativeId,n]));
    const depth=(n:OwnedNode)=>{let d=0,p=n.parentNativeId;const seen=new Set<string>();while(p&&byId.has(p)&&!seen.has(p)){seen.add(p);d++;p=byId.get(p)?.parentNativeId;}return d;};
    // Child-first empty-directory remove only. A concurrent child makes remove fail safely.
    const selectedNodes=nodes.filter(n=>selected.has(n.key)||Boolean(n.copyTaskId&&selected.has(n.node.key))).sort((a,b)=>depth(b)-depth(a));
    for(const [index,owned] of selectedNodes.entries()){
      if(index%NATIVE_BATCH_SIZE===0)await beforeBatch?.();
      if(!await db.get('nodes',owned.id))continue;await assertToken(row,cleanup);
      const current=await read(owned.nativeId);if(!current){await db.remove('nodes',owned.id);continue;}
      if(owned.personalCopy||fingerprint(current)!==owned.fingerprint){
        if(!current.url&&(await api.getChildren(current.id)).some(child=>byId.has(child.id)))continue;
        await preserve(row,current.id,cleanup);continue;
      }
      if(!current.url)for(const child of await api.getChildren(current.id)){
        const evidence=byId.get(child.id);if(!evidence)await preserve(row,child.id,cleanup);
      }
      if(!current.url&&(await api.getChildren(current.id)).some(child=>byId.has(child.id)&&!selected.has(byId.get(child.id)!.key)))continue;
      await execute(row,operation(row,'remove',{nativeId:owned.nativeId}),()=>api.remove(owned.nativeId),cleanup);
    }
  }
  async function quarantineUnknownCreate(row: LocalMapping, op: NativeOperation) {
    if (op.kind === 'create' && op.parentNativeId && !op.protectedParent) {
      for (const node of await api.getChildren(op.parentNativeId)) {
        if (!op.beforeIds?.includes(node.id)) await db.put('exclusions', { id: node.id, nativeId: node.id, reason: 'quarantine', accountId: row.scope.accountId, serverOrigin: row.scope.serverOrigin });
      }
    }
  }
  async function recover(row:LocalMapping){
    for(const op of (await db.pendingOperations()).filter(o=>o.mappingId===row.id&&o.generation===row.mapping.generation)){
      if (op.phase === 'received') {
        await settleReceived(row, op);
        continue;
      }
      if(op.phase==='prepared'){await db.remove('operations',op.id);continue;}
      if(op.kind==='remove'&&op.nativeId){
        const current=await read(op.nativeId);const n=await db.nodeForNative(op.nativeId);
        if(!current){if(n?.mappingId===row.id)await db.remove('nodes',n.id);await db.changeOperation(op.id,{phase:'received',settled:true});continue;}
        // Exact identity still exists: retire this failed call, retain ownership,
        // and let a freshly authorized diff/cleanup recheck user content before retry.
        if(n?.mappingId===row.id&&n.generation===row.mapping.generation){await db.changeOperation(op.id,{phase:'received',settled:true,eventConsumed:true,observedOutcome:'not_applied'});continue;}
      }
      if((op.kind==='move'||op.kind==='update')&&op.nativeId){const current=await read(op.nativeId);const matched=current&&(op.kind==='move'?current.parentId===op.parentNativeId&&(op.targetIndex===undefined||current.index===op.targetIndex):op.node&&fingerprint(current)===fingerprint(op.node));if(matched){const received=await db.changeOperation(op.id,{phase:'received',resultId:op.nativeId,resultParentNativeId:current.parentId,resultIndex:current.index});await settleReceived(row,received);continue;}}
      await quarantineUnknownCreate(row, op);
      throw new Error('recovery_identity_uncertain');
    }
  }
  async function restorePlacement(row:LocalMapping,owned:OwnedNode,parentId:string,index:number){
    const current=await read(owned.nativeId);if(!current)throw new Error('target_missing');
    await move(row,current,parentId,index,{...owned.node,index},true);
  }
  async function updateRoot(row:LocalMapping,owned:OwnedNode,title:string,parentId:string,index?:number){
    if(owned.node.role!=='root'||owned.mappingId!==row.id)throw new Error('root_identity_required');let current=await read(owned.nativeId);if(!current)throw new Error('target_missing');
    if(fingerprint(current)!==owned.fingerprint)throw new Error('readonly_content_changed');
    const lastIndex=Math.max(0,(await api.getChildren(parentId)).length-(current.parentId===parentId?1:0));
    const finalIndex=Math.min(index??lastIndex,lastIndex);
    const node={...owned.node,title,index:finalIndex};if(current.title!==title)current=await execute(row,operation(row,'update',{nativeId:owned.nativeId,node,parentNativeId:current.parentId}),()=>api.update(owned.nativeId,{title}),true);
    if(current.parentId!==parentId||current.index!==finalIndex)current=await move(row,current,parentId,finalIndex,node,true);
    const actualIndex=current.index??finalIndex;await own(row,{...node,index:actualIndex},owned.nativeId,current.parentId??parentId);
    return actualIndex;
  }

  async function writableParent(id:string){
    if(await isUnsupportedBookmarkFolder(id,read))throw new Error('recovery_target_invalid');
    const mappings=await db.all('mappings');const roots=new Set(mappings.filter(m=>m.state!=='detached').flatMap(m=>m.rootNativeId?[m.rootNativeId]:[]));const seen=new Set<string>();let next:string|undefined=id;
    while(next){if(roots.has(next)||seen.has(next)||seen.size>256||await db.nodeForNative(next)||(await db.get('exclusions',next))?.reason==='quarantine')throw new Error('recovery_target_invalid');seen.add(next);const value=await read(next);if(!value||value.url||value.unmodifiable)throw new Error('recovery_target_invalid');next=value.parentId;}
  }
  async function restorePersonal(row:LocalMapping,id:string,parentId:string,index:number){
    await writableParent(parentId);await db.put('exclusions',{id,nativeId:id,reason:'quarantine',accountId:row.scope.accountId,serverOrigin:row.scope.serverOrigin});
    const current=await read(id);if(!current)throw new Error('target_missing');
    await move(row,current,parentId,index,undefined,true,'restore-personal');
    await db.remove('exclusions',id);
  }
  async function createLocal(row:LocalMapping,localKey:string,input:{parentId:string;title:string;url?:string;index?:number},copy?:{taskId:string;source?:OwnedNode}){
    return withSubscriptionCreate(async()=>{
      const existing=await db.operationForLocalKey(row.id,localKey);
      if(existing){if(existing.phase==='received'&&existing.resultId){const found=await read(existing.resultId);if(found)return found;throw new Error('target_missing');}throw new Error('recovery_identity_uncertain');}
      await assertToken(row,true);if(!copy)await writableParent(input.parentId);else {const parent=await db.nodeForNative(input.parentId);if(parent){if(parent.mappingId!==row.id||parent.copyTaskId!==copy.taskId)throw new Error('recovery_target_invalid');}else await writableParent(input.parentId);}
      const protectedParent=Boolean(copy&&(await db.nodeForNative(input.parentId))?.copyTaskId===copy.taskId);const before=protectedParent?undefined:await api.getChildren(input.parentId);const childCount=before?.length??await db.nodeChildrenCount(input.parentId);const ownershipKey=JSON.stringify(['copy',copy?.taskId,localKey]);
      const node:ProjectionNode|undefined=copy?{...(copy.source?.node??{key:ownershipKey,parentKey:null,kind:input.url?'bookmark':'folder',role:'content',editionId:null}),title:input.title,...(input.url?{url:input.url}:{}),index:input.index??childCount}:undefined;
      const op=operation(row,'create',{localKey,parentNativeId:input.parentId,protectedParent,beforeIds:before?.map(n=>n.id),targetIndex:input.index,node,...(copy?{ownershipKey,copyTaskId:copy.taskId,personalCopy:!copy.source||fingerprint(input)!==copy.source.fingerprint}:{purpose:'directory'})});
      const result=await execute(row,op,()=>api.create(input),true);if(!result)throw new Error('native_identity_uncertain');return result;
    });
  }
  async function reconcile(row:LocalMapping){
    if(!row.rootNativeId)return;
    const root=await read(row.rootNativeId);if(!root)throw new Error('target_missing');
    const nodes=(await db.all('nodes')).filter(n=>n.mappingId===row.id&&!n.copyTaskId);const owned=new Map(nodes.map(n=>[n.nativeId,n]));const stack=[root];
    while(stack.length){const node=stack.pop()!;const evidence=owned.get(node.id);if(!evidence){await preserve(row,node.id,true);continue;}
      if(fingerprint(node)!==evidence.fingerprint||node.parentId!==evidence.parentNativeId)throw new Error('readonly_content_changed');
      if(!node.url)stack.push(...await api.getChildren(node.id));owned.delete(node.id);
    }
    if(owned.size)throw new Error('readonly_content_changed');
  }
  return {assertToken,create,update,preserve,removeOwned,recover,own,restorePlacement,updateRoot,read,writableParent,restorePersonal,createLocal,reconcile,preservation,children:api.getChildren};
}
export type NativeExecutor=ReturnType<typeof createNativeExecutor>;
