import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach,afterEach,expect,test,vi } from 'vitest';
import { subscriptionStore as db } from '../src/bookmark-subscriptions/store.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { personalTreeApi,assertSubscriptionUploadAllowed } from '../src/bookmark-subscriptions/personal-boundary.js';
import { withSubscriptionRead } from '../src/bookmark-subscriptions/barrier.js';
import { assertPersonalTreeAllowed,isSubscriptionExcluded } from '../src/bookmark-subscriptions/guards.js';
import { validSubscriptionSender } from '../src/bookmark-subscriptions/commands.js';
import { validateExternalReference,acceptExternalReference } from '../src/bookmark-subscriptions/external.js';
import { nativeFixture,row,root } from './bookmark-subscriptions-fixture.js';
import type { BuildConfig } from '../src/types.js';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function locks(){let readers=0,writer=false;const queue:{mode:string;run:()=>void}[]=[];const modes:string[]=[];const pump=()=>{if(writer)return;if(queue[0]?.mode==='exclusive'){if(readers)return;queue.shift()!.run();return;}while(queue[0]?.mode==='shared')queue.shift()!.run();};return {modes,request:(_name:string,options:{mode:string},work:()=>Promise<unknown>)=>new Promise((resolve,reject)=>{modes.push(options.mode);queue.push({mode:options.mode,run:()=>{if(options.mode==='exclusive')writer=true;else readers++;Promise.resolve().then(work).then(resolve,reject).finally(()=>{if(options.mode==='exclusive')writer=false;else readers--;pump();});}});pump();})};}
let fixture:ReturnType<typeof nativeFixture>;
beforeEach(async()=>{await db.close();vi.stubGlobal('indexedDB',new IDBFactory());fixture=nativeFixture();const subtree=(id:string):chrome.bookmarks.BookmarkTreeNode=>({...fixture.nodes.get(id)!,children:[...fixture.nodes.values()].filter(n=>n.parentId===id).map(n=>subtree(n.id))});vi.stubGlobal('chrome',{bookmarks:{...fixture.api,getTree:async()=>[subtree('0')],getSubTree:async(id:string)=>[subtree(id)]},tabs:{create:vi.fn(async()=>({id:1}))},runtime:{getURL:(path:string)=>'chrome-extension://extension/'+path}});vi.stubGlobal('navigator',{locks:locks()});});
afterEach(async()=>{vi.restoreAllMocks();await db.close();vi.unstubAllGlobals();});
test('scan, create intent, native success, ownership receipt and old-upload dispatch share one boundary',async()=>{
 const mapping=row();await db.put('mappings',mapping);const scanned=deferred<void>(),scanRelease=deferred<void>(),nativeCreated=deferred<string>(),receiptRelease=deferred<void>();
 const getTree=chrome.bookmarks.getTree;vi.spyOn(chrome.bookmarks,'getTree').mockImplementation(async()=>{scanned.resolve();await scanRelease.promise;return getTree();});
 const read=personalTreeApi().getTree();await scanned.promise;const create=fixture.api.create;fixture.api.create=async input=>{const result=await create(input);nativeCreated.resolve(result.id);await receiptRelease.promise;return result;};
 const mounting=createNativeExecutor(db,fixture.api).create(mapping,root,'bar');await Promise.resolve();expect(fixture.calls).toHaveLength(0);scanRelease.resolve();const personal=await read;expect(personal[0]?.children?.[0]?.children).toHaveLength(0);
 const id=await nativeCreated.promise;expect((await db.all('nodes'))).toHaveLength(0);expect(await isSubscriptionExcluded(id)).toBe(true);
 let sent=false;const upload=withSubscriptionRead(async()=>{await assertSubscriptionUploadAllowed({getMappingByColpId:async()=>undefined,listBookmarkEvents:async()=>[]} as any,{} as any,{opId:'old-queue',payload:{nativeId:id}} as any);sent=true;});const rejected=expect(upload).rejects.toThrow('subscription_upload_excluded');
 await Promise.resolve();expect(sent).toBe(false);receiptRelease.resolve();await mounting;await rejected;expect((await db.all('nodes'))[0]?.nativeId).toBe(id);
 expect((await personalTreeApi().getTree())[0]?.children?.[0]?.children).toHaveLength(0);expect(sent).toBe(false);
});
test('preserved copies remain writable local bookmarks while old uploads remain excluded',async()=>{
 fixture.nodes.set('copy',{id:'copy',parentId:'bar',title:'Copy'});await db.put('exclusions',{id:'copy',nativeId:'copy',reason:'preserved',accountId:'account',serverOrigin:'https://known.test'});
 await expect(assertPersonalTreeAllowed('copy')).resolves.toBeUndefined();expect(await isSubscriptionExcluded('copy')).toBe(true);
 vi.spyOn(db,'pendingOperations').mockRejectedValue(new Error('storage_unavailable'));await expect(personalTreeApi().getTree()).rejects.toThrow('storage_unavailable');
});
test('management messages accept only the exact options page of this extension',()=>{
 expect(validSubscriptionSender({id:'extension',url:'chrome-extension://extension/options.html#subscriptions'},'extension')).toBe(true);
 for(const url of ['chrome-extension://extension/popup.html','chrome-extension://extension/capture-tabs.html','https://known.test/options.html','chrome-extension://extension/options.html/','chrome-extension://other/options.html'])expect(validSubscriptionSender({id:'extension',url},'extension')).toBe(false);
});
const config={serverOrigin:'https://api.known.test',subscriptionBridgeOrigins:[{webOrigin:'https://known.test',serverOrigin:'https://api.known.test'}]} as unknown as BuildConfig;
const message=()=>({kind:'known.subscription.open',requestId:crypto.randomUUID(),sourceType:'collection',sourceId:'source'});
test('external bridge validates exact environment and permits only opaque source references',()=>{
 const input=message();expect(validateExternalReference(input,'https://known.test/collections/source',config)?.sourceId).toBe('source');
 for(const url of ['https://known.test.evil.test/','https://sub.known.test/','http://known.test/','https://user@known.test/'])expect(validateExternalReference(input,url,config)).toBeNull();
 expect(validateExternalReference({...input,token:'secret'},'https://known.test/',config)).toBeNull();expect(validateExternalReference(input,'https://known.test/',{...config,serverOrigin:'https://other.test'})).toBeNull();
});
test('failed wizard opening cannot produce a successful dedupe receipt; exact successful retry opens only once',async()=>{
 const input=message();vi.mocked(chrome.tabs.create).mockRejectedValueOnce(new Error('tab_failed'));
 await expect(acceptExternalReference(input,'https://known.test/',config)).rejects.toThrow('tab_failed');await expect(acceptExternalReference(input,'https://known.test/',config)).resolves.toEqual({accepted:true,protocolVersion:1});await acceptExternalReference(input,'https://known.test/',config);expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
 await expect(acceptExternalReference({...input,sourceId:'another'},'https://known.test/',config)).rejects.toThrow('external_request_reused');
});
