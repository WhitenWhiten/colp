import { CompiledQuery } from 'kysely';
import { canonicalJson } from '../../modules/commands/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { ActorCollectionReadPort } from '../../modules/collections/index.js';
import { createPostgresTransactionPublicProfileFactsReadPort } from '../identity/postgres-public-profile-read.js';
import type { ReportActorReadPort } from '../../modules/reports/index.js';
import type { SubscriptionSourcePort, SubscriptionActor, SourceRef, SourceView, SourceProjection, SourceNodeRef, ProjectionNode } from '../../modules/bookmark-subscriptions/index.js';
import { fail, digest } from '../../modules/bookmark-subscriptions/index.js';

function safeBookmarkUrl(value:string|null):boolean {try{const url=new URL(value??'');return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}}
export const sourceNodeKey=(parts:unknown[]):string=>canonicalJson(parts);
export function decodeSourceNodeKey(key:string):SourceNodeRef|null {
  try {const p=JSON.parse(key);if(p[0]==='collection')return {sourceCollectionId:p[1],nodeId:p[2],editionId:null};if(p[0]==='digest')return {sourceCollectionId:p[3],nodeId:p[4],editionId:p[2]};}catch {return null;}return null;
}
export function createBookmarkSubscriptionSources(tx:DatabaseTransaction,options:{origin:string;reportsEnabled?:boolean},collections:ActorCollectionReadPort,reports:ReportActorReadPort):SubscriptionSourcePort & {
  memberSeries(actor:SubscriptionActor,id:string):Promise<SourceView|null>;
  memberEditions(actor:SubscriptionActor,id:string,after?:string,limit?:number):Promise<SourceProjection['editions']>;
  memberEdition(actor:SubscriptionActor,id:string,editionId:string):Promise<SourceProjection|null>;
} {
  const profiles=createPostgresTransactionPublicProfileFactsReadPort(tx);
  async function owner(id:string) {const p=await profiles.findByOwnerSubjectId(id);return p?{displayName:p.displayName,handle:p.handle}:null;}
  async function series(actor:SubscriptionActor,id:string) {
    if(options.reportsEnabled===false) return fail('feature_temporarily_unavailable');
    return reports.series(actor,id);
  }
  async function get(actor:SubscriptionActor,ref:SourceRef,requireRelation=true):Promise<SourceView|null> {
    if(ref.sourceType==='collection') {
      const m=await collections.metadata(actor,ref.sourceId);if(!m)return null;
      const relations:SourceView['relations']=[];if(m.followed)relations.push('followed');if(m.shared)relations.push('shared');if(requireRelation&&!relations.length)return null;
      return {...ref,title:m.c.title,owner:await owner(m.c.ownerSubjectId),visibility:m.c.visibility,relations,sourceRole:m.role,openUrl:m.openUrl,updatedAt:m.c.updatedAt,allowedMappingModes:['readonly']};
    }
    const m=await series(actor,ref.sourceId);if(!m)return null;
    const follow=m.followed;
    const relations:SourceView['relations']=[];if(follow)relations.push('followed');if(m.memberRole&&m.s.ownerSubjectId!==actor.subjectId)relations.push('shared');if(requireRelation&&!relations.length)return null;
    return {...ref,title:m.s.title,owner:await owner(m.s.ownerSubjectId),visibility:m.s.visibility,relations,sourceRole:m.s.ownerSubjectId===actor.subjectId||m.memberRole==='editor'||m.memberRole==='owner'?'editor':'viewer',openUrl:options.origin+(m.member?'/library/digests/'+encodeURIComponent(m.s.id)+'/read':'/reports/'+encodeURIComponent(m.s.slug??m.s.id)),updatedAt:m.s.updatedAt!,allowedMappingModes:['readonly']};
  }
  async function readableEdition(actor:SubscriptionActor,seriesId:string,id:string) {
    const s=await series(actor,seriesId);if(!s)return null;
    const e=await reports.publishedEdition(actor,seriesId,id);if(!e)return null;
    const c=await collections.metadata(actor,e.sourceCollectionId);return c?{e,c,s}:null;
  }
  async function editions(actor:SubscriptionActor,id:string,limit:number,after?:string) {
    const result:Awaited<ReturnType<typeof readableEdition>>[]=[];const s=await series(actor,id);if(!s)return [];let scan=0;let cursor=after?JSON.parse(after) as {publishedAt:string;ordinal:string;id:string}:undefined;
    while(result.length<limit) {
      const candidates=await reports.publishedCandidates(id,Math.min(100,10001-scan),cursor?{publishedAt:cursor.publishedAt,editionOrdinal:Number(cursor.ordinal),id:cursor.id}:undefined);
      if(!candidates.length)break;
      const metadata=await collections.metadataMany(actor,candidates.map(e=>e.sourceCollectionId));
      const hidden=s.member?new Set<string>():await reports.hiddenPublishedEditionIds(candidates.map(e=>e.id));
      for(const e of candidates) {scan++;if(scan>10000)fail('payload_too_large');cursor={publishedAt:e.publishedAt!,ordinal:String(e.editionOrdinal),id:e.id};const c=metadata.get(e.sourceCollectionId);if(c&&!hidden.has(e.id))result.push({e,c,s});if(result.length===limit)break;}
      if(candidates.length<100)break;
    }
    return result.filter((x):x is NonNullable<typeof x>=>x!==null);
  }
  async function project(actor:SubscriptionActor,ref:SourceRef,mode:'latest'|'recent'|null,limit:number|null,oneEdition?:string):Promise<SourceProjection|null> {
    const source=await get(actor,ref,false);if(!source)return null;
    const rootKey=sourceNodeKey(['synthetic','root',ref.sourceType,ref.sourceId]);const nodes:ProjectionNode[]=[{key:rootKey,parentKey:null,index:0,kind:'folder',role:'root',editionId:null,title:source.title},{key:sourceNodeKey(['synthetic','source_link',ref.sourceType,ref.sourceId]),parentKey:rootKey,index:0,kind:'bookmark',role:'source_link',editionId:null,title:ref.sourceType==='collection'?'Open collection':'Open Digest',url:source.openUrl}];
    const revisions:unknown[]=[];const policy:unknown[]=[];const skipped={unsupported_node:0,unsafe_url:0};
    const selected=ref.sourceType==='digest_series'?(oneEdition?[await readableEdition(actor,ref.sourceId,oneEdition)].filter((x):x is NonNullable<typeof x>=>x!==null):await editions(actor,ref.sourceId,limit??1)):[];
    if(oneEdition&&!selected.length)return null;
    const targets=ref.sourceType==='collection'?[{collectionId:ref.sourceId,edition:null}]:selected.map(x=>({collectionId:x.e.sourceCollectionId,edition:x.e}));
    for(const target of targets) {
      const read=await collections.nodes(actor,target.collectionId);if(!read)return null;
      const {meta,rows}=read;const editionId=target.edition?.id??null;let parentKey=rootKey;let startIndex=1;
      revisions.push([meta.c.id,meta.c.contentRevision,target.edition?.resourceRevision??null]);policy.push([meta.c.id,meta.policyRevision]);
      if(target.edition) {
        if(mode==='recent') {parentKey=sourceNodeKey(['synthetic','edition_folder',ref.sourceId,editionId]);nodes.push({key:parentKey,parentKey:rootKey,index:nodes.filter(n=>n.parentKey===rootKey).length,kind:'folder',role:'edition_folder',editionId,title:target.edition.titleSnapshot});startIndex=0;}
        nodes.push({key:sourceNodeKey(['synthetic','edition_link',ref.sourceId,editionId]),parentKey,index:startIndex++,kind:'bookmark',role:'edition_link',editionId,title:'Read full edition',url:options.origin+((await series(actor,ref.sourceId))!.member?'/library/digests/'+encodeURIComponent(ref.sourceId)+'/issues/'+encodeURIComponent(editionId!)+'/read':'/reports/'+encodeURIComponent((await series(actor,ref.sourceId))!.s.slug??ref.sourceId)+'/issues/'+encodeURIComponent(target.edition.id))});
      }
      const children=new Map<string,typeof rows>();for(const row of rows) {if(row.parentId){const a=children.get(row.parentId)??[];a.push(row);children.set(row.parentId,a);}}
      if(!rows.some(r=>r.id===meta.c.rootNodeId))continue;
      const stack=[{id:meta.c.rootNodeId,key:parentKey,depth:0,start:startIndex}];const seen=new Set<string>();
      while(stack.length) {
        const entry=stack.pop()!;if(entry.depth>128||seen.has(entry.id))fail('payload_too_large');seen.add(entry.id);
        const pending:typeof stack=[];let index=entry.start;
        for(const row of children.get(entry.id)??[]) {
          if(entry.depth+1>128)fail('payload_too_large');
          if(row.kind==='separator') {skipped.unsupported_node++;continue;}
          if(row.kind==='bookmark'&&!safeBookmarkUrl(row.url)){skipped.unsafe_url++;continue;}
          const key=sourceNodeKey(editionId?['digest',ref.sourceId,editionId,target.collectionId,row.id]:['collection',target.collectionId,row.id]);
          nodes.push({key,parentKey:entry.key,index:index++,kind:row.kind,role:'content',editionId,title:row.title??'',...(row.kind==='bookmark'?{url:row.url!}:{})});
          if(nodes.length>20000)fail('payload_too_large');if(row.kind==='folder')pending.push({id:row.id,key,depth:entry.depth+1,start:0});
        }
        stack.push(...pending.reverse());
      }
    }
    // Explicit pre-order is independent of SQL row ordering and stable across pages.
    const byParent=new Map<string,ProjectionNode[]>();for(const n of nodes)if(n.parentKey){const a=byParent.get(n.parentKey)??[];a.push(n);byParent.set(n.parentKey,a);}
    const ordered:ProjectionNode[]=[];const stack=[nodes[0]!];while(stack.length){const n=stack.pop()!;ordered.push(n);stack.push(...(byParent.get(n.key)??[]).sort((a,b)=>a.index-b.index).reverse());}
    if(ordered.length>20000||Buffer.byteLength(JSON.stringify(ordered))>33554432)fail('payload_too_large');
    if(ref.sourceType==='digest_series'){const s=await series(actor,ref.sourceId);policy.push([s!.s.policyRevision,s!.member,s!.hidden]);revisions.push(s!.s.contentRevision);}
    return {source,nodes:ordered,policyRevision:digest(policy),contentRevision:digest(revisions),editions:selected.map(x=>({editionId:x.e.id,title:x.e.titleSnapshot,publishedAt:x.e.publishedAt!})),skippedByReason:Object.entries(skipped).filter(([,n])=>n>0).map(([reason,count])=>({reason:reason as 'unsupported_node'|'unsafe_url',count}))};
  }
  async function check(actor:SubscriptionActor,ref:SourceRef,editionIds:string[],nodes:SourceNodeRef[]=[]){
    const source=await get(actor,ref,false);if(!source)return {available:false,removeEditionIds:[],removeNodes:[],authorityRevision:digest([ref,'unavailable'])};
    const removeEditionIds:string[]=[];const removeNodes:SourceNodeRef[]=[];const facts:unknown[]=[];
    if(ref.sourceType==='collection'){const c=await collections.metadata(actor,ref.sourceId);facts.push(c?.policyRevision??null);}else{const s=await series(actor,ref.sourceId);facts.push([s?.s.policyRevision??null,s?.member??null,s?.hidden??null]);}
    const checked=new Map<string,Awaited<ReturnType<typeof readableEdition>>>();
    if(ref.sourceType==='digest_series')for(const id of new Set([...editionIds,...nodes.map(n=>n.editionId).filter((x):x is string=>x!==null)])){const e=await readableEdition(actor,ref.sourceId,id);checked.set(id,e);facts.push([id,e?.e.resourceRevision??null,e?.s.s.policyRevision??null,e?.s.member??null,e?.c.policyRevision??null]);if(!e&&editionIds.includes(id))removeEditionIds.push(id);}
    const groups=new Map<string,SourceNodeRef[]>();for(const n of nodes){const e=n.editionId?checked.get(n.editionId):null;const valid=ref.sourceType==='collection'?n.editionId===null&&n.sourceCollectionId===ref.sourceId:!!e&&e.e.sourceCollectionId===n.sourceCollectionId;if(!valid){removeNodes.push(n);continue;}const g=groups.get(n.sourceCollectionId)??[];g.push(n);groups.set(n.sourceCollectionId,g);}
    for(const [id,refs]of groups){const read=await collections.nodes(actor,id,refs.map(n=>n.nodeId));const allowed=new Set(read?.rows.filter(r=>r.id!==read.meta.c.rootNodeId&&r.kind!=='separator'&&(r.kind==='folder'||safeBookmarkUrl(r.url))).map(r=>r.id)??[]);for(const n of refs)if(!allowed.has(n.nodeId))removeNodes.push(n);facts.push([id,read?.meta.policyRevision??null,read?.rows.map(n=>[n.id,n.resourceRevision,n.visibility])??null]);}
    return {available:true,removeEditionIds,removeNodes,authorityRevision:digest([ref,editionIds,nodes,facts,removeNodes])};
  }
  return {get,project,check,async list(actor,filter,after,limit=20){
    if(filter.sourceType!=='collection'&&options.reportsEnabled===false)fail('feature_temporarily_unavailable');
    let anchor=after?JSON.parse(after) as [string,string,string]:null;const result:SourceView[]=[];
    while(result.length<limit) {
      const statement=[
        "with candidates as (select c.id as source_id,'collection'::text as source_type,date_trunc('milliseconds',c.updated_at) as updated_at,exists(select 1 from collection_follows f where f.collection_id=c.id and f.follower_profile_id=$1) as followed,exists(select 1 from collection_members m where m.collection_id=c.id and m.subject_id=$2 and c.owner_subject_id<>$2) as shared from collections c where c.deleted_at is null",
        "union all select s.id,'digest_series',date_trunc('milliseconds',s.updated_at),exists(select 1 from digest_follows f where f.series_id=s.id and f.follower_profile_id=$1 and f.unfollowed_at is null),exists(select 1 from digest_members m where m.series_id=s.id and m.subject_id=$2 and m.revoked_at is null and s.owner_subject_id<>$2) from digest_series s where s.deleted_at is null and s.state='active')",
        "select source_id,source_type,updated_at from candidates where (followed or shared) and ($3::text is null or source_type=$3) and ($4::text is null or ($4='followed' and followed) or ($4='shared' and shared)) and ($5::timestamptz is null or updated_at<$5 or (updated_at=$5 and (source_type>$6 or (source_type=$6 and source_id>$7)))) order by updated_at desc,source_type,source_id limit 100"
      ].join(' ');
      const rows=(await tx.executeQuery<{source_id:string;source_type:SourceRef['sourceType'];updated_at:Date}>(CompiledQuery.raw(statement,[actor.accountId,actor.subjectId,filter.sourceType??null,filter.relation??null,anchor?.[0]??null,anchor?.[1]??null,anchor?.[2]??null]))).rows;
      for(const row of rows){anchor=[row.updated_at.toISOString(),row.source_type,row.source_id];const v=await get(actor,{sourceType:row.source_type,sourceId:row.source_id});if(v&&(!filter.q||(v.title+' '+(v.owner?.displayName??'')).toLowerCase().includes(filter.q.toLowerCase())))result.push(v);if(result.length>=limit)break;}
      if(rows.length<100)break;
    }
    return result;
  },async memberSeries(actor,id){const s=await series(actor,id);return s?.member?get(actor,{sourceType:'digest_series',sourceId:id},false):null;},async memberEditions(actor,id,after,limit=20){const s=await series(actor,id);if(!s?.member)return fail('resource_not_found');let anchor:string|undefined;if(after){const e=await readableEdition(actor,id,after);if(!e)fail('invalid_cursor');anchor=JSON.stringify({publishedAt:e.e.publishedAt!,ordinal:String(e.e.editionOrdinal),id:e.e.id});}return (await editions(actor,id,limit,anchor)).map(x=>({editionId:x.e.id,title:x.e.titleSnapshot,publishedAt:x.e.publishedAt!}));},async memberEdition(actor,id,editionId){const s=await series(actor,id);if(!s?.member)return null;const projection=await project(actor,{sourceType:'digest_series',sourceId:id},'latest',1,editionId);if(!projection)return null;
    const selected=await readableEdition(actor,id,editionId);if(!selected)return null;
    const read=await collections.nodes(actor,selected.e.sourceCollectionId);if(!read)return null;
    const refs=new Map(projection.nodes.filter(n=>n.role==='content').map(n=>[decodeSourceNodeKey(n.key)!.nodeId,n.key]));
    const annotations=await collections.annotations(actor,selected.e.sourceCollectionId,[...refs.keys()]);
    const reader={seriesSummary:s.s.summary,editionSummary:selected.e.summarySnapshot,sourceSummary:read.meta.c.summary,notes:read.rows.filter(n=>refs.has(n.id)).map(n=>({key:refs.get(n.id)!,description:n.description})),annotations};
    if(Buffer.byteLength(JSON.stringify({projection,reader}))>33554432)fail('payload_too_large');
    return {...projection,reader};}};
}
