import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createProductCommunityClient } from '../../../generated/openapi/product-v1.client.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  createCommentHttpFixture,
  isProductClientError,
} from './comment-http-helpers.js';

describeWithPostgres('community-social comment http threads', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_comment_http_threads', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  const { testConfig, startApp, seedCollection, seedBookmark, seedCommentRow, rawGet } =
    createCommentHttpFixture(() => isolated);

  test('replyToId must name a visible comment on the same target; depth 2 is the ceiling', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `comment-ronwer-${randomUUID()}`, handle: `cr${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const commenter = await issueTestSession({ factory,
        subject: `comment-roactor-${randomUUID()}`, handle: `cq${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const collectionA = 'comment-it-collection-reply-a';
      const collectionB = 'comment-it-collection-reply-b';
      await seedCollection(collectionA, owner.subjectId, 'public', 'comment-reply-a');
      await seedCollection(collectionB, owner.subjectId, 'public', 'comment-reply-b');

      const anonymous = createProductCommunityClient({ origin });
      const client = createProductCommunityClient({ origin, sessionCookie: commenter.cookie,
        originHeader: config.productOrigin, csrfToken: commenter.csrfToken });
      const targetA = (await client.resolveTarget({ kind: 'collection', id: collectionA })).target;
      const targetB = (await client.resolveTarget({ kind: 'collection', id: collectionB })).target;

      const rootA = await client.createComment(
        { target: targetA, body: 'Root on A', replyToId: null }, randomUUID());
      const rootB = await client.createComment(
        { target: targetB, body: 'Root on B', replyToId: null }, randomUUID());

      // Cross-root/cross-target replyToId is the concealed 404 — a comment id
      // from another target is never an oracle for that target's thread.
      await assert.rejects(() => client.createComment(
        { target: targetA, body: 'Cross target', replyToId: rootB.id }, randomUUID()),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
      await assert.rejects(() => client.createComment(
        { target: targetB, body: 'Cross target back', replyToId: rootA.id }, randomUUID()),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
      // Same for a replyToId that names no stored comment at all.
      await assert.rejects(() => client.createComment(
        { target: targetA, body: 'Ghost parent', replyToId: 'comment-no-such-parent' }, randomUUID()),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));

      // Depth chain: root(0) -> reply(1) -> nested reply(2); depth 3 is
      // structurally impossible and rejects as invalid_request, not 404.
      const depth1 = await client.createComment(
        { target: targetA, body: 'Depth one', replyToId: rootA.id }, randomUUID());
      assert.equal(depth1.depth, 1);
      assert.equal(depth1.rootId, rootA.id);
      const depth2 = await client.createComment(
        { target: targetA, body: 'Depth two', replyToId: depth1.id }, randomUUID());
      assert.equal(depth2.depth, 2);
      assert.equal(depth2.rootId, rootA.id);
      assert.equal(depth2.replyToId, depth1.id);
      await assert.rejects(() => client.createComment(
        { target: targetA, body: 'Depth three', replyToId: depth2.id }, randomUUID()),
        (error: unknown) => isProductClientError(error, 400, 'invalid_request'));

      // The replies endpoint requires the ROOT id; a reply id is 400.
      await assert.rejects(() => anonymous.listReplies(depth1.id),
        (error: unknown) => isProductClientError(error, 400, 'invalid_request'));
      await assert.rejects(() => anonymous.listReplies(depth2.id),
        (error: unknown) => isProductClientError(error, 400, 'invalid_request'));

      // The flattened thread returns both descendants of the root.
      const thread = await anonymous.listReplies(rootA.id);
      assert.deepEqual(thread.items.map((item) => item.id).sort(), [depth1.id, depth2.id].sort());
      assert.deepEqual(thread.items.map((item) => item.depth).sort(), [1, 2]);
      assert.ok(thread.items.every((item) => item.rootId === rootA.id));
    } finally {
      await app.close();
    }
  }, 60_000);

  test('opaque cursors paginate stably and tamper or binding mismatch is invalid_cursor', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `comment-powner-${randomUUID()}`, handle: `cp${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const commenter = await issueTestSession({ factory,
        subject: `comment-pactor-${randomUUID()}`, handle: `cu${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const collectionId = 'comment-it-collection-paging';
      await seedCollection(collectionId, owner.subjectId, 'public', 'comment-paging');

      // Deterministic ordering: roots newest-first (createdAt DESC, id ASC).
      const rootIds = ['page-root-1', 'page-root-2', 'page-root-3', 'page-root-4'];
      for (const [index, id] of rootIds.entries()) {
        await seedCommentRow({
          id, targetKind: 'collection', targetId: collectionId, generation: 'static-v1',
          authorAccountId: commenter.accountId, body: `Root ${index + 1}`,
          minutesAgo: 40 - index * 10,
        });
      }
      // Replies oldest-first under the first root.
      const replyIds = ['page-reply-1', 'page-reply-2', 'page-reply-3'];
      for (const [index, id] of replyIds.entries()) {
        await seedCommentRow({
          id, targetKind: 'collection', targetId: collectionId, generation: 'static-v1',
          rootId: 'page-root-1', replyToId: 'page-root-1', depth: 1,
          authorAccountId: commenter.accountId, body: `Reply ${index + 1}`,
          minutesAgo: 30 - index * 10,
        });
      }

      const anonymous = createProductCommunityClient({ origin });
      const client = createProductCommunityClient({ origin, sessionCookie: commenter.cookie,
        originHeader: config.productOrigin, csrfToken: commenter.csrfToken });
      const listQuery = { kind: 'collection' as const, id: collectionId,
        generation: 'static-v1' };

      // Two stable pages of roots, newest first, no overlap.
      const page1 = await anonymous.listComments({ ...listQuery, limit: 2 });
      assert.deepEqual(page1.items.map((item) => item.id), ['page-root-4', 'page-root-3']);
      assert.ok(page1.nextCursor !== null);
      const page2 = await anonymous.listComments(
        { ...listQuery, limit: 2, cursor: page1.nextCursor! });
      assert.deepEqual(page2.items.map((item) => item.id), ['page-root-2', 'page-root-1']);
      assert.equal(page2.nextCursor, null);
      // Page 2 carries the thread reply count for the seeded root.
      assert.equal(page2.items.find((item) => item.id === 'page-root-1')?.replyCount, 3);

      // Tampered signature/body segments are invalid_cursor, not a silent restart.
      const tampered = `${page1.nextCursor!.slice(0, -1)}${page1.nextCursor!.endsWith('a') ? 'b' : 'a'}`;
      await assert.rejects(() => anonymous.listComments(
        { ...listQuery, limit: 2, cursor: tampered }),
        (error: unknown) => isProductClientError(error, 400, 'invalid_cursor'));
      const garbage = await rawGet(origin,
        `/api/v1/community/comments?kind=collection&id=${collectionId}&generation=static-v1&cursor=not.a.cursor`);
      assert.equal(garbage.status, 400);
      assert.equal(garbage.body.error?.code, 'invalid_cursor');

      // Binding mismatch: limit and viewer are sealed into the cursor.
      await assert.rejects(() => anonymous.listComments(
        { ...listQuery, limit: 3, cursor: page1.nextCursor! }),
        (error: unknown) => isProductClientError(error, 400, 'invalid_cursor'));
      await assert.rejects(() => client.listComments(
        { ...listQuery, limit: 2, cursor: page1.nextCursor! }),
        (error: unknown) => isProductClientError(error, 400, 'invalid_cursor'));
      // A root-list cursor can never verify on the replies endpoint.
      await assert.rejects(() => anonymous.listReplies('page-root-1',
        { limit: 2, cursor: page1.nextCursor! }),
        (error: unknown) => isProductClientError(error, 400, 'invalid_cursor'));

      // Replies paginate the flattened descendants oldest-first.
      const replies1 = await anonymous.listReplies('page-root-1', { limit: 2 });
      assert.deepEqual(replies1.items.map((item) => item.id), ['page-reply-1', 'page-reply-2']);
      assert.ok(replies1.nextCursor !== null);
      const replies2 = await anonymous.listReplies('page-root-1',
        { limit: 2, cursor: replies1.nextCursor! });
      assert.deepEqual(replies2.items.map((item) => item.id), ['page-reply-3']);
      assert.equal(replies2.nextCursor, null);
      const tamperedReplies = `${replies1.nextCursor!.slice(0, -1)}${replies1.nextCursor!.endsWith('a') ? 'b' : 'a'}`;
      await assert.rejects(() => anonymous.listReplies('page-root-1',
        { limit: 2, cursor: tamperedReplies }),
        (error: unknown) => isProductClientError(error, 400, 'invalid_cursor'));
    } finally {
      await app.close();
    }
  }, 60_000);

  test('a target that turns private conceals every comment operation uniformly', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `comment-howner-${randomUUID()}`, handle: `ch${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const commenter = await issueTestSession({ factory,
        subject: `comment-hactor-${randomUUID()}`, handle: `ci${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const collectionId = 'comment-it-collection-hidden';
      await seedCollection(collectionId, owner.subjectId, 'public', 'comment-hidden');

      const anonymous = createProductCommunityClient({ origin });
      const client = createProductCommunityClient({ origin, sessionCookie: commenter.cookie,
        originHeader: config.productOrigin, csrfToken: commenter.csrfToken });
      const target = (await client.resolveTarget({ kind: 'collection', id: collectionId })).target;
      const root = await client.createComment(
        { target, body: 'Was public', replyToId: null }, randomUUID());
      const reply = await client.createComment(
        { target, body: 'Was public reply', replyToId: root.id }, randomUUID());

      // Flip the target to private: every operation shares the concealed 404,
      // including POST — a now-concealed target is 404 before any saved
      // receipt body could leak.
      await isolated.runtime.pool.query(
        `update collections set visibility='private' where id=$1`, [collectionId]);
      await assert.rejects(() => anonymous.listComments(
        { kind: 'collection', id: collectionId, generation: 'static-v1' }),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
      await assert.rejects(() => anonymous.getComment(root.id),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
      await assert.rejects(() => anonymous.getComment(reply.id),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
      await assert.rejects(() => anonymous.listReplies(root.id),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
      await assert.rejects(() => client.createComment(
        { target, body: 'On private', replyToId: null }, randomUUID()),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
      await assert.rejects(() => client.createComment(
        { target, body: 'Reply on private', replyToId: root.id }, randomUUID()),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));

      // The rows themselves persist untouched — concealment is projection-only.
      const rows = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text count from community_comments where target_id=$1`, [collectionId]);
      assert.equal(rows.rows[0]?.count, '2');
    } finally {
      await app.close();
    }
  }, 60_000);

  test('bookmark generation fencing: stale generation is 409 on write, 404 on read', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `comment-fowner-${randomUUID()}`, handle: `cf${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const commenter = await issueTestSession({ factory,
        subject: `comment-factor-${randomUUID()}`, handle: `cg${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const collectionId = 'comment-it-collection-fence';
      const nodeId = 'comment-it-bookmark-fence';
      const rootNodeId = await seedCollection(collectionId, owner.subjectId, 'public', 'comment-fence');
      await seedBookmark(nodeId, collectionId, rootNodeId);

      const anonymous = createProductCommunityClient({ origin });
      const client = createProductCommunityClient({ origin, sessionCookie: commenter.cookie,
        originHeader: config.productOrigin, csrfToken: commenter.csrfToken });

      const before = await client.resolveTarget(
        { kind: 'bookmark', id: nodeId, collectionId });
      assert.match(before.target.generation, /^bm-gen-/u);
      const root = await client.createComment(
        { target: before.target, body: 'Pinned generation', replyToId: null }, randomUUID());
      assert.equal(root.target.generation, before.target.generation);

      // Any real URL write advances the server-minted generation.
      await isolated.runtime.pool.query(
        `update nodes set url='https://example.com/changed' where id=$1`, [nodeId]);
      const after = await client.resolveTarget({ kind: 'bookmark', id: nodeId, collectionId });
      assert.notEqual(after.target.generation, before.target.generation);

      // A write carrying the superseded generation is a 409 revision_conflict —
      // the caller resolves again and confirms intent on the new content.
      await assert.rejects(() => client.createComment(
        { target: before.target, body: 'Stale write', replyToId: null }, randomUUID()),
        (error: unknown) => isProductClientError(error, 409, 'revision_conflict'));
      await assert.rejects(() => client.createComment(
        { target: before.target, body: 'Stale reply', replyToId: root.id }, randomUUID()),
        (error: unknown) => isProductClientError(error, 409, 'revision_conflict'));

      // Reads conceal instead of conflicting: the stale-generation page, the
      // pinned comment, and its thread all share the same 404.
      await assert.rejects(() => anonymous.listComments(
        { kind: 'bookmark', id: nodeId, collectionId,
          generation: before.target.generation }),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
      await assert.rejects(() => anonymous.getComment(root.id),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
      await assert.rejects(() => anonymous.listReplies(root.id),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));

      // The fresh generation serves an empty page (old rows stay concealed)
      // and accepts new writes under a new command id.
      const freshPage = await anonymous.listComments(
        { kind: 'bookmark', id: nodeId, collectionId, generation: after.target.generation });
      assert.deepEqual(freshPage.items, []);
      const fresh = await client.createComment(
        { target: after.target, body: 'New generation', replyToId: null }, randomUUID());
      assert.equal(fresh.target.generation, after.target.generation);
      const repopulated = await anonymous.listComments(
        { kind: 'bookmark', id: nodeId, collectionId, generation: after.target.generation });
      assert.deepEqual(repopulated.items.map((item) => item.id), [fresh.id]);
    } finally {
      await app.close();
    }
  }, 60_000);
});
