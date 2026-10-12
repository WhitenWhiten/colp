import { expect,test,vi } from 'vitest';
import { createMaintenance,type MaintenanceContext } from '../src/bookmark-subscriptions/maintenance.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { digest,sourceNodeKey } from '../src/bookmark-subscriptions/projection.js';
import type { ProjectionNode,SnapshotDescriptor,ExitTask } from '../src/bookmark-subscriptions/contracts.js';
import { database,nativeFixture,row,root,leaf,owned,scope } from './bookmark-subscriptions-fixture.js';
function context(mapping:ReturnType<typeof row>,request:(path:string,options:any)=>Promise<any>):MaintenanceContext{return {scope,assertCurrent:async()=>undefined,client:{request:request as any}};}
function fence(mapping:ReturnType<typeof row>,contentEnabled=true){return {mappingId:mapping.id,generation:mapping.mapping.generation,mappingRevision:mapping.mapping.revision,authorityRevision:'a1',contentEnabled};}
async function seed(nodes:ProjectionNode[],mapping=row()){
 const db=database(),fixture=nativeFixture();mapping.rootNativeId='source-root';await db.put('mappings',mapping);
 const ids=new Map<string,string>();for(const [i,node] of nodes.entries()){const id=i===0?'source-root':'source-'+i;ids.set(node.key,id);const parent=node.parentKey===null?'bar':ids.get(node.parentKey)!;fixture.nodes.set(id,{id,parentId:parent,index:node.index,title:node.title,...(node.url?{url:node.url}:{})});await db.put('nodes',{...owned(mapping,node,id,parent),ref:node.role==='content'?mapping.source.sourceType==='collection'?{sourceCollectionId:'collection',nodeId:JSON.parse(node.key)[2],editionId:null}:{sourceCollectionId:JSON.parse(node.key)[3],nodeId:JSON.parse(node.key)[4],editionId:node.editionId}:undefined});}
 return {db,fixture,mapping,native:createNativeExecutor(db,fixture.api),ids};
}
test('paused + content gate off still clears a denied ancestor across 128-node batches without preserving unchecked source children',async()=>{
 const folder={...leaf('folder'),kind:'folder' as const,url:undefined};const nodes=[root,folder,...Array.from({length:130},(_,i)=>({...leaf('child-'+i,folder.key),index:i}))];
 const {db,fixture,mapping,native}=await seed(nodes);const paused=await db.changeMapping(mapping.id,m=>({...m,enabled:false,state:'paused',applyEpoch:2}));let batches=0;
 const ctx=context(paused,async(path,options)=>({status:200,etag:null,data:path.endsWith('/node-access-checks')?(batches++,{...fence(paused,false),state:'available',requestDigest:digest(options.body.nodes),removeNodes:options.body.nodes}):{...fence(paused,false),state:'available',removeEditionIds:[]}}));
 expect(await createMaintenance(db,native).access(ctx,paused)).toBe(true);expect(batches).toBe(2);expect((await db.all('nodes')).map(n=>n.nativeId)).toEqual(['source-root']);expect(await db.all('exclusions')).toHaveLength(0);expect(fixture.calls.every(c=>c.startsWith('remove:'))).toBe(true);
});
test('a failed permission batch leaves an incomplete keep proof and retries the remaining identities freshly',async()=>{
 const nodes=[root,...Array.from({length:129},(_,i)=>({...leaf('child-'+i),index:i}))];const {db,mapping,native}=await seed(nodes);let batches=0;
 const ctx=context(mapping,async(path,options)=>{if(path.endsWith('/node-access-checks')){if(++batches===2)throw new Error('offline');return {status:200,etag:null,data:{...fence(mapping),state:'available',requestDigest:digest(options.body.nodes),removeNodes:[]}};}return {status:200,etag:null,data:{...fence(mapping),state:'available',removeEditionIds:[]}};});
 await expect(createMaintenance(db,native).access(ctx,mapping,'exit')).rejects.toThrow('offline');const scan=(await db.get('meta','scan:'+mapping.id))!.value as any;expect(scan.complete).toBe(false);expect(scan.processed).toBe(128);
 await expect(db.terminal({id:'exit',scope,mappingId:mapping.id,generation:'g1',expectedEpoch:1,scanId:scan.scanId,result:'kept',commandId:crypto.randomUUID(),pending:true,completedAt:Date.now(),evidence:[]},true)).rejects.toThrow('keep_proof_incomplete');
});
test('a frozen keep commits once and retries the original ACK after it disappears from pending action pages',async()=>{
 const {db,mapping,native,fixture}=await seed([root,leaf()]);let failAck=true,delivered=false,accessCalls=0;const commands:string[]=[];
 const action:ExitTask={actionId:crypto.randomUUID(),exitId:crypto.randomUUID(),sequence:'1',subscriptionId:'sub',mappingId:mapping.id,profileId:scope.profileId,generation:'g1',trigger:'unsubscribe',effectiveAction:'keep',policyOrigin:'global',preferenceRevision:'p1',mappingRevision:'r1',createdAt:new Date().toISOString()};
 const ctx=context(mapping,async(path,options)=>{let data:unknown;if(path.includes('/ack')){commands.push(options.commandId);if(failAck)throw new Error('offline');data={};}else if(path.includes('actions?')){data={items:delivered?[]:[action],nextCursor:null};delivered=true;}else if(path.endsWith('node-access-checks')){accessCalls++;data={...fence(mapping),state:'available',requestDigest:digest(options.body.nodes),removeNodes:[]};}else data={...fence(mapping),state:'available',removeEditionIds:[]};return {data,status:200,etag:null};});
 const maintenance=createMaintenance(db,native);await maintenance.actions(ctx);expect((await db.get('acks',action.actionId))?.pending).toBe(true);expect((await db.get('mappings',mapping.id))?.state).toBe('detached');expect(await db.all('nodes')).toHaveLength(0);const firstCalls=fixture.calls.length;
 failAck=false;await maintenance.actions(ctx);expect((await db.get('acks',action.actionId))?.pending).toBe(false);expect(new Set(commands).size).toBe(1);expect(accessCalls).toBe(1);expect(fixture.calls).toHaveLength(firstCalls);expect(fixture.nodes.has('source-1')).toBe(true);
});
test('Digest recent to latest moves same-edition same-source content before deleting obsolete folders',async()=>{
 const mapping=row();mapping.source={sourceType:'digest_series',sourceId:'series'};mapping.mapping={...mapping.mapping,digestMode:'latest',editionLimit:1};mapping.state='current';mapping.projectionEtag='"old"';
 const content={...leaf(),key:sourceNodeKey(mapping.source,{sourceCollectionId:'collection',nodeId:'node',editionId:'edition'}),editionId:'edition'};
 const edition:ProjectionNode={key:JSON.stringify(['synthetic','edition_folder','edition']),parentKey:root.key,title:'Edition',kind:'folder',role:'edition_folder',index:0,editionId:'edition'};
 const old=[root,edition,{...content,parentKey:edition.key}];const {db,native,fixture,ids}=await seed(old,mapping);const next=[root,content];
 const descriptor:SnapshotDescriptor={snapshotId:'snapshot',source:mapping.source,mappingId:mapping.id,generation:'g1',digestMode:'latest',editionLimit:1,projectionVersion:'1',projectionRevision:'p2',projectionEtag:'"p2"',policyRevision:'p1',contentDigest:digest(next),rootKey:root.key,counts:{nodes:2,bookmarks:1,editions:1,skipped:0},editions:[{editionId:'edition',title:'Edition',publishedAt:new Date().toISOString()}],skippedByReason:[],expiresAt:new Date(Date.now()+60000).toISOString(),maxPageSize:200};let checks=0;
 const ctx=context(mapping,async(path,options)=>{if(path.endsWith('/projection'))return ++checks===1?{status:200,etag:'"p2"',data:{state:'available',mappingId:mapping.id,generation:'g1'}}:{status:304,etag:'"p2"'};if(path.endsWith('snapshots'))return {status:201,etag:null,data:descriptor};if(path.endsWith('/nodes'))return {status:200,etag:null,data:{snapshotId:'snapshot',projectionRevision:'p2',items:next,nextCursor:null,complete:true}};return {status:200,etag:null,data:path.endsWith('node-access-checks')?{...fence(mapping),state:'available',requestDigest:digest(options.body.nodes),removeNodes:[]}:{...fence(mapping),state:'available',removeEditionIds:[]}};});
 await createMaintenance(db,native).content(ctx,mapping);expect(fixture.nodes.get(ids.get(content.key)!)?.parentId).toBe('source-root');expect(fixture.nodes.has(ids.get(edition.key)!)).toBe(false);expect(fixture.calls.filter(c=>c.startsWith('create:'))).toHaveLength(0);expect(await db.all('exclusions')).toHaveLength(0);expect((await db.get('mappings',mapping.id))?.lastAppliedRevision).toBe('p2');
});
test('remote configuration or content gate changes reject content permission before writes',async()=>{
 const {db,mapping,native,fixture}=await seed([root,leaf()]);const maintenance=createMaintenance(db,native);
 const ctx=context(mapping,async()=>({status:200,etag:null,data:{...fence(mapping,false),state:'available',removeEditionIds:[]}}));await expect(maintenance.access(ctx,mapping,undefined,true)).rejects.toThrow('configuration_changed');expect(fixture.calls).toHaveLength(0);
 await db.changeMapping(mapping.id,m=>({...m,applyEpoch:2,enabled:false}));await expect(maintenance.content(ctx,mapping)).rejects.toThrow('apply_epoch_changed');expect(fixture.calls).toHaveLength(0);
});
