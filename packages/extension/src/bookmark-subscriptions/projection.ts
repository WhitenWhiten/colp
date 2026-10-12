import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NodePage, ProjectionNode, SnapshotDescriptor, SourceNodeRef, SourceRef } from './contracts.js';
import type { ProductClient } from './product-client.js';
export function canonical(value:unknown):string {if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';}
export function digest(value:unknown):string{return 'sha256:'+bytesToHex(sha256(new TextEncoder().encode(canonical(value))));}
export function sourceNodeKey(source:SourceRef,ref:SourceNodeRef):string{return JSON.stringify(source.sourceType==='collection'?['collection',ref.sourceCollectionId,ref.nodeId]:['digest',source.sourceId,ref.editionId,ref.sourceCollectionId,ref.nodeId]);}
export function nodeRef(node:ProjectionNode,source:SourceRef):SourceNodeRef|undefined {
  if(node.role!=='content')return undefined;
  let key:unknown;try{key=JSON.parse(node.key);}catch{throw new Error('projection_key_invalid');}
  if(!Array.isArray(key)||!key.every(v=>typeof v==='string'))throw new Error('projection_key_invalid');
  if(source.sourceType==='collection'&&key.length===3&&key[0]==='collection'&&key[1]===source.sourceId&&node.editionId===null)return {sourceCollectionId:key[1],nodeId:key[2]!,editionId:null};
  if(source.sourceType==='digest_series'&&key.length===5&&key[0]==='digest'&&key[1]===source.sourceId&&key[2]===node.editionId)return {sourceCollectionId:key[3]!,nodeId:key[4]!,editionId:key[2]!};
  throw new Error('projection_key_invalid');
}
export function safeUrl(value:string):boolean{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}
export function validateSnapshot(descriptor:SnapshotDescriptor,nodes:ProjectionNode[]):void {
  if(descriptor.projectionVersion!=='1'||descriptor.maxPageSize!==200||nodes.length!==descriptor.counts.nodes||nodes.length>20000||nodes.length===0||!Number.isFinite(Date.parse(descriptor.expiresAt))||Date.parse(descriptor.expiresAt)<=Date.now())throw new Error('snapshot_invalid');
  const encoded=canonical(nodes);if(new TextEncoder().encode(encoded).length>33554432||digest(nodes)!==descriptor.contentDigest)throw new Error('snapshot_digest_invalid');
  const seen=new Map<string,{node:ProjectionNode;depth:number}>();const editions=new Set<string>();let bookmarks=0;const indices=new Map<string,number>();
  for(const n of nodes){
    if(typeof n.key!=='string'||seen.has(n.key)||typeof n.title!=='string'||!Number.isSafeInteger(n.index)||n.index<0||!['folder','bookmark'].includes(n.kind)||!['root','content','source_link','edition_folder','edition_link'].includes(n.role))throw new Error('snapshot_invalid');
    const parent=n.parentKey===null?undefined:seen.get(n.parentKey);const depth=parent?parent.depth+1:0;
    if(depth>128||(n.parentKey!==null&&(!parent||parent.node.kind!=='folder'))||(n.parentKey===null&&(n.role!=='root'||n.key!==descriptor.rootKey||seen.size!==0))||(n.role==='root'&&n.parentKey!==null))throw new Error('snapshot_tree_invalid');
    if(n.kind==='bookmark'?typeof n.url!=='string'||!safeUrl(n.url):n.url!==undefined)throw new Error('snapshot_url_invalid');
    if(n.parentKey!==null){const previous=indices.get(n.parentKey)??-1;if(n.index<=previous)throw new Error('snapshot_order_invalid');indices.set(n.parentKey,n.index);}
    if(n.editionId!==null)editions.add(n.editionId);
    if(n.role==='content'){nodeRef(n,descriptor.source);if(n.kind==='bookmark')bookmarks++;}
    if(descriptor.source.sourceType==='digest_series'&&['content','edition_folder','edition_link'].includes(n.role)&&!n.editionId)throw new Error('projection_key_invalid');
    seen.set(n.key,{node:n,depth});
  }
  if(bookmarks!==descriptor.counts.bookmarks||editions.size!==descriptor.counts.editions||editions.size>20||editions.size>(descriptor.editionLimit??20))throw new Error('snapshot_counts_invalid');
}
export async function downloadSnapshot(client:ProductClient,body:unknown,commandId:string):Promise<{descriptor:SnapshotDescriptor;nodes:ProjectionNode[]}>{
  const descriptor=(await client.request<SnapshotDescriptor>('/me/bookmark-subscription-snapshots',{method:'POST',body,commandId})).data;
  const nodes:ProjectionNode[]=[];const cursors=new Set<string>();let cursor:string|null=null;let bytes=0;
  do {
    const page:NodePage=(await client.request<NodePage>('/me/bookmark-subscription-snapshots/'+encodeURIComponent(descriptor.snapshotId)+'/nodes'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{maxBytes:262144})).data;
    if(page.snapshotId!==descriptor.snapshotId||page.projectionRevision!==descriptor.projectionRevision||!Array.isArray(page.items)||page.items.length>200||page.complete!==(page.nextCursor===null)||(!page.complete&&page.items.length===0))throw new Error('snapshot_incomplete');
    nodes.push(...page.items);bytes+=new TextEncoder().encode(canonical(page.items)).length;if(nodes.length>20000||bytes>33554432)throw new Error('payload_too_large');
    cursor=page.nextCursor;if(cursor){if(cursors.has(cursor))throw new Error('snapshot_cursor_cycle');cursors.add(cursor);}
  }while(cursor);
  validateSnapshot(descriptor,nodes);return {descriptor,nodes};
}
