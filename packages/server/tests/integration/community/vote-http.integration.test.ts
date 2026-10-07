import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createProductCommunityClient } from '../../../generated/openapi/product-v1.client.js';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCommunityCommentCommandUnitOfWork,
  createPostgresCommunityCommentManageUnitOfWork,
  createPostgresCommunityCommentQueryUnitOfWork,
  createPostgresCommunityNotificationCommandUnitOfWork,
  createPostgresCommunityNotificationQueryUnitOfWork,
  createPostgresCommunityRankingQueryUnitOfWork,
  createPostgresCommunityRankingRefreshUnitOfWork,
  createPostgresCommunityTargetQueryUnitOfWork,
  createPostgresCommunityVoteCommandUnitOfWork,
} from '../../../src/infrastructure/community/index.js';
import { refreshCommunityRanking } from '../../../src/modules/community/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const COLLECTION = 'community-it-collection';
const BOOKMARK = 'community-it-bookmark';
const SERIES = 'community-it-series';
const EDITION = 'community-it-edition';
const PRIVATE_COLLECTION = 'community-it-private';

describeWithPostgres('CS-01 community vote HTTP', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_vote_http', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function seedCollection(
    collectionId: string,
    ownerSubjectId: string,
    visibility: 'public' | 'unlisted' | 'private' | 'protected',
    slug: string,
  ): Promise<string> {
    const rootId = `root-${collectionId}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
        [collectionId, rootId],
      );
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
        commit_ordinal,created_at,updated_at)
        values($1,$2,$6,'bookmarks',$5,$4,current_timestamp,$3,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, ownerSubjectId, rootId, slug, visibility, 'Vote target']);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
          current_timestamp,current_timestamp)`, [rootId, collectionId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return rootId;
  }

  async function seedBookmark(nodeId: string, collectionId: string, parentId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id,resource_type,committed_at)
       values($1,'node',current_timestamp)`, [nodeId]);
    await isolated.runtime.pool.query(`insert into nodes(
      id,collection_id,parent_id,kind,is_root,title,url,position_token,
      resource_revision,children_revision,created_at,updated_at)
      values($1,$2,$3,'bookmark',false,'Bookmark','https://example.com/one','a0','r1','ch1',
        current_timestamp,current_timestamp)`, [nodeId, collectionId, parentId]);
  }

  async function seedFolder(
    nodeId: string,
    collectionId: string,
    parentId: string,
    visibility: 'inherit' | 'protected' | 'private',
  ): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id,resource_type,committed_at)
       values($1,'node',current_timestamp)`, [nodeId]);
    await isolated.runtime.pool.query(`insert into nodes(
      id,collection_id,parent_id,kind,is_root,title,url,position_token,visibility,
      resource_revision,children_revision,created_at,updated_at)
      values($1,$2,$3,'folder',false,'Folder',null,'a1',$4,'r1','ch1',
        current_timestamp,current_timestamp)`, [nodeId, collectionId, parentId, visibility]);
  }

  async function seedDigestSeries(seriesId: string, ownerSubjectId: string, slug: string): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'report',current_timestamp)`, [seriesId]);
      await client.query(`insert into digest_series(
        id,owner_subject_id,title,summary,slug,visibility,state,
        resource_revision,content_revision,policy_revision,commit_ordinal,
        created_at,updated_at)
        values($1,$2,'Digest','Weekly digest',$3,'public','active',
          'r1','c1','p1',1,current_timestamp,current_timestamp)`, [seriesId, ownerSubjectId, slug]);
      // The deferred owner-membership guard requires the owner row by commit.
      await client.query(`insert into digest_members(series_id,subject_id,role,granted_at)
        values($1,$2,'owner',current_timestamp)`, [seriesId, ownerSubjectId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedEdition(editionId: string, seriesId: string, sourceCollectionId: string): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'report',current_timestamp)`, [editionId]);
      await client.query(`insert into digest_editions(
        id,series_id,source_collection_id,issue_key,edition_ordinal,
        title_snapshot,summary_snapshot,source_content_revision,source_policy_revision,
        resource_revision,period_start,period_end,state,published_at,created_at,updated_at)
        values($1,$2,$3,'2026-W40',1,'Edition one','Summary','c1','p1','r1',
          current_timestamp - interval '7 days',current_timestamp,'published',current_timestamp,
          current_timestamp,current_timestamp)`, [editionId, seriesId, sourceCollectionId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  test('generated client resolves all four kinds, votes durably and replays receipts', async () => {
    const config = loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64') });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const actor = await issueTestSession({ factory,
      subject: `vote-actor-${randomUUID()}`, handle: `a${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const owner = await issueTestSession({ factory,
      subject: `vote-owner-${randomUUID()}`, handle: `o${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const other = await issueTestSession({ factory,
      subject: `vote-other-${randomUUID()}`, handle: `p${randomUUID().replaceAll('-', '').slice(0, 12)}` });

    const rootId = await seedCollection(COLLECTION, owner.subjectId, 'public', 'vote-target');
    await seedBookmark(BOOKMARK, COLLECTION, rootId);
    await seedCollection(PRIVATE_COLLECTION, owner.subjectId, 'private', 'vote-private');
    await seedDigestSeries(SERIES, owner.subjectId, 'vote-digest');
    await seedEdition(EDITION, SERIES, COLLECTION);

    const app = buildApiApp({ config, identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      communityTargetQueryUnitOfWork: createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork: createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
      communityRankingQueryUnitOfWork: createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork: createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork: createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityCommentManageUnitOfWork: createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityNotificationQueryUnitOfWork: createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork: createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const anonymous = createProductCommunityClient({ origin });
      const client = createProductCommunityClient({ origin, sessionCookie: actor.cookie,
        originHeader: config.productOrigin, csrfToken: actor.csrfToken });
      const ownerClient = createProductCommunityClient({ origin, sessionCookie: owner.cookie,
        originHeader: config.productOrigin, csrfToken: owner.csrfToken });

      // Anonymous resolve: counts visible, no viewer state, cannot vote.
      const publicView = await anonymous.resolveTarget({ kind: 'collection', id: COLLECTION });
      assert.equal(publicView.canVote, false);
      assert.equal(publicView.canComment, false);
      assert.equal(publicView.votes.myVote, null);
      assert.equal(publicView.target.generation, 'static-v1');

      // All four kinds resolve for an authenticated non-owner.
      const bookmarkView = await client.resolveTarget(
        { kind: 'bookmark', id: BOOKMARK, collectionId: COLLECTION });
      assert.match(bookmarkView.target.generation, /^bm-gen-/u);
      assert.equal(bookmarkView.canVote, true);
      const seriesView = await client.resolveTarget({ kind: 'digest_series', id: SERIES });
      assert.equal(seriesView.canVote, true);
      const editionView = await client.resolveTarget(
        { kind: 'digest_edition', id: EDITION, seriesId: SERIES });
      assert.equal(editionView.canVote, true);

      // The owner sees curation rights but no vote affordance.
      const ownerView = await ownerClient.resolveTarget({ kind: 'collection', id: COLLECTION });
      assert.equal(ownerView.canVote, false);
      assert.equal(ownerView.canCurateComments, true);

      // Concealment is uniform for missing and non-public targets.
      for (const query of [
        { kind: 'collection', id: 'community-it-missing' },
        { kind: 'collection', id: PRIVATE_COLLECTION },
      ]) {
        await assert.rejects(() => client.resolveTarget(query),
          (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
      }

      // Durable upvote + idempotent replay of the same command id.
      const commandId = randomUUID();
      const target = { ...publicView.target };
      const first = await client.setVote({ target, value: 1 }, commandId);
      assert.equal(first.myVote, 1);
      assert.equal(first.up, 1);
      const replay = await client.setVote({ target, value: 1 }, commandId);
      assert.deepEqual(replay, first);
      await assert.rejects(() => client.setVote(
        { target: { ...seriesView.target }, value: 1 }, commandId),
        (error: unknown) => isProductClientError(error, 409, 'command_id_reused'));
      const rows = await isolated.runtime.pool.query<{ votes: string; receipts: string; audits: string }>(`
        select
          (select count(*)::text from community_votes where account_id=$1) votes,
          (select count(*)::text from product_command_receipts where principal_id=$1 and command_id=$2) receipts,
          (select count(*)::text from audit_events where principal_id=$1 and event_type='community.vote_set') audits`,
        [actor.accountId, commandId]);
      assert.deepEqual(rows.rows[0], { votes: '1', receipts: '1', audits: '1' });

      // Replace then remove the vote; only ±1 rows persist.
      const down = await client.setVote({ target, value: -1 }, randomUUID());
      assert.equal(down.myVote, -1);
      assert.equal(down.down, 1);
      const cleared = await client.setVote({ target, value: 0 }, randomUUID());
      assert.equal(cleared.myVote, 0);
      assert.equal(cleared.up, 0);
      assert.equal(cleared.down, 0);
      const remaining = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text count from community_votes where account_id=$1`, [actor.accountId]);
      assert.equal(remaining.rows[0]?.count, '0');

      // A second voter reconciles counts against the same target.
      const otherClient = createProductCommunityClient({ origin, sessionCookie: other.cookie,
        originHeader: config.productOrigin, csrfToken: other.csrfToken });
      const otherVote = await otherClient.setVote({ target, value: 1 }, randomUUID());
      assert.equal(otherVote.up, 1);

      // Self-vote is a stable 403, not a concealment.
      await assert.rejects(() => ownerClient.setVote({ target, value: 1 }, randomUUID()),
        (error: unknown) => isProductClientError(error, 403, 'insufficient_permission'));
    } finally {
      await app.close();
    }
  });

  test('digest edition resolution conceals when its source collection loses public eligibility', async () => {
    const config = loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 29).toString('base64') });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    // The source collection and the series have DIFFERENT owners so the
    // source-owner account can be disabled without touching the series.
    const sourceOwner = await issueTestSession({ factory,
      subject: `vote-src-${randomUUID()}`, handle: `s${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const seriesOwner = await issueTestSession({ factory,
      subject: `vote-series-${randomUUID()}`, handle: `r${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const reader = await issueTestSession({ factory,
      subject: `vote-reader-${randomUUID()}`, handle: `e${randomUUID().replaceAll('-', '').slice(0, 12)}` });

    const SOURCE = 'community-it-edition-source';
    const sourceSeries = 'community-it-edition-series';
    const sourceEdition = 'community-it-source-edition';
    const sourceRootId = await seedCollection(SOURCE, sourceOwner.subjectId, 'public', 'vote-src');
    await seedDigestSeries(sourceSeries, seriesOwner.subjectId, 'vote-src-digest');
    await seedEdition(sourceEdition, sourceSeries, SOURCE);

    const app = buildApiApp({ config, identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      communityTargetQueryUnitOfWork: createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork: createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
      communityRankingQueryUnitOfWork: createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork: createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork: createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityCommentManageUnitOfWork: createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityNotificationQueryUnitOfWork: createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork: createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductCommunityClient({ origin, sessionCookie: reader.cookie,
        originHeader: config.productOrigin, csrfToken: reader.csrfToken });
      const editionQuery = { kind: 'digest_edition' as const, id: sourceEdition, seriesId: sourceSeries };
      const seriesQuery = { kind: 'digest_series' as const, id: sourceSeries };

      // Baseline: a published edition on a live, public, rooted, actively
      // owned source resolves and is voteable.
      const baseline = await client.resolveTarget(editionQuery);
      assert.equal(baseline.canVote, true);

      const expectConcealed = async () => {
        await assert.rejects(() => client.resolveTarget(editionQuery),
          (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
        // The concealment is source-scoped: the series itself still resolves.
        await client.resolveTarget(seriesQuery);
      };

      // Privatized source conceals the edition.
      await isolated.runtime.pool.query(
        `update collections set visibility='private' where id=$1`, [SOURCE]);
      try {
        await expectConcealed();
      } finally {
        await isolated.runtime.pool.query(
          `update collections set visibility='public' where id=$1`, [SOURCE]);
      }
      await client.resolveTarget(editionQuery);

      // Deleted source conceals the edition (collection and root flip
      // together — the lifecycle trigger forbids divergent tombstones).
      const client2 = await isolated.runtime.pool.connect();
      try {
        await client2.query('begin');
        await client2.query(`update nodes set deleted_at=current_timestamp
          where collection_id=$1 and id=$2`, [SOURCE, sourceRootId]);
        await client2.query(`update collections set deleted_at=current_timestamp where id=$1`, [SOURCE]);
        await client2.query('commit');
      } catch (error) {
        await client2.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client2.release();
      }
      try {
        await expectConcealed();
      } finally {
        const restore = await isolated.runtime.pool.connect();
        try {
          await restore.query('begin');
          await restore.query(`update collections set deleted_at=null where id=$1`, [SOURCE]);
          await restore.query(`update nodes set deleted_at=null
            where collection_id=$1 and id=$2`, [SOURCE, sourceRootId]);
          await restore.query('commit');
        } catch (error) {
          await restore.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          restore.release();
        }
      }
      await client.resolveTarget(editionQuery);

      // A deactivated source owner conceals the edition — the report-source
      // eligibility rule is the same one the public feed applies.
      await isolated.runtime.pool.query(
        `update accounts set status='disabled' where subject_id=$1`, [sourceOwner.subjectId]);
      try {
        await expectConcealed();
      } finally {
        await isolated.runtime.pool.query(
          `update accounts set status='active' where subject_id=$1`, [sourceOwner.subjectId]);
      }
      await client.resolveTarget(editionQuery);
    } finally {
      await app.close();
    }
  });

  test('a restricted ancestor folder conceals the bookmark from every community surface', async () => {
    const config = loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 23).toString('base64') });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const owner = await issueTestSession({ factory,
      subject: `vote-anc-owner-${randomUUID()}`, handle: `w${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const voter = await issueTestSession({ factory,
      subject: `vote-anc-voter-${randomUUID()}`, handle: `x${randomUUID().replaceAll('-', '').slice(0, 12)}` });

    const collectionId = 'community-it-ancestor';
    const folderId = 'community-it-ancestor-folder';
    const nodeId = 'community-it-ancestor-bookmark';
    const rootId = await seedCollection(collectionId, owner.subjectId, 'public', 'vote-ancestor');
    await seedFolder(folderId, collectionId, rootId, 'inherit');
    await seedBookmark(nodeId, collectionId, folderId);

    const app = buildApiApp({ config, identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      communityTargetQueryUnitOfWork: createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork: createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
      communityRankingQueryUnitOfWork: createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork: createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork: createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityCommentManageUnitOfWork: createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityNotificationQueryUnitOfWork: createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork: createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductCommunityClient({ origin, sessionCookie: voter.cookie,
        originHeader: config.productOrigin, csrfToken: voter.csrfToken });
      const query = { kind: 'bookmark' as const, id: nodeId, collectionId };

      const bookmarkRanked = async (): Promise<number> => {
        await createPostgresCommunityRankingRefreshUnitOfWork(isolated.runtime.db)
          .execute((ports) => refreshCommunityRanking(ports));
        const rows = await isolated.runtime.pool.query<{ n: number }>(
          `select count(*)::int as n from community_rank_entries
           where snapshot_id = (select max(snapshot_id) from community_rank_snapshots)
             and target_kind = 'bookmark' and target_id = $1`, [nodeId]);
        return rows.rows[0]!.n;
      };

      // Baseline: an inherit-chain bookmark resolves, votes, lists and ranks.
      const baseline = await client.resolveTarget(query);
      assert.equal(baseline.canVote, true);
      const voted = await client.setVote({ target: baseline.target, value: 1 }, randomUUID());
      assert.equal(voted.up, 1);
      const listed = await client.listComments(
        { ...query, generation: baseline.target.generation });
      assert.deepEqual(listed.items, []);
      assert.equal(await bookmarkRanked(), 1);

      const expectConcealed = async () => {
        // A private/protected ancestor is the same concealment the
        // publication snapshot computes: resolve, comment list, vote and
        // the ranking candidate set all drop the still-'inherit' bookmark.
        await assert.rejects(() => client.resolveTarget(query),
          (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
        await assert.rejects(() => client.listComments(
          { ...query, generation: baseline.target.generation }),
          (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
        await assert.rejects(() => client.setVote(
          { target: baseline.target, value: -1 }, randomUUID()),
          (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
        assert.equal(await bookmarkRanked(), 0);
      };

      for (const restricted of ['private', 'protected'] as const) {
        await isolated.runtime.pool.query(
          `update nodes set visibility=$2 where collection_id=$1 and id=$3`,
          [collectionId, restricted, folderId]);
        try {
          await expectConcealed();
        } finally {
          await isolated.runtime.pool.query(
            `update nodes set visibility='inherit' where collection_id=$1 and id=$2`,
            [collectionId, folderId]);
        }
        assert.equal((await client.resolveTarget(query)).target.id, nodeId,
          `${restricted} ancestor restore must make the bookmark resolvable again`);
        assert.equal(await bookmarkRanked(), 1,
          `${restricted} ancestor restore must re-rank the bookmark`);
      }
    } finally {
      await app.close();
    }
  }, 60_000);

  test('a disabled owner account conceals every kind of community target', async () => {
    const config = loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 27).toString('base64') });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    // Two distinct owners so each leg can be flipped independently: the
    // collection/bookmark owner also owns the edition's live source, while
    // the series (and therefore the resolved edition target) is owned by
    // the second account.
    const owner = await issueTestSession({ factory,
      subject: `vote-own-a-${randomUUID()}`, handle: `y${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const seriesOwner = await issueTestSession({ factory,
      subject: `vote-own-b-${randomUUID()}`, handle: `z${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const voter = await issueTestSession({ factory,
      subject: `vote-own-v-${randomUUID()}`, handle: `v${randomUUID().replaceAll('-', '').slice(0, 12)}` });

    const collectionId = 'community-it-owner-collection';
    const nodeId = 'community-it-owner-bookmark';
    const seriesId = 'community-it-owner-series';
    const editionId = 'community-it-owner-edition';
    const rootId = await seedCollection(collectionId, owner.subjectId, 'public', 'vote-owner');
    await seedBookmark(nodeId, collectionId, rootId);
    await seedDigestSeries(seriesId, seriesOwner.subjectId, 'vote-owner-digest');
    await seedEdition(editionId, seriesId, collectionId);

    const app = buildApiApp({ config, identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      communityTargetQueryUnitOfWork: createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork: createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
      communityRankingQueryUnitOfWork: createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork: createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork: createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityCommentManageUnitOfWork: createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityNotificationQueryUnitOfWork: createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork: createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductCommunityClient({ origin, sessionCookie: voter.cookie,
        originHeader: config.productOrigin, csrfToken: voter.csrfToken });
      const collectionQuery = { kind: 'collection' as const, id: collectionId };
      const bookmarkQuery = { kind: 'bookmark' as const, id: nodeId, collectionId };
      const seriesQuery = { kind: 'digest_series' as const, id: seriesId };
      const editionQuery = { kind: 'digest_edition' as const, id: editionId, seriesId };

      const rankedTargets = async (): Promise<readonly string[]> => {
        await createPostgresCommunityRankingRefreshUnitOfWork(isolated.runtime.db)
          .execute((ports) => refreshCommunityRanking(ports));
        const rows = await isolated.runtime.pool.query<{ target_id: string }>(
          `select target_id from community_rank_entries
           where snapshot_id = (select max(snapshot_id) from community_rank_snapshots)
             and target_id = any($1)`, [[collectionId, nodeId, seriesId, editionId]]);
        return rows.rows.map((row) => row.target_id);
      };

      // Baseline: all four kinds resolve for a non-owner.
      const baselineCollection = await client.resolveTarget(collectionQuery);
      await client.resolveTarget(bookmarkQuery);
      await client.resolveTarget(seriesQuery);
      const baselineEdition = await client.resolveTarget(editionQuery);
      assert.equal((await rankedTargets()).length, 4);

      // Disabling the collection owner conceals the collection, its
      // bookmark, and the edition sourced from it; the other-owner series
      // stays resolvable. New votes on a concealed target are refused too.
      await isolated.runtime.pool.query(
        `update accounts set status='disabled' where subject_id=$1`, [owner.subjectId]);
      try {
        for (const concealed of [collectionQuery, bookmarkQuery, editionQuery]) {
          await assert.rejects(() => client.resolveTarget(concealed),
            (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
        }
        await client.resolveTarget(seriesQuery);
        await assert.rejects(() => client.setVote(
          { target: baselineCollection.target, value: 1 }, randomUUID()),
          (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
        assert.deepEqual((await rankedTargets()).sort(), [seriesId]);
      } finally {
        await isolated.runtime.pool.query(
          `update accounts set status='active' where subject_id=$1`, [owner.subjectId]);
      }

      // Disabling the series owner conceals the series AND the edition
      // whose resolved owner is that series owner — while the collection
      // branch targets keep resolving.
      await isolated.runtime.pool.query(
        `update accounts set status='disabled' where subject_id=$1`, [seriesOwner.subjectId]);
      try {
        for (const concealed of [seriesQuery, editionQuery]) {
          await assert.rejects(() => client.resolveTarget(concealed),
            (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
        }
        await client.resolveTarget(collectionQuery);
        await client.resolveTarget(bookmarkQuery);
        await assert.rejects(() => client.setVote(
          { target: baselineEdition.target, value: 1 }, randomUUID()),
          (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
        assert.deepEqual((await rankedTargets()).sort(), [collectionId, nodeId].sort());
      } finally {
        await isolated.runtime.pool.query(
          `update accounts set status='active' where subject_id=$1`, [seriesOwner.subjectId]);
      }
      assert.equal((await client.resolveTarget(editionQuery)).target.id, editionId);
      assert.equal((await rankedTargets()).length, 4);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('an unlisted publication conceals every kind of community target', async () => {
    const config = loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 25).toString('base64') });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    // Same two-owner split as the disabled-owner test: unlisted on the
    // collection leg conceals the edition through its source, while
    // unlisted on the series leg conceals it through the governing series.
    const owner = await issueTestSession({ factory,
      subject: `vote-unl-a-${randomUUID()}`, handle: `u${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const seriesOwner = await issueTestSession({ factory,
      subject: `vote-unl-b-${randomUUID()}`, handle: `t${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const voter = await issueTestSession({ factory,
      subject: `vote-unl-v-${randomUUID()}`, handle: `s${randomUUID().replaceAll('-', '').slice(0, 12)}` });

    const collectionId = 'community-it-unlisted-collection';
    const nodeId = 'community-it-unlisted-bookmark';
    const seriesId = 'community-it-unlisted-series';
    const editionId = 'community-it-unlisted-edition';
    const rootId = await seedCollection(collectionId, owner.subjectId, 'public', 'vote-unlisted');
    await seedBookmark(nodeId, collectionId, rootId);
    await seedDigestSeries(seriesId, seriesOwner.subjectId, 'vote-unlisted-digest');
    await seedEdition(editionId, seriesId, collectionId);

    const app = buildApiApp({ config, identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      communityTargetQueryUnitOfWork: createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork: createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
      communityRankingQueryUnitOfWork: createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork: createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork: createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityCommentManageUnitOfWork: createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityNotificationQueryUnitOfWork: createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork: createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductCommunityClient({ origin, sessionCookie: voter.cookie,
        originHeader: config.productOrigin, csrfToken: voter.csrfToken });
      const collectionQuery = { kind: 'collection' as const, id: collectionId };
      const bookmarkQuery = { kind: 'bookmark' as const, id: nodeId, collectionId };
      const seriesQuery = { kind: 'digest_series' as const, id: seriesId };
      const editionQuery = { kind: 'digest_edition' as const, id: editionId, seriesId };

      const rankedTargets = async (): Promise<readonly string[]> => {
        await createPostgresCommunityRankingRefreshUnitOfWork(isolated.runtime.db)
          .execute((ports) => refreshCommunityRanking(ports));
        const rows = await isolated.runtime.pool.query<{ target_id: string }>(
          `select target_id from community_rank_entries
           where snapshot_id = (select max(snapshot_id) from community_rank_snapshots)
             and target_id = any($1)`, [[collectionId, nodeId, seriesId, editionId]]);
        return rows.rows.map((row) => row.target_id);
      };

      // Baseline: all four kinds resolve and rank while everything is public.
      await client.resolveTarget(collectionQuery);
      await client.resolveTarget(bookmarkQuery);
      await client.resolveTarget(seriesQuery);
      await client.resolveTarget(editionQuery);
      assert.equal((await rankedTargets()).length, 4);

      // `unlisted` is link-visible in the library but is not published to
      // the community surface — every `visibility = 'public'` predicate
      // drops it from resolve, vote and the ranking candidate set.
      type AnyTargetQuery = typeof collectionQuery | typeof bookmarkQuery
        | typeof seriesQuery | typeof editionQuery;
      const legs: ReadonlyArray<readonly [
        name: string,
        apply: readonly [sql: string, params: readonly unknown[]],
        concealed: readonly AnyTargetQuery[],
        stillVisible: readonly AnyTargetQuery[],
        expectedRanked: readonly string[],
      ]> = [
        ['collection unlisted',
          [`update collections set visibility='unlisted' where id=$1`, [collectionId]],
          [collectionQuery, bookmarkQuery, editionQuery], [seriesQuery], [seriesId]],
        ['governing series unlisted',
          [`update digest_series set visibility='unlisted' where id=$1`, [seriesId]],
          [seriesQuery, editionQuery], [collectionQuery, bookmarkQuery], [collectionId, nodeId]],
      ];
      for (const [name, apply, concealed, stillVisible, expectedRanked] of legs) {
        await isolated.runtime.pool.query(apply[0], [...apply[1]]);
        try {
          for (const query of concealed) {
            await assert.rejects(() => client.resolveTarget(query),
              (error: unknown) => isProductClientError(error, 404, 'resource_not_found'),
              `${name} must conceal ${query.kind}`);
          }
          for (const query of stillVisible) {
            await client.resolveTarget(query);
          }
          assert.deepEqual((await rankedTargets()).sort(), [...expectedRanked].sort(),
            `${name} must drop the concealed ranking candidates`);
        } finally {
          const restoreSql = name.startsWith('collection')
            ? `update collections set visibility='public' where id=$1`
            : `update digest_series set visibility='public' where id=$1`;
          const restoreId = name.startsWith('collection') ? collectionId : seriesId;
          await isolated.runtime.pool.query(restoreSql, [restoreId]);
        }
      }
      assert.equal((await client.resolveTarget(editionQuery)).target.id, editionId);
      assert.equal((await rankedTargets()).length, 4);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('bookmark generation fencing: URL mutation invalidates stale vote targets', async () => {
    const config = loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 19).toString('base64') });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const voter = await issueTestSession({ factory,
      subject: `vote-fence-${randomUUID()}`, handle: `f${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const fenceOwner = await issueTestSession({ factory,
      subject: `vote-fence-owner-${randomUUID()}`, handle: `g${randomUUID().replaceAll('-', '').slice(0, 12)}` });

    const fencedCollection = 'community-it-fence';
    const fencedNode = 'community-it-fence-node';
    const rootId = await seedCollection(fencedCollection, fenceOwner.subjectId, 'public', 'vote-fence');
    await seedBookmark(fencedNode, fencedCollection, rootId);

    const app = buildApiApp({ config, identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      communityTargetQueryUnitOfWork: createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork: createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
      communityRankingQueryUnitOfWork: createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork: createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork: createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityCommentManageUnitOfWork: createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityNotificationQueryUnitOfWork: createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork: createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductCommunityClient({ origin, sessionCookie: voter.cookie,
        originHeader: config.productOrigin, csrfToken: voter.csrfToken });

      const before = await client.resolveTarget(
        { kind: 'bookmark', id: fencedNode, collectionId: fencedCollection });
      assert.match(before.target.generation, /^bm-gen-/u);
      const voted = await client.setVote({ target: before.target, value: 1 }, randomUUID());
      assert.equal(voted.myVote, 1);
      assert.equal(voted.up, 1);

      // Any real URL write bumps the server-minted generation (the trigger is
      // the fence — no caller-side bookkeeping). The old vote stops counting.
      await isolated.runtime.pool.query(
        `update nodes set url='https://example.com/two' where id=$1`, [fencedNode]);
      const after = await client.resolveTarget(
        { kind: 'bookmark', id: fencedNode, collectionId: fencedCollection });
      assert.notEqual(after.target.generation, before.target.generation);
      assert.equal(after.votes.up, 0);
      assert.equal(after.votes.myVote, 0);

      // A vote carrying the superseded generation is a 409 revision conflict;
      // the fresh target votes cleanly under a new command id.
      await assert.rejects(() => client.setVote({ target: before.target, value: -1 }, randomUUID()),
        (error: unknown) => isProductClientError(error, 409, 'revision_conflict'));
      const fresh = await client.setVote({ target: after.target, value: -1 }, randomUUID());
      assert.equal(fresh.myVote, -1);
      assert.equal(fresh.down, 1);
    } finally {
      await app.close();
    }
  });

  test('digest_edition conceals when its live source collection leaves public eligibility', async () => {
    const config = loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 29).toString('base64') });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const voter = await issueTestSession({ factory,
      subject: `vote-conceal-${randomUUID()}`, handle: `c${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const sourceOwner = await issueTestSession({ factory,
      subject: `vote-conceal-owner-${randomUUID()}`, handle: `d${randomUUID().replaceAll('-', '').slice(0, 12)}` });

    const source = 'community-it-concealed-source';
    const series = 'community-it-concealed-series';
    const edition = 'community-it-concealed-edition';
    const rootId = await seedCollection(source, sourceOwner.subjectId, 'public', 'concealed-src');
    await seedDigestSeries(series, sourceOwner.subjectId, 'concealed-digest');
    await seedEdition(edition, series, source);

    const app = buildApiApp({ config, identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      communityTargetQueryUnitOfWork: createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork: createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
      communityRankingQueryUnitOfWork: createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork: createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork: createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityCommentManageUnitOfWork: createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityNotificationQueryUnitOfWork: createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork: createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductCommunityClient({ origin, sessionCookie: voter.cookie,
        originHeader: config.productOrigin, csrfToken: voter.csrfToken });
      const query = { kind: 'digest_edition', id: edition, seriesId: series } as const;

      // The same predicate drives ranking candidate generation: after each
      // refresh the edition is present exactly while it resolves.
      const editionRanked = async (): Promise<number> => {
        await createPostgresCommunityRankingRefreshUnitOfWork(isolated.runtime.db)
          .execute((ports) => refreshCommunityRanking(ports));
        const rows = await isolated.runtime.pool.query<{ n: number }>(
          `select count(*)::int as n from community_rank_entries
           where snapshot_id = (select max(snapshot_id) from community_rank_snapshots)
             and target_kind = 'digest_edition' and target_id = $1`,
          [edition]);
        return rows.rows[0]!.n;
      };

      assert.equal((await client.resolveTarget(query)).canVote, true);
      assert.equal(await editionRanked(), 1);

      // Every reachable leg of the live-source + governing-series predicate
      // conceals the already-published edition from BOTH direct resolution
      // and the ranking candidate set — restore proves the flip was the
      // cause. The root-node legs (`root_node_id` null/`is_root` flipped/
      // tombstoned while the collection lives) are unreachable states: the
      // deferred `collections_root_fk`, `root_node_id is immutable` and
      // `collections_root_lifecycle_integrity` invariants forbid them, so
      // the SQL `exists` re-proof is defense-in-depth over them.
      const flips: ReadonlyArray<readonly [
        name: string,
        apply: readonly [sql: string, params: readonly unknown[]],
        restore: readonly [sql: string, params: readonly unknown[]],
      ]> = [
        ['source privatized',
          [`update collections set visibility=$2 where id=$1`, [source, 'private']],
          [`update collections set visibility=$2 where id=$1`, [source, 'public']]],
        ['source unpublished (locator cleared)',
          [`update collections set visibility='protected', published_at=null, publication_slug=null
            where id=$1`, [source]],
          [`update collections set visibility='public', published_at=current_timestamp,
            publication_slug='concealed-src' where id=$1`, [source]]],
        // The deferred lifecycle trigger requires collection and root to
        // tombstone together — one statement keeps the commit consistent.
        ['source deleted',
          [`with c as (update collections set deleted_at=current_timestamp where id=$1)
            update nodes set deleted_at=current_timestamp where id=$2`, [source, rootId]],
          [`with c as (update collections set deleted_at=null where id=$1)
            update nodes set deleted_at=null where id=$2`, [source, rootId]]],
        ['source owner disabled',
          [`update accounts set status=$2 where subject_id=$1`, [sourceOwner.subjectId, 'disabled']],
          [`update accounts set status=$2 where subject_id=$1`, [sourceOwner.subjectId, 'active']]],
        ['source owner deleted',
          [`update accounts set deleted_at=current_timestamp where subject_id=$1`, [sourceOwner.subjectId]],
          [`update accounts set deleted_at=null where subject_id=$1`, [sourceOwner.subjectId]]],
        ['edition withdrawn',
          [`update digest_editions set state=$2, withdrawn_at=current_timestamp where id=$1`,
            [edition, 'withdrawn']],
          [`update digest_editions set state=$2, withdrawn_at=null where id=$1`,
            [edition, 'published']]],
        ['governing series archived',
          [`update digest_series set state=$2, deleted_at=current_timestamp where id=$1`,
            [series, 'archived']],
          [`update digest_series set state=$2, deleted_at=null where id=$1`, [series, 'active']]],
      ];
      for (const [name, apply, restore] of flips) {
        await isolated.runtime.pool.query(apply[0], [...apply[1]]);
        try {
          await assert.rejects(() => client.resolveTarget(query),
            (error: unknown) => isProductClientError(error, 404, 'resource_not_found'),
            `${name} must conceal the edition`);
          assert.equal(await editionRanked(), 0, `${name} must drop the ranking candidate`);
        } finally {
          await isolated.runtime.pool.query(restore[0], [...restore[1]]);
        }
        assert.equal((await client.resolveTarget(query)).target.id, edition,
          `${name} restore must make the edition resolvable again`);
        assert.equal(await editionRanked(), 1, `${name} restore must re-rank the edition`);
      }
    } finally {
      await app.close();
    }
  }, 60_000);
});

function isProductClientError(error: unknown, status: number, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { status?: unknown; problem?: { error?: { code?: unknown } } };
  return value.status === status && value.problem?.error?.code === code;
}
