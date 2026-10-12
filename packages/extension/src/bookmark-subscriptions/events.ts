import type { BookmarkCaptureEvent } from '../bookmark-listener-lifecycle.js';
import { subscriptionStore as db } from './store.js';
import { isSubscriptionExcluded } from './guards.js';
import { subscriptionNative as native } from './runtime.js';
import { fingerprint } from './native.js';
import { withMapping } from './coordination.js';
import type { Diagnostic,LocalMapping,OwnedNode } from './local-types.js';
interface EventRepair {id:string;mappingId:string;generation:string;epoch:number;nativeId:string;owned?:OwnedNode;oldParentId?:string;oldIndex?:number;intrusionMappingId?:string;priorEnabled:boolean;priorState:LocalMapping['state'];complete?:boolean}
let lane:Promise<unknown>=Promise.resolve();
export function subscriptionEvent(event:BookmarkCaptureEvent):Promise<boolean>{const task=lane.then(()=>handleEvent(event));lane=task.catch(()=>undefined);return task;}
async function containingMapping(parentId:string|undefined,mappings:LocalMapping[]){
  const live=new Map(mappings.filter(m=>m.state!=='detached').map(m=>[m.id,m]));
  const roots=new Map([...live.values()].filter(m=>m.rootNativeId).map(m=>[m.rootNativeId!,m]));
  const seen=new Set<string>();
  while(parentId){
    if(seen.has(parentId)||seen.size>=256)throw new Error('native_identity_uncertain');
    seen.add(parentId);
    const root=roots.get(parentId);if(root)return root;
    const owner=await db.nodeForNative(parentId);
    const mapping=owner&&live.get(owner.mappingId);if(mapping)return mapping;
    parentId=(await native.read(parentId))?.parentId;
  }
}
async function handleEvent(event:BookmarkCaptureEvent):Promise<boolean>{
  await db.ready();const operations=await db.operationsForNative(event.nativeId);
  const current=await native.read(event.nativeId);
  const own=operations.find(o=>!o.eventConsumed&&((event.kind==='removed'&&o.kind==='remove')||(event.kind==='changed'&&o.node&&current&&fingerprint(current)===fingerprint(o.node))||(event.kind==='moved'&&o.kind==='move'&&current&&current.parentId===(o.resultParentNativeId??o.parentNativeId)&&((o.resultIndex??o.targetIndex)===undefined||current.index===(o.resultIndex??o.targetIndex)))||(event.kind==='created'&&o.kind==='create')));
  if(own){await db.changeOperation(own.id,{eventConsumed:true});return true;}
  if(event.kind==='created'&&(await db.pendingOperations()).some(o=>o.kind==='create'&&o.phase!=='received'&&o.parentNativeId===current?.parentId))return true;
  const owned=await db.nodeForNative(event.nativeId);const mappings=await db.all('mappings');let row=mappings.find(m=>m.id===owned?.mappingId&&m.state!=='detached');
  if(event.kind==='created'&&owned){const receipt=(await db.operationsForNative(event.nativeId)).find(o=>o.kind==='create');if(receipt){await db.changeOperation(receipt.id,{eventConsumed:true});return true;}}
  if(!row&&current)row=await containingMapping(current.parentId,mappings);
  if(!row)return isSubscriptionExcluded(event.nativeId);
  if(row.cleanup||row.state==='terminating')return true;
  if(owned?.node.role==='root'&&!owned.copyTaskId&&current){
    if(event.kind==='changed'){await db.changeMapping(row.id,m=>({...m,localAlias:current.title,applyEpoch:m.applyEpoch+1}));await db.put('nodes',{...owned,node:{...owned.node,title:current.title},fingerprint:fingerprint(current)});return true;}
    if(event.kind==='moved'&&current.parentId){try{await native.writableParent(current.parentId);await db.changeMapping(row.id,m=>({...m,mountParentNativeId:current.parentId!,mountIndex:current.index,applyEpoch:m.applyEpoch+1}));await db.put('nodes',{...owned,parentNativeId:current.parentId,index:current.index??0,node:{...owned.node,index:current.index??0}});return true;}catch{/* The persisted previous placement is the only repair target. */}}
  }
  // A source child moved out (or rearranged inside its own mapping) is a local
  // edit. Keep its native placement and ownership until explicit user recovery.
  // Entry into a different readonly mapping remains an intrusion to correct.
  const destination=event.kind==='moved'&&current&&owned?await containingMapping(current.parentId,mappings):undefined;
  const foreignMapping=destination&&destination.id!==row.id;
  const correctMove=event.kind==='moved'&&(!owned||owned.node.role==='root'||foreignMapping);
  const reason=event.kind==='removed'&&owned?.node.role==='root'?'mount_target_missing':event.kind==='created'?'readonly_native_created':correctMove?'readonly_native_moved_in':'readonly_content_changed';
  const diagnostic:Diagnostic={id:crypto.randomUUID(),scope:row.scope,mappingId:row.id,reasonCode:reason,resolution:'pending',nativeId:event.nativeId,operation:event.kind,origin:'native_unknown',time:Date.now(),count:1};await db.put('diagnostics',diagnostic);
  const paused=await db.changeMapping(row.id,m=>({...m,enabled:false,applyEpoch:m.applyEpoch+1,state:reason==='mount_target_missing'?'target_missing':'local_change'}));
  if(current&&(correctMove||!owned&&event.kind==='created')){
    const task:EventRepair={id:diagnostic.id,mappingId:row.id,generation:row.mapping.generation,epoch:paused.applyEpoch,nativeId:event.nativeId,owned,intrusionMappingId:foreignMapping?destination!.id:undefined,priorEnabled:row.enabled,priorState:row.state,...(event.kind==='moved'?{oldParentId:event.move.oldParentId,oldIndex:event.move.oldIndex}:{})};
    await db.put('meta',{id:'native-recovery:'+task.id,value:task});await runRepair(task);
  }
  return true;
}
async function runRepair(task:EventRepair){return withMapping(task.mappingId,async()=>{
  const row=await db.get('mappings',task.mappingId);if(!row||row.mapping.generation!==task.generation||row.cleanup||row.state==='detached')return;
  const diagnostic=await db.get('diagnostics',task.id);if(!diagnostic||task.complete)return;
  if(row.applyEpoch!==task.epoch){await db.put('meta',{id:'native-recovery:'+task.id,value:{...task,complete:true}});return;}
  try{
    const current=await native.read(task.nativeId);if(!current)throw new Error('target_missing');
    if(task.owned&&task.owned.node.role!=='root'){
      const destination=await containingMapping(current.parentId,await db.all('mappings'));
      const correctedIntrusion=task.intrusionMappingId&&current.parentId===task.owned.parentNativeId&&current.index===task.owned.index&&fingerprint(current)===task.owned.fingerprint;
      if((!destination||destination.id===row.id)&&!correctedIntrusion){
        // Older workers queued automatic repairs for ordinary move-out events.
        // Retire that task, but retain the unresolved diagnostic and ownership.
        await db.put('diagnostics',{...diagnostic,reasonCode:'readonly_content_changed',resolution:'pending'});
        await db.put('meta',{id:'native-recovery:'+task.id,value:{...task,complete:true}});
        await db.changeMapping(row.id,m=>m.applyEpoch===task.epoch?{...m,enabled:false,state:'local_change',error:undefined}:m);
        return;
      }
    }
    await native.recover(row);let resolution:Diagnostic['resolution'];
    if(task.owned){const parentId=task.owned.parentNativeId;if(!parentId)throw new Error('recovery_target_invalid');if(task.owned.node.role==='root')await native.writableParent(parentId);else if(!(await db.all('nodes')).some(n=>n.nativeId===parentId&&n.mappingId===row.id))throw new Error('recovery_target_invalid');if(current.parentId!==parentId||current.index!==task.owned.index)await native.restorePlacement(row,task.owned,parentId,task.owned.index);resolution='restored';}
    else {
      let previousUsable=false;if(task.oldParentId){try{await native.writableParent(task.oldParentId);previousUsable=true;}catch(error){if(!(error instanceof Error&&error.message==='recovery_target_invalid'))throw error;}}
      if(previousUsable){await native.restorePersonal(row,task.nativeId,task.oldParentId!,task.oldIndex??0);resolution='restored';}
      else {await native.preserve(row,task.nativeId,true);resolution='preserved';}
    }
    await db.put('diagnostics',{...diagnostic,reasonCode:task.owned?.node.role==='root'?'mount_nested_invalid':diagnostic.reasonCode,resolution,...(resolution==='preserved'?{preservedNativeId:task.nativeId}:{})});await db.put('meta',{id:'native-recovery:'+task.id,value:{...task,complete:true}});
    await db.changeMapping(row.id,m=>m.applyEpoch===task.epoch?{...m,enabled:task.priorEnabled,state:task.priorState,error:undefined}:m);
  }catch(error){await db.changeMapping(row.id,m=>({...m,state:'repair_pending',error:error instanceof Error?error.message:'recovery_failed'}));}
});}
export async function repairSubscriptionEvents(mappingId?:string){for(const item of await db.all('meta')){if(!item.id.startsWith('native-recovery:'))continue;const task=item.value as EventRepair;if(!task.complete&&(!mappingId||mappingId===task.mappingId))await runRepair(task);}}
