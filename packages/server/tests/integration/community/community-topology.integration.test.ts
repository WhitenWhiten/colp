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
  createPostgresCommunityTargetQueryUnitOfWork,
  createPostgresCommunityVoteCommandUnitOfWork,
} from '../../../src/infrastructure/community/index.js';
import { COMMUNITY_STATIC_GENERATION } from '../../../src/modules/community/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createPostgresBetterAuthTestFactory,
  type PostgresBetterAuthTestFactory,
} from '../../support/better-auth-test-factory.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/**
 * CS-06 topology acceptance for the community surface:
 * - two INDEPENDENT buildApiApp replicas over one PostgreSQL schema must
 *   agree on the authoritative reads (vote counts, comment lists, command
 *   receipts) — no in-process cache or single-instance state may exist;
 * - a real PostgreSQL fault (an access-exclusive community_votes lock) must
 *   surface as a bounded 503 feature_temporarily_unavailable — never a hang,
 *   a 500, an internals leak, or a half-committed write.
 * The third acceptance leg (worker restart with no lost or duplicate
 * consumption) is covered by comment-notification-worker.integration.test.ts,
 * including the cross-process API-outbox → worker hand-off.
 */
describeWithPostgres('community-social topology (CS-06)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_topology', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  function testConfig(overrides: Record<string, string> = {}): ReturnType<typeof loadConfig> {
    return loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
      ...overrides });
  }

  /**
   * One full replica composition: its own identity unit of work, its own
   * Better Auth session factory/authority, and its own community ports.
   * The ONLY state shared between replicas is the PostgreSQL schema — a
   * replica keeps nothing authoritative in process memory.
   */
  async function startReplica(config: ReturnType<typeof loadConfig>): Promise<{
    app: { close(): Promise<unknown> };
    origin: string;
    factory: PostgresBetterAuthTestFactory;
  }> {
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
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
    return { app, origin, factory };
  }

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
      [collectionId, ownerSubjectId, rootId, slug, visibility, 'Topology target']);
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

  test('two independent replicas read each other\'s writes from one PostgreSQL authority', async () => {
    const config = testConfig();
    const replicaA = await startReplica(config);
    const replicaB = await startReplica(config);
    try {
      // Sessions are minted through replica A's factory only; replica B's
      // separate authority validates the same cookie straight from the PG
      // session/metadata rows (it never saw the mint in process memory).
      const owner = await issueTestSession({ factory: replicaA.factory,
        subject: `topology-owner-${randomUUID()}`, handle: `to${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const voter = await issueTestSession({ factory: replicaA.factory,
        subject: `topology-voter-${randomUUID()}`, handle: `tv${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const collectionId = 'topology-it-collection';
      await seedCollection(collectionId, owner.subjectId, 'public', 'topology-two-replicas');

      const clientA = createProductCommunityClient({ origin: replicaA.origin,
        sessionCookie: voter.cookie, originHeader: config.productOrigin, csrfToken: voter.csrfToken });
      const clientB = createProductCommunityClient({ origin: replicaB.origin,
        sessionCookie: voter.cookie, originHeader: config.productOrigin, csrfToken: voter.csrfToken });

      // A writes the vote; B reads back the authoritative counts and the
      // same target descriptor (one writer's output is the other's input).
      const viewA = await clientA.resolveTarget({ kind: 'collection', id: collectionId });
      assert.equal(viewA.canVote, true);
      const voteCommandId = randomUUID();
      const voteA = await clientA.setVote({ target: viewA.target, value: 1 }, voteCommandId);
      assert.equal(voteA.myVote, 1);
      assert.equal(voteA.up, 1);
      const viewB = await clientB.resolveTarget({ kind: 'collection', id: collectionId });
      assert.deepEqual(viewB.target, viewA.target);
      assert.equal(viewB.votes.up, 1);
      assert.equal(viewB.votes.myVote, 1);

      // Command receipts are shared state too: replaying A's command id on B
      // returns the recorded outcome, and a changed payload under the same
      // id is the same 409 command_id_reused the single-instance test pins.
      const replayedOnB = await clientB.setVote({ target: viewA.target, value: 1 }, voteCommandId);
      assert.deepEqual(replayedOnB, voteA);
      await assert.rejects(() => clientB.setVote({ target: viewB.target, value: -1 }, voteCommandId),
        (error: unknown) => isProductClientError(error, 409, 'command_id_reused'));

      // A writes a comment; B lists it and fetches it by id.
      const commentA = await clientA.createComment(
        { target: viewA.target, body: 'written on replica A', replyToId: null }, randomUUID());
      const listedOnB = await clientB.listComments(
        { kind: 'collection', id: collectionId, generation: COMMUNITY_STATIC_GENERATION });
      assert.deepEqual(listedOnB.items.map((item) => item.id), [commentA.id]);
      assert.equal(listedOnB.items[0]?.body, 'written on replica A');
      assert.equal(listedOnB.items[0]?.author.id, voter.accountId);
      const fetchedOnB = await clientB.getComment(commentA.id);
      assert.equal(fetchedOnB.body, 'written on replica A');

      // Reverse direction: B writes vote + comment; A reads both back.
      const commentB = await clientB.createComment(
        { target: viewB.target, body: 'written on replica B', replyToId: null }, randomUUID());
      const listedOnA = await clientA.listComments(
        { kind: 'collection', id: collectionId, generation: COMMUNITY_STATIC_GENERATION });
      assert.deepEqual(listedOnA.items.map((item) => item.id).sort(),
        [commentA.id, commentB.id].sort());
      const voteB = await clientB.setVote({ target: viewB.target, value: -1 }, randomUUID());
      assert.equal(voteB.myVote, -1);
      assert.equal(voteB.down, 1);
      const viewA2 = await clientA.resolveTarget({ kind: 'collection', id: collectionId });
      assert.equal(viewA2.votes.up, 0);
      assert.equal(viewA2.votes.down, 1);
      assert.equal(viewA2.votes.myVote, -1);

      // The durable ledger agrees with both replicas' view: one vote row,
      // two comment rows, and exactly four receipts — the cross-replica
      // replay and the rejected reuse minted none.
      const rows = await isolated.runtime.pool.query<{
        votes: string; value: string; comments: string; receipts: string;
      }>(`
        select
          (select count(*)::text from community_votes where account_id=$1) votes,
          (select value::text from community_votes where account_id=$1) value,
          (select count(*)::text from community_comments where author_account_id=$1) comments,
          (select count(*)::text from product_command_receipts where principal_id=$1) receipts`,
        [voter.accountId]);
      assert.deepEqual(rows.rows[0], { votes: '1', value: '-1', comments: '2', receipts: '4' });
    } finally {
      await replicaA.app.close();
      await replicaB.app.close();
    }
  }, 60_000);

  test('an access-exclusive community_votes lock bounds the surface to 503 and recovers without partial state', async () => {
    const config = testConfig({ COMMUNITY_HTTP_TIMEOUT_MS: '50' });
    const { app, origin, factory } = await startReplica(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `topology-fowner-${randomUUID()}`, handle: `fo${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const voter = await issueTestSession({ factory,
        subject: `topology-fvoter-${randomUUID()}`, handle: `fv${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const collectionId = 'topology-it-fail-collection';
      await seedCollection(collectionId, owner.subjectId, 'public', 'topology-failure');
      const client = createProductCommunityClient({ origin,
        sessionCookie: voter.cookie, originHeader: config.productOrigin, csrfToken: voter.csrfToken });
      const target = (await client.resolveTarget({ kind: 'collection', id: collectionId })).target;

      const blocker = await isolated.runtime.pool.connect();
      await blocker.query('begin');
      await blocker.query('lock table community_votes in access exclusive mode');
      const voteCommandId = randomUUID();
      try {
        // Read path: the vote-count read blocks; the route still answers a
        // bounded 503 instead of hanging or leaking the backend error.
        const readFailure = await rejectionOf(
          client.resolveTarget({ kind: 'collection', id: collectionId }));
        assert.equal(readFailure.status, 503);
        assert.equal(readFailure.problem?.error?.code, 'feature_temporarily_unavailable');
        assert.doesNotMatch(JSON.stringify(readFailure.problem),
          /community_votes|57014|pg_|lock|access exclusive/iu);

        // Write path: the FOR UPDATE own-vote lock blocks inside the command
        // transaction; the timeout aborts and cancels the backend statement
        // so the whole transaction — receipt included — rolls back.
        const writeFailure = await rejectionOf(client.setVote({ target, value: 1 }, voteCommandId));
        assert.equal(writeFailure.status, 503);
        assert.equal(writeFailure.problem?.error?.code, 'feature_temporarily_unavailable');
        assert.equal(writeFailure.headers?.get('retry-after'), '1');
        assert.doesNotMatch(JSON.stringify(writeFailure.problem),
          /community_votes|57014|pg_|lock|access exclusive/iu);
      } finally {
        await blocker.query('rollback').catch(() => undefined);
        blocker.release();
      }

      // The fault window left no half-state: no vote row, no receipt, no
      // audit event for the failed command.
      const rows = await isolated.runtime.pool.query<{
        votes: string; receipts: string; audits: string;
      }>(`
        select
          (select count(*)::text from community_votes where account_id=$1) votes,
          (select count(*)::text from product_command_receipts
             where principal_id=$1 and command_id=$2) receipts,
          (select count(*)::text from audit_events
             where principal_id=$1 and event_type='community.vote_set') audits`,
        [voter.accountId, voteCommandId]);
      assert.deepEqual(rows.rows[0], { votes: '0', receipts: '0', audits: '0' });

      // The same instance recovers full read+write once the lock is gone.
      const recovered = await client.resolveTarget({ kind: 'collection', id: collectionId });
      assert.equal(recovered.votes.up, 0);
      const voted = await client.setVote({ target: recovered.target, value: 1 }, randomUUID());
      assert.equal(voted.myVote, 1);
      assert.equal(voted.up, 1);
    } finally {
      await app.close();
    }
  }, 60_000);
});

interface ClientFailure {
  readonly status?: unknown;
  readonly problem?: { readonly error?: { readonly code?: unknown } };
  readonly headers?: Headers;
}

/** Capture a generated-client rejection for assertion (never rethrows). */
async function rejectionOf(promise: Promise<unknown>): Promise<ClientFailure> {
  return promise.then(
    () => {
      throw new Error('expected the request to fail under the database fault');
    },
    (error: unknown) => error as ClientFailure,
  );
}

function isProductClientError(error: unknown, status: number, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { status?: unknown; problem?: { error?: { code?: unknown } } };
  return value.status === status && value.problem?.error?.code === code;
}
