import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createProductCommunityClient } from '../../../generated/openapi/product-v1.client.js';
import { loadConfig } from '../../support/test-config.js';
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
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createPostgresBetterAuthTestFactory,
  type PostgresBetterAuthTestFactory,
} from '../../support/better-auth-test-factory.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import type { IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

/*
 * Shared fixture for the bookmark-generation entry-point suite: the product
 * HTTP app composition (canonical node PATCH + every community unit of
 * work), the payload-materializing collection/bookmark seeders canonical
 * mutation requires, and the superseded-generation fence assertions every
 * URL write entry must satisfy. The getter defers `isolated` so each suite
 * keeps its own schema lifecycle.
 */
export function createGenerationEntriesFixture(getIsolated: () => IsolatedPostgresRuntime) {
  function testConfig(): ReturnType<typeof loadConfig> {
    return loadConfig({ ...process.env, DATABASE_URL: getIsolated().databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64') });
  }

  async function startApp(config: ReturnType<typeof loadConfig>): Promise<{
    app: { close(): Promise<unknown> };
    origin: string;
    factory: PostgresBetterAuthTestFactory;
  }> {
    const isolated = getIsolated();
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

  /** Backfill `payload_json`/`payload_schema_version` for a seeded row. */
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

  /**
   * A bare principal row for the entries that bind by principalId rather
   * than a browser session (MCP / publisher / sync / restore).
   */
  async function seedAccount(accountId: string): Promise<void> {
    const pool = getIsolated().runtime.pool;
    await pool.query(
      `insert into accounts(id, subject_id, status, security_epoch)
       values ($1, $1, 'active', 0)`, [accountId]);
    await pool.query(
      `insert into profiles(account_id, display_name, avatar_url)
       values ($1, 'Entry principal', null)`, [accountId]);
  }

  /** Public, published collection + one bookmark at `urlA`. */
  async function seedEntryFixture(
    ownerSubjectId: string,
    urlA: string,
  ): Promise<{ collectionId: string; nodeId: string; rootId: string }> {
    const collectionId = randomBytes(16).toString('base64url');
    const nodeId = randomBytes(16).toString('base64url');
    const rootId = randomBytes(16).toString('base64url');
    const client = await getIsolated().runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'collection',current_timestamp),($2,'node',current_timestamp),
           ($3,'node',current_timestamp)`, [collectionId, rootId, nodeId]);
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
        commit_ordinal,created_at,updated_at)
        values($1,$2,$3,'bookmarks','public',$4,current_timestamp,$5,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, ownerSubjectId, 'Entry target',
        `ge-${randomUUID().replaceAll('-', '').slice(0, 12)}`, rootId]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
          current_timestamp,current_timestamp),
        ($3,$2,$1,'bookmark',false,'Bookmark',$4,'a0','r1','ch1',
          current_timestamp,current_timestamp)`,
      [rootId, collectionId, nodeId, urlA]);
      await materializeFixture(client, collectionId, rootId);
      await materializeFixture(client, collectionId, nodeId);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { collectionId, nodeId, rootId };
  }

  async function generationOf(collectionId: string, nodeId: string): Promise<string> {
    const row = (await getIsolated().runtime.pool.query<{ generation: string }>(
      `select generation from community_bookmark_generations
       where collection_id=$1 and node_id=$2`, [collectionId, nodeId])).rows[0];
    assert.ok(row, 'a stored bookmark always owns a generation row');
    return row.generation;
  }

  async function nodeFacts(
    collectionId: string,
    nodeId: string,
  ): Promise<{ url: string; revision: string }> {
    const row = (await getIsolated().runtime.pool.query<{
      url: string; resource_revision: string;
    }>('select url, resource_revision from nodes where collection_id=$1 and id=$2',
      [collectionId, nodeId])).rows[0];
    assert.ok(row);
    return { url: row.url, revision: row.resource_revision };
  }

  async function collectionContentRevision(collectionId: string): Promise<string> {
    const row = (await getIsolated().runtime.pool.query<{ content_revision: string }>(
      'select content_revision from collections where id=$1', [collectionId])).rows[0];
    assert.ok(row);
    return row.content_revision;
  }

  /**
   * One community member binds a comment and an upvote to the CURRENT
   * generation over real HTTP; returns the handles the fence checks need.
   */
  async function bindInteractions(
    origin: string,
    config: ReturnType<typeof testConfig>,
    factory: PostgresBetterAuthTestFactory,
    collectionId: string,
    nodeId: string,
  ) {
    const member = await issueTestSession({ factory,
      subject: `ge-member-${randomUUID()}`,
      handle: `gm${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const client = createProductCommunityClient({ origin,
      sessionCookie: member.cookie, originHeader: config.productOrigin,
      csrfToken: member.csrfToken });
    const anonymous = createProductCommunityClient({ origin });
    const query = { kind: 'bookmark', id: nodeId, collectionId };
    const target = (await client.resolveTarget(query)).target;
    const comment = await client.createComment(
      { target, body: `bound to ${target.generation}`, replyToId: null }, randomUUID());
    const vote = await client.setVote({ target, value: 1 }, randomUUID());
    assert.equal(vote.up, 1);
    return { client, anonymous, query, target, commentId: comment.id };
  }

  type Interactions = Awaited<ReturnType<typeof bindInteractions>>;

  /**
   * The generation must now be a fresh opaque value that never rewinds to a
   * spent one, and the resolved target must present it.
   */
  async function expectRotation(
    inter: Interactions,
    collectionId: string,
    nodeId: string,
    expectedUrl: string,
    spentGenerations: readonly string[],
  ): Promise<string> {
    assert.equal((await nodeFacts(collectionId, nodeId)).url, expectedUrl,
      'the entry must persist the rewritten raw URL');
    const generation = await generationOf(collectionId, nodeId);
    for (const spent of spentGenerations) {
      assert.notEqual(generation, spent, 'the fence never rewinds to a spent generation');
    }
    const resolved = await inter.anonymous.resolveTarget(inter.query);
    assert.equal(resolved.target.generation, generation,
      'the resolved target presents the freshly minted generation');
    return generation;
  }

  /**
   * Interactions bound to a superseded generation are fenced: the vote
   * replay is 409 revision_conflict, the comment conceals to 404 on both
   * the id read and the stale-generation list, and nothing migrated to the
   * live generation.
   */
  async function assertSupersededFenced(
    inter: Interactions,
    staleGenerations: readonly string[],
  ): Promise<void> {
    for (const generation of staleGenerations) {
      const staleVote = await rejectionOf(inter.client.setVote(
        { target: { ...inter.target, generation }, value: -1 }, randomUUID()));
      assert.equal(staleVote.status, 409);
      assert.equal(staleVote.problem?.error?.code, 'revision_conflict');
      const staleList = await rejectionOf(inter.client.listComments(
        { ...inter.query, generation }));
      assert.equal(staleList.status, 404);
      assert.equal(staleList.problem?.error?.code, 'resource_not_found');
    }
    const concealed = await rejectionOf(inter.client.getComment(inter.commentId));
    assert.equal(concealed.status, 404);
    assert.equal(concealed.problem?.error?.code, 'resource_not_found');
    const live = await inter.anonymous.resolveTarget(inter.query);
    assert.equal(live.votes.up, 0,
      'the old-generation vote must not migrate to the live generation');
    const liveComments = await inter.anonymous.listComments(
      { ...inter.query, generation: live.target.generation });
    assert.ok(!liveComments.items.some((item) => item.id === inter.commentId),
      'the old-generation comment must not appear under the live generation');
  }

  /** Real product HTTP PATCH of the node url through the merge-patch route. */
  async function productPatchUrl(
    origin: string,
    config: ReturnType<typeof testConfig>,
    owner: { cookie: string; csrfToken: string },
    seed: { collectionId: string; nodeId: string },
    url: string,
  ): Promise<void> {
    const { revision } = await nodeFacts(seed.collectionId, seed.nodeId);
    const response = await fetch(
      `${origin}/api/v1/collections/${seed.collectionId}/nodes/${seed.nodeId}`, {
        method: 'PATCH',
        headers: {
          cookie: owner.cookie,
          origin: config.productOrigin,
          'x-csrf-token': owner.csrfToken,
          'known-command-id': randomUUID(),
          'if-match': `"${revision}"`,
          'content-type': 'application/merge-patch+json',
        },
        body: JSON.stringify({ url }),
      });
    assert.equal(response.status, 200);
  }

  return {
    testConfig,
    startApp,
    materializeFixture,
    seedAccount,
    seedEntryFixture,
    generationOf,
    nodeFacts,
    collectionContentRevision,
    bindInteractions,
    expectRotation,
    assertSupersededFenced,
    productPatchUrl,
  };
}

export interface ClientFailure {
  readonly status?: unknown;
  readonly problem?: { readonly error?: { readonly code?: unknown } };
}

export async function rejectionOf(promise: Promise<unknown>): Promise<ClientFailure> {
  return promise.then(
    () => {
      throw new Error('expected the request to be rejected');
    },
    (error: unknown) => error as ClientFailure,
  );
}
