import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createProductCommunityClient } from '../../../generated/openapi/product-v1.client.js';
import { loadConfig } from '../../support/test-config.js';
import {
  createDatabaseRuntime,
  runMigrations,
  type DatabaseRuntime,
} from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresCommunityCommentCommandUnitOfWork,
  createPostgresCommunityCommentManageUnitOfWork,
  createPostgresCommunityCommentQueryUnitOfWork,
  createPostgresCommunityNotificationCommandUnitOfWork,
  createPostgresCommunityNotificationQueryUnitOfWork,
  createPostgresCommunityRankingQueryUnitOfWork,
  createPostgresCommunityTargetQueryUnitOfWork,
  createPostgresCommunityVoteCommandUnitOfWork,
} from '../../../src/infrastructure/community/index.js';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/*
 * CS-01/CS-02 generation-race and durability evidence over PostgreSQL:
 *
 * - A vote racing a real bookmark URL rewrite either lands on the superseded
 *   generation (and is then excluded from current counts) or observes the
 *   new one — never a torn state; the stale generation is rejected with
 *   409 revision_conflict afterwards.
 * - Interaction writes (votes, comments, curation, notification reads and
 *   preferences) never touch the canonical `nodes`/`collections` revision
 *   or `updated_at` authority.
 * - A lost COMMIT acknowledgement on the vote path surfaces a bounded
 *   outcome (never a false "rolled back" claim); the durable product receipt
 *   then replays the stored result without a second vote/audit write.
 */

interface ClientFailure {
  readonly status?: unknown;
  readonly problem?: { readonly error?: { readonly code?: unknown } };
  readonly headers?: Headers;
}

async function rejectionOf(promise: Promise<unknown>): Promise<ClientFailure> {
  return promise.then(
    () => {
      throw new Error('expected the request to be rejected');
    },
    (error: unknown) => error as ClientFailure,
  );
}

function isProductClientError(error: unknown, status: number, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { status?: unknown; problem?: { error?: { code?: unknown } } };
  return value.status === status && value.problem?.error?.code === code;
}

