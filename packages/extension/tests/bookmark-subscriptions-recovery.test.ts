import { beforeEach,afterEach,expect,test,vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { NativeExecutor } from '../src/bookmark-subscriptions/native.js';
import type { createMaintenance,MaintenanceContext } from '../src/bookmark-subscriptions/maintenance.js';
const state=vi.hoisted(()=>({db:undefined as unknown as SubscriptionStore,native:undefined as unknown as NativeExecutor,maintenance:undefined as unknown as ReturnType<typeof createMaintenance>,refresh:vi.fn()}));
vi.mock('../src/bookmark-subscriptions/store.js',async original=>({...await original<object>(),get subscriptionStore(){return state.db;}}));
vi.mock('../src/bookmark-subscriptions/runtime.js',()=>({get subscriptionNative(){return state.native;},get maintenance(){return state.maintenance;},localMapping:async(_ctx:unknown,id:string,generation?:string)=>{const m=await state.db.get('mappings',id);if(!m||generation&&m.mapping.generation!==generation)throw new Error('mapping_missing');return m;},refreshMapping:(...args:unknown[])=>state.refresh(...args),markFailure:async()=>{},wakeSubscriptions:async()=>{}}));
import { recoveryCommand } from '../src/bookmark-subscriptions/recovery.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { createMaintenance as buildMaintenance } from '../src/bookmark-subscriptions/maintenance.js';
import { digest } from '../src/bookmark-subscriptions/projection.js';
import { database,nativeFixture,row,root,leaf,owned,scope } from './bookmark-subscriptions-fixture.js';
let fixture:ReturnType<typeof nativeFixture>,mapping:ReturnType<typeof row>,ctx:MaintenanceContext,exitCalls:number,exitSawCompleteCopy:boolean;
beforeEach(async()=>{
 state.db=database();fixture=nativeFixture();mapping={...row(),rootNativeId:'source-root',state:'local_change',enabled:false};await state.db.put('mappings',mapping);
 fixture.nodes.set('source-root',{id:'source-root',parentId:'bar',title:'Source',index:0});fixture.nodes.set('source-leaf',{id:'source-leaf',parentId:'source-root',index:0,title:'Edited locally',url:leaf().url});
 await state.db.put('nodes',owned(mapping,root,'source-root'));await state.db.put('nodes',owned(mapping,leaf(),'source-leaf','source-root'));
 state.native=createNativeExecutor(state.db,fixture.api);state.maintenance=buildMaintenance(state.db,state.native);exitCalls=0;exitSawCompleteCopy=false;state.refresh.mockReset();
 const fence={mappingId:mapping.id,generation:'g1',mappingRevision:'r1',authorityRevision:'a1',contentEnabled:true};
 const request=async(path:string,options:any={})=>{
  let data:any;
  if(path.endsWith('exit-previews'))data={previewId:'preview',trigger:'unsubscribe',target:{kind:'mapping',mappingId:mapping.id},preferenceRevision:'p1',expiresAt:new Date(Date.now()+60000).toISOString(),targets:[{mappingId:mapping.id,effectiveAction:'remove'}]};
  else if(path.endsWith('subscription-exits')){exitCalls++;exitSawCompleteCopy=(await state.db.all('meta')).some(m=>m.id.startsWith('copy-receipt:'));data={exitId:'exit',trigger:'unsubscribe',actions:[]};}
  else if(path.endsWith('node-access-checks'))data={...fence,state:'available',requestDigest:digest(options.body.nodes),removeNodes:[]};
  else if(path.includes('/access'))data={...fence,state:'available',removeEditionIds:[]};
  else if(path.endsWith('/projection')){if(options.ifNoneMatch==='"p1"')return {status:304,etag:'"p1"',data:undefined};data={state:'available',mappingId:mapping.id,generation:'g1'};return {status:200,etag:'"p1"',data};}
  else if(path.endsWith('/nodes'))data={snapshotId:'snapshot',projectionRevision:'p1',items:[root,leaf()],nextCursor:null,complete:true};
  else if(path.endsWith('snapshots'))data={snapshotId:'snapshot',source:mapping.source,mappingId:mapping.id,generation:'g1',digestMode:null,editionLimit:null,projectionVersion:'1',projectionRevision:'p1',projectionEtag:'"p1"',policyRevision:'policy1',contentDigest:digest([root,leaf()]),rootKey:root.key,counts:{nodes:2,bookmarks:1,editions:0,skipped:0},skippedByReason:[],editions:[],expiresAt:new Date(Date.now()+60000).toISOString(),maxPageSize:200};
  else data=mapping.mapping;
  return {status:200,etag:null,data};
 };
 ctx={scope,assertCurrent:async()=>{},client:{request:request as any}};
});
afterEach(async()=>{await state.db.close();});
async function preview(action:'restore'|'copy_detach'){const result=await recoveryCommand(ctx,{kind:'recoveryPreview',mappingId:mapping.id,expectedGeneration:'g1',action},crypto.randomUUID());return result.data as {token:string;copyCount:number};}
test('copy and detach completes durable authorized copy before sending frozen exit and replays one result',async()=>{
 const review=await preview('copy_detach');expect(fixture.calls).toHaveLength(0);expect(review.copyCount).toBe(2);
 const first=await recoveryCommand(ctx,{kind:'recoveryConfirm',token:review.token},crypto.randomUUID());expect(exitCalls).toBe(1);expect(exitSawCompleteCopy).toBe(true);expect([...fixture.nodes.values()].filter(n=>n.title==='Edited locally')).toHaveLength(2);
 const count=fixture.calls.length;const second=await recoveryCommand(ctx,{kind:'recoveryConfirm',token:review.token},crypto.randomUUID());expect((second.data as any).copy).toEqual((first.data as any).copy);expect(exitCalls).toBe(1);expect(fixture.calls).toHaveLength(count);expect((await state.db.all('nodes')).every(n=>!n.copyTaskId)).toBe(true);expect(await state.db.all('exclusions')).not.toHaveLength(0);
});
test('lost copy create response persists ambiguous evidence and never detaches or duplicates on retry',async()=>{
 const review=await preview('copy_detach');const create=fixture.api.create;fixture.api.create=async input=>{const created=await create(input);if(input.title==='Edited locally')throw new Error('reply_lost');return created;};
 await expect(recoveryCommand(ctx,{kind:'recoveryConfirm',token:review.token},crypto.randomUUID())).rejects.toThrow('reply_lost');expect(exitCalls).toBe(0);const creates=fixture.calls.filter(c=>c.startsWith('create:')).length;
 await expect(recoveryCommand(ctx,{kind:'recoveryConfirm',token:review.token},crypto.randomUUID())).rejects.toThrow('recovery_identity_uncertain');expect(fixture.calls.filter(c=>c.startsWith('create:'))).toHaveLength(creates);expect(exitCalls).toBe(0);expect(fixture.nodes.has('source-root')).toBe(true);expect((await state.db.pendingOperations()).some(o=>o.phase==='issued')).toBe(true);
});
test('restore preserves local edits then reapplies source through actual maintenance while retaining native identities',async()=>{
 state.refresh.mockImplementation(async(context:MaintenanceContext,m:ReturnType<typeof row>)=>{if(await state.maintenance.access(context,m))await state.maintenance.content(context,m);});
 const review=await preview('restore');await recoveryCommand(ctx,{kind:'recoveryConfirm',token:review.token},crypto.randomUUID());
 expect(exitCalls).toBe(0);expect(fixture.nodes.get('source-leaf')?.title).toBe(leaf().title);expect([...fixture.nodes.values()].filter(n=>n.title==='Edited locally')).toHaveLength(1);expect((await state.db.get('mappings',mapping.id))?.rootNativeId).toBe('source-root');expect((await state.db.get('mappings',mapping.id))?.state).toBe('current');
});
test('changed local preview and authority replacement cannot start copy or server exit',async()=>{
 const review=await preview('copy_detach');fixture.nodes.get('source-leaf')!.title='Changed after preview';await expect(recoveryCommand(ctx,{kind:'recoveryConfirm',token:review.token},crypto.randomUUID())).rejects.toThrow('preview_changed');expect(fixture.calls).toHaveLength(0);
 await expect(recoveryCommand({...ctx,scope:{...scope,accountId:'other'}},{kind:'recoveryConfirm',token:review.token},crypto.randomUUID())).rejects.toThrow('preview_invalid');expect(exitCalls).toBe(0);
});
