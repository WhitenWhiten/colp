import type { JsonObject, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Confirmation is bound to this save's original creation revision, never a later pull/edit. */
export async function classificationCreateReceipt(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope,
  nativeId: string, createdAt: number): Promise<{nodeId:string;etag:string}|null> {
  let after=0,createOpId:string|null=null;
  for (;;) {
    const page=await store.listBookmarkEventsByNative(scope,nativeId,after,1000);
    for (const event of page) {
      const occurredAt=Date.parse(event.occurredAt);if(!Number.isFinite(occurredAt))return null;
      if(occurredAt<createdAt)continue;
      if(event.kind==='remove')return null;
      if(event.kind==='create') {
        if(createOpId && createOpId!==event.opId)return null;
        if(!event.opId)return null;
        createOpId=event.opId;
      }
    }
    if(page.length<1000)break;
    after=page[page.length-1]!.ordinal;
  }
  if(!createOpId)return null;
  const queued=await store.getQueueByOpId(scope,createOpId);
  if(!queued||queued.status!=='terminal'||queued.payload.type!=='create_node')return null;
  const receipt=await store.getQueueReceipt(scope,queued.sequence);
  if(receipt?.kind!=='terminal'||receipt.opId!==queued.opId||receipt.operationDigest!==queued.digest)return null;
  const results=receipt.result?.results;
  if(!Array.isArray(results))return null;
  const matching=results.filter(result=>result&&typeof result==='object'&&!Array.isArray(result)&&(result as JsonObject).opId===queued.opId);
  if(matching.length!==1)return null;
  const row=matching[0] as JsonObject|null;
  if(!row||!['applied','rebased'].includes(String(row.status))||typeof row.targetId!=='string'
    ||typeof row.revision!=='string'||row.revision.startsWith('local-')||!/^[\x21\x23-\x7e]+$/u.test(row.revision))return null;
  const mapping=await store.getMappingByNativeId(scope,nativeId);
  if(!mapping||mapping.nodeKind!=='bookmark'||mapping.colpId!==row.targetId||row.targetId.startsWith('pending-'))return null;
  return {nodeId:row.targetId,etag:`"${row.revision}"`};
}