describeWithPostgres('CS-01 community vote concurrency and durability', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_vote_concurrency', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  function testConfig(overrides: Record<string, string> = {}) {
    return loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
      ...overrides });
  }

  /** Full community surface plus the canonical node PATCH write route. */
  async function startApp(
    config: ReturnType<typeof testConfig>,
    options: { readonly voteDb?: DatabaseRuntime['db'] } = {},
  ) {
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const app = buildApiApp({
      config,
      identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork:
        createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      communityTargetQueryUnitOfWork:
        createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork:
        createPostgresCommunityVoteCommandUnitOfWork(options.voteDb ?? isolated.runtime.db),
      communityRankingQueryUnitOfWork:
        createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork:
        createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork:
        createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
          etagHmacKey: config.community.cursorHmacKey,
        }),
      communityCommentManageUnitOfWork:
        createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
          etagHmacKey: config.community.cursorHmacKey,
        }),
      communityNotificationQueryUnitOfWork:
        createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork:
        createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
          etagHmacKey: config.community.cursorHmacKey,
        }),
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, origin, factory };
  }

  function communityClient(
    origin: string,
    config: ReturnType<typeof testConfig>,
    session?: Pick<AuthenticatedTestClient, 'cookie' | 'csrfToken'>,
  ) {
    return createProductCommunityClient({
      origin,
      ...(session === undefined ? {} : {
        sessionCookie: session.cookie,
        originHeader: config.productOrigin,
        csrfToken: session.csrfToken,
      }),
    });
  }

  async function seedCollection(
    collectionId: string,
    ownerSubjectId: string,
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
        values($1,$2,$3,'bookmarks','public',$4,current_timestamp,$5,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, ownerSubjectId, 'Concurrency target', slug, rootId]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
          current_timestamp,current_timestamp)`, [rootId, collectionId]);
      // Canonical mutations require materialized payload authority — the
      // production write path maintains it, so fixtures backfill it here.
      await materializeFixture(client, collectionId, rootId);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return rootId;
  }

  async function seedBookmark(
    nodeId: string,
    collectionId: string,
    parentId: string,
    url: string,
  ): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id,resource_type,committed_at)
       values($1,'node',current_timestamp)`, [nodeId]);
    await isolated.runtime.pool.query(`insert into nodes(
      id,collection_id,parent_id,kind,is_root,title,url,position_token,
      resource_revision,children_revision,created_at,updated_at)
      values($1,$2,$3,'bookmark',false,'Bookmark',$4,'a0','r1','ch1',
        current_timestamp,current_timestamp)`, [nodeId, collectionId, parentId, url]);
    await materializeFixture(isolated.runtime.pool, collectionId, nodeId);
  }

  /** Backfill `payload_json`/`payload_schema_version` for the seeded rows. */
  async function materializeFixture(
    queryable: Pick<IsolatedPostgresRuntime['runtime']['pool'], 'query'>,
    collectionId: string,
    nodeId: string,
  ): Promise<void> {
    const collection = (await queryable.query(
      'select * from collections where id=$1', [collectionId])).rows[0];
    const materializedCollection = materializeCollectionPayload({
      id: collection.id, ownerSubjectId: collection.owner_subject_id,
      title: collection.title, summary: collection.summary, kind: collection.kind,
      visibility: collection.visibility, rootNodeId: collection.root_node_id,
      resourceRevision: collection.resource_revision,
      contentRevision: collection.content_revision,
      policyRevision: collection.policy_revision,
      commitOrdinal: collection.commit_ordinal, createdAt: collection.created_at,
      updatedAt: collection.updated_at, deletedAt: collection.deleted_at,
    });
    assert.equal(materializedCollection.ok, true);
    if (!materializedCollection.ok) throw new Error(materializedCollection.reason);
    await queryable.query(
      `update collections set payload_json=$2::jsonb, payload_schema_version=$3,
         payload_authority_status='backfilled' where id=$1`,
      [collectionId, JSON.stringify(materializedCollection.payload),
        RESOURCE_PAYLOAD_SCHEMA_VERSION]);
    const node = (await queryable.query('select * from nodes where id=$1', [nodeId])).rows[0];
    const materializedNode = materializeNodePayload({
      id: node.id, collectionId: node.collection_id, parentId: node.parent_id,
      kind: node.kind, isRoot: node.is_root, title: node.title, url: node.url,
      description: node.description, tags: node.tags, visibility: node.visibility,
      positionToken: node.position_token, resourceRevision: node.resource_revision,
      childrenRevision: node.children_revision, createdAt: node.created_at,
      updatedAt: node.updated_at, deletedAt: node.deleted_at,
      deletedCommitOrdinal: node.deleted_commit_ordinal,
    });
    assert.equal(materializedNode.ok, true);
    if (!materializedNode.ok) throw new Error(materializedNode.reason);
    await queryable.query(
      `update nodes set payload_json=$2::jsonb, payload_schema_version=$3,
         payload_authority_status='backfilled' where id=$1`,
      [nodeId, JSON.stringify(materializedNode.payload), RESOURCE_PAYLOAD_SCHEMA_VERSION]);
  }

  async function generationOf(collectionId: string, nodeId: string): Promise<string> {
    const row = (await isolated.runtime.pool.query<{ generation: string }>(
      `select generation from community_bookmark_generations
       where collection_id=$1 and node_id=$2`, [collectionId, nodeId])).rows[0];
    assert.ok(row, 'a stored bookmark always owns a generation row');
    return row.generation;
  }

  /** Real HTTP PATCH of a node URL through the product merge-patch route. */
  async function patchNodeUrl(
    origin: string,
    owner: Pick<AuthenticatedTestClient, 'cookie' | 'csrfToken'>,
    config: ReturnType<typeof testConfig>,
    collectionId: string,
    nodeId: string,
    ifMatch: string,
    url: string,
  ): Promise<Response> {
    return fetch(`${origin}/api/v1/collections/${collectionId}/nodes/${nodeId}`, {
      method: 'PATCH',
      headers: {
        cookie: owner.cookie,
        origin: config.productOrigin,
        'x-csrf-token': owner.csrfToken,
        'known-command-id': randomUUID(),
        'if-match': ifMatch,
        'content-type': 'application/merge-patch+json',
      },
      body: JSON.stringify({ url }),
    });
  }

  async function canonicalSnapshot(collectionId: string) {
    const collections = await isolated.runtime.pool.query(
      `select id, resource_revision, content_revision, policy_revision,
         commit_ordinal::text, created_at, updated_at, payload_json
       from collections where id=$1`, [collectionId]);
    const nodes = await isolated.runtime.pool.query(
      `select id, resource_revision, children_revision, created_at, updated_at,
         payload_json from nodes where collection_id=$1 order by id`, [collectionId]);
    return { collections: collections.rows, nodes: nodes.rows };
  }

  test('a vote racing a real bookmark URL rewrite lands on exactly one generation', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `vr-owner-${randomUUID()}`, handle: `ro${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const voter = await issueTestSession({ factory,
        subject: `vr-voter-${randomUUID()}`, handle: `rv${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      // The canonical PATCH entry emits a social-collection-change outbox
      // event whose mapper requires canonical 16-byte base64url identities.
      const collectionId = randomBytes(16).toString('base64url');
      const bookmarkId = randomBytes(16).toString('base64url');
      const rootId = await seedCollection(collectionId, owner.subjectId, 'vr-race');
      await seedBookmark(bookmarkId, collectionId, rootId, 'https://race.example/one');

      const client = communityClient(origin, config, voter);
      const view = await client.resolveTarget(
        { kind: 'bookmark', id: bookmarkId, collectionId });
      const genOne = view.target.generation;
      assert.equal(genOne, await generationOf(collectionId, bookmarkId));

      const nodeBefore = (await isolated.runtime.pool.query<{
        resource_revision: string;
      }>(`select resource_revision from nodes where id=$1`, [bookmarkId])).rows[0]!;

      // The vote command locks the bookmark row (for update of n); the real
      // canonical PATCH writes the same row. Whichever commit lands first,
      // the outcome is exactly one consistent state.
      const [patchResult, voteOutcome] = await Promise.all([
        patchNodeUrl(origin, owner, config, collectionId, bookmarkId,
          `"${nodeBefore.resource_revision}"`, 'https://race.example/two'),
        client.setVote({ target: view.target, value: 1 }, randomUUID())
          .then((state) => ({ kind: 'resolved' as const, state }))
          .catch((error: unknown) => ({ kind: 'rejected' as const, error })),
      ]);
      assert.equal(patchResult.status, 200, 'the canonical URL rewrite always commits');

      const genTwo = await generationOf(collectionId, bookmarkId);
      assert.notEqual(genTwo, genOne, 'the semantic URL rewrite rotated the generation');

      const voteRows = (await isolated.runtime.pool.query<{
        value: number; target_generation: string;
      }>(`select value, target_generation from community_votes
          where account_id=$1 and target_kind='bookmark' and target_id=$2`,
        [voter.accountId, bookmarkId])).rows;
      if (voteOutcome.kind === 'resolved') {
        // The vote committed first (on genOne); its row stays bound to the
        // superseded generation and must not count against the fresh target.
        assert.equal(voteRows.length, 1);
        assert.equal(voteRows[0]!.target_generation, genOne);
        const freshView = await client.resolveTarget(
          { kind: 'bookmark', id: bookmarkId, collectionId });
        assert.equal(freshView.target.generation, genTwo);
        assert.equal(freshView.votes.up, 0, 'a superseded-generation vote is invisible');
        assert.equal(freshView.votes.myVote, 0,
          'the superseded-generation vote does not show as myVote');
      } else {
        // The rewrite committed first: the stale target was refused before
        // any vote write — the durable state stays clean.
        assert.ok(isProductClientError(voteOutcome.error, 409, 'revision_conflict'));
        assert.equal(voteRows.length, 0);
      }

      // Whichever order won, the stale generation stays rejected and the
      // freshly resolved target accepts the vote.
      const stale = await rejectionOf(
        client.setVote({ target: { ...view.target }, value: 1 }, randomUUID()));
      assert.equal(stale.status, 409);
      assert.equal(stale.problem?.error?.code, 'revision_conflict');
      const freshTarget = (await client.resolveTarget(
        { kind: 'bookmark', id: bookmarkId, collectionId })).target;
      const applied = await client.setVote({ target: freshTarget, value: 1 }, randomUUID());
      assert.equal(applied.myVote, 1);
      assert.equal(applied.up, 1);
      const finalRows = (await isolated.runtime.pool.query<{
        target_generation: string;
      }>(`select target_generation from community_votes
          where account_id=$1 and target_kind='bookmark' and target_id=$2`,
        [voter.accountId, bookmarkId])).rows;
      assert.equal(finalRows.length, 1);
      assert.equal(finalRows[0]!.target_generation, genTwo);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('interaction writes never touch canonical revisions or updated_at', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `ir-owner-${randomUUID()}`, handle: `io${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const voter = await issueTestSession({ factory,
        subject: `ir-voter-${randomUUID()}`, handle: `iv${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const commenter = await issueTestSession({ factory,
        subject: `ir-commenter-${randomUUID()}`, handle: `ic${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const collectionId = 'ir-it-canonical-collection';
      const bookmarkId = 'ir-it-canonical-bookmark';
      const rootId = await seedCollection(collectionId, owner.subjectId, 'ir-canonical');
      await seedBookmark(bookmarkId, collectionId, rootId, 'https://canonical.example/one');

      const voterClient = communityClient(origin, config, voter);
      const commenterClient = communityClient(origin, config, commenter);
      const ownerClient = communityClient(origin, config, owner);
      const before = await canonicalSnapshot(collectionId);

      // Vote on the collection and on the bookmark.
      const collectionTarget = (await voterClient.resolveTarget(
        { kind: 'collection', id: collectionId })).target;
      await voterClient.setVote({ target: collectionTarget, value: 1 }, randomUUID());
      const bookmarkTarget = (await voterClient.resolveTarget(
        { kind: 'bookmark', id: bookmarkId, collectionId })).target;
      await voterClient.setVote({ target: bookmarkTarget, value: -1 }, randomUUID());

      // Comment + curation overlay on the same collection.
      const comment = await commenterClient.createComment(
        { target: collectionTarget, body: 'interaction side-effects', replyToId: null },
        randomUUID());
      const curation = await ownerClient.getCuration(comment.id);
      assert.ok(curation.etag, 'the curation surface always carries a strong ETag');
      await ownerClient.setCuration(
        comment.id, { hidden: true, reason: 'curated' }, curation.etag, randomUUID());

      // A read-transition on a real notification row (projection fixture; the
      // write path stays HTTP) — performed while the channel is still enabled.
      const notificationId = `ir-notification-${randomUUID()}`;
      await isolated.runtime.pool.query(
        `insert into notifications(
           notification_id,recipient_account_id,source_event_id,notification_type,
           actor_profile_id,subject_type,subject_id,state,read_at,occurred_at,retain_until)
         values($1,$2,$3,'comment_reply',$4,'community_comment',$5,'unread',null,
           current_timestamp,current_timestamp + interval '365 days')`,
        [notificationId, commenter.accountId, `ir-event-${randomUUID()}`,
          voter.accountId, comment.id]);
      const marked = await commenterClient.markNotificationsRead(
        { ids: [notificationId] }, randomUUID());
      assert.equal(marked.changedIds.includes(notificationId), true);
      // Notification preference write through the real HTTP surface.
      const preference = await commenterClient.getNotificationPreference();
      assert.ok(preference.etag, 'the preference surface always carries a strong ETag');
      await commenterClient.putNotificationPreference(
        { enabled: false }, preference.etag, randomUUID());

      // Interaction authority exists — and canonical authority is byte-identical.
      const interactions = await isolated.runtime.pool.query<{
        votes: string; comments: string; curations: string;
        preference: string; readState: string;
      }>(`
        select
          (select count(*)::text from community_votes
             where (target_kind='collection' and target_id=$1)
                or (target_kind='bookmark' and target_id=$2)) votes,
          (select count(*)::text from community_comments where comment_id=$3) comments,
          (select count(*)::text from community_comment_curations where comment_id=$3) curations,
          (select count(*)::text from notification_preferences
             where recipient_account_id=$4 and channel='community') preference,
          (select state from notifications where notification_id=$5) "readState"`,
        [collectionId, bookmarkId, comment.id, commenter.accountId, notificationId]);
      assert.deepEqual(interactions.rows[0], {
        votes: '2', comments: '1', curations: '1', preference: '1', readState: 'read',
      });
      const after = await canonicalSnapshot(collectionId);
      assert.deepEqual(after, before,
        'votes, comments, curation and notification writes must not mutate canonical authority');
    } finally {
      await app.close();
    }
  }, 60_000);

  test('a lost COMMIT acknowledgement on the vote path replays the durable receipt', async () => {
    const config = testConfig();
    // A second runtime on the same isolated schema: the real COMMIT statement
    // is applied, then the injected fault severs the acknowledgement. The
    // route must report a bounded outcome and never claim a false rollback.
    let armed = true;
    const faultyRuntime = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 4,
      applicationName: 'known-vote-lost-ack-test',
      transactionPhaseFaultInjector: {
        async afterCommitApplied() {
          if (armed) {
            throw Object.assign(new Error('simulated lost commit acknowledgement'),
              { code: 'ECONNRESET' });
          }
        },
      },
    });
    try {
      const { app, origin, factory } = await startApp(config, { voteDb: faultyRuntime.db });
      try {
        const owner = await issueTestSession({ factory,
          subject: `la-owner-${randomUUID()}`, handle: `lo${randomUUID().replaceAll('-', '').slice(0, 12)}` });
        const voter = await issueTestSession({ factory,
          subject: `la-voter-${randomUUID()}`, handle: `lv${randomUUID().replaceAll('-', '').slice(0, 12)}` });
        const collectionId = 'la-it-lost-ack-collection';
        await seedCollection(collectionId, owner.subjectId, 'la-lost-ack');
        const client = communityClient(origin, config, voter);
        const target = (await client.resolveTarget({ kind: 'collection', id: collectionId })).target;

        const commandId = randomUUID();
        const refreshEvents = async () => (await isolated.runtime.pool
          .query<{ count: string }>(`select count(*)::text count from outbox_events
            where event_type='community.rank-refresh'`)).rows[0]!.count;
        const beforeEvents = await refreshEvents();

        const failure = await rejectionOf(client.setVote({ target, value: 1 }, commandId));
        assert.equal(failure.status, 503, 'unknown outcome is bounded, never a false success');
        assert.equal(failure.problem?.error?.code, 'feature_temporarily_unavailable');

        // The COMMIT was applied: the vote row, completed receipt, audit
        // record and the atomic refresh event are all durable.
        const committed = await isolated.runtime.pool.query<{
          votes: string; value: number | null; receipts: string; audits: string;
        }>(`
          select
            (select count(*)::text from community_votes
               where account_id=$1 and target_kind='collection' and target_id=$2) votes,
            (select value from community_votes
               where account_id=$1 and target_kind='collection' and target_id=$2) value,
            (select count(*)::text from product_command_receipts
               where principal_id=$1 and command_id=$3) receipts,
            (select count(*)::text from audit_events
               where principal_id=$1 and event_type='community.vote_set') audits`,
          [voter.accountId, collectionId, commandId]);
        assert.deepEqual(committed.rows[0], {
          votes: '1', value: 1, receipts: '1', audits: '1',
        });
        assert.equal(BigInt(await refreshEvents()) - BigInt(beforeEvents), 1n,
          'the atomic rank-refresh event committed with the vote');

        // The receipt boundary recovers: replaying the same command id
        // returns the stored outcome without a second mutation.
        armed = false;
        const replayed = await client.setVote({ target, value: 1 }, commandId);
        assert.equal(replayed.myVote, 1);
        assert.equal(replayed.up, 1);
        const afterReplay = await isolated.runtime.pool.query<{
          votes: string; receipts: string; audits: string;
        }>(`
          select
            (select count(*)::text from community_votes
               where account_id=$1 and target_kind='collection' and target_id=$2) votes,
            (select count(*)::text from product_command_receipts
               where principal_id=$1 and command_id=$3) receipts,
            (select count(*)::text from audit_events
               where principal_id=$1 and event_type='community.vote_set') audits`,
          [voter.accountId, collectionId, commandId]);
        assert.deepEqual(afterReplay.rows[0], { votes: '1', receipts: '1', audits: '1' },
          'receipt replay must not double the vote, receipt or audit rows');
      } finally {
        await app.close();
      }
    } finally {
      armed = false;
      await faultyRuntime.close();
    }
  }, 60_000);
});
