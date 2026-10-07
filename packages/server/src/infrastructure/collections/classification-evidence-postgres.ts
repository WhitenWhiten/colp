import {createHash,randomUUID} from 'node:crypto';
import {sql,type Kysely} from 'kysely';
import {normalizeClassificationHostname,type ClassificationEvidencePort,type ClassificationHostnameEvidence} from '../../modules/collections/index.js';
import type {DatabaseTransaction} from '../database/unit-of-work.js';
import type {DatabaseSchema} from '../database/runtime.js';
export function createClassificationEvidencePort(tx:DatabaseTransaction):ClassificationEvidencePort {
  return {async append(input){
    const account=await tx.selectFrom('accounts').select('id').where('subject_id','=',input.ownerSubjectId).executeTakeFirst();
    if(!account)return;
    const preference=await tx.selectFrom('bookmark_preferences').select('learn_from_corrections').where('account_id','=',account.id).forUpdate().executeTakeFirst();
    if(preference?.learn_from_corrections===false)return;
    const erased=await tx.selectFrom('classification_evidence_erasure').select('node_id').where('owner_subject_id','=',input.ownerSubjectId)
      .where('source','=',input.source).where('command_id','=',input.commandId).where('node_id','=',input.nodeId).executeTakeFirst();
    if(erased)return;
    await tx.insertInto('bookmark_capture_learning').values({account_id:account.id,generation:0,cleared_at:null}).onConflict(c=>c.column('account_id').doNothing()).execute();
    const learning=await tx.selectFrom('bookmark_capture_learning').select('generation').where('account_id','=',account.id).forUpdate().executeTakeFirst();
    const node=await tx.selectFrom('nodes as n').innerJoin('collections as c','c.id','n.collection_id').select(['n.url','n.parent_id'])
      .where('n.id','=',input.nodeId).where('n.collection_id','=',input.collectionId).where('n.kind','=','bookmark').where('n.deleted_at','is',null)
      .where('c.owner_subject_id','=',input.ownerSubjectId).where('c.deleted_at','is',null).executeTakeFirst();
    const hostname=node?.url?normalizeClassificationHostname(node.url):null;if(!hostname)return;
    if(input.folderId!==null&&node?.parent_id!==input.folderId)throw new Error('classification_evidence_folder_mismatch');
    if(input.folderId===null&&!input.addTags.length)return;
    await tx.insertInto('collection_classification_evidence').values({evidence_id:randomUUID(),collection_id:input.collectionId,owner_subject_id:input.ownerSubjectId,node_id:input.nodeId,
      hostname,folder_id:input.folderId,source:input.source,command_id:input.commandId,operation_id:input.operationId??null,taxonomy_revision:input.taxonomyRevision,
      bookmark_key:createHash('sha256').update(node!.url!).digest('hex'),evidence_generation:learning?.generation??0,created_at:sql<Date>`clock_timestamp()`,
      tag_count:input.addTags.length,tag_digest:input.addTags.length?createHash('sha256').update(JSON.stringify(input.addTags)).digest('hex'):null})
      .onConflict(conflict=>conflict.columns(['source','command_id','node_id']).doNothing()).execute();
  }};
}
export async function readClassificationHostnameEvidence(tx:DatabaseTransaction,input:{collectionId:string;ownerSubjectId:string;taxonomyRevision:string;urls:readonly string[]}):Promise<readonly ClassificationHostnameEvidence[]>{
  const preference=await tx.selectFrom('accounts as a').leftJoin('bookmark_preferences as p','p.account_id','a.id')
    .select('p.learn_from_corrections').where('a.subject_id','=',input.ownerSubjectId).executeTakeFirst();
  if(preference?.learn_from_corrections===false)return [];
  const hosts=[...new Set(input.urls.map(normalizeClassificationHostname).filter((value):value is string=>value!==null))];if(!hosts.length)return [];
  if(hosts.length>50)throw new Error('classification_prior_host_limit');
  const rows=await sql<{hostname:string;folder_id:string;accepted:number;current_count:number;latest:Date}>`
    SELECT e.hostname,e.folder_id,count(*)::int AS accepted,count(*) FILTER(WHERE e.taxonomy_revision=${input.taxonomyRevision})::int AS current_count,max(e.created_at) AS latest
    FROM collection_classification_evidence e JOIN collections c ON c.id=e.collection_id
      JOIN accounts a ON a.subject_id=e.owner_subject_id LEFT JOIN bookmark_capture_learning l ON l.account_id=a.id
      JOIN nodes n ON n.id=e.node_id AND n.collection_id=e.collection_id
      JOIN nodes f ON f.id=e.folder_id AND f.collection_id=e.collection_id
    WHERE e.collection_id=${input.collectionId} AND e.owner_subject_id=${input.ownerSubjectId} AND c.owner_subject_id=${input.ownerSubjectId}
      AND c.deleted_at IS NULL AND n.deleted_at IS NULL AND f.deleted_at IS NULL AND f.kind='folder' AND NOT f.is_root
      AND e.hostname=ANY(${hosts}::text[]) AND e.created_at>clock_timestamp()-interval '180 days'
      AND e.evidence_generation=coalesce(l.generation,0)
    GROUP BY e.hostname,e.folder_id ORDER BY e.hostname,e.folder_id LIMIT 10001`.execute(tx);
  // Prior is optional; overflow cannot silently produce a biased partial distribution.
  if(rows.rows.length>10000)return [];
  return rows.rows.map(row=>({hostname:row.hostname,folderId:row.folder_id,acceptedCount:row.accepted,currentRevisionCount:row.current_count,
    rejectedCount:null,lastAcceptedAt:row.latest.toISOString()}));
}
export async function pruneClassificationEvidence(db:Kysely<DatabaseSchema>){
  await sql`DELETE FROM collection_classification_evidence WHERE evidence_id IN (SELECT evidence_id FROM collection_classification_evidence
    WHERE created_at<=clock_timestamp()-interval '180 days' ORDER BY created_at LIMIT 1000)`.execute(db);
}
