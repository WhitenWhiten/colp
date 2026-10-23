import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { NativeExecutor } from '../src/bookmark-subscriptions/native.js';
const state=vi.hoisted(()=>({db:undefined as unknown as SubscriptionStore,native:undefined as unknown as NativeExecutor}));
vi.mock('../src/bookmark-subscriptions/store.js',async original=>({...await original<object>(),get subscriptionStore(){return state.db;}}));
vi.mock('../src/bookmark-subscriptions/runtime.js',()=>({get subscriptionNative(){return state.native;}}));
import { subscriptionEvent } from '../src/bookmark-subscriptions/events.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { database,nativeFixture,row,root,leaf } from './bookmark-subscriptions-fixture.js';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
let fixture:ReturnType<typeof nativeFixture>;
beforeEach(async()=>{state.db=database();fixture=nativeFixture();state.native=createNativeExecutor(state.db,fixture.api);await state.db.put('mappings',row());});
afterEach(async()=>{vi.restoreAllMocks();await state.db.close();});
test('own root create is recognized when receipt settles between initial event lookup and ownership lookup',async()=>{
 const created=deferred<chrome.bookmarks.BookmarkTreeNode>(),releaseReply=deferred<void>(),initialLookup=deferred<void>(),releaseLookup=deferred<void>();
 const create=fixture.api.create;fixture.api.create=async input=>{const node=await create(input);created.resolve(node);await releaseReply.promise;return node;};
 const mounting=state.native.create(row(),root,'bar');const node=await created.promise;
 const operationsForNative=state.db.operationsForNative;vi.spyOn(state.db,'operationsForNative').mockImplementationOnce(async id=>{const empty=await operationsForNative(id);expect(empty).toEqual([]);initialLookup.resolve();await releaseLookup.promise;return empty;});
 const event=subscriptionEvent({kind:'created',nativeId:node.id,node});await initialLookup.promise;releaseReply.resolve();await mounting;
 expect(await state.db.pendingOperations()).toEqual([]);releaseLookup.resolve();expect(await event).toBe(true);
 expect(await state.db.get('mappings',row().id)).toMatchObject({enabled:true,applyEpoch:1,rootNativeId:node.id});expect(await state.db.all('diagnostics')).toEqual([]);expect((await state.db.operationsForNative(node.id))[0]?.eventConsumed).toBe(true);
});
test('receipt phase updates preserve event consumption during an issued native update',async()=>{
 const node=await state.native.create(row(),root,'bar');if(!node)throw new Error('missing root');await subscriptionEvent({kind:'created',nativeId:node.id,node});
 const evidence=await state.db.nodeForNative(node.id);if(!evidence)throw new Error('missing evidence');
 const update=fixture.api.update;fixture.api.update=async(id,input)=>{const result=await update(id,input);await subscriptionEvent({kind:'changed',nativeId:id,changes:{title:result.title}});return result;};
 await state.native.updateRoot(row(),evidence,'Renamed','bar',0);const operation=(await state.db.operationsForNative(node.id)).find(o=>o.kind==='update');
 expect(operation).toMatchObject({phase:'received',settled:true,eventConsumed:true});expect(await state.db.get('mappings',row().id)).toMatchObject({enabled:true,applyEpoch:1});expect(await state.db.all('diagnostics')).toEqual([]);
});

test('own child receipt arriving between native-operation and ownership reads cannot become an intrusion',async()=>{
 const parent=await state.native.create(row(),root,'bar');if(!parent)throw new Error('missing root');
 await subscriptionEvent({kind:'created',nativeId:parent.id,node:parent});
 const created=deferred<chrome.bookmarks.BookmarkTreeNode>(),releaseReply=deferred<void>();
 const initialLookup=deferred<void>(),releaseInitial=deferred<void>(),receiptSaved=deferred<void>(),allowOwnership=deferred<void>();
 const ownershipLookup=deferred<void>(),releaseOwnership=deferred<void>();
 const create=fixture.api.create;fixture.api.create=async input=>{const node=await create(input);created.resolve(node);await releaseReply.promise;return node;};
 const mounting=state.native.create(row(),leaf('own-child'),parent.id);const node=await created.promise;
 const operations=state.db.operationsForNative;
 vi.spyOn(state.db,'operationsForNative').mockImplementationOnce(async id=>{const old=await operations(id);expect(old).toEqual([]);initialLookup.resolve();await releaseInitial.promise;return old;});
 const change=state.db.changeOperation;
 vi.spyOn(state.db,'changeOperation').mockImplementation(async(id,patch)=>{const saved=await change(id,patch);if(patch.phase==='received'&&patch.resultId===node.id){receiptSaved.resolve();await allowOwnership.promise;}return saved;});
 const owned=state.db.nodeForNative;
 vi.spyOn(state.db,'nodeForNative').mockImplementationOnce(async id=>{const old=await owned(id);expect(old).toBeUndefined();ownershipLookup.resolve();await releaseOwnership.promise;return old;});
 const event=subscriptionEvent({kind:'created',nativeId:node.id,node});
 await initialLookup.promise;releaseReply.resolve();await receiptSaved.promise;releaseInitial.resolve();await ownershipLookup.promise;
 allowOwnership.resolve();await mounting;releaseOwnership.resolve();await event;
 expect(await state.db.get('mappings',row().id)).toMatchObject({enabled:true,applyEpoch:1,rootNativeId:parent.id});
 expect(await state.db.all('diagnostics')).toEqual([]);
 expect((await state.db.operationsForNative(node.id)).find(op=>op.kind==='create')?.eventConsumed).toBe(true);
});
