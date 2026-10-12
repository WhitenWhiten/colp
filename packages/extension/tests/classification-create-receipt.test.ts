import {expect,test} from 'vitest';
import {classificationCreateReceipt} from '../src/classification-create-receipt.js';
import type {createSyncStateStore,SyncScope} from '../src/sync-state-store.js';
function fixture(){
  const events=[{ordinal:1,kind:'create',occurredAt:new Date(100).toISOString(),opId:'create'}];
  const mapping={nodeKind:'bookmark',colpId:'node',projection:{resourceRevision:'later-edit'}};
  const store={listBookmarkEventsByNative:async()=>events,getQueueByOpId:async()=>({status:'terminal',payload:{type:'create_node'},sequence:1,opId:'create',digest:'digest'}),
    getQueueReceipt:async()=>({kind:'terminal',opId:'create',operationDigest:'digest',result:{results:[{opId:'other',status:'applied',targetId:'another-node',revision:'another-revision'},{opId:'create',status:'applied',targetId:'node',revision:'original'}]}}),
    getMappingByNativeId:async()=>mapping} as unknown as ReturnType<typeof createSyncStateStore>;
  return {store,events,mapping};
}
const scope={} as SyncScope;
test('finds the exact operation in a multi-result receipt despite a newer pull revision',async()=>{
  const {store}=fixture();expect(await classificationCreateReceipt(store,scope,'native',90)).toEqual({nodeId:'node',etag:'"original"'});
});
test('rejects old native identity and remove/recreate reuse',async()=>{
  const {store,events}=fixture();expect(await classificationCreateReceipt(store,scope,'native',110)).toBeNull();
  events.push({ordinal:2,kind:'remove',occurredAt:new Date(120).toISOString(),opId:'delete'});
  expect(await classificationCreateReceipt(store,scope,'native',90)).toBeNull();
});
test('rejects a mapping to another node',async()=>{
  const {store,mapping}=fixture();mapping.colpId='other';expect(await classificationCreateReceipt(store,scope,'native',90)).toBeNull();
});
