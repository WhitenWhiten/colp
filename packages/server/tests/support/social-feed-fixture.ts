import type { IsolatedPostgresRuntime } from './postgres-test-runtime.js';

export async function seedProfileAndCollection(
  runtime: IsolatedPostgresRuntime,
  recipientId: string,
  actorId: string,
  collectionId: string,
): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    for (const id of [recipientId, actorId]) {
      await client.query(
        `insert into accounts(id,subject_id,status) values($1,$2,'active')`,
        [id, `subject-${id}`],
      );
      await client.query(
        `insert into profiles(account_id,display_name) values($1,$2)`, [id, id],
      );
    }
    const rootId = `root-${collectionId}`;
    await client.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      values($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
    [collectionId, rootId]);
    await client.query(`insert into collections(
      id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
      root_node_id,root_node_is_root,
      resource_revision,content_revision,policy_revision,commit_ordinal,created_at,updated_at)
      values($1,$2,'Feed source','bookmarks','public',$4,current_timestamp,$3,true,
        'r1','c1','p1',1,
        current_timestamp,current_timestamp)`,
    [collectionId, `subject-${actorId}`, rootId,
      `feed-${collectionId.toLowerCase().replaceAll('_', '-')}`]);
    await client.query(`insert into nodes(
      id,collection_id,parent_id,kind,is_root,title,url,position_token,
      resource_revision,children_revision,created_at,updated_at)
      values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
        current_timestamp,current_timestamp)`, [rootId, collectionId]);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
