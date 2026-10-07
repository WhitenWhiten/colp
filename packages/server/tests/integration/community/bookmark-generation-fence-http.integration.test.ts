import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createProductCommunityClient } from '../../../generated/openapi/product-v1.client.js';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
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
 * CS-01/CS-02 bookmark generation fencing through the real product HTTP
 * write entry (PATCH /api/v1/collections/:collectionId/nodes/:nodeId):
 *
 * - A semantic URL rewrite A→B rotates the minted `bm-gen-*` generation,
 *   and B→A rotates again (a fresh opaque value, never a rewind).
 * - A normalization-equivalent rewrite (trailing slash / default port /
 *   host case) is pinned to the stored raw URL, so the row never sees a
 *   DISTINCT url and the generation survives untouched.
 * - Every rotation fences stale votes: replaying a pre-rotation target is
 *   rejected with 409 revision_conflict while the freshly resolved target
 *   keeps accepting votes.
 */

interface ClientFailure {
  readonly status?: unknown;
  readonly problem?: { readonly error?: { readonly code?: unknown } };
}

async function rejectionOf(promise: Promise<unknown>): Promise<ClientFailure> {
  return promise.then(
    () => {
      throw new Error('expected the request to be rejected');
    },
    (error: unknown) => error as ClientFailure,
  );
}

describeWithPostgres('CS-02 bookmark generation fence via product HTTP PATCH', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_gen_fence_http', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  function testConfig() {
    return loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64') });
  }

  async function startApp(config: ReturnType<typeof testConfig>) {
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
        createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
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
      [collectionId, ownerSubjectId, 'Fence target', slug, rootId]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
          current_timestamp,current_timestamp)`, [rootId, collectionId]);
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

  async function generationOf(collectionId: string, nodeId: string): Promise<string> {
    const row = (await isolated.runtime.pool.query<{ generation: string }>(
      `select generation from community_bookmark_generations
       where collection_id=$1 and node_id=$2`, [collectionId, nodeId])).rows[0];
    assert.ok(row, 'a stored bookmark always owns a generation row');
    return row.generation;
  }

  async function storedUrl(collectionId: string, nodeId: string): Promise<string> {
    const row = (await isolated.runtime.pool.query<{ url: string }>(
      'select url from nodes where collection_id=$1 and id=$2',
      [collectionId, nodeId])).rows[0];
    assert.ok(row);
    return row.url;
  }

  async function nodeEtag(collectionId: string, nodeId: string): Promise<string> {
    const row = (await isolated.runtime.pool.query<{ resource_revision: string }>(
      'select resource_revision from nodes where collection_id=$1 and id=$2',
      [collectionId, nodeId])).rows[0];
    assert.ok(row);
    return `"${row.resource_revision}"`;
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

  test('A→B→A rewrites rotate the generation, equivalent rewrites are pinned, and stale generations are fenced', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `gf-owner-${randomUUID()}`,
        handle: `gf${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const voter = await issueTestSession({ factory,
        subject: `gf-voter-${randomUUID()}`,
        handle: `gv${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      // Canonical mutation requires 16-byte base64url opaque identities.
      const collectionId = randomBytes(16).toString('base64url');
      const bookmarkId = randomBytes(16).toString('base64url');
      const rootId = await seedCollection(collectionId, owner.subjectId,
        `gf-${randomUUID().replaceAll('-', '').slice(0, 12)}`);
      const urlA = 'https://alpha.example/path';
      const urlB = 'https://beta.example/other';
      await seedBookmark(bookmarkId, collectionId, rootId, urlA);

      const client = createProductCommunityClient({ origin,
        sessionCookie: voter.cookie, originHeader: config.productOrigin,
        csrfToken: voter.csrfToken });
      const resolve = async () => (await client.resolveTarget(
        { kind: 'bookmark', id: bookmarkId, collectionId })).target;

      const genA = await generationOf(collectionId, bookmarkId);
      assert.match(genA, /^bm-gen-/u);
      assert.equal(genA, (await resolve()).generation);

      // A→B: a semantic rewrite rotates the generation.
      const first = await patchNodeUrl(origin, owner, config, collectionId,
        bookmarkId, await nodeEtag(collectionId, bookmarkId), urlB);
      assert.equal(first.status, 200);
      assert.equal(await storedUrl(collectionId, bookmarkId), urlB);
      const genB = await generationOf(collectionId, bookmarkId);
      assert.notEqual(genB, genA, 'A→B must mint a fresh generation');
      assert.equal(genB, (await resolve()).generation);

      // The superseded generation is fenced off for interactions.
      const staleA = await rejectionOf(client.setVote(
        { target: { kind: 'bookmark', id: bookmarkId, collectionId,
            seriesId: null, generation: genA },
          value: 1 }, randomUUID()));
      assert.equal(staleA.status, 409);
      assert.equal(staleA.problem?.error?.code, 'revision_conflict');

      // B→A: rotating back mints another opaque generation — never a rewind.
      const second = await patchNodeUrl(origin, owner, config, collectionId,
        bookmarkId, await nodeEtag(collectionId, bookmarkId), urlA);
      assert.equal(second.status, 200);
      assert.equal(await storedUrl(collectionId, bookmarkId), urlA);
      const genA2 = await generationOf(collectionId, bookmarkId);
      assert.notEqual(genA2, genB, 'B→A must mint yet another generation');
      assert.notEqual(genA2, genA, 'the fence never rewinds to a spent generation');
      assert.equal(genA2, (await resolve()).generation);

      // Equivalent rewrites pin the stored raw URL: the row sees no DISTINCT
      // url, so the trigger never fires and the generation survives.
      const third = await patchNodeUrl(origin, owner, config, collectionId,
        bookmarkId, await nodeEtag(collectionId, bookmarkId),
        'https://alpha.example/path/');
      assert.equal(third.status, 200);
      assert.equal(await storedUrl(collectionId, bookmarkId), urlA,
        'the equivalent rewrite is pinned to the stored raw spelling');
      assert.equal(await generationOf(collectionId, bookmarkId), genA2,
        'a normalization-equivalent rewrite preserves the generation');

      // A second equivalent spelling (host case + default port + fragment)
      // also preserves the generation.
      const fourth = await patchNodeUrl(origin, owner, config, collectionId,
        bookmarkId, await nodeEtag(collectionId, bookmarkId),
        'https://ALPHA.example:443/path#frag');
      assert.equal(fourth.status, 200);
      assert.equal(await storedUrl(collectionId, bookmarkId), urlA);
      assert.equal(await generationOf(collectionId, bookmarkId), genA2);

      // The fresh generation keeps accepting interactions; the immediately
      // superseded one stays fenced.
      const staleB = await rejectionOf(client.setVote(
        { target: { kind: 'bookmark', id: bookmarkId, collectionId,
            seriesId: null, generation: genB },
          value: 1 }, randomUUID()));
      assert.equal(staleB.status, 409);
      assert.equal(staleB.problem?.error?.code, 'revision_conflict');
      const applied = await client.setVote(
        { target: await resolve(), value: 1 }, randomUUID());
      assert.equal(applied.myVote, 1);
      assert.equal(applied.up, 1);
      const voteRows = (await isolated.runtime.pool.query<{
        target_generation: string;
      }>(`select target_generation from community_votes
          where account_id=$1 and target_kind='bookmark' and target_id=$2`,
        [voter.accountId, bookmarkId])).rows;
      assert.equal(voteRows.length, 1);
      assert.equal(voteRows[0]!.target_generation, genA2);
    } finally {
      await app.close();
    }
  }, 60_000);
});
