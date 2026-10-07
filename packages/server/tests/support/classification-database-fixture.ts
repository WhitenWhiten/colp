import { randomUUID,randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { materializeCollectionPayload,materializeNodePayload } from '../../src/modules/collections/index.js';

export async function seedClassificationTaxonomy(runtime:DatabaseRuntime, canonical = false, otherNodeId?: string, folderIdOverride?:string) {
  const id = canonical ? randomBytes(16).toString('base64url') : randomUUID(); const owner = `owner-${id}`; const root = `root-${id}`;
  const client = await runtime.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO accounts(id,subject_id,status,security_epoch) VALUES ($1,$2,'active',0)", [id, owner]);
    await client.query("INSERT INTO resource_id_ledger(resource_id,resource_type) VALUES ($1,'collection')", [id]);
    const nodes = [root, folderIdOverride??`f-${id}`, `deep-${id}`, `b-${id}`, otherNodeId ?? `b2-${id}`, `deleted-${id}`];
    await client.query("INSERT INTO resource_id_ledger(resource_id,resource_type) SELECT unnest($1::text[]),'node'", [nodes]);
    await client.query(`INSERT INTO collections(id,owner_subject_id,title,summary,kind,visibility,root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal)
      VALUES ($1,$2,'中文库','collection scope','bookmarks','private',$3,'r1','c1','p1',1)`, [id, owner, root]);
    await client.query(`INSERT INTO nodes(id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,resource_revision,children_revision,deleted_at) VALUES
      ($2,$1,null,'folder',true,'Root',null,null,null,'inherit',null,'r1','ch1',null),
      ($3,$1,$2,'folder',false,'技术',null,'folder scope','["folder-only"]','inherit','A','r1','ch1',null),
      ($4,$1,$3,'folder',false,'深层',null,'deep scope','[]','inherit','A','r1','ch1',null),
      ($5,$1,$2,'bookmark',false,'AI resource','https://example.org/ai','bookmark description','["AI","ai"]','inherit','B','r1','ch1',null),
      ($6,$1,$4,'bookmark',false,'Another','https://example.org/other',null,'["AI"]','inherit','A','r1','ch1',null),
      ($7,$1,$2,'bookmark',false,'Deleted','https://example.org/deleted',null,'["deleted-only"]','inherit','C','r1','ch1',now())`, [id, ...nodes]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return { collectionId: id, ownerSubjectId: owner, root, nodeId: `b-${id}`, folderId: folderIdOverride??`f-${id}`, otherNodeId: otherNodeId ?? `b2-${id}` };
}

export async function seedCanonicalClassificationFixture(runtime:DatabaseRuntime, otherNodeId?: string,extra?:{nodeIds:readonly string[];tags:readonly string[];folderId:string}) {
  const input=await seedClassificationTaxonomy(runtime,true,otherNodeId,extra?.folderId);
  if(extra){
    await sql`UPDATE nodes SET tags=${JSON.stringify(extra.tags)}::jsonb WHERE id=${input.nodeId}`.execute(runtime.db);
    await sql`INSERT INTO resource_id_ledger(resource_id,resource_type) SELECT unnest(${extra.nodeIds}::text[]),'node'`.execute(runtime.db);
    await sql`INSERT INTO nodes(id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,resource_revision,children_revision)
      SELECT id,${input.collectionId},${`deep-${input.collectionId}`},'bookmark',false,'Maximum batch '||n::text,
        'https://example.org/maximum/'||n::text,NULL,'[]'::jsonb,'inherit','Z'||n::text,'r1','ch1'
      FROM unnest(${extra.nodeIds}::text[]) WITH ORDINALITY AS seed(id,n)`.execute(runtime.db);
  }
  await runtime.pool.query("INSERT INTO profiles(account_id,display_name,avatar_url) VALUES ($1,'Classification owner',null)",[input.collectionId]);
  await runtime.pool.query("INSERT INTO collection_members(collection_id,subject_id,role) VALUES ($1,$2,'owner')",[input.collectionId,input.ownerSubjectId]);
  const c=(await runtime.pool.query('SELECT * FROM collections WHERE id=$1',[input.collectionId])).rows[0];
  const payload=materializeCollectionPayload({id:c.id,ownerSubjectId:c.owner_subject_id,title:c.title,summary:c.summary,kind:c.kind,visibility:c.visibility,
    rootNodeId:c.root_node_id,resourceRevision:c.resource_revision,contentRevision:c.content_revision,policyRevision:c.policy_revision,commitOrdinal:c.commit_ordinal,
    createdAt:c.created_at,updatedAt:c.updated_at,deletedAt:c.deleted_at});
  if(!payload.ok)throw new Error(payload.reason);
  await runtime.pool.query("UPDATE collections SET payload_json=$2::jsonb,payload_schema_version=1,payload_authority_status='backfilled' WHERE id=$1",[input.collectionId,JSON.stringify(payload.payload)]);
  const nodes=(await runtime.pool.query('SELECT * FROM nodes WHERE collection_id=$1 AND deleted_at IS NULL',[input.collectionId])).rows;
  for(const n of nodes){
    const value=materializeNodePayload({id:n.id,collectionId:n.collection_id,parentId:n.parent_id,kind:n.kind,isRoot:n.is_root,title:n.title,url:n.url,
      description:n.description,tags:n.tags,visibility:n.visibility,positionToken:n.position_token,resourceRevision:n.resource_revision,childrenRevision:n.children_revision,
      createdAt:n.created_at,updatedAt:n.updated_at,deletedAt:n.deleted_at,deletedCommitOrdinal:n.deleted_commit_ordinal});
    if(!value.ok)throw new Error(value.reason);
    await runtime.pool.query("UPDATE nodes SET payload_json=$2::jsonb,payload_schema_version=1,payload_authority_status='backfilled' WHERE id=$1",[n.id,JSON.stringify(value.payload)]);
  }
  return input;
}

