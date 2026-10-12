import { digest } from './projection.js';
import { isPreservationCreate, preservationKey } from './preservation-journal.js';
import type { AccountScope, AckRecord, Diagnostic, Exclusion, LocalMapping, NativeOperation, OwnedNode, MappingToken, StagedProjection, CompletedCopy, CopyCandidate } from './local-types.js';
export interface Tables { tokens:MappingToken; stages:StagedProjection; mappings: LocalMapping; nodes: OwnedNode; operations: NativeOperation; acks: AckRecord; exclusions: Exclusion; diagnostics: Diagnostic; meta: { id: string; value: unknown } }
export type Table = keyof Tables;
const TABLES: Table[] = ['tokens','stages','mappings','nodes','operations','acks','exclusions','diagnostics','meta'];
function result<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve,reject) => { request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); }); }
export function createSubscriptionStore(name = 'known-bookmark-subscriptions-v1', factory?: IDBFactory) {
  let opened: Promise<IDBDatabase> | undefined;
  const db = () => opened ??= new Promise<IDBDatabase>((resolve,reject) => {
    const request=(factory ?? indexedDB).open(name,5);
    request.onupgradeneeded=()=>{for(const table of TABLES) if(!request.result.objectStoreNames.contains(table)) request.result.createObjectStore(table,{keyPath:'id'});const operations=request.transaction!.objectStore('operations');for(const field of ['unsettled','nativeId','resultId','localKey'])if(!operations.indexNames.contains(field))operations.createIndex(field,field);const nodes=request.transaction!.objectStore('nodes');for(const field of ['nativeId','parentNativeId','mappingId'])if(!nodes.indexNames.contains(field))nodes.createIndex(field,field);const mappingCursor=request.transaction!.objectStore('mappings').openCursor();mappingCursor.onsuccess=()=>{const item=mappingCursor.result;if(item){const row=item.value as LocalMapping&{staged?:{descriptor:StagedProjection['descriptor'];nodes?:StagedProjection['nodes']}};request.transaction!.objectStore('tokens').put(tokenOf(row));if(row.staged?.nodes){request.transaction!.objectStore('stages').put({id:row.id,generation:row.mapping.generation,applyEpoch:row.applyEpoch,...row.staged});item.update({...row,staged:{descriptor:row.staged.descriptor}});}item.continue();}};const cursor=operations.openCursor();cursor.onsuccess=()=>{const item=cursor.result;if(item){item.update({...item.value,unsettled:item.value.settled?0:1});item.continue();}};};
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); request.onblocked=()=>reject(new Error('storage_unavailable'));
  });
  async function transaction<T>(tables: Table[], work: (tx: IDBTransaction)=>Promise<T>): Promise<T> {
    const tx=(await db()).transaction(tables,'readwrite');
    const done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error ?? new Error('storage_unavailable'));});
    void done.catch(()=>undefined);
    try { const value=await work(tx); await done; return value; } catch(error) { try{tx.abort();}catch{} throw error; }
  }
  async function all<K extends Table>(table: K): Promise<Tables[K][]> { return result((await db()).transaction(table).objectStore(table).getAll()); }
  async function get<K extends Table>(table: K,id:string): Promise<Tables[K]|undefined> { return result((await db()).transaction(table).objectStore(table).get(id)); }
  async function put<K extends Table>(table: K,value:Tables[K]): Promise<void> { await transaction(table==='mappings'?['mappings','tokens','stages']:[table],async tx=>{await result(tx.objectStore(table).put(table==='operations'?{...value,unsettled:(value as NativeOperation).settled?0:1}:value));if(table==='mappings'){const row=value as LocalMapping;tx.objectStore('tokens').put(tokenOf(row));if(!row.staged)tx.objectStore('stages').delete(row.id);}}); }

  async function changeOperation(id:string,patch:Partial<NativeOperation>):Promise<NativeOperation>{return transaction(['operations'],async tx=>{const store=tx.objectStore('operations');const prior=await result<NativeOperation|undefined>(store.get(id));if(!prior)throw new Error('operation_missing');const next={...prior,...patch};await result(store.put({...next,unsettled:next.settled?0:1}));return next;});}
  async function pendingOperations(){return result<NativeOperation[]>((await db()).transaction('operations').objectStore('operations').index('unsettled').getAll(1));}
  async function settlePreservation(operationId: string): Promise<void> {
    await transaction(['operations', 'mappings', 'exclusions', 'meta'], async tx => {
      const operations = tx.objectStore('operations');
      const op = await result<NativeOperation | undefined>(operations.get(operationId));
      if (!op || !isPreservationCreate(op) || op.phase !== 'received' || !op.resultId) throw new Error('recovery_identity_uncertain');
      const row = await result<LocalMapping | undefined>(tx.objectStore('mappings').get(op.mappingId));
      if (!row || row.mapping.generation !== op.generation) throw new Error('generation_mismatch');
      const key = preservationKey(row.scope);
      if (op.localKey !== undefined && op.localKey !== key) throw new Error('recovery_identity_uncertain');
      const saved = await result<Tables['meta'] | undefined>(tx.objectStore('meta').get(key));
      if (saved && saved.value !== op.resultId) throw new Error('recovery_identity_uncertain');
      tx.objectStore('exclusions').put({ id: op.resultId, nativeId: op.resultId, reason: 'preserved', accountId: row.scope.accountId, serverOrigin: row.scope.serverOrigin });
      tx.objectStore('meta').put({ id: key, value: op.resultId });
      operations.put({ ...op, purpose: 'preservation', localKey: key, settled: true, unsettled: 0 });
    });
  }
  async function count(table:Table){return result((await db()).transaction(table).objectStore(table).count());}
  async function nodeForNative(id:string){return (await result<OwnedNode[]>((await db()).transaction('nodes').objectStore('nodes').index('nativeId').getAll(id)))[0];}
  async function nodeChildrenCount(parentId:string){return result((await db()).transaction('nodes').objectStore('nodes').index('parentNativeId').count(parentId));}
  async function nodesForMapping(mappingId:string){return result<OwnedNode[]>((await db()).transaction('nodes').objectStore('nodes').index('mappingId').getAll(mappingId));}
  async function operationForLocalKey(mappingId:string,localKey:string){const rows=await result<NativeOperation[]>((await db()).transaction('operations').objectStore('operations').index('localKey').getAll(localKey));return rows.find(o=>o.mappingId===mappingId);}
  async function operationsForNative(id:string){const store=(await db()).transaction('operations').objectStore('operations');const rows=await Promise.all([result<NativeOperation[]>(store.index('nativeId').getAll(id)),result<NativeOperation[]>(store.index('resultId').getAll(id))]);return [...new Map(rows.flat().map(o=>[o.id,o])).values()];}
  async function remove(table:Table,id:string): Promise<void> { await transaction([table],async tx=>{await result(tx.objectStore(table).delete(id));}); }
  async function changeMapping(id:string,change:(row:LocalMapping)=>LocalMapping): Promise<LocalMapping> {
    return transaction(['mappings','tokens','stages'],async tx=>{ const store=tx.objectStore('mappings'); const row=await result<LocalMapping|undefined>(store.get(id)); if(!row)throw new Error('mapping_missing'); let next=change(row);if(next.applyEpoch!==row.applyEpoch)next={...next,staged:undefined};await result(store.put(next));tx.objectStore('tokens').put(tokenOf(next));if(!next.staged)tx.objectStore('stages').delete(id);return next; });
  }
  async function reserve(id:string,target:number):Promise<void> {
    if(!Number.isSafeInteger(target)||target<0||target>20000)throw new Error('capacity_exceeded');
    await transaction(['mappings','nodes'],async tx=>{
      const mappings=await result<LocalMapping[]>(tx.objectStore('mappings').getAll()); const nodes=await result<OwnedNode[]>(tx.objectStore('nodes').getAll());
      const row=mappings.find(m=>m.id===id);if(!row)throw new Error('mapping_missing');
      assertCapacity(mappings.map(m=>m.id===id?{...m,reserved:target}:m),nodes);
      await result(tx.objectStore('mappings').put({...row,reserved:target}));
    });
  }
  async function reserveCopy(id:string,taskId:string,epoch:number,count:number):Promise<void> {
    if(!Number.isSafeInteger(count)||count<1||count>20000)throw new Error('capacity_exceeded');
    await transaction(['mappings','nodes'],async tx=>{
      const mappings=await result<LocalMapping[]>(tx.objectStore('mappings').getAll());
      const nodes=await result<OwnedNode[]>(tx.objectStore('nodes').getAll());
      const row=mappings.find(m=>m.id===id);
      if(!row||row.applyEpoch!==epoch)throw new Error('apply_epoch_changed');
      if(row.cleanup||row.state==='detached'||row.state==='terminating')throw new Error('cleanup_pending');
      const prior=row.copyReservations?.[taskId];
      if(prior!==undefined&&prior!==count)throw new Error('copy_reservation_conflict');
      const next={...row,copyReservations:{...row.copyReservations,[taskId]:count}};
      assertCapacity(mappings.map(m=>m.id===id?next:m),nodes);
      await result(tx.objectStore('mappings').put(next));
    });
  }
  async function terminal(ack:AckRecord,preserve:boolean):Promise<AckRecord> {
    return transaction(['acks','mappings','nodes','exclusions','operations','meta','tokens','stages'],async tx=>{
      if(preserve!==(ack.result==='kept'))throw new Error('terminal_result_invalid');
      const old=await result<AckRecord|undefined>(tx.objectStore('acks').get(ack.id));if(old)return old;
      const mapping=await result<LocalMapping|undefined>(tx.objectStore('mappings').get(ack.mappingId));
      const nodes=await result<OwnedNode[]>(tx.objectStore('nodes').getAll());
      const operations=await result<NativeOperation[]>(tx.objectStore('operations').getAll());
      if(operations.some(o=>o.mappingId===ack.mappingId&&o.generation===ack.generation&&(o.phase!=='received'||!o.settled)))throw new Error('recovery_identity_uncertain');
      if(mapping&&(mapping.mapping.generation!==ack.generation||mapping.applyEpoch!==ack.expectedEpoch))throw new Error('generation_mismatch');
      const owned=nodes.filter(n=>n.mappingId===ack.mappingId&&n.generation===ack.generation);
      if(ack.result==='kept'){
        const scan=await result<{value:{scanId:string;epoch:number;complete:boolean;full:boolean;ownershipDigest:string}}|undefined>(tx.objectStore('meta').get('scan:'+ack.mappingId));
        if(!mapping||!scan||scan.value.scanId!==ack.scanId||scan.value.epoch!==mapping.applyEpoch||!scan.value.complete||!scan.value.full||scan.value.ownershipDigest!==ownershipDigest(owned))throw new Error('keep_proof_incomplete');
      }
      if(ack.result==='removed_access_lost'&&mapping?.state!=='access_lost')throw new Error('access_proof_missing');
      if(ack.result!=='kept'&&owned.length)throw new Error('cleanup_incomplete');
      for(const node of nodes.filter(n=>n.mappingId===ack.mappingId&&n.generation===ack.generation)){
        if(preserve)tx.objectStore('exclusions').put({id:node.nativeId,nativeId:node.nativeId,reason:'preserved',accountId:ack.scope.accountId,serverOrigin:ack.scope.serverOrigin});
        tx.objectStore('nodes').delete(node.id);
      }
      if(mapping){const detached:LocalMapping={...mapping,enabled:false,state:'detached',applyEpoch:mapping.applyEpoch+1,reserved:0,copyReservations:undefined,staged:undefined,cleanup:false};tx.objectStore('mappings').put(detached);tx.objectStore('tokens').put(tokenOf(detached));tx.objectStore('stages').delete(mapping.id);}
      tx.objectStore('acks').put(ack);return ack;
    });
  }
  async function prepareCleanup(accountId:string,serverOrigin:string):Promise<void>{
    await transaction(['mappings','tokens','stages','meta'],async tx=>{const rows=await result<LocalMapping[]>(tx.objectStore('mappings').getAll());for(const row of rows)if(row.scope.accountId===accountId&&row.scope.serverOrigin===serverOrigin&&row.state!=='detached'){const next:LocalMapping={...row,enabled:false,cleanup:true,applyEpoch:row.applyEpoch+1,state:'terminating',staged:undefined};tx.objectStore('mappings').put(next);tx.objectStore('tokens').put(tokenOf(next));tx.objectStore('stages').delete(row.id);}tx.objectStore('meta').delete('external-draft');});
  }
  async function fenceExit(scope:AccountScope,targets:readonly {mappingId:string;generation:string}[],intentId:string,confirmed:boolean){
    await transaction(['mappings','tokens','stages','meta'],async tx=>{
      const key='exit-fence:'+intentId;if(await result(tx.objectStore('meta').get(key)))return;
      for(const target of targets){const row=await result<LocalMapping|undefined>(tx.objectStore('mappings').get(target.mappingId));
        if(!row||row.mapping.generation!==target.generation||row.scope.accountId!==scope.accountId||row.scope.serverOrigin!==scope.serverOrigin||row.scope.profileId!==scope.profileId||row.state==='detached')continue;
        const next:LocalMapping={...row,enabled:false,applyEpoch:row.applyEpoch+1,staged:undefined,state:confirmed?'terminating':'paused',error:'exit_pending'};
        tx.objectStore('mappings').put(next);tx.objectStore('tokens').put(tokenOf(next));tx.objectStore('stages').delete(row.id);
      }
      tx.objectStore('meta').put({id:key,value:true});
    });
  }
  async function stage(row:LocalMapping,snapshot:Pick<StagedProjection,'descriptor'|'nodes'>){
    return transaction(['mappings','stages'],async tx=>{const current=await result<LocalMapping|undefined>(tx.objectStore('mappings').get(row.id));if(!current||current.applyEpoch!==row.applyEpoch||current.mapping.generation!==row.mapping.generation||!current.enabled||current.cleanup)throw new Error('apply_epoch_changed');const next:LocalMapping={...current,staged:{descriptor:snapshot.descriptor},state:'applying'};tx.objectStore('stages').put({id:row.id,generation:row.mapping.generation,applyEpoch:row.applyEpoch,...snapshot});tx.objectStore('mappings').put(next);return next;});
  }
  async function beginIntent<T extends {used:boolean;mappingId:string;epoch:number}>(key:string):Promise<T>{
    return transaction(['meta','mappings','tokens','stages'],async tx=>{
      const saved=await result<{id:string;value:T}|undefined>(tx.objectStore('meta').get(key));if(!saved)throw new Error('preview_invalid');if(saved.value.used)return saved.value;
      const row=await result<LocalMapping|undefined>(tx.objectStore('mappings').get(saved.value.mappingId));if(!row||row.applyEpoch!==saved.value.epoch)throw new Error('preview_changed');
      const value={...saved.value,used:true,epoch:row.applyEpoch+1};tx.objectStore('meta').put({...saved,value});const next={...row,enabled:false,applyEpoch:value.epoch,staged:undefined};tx.objectStore('mappings').put(next);tx.objectStore('tokens').put(tokenOf(next));tx.objectStore('stages').delete(row.id);return value;
    });
  }
  async function completeCopy(mappingId:string,taskId:string,epoch:number,scanId:string,count:number,rootNativeId:string,reuse:{scope:AccountScope;treeDigest:string}){
    await transaction(['mappings','nodes','exclusions','operations','meta'],async tx=>{
      const row=await result<LocalMapping|undefined>(tx.objectStore('mappings').get(mappingId));if(!row||row.applyEpoch!==epoch)throw new Error('apply_epoch_changed');
      const nodes=(await result<OwnedNode[]>(tx.objectStore('nodes').getAll())).filter(n=>n.mappingId===mappingId);const copies=nodes.filter(n=>n.copyTaskId===taskId);
      const scan=await result<{value:{scanId:string;epoch:number;complete:boolean;full:boolean;ownershipDigest:string}}|undefined>(tx.objectStore('meta').get('scan:'+mappingId));
      if(copies.length!==count||!scan?.value.complete||!scan.value.full||scan.value.scanId!==scanId||scan.value.epoch!==epoch||scan.value.ownershipDigest!==ownershipDigest(nodes))throw new Error('keep_proof_incomplete');
      const ops=await result<NativeOperation[]>(tx.objectStore('operations').getAll());if(ops.some(o=>o.copyTaskId===taskId&&(!o.settled||o.phase!=='received')))throw new Error('recovery_identity_uncertain');
      for(const node of copies){tx.objectStore('exclusions').put({id:node.nativeId,nativeId:node.nativeId,reason:'preserved',accountId:row.scope.accountId,serverOrigin:row.scope.serverOrigin});tx.objectStore('nodes').delete(node.id);}
      const copyReservations={...row.copyReservations};
      delete copyReservations[taskId];
      tx.objectStore('mappings').put({...row,copyReservations:Object.keys(copyReservations).length?copyReservations:undefined});
      const receipt:CompletedCopy={rootNativeId,count,completedAt:Date.now(),nodes:copies.map(node=>({
        nativeId:node.nativeId,parentNativeId:node.parentNativeId,fingerprint:node.fingerprint,
      }))};
      const candidate:CopyCandidate={scope:reuse.scope,generation:row.mapping.generation,taskId,treeDigest:reuse.treeDigest};
      tx.objectStore('meta').put({id:'copy-receipt:'+taskId,value:receipt});
      tx.objectStore('meta').put({id:'copy-candidate:'+mappingId,value:candidate});
    });
  }
  async function pruneSettledOperations(now = Date.now()): Promise<void> {
    const settled = (await all('operations')).filter((op) => op.settled === true && op.phase === 'received'
      && (op.eventConsumed === true || op.createdAt < now - SETTLED_OPERATION_GRACE_MS));
    settled.sort((left, right) => left.createdAt - right.createdAt);
    const extra = settled.length - SETTLED_OPERATION_MAX;
    for (const op of settled.slice(0, Math.max(0, extra))) await remove('operations', op.id);
  }
  return {get,all,count,put,remove,changeOperation,pendingOperations,settlePreservation,operationsForNative,operationForLocalKey,nodeForNative,nodeChildrenCount,nodesForMapping,changeMapping,reserve,reserveCopy,terminal,prepareCleanup,fenceExit,stage,beginIntent,completeCopy,pruneSettledOperations,ready:async()=>{await db();},close:async()=>{(await db()).close();opened=undefined;}};
}
/** Settled receipts stay long enough for the native bookmark event, then only the newest few. */
export const SETTLED_OPERATION_GRACE_MS = 60_000;
export const SETTLED_OPERATION_MAX = 32;
export type SubscriptionStore = ReturnType<typeof createSubscriptionStore>;
export const subscriptionStore = createSubscriptionStore();

