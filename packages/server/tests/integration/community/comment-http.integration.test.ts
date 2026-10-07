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

describeWithPostgres('community-social comment http', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_comment_http', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  const { testConfig, startApp, seedCollection, seedBookmark, rawGet } =
    createCommentHttpFixture(() => isolated);

  test('all four comment operations succeed with the closed Comment schema', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const authorHandle = `ca${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const author = await issueTestSession({ factory,
        subject: `comment-author-${randomUUID()}`, handle: authorHandle });
      const owner = await issueTestSession({ factory,
        subject: `comment-owner-${randomUUID()}`, handle: `co${randomUUID().replaceAll('-', '').slice(0, 12)}` });

      const collectionId = 'comment-it-collection-ops';
      await seedCollection(collectionId, owner.subjectId, 'public', 'comment-ops');

      const anonymous = createProductCommunityClient({ origin });
      const client = createProductCommunityClient({ origin, sessionCookie: author.cookie,
        originHeader: config.productOrigin, csrfToken: author.csrfToken });
      const ownerClient = createProductCommunityClient({ origin, sessionCookie: owner.cookie,
        originHeader: config.productOrigin, csrfToken: owner.csrfToken });

      const view = await anonymous.resolveTarget({ kind: 'collection', id: collectionId });
      assert.equal(view.canComment, false);
      const target = { ...view.target };

      // POST creates a root comment (201 + closed Comment projection).
      const root = await client.createComment(
        { target, body: 'First comment', replyToId: null }, randomUUID());
      assert.deepEqual(Object.keys(root).sort(), [
        'author', 'body', 'canCurate', 'canDelete', 'canEdit', 'createdAt', 'depth',
        'id', 'replyCount', 'replyToId', 'revision', 'rootId', 'state', 'target', 'updatedAt',
      ]);
      assert.equal(root.rootId, root.id);
      assert.equal(root.replyToId, null);
      assert.equal(root.depth, 0);
      assert.equal(root.body, 'First comment');
      assert.equal(root.state, 'visible');
      assert.equal(root.revision, '1');
      assert.equal(root.replyCount, 0);
      assert.deepEqual(root.target, target);
      assert.equal(root.author.id, author.accountId);
      assert.equal(root.author.handle, authorHandle);
      assert.equal(typeof root.author.displayName, 'string');
      assert.match(root.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.equal(root.canEdit, true);
      assert.equal(root.canDelete, true);
      assert.equal(root.canCurate, false);

      // Exact command-id replay returns the same outcome; a changed payload
      // under the same id is a 409 command_id_reused.
      const commandId = randomUUID();
      const posted = await client.createComment(
        { target, body: 'Replay me', replyToId: null }, commandId);
      const replay = await client.createComment(
        { target, body: 'Replay me', replyToId: null }, commandId);
      assert.deepEqual(replay, posted);
      await assert.rejects(() => client.createComment(
        { target, body: 'Changed', replyToId: null }, commandId),
        (error: unknown) => isProductClientError(error, 409, 'command_id_reused'));

      // GET one comment: anonymous-safe, capability hints all false; the
      // target owner gets only the curation hint.
      const fetched = await anonymous.getComment(root.id);
      assert.equal(fetched.id, root.id);
      assert.equal(fetched.body, 'First comment');
      assert.equal(fetched.canEdit, false);
      assert.equal(fetched.canDelete, false);
      assert.equal(fetched.canCurate, false);
      const ownerView = await ownerClient.getComment(root.id);
      assert.equal(ownerView.canCurate, true);
      assert.equal(ownerView.canEdit, false);
      // Single-read carries the strong opaque comment ETag.
      const rawComment = await rawGet(origin, `/api/v1/community/comments/${root.id}`);
      assert.equal(rawComment.status, 200);
      assert.match(rawComment.etag ?? '', /^"community-comment:[A-Za-z0-9_-]{32}"$/u);

      // Replies attach to the root thread at depth 1.
      const reply = await client.createComment(
        { target, body: 'Threaded reply', replyToId: root.id }, randomUUID());
      assert.equal(reply.rootId, root.id);
      assert.equal(reply.replyToId, root.id);
      assert.equal(reply.depth, 1);

      // The root list pages only roots with their thread reply counts.
      const page = await anonymous.listComments(
        { kind: 'collection', id: collectionId, generation: 'static-v1' });
      assert.deepEqual(page.items.map((item) => item.id).sort(), [posted.id, root.id].sort());
      assert.ok(page.items.every((item) => item.depth === 0 && item.replyToId === null));
      assert.equal(page.items.find((item) => item.id === root.id)?.replyCount, 1);
      assert.equal(page.nextCursor, null);

      // Replies list the flattened descendants oldest-first.
      const replies = await anonymous.listReplies(root.id);
      assert.deepEqual(replies.items.map((item) => item.id), [reply.id]);
      assert.equal(replies.items[0]?.depth, 1);
      assert.equal(replies.nextCursor, null);

      // The create persisted one durable row + receipt + audit event.
      const rows = await isolated.runtime.pool.query<{ comments: string; audits: string }>(`
        select
          (select count(*)::text from community_comments where author_account_id=$1) comments,
          (select count(*)::text from audit_events
             where principal_id=$1 and event_type='community.comment_created') audits`,
        [author.accountId]);
      assert.equal(rows.rows[0]?.comments, '3');
      assert.equal(rows.rows[0]?.audits, '3');
    } finally {
      await app.close();
    }
  }, 60_000);

  test('closed create body and list query reject missing, unknown and out-of-range input', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `comment-vowner-${randomUUID()}`, handle: `cv${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const commenter = await issueTestSession({ factory,
        subject: `comment-vactor-${randomUUID()}`, handle: `cw${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const collectionId = 'comment-it-collection-validation';
      const rootId = await seedCollection(collectionId, owner.subjectId, 'public', 'comment-validation');
      await seedBookmark('comment-it-bookmark-validation', collectionId, rootId);

      const client = createProductCommunityClient({ origin, sessionCookie: commenter.cookie,
        originHeader: config.productOrigin, csrfToken: commenter.csrfToken });
      const target = (await client.resolveTarget({ kind: 'collection', id: collectionId })).target;
      const bookmarkTarget = (await client.resolveTarget(
        { kind: 'bookmark', id: 'comment-it-bookmark-validation', collectionId })).target;

      // Closed {target, body, replyToId}: missing keys and unknown keys are 400.
      for (const body of [
        { target, body: 'No replyToId' },
        { target, replyToId: null },
        { body: 'No target', replyToId: null },
        { target, body: 'Extra key', replyToId: null, extra: 'nope' },
        { target, body: 'Two extras', replyToId: null, a: 1, b: 2 },
        { target, body: 42, replyToId: null },
        { target, body: 'Bad replyToId', replyToId: 7 },
        'not an object',
        null,
      ]) {
        await assert.rejects(() => client.createComment(body as never, randomUUID()),
          (error: unknown) => isProductClientError(error, 400, 'invalid_request'));
      }

      // A malformed closed target inside the body is also invalid_request.
      await assert.rejects(() => client.createComment(
        { target: { kind: 'collection', id: collectionId, collectionId: null, seriesId: null },
          body: 'Missing generation', replyToId: null } as never, randomUUID()),
        (error: unknown) => isProductClientError(error, 400, 'invalid_request'));

      // Required query keys + closed key set + parent-id rules are invalid_query.
      const listBase = `/api/v1/community/comments?kind=collection&id=${collectionId}`;
      for (const path of [
        `/api/v1/community/comments?id=${collectionId}&generation=static-v1`,
        `/api/v1/community/comments?kind=collection&generation=static-v1`,
        listBase,
        `${listBase}&generation=static-v1&bogus=1`,
        `${listBase}&generation=static-v1&collectionId=${collectionId}`,
        `/api/v1/community/comments?kind=bookmark&id=comment-it-bookmark-validation&generation=${bookmarkTarget.generation}`,
        `/api/v1/community/comments?kind=bookmark&id=comment-it-bookmark-validation`
          + `&collectionId=${collectionId}&seriesId=x&generation=${bookmarkTarget.generation}`,
        `${listBase}&generation=bm-gen-notstatic`,
      ]) {
        const result = await rawGet(origin, path);
        assert.equal(result.status, 400, path);
        assert.equal(result.body.error?.code, 'invalid_query', path);
      }

      // Limit bounds are 1..100 on both paged endpoints.
      const root = await client.createComment(
        { target, body: 'Thread root', replyToId: null }, randomUUID());
      for (const limit of ['0', '101', '-1', 'abc', '1.5']) {
        const result = await rawGet(origin, `${listBase}&generation=static-v1&limit=${limit}`);
        assert.equal(result.status, 400, `limit=${limit}`);
        assert.equal(result.body.error?.code, 'invalid_query', `limit=${limit}`);
        await assert.rejects(() => client.listReplies(root.id, { limit: Number(limit) || 101 }),
          (error: unknown) => isProductClientError(error, 400, 'invalid_query'));
      }
      // A replies query key outside {limit, cursor} is rejected.
      const badReplies = await rawGet(origin,
        `/api/v1/community/comments/${root.id}/replies?kind=collection`);
      assert.equal(badReplies.status, 400);
      assert.equal(badReplies.body.error?.code, 'invalid_query');
    } finally {
      await app.close();
    }
  }, 60_000);

  test('create requires a session; missing and malformed comment ids conceal uniformly', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `comment-sowner-${randomUUID()}`, handle: `cs${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const commenter = await issueTestSession({ factory,
        subject: `comment-sactor-${randomUUID()}`, handle: `ct${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const collectionId = 'comment-it-collection-session';
      await seedCollection(collectionId, owner.subjectId, 'public', 'comment-session');

      const anonymous = createProductCommunityClient({ origin });
      const client = createProductCommunityClient({ origin, sessionCookie: commenter.cookie,
        originHeader: config.productOrigin, csrfToken: commenter.csrfToken });
      const target = (await client.resolveTarget({ kind: 'collection', id: collectionId })).target;

      // POST without a session is 401 before Origin/CSRF is even checked.
      await assert.rejects(() => anonymous.createComment(
        { target, body: 'Anonymous write', replyToId: null }, randomUUID()),
        (error: unknown) => isProductClientError(error, 401, 'authentication_required'));

      // Anonymous reads still work on live targets.
      const root = await client.createComment(
        { target, body: 'Readable root', replyToId: null }, randomUUID());
      const fetched = await anonymous.getComment(root.id);
      assert.equal(fetched.id, root.id);

      // A well-formed but unknown comment id is the concealed 404 on both
      // single-read and replies; a malformed path id is a plain 400.
      for (const missing of ['comment-does-not-exist', `comment-${randomUUID()}`]) {
        await assert.rejects(() => anonymous.getComment(missing),
          (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
        await assert.rejects(() => anonymous.listReplies(missing),
          (error: unknown) => isProductClientError(error, 404, 'resource_not_found'));
      }
      const malformed = await rawGet(origin, '/api/v1/community/comments/bad%20id');
      assert.equal(malformed.status, 400);
      assert.equal(malformed.body.error?.code, 'invalid_request');
      const malformedReplies = await rawGet(origin, '/api/v1/community/comments/bad%20id/replies');
      assert.equal(malformedReplies.status, 400);
      assert.equal(malformedReplies.body.error?.code, 'invalid_request');
    } finally {
      await app.close();
    }
  }, 60_000);

  test('body is trimmed, NFC-normalized and bounded at 1..4000 code points', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `comment-bowner-${randomUUID()}`, handle: `cb${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const commenter = await issueTestSession({ factory,
        subject: `comment-bactor-${randomUUID()}`, handle: `cn${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const collectionId = 'comment-it-collection-body';
      await seedCollection(collectionId, owner.subjectId, 'public', 'comment-body');

      const client = createProductCommunityClient({ origin, sessionCookie: commenter.cookie,
        originHeader: config.productOrigin, csrfToken: commenter.csrfToken });
      const target = (await client.resolveTarget({ kind: 'collection', id: collectionId })).target;

      // 0 code points after trim: empty and whitespace-only reject.
      for (const body of ['', '   ', '\n\t ', '  ']) {
        await assert.rejects(() => client.createComment(
          { target, body, replyToId: null }, randomUUID()),
          (error: unknown) => isProductClientError(error, 400, 'invalid_request'));
      }

      // 4001 code points reject; exactly 4000 is stored verbatim.
      await assert.rejects(() => client.createComment(
        { target, body: 'x'.repeat(4001), replyToId: null }, randomUUID()),
        (error: unknown) => isProductClientError(error, 400, 'invalid_request'));
      const maxed = await client.createComment(
        { target, body: 'y'.repeat(4000), replyToId: null }, randomUUID());
      assert.equal(maxed.body?.length, 4000);

      // 1 code point succeeds; surrounding whitespace is trimmed and the
      // stored body is NFC ('Café' normalizes to 'Café').
      const one = await client.createComment(
        { target, body: ' x ', replyToId: null }, randomUUID());
      assert.equal(one.body, 'x');
      const accented = await client.createComment(
        { target, body: '  Café lunch — ok  ', replyToId: null }, randomUUID());
      assert.equal(accented.body, 'Café lunch — ok');
      const fetched = await client.getComment(accented.id);
      assert.equal(fetched.body, 'Café lunch — ok');

      // A decomposed sequence longer than 4000 UTF-16 units but <= 4000 code
      // points still fits: normalization happens before the bound is measured.
      const decomposed = 'é'.repeat(2000); // 2000 code points, 4000 UTF-16 units
      const stored = await client.createComment(
        { target, body: decomposed, replyToId: null }, randomUUID());
      assert.equal(stored.body, 'é'.repeat(2000));
    } finally {
      await app.close();
    }
  }, 60_000);
});
