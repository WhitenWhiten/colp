import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { isFaviconPubliclyAccessible } from '../../../src/infrastructure/database/publication-object-controls.js';
import { createPostgresLinkPreviewPublicAccess } from '../../../src/infrastructure/collections/link-preview-public-access.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('shared anonymous publication controls for image objects', () => {
  let isolated: IsolatedPostgresRuntime;
  const objectId = randomUUID();
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('published_object_access');
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ('image-owner','image-subject','active')");
      await client.query("insert into resource_id_ledger(resource_id,resource_type) values ('images','collection'),('images-root','node'),('images-bookmark','node')");
      await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,policy_revision,publication_slug,published_at)
        values ('images','image-subject','Images','bookmarks','public','images-root','r1','c1','p1','images',now())`);
      await client.query(`insert into nodes(id,collection_id,kind,is_root,title,visibility,resource_revision,children_revision)
        values ('images-root','images','folder',true,'Root','inherit','r1','ch1')`);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,title,url,visibility,position_token,resource_revision,children_revision)
        values ('images-bookmark','images','images-root','bookmark','Image','https://example.test/image','inherit','a','r1','ch1')`);
      await client.query(`insert into bookmark_icons(node_id,collection_id,object_id,content_type,byte_size,digest_sha256)
        values ('images-bookmark','images',$1,'image/png',1,$2)`, [objectId, Buffer.alloc(32, 1)]);
      await client.query(`insert into link_preview_targets(url_key,normalized_url,site,status,object_id,width,height,mime,digest)
        values (public.link_preview_url_key('https://example.test/image'),'https://example.test/image','example.test','ready',$1,1,1,'image/png','fixture')`, [objectId]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function assertAdmission(allowed: boolean) {
    assert.equal(await isFaviconPubliclyAccessible(isolated.runtime.db, objectId), allowed, 'favicon');
    assert.equal(await createPostgresLinkPreviewPublicAccess(isolated.runtime.db).isServable(objectId), allowed, 'preview');
  }

  test('owner lifecycle ends anonymous publication without deleting bookmark bindings', async () => {
    await assertAdmission(true);
    for (const status of ['disabled', 'deleted']) {
      await isolated.runtime.pool.query('update accounts set status=$1 where id=$2', [status, 'image-owner']);
      await assertAdmission(false);
    }
    await isolated.runtime.pool.query("update accounts set status='active',deleted_at=now() where id='image-owner'");
    await assertAdmission(false);
    await isolated.runtime.pool.query("update accounts set deleted_at=null where id='image-owner'");
    await assertAdmission(true);
  });

  test('retained account publication restrictions gate every image reader', async () => {
    await isolated.runtime.pool.query(`insert into moderation_cases(id,reporter_account_id,target_kind,target_id,target_json,target_fingerprint,category,description,status,revision,created_at,updated_at)
      values ('image-case','image-owner','account','image-owner','{}','image-owner','other','fixture','submitted','1',now(),now())`);
    await isolated.runtime.pool.query(`insert into moderation_actions(id,case_id,target_kind,target_id,target_json,target_fingerprint,action,reason,actor_account_id,state,revision,created_at)
      values ('image-action','image-case','account','image-owner','{}','image-owner','restrict_publication','fixture','image-owner','active','1',now())`);
    await assertAdmission(false);
    await isolated.runtime.pool.query("update moderation_actions set state='revoked' where id='image-action'");
    await assertAdmission(true);
  });
});
