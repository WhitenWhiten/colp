import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { buildPublicationCollectionPublicAccessSql, buildPublicationBookmarkPublicAccessSql } from '../publication/index.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../modules/commands/index.js';
import { ActorCollectionReadLimitError, type ActorCollectionReadPort, type CollectionReadActor, type ActorCollectionMetadata } from '../../modules/collections/index.js';
import { mapProductAnnotationRow } from './annotation-product-read.js';
const digest=(value:unknown)=>'sha256:'+createHash('sha256').update(canonicalJson(value)).digest('hex');
export function createActorCollectionReader(tx: DatabaseTransaction, origin:string):ActorCollectionReadPort {
  async function metadataMany(actor:CollectionReadActor,requested:readonly string[]):Promise<Map<string,ActorCollectionMetadata>> {
    const ids=[...new Set(requested)];if(ids.length>100)throw new ActorCollectionReadLimitError();if(!ids.length)return new Map();
    const actorAccount=await tx.selectFrom('accounts').select('id').where('id','=',actor.accountId).where('subject_id','=',actor.subjectId).where('status','=','active').where('deleted_at','is',null).executeTakeFirst();if(!actorAccount)return new Map();
    const rows=await tx.selectFrom('collections as c').innerJoin('accounts as owner','owner.subject_id','c.owner_subject_id')
      .leftJoin('collection_members as member',j=>j.onRef('member.collection_id','=','c.id').on('member.subject_id','=',actor.subjectId))
      .selectAll('c').select(['member.role as member_role',sql.raw<boolean>(buildPublicationCollectionPublicAccessSql('c')).as('public_readable')])
      .where('c.id','in',ids).where('c.deleted_at','is',null).where('owner.status','=','active').where('owner.deleted_at','is',null).limit(ids.length).execute();
    const followedIds=new Set((await tx.selectFrom('collection_follows').select('collection_id').where('collection_id','in',ids).where('follower_profile_id','=',actor.accountId).execute()).map(f=>f.collection_id));
    const result=new Map<string,ActorCollectionMetadata>();
    for(const c of rows){const member=c.owner_subject_id===actor.subjectId||c.member_role!=null;
      if(!member&&(!c.public_readable||!c.publication_slug||!c.published_at))continue;
      result.set(c.id,{c:{id:c.id,title:c.title,summary:c.summary,ownerSubjectId:c.owner_subject_id,visibility:c.visibility,rootNodeId:c.root_node_id,contentRevision:c.content_revision,updatedAt:c.updated_at.toISOString()},member,followed:followedIds.has(c.id),shared:c.member_role!=null&&c.owner_subject_id!==actor.subjectId,role:c.owner_subject_id===actor.subjectId||c.member_role==='owner'||c.member_role==='editor'?'editor':'viewer',
        openUrl:origin+(member?'/library/'+encodeURIComponent(c.id):'/c/'+encodeURIComponent(c.publication_slug!)),policyRevision:digest([c.policy_revision,member,c.public_readable])});
    }
    return result;
  }
  async function metadata(actor:CollectionReadActor,id:string){return (await metadataMany(actor,[id])).get(id)??null;}
  async function nodes(actor:CollectionReadActor,id:string,ids?:string[]) {
    const meta=await metadata(actor,id);if(!meta)return null;
    let q=tx.selectFrom('nodes as n').innerJoin('collections as c','c.id','n.collection_id').selectAll('n').where('n.collection_id','=',id).where('n.deleted_at','is',null);
    if(ids) {if(ids.length>20000)throw new ActorCollectionReadLimitError();if(!ids.length)return {meta,rows:[]};q=q.where('n.id','in',ids);}
    // Full trees retain depth-129 descendants so the projector rejects overflow;
    // identity probes deny nodes deeper than the projection budget.
    q=q.where(sql.raw<boolean>(ids?rootedNodeSql:rootedNodeSql.replaceAll('bad.depth>128','bad.depth>129')));
    if(!meta.member) q=q.where(sql.raw<boolean>(buildPublicationBookmarkPublicAccessSql('n','c')));
    const rows=await q.orderBy('n.position_token').orderBy('n.id').limit(ids?ids.length+1:20001).execute();
    if(!ids&&rows.length>20000)throw new ActorCollectionReadLimitError();
    return {meta,rows:rows.map(n=>({id:n.id,parentId:n.parent_id,kind:n.kind,title:n.title,url:n.url,description:n.description,resourceRevision:n.resource_revision,visibility:n.visibility}))};
  }
  async function annotations(actor:CollectionReadActor,id:string,nodeIds:readonly string[]) {
    const meta=await metadata(actor,id);if(!meta)return [];
    // Node ids must come from this transaction's actor-filtered tree. Private
    // annotations remain creator-only, including for collection owners/editors.
    const rows=await tx.selectFrom('annotations').selectAll().where('collection_id','=',id).where('deleted_at','is',null)
      .where(eb=>eb.or([eb.and([eb('subject_type','=','collection'),eb('subject_id','=',id)]),...(nodeIds.length?[eb.and([eb('subject_type','=','node'),eb('subject_id','in',[...nodeIds])])]:[])]))
      .where(eb=>eb.or([eb('creator_principal_id','=',actor.accountId),eb('visibility','in',meta.member?['public','unlisted','protected']:['public','unlisted'])]))
      .orderBy('id').limit(20001).execute();
    if(rows.length>20000)throw new ActorCollectionReadLimitError();
    return rows.map(row=>{const annotation=mapProductAnnotationRow(row).payload;return {id:annotation.id,subjectType:row.subject_type,subjectId:row.subject_id,type:annotation.type,format:annotation.format??null,value:annotation.value};});
  }
  return {metadata,metadataMany,nodes,annotations};
}

// A member projection still cannot expose a deleted/dangling subtree. Every check is bounded independently of full-tree size.
const rootedNodeSql = "exists (with recursive chain as (select n.id,n.parent_id,n.deleted_at,array[n.id] as path,0 as depth,false as cycle union all select p.id,p.parent_id,p.deleted_at,c.path||p.id,c.depth+1,p.id=any(c.path) from nodes p join chain c on p.id=c.parent_id where p.collection_id=n.collection_id and not c.cycle and c.depth<129) select 1 from chain where id=c.root_node_id and not exists(select 1 from chain bad where bad.deleted_at is not null or bad.cycle or bad.depth>128))";
