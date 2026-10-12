import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { MaintenanceContext } from '../src/bookmark-subscriptions/maintenance.js';
import type { SubscriptionCommand } from '../src/bookmark-subscriptions/commands.js';
const state=vi.hoisted(()=>({db:undefined as unknown as SubscriptionStore,ctx:undefined as unknown as MaintenanceContext,wake:vi.fn()}));
vi.mock('../src/bookmark-subscriptions/store.js',async original=>({...await original<object>(),get subscriptionStore(){return state.db;}}));
vi.mock('../src/sw/runtime.js',()=>({hasBookmarkPermission:async()=>true}));
vi.mock('../src/bookmark-subscriptions/runtime.js',()=>({subscriptionContext:async()=>state.ctx,localDirectoryContext:async()=>state.ctx,localMapping:async(_ctx:unknown,id:string)=>state.db.get('mappings',id),maintenance:{},subscriptionNative:{},wakeSubscriptions:()=>state.wake(),refreshMapping:vi.fn(),markFailure:vi.fn(),scheduleSubscriptionAlarm:vi.fn()}));
import { handleSubscriptionRequest } from '../src/bookmark-subscriptions/worker.js';
import { database,row,scope } from './bookmark-subscriptions-fixture.js';
import { workspaceFolderTree } from './fixtures/workspace-folders.js';
import type { FolderTreeNode } from '../src/save-folder.js';
const call=(command:SubscriptionCommand)=>handleSubscriptionRequest({type:'BOOKMARK_SUBSCRIPTIONS',requestId:crypto.randomUUID(),command});
beforeEach(async()=>{state.db=database();await state.db.put('mappings',row());state.wake.mockReset();state.ctx={scope,assertCurrent:async()=>{},client:{request:vi.fn() as any}};});
afterEach(async()=>{await state.db.close();vi.unstubAllGlobals();});
test('subscription folder navigation, mount targets and directory defaults share the root policy',async()=>{
 const index=new Map<string,FolderTreeNode>();const visit=(nodes:readonly FolderTreeNode[])=>{for(const n of nodes){index.set(n.id,n);visit(n.children??[]);}};visit(workspaceFolderTree());
 vi.stubGlobal('chrome',{bookmarks:{get:async(id:string)=>index.has(id)?[index.get(id)]:[],getChildren:async(id:string)=>index.get(id)?.children??[]}});
 const result=await call({kind:'folders'}) as {nodes:{id:string}[]};expect(result.nodes.map(n=>n.id)).toEqual(['1','2']);
 const ordinary=await call({kind:'folders',parentId:'1'}) as {nodes:{id:string}[]};expect(ordinary.nodes.map(n=>n.id)).toEqual(['a','user-workspace']);
 for(const id of ['workspaces','project','workspace-folder']){
  await expect(call({kind:'folders',parentId:id})).rejects.toThrow('bookmark_folder_unavailable');
  await expect(call({kind:'relocatePreview',mappingId:row().id,expectedGeneration:'g1',parentNativeId:id})).rejects.toThrow('bookmark_folder_unavailable');
  await expect(call({kind:'directoryPreview',mountParentNativeId:id})).rejects.toThrow('bookmark_folder_unavailable');
 }
 expect(state.ctx.client.request).not.toHaveBeenCalled();
});
test('actual exit confirmation revokes content before HTTP and retries the frozen command after a lost response',async()=>{
 const previewId=crypto.randomUUID(),commands:string[]=[];let fail=true;const batch={exitId:'exit',trigger:'unsubscribe',actions:[]};
 vi.mocked(state.ctx.client.request).mockImplementation(async(path,options)=>{
   if(path.endsWith(row().id))return {status:200,etag:null,data:row().mapping} as any;
   if(path.endsWith('exit-previews'))return {status:200,etag:null,data:{previewId,expiresAt:new Date(Date.now()+60000).toISOString(),trigger:'unsubscribe',target:{kind:'mapping',mappingId:row().id},preferenceRevision:'p1',targets:[{mappingId:row().id,generation:'g1',profileId:scope.profileId}]}} as any;
   expect(path).toMatch(/subscription-exits$/);expect(await state.db.get('tokens',row().id)).toMatchObject({enabled:false,applyEpoch:2});commands.push(options!.commandId!);if(fail){fail=false;throw new Error('reply_lost');}return {status:202,etag:null,data:batch} as any;
 });
 await call({kind:'exitPreview',mappingId:row().id,expectedGeneration:'g1',scope:'mapping'});expect((await state.db.get('tokens',row().id))?.enabled).toBe(true);
 await expect(call({kind:'exitConfirm',previewId})).rejects.toThrow('reply_lost');await expect(call({kind:'exitConfirm',previewId})).resolves.toEqual(batch);await expect(call({kind:'exitConfirm',previewId})).resolves.toEqual(batch);expect(commands).toHaveLength(2);expect(new Set(commands).size).toBe(1);expect(state.wake).toHaveBeenCalledOnce();
 state.ctx={...state.ctx,scope:{...scope,accountId:'another'}};await expect(call({kind:'exitConfirm',previewId})).rejects.toThrow('preview_invalid');expect(commands).toHaveLength(2);
});
