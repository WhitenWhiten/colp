import { withMapping, withContentSlot } from './coordination.js';
import { ownershipDigest } from './store.js';
import type { AccessCheck, NodeAccessCheck, SourceNodeRef, ProjectionCheck, ExitTask, ActionPage, ProjectionNode } from './contracts.js';
import type { AccountScope, LocalMapping } from './local-types.js';
import type { ProductClient } from './product-client.js';
import { query } from './product-client.js';
import { digest, nodeRef, downloadSnapshot, canonical } from './projection.js';
import type { SubscriptionStore } from './store.js';
import { NATIVE_BATCH_SIZE, type NativeExecutor } from './native.js';
export interface MaintenanceContext { scope:AccountScope;client:ProductClient;assertCurrent:()=>Promise<void> }
export function createMaintenance(db:SubscriptionStore,native:NativeExecutor){
  const belongs=(row:LocalMapping,scope:AccountScope)=>row.scope.accountId===scope.accountId&&row.scope.serverOrigin===scope.serverOrigin&&row.scope.profileId===scope.profileId;
  async function held(row:LocalMapping){return [...(await db.all('nodes')).filter(n=>n.mappingId===row.id&&!n.personalCopy).map(n=>n.node),...((row.staged?(await db.get('stages',row.id))?.nodes:undefined)??[]),...(await db.pendingOperations()).filter(o=>o.mappingId===row.id&&o.node&&!o.settled).map(o=>o.node!)];}
  function checkFence(row:LocalMapping,result:AccessCheck|NodeAccessCheck,content:boolean){if(result.mappingId!==row.id||result.generation!==row.mapping.generation||typeof result.authorityRevision!=='string'||!result.authorityRevision||typeof result.mappingRevision!=='string'||typeof result.contentEnabled!=='boolean')throw new Error('access_response_invalid');if(content&&(result.mappingRevision!==row.mapping.revision||!result.contentEnabled))throw new Error('configuration_changed');}
  async function access(ctx:MaintenanceContext,row:LocalMapping,actionId?:string,content=false,onlyNodes?:ProjectionNode[]):Promise<boolean>{
    await ctx.assertCurrent();const nodes=onlyNodes??await held(row);const editions=[...new Set(nodes.flatMap(n=>n.editionId?[n.editionId]:[]))];const removedEditions=new Set<string>();
    for(let offset=0;offset<Math.max(1,editions.length);offset+=20){
      const batch=editions.slice(offset,offset+20);const result=(await ctx.client.request<AccessCheck>('/me/bookmark-subscription-mappings/'+row.id+'/access'+query({...(row.source.sourceType==='digest_series'&&batch.length?{editionIds:batch.join(',')}:{}),actionId}))).data;
      checkFence(row,result,content);await ctx.assertCurrent();
      if(result.state==='terminated')throw new Error('exit_pending');
      if(result.state==='unavailable'){if(result.cleanup!=='remove_managed'||result.reason!=='access_lost')throw new Error('access_response_invalid');await revokeAll(row);return false;}
      if(result.state!=='available'||!Array.isArray(result.removeEditionIds)||result.removeEditionIds.some(id=>!batch.includes(id)))throw new Error('access_response_invalid');
      for(const id of result.removeEditionIds)removedEditions.add(id);
    }
    const removeKeys=new Set(nodes.filter(n=>n.editionId&&removedEditions.has(n.editionId)).map(n=>n.key));
    if(removeKeys.size){await native.removeOwned(row,removeKeys,true);await invalidateStage(row.id,removeKeys);}
    const refs=new Map<string,SourceNodeRef>();for(const node of onlyNodes??nodes){if(node.editionId&&removedEditions.has(node.editionId))continue;const ref=nodeRef(node,row.source);if(ref)refs.set(canonical(ref),ref);}
    const list=[...refs.values()];const scanId=crypto.randomUUID();const deniedKeys=new Set<string>();
    await db.put('meta',{id:'scan:'+row.id,value:{scanId,generation:row.mapping.generation,epoch:row.applyEpoch,complete:false,identities:list,processed:0}});
    for(let offset=0;offset<list.length;){
      const batch:SourceNodeRef[]=[];while(offset+batch.length<list.length&&batch.length<128){const candidate=[...batch,list[offset+batch.length]!];if(new TextEncoder().encode(JSON.stringify({generation:row.mapping.generation,actionId,nodes:candidate})).length>65536)break;batch.push(list[offset+batch.length]!);}
      if(!batch.length)throw new Error('payload_too_large');
      const result=(await ctx.client.request<NodeAccessCheck>('/me/bookmark-subscription-mappings/'+row.id+'/node-access-checks',{method:'POST',body:{generation:row.mapping.generation,...(actionId?{actionId}:{}),nodes:batch},nodeAccess:true})).data;
      checkFence(row,result,content);await ctx.assertCurrent();if(result.state==='terminated')throw new Error('exit_pending');
      if(result.state==='unavailable'){if(result.cleanup!=='remove_managed'||result.reason!=='access_lost')throw new Error('access_response_invalid');await revokeAll(row);return false;}
      const requested=new Set(batch.map(canonical));if(result.state!=='available'||result.requestDigest!==digest(batch)||!Array.isArray(result.removeNodes)||result.removeNodes.some(ref=>!requested.has(canonical(ref))))throw new Error('access_response_invalid');
      const denied=new Set(result.removeNodes.map(canonical));const keys=new Set(nodes.filter(n=>{const ref=nodeRef(n,row.source);return ref&&denied.has(canonical(ref));}).map(n=>n.key));
      if(keys.size){for(const key of keys)deniedKeys.add(key);await native.removeOwned(row,keys,true);await invalidateStage(row.id,keys);}
      offset+=batch.length;await db.put('meta',{id:'scan:'+row.id,value:{scanId,generation:row.mapping.generation,epoch:row.applyEpoch,complete:false,identities:list,processed:offset}});
    }
    if(deniedKeys.size)await native.removeOwned(row,deniedKeys,true);
    if(content&&(removeKeys.size||(await db.get('mappings',row.id))?.staged===undefined&&row.staged))throw new Error('projection_access_changed');
    await ctx.assertCurrent();
    const current=await db.get('mappings',row.id);if(!current||current.applyEpoch!==row.applyEpoch)throw new Error('apply_epoch_changed');
    if(onlyNodes)return true;
    const owned=(await db.all('nodes')).filter(n=>n.mappingId===row.id&&n.generation===row.mapping.generation);
    if(!onlyNodes&&owned.some(n=>n.ref&&!refs.has(canonical(n.ref))))throw new Error('keep_proof_incomplete');
    await db.put('meta',{id:'scan:'+row.id,value:{scanId,generation:row.mapping.generation,epoch:row.applyEpoch,complete:true,full:!onlyNodes,identities:list,processed:list.length,ownershipDigest:ownershipDigest(owned)}});
    return true;
  }
  async function invalidateStage(id:string,keys:Set<string>){const stage=await db.get('stages',id);if(stage?.nodes.some(n=>keys.has(n.key)))await db.changeMapping(id,m=>({...m,staged:undefined}));}
  async function revokeAll(row:LocalMapping){const current=await db.changeMapping(row.id,m=>({...m,applyEpoch:m.applyEpoch+1,enabled:false,state:'access_lost',staged:undefined}));await native.removeOwned(current,new Set((await db.all('nodes')).filter(n=>n.mappingId===row.id).map(n=>n.key)),true);if((await db.all('nodes')).some(n=>n.mappingId===row.id))throw new Error('cleanup_incomplete');await db.changeMapping(row.id,m=>({...m,rootNativeId:undefined,reserved:0,copyReservations:undefined}));}
  async function content(ctx:MaintenanceContext,row:LocalMapping){
    await ctx.assertCurrent();await native.recover(row);
    await native.assertToken(row,true);if(!row.enabled||row.cleanup||row.state==='paused'||row.state==='local_change')return;await native.reconcile(row);
    const path='/me/bookmark-subscription-mappings/'+row.id+'/projection';
    const check=await ctx.client.request<ProjectionCheck>(path,{ifNoneMatch:row.projectionEtag});
    if(check.status===304){if(!row.rootNativeId)throw new Error('target_missing');if(!await native.read(row.rootNativeId))throw new Error('target_missing');await db.changeMapping(row.id,m=>({...m,lastCheckedAt:Date.now()}));return;}
    if(check.data.state==='terminated')throw new Error('exit_pending');if(check.data.state==='unavailable'){await access(ctx,row);return;}
    if(!check.etag||check.data.mappingId!==row.id||check.data.generation!==row.mapping.generation)throw new Error('projection_response_invalid');
    const snapshot=await downloadSnapshot(ctx.client,{mappingId:row.id,expectedProjectionEtag:check.etag},crypto.randomUUID());
    if(snapshot.descriptor.mappingId!==row.id||snapshot.descriptor.generation!==row.mapping.generation||canonical(snapshot.descriptor.source)!==canonical(row.source))throw new Error('snapshot_identity_invalid');
    await db.reserve(row.id,snapshot.nodes.length);
    const recheck=await ctx.client.request<ProjectionCheck>(path,{ifNoneMatch:snapshot.descriptor.projectionEtag});
    if(recheck.status!==304&&(recheck.data.state!=='available'||recheck.etag!==snapshot.descriptor.projectionEtag))throw new Error('projection_changed');
    await native.assertToken(row);row=await db.stage(row,snapshot);
    if(!await access(ctx,row,undefined,true))return;
    const expectedKeys=new Set(snapshot.nodes.map(n=>n.key));
    const obsolete=new Set((await db.all('nodes')).filter(n=>n.mappingId===row.id&&!n.copyTaskId&&!expectedKeys.has(n.key)).map(n=>n.key));
    if(!await moveRetained(ctx,row,snapshot.nodes,obsolete))return;
    await native.removeOwned(row,obsolete,false,async()=>{
      // Removing obsolete content is also a content batch. Authority cleanup
      // uses its separate path and remains available while the content gate is off.
      if(!await authorizeContentBatch(ctx,row,[]))throw new Error('apply_epoch_changed');
    });
    const owned=new Map((await db.all('nodes')).filter(n=>n.mappingId===row.id&&!n.copyTaskId).map(n=>[n.key,n]));
    if(!await applyContentBatches(ctx,row,snapshot.nodes,async sourceNode=>{
        const rootPosition=sourceNode.role==='root'&&owned.has(sourceNode.key)?await native.read(owned.get(sourceNode.key)!.nativeId):undefined;
        // An omitted mount index means append once. Subsequent content updates
        // retain the root's actual local placement, including shifted siblings.
        const node=sourceNode.role==='root'?{...sourceNode,title:row.localAlias,index:rootPosition?.index??row.mountIndex??(await native.children(row.mountParentNativeId)).length}:sourceNode;
        const parentId=node.parentKey===null?row.mountParentNativeId:owned.get(node.parentKey)?.nativeId;if(!parentId)throw new Error('projection_parent_missing');
        const prior=owned.get(node.key);
        if(prior&&prior.node.kind!==node.kind){await native.removeOwned(row,new Set([prior.key]));owned.delete(prior.key);}
        const nativeId=owned.has(node.key)?await native.update(row,owned.get(node.key)!,node,parentId):(await native.create(row,node,parentId))?.id;if(!nativeId)throw new Error('native_identity_uncertain');
        await ctx.assertCurrent();const refreshed=await db.get('nodes',JSON.stringify([row.id,row.mapping.generation,node.key]));if(refreshed)owned.set(node.key,refreshed);
        if(node.role==='root'&&refreshed)row=await db.changeMapping(row.id,m=>{if(m.applyEpoch!==row.applyEpoch)throw new Error('apply_epoch_changed');return {...m,mountIndex:refreshed.index};});
    }))return;
    const applied = (await db.nodesForMapping(row.id)).filter(n => n.generation === row.mapping.generation && !n.copyTaskId);
    if (applied.length !== expectedKeys.size || applied.some(n => !expectedKeys.has(n.key))) {
      throw new Error('projection_incomplete');
    }
    if(!await access(ctx,row,undefined,true))return;await native.assertToken(row);await ctx.assertCurrent();
    const final=await ctx.client.request<ProjectionCheck>(path,{ifNoneMatch:snapshot.descriptor.projectionEtag});if(final.status!==304&&(final.data.state!=='available'||final.etag!==snapshot.descriptor.projectionEtag))throw new Error('projection_changed');
    await db.changeMapping(row.id,m=>{if(m.applyEpoch!==row.applyEpoch||!m.staged)throw new Error('apply_epoch_changed');return {...m,staged:undefined,reserved:snapshot.nodes.length,projectionEtag:snapshot.descriptor.projectionEtag,lastAppliedRevision:snapshot.descriptor.projectionRevision,lastCheckedAt:Date.now(),lastUpdatedAt:Date.now(),state:snapshot.descriptor.counts.bookmarks?'current':'empty',error:undefined};});
  }
  async function flushAcks(ctx:MaintenanceContext){for(const ack of (await db.all('acks')).filter(a=>a.pending&&a.scope.accountId===ctx.scope.accountId&&a.scope.serverOrigin===ctx.scope.serverOrigin)){try{await ctx.client.request('/me/bookmark-subscription-actions/'+ack.id+'/ack',{method:'POST',commandId:ack.commandId,body:{mappingId:ack.mappingId,generation:ack.generation,result:ack.result}});await ctx.assertCurrent();await db.put('acks',{...ack,pending:false});}catch{/* Same immutable outbox stays pending independently of actions pagination. */}}}
  async function action(ctx:MaintenanceContext,task:ExitTask){
    if(task.profileId!==ctx.scope.profileId)throw new Error('profile_mismatch');if(await db.get('acks',task.actionId))return;
    let row=await db.get('mappings',task.mappingId);let result:'kept'|'removed'|'removed_access_lost'|'no_local_mount'='no_local_mount';
    if(row)await native.recover(row);
    const unknown=(await db.pendingOperations()).some(o=>o.mappingId===task.mappingId&&o.generation===task.generation&&o.phase!=='received');
    if(unknown)throw new Error('recovery_identity_uncertain');
    if(row){if(!belongs(row,ctx.scope)||row.mapping.generation!==task.generation)throw new Error('generation_mismatch');row=await db.changeMapping(row.id,m=>({...m,enabled:false,applyEpoch:m.applyEpoch+1,state:'terminating'}));await native.recover(row);
      if((await db.all('nodes')).some(n=>n.mappingId===row!.id)){
        if(task.effectiveAction==='keep'){const allowed=await access(ctx,row,task.actionId);result=allowed?'kept':'removed_access_lost';{const current=await db.get('mappings',row.id);if(!current)throw new Error('mapping_missing');row=current;}}
        else {await native.removeOwned(row,new Set((await db.all('nodes')).filter(n=>n.mappingId===row!.id).map(n=>n.key)),true);result='removed';}
      }
    }
    await ctx.assertCurrent();const final=await db.get('mappings',task.mappingId);if(row&&final?.applyEpoch!==row.applyEpoch)throw new Error('apply_epoch_changed');const scan=(await db.get('meta','scan:'+task.mappingId))?.value as {scanId?:string}|undefined;
    await db.terminal({expectedEpoch:row?.applyEpoch,scanId:scan?.scanId,id:task.actionId,scope:ctx.scope,mappingId:task.mappingId,generation:task.generation,result,commandId:crypto.randomUUID(),pending:true,completedAt:Date.now(),evidence:[result==='removed_access_lost'?'access_unavailable':'native_operations_completed']},result==='kept');
  }
  async function actions(ctx:MaintenanceContext){await flushAcks(ctx);let cursor:string|null=null;const seen=new Set<string>();do{const page:ActionPage=(await ctx.client.request<ActionPage>('/me/bookmark-subscription-actions'+query(cursor?{cursor}:{profileId:ctx.scope.profileId,limit:50}))).data;for(const task of page.items){try{await ctx.assertCurrent();if(task.profileId!==ctx.scope.profileId)throw new Error('profile_mismatch');if(!await db.get('acks',task.actionId))await db.fenceExit(ctx.scope,[task],task.actionId,true);await withMapping(task.mappingId,()=>action(ctx,task));}catch(error){const failed=await db.get('mappings',task.mappingId);if(failed&&belongs(failed,ctx.scope)&&failed.mapping.generation===task.generation)await db.changeMapping(task.mappingId,m=>({...m,state:'repair_pending',error:error instanceof Error?error.message:'action_failed'}));}}cursor=page.nextCursor;if(cursor){if(seen.has(cursor))throw new Error('cursor_cycle');seen.add(cursor);}}while(cursor);await flushAcks(ctx);}
  async function cleanup(){await db.pruneSettledOperations();for(const candidate of (await db.all('mappings')).filter(m=>m.cleanup)){await withMapping(candidate.id,async()=>{let row=(await db.get('mappings',candidate.id))!;if(!row.cleanup)return;try{await native.recover(row);await native.removeOwned(row,new Set((await db.all('nodes')).filter(n=>n.mappingId===row.id).map(n=>n.key)),true);if((await db.all('nodes')).some(n=>n.mappingId===row.id))throw new Error('cleanup_incomplete');row=await db.changeMapping(row.id,m=>({...m,cleanup:false,enabled:false,state:'paused',rootNativeId:undefined,reserved:0,copyReservations:undefined,staged:undefined,error:'local_enable_required'}));}catch(error){await db.changeMapping(row.id,m=>({...m,error:error instanceof Error?error.message:'recovery_failed',state:'repair_pending'}));}});}}
  async function authorizeContentBatch(ctx:MaintenanceContext,row:LocalMapping,nodes:ProjectionNode[]){
    if(!await access(ctx,row,undefined,true,nodes))return false;
    await ctx.assertCurrent();
    await native.assertToken(row);
    return true;
  }
  async function applyContentBatches(ctx:MaintenanceContext,row:LocalMapping,nodes:ProjectionNode[],apply:(node:ProjectionNode)=>Promise<void>){
    for(let offset=0;offset<nodes.length;offset+=NATIVE_BATCH_SIZE){
      const batch=nodes.slice(offset,offset+NATIVE_BATCH_SIZE);
      if(!await authorizeContentBatch(ctx,row,batch))return false;
      for(const node of batch){
        await ctx.assertCurrent();
        await native.assertToken(row);
        await apply(node);
      }
    }
    return true;
  }
  async function moveRetained(ctx:MaintenanceContext,row:LocalMapping,nodes:ProjectionNode[],obsolete:Set<string>){
    const owned=new Map((await db.nodesForMapping(row.id)).filter(n=>!n.copyTaskId).map(n=>[n.key,n]));
    const desired=new Map(nodes.map(n=>[n.key,n]));const required=new Set<string>();
    // Older receipts may contain the desired logical parent before the native
    // move happened. The recorded native parent is the applied structure.
    for (const [key, prior] of owned) {
      if (obsolete.has(key)) continue;
      const next = desired.get(key);
      if (!next?.parentKey || prior.parentNativeId === owned.get(next.parentKey)?.nativeId) continue;
      let parent = next.parentKey;
      while (parent && !owned.has(parent)) {
        required.add(parent);
        parent = desired.get(parent)?.parentKey ?? '';
      }
    }
    if(required.size)await db.reserve(row.id,Math.max(nodes.length,owned.size+required.size));
    if(!await applyContentBatches(ctx,row,nodes.filter(node=>required.has(node.key)),async node=>{
      const parentId=node.parentKey===null?row.mountParentNativeId:owned.get(node.parentKey)?.nativeId;
      if(!parentId||node.kind!=='folder')throw new Error('projection_parent_missing');
      await native.create(row,node,parentId);
      const value=await db.get('nodes',JSON.stringify([row.id,row.mapping.generation,node.key]));
      if(value)owned.set(node.key,value);
    }))return false;
    const moved = nodes.filter(node => {
      const prior = owned.get(node.key);
      return prior && node.parentKey !== null && prior.parentNativeId !== owned.get(node.parentKey)?.nativeId;
    });
    // New siblings do not exist yet, so stage at a valid position and let the
    // final content pass apply snapshot order. Appending (not index 0) keeps
    // retained siblings in snapshot order, so that pass has nothing to redo;
    // staging every node at the top reversed them and doubled the moves.
    // Counts are read once per parent and advanced as appends land.
    const tails=new Map<string,number>();
    return applyContentBatches(ctx,row,moved,async node=>{
      const parent=owned.get(node.parentKey!),self=owned.get(node.key)!;
      if(!parent)throw new Error('projection_parent_missing');
      const tail=tails.get(parent.nativeId)??(await native.children(parent.nativeId)).filter(child=>child.id!==self.nativeId).length;
      const source=(await native.read(self.nativeId))?.parentId;
      await native.update(row,self,{...node,index:tail},parent.nativeId);
      tails.set(parent.nativeId,tail+1);
      // Leaving a parent shrinks it; recount it if something is appended there later.
      if(source&&source!==parent.nativeId)tails.delete(source);
    });
  }
  return {accessWhileLocked:access,access:(ctx:MaintenanceContext,row:LocalMapping,actionId?:string,contentMode=false,onlyNodes?:ProjectionNode[])=>withMapping(row.id,()=>access(ctx,row,actionId,contentMode,onlyNodes)),content:(ctx:MaintenanceContext,row:LocalMapping)=>withMapping(row.id,()=>withContentSlot(()=>content(ctx,row))),actions,cleanup,belongs,flushAcks};
}
