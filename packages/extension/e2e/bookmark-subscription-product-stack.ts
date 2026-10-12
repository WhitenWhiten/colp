import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from '../../server/node_modules/fastify/fastify.js';
import type { createDatabaseRuntime } from '../../server/src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../server/src/infrastructure/identity/index.js';
import { createPostgresBookmarkSubscriptionUnitOfWork } from '../../server/src/infrastructure/bookmark-subscriptions/unit-of-work.js';
import { registerBookmarkSubscriptionRoutes } from '../../server/src/transport/product/bookmark-subscription-routes.js';
import { createFixedWindowRateLimiter } from '../../server/src/transport/http-security.js';
import { externalBackendOrigin, pointExtensionBuildConfig, skippedInProcessProductStack } from './external-backend.js';
import { knowNBackendRoot, loadReportReaderRoutes } from './cloud-product-fixtures.js';

/** Real Product routes and PostgreSQL adapters; only source content is fixture data. */
export async function createBookmarkSubscriptionProductFixture(
  runtime: ReturnType<typeof createDatabaseRuntime>,
  actor: { id: string; subjectId: string },
) {
  // create-user via the server CLI is a precondition; see external-backend.ts.
  const origin = externalBackendOrigin();
  if (origin) {
    pointExtensionBuildConfig(origin);
    return skippedInProcessProductStack('bookmark-subscription-product-stack');
  }
  const collectionId = 'subscription-source-' + randomUUID();
  const rootId = 'subscription-root-' + randomUUID();
  const bookmarkId = 'subscription-bookmark-' + randomUUID();
  const ownerId = 'subscription-owner-' + randomUUID();
  const ownerSubject = 'subject-' + ownerId;
  const sourceUrl = 'https://subscription-fixture.example/article';
  const client = await runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query("insert into accounts(id,subject_id,status) values($1,$2,'active')", [ownerId, ownerSubject]);
    await client.query("insert into profiles(account_id,display_name) values($1,'Subscription source owner')", [ownerId]);
    await client.query("insert into resource_id_ledger(resource_id,resource_type) values($1,'collection'),($2,'node'),($3,'node')", [collectionId, rootId, bookmarkId]);
    await client.query('insert into collections(id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal,created_at,updated_at) '
      + "values($1,$2,'Shared subscription source','bookmarks','private',$3,'r1','c1','p1',1,now(),now())", [collectionId, ownerSubject, rootId]);
    await client.query('insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,position_token,resource_revision,children_revision,created_at,updated_at) '
      + "values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',now(),now()),($3,$2,$1,'bookmark',false,'Source article',$4,'a','r1','ch1',now(),now())", [rootId, collectionId, bookmarkId, sourceUrl]);
    await client.query("insert into collection_members(collection_id,subject_id,role) values($1,$2,'viewer')", [collectionId, actor.subjectId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
  let contentEnabled = true;
  // Digest editions are read through Know-N's report reader; COLP Server has no reports.
  const reportReader = knowNBackendRoot ? await loadReportReaderRoutes() : undefined;
  return {
    collectionId, bookmarkId, sourceUrl,
    register(app: FastifyInstance) {
      const deps = {
        identityUnitOfWork: createPostgresIdentityUnitOfWork(runtime.db),
        unitOfWork: createPostgresBookmarkSubscriptionUnitOfWork(runtime.db, { origin: 'https://known.example', reportsEnabled: true }),
        allowedOrigins: ['chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen', 'https://known.example'],
        enabled: () => contentEnabled,
        protocolReady: () => true,
        cursorKey: 'test-subscription-cursor-key-not-production-2026',
        rateLimiter: createFixedWindowRateLimiter({ maxRequests: 120, windowMs: 60000 }),
      };
      registerBookmarkSubscriptionRoutes(app, deps);
      reportReader?.registerReportReaderRoutes(app, deps);
    },
    setContentEnabled(value: boolean) { contentEnabled = value; },
    async renameBookmark(title: string) {
      await runtime.db.transaction().execute(async tx => {
        await tx.updateTable('nodes').set({ title, resource_revision: 'r-' + randomUUID(), updated_at: new Date() }).where('id', '=', bookmarkId).execute();
        await tx.updateTable('collections').set({ content_revision: 'c-' + randomUUID(), updated_at: new Date() }).where('id', '=', collectionId).execute();
      });
    },
    async rearrangeSource() {
      const folder = 'changed-folder-' + randomUUID(), added = 'changed-node-' + randomUUID();
      const url = 'https://subscription-fixture.example/added';
      const client = await runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query("insert into resource_id_ledger(resource_id,resource_type) values($1,'node'),($2,'node')", [folder, added]);
        await client.query("insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,position_token,resource_revision,children_revision) values($1,$2,$3,'folder',false,'New source group',null,'c','r1','ch1'),($4,$2,$3,'bookmark',false,'Added source article',$5,'b','r1','ch1')", [folder, collectionId, rootId, added, url]);
        await client.query("update nodes set parent_id=$2,resource_revision=$3 where id=$1", [bookmarkId, folder, 'r-' + randomUUID()]);
        await client.query("update collections set content_revision=$2 where id=$1", [collectionId, 'c-' + randomUUID()]);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
      return { folder, added, url };
    },
    async finishSourceRearrangement(folder: string, added: string) {
      await runtime.db.transaction().execute(async tx => {
        await tx.updateTable('nodes').set({ parent_id: rootId, position_token: 'a', resource_revision: 'r-' + randomUUID() }).where('id', '=', bookmarkId).execute();
        await tx.updateTable('nodes').set({ deleted_at: new Date(), resource_revision: 'r-' + randomUUID() }).where('id', 'in', [folder, added]).execute();
        await tx.updateTable('collections').set({ content_revision: 'c-' + randomUUID() }).where('id', '=', collectionId).execute();
      });
    },
    async revokeSource() {
      await runtime.db.deleteFrom('collection_members').where('collection_id', '=', collectionId).where('subject_id', '=', actor.subjectId).execute();
    },
    async expandProjectedNodes(total: number) {
      if (!Number.isSafeInteger(total) || total < 3 || total > 20000) throw new Error('invalid_fixture_size');
      const extra = total - 3;
      const folderCount = Math.min(extra, Math.ceil(extra / 100));
      const leafCount = extra - folderCount;
      const prefix = 'capacity-' + randomUUID() + '-';
      const client = await runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query("insert into resource_id_ledger(resource_id,resource_type) select $1||'f'||v::text,'node' from generate_series(1,$2::int) v union all select $1||'b'||v::text,'node' from generate_series(1,$3::int) v", [prefix, folderCount, leafCount]);
        await client.query("insert into nodes(id,collection_id,parent_id,kind,is_root,title,position_token,resource_revision,children_revision) select $1||'f'||v::text,$2,$3,'folder',false,'Capacity group '||v::text,'b'||lpad(v::text,8,'0'),'r1','ch1' from generate_series(1,$4::int) v", [prefix, collectionId, rootId, folderCount]);
        for (let start = 1; start <= leafCount; start += 1000) {
          await client.query("insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,position_token,resource_revision,children_revision) select $1||'b'||v::text,$2,$1||'f'||(1+((v-1)%$3::int))::text,'bookmark',false,'Capacity article '||v::text,'https://subscription-fixture.example/capacity/'||v::text,'b'||lpad(v::text,8,'0'),'r1','ch1' from generate_series($4::int,$5::int) v", [prefix, collectionId, folderCount, start, Math.min(start + 999, leafCount)]);
        }
        await client.query("update collections set content_revision=$2,updated_at=now() where id=$1", [collectionId, 'c-' + randomUUID()]);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
    async seedSmallCollections(count: number) {
      const ids: string[] = [];
      const client = await runtime.pool.connect();
      try {
        await client.query('begin');
        for (let index = 0; index < count; index++) {
          const id = 'small-source-' + randomUUID(), root = 'small-root-' + randomUUID(), bookmark = 'small-node-' + randomUUID();
          ids.push(id);
          await client.query("insert into resource_id_ledger(resource_id,resource_type) values($1,'collection'),($2,'node'),($3,'node')", [id, root, bookmark]);
          await client.query("insert into collections(id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal) values($1,$2,$3,'bookmarks','private',$4,'r1','c1','p1',1)", [id, ownerSubject, 'Capacity source ' + index, root]);
          await client.query("insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,position_token,resource_revision,children_revision) values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1'),($3,$2,$1,'bookmark',false,'Small article',$4,'a','r1','ch1')", [root, id, bookmark, 'https://subscription-fixture.example/small/' + index]);
          await client.query("insert into collection_members(collection_id,subject_id,role) values($1,$2,'viewer')", [id, actor.subjectId]);
        }
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
      return ids;
    },
    async expireCompletedFixtureSnapshots() {
      // Capacity setup models mappings accumulated across retention windows.
      // The independent backend suite verifies the eight-live-cache admission.
      await runtime.db.updateTable('bookmark_subscription_snapshots').set({ expires_at: new Date(0) }).where('account_id', '=', actor.id).execute();
    },
    async seedDigest(count = 21) {
      const seriesId = 'subscription-digest-' + randomUUID();
      const editionIds: string[] = [];
      const client = await runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query("insert into resource_id_ledger(resource_id,resource_type) values($1,'digest_series')", [seriesId]);
        await client.query("insert into digest_series(id,owner_subject_id,title,visibility,state,resource_revision,content_revision,policy_revision,commit_ordinal) values($1,$2,'Private subscription Digest','private','active','r1','c1','p1',1)", [seriesId, ownerSubject]);
        await client.query("insert into digest_members(series_id,subject_id,role) values($1,$2,'owner'),($1,$3,'viewer')", [seriesId, ownerSubject, actor.subjectId]);
        for (let i = 1; i <= count; i++) {
          const id = 'subscription-edition-' + randomUUID(); editionIds.push(id);
          await client.query("insert into resource_id_ledger(resource_id,resource_type) values($1,'digest_edition')", [id]);
          await client.query("insert into digest_editions(id,series_id,source_collection_id,issue_key,edition_ordinal,title_snapshot,source_content_revision,resource_revision,state,published_at) values($1,$2,$3,$4,$5,$6,'c1','r1','published',current_timestamp + ($5::bigint*interval '1 second'))", [id, seriesId, collectionId, 'issue-' + i, i, 'Edition ' + i]);
        }
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
      return { seriesId, editionIds };
    },
    async withdrawEdition(id: string) {
      await runtime.pool.query("update digest_editions set state='withdrawn',withdrawn_at=current_timestamp where id=$1", [id]);
    },
    async lifecycle() {
      const [subscriptions, mappings, actions] = await Promise.all([
        runtime.db.selectFrom('bookmark_subscriptions').selectAll().where('account_id', '=', actor.id).execute(),
        runtime.db.selectFrom('bookmark_subscription_mappings').selectAll().where('account_id', '=', actor.id).execute(),
        runtime.db.selectFrom('bookmark_subscription_actions').selectAll().where('account_id', '=', actor.id).execute(),
      ]);
      return { subscriptions, mappings, actions };
    },
  };
}
