import { hasBookmarkPermission } from '../sw/runtime.js';
import { isSupportedBookmarkRoot, isUnsupportedBookmarkFolder, assertBookmarkFolderAllowed } from '../bookmark-folder-policy.js';
import { recoveryCommand, nativePath } from './recovery.js';
import { subscriptionLane, withMapping } from './coordination.js';
import { localSettings } from './settings.js';
import type { Mapping, MappingPage, Subscription, SubscriptionPage, SubscriptionCapabilities, SourceView, SourcePage, ExitPreview, ExitBatch } from './contracts.js';
import type { AccountScope, Draft, LocalMapping } from './local-types.js';
import type { MountInput, SubscriptionRequest } from './commands.js';
import { validateCommand, validMode, validSettings } from './commands.js';
import { subscriptionStore as db } from './store.js';
import { subscriptionContext, localDirectoryContext, localMapping, maintenance, subscriptionNative, wakeSubscriptions, refreshMapping, markFailure, scheduleSubscriptionAlarm } from './runtime.js';
import { downloadSnapshot, digest } from './projection.js';
import { assertPersonalNativeAllowed, isSubscriptionExcluded } from './guards.js';
import { query } from './product-client.js';
import { loadLocalViews, pendingExitSummaries } from './local-views.js';
import type { MaintenanceContext } from './maintenance.js';
import { t } from '../i18n.js';
interface ExitIntent {scope:AccountScope;preview:ExitPreview;commandId:string;used:boolean;result?:ExitBatch}
interface Preview {kind:'mount'|'relocate';token:string;expiresAt:number;scope:AccountScope;input?:MountInput;mappingId:string;parentNativeId:string;index?:number;used:boolean;subscriptionCommandId:string;mappingCommandId:string;generation?:string;epoch:number;result?:unknown;priorEnabled?:boolean;priorState?:LocalMapping['state'];targetVersion?:string}
function owner(scope:AccountScope){return JSON.stringify([scope.serverOrigin,scope.accountId,scope.profileId]);}
async function target(id:string,index?:number){await assertPersonalNativeAllowed(id);await assertBookmarkFolderAllowed(id);const [node]=await chrome.bookmarks.get(id);if(!node||node.url||node.unmodifiable||!node.parentId)throw new Error('mount_target_invalid');const siblings=await chrome.bookmarks.getChildren(id);if(index!==undefined&&index>siblings.length)throw new Error('mount_target_changed');return node;}
async function preview(ctx:MaintenanceContext,token:string,kind:Preview['kind']):Promise<Preview>{const row=await db.get('meta','preview:'+token);const value=row?.value as Preview|undefined;if(!value||value.kind!==kind||owner(value.scope)!==owner(ctx.scope)||value.scope.authorityGeneration!==ctx.scope.authorityGeneration)throw new Error('preview_invalid');if(!value.used&&value.expiresAt<=Date.now())throw new Error('preview_expired');return value;}
export async function handleSubscriptionRequest(request:SubscriptionRequest):Promise<unknown>{
  if(!validateCommand(request))throw new Error('request_invalid');const c=request.command;if(['folders','mountPreview','mountConfirm','rename','relocatePreview','relocateConfirm','resume','refresh','repair','recoveryPreview','recoveryConfirm','directoryPreview','directoryConfirm','locate','diagnosticLocate'].includes(c.kind)&&!await hasBookmarkPermission())throw new Error('permission_required');if(['folders','directoryDefaults','directoryPreview','directoryConfirm'].includes(c.kind)){const local=await localDirectoryContext();await local.assertCurrent();if(c.kind==='folders')return folderChoices(local,c.parentId);const settings=await localSettings(local,c);if(settings.handled)return settings.data;}const ctx=await subscriptionContext();await ctx.assertCurrent();
  const recovery=await recoveryCommand(ctx,c,request.requestId);if(recovery.handled)return recovery.data;
  const settings=await localSettings(ctx,c);if(settings.handled)return settings.data;
  if(c.kind==='draft'){const draft=(await db.get('meta','external-draft'))?.value as Draft|undefined;return draft&&draft.expiresAt>Date.now()&&draft.serverOrigin===ctx.scope.serverOrigin?draft:null;}
  if(c.kind==='list'){
    void wakeSubscriptions('management');
    const [mappings,subscriptions,capabilities]=await Promise.all([
      ctx.client.request<MappingPage>('/me/bookmark-subscription-mappings'+query(c.cursor?{cursor:c.cursor}:{profileId:c.scope==='all_browsers'?undefined:ctx.scope.profileId,status:c.status??'live',limit:50,q:c.q,sourceType:c.sourceType})),
      ctx.client.request<SubscriptionPage>('/me/bookmark-subscriptions?limit=50'),ctx.client.request<SubscriptionCapabilities>('/me/bookmark-subscription-capabilities')]);
    const local=(await db.all('mappings')).filter(m=>maintenance.belongs(m,ctx.scope));
    const localById=new Map(local.map(row=>[row.id,row]));
    const pageRows=mappings.data.items.flatMap(mapping=>{
      const row=localById.get(mapping.mappingId);
      return row?[row]:[];
    });
    // Outbox entries survive a successful server ACK whose response was lost.
    // Return them independently of the server cursor and its live mapping limit.
    const includePending=!c.cursor&&c.scope!=='all_browsers'&&(c.status??'live')==='live';
    const acks=includePending?await db.all('acks'):undefined;
    const views=await loadLocalViews(db,pageRows,nativePath,acks);
    const pendingDraft=(await db.get('meta','external-draft'))?.value as Draft|undefined;
    await ctx.assertCurrent();
    return {
      profileId:ctx.scope.profileId,
      mappings:{...mappings.data,items:mappings.data.items.map(mapping=>({...mapping,local:views.get(mapping.mappingId)??null}))},
      pendingExits:acks?pendingExitSummaries(acks,local,ctx.scope):[],
      subscriptions:subscriptions.data,capabilities:capabilities.data,
      pendingDraft:pendingDraft&&pendingDraft.expiresAt>Date.now()&&pendingDraft.serverOrigin===ctx.scope.serverOrigin?pendingDraft:null,
    };
  }
  if(c.kind==='subscriptions')return (await ctx.client.request<SubscriptionPage>('/me/bookmark-subscriptions'+query(c.cursor?{cursor:c.cursor}:{limit:50}))).data;
  if(c.kind==='sources')return (await ctx.client.request<SourcePage>('/me/bookmark-subscription-sources'+query(c.cursor?{cursor:c.cursor}:{sourceType:c.sourceType,relation:c.relation,q:c.q}))).data;
  if(c.kind==='source')return (await ctx.client.request<SourceView>('/me/bookmark-subscription-sources/'+c.sourceType+'/'+encodeURIComponent(c.sourceId))).data;
  if(c.kind==='sourcePreview')return downloadSnapshot(ctx.client,{sourceType:c.sourceType,sourceId:c.sourceId,digestMode:c.digestMode,editionLimit:c.editionLimit},request.requestId);
  if(c.kind==='mountPreview'){
    if(typeof navigator==='undefined'||!navigator.locks)throw new Error('native_boundary_unavailable');
    const {kind:_kind,...input}=c;await target(input.parentNativeId,input.index);
    const capabilities=(await ctx.client.request<SubscriptionCapabilities>('/me/bookmark-subscription-capabilities')).data;if(capabilities.protocolVersion!==1||!capabilities.contentEnabled)throw new Error('content_disabled');
    const snapshot=await downloadSnapshot(ctx.client,{sourceType:input.sourceType,sourceId:input.sourceId,digestMode:input.digestMode,editionLimit:input.editionLimit},request.requestId);
    const token=crypto.randomUUID(),expiresAt=Date.now()+300000;await db.put('meta',{id:'preview:'+token,value:{kind:'mount',token,expiresAt,scope:ctx.scope,input,mappingId:crypto.randomUUID(),parentNativeId:input.parentNativeId,index:input.index,used:false,epoch:0,targetVersion:await targetVersion(input.parentNativeId),subscriptionCommandId:crypto.randomUUID(),mappingCommandId:crypto.randomUUID()} satisfies Preview});return {token,expiresAt,...snapshot,input};
  }
  if(c.kind==='mountConfirm')return subscriptionLane('mount:'+c.token,async()=>{
    const intent=await preview(ctx,c.token,'mount');const input=intent.input!;if(!intent.used&&intent.targetVersion!==await targetVersion(intent.parentNativeId))throw new Error('preview_changed');await target(intent.parentNativeId,intent.index);await ctx.assertCurrent();
    if(!intent.used)await db.put('meta',{id:'preview:'+intent.token,value:{...intent,used:true}});
    let row=await db.get('mappings',intent.mappingId);
    if(!row){
      const sub=await ctx.client.request<Subscription>('/me/bookmark-subscriptions',{method:'POST',commandId:intent.subscriptionCommandId,body:{sourceType:input.sourceType,sourceId:input.sourceId}});if(!sub.etag)throw new Error('response_invalid');
      const mapping=(await ctx.client.request<Mapping>('/me/bookmark-subscriptions/'+encodeURIComponent(sub.data.subscriptionId)+'/mappings',{method:'POST',commandId:intent.mappingCommandId,ifMatch:sub.etag,body:{mappingId:intent.mappingId,profileId:ctx.scope.profileId,profileLabel:input.profileLabel,mode:'readonly',digestMode:input.digestMode,editionLimit:input.editionLimit,checkIntervalMinutes:input.checkIntervalMinutes,exitPolicy:input.exitPolicy}})).data;
      await ctx.assertCurrent();row={id:mapping.mappingId,mapping,source:{sourceType:input.sourceType,sourceId:input.sourceId},scope:ctx.scope,enabled:true,applyEpoch:1,mountParentNativeId:input.parentNativeId,mountIndex:input.index,localAlias:input.localAlias,state:'initializing',reserved:0,nextCheckAt:0,nextMaintenanceAt:0};await db.put('mappings',row);
    }
    if(input.parentDraft){const folder=await subscriptionNative.createLocal(row,'mount-parent:'+intent.token,{parentId:input.parentNativeId,title:input.parentDraft.title});row=await db.changeMapping(row.id,m=>({...m,mountParentNativeId:folder.id}));}
    try{await refreshMapping(ctx,row);}catch(error){await markFailure(row,error);}await scheduleSubscriptionAlarm();return {mapping:row.mapping,local:await localMapping(ctx,row.id).then(localView)};
  });
  if(c.kind==='diagnostics'||c.kind==='diagnosticsExport'){
    const rows=(await db.all('diagnostics')).filter(d=>d.scope.accountId===ctx.scope.accountId&&d.scope.serverOrigin===ctx.scope.serverOrigin&& (c.kind!=='diagnostics'||(!c.mappingId||d.mappingId===c.mappingId)&&(!c.resolution||d.resolution===c.resolution)));
    return c.kind==='diagnosticsExport'?rows.map(({scope:_scope,nativeId:_native,preservedNativeId:_preserved,nativePath:_path,...safe})=>safe):Promise.all(rows.sort((a,b)=>b.time-a.time).map(async d=>({...d,nativePath:d.nativeId?await nativePath(d.nativeId).catch(()=>[]):[]})));
  }
  if(c.kind==='diagnosticLocate'){const event=await db.get('diagnostics',c.eventId);if(!event||event.scope.accountId!==ctx.scope.accountId||event.scope.serverOrigin!==ctx.scope.serverOrigin||event.scope.profileId!==ctx.scope.profileId)throw new Error('diagnostic_missing');const id=event.preservedNativeId??event.nativeId;if(!id||!await subscriptionNative.read(id))throw new Error('target_missing');await ctx.assertCurrent();await chrome.tabs.create({url:'chrome://bookmarks/?id='+encodeURIComponent(id)});return {located:true};}
  if(c.kind==='diagnosticsClear'){for(const id of c.eventIds){const d=await db.get('diagnostics',id);if(d&&d.scope.accountId===ctx.scope.accountId&&d.scope.serverOrigin===ctx.scope.serverOrigin&&d.resolution!=='pending')await db.remove('diagnostics',id);}return {cleared:true};}
  if(c.kind==='exitConfirm')return subscriptionLane('exit:'+c.previewId,async()=>{
    const key='exit-preview:'+c.previewId;const intent=(await db.get('meta',key))?.value as ExitIntent|undefined;
    if(!intent||owner(intent.scope)!==owner(ctx.scope)||intent.scope.authorityGeneration!==ctx.scope.authorityGeneration)throw new Error('preview_invalid');
    if(intent.result)return intent.result;if(!intent.used&&Date.parse(intent.preview.expiresAt)<=Date.now())throw new Error('preview_expired');
    await ctx.assertCurrent();await db.fenceExit(ctx.scope,intent.preview.targets,c.previewId,false);await db.put('meta',{id:key,value:{...intent,used:true}});
    const batch=(await ctx.client.request<ExitBatch>('/me/bookmark-subscription-exits',{method:'POST',commandId:intent.commandId,body:{previewId:c.previewId}})).data;
    await ctx.assertCurrent();await db.put('meta',{id:key,value:{...intent,used:true,result:batch}});void wakeSubscriptions('management');return batch;
  });
  if(c.kind==='relocateConfirm'){
    let initial=await preview(ctx,c.token,'relocate');if(!initial.used){await target(initial.parentNativeId,initial.index);if(initial.targetVersion!==await targetVersion(initial.parentNativeId))throw new Error('preview_changed');initial=await db.beginIntent<Preview>('preview:'+initial.token);}return withMapping(initial.mappingId,async()=>{
      let intent=await preview(ctx,c.token,'relocate');if(intent.result)return intent.result;
      let row=await localMapping(ctx,intent.mappingId,intent.generation);await target(intent.parentNativeId,intent.index);
      if(!intent.used&&intent.targetVersion!==await targetVersion(intent.parentNativeId))throw new Error('preview_changed');
      intent=await db.beginIntent<Preview>('preview:'+intent.token);row=await localMapping(ctx,row.id);if(row.applyEpoch!==intent.epoch)throw new Error('apply_epoch_changed');
      await subscriptionNative.recover(row);const root=(await db.all('nodes')).find(n=>n.mappingId===row.id&&!n.copyTaskId&&n.nativeId===row.rootNativeId);if(!root||!await subscriptionNative.read(root.nativeId))throw new Error('target_missing');
      const mountIndex=await subscriptionNative.updateRoot(row,root,root.node.title,intent.parentNativeId,intent.index);await ctx.assertCurrent();
      const result=await db.changeMapping(row.id,m=>{if(m.applyEpoch!==intent.epoch)throw new Error('apply_epoch_changed');return {...m,mountParentNativeId:intent.parentNativeId,mountIndex,enabled:intent.priorEnabled??false,state:intent.priorState??'paused'};});
      await db.put('meta',{id:'preview:'+intent.token,value:{...intent,result}});return result;
    });
  }
  if('mappingId' in c&&c.mappingId){
    if(c.kind==='mapping'){const mapping=await ctx.client.request<Mapping>('/me/bookmark-subscription-mappings/'+c.mappingId);const sub=(await ctx.client.request<Subscription>('/me/bookmark-subscriptions/'+encodeURIComponent(mapping.data.subscriptionId))).data;return {mapping:mapping.data,etag:mapping.etag,local:await localMapping(ctx,c.mappingId).then(localView).catch(()=>null),sourceRef:{sourceType:sub.sourceType,sourceId:sub.sourceId}};}
    if(c.kind==='exitPreview'){const remote=(await ctx.client.request<Mapping>('/me/bookmark-subscription-mappings/'+c.mappingId)).data;if(!c.expectedGeneration||remote.generation!==c.expectedGeneration)throw new Error('generation_mismatch');const result=(await ctx.client.request<ExitPreview>('/me/bookmark-subscription-exit-previews',{method:'POST',commandId:request.requestId,body:{trigger:'unsubscribe',target:c.scope==='subscription'?{kind:'subscription',subscriptionId:remote.subscriptionId}:{kind:'mapping',mappingId:c.mappingId}}})).data;await db.put('meta',{id:'exit-preview:'+result.previewId,value:{scope:ctx.scope,preview:result,commandId:crypto.randomUUID(),used:false} satisfies ExitIntent});return result;}
    if(!c.expectedGeneration)throw new Error('generation_required');
    let row=await localMapping(ctx,c.mappingId,c.expectedGeneration);
    if(c.kind==='pause')return db.changeMapping(row.id,m=>({...m,enabled:false,applyEpoch:m.applyEpoch+1,state:'paused'}));
    if(c.kind==='resume'){
      await maintenance.cleanup();await maintenance.actions(ctx);row=await localMapping(ctx,row.id);if(row.cleanup||row.state==='detached'||row.state==='terminating')throw new Error('cleanup_pending');
      if(row.state==='target_missing'||row.rootNativeId&&!await subscriptionNative.read(row.rootNativeId))throw new Error('recovery_target_required');if(row.state==='local_change')throw new Error('recovery_preview_required');await target(row.mountParentNativeId,row.mountIndex);const mapping=(await ctx.client.request<Mapping>('/me/bookmark-subscription-mappings/'+row.id)).data;if(mapping.status!=='active'||mapping.generation!==row.mapping.generation)throw new Error('generation_mismatch');row=await db.changeMapping(row.id,m=>({...m,mapping,scope:ctx.scope,enabled:true,applyEpoch:m.applyEpoch+1,state:'initializing',error:undefined,projectionEtag:m.rootNativeId?m.projectionEtag:undefined}));
      try{await refreshMapping(ctx,row);}catch(error){await markFailure(row,error);}await scheduleSubscriptionAlarm();return localMapping(ctx,row.id);
    }
    if(c.kind==='repair'){await (await import('./events.js')).repairSubscriptionEvents(row.id);row=await localMapping(ctx,row.id);await withMapping(row.id,async()=>{await subscriptionNative.recover(row);await subscriptionNative.reconcile(row);});return localMapping(ctx,row.id).then(localView);}
    if(c.kind==='refresh'){try{await refreshMapping(ctx,row);}catch(error){await markFailure(row,error);}return localMapping(ctx,row.id);}
    if(c.kind==='locate'){if(!row.rootNativeId)throw new Error('target_missing');await chrome.bookmarks.get(row.rootNativeId);await chrome.tabs.create({url:'chrome://bookmarks/?id='+encodeURIComponent(row.rootNativeId)});return {located:true};}
    if(c.kind==='rename'){row=await db.changeMapping(row.id,m=>({...m,applyEpoch:m.applyEpoch+1}));return withMapping(row.id,async()=>{await subscriptionNative.assertToken(row,true);const root=row.rootNativeId?await db.nodeForNative(row.rootNativeId):undefined;if(!root||root.mappingId!==row.id)throw new Error('target_missing');await subscriptionNative.updateRoot(row,root,c.localAlias,row.mountParentNativeId,row.mountIndex??root.index);return db.changeMapping(row.id,m=>({...m,localAlias:c.localAlias}));});}
    if(c.kind==='relocatePreview'){await target(c.parentNativeId,c.index);const token=crypto.randomUUID(),expiresAt=Date.now()+300000;await db.put('meta',{id:'preview:'+token,value:{kind:'relocate',token,expiresAt,scope:ctx.scope,mappingId:row.id,generation:row.mapping.generation,parentNativeId:c.parentNativeId,index:c.index,used:false,epoch:row.applyEpoch,priorEnabled:row.enabled,priorState:row.state,targetVersion:await targetVersion(c.parentNativeId),subscriptionCommandId:crypto.randomUUID(),mappingCommandId:crypto.randomUUID()} satisfies Preview});return {token,expiresAt};}
    if(c.kind==='patch'){
      const merged={...row.mapping,...c.patch};if(!validMode(row.source.sourceType,merged.digestMode,merged.editionLimit)||!validSettings(merged))throw new Error('mapping_invalid');await db.changeMapping(row.id,m=>({...m,applyEpoch:m.applyEpoch+1}));const response=await ctx.client.request<Mapping>('/me/bookmark-subscription-mappings/'+row.id,{method:'PATCH',ifMatch:c.ifMatch,commandId:request.requestId,body:c.patch});await ctx.assertCurrent();return {mapping:response.data,etag:response.etag,local:await db.changeMapping(row.id,m=>({...m,mapping:response.data,nextCheckAt:0,staged:undefined,projectionEtag:undefined}))};
    }
  }
  throw new Error('request_invalid');
}

