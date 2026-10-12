import { expect,test } from 'vitest';
import { database,row,root,owned,scope } from './bookmark-subscriptions-fixture.js';
import { ownershipDigest } from '../src/bookmark-subscriptions/store.js';
import type { AckRecord } from '../src/bookmark-subscriptions/local-types.js';
import type { SnapshotDescriptor } from '../src/bookmark-subscriptions/contracts.js';
import { createSubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { IDBFactory } from 'fake-indexeddb';
import { digest } from '../src/bookmark-subscriptions/projection.js';
const descriptor=():SnapshotDescriptor=>({snapshotId:'snapshot',source:row().source,mappingId:row().id,generation:'g1',digestMode:null,editionLimit:null,projectionVersion:'1',projectionRevision:'p1',projectionEtag:'"p1"',policyRevision:'policy1',contentDigest:digest([root]),rootKey:root.key,counts:{nodes:1,bookmarks:0,editions:0,skipped:0},skippedByReason:[],editions:[],expiresAt:new Date(Date.now()+60000).toISOString(),maxPageSize:200});
test('capacity reservations serialize concurrent net growth across the entire profile',async()=>{
  const db=database(),a=row(),b={...row(),id:'b'};await db.put('mappings',a);await db.put('mappings',b);
  const result=await Promise.allSettled([db.reserve(a.id,12000),db.reserve(b.id,12000)]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await db.all('mappings')).reduce((sum,m)=>sum+m.reserved,0)).toBe(12000);await db.close();
});
test('keep terminal requires exact epoch and complete same-generation owned identity proof',async()=>{
  const db=database(),m=row(),n=owned(m,root,'root');await db.put('mappings',m);await db.put('nodes',n);
  const ack:AckRecord={id:crypto.randomUUID(),scope,mappingId:m.id,generation:'g1',result:'kept',commandId:crypto.randomUUID(),pending:true,completedAt:1,evidence:[],expectedEpoch:1,scanId:'scan'};
  await expect(db.terminal(ack,true)).rejects.toThrow('keep_proof_incomplete');
  await db.put('meta',{id:'scan:'+m.id,value:{scanId:'scan',epoch:1,complete:true,full:true,ownershipDigest:ownershipDigest([n])}});
  await db.changeMapping(m.id,v=>({...v,applyEpoch:2}));await expect(db.terminal(ack,true)).rejects.toThrow('generation_mismatch');
  await db.changeMapping(m.id,v=>({...v,applyEpoch:1}));await db.put('nodes',{...n,id:'another',nativeId:'another'});await expect(db.terminal(ack,true)).rejects.toThrow('keep_proof_incomplete');await db.remove('nodes','another');
  const saved=await db.terminal(ack,true);expect(saved.result).toBe('kept');expect(await db.all('nodes')).toEqual([]);expect((await db.all('exclusions')).map(n=>n.nativeId)).toEqual(['root']);expect((await db.get('mappings',m.id))?.state).toBe('detached');
  expect(await db.terminal({...ack,result:'no_local_mount'},false)).toEqual(saved);expect((await db.get('acks',ack.id))?.pending).toBe(true);await db.close();
});
test('remove and no-local-mount cannot commit over pending creation or remaining ownership',async()=>{
  const db=database(),m=row();await db.put('mappings',m);await db.put('nodes',owned(m,root,'root'));
  const ack:AckRecord={id:'ack',scope,mappingId:m.id,generation:'g1',result:'removed',commandId:crypto.randomUUID(),pending:true,expectedEpoch:1,completedAt:1,evidence:[]};await expect(db.terminal(ack,false)).rejects.toThrow('cleanup_incomplete');
  await db.put('operations',{id:'op',mappingId:m.id,generation:'g1',applyEpoch:1,kind:'create',phase:'issued',parentNativeId:'bar',beforeIds:[],createdAt:1});await expect(db.terminal({...ack,result:'no_local_mount'},false)).rejects.toThrow('recovery_identity_uncertain');await db.close();
});
test('logout durable cleanup revokes content but preserves recovery and exclusion evidence',async()=>{
  const db=database(),m=row();await db.put('mappings',m);await db.put('nodes',owned(m,root,'root'));await db.put('meta',{id:'external-draft',value:{private:true}});await db.prepareCleanup(scope.accountId,scope.serverOrigin);
  expect(await db.get('mappings',m.id)).toMatchObject({cleanup:true,enabled:false,applyEpoch:2,state:'terminating'});expect(await db.all('nodes')).toHaveLength(1);expect(await db.get('meta','external-draft')).toBeUndefined();await db.close();
});
test('staging keeps native tokens small and any epoch change atomically discards staged authority',async()=>{
 const db=database(),m=row(),snapshot={descriptor:descriptor(),nodes:[root]};await db.put('mappings',m);await db.stage(m,snapshot);
 expect(await db.get('mappings',m.id)).toMatchObject({state:'applying',staged:{descriptor:snapshot.descriptor}});expect((await db.get('mappings',m.id))?.staged).not.toHaveProperty('nodes');
 expect(await db.get('tokens',m.id)).toEqual({id:m.id,generation:'g1',applyEpoch:1,enabled:true,cleanup:false});expect((await db.get('stages',m.id))?.nodes).toEqual([root]);
 await db.changeMapping(m.id,v=>({...v,enabled:false,applyEpoch:v.applyEpoch+1}));expect(await db.get('stages',m.id)).toBeUndefined();expect((await db.get('mappings',m.id))?.staged).toBeUndefined();expect(await db.get('tokens',m.id)).toMatchObject({enabled:false,applyEpoch:2});
 await expect(db.stage(m,snapshot)).rejects.toThrow('apply_epoch_changed');await db.close();
});
test('version four migration preserves recovery evidence while splitting large staged nodes and seeding tokens',async()=>{
 const factory=new IDBFactory(),name='upgrade-'+crypto.randomUUID(),m=row(),snapshot={descriptor:descriptor(),nodes:[root]};
 const legacy=await new Promise<IDBDatabase>((resolve,reject)=>{const request=factory.open(name,4);request.onupgradeneeded=()=>{for(const table of ['mappings','nodes','operations','acks','exclusions','diagnostics','meta'])request.result.createObjectStore(table,{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 await new Promise<void>((resolve,reject)=>{const tx=legacy.transaction(['mappings','nodes','operations'],'readwrite');tx.objectStore('mappings').put({...m,staged:snapshot});tx.objectStore('nodes').put(owned(m,root,'native-root'));tx.objectStore('operations').put({id:'unknown',mappingId:m.id,generation:'g1',applyEpoch:1,kind:'create',phase:'issued',parentNativeId:'bar',beforeIds:[],createdAt:1});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});legacy.close();
 const upgraded=createSubscriptionStore(name,factory);await upgraded.ready();expect((await upgraded.get('stages',m.id))?.nodes).toEqual([root]);expect((await upgraded.get('mappings',m.id))?.staged).not.toHaveProperty('nodes');expect(await upgraded.get('tokens',m.id)).toMatchObject({generation:'g1',applyEpoch:1});expect((await upgraded.pendingOperations()).map(o=>o.id)).toEqual(['unknown']);expect((await upgraded.nodeForNative('native-root'))?.mappingId).toBe(m.id);await upgraded.close();
});
test('received native operations remain pending until ownership is settled and block terminal ACK',async()=>{
 const db=database(),m=row();await db.put('mappings',m);await db.put('operations',{id:'received',mappingId:m.id,generation:'g1',applyEpoch:1,kind:'create',phase:'received',resultId:'native-root',node:root,createdAt:1});
 expect((await db.pendingOperations()).map(o=>o.id)).toEqual(['received']);await expect(db.terminal({id:'exit',scope,mappingId:m.id,generation:'g1',result:'no_local_mount',commandId:crypto.randomUUID(),pending:true,expectedEpoch:1,completedAt:1,evidence:[]},false)).rejects.toThrow('recovery_identity_uncertain');await db.close();
});
test('exit fencing is idempotent and cannot stop another account or a replacement generation',async()=>{
 const db=database(),m=row(),other={...row(),id:'other',scope:{...scope,accountId:'another'}};await db.put('mappings',m);await db.put('mappings',other);await db.stage(m,{descriptor:descriptor(),nodes:[root]});
 await db.fenceExit(scope,[{mappingId:m.id,generation:'stale'},{mappingId:other.id,generation:'g1'}],'ignored',true);expect((await db.get('tokens',m.id))?.enabled).toBe(true);expect((await db.get('tokens',other.id))?.enabled).toBe(true);
 await db.fenceExit(scope,[{mappingId:m.id,generation:'g1'}],'exit',true);await db.fenceExit(scope,[{mappingId:m.id,generation:'g1'}],'exit',true);expect(await db.get('tokens',m.id)).toMatchObject({enabled:false,applyEpoch:2});expect(await db.get('stages',m.id)).toBeUndefined();expect((await db.get('mappings',m.id))?.state).toBe('terminating');await db.close();
});
