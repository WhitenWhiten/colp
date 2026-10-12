import { mappingBusy, runFairMappings, subscriptionLane, tryWithMapping, whenMappingIdle } from './coordination.js';
import { store as credentials, hasBookmarkPermission } from '../sw/runtime.js';
import { loadConfig } from '../sw/scope.js';
import { subscriptionStore as db } from './store.js';
import { createSubscriptionProductClient, SubscriptionError, UUID } from './product-client.js';
import { createNativeExecutor } from './native.js';
import { createMaintenance, type MaintenanceContext } from './maintenance.js';
import type { AccountScope, LocalMapping } from './local-types.js';
import type { SubscriptionCapabilities, Mapping, ActionPage } from './contracts.js';
export const SUBSCRIPTION_ALARM='known-bookmark-subscriptions';
let profilePromise:Promise<string>|undefined;
export function subscriptionProfile():Promise<string>{return profilePromise??=(async()=>{const saved=await db.get('meta','profile');if(typeof saved?.value==='string'&&UUID.test(saved.value))return saved.value;const binding=await credentials.loadBinding();const id=binding?.browserProfileId&&UUID.test(binding.browserProfileId)?binding.browserProfileId:crypto.randomUUID();await db.put('meta',{id:'profile',value:id});return id;})();}
export async function currentSubscriptionScope():Promise<AccountScope>{
  const [config,credential,authority,profileId]=await Promise.all([loadConfig(),credentials.loadCredential(),credentials.fence.read(),subscriptionProfile()]);
  if(!credential?.subject||credential.serverOrigin!==config.serverOrigin||authority.revoked)throw new SubscriptionError('sign_in_required',401);
  return {serverOrigin:config.serverOrigin,accountId:credential.subject,authorityGeneration:authority.generation,profileId};
}
export async function subscriptionContext():Promise<MaintenanceContext>{
  const scope=await currentSubscriptionScope();const assertCurrent=async()=>{const current=await currentSubscriptionScope();if(JSON.stringify(scope)!==JSON.stringify(current))throw new Error('authority_fenced');};
  return {scope,assertCurrent,client:createSubscriptionProductClient({serverOrigin:scope.serverOrigin,accountId:scope.accountId,assertCurrent})};
}
export const subscriptionNative=createNativeExecutor(db,{get:id=>chrome.bookmarks.get(id),getChildren:id=>chrome.bookmarks.getChildren(id),create:input=>chrome.bookmarks.create(input),update:(id,input)=>chrome.bookmarks.update(id,input),move:(id,input)=>chrome.bookmarks.move(id,input),remove:id=>chrome.bookmarks.remove(id)});
export const maintenance=createMaintenance(db,subscriptionNative);
export async function localMapping(ctx:MaintenanceContext,id:string,generation?:string){const row=await db.get('mappings',id);if(!row||!maintenance.belongs(row,ctx.scope))throw new Error('mapping_missing');if(generation!==undefined&&row.mapping.generation!==generation)throw new Error('generation_mismatch');return row;}
type WakeReason='startup'|'online'|'alarm'|'management';
let task:Promise<void>|undefined;let rerun:WakeReason|undefined;
let housekeeping:Promise<void>|undefined;
const deferredMappings=new Map<string,{done:Promise<void>;reason:WakeReason}>();
interface ContentJob {ctx:MaintenanceContext;row:LocalMapping;running:boolean;rerun?:boolean;done:Promise<void>;resolve:()=>void;reject:(error:unknown)=>void}
const contentJobs=new Map<string,ContentJob>();
let contentActive=0;
const contentKey=(row:LocalMapping)=>JSON.stringify([row.scope,row.id,row.mapping.generation]);
const contentGateKey=(scope:AccountScope)=>'content-gate:'+JSON.stringify([scope.serverOrigin,scope.accountId,scope.profileId]);
function deferMapping(id:string,reason:WakeReason='alarm'){
  const existing=deferredMappings.get(id);if(existing){if(existing.reason==='alarm')existing.reason=reason;return;}
  const pending={done:whenMappingIdle(id),reason};deferredMappings.set(id,pending);
  void pending.done.then(()=>{if(deferredMappings.get(id)!==pending)return;deferredMappings.delete(id);void wakeSubscriptions(pending.reason);});
}
function startHousekeeping(){
  if(housekeeping)return;
  const pending=(async()=>{await maintenance.cleanup();await (await import('./events.js')).repairSubscriptionEvents();})().catch(()=>undefined).finally(()=>{if(housekeeping===pending)housekeeping=undefined;});
  housekeeping=pending;
}
/** Fence busy exits immediately, but leave their native work for the lane's next wake. */
async function availableActions(ctx:MaintenanceContext){
  const client:MaintenanceContext['client']={request:async<T>(path:string,options?:Parameters<MaintenanceContext['client']['request']>[1])=>{
    const response=await ctx.client.request<T>(path,options);
    if(path.startsWith('/me/bookmark-subscription-actions?')){
      await ctx.assertCurrent();const page=response.data as ActionPage;const items=[];
      for(const action of page.items){
        if(action.profileId===ctx.scope.profileId&&mappingBusy(action.mappingId)){
          if(!await db.get('acks',action.actionId))await db.fenceExit(ctx.scope,[action],action.actionId,true);
          deferMapping(action.mappingId);
        }else items.push(action);
      }
      return {...response,data:{...page,items}} as typeof response;
    }
    return response;
  }};
  await maintenance.actions({...ctx,client});
}
/** A wake waits for maintenance rounds only; content owns separate per-generation jobs. */
export function wakeSubscriptions(reason:WakeReason='management'):Promise<void>{
  if(task){rerun=rerun&&rerun!=='alarm'?rerun:reason;return task;}
  const pending=(async()=>{
    let next:WakeReason|undefined=reason;
    do{rerun=undefined;await maintenanceRound(next).catch(()=>undefined);await scheduleSubscriptionAlarm().catch(()=>undefined);next=rerun;}while(next);
  })().finally(()=>{
    if(task===pending)task=undefined;
    // A wake may arrive after the last round settles but before this finalizer.
    if(rerun){const reason=rerun;rerun=undefined;return wakeSubscriptions(reason);}
    drainContent();
  });
  task=pending;return pending;
}
async function maintenanceRound(reason:WakeReason){
  await db.ready();if(!await hasBookmarkPermission())return;startHousekeeping();
  const ctx=await subscriptionContext();await availableActions(ctx).catch(()=>undefined);
  const capabilities=(await ctx.client.request<SubscriptionCapabilities>('/me/bookmark-subscription-capabilities')).data;
  if(capabilities.protocolVersion!==1)throw new Error('protocol_unsupported');await ctx.assertCurrent();await recordContentGate(ctx,capabilities.contentEnabled);
  const rows=(await db.all('mappings')).filter(m=>maintenance.belongs(m,ctx.scope)&&m.state!=='detached'&&!m.cleanup).sort((a,b)=>a.nextMaintenanceAt-b.nextMaintenanceAt||a.id.localeCompare(b.id));
  await runFairMappings(rows,async candidate=>{
    if(reason==='alarm'&&(candidate.mapping.checkIntervalMinutes===null||candidate.nextMaintenanceAt>Date.now()&&(!candidate.enabled||!capabilities.contentEnabled||candidate.nextCheckAt>Date.now()||contentJobs.has(contentKey(candidate)))))return;
    const pending=tryWithMapping(candidate.id,async()=>{
      let row=candidate;
      try{
        await ctx.assertCurrent();row=await localMapping(ctx,row.id,row.mapping.generation);if(row.state==='detached'||row.state==='terminating'||row.cleanup)return;
        row=await refreshRemoteMapping(ctx,row);const allowed=await maintenance.accessWhileLocked(ctx,row);
        const live=await localMapping(ctx,row.id,row.mapping.generation);
        if(allowed)await subscriptionNative.recover(live);
        if(allowed&&live.state!=='local_change'&&live.state!=='target_missing'&&live.state!=='repair_pending')await subscriptionNative.reconcile(live);
        await ctx.assertCurrent();await db.changeMapping(row.id,m=>sameAttempt(m,live)?{...m,nextMaintenanceAt:Date.now()+15*60000,error:m.state==='retrying'?undefined:m.error}:m);
        if(allowed&&live.enabled&&capabilities.contentEnabled&&live.mapping.checkIntervalMinutes!==null&&live.nextCheckAt<=Date.now()){
          enqueueContent(ctx,live);
        }
      }catch(error){await ctx.assertCurrent().then(()=>markFailure(row,error,false)).catch(()=>undefined);}
    });
    if(pending)await pending;else deferMapping(candidate.id,reason);
  });
}
function sameAttempt(current:LocalMapping,expected:LocalMapping){return contentKey(current)===contentKey(expected)&&current.applyEpoch===expected.applyEpoch&&!current.cleanup&&current.state!=='detached'&&current.state!=='terminating';}
function enqueueContent(ctx:MaintenanceContext,row:LocalMapping):ContentJob{
  const key=contentKey(row);const existing=contentJobs.get(key);
  if(existing){
    if(!existing.running){existing.ctx=ctx;existing.row=row;}
    else if(!sameAttempt(row,existing.row))existing.rerun=true;
    return existing;
  }
  let resolve!:()=>void;let reject!:(error:unknown)=>void;
  const done=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void done.catch(()=>undefined);
  const job={ctx,row,running:false,done,resolve,reject};contentJobs.set(key,job);drainContent();return job;
}
function drainContent(){
  if(task)return;
  for(const [key,job] of contentJobs){
    if(contentActive>=2)break;if(job.running)continue;job.running=true;contentActive++;
    const finish=()=>{
      if(contentJobs.get(key)===job)contentJobs.delete(key);contentActive--;
      if(job.rerun)void wakeSubscriptions('alarm');else drainContent();
      void scheduleSubscriptionAlarm().catch(()=>undefined);
    };
    void (async()=>{
      let row=job.row;
      try{
        await job.ctx.assertCurrent();const live=await localMapping(job.ctx,row.id,row.mapping.generation);
        if(!sameAttempt(live,row)||!live.enabled||(await db.get('meta',contentGateKey(job.ctx.scope)))?.value===false)return;
        row=await db.changeMapping(row.id,m=>{if(!sameAttempt(m,live))throw new Error('apply_epoch_changed');return {...m,nextCheckAt:m.mapping.checkIntervalMinutes===null?Number.MAX_SAFE_INTEGER:Date.now()+m.mapping.checkIntervalMinutes*60000+Math.floor(Math.random()*15000)};});
        await maintenance.content(job.ctx,row);
      }catch(error){await job.ctx.assertCurrent().then(()=>markFailure(row,error)).catch(()=>undefined);throw error;}
    })().then(()=>{finish();job.resolve();},error=>{finish();job.reject(error);}).catch(job.reject);
  }
}
export async function refreshMapping(ctx:MaintenanceContext,row:LocalMapping){
  for(;;){
    await ctx.assertCurrent();row=await localMapping(ctx,row.id,row.mapping.generation);
    const pending=contentJobs.get(contentKey(row));
    if(pending&&sameAttempt(row,pending.row)&&JSON.stringify(ctx.scope)===JSON.stringify(pending.ctx.scope))return pending.done;
    if(pending?.running){await pending.done.catch(()=>undefined);continue;}
    await maintenance.actions(ctx);row=await localMapping(ctx,row.id,row.mapping.generation);
    if(row.state==='detached'||row.state==='terminating'||row.cleanup)return;
    row=await refreshRemoteMapping(ctx,row);if(!await maintenance.access(ctx,row))return;
    const live=await localMapping(ctx,row.id,row.mapping.generation);const job=enqueueContent(ctx,live);
    if(sameAttempt(live,job.row)&&JSON.stringify(ctx.scope)===JSON.stringify(job.ctx.scope))return job.done;
    await job.done.catch(()=>undefined);
  }
}
export async function refreshRemoteMapping(ctx:MaintenanceContext,row:LocalMapping){const remote=(await ctx.client.request<Mapping>('/me/bookmark-subscription-mappings/'+row.id)).data;if(remote.generation!==row.mapping.generation)throw new Error('generation_mismatch');if(remote.status!=='active')throw new Error('exit_pending');if(remote.revision===row.mapping.revision)return row;return db.changeMapping(row.id,m=>({...m,mapping:remote,applyEpoch:m.applyEpoch+1,staged:undefined,projectionEtag:undefined,nextCheckAt:0}));}
export async function markFailure(row:LocalMapping,error:unknown,contentAttempt=true){
  const code=error instanceof Error?error.message:'subscription_unavailable';if(['apply_epoch_changed','authority_fenced'].includes(code))return;const states:Record<string,LocalMapping['state']>={capacity_exceeded:'capacity_exceeded',storage_unavailable:'storage_unavailable',sign_in_required:'sign_in_required',target_missing:'target_missing',readonly_content_changed:'local_change',configuration_changed:'retrying',recovery_identity_uncertain:'repair_pending',permission_required:'permission_required'};
  const blocking=['readonly_content_changed','target_missing','recovery_identity_uncertain'].includes(code);
  await db.changeMapping(row.id,m=>sameAttempt(m,row)?({...m,state:states[code]??'retrying',error:code,...(blocking?{enabled:false,applyEpoch:m.applyEpoch+1}:code==='configuration_changed'?{applyEpoch:m.applyEpoch+1,staged:undefined,projectionEtag:undefined}:{}),nextMaintenanceAt:Date.now()+Math.max(60000,error instanceof SubscriptionError?error.retryAfter:0),nextCheckAt:contentAttempt?Date.now()+Math.max(60000,error instanceof SubscriptionError?error.retryAfter:0):m.nextCheckAt}):m);
}
export function scheduleSubscriptionAlarm(){return subscriptionLane('subscription-alarm',async()=>{
  const [mappings,acks,scope]=await Promise.all([db.all('mappings'),db.all('acks'),currentSubscriptionScope().catch(()=>undefined)]);
  const rows=mappings.filter(m=>scope&&maintenance.belongs(m,scope)&&m.state!=='detached'&&m.mapping.checkIntervalMinutes!==null);
  const retry=acks.some(a=>a.pending)||mappings.some(m=>m.cleanup);if(!rows.length&&!retry){await chrome.alarms.clear(SUBSCRIPTION_ALARM);return;}
  const contentEnabled=scope&&(await db.get('meta',contentGateKey(scope)))?.value!==false;
  const deadlines=rows.map(m=>{const busy=mappingBusy(m.id);const contentDue=m.state==='retrying'&&m.error?Math.max(m.nextCheckAt,m.nextMaintenanceAt):m.nextCheckAt;return Math.min(busy?Math.max(m.nextMaintenanceAt,Date.now()+15*60000):m.nextMaintenanceAt,m.enabled&&contentEnabled&&!busy&&!contentJobs.has(contentKey(m))?contentDue:Number.MAX_SAFE_INTEGER);});
  const when=Math.max(Date.now()+30000,Math.min(retry?Date.now()+60000:Number.MAX_SAFE_INTEGER,...deadlines));await chrome.alarms.create(SUBSCRIPTION_ALARM,{when});
});}
export async function prepareSubscriptionLogout(accountId:string,serverOrigin:string){await db.prepareCleanup(accountId,serverOrigin);for(const row of await db.all('meta'))if(row.id.startsWith('preview:')||row.id.startsWith('exit-preview:')||row.id.startsWith('wizard:')||row.id.startsWith('directory-preview:')||row.id.startsWith('external-request:')||row.id.startsWith('recovery:'))await db.remove('meta',row.id);}

export async function localDirectoryContext():Promise<Pick<MaintenanceContext,'scope'|'assertCurrent'>>{
  async function read(){const [config,credential,authority,profileId]=await Promise.all([loadConfig(),credentials.loadCredential(),credentials.fence.read(),subscriptionProfile()]);return {serverOrigin:config.serverOrigin,accountId:!authority.revoked&&credential?.serverOrigin===config.serverOrigin&&credential.subject?credential.subject:'anonymous',authorityGeneration:authority.generation,profileId};}
  const scope=await read();return {scope,assertCurrent:async()=>{if(JSON.stringify(scope)!==JSON.stringify(await read()))throw new Error('authority_fenced');}};
}

async function recordContentGate(ctx:MaintenanceContext,enabled:boolean){const key=contentGateKey(ctx.scope);const old=(await db.get('meta',key))?.value;if(enabled===false&&old!==false){for(const row of await db.all('mappings'))if(maintenance.belongs(row,ctx.scope)&&row.state!=='detached')await db.changeMapping(row.id,m=>sameAttempt(m,row)?{...m,applyEpoch:m.applyEpoch+1,staged:undefined}:m);}await ctx.assertCurrent();await db.put('meta',{id:key,value:enabled});}