async function targetVersion(id:string){const n=await target(id);return digest([n.id,n.parentId??null,n.title,(await chrome.bookmarks.getChildren(id)).map(c=>c.id)]);}
async function localView(row:LocalMapping){
  return (await loadLocalViews(db,[row],nativePath)).get(row.id)!;
}

async function folderChoices(ctx:Pick<MaintenanceContext,'scope'|'assertCurrent'>,parentId?:string){
  if(parentId&&parentId!=='0'&&await isUnsupportedBookmarkFolder(parentId))throw new Error('bookmark_folder_unavailable');
  if(parentId&&await isSubscriptionExcluded(parentId))throw new Error('readonly_write_blocked');
  const [nodes,mappings,owned]=await Promise.all([chrome.bookmarks.getChildren(parentId??'0'),db.all('mappings'),db.all('nodes')]);const choices=[];
  for(const n of nodes.filter(n=>!n.url&&((parentId??'0')!=='0'||isSupportedBookmarkRoot(n)))){const excluded=await isSubscriptionExcluded(n.id);const mapping=mappings.find(m=>m.id===owned.find(o=>o.nativeId===n.id)?.mappingId||m.rootNativeId===n.id);const hidden=mapping&&(mapping.scope.accountId!==ctx.scope.accountId||mapping.scope.serverOrigin!==ctx.scope.serverOrigin);choices.push({...n,title:hidden?t('subscription_unavailableFolder', 'Subscription (unavailable)'):n.title,children:undefined,disabled:Boolean(n.unmodifiable)||excluded,reason:n.unmodifiable?'managed':excluded?'readonly_subscription':undefined});}
  await ctx.assertCurrent();return {nodes:choices,preservationParentId:null};
}