export function ownershipDigest(nodes:OwnedNode[]):string{return digest([...nodes].sort((a,b)=>a.id.localeCompare(b.id)).map(n=>[n.id,n.nativeId,n.generation,n.key,n.parentNativeId??null,n.fingerprint,n.ref??null]));}

function tokenOf(row:LocalMapping):MappingToken{return {id:row.id,generation:row.mapping.generation,applyEpoch:row.applyEpoch,enabled:row.enabled,cleanup:Boolean(row.cleanup)};}

/** Projection and each unfinished copy own separate reservations until conversion/cleanup. */
function assertCapacity(mappings:LocalMapping[],nodes:OwnedNode[]):void {
  const owned=new Map<string,{base:number;copies:Map<string,number>}>();
  for(const node of nodes){
    let usage=owned.get(node.mappingId);
    if(!usage){usage={base:0,copies:new Map()};owned.set(node.mappingId,usage);}
    if(node.copyTaskId)usage.copies.set(node.copyTaskId,(usage.copies.get(node.copyTaskId)??0)+1);
    else usage.base++;
  }
  let total=0;
  for(const mapping of mappings){
    const usage=owned.get(mapping.id);
    total+=Math.max(mapping.reserved,usage?.base??0);
    const tasks=new Set([...Object.keys(mapping.copyReservations??{}),...(usage?.copies.keys()??[])]);
    for(const task of tasks)total+=Math.max(mapping.copyReservations?.[task]??0,usage?.copies.get(task)??0);
  }
  if(total>20000||mappings.filter(m=>m.state!=='detached').length>50)throw new Error('capacity_exceeded');
}
