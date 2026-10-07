import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  COMMENT_ETAG,
  CURATION_ETAG,
  SETTINGS_ETAG,
  collectionTarget,
  commentPath,
  createCommentManagementHttpFixture,
  curationBody,
  curationPath,
  postComment,
  rawGet,
  repliesPath,
  sendMutation,
  session,
  settingsBody,
  settingsPath,
  type CommentWire,
  type CurationWire,
  type SettingsWire,
} from './comment-management-http-helpers.js';

/**
 * CS-04 comment management over real HTTP: author PATCH/DELETE with the
 * comment ETag, curator GET/PUT curation with the curation ETag, and curator
 * GET/PUT comment-area settings with the settings ETag. The three ETag
 * authorities are independent and never interchangeable; every mutation
 * requires session + Origin + CSRF + Known-Command-Id + a strong If-Match.
 */
describeWithPostgres('community-social comment management http', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_comment_mgmt_http', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  const { testConfig, startApp, seedCollection } =
    createCommentManagementHttpFixture(() => isolated);

  /* ------------------------------------------------------------------ */
  /* Group 1: author edit + author delete happy paths.                   */
  /* ------------------------------------------------------------------ */

  test('author PATCH edit rotates the comment ETag and advances the revision', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner-edit');
      const author = await session(factory, 'author-edit');
      const collectionId = `cm-edit-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await seedCollection(collectionId, owner.subjectId, 'public', `cm-edit-${randomUUID().slice(0, 8)}`);

      const created = await postComment(origin, config.productOrigin, author,
        collectionTarget(collectionId), 'Original body');
      assert.equal(created.status, 201);
      assert.match(created.etag ?? '', COMMENT_ETAG);
      const commentId = created.body!.id;
      assert.equal(created.body!.revision, '1');

      const before = await rawGet<CommentWire>(origin, commentPath(commentId));
      assert.equal(before.status, 200);
      assert.equal(before.etag, created.etag);

      const edited = await sendMutation<CommentWire>({
        origin, productOrigin: config.productOrigin, method: 'PATCH',
        path: commentPath(commentId), client: author,
        body: { body: 'Edited body' }, ifMatch: before.etag!,
      });
      assert.equal(edited.status, 200);
      assert.equal(edited.body!.body, 'Edited body');
      assert.equal(edited.body!.state, 'visible');
      assert.equal(edited.body!.revision, '2');
      assert.match(edited.etag ?? '', COMMENT_ETAG);
      assert.notEqual(edited.etag, before.etag);

      const after = await rawGet<CommentWire>(origin, commentPath(commentId));
      assert.equal(after.status, 200);
      assert.equal(after.body!.body, 'Edited body');
      assert.equal(after.body!.revision, '2');
      assert.equal(after.etag, edited.etag);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('author DELETE tombstones the comment while replies stay readable', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner-del');
      const author = await session(factory, 'author-del');
      const collectionId = `cm-del-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await seedCollection(collectionId, owner.subjectId, 'public', `cm-del-${randomUUID().slice(0, 8)}`);

      const root = await postComment(origin, config.productOrigin, author,
        collectionTarget(collectionId), 'Root to delete');
      assert.equal(root.status, 201);
      const rootId = root.body!.id;
      const reply = await postComment(origin, config.productOrigin, author,
        collectionTarget(collectionId), 'Surviving reply', rootId);
      assert.equal(reply.status, 201);
      const replyId = reply.body!.id;

      const before = await rawGet<CommentWire>(origin, commentPath(rootId));
      assert.equal(before.status, 200);
      assert.match(before.etag ?? '', COMMENT_ETAG);

      const deleted = await sendMutation<CommentWire>({
        origin, productOrigin: config.productOrigin, method: 'DELETE',
        path: commentPath(rootId), client: author, ifMatch: before.etag!,
      });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body!.state, 'deleted');
      assert.equal(deleted.body!.body, null);
      assert.equal(deleted.body!.revision, '2');
      assert.match(deleted.etag ?? '', COMMENT_ETAG);
      assert.notEqual(deleted.etag, before.etag);

      // Tombstone: the single read still serves the row with body=null and
      // the reply tree stays readable underneath it.
      const tombstone = await rawGet<CommentWire>(origin, commentPath(rootId));
      assert.equal(tombstone.status, 200);
      assert.equal(tombstone.body!.state, 'deleted');
      assert.equal(tombstone.body!.body, null);
      assert.equal(tombstone.body!.id, rootId);

      const replies = await rawGet<CommentWire & { items?: CommentWire[] }>(
        origin, repliesPath(rootId));
      assert.equal(replies.status, 200);
      assert.deepEqual(
        (replies.body as { items: CommentWire[] } | null)?.items.map((item) => item.id),
        [replyId]);

      // A second delete is not a tombstone rewrite — the row is not deletable.
      const again = await sendMutation<CommentWire>({
        origin, productOrigin: config.productOrigin, method: 'DELETE',
        path: commentPath(rootId), client: author, ifMatch: deleted.etag!,
      });
      assert.equal(again.status, 400);
      assert.equal(again.body?.error?.code, 'invalid_request');
    } finally {
      await app.close();
    }
  }, 60_000);

  test('a curator-hidden comment rejects new replies exactly like a deleted one', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner-hidereply');
      const author = await session(factory, 'author-hidereply');
      const collectionId = `cm-hiderp-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await seedCollection(collectionId, owner.subjectId, 'public', `cm-hiderp-${randomUUID().slice(0, 8)}`);

      const root = await postComment(origin, config.productOrigin, author,
        collectionTarget(collectionId), 'Root to hide');
      assert.equal(root.status, 201);
      const rootId = root.body!.id;

      const virtualCuration = await rawGet<CurationWire>(origin, curationPath(rootId), owner.cookie);
      assert.equal(virtualCuration.status, 200);
      const hidden = await sendMutation<CurationWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(rootId), client: owner,
        body: curationBody(true, 'moderate'), ifMatch: virtualCuration.etag!,
      });
      assert.equal(hidden.status, 200);
      assert.equal(hidden.body!.hidden, true);

      // The row still serves as a tombstone — hidden, not deleted.
      const tombstone = await rawGet<CommentWire>(origin, commentPath(rootId));
      assert.equal(tombstone.status, 200);
      assert.equal(tombstone.body!.state, 'hidden');
      assert.equal(tombstone.body!.body, null);

      // But it is not a reply target: the concealed parent is 404, the same
      // refusal a deleted comment gives.
      const rejected = await postComment(origin, config.productOrigin, author,
        collectionTarget(collectionId), 'reply under hidden', rootId);
      assert.equal(rejected.status, 404);
      assert.equal(rejected.body?.error?.code, 'resource_not_found');

      const unhidden = await sendMutation<CurationWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(rootId), client: owner,
        body: curationBody(false, 'restore'), ifMatch: hidden.etag!,
      });
      assert.equal(unhidden.status, 200);
      const restored = await postComment(origin, config.productOrigin, author,
        collectionTarget(collectionId), 'reply after unhide', rootId);
      assert.equal(restored.status, 201);
    } finally {
      await app.close();
    }
  }, 60_000);

  /* ------------------------------------------------------------------ */
  /* Group 2: If-Match admission matrix — 428 / 400 / 412.               */
  /* ------------------------------------------------------------------ */

  test('If-Match admission rejects missing, malformed, and stale entity tags', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner-im');
      const author = await session(factory, 'author-im');
      const collectionId = `cm-im-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await seedCollection(collectionId, owner.subjectId, 'public', `cm-im-${randomUUID().slice(0, 8)}`);
      const target = collectionTarget(collectionId);
      const malformed = ['not-a-tag', 'W/"abc"', '"a", "b"', '*'] as const;

      // PATCH /comments/{id}: the full matrix on the author endpoint.
      const editSeed = await postComment(origin, config.productOrigin, author, target, 'Edit me');
      assert.equal(editSeed.status, 201);
      const editId = editSeed.body!.id;
      const patchMissing = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PATCH',
        path: commentPath(editId), client: author, body: { body: 'x' },
      });
      assert.equal(patchMissing.status, 428);
      assert.equal(patchMissing.body?.error?.code, 'precondition_required');
      for (const tag of malformed) {
        const rejected = await sendMutation({
          origin, productOrigin: config.productOrigin, method: 'PATCH',
          path: commentPath(editId), client: author, body: { body: 'x' }, ifMatch: tag,
        });
        assert.equal(rejected.status, 400, `malformed If-Match ${tag}`);
        assert.equal(rejected.body?.error?.code, 'invalid_request');
      }
      const editEtag = (await rawGet<CommentWire>(origin, commentPath(editId))).etag!;
      const edited = await sendMutation<CommentWire>({
        origin, productOrigin: config.productOrigin, method: 'PATCH',
        path: commentPath(editId), client: author,
        body: { body: 'Revision two' }, ifMatch: editEtag,
      });
      assert.equal(edited.status, 200);
      const patchStale = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PATCH',
        path: commentPath(editId), client: author,
        body: { body: 'Revision three' }, ifMatch: editEtag,
      });
      assert.equal(patchStale.status, 412);
      assert.equal(patchStale.body?.error?.code, 'precondition_failed');
      assert.equal(patchStale.body?.error?.currentEtag, edited.etag);

      // DELETE /comments/{id}: missing + stale (malformed shares the same
      // transport reader — covered exhaustively on PATCH and PUT curation).
      const deleteSeed = await postComment(origin, config.productOrigin, author, target, 'Delete me');
      assert.equal(deleteSeed.status, 201);
      const deleteId = deleteSeed.body!.id;
      const deleteMissing = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'DELETE',
        path: commentPath(deleteId), client: author,
      });
      assert.equal(deleteMissing.status, 428);
      assert.equal(deleteMissing.body?.error?.code, 'precondition_required');
      const deleteEtag = (await rawGet<CommentWire>(origin, commentPath(deleteId))).etag!;
      const bumped = await sendMutation<CommentWire>({
        origin, productOrigin: config.productOrigin, method: 'PATCH',
        path: commentPath(deleteId), client: author,
        body: { body: 'Bump revision' }, ifMatch: deleteEtag,
      });
      assert.equal(bumped.status, 200);
      const deleteStale = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'DELETE',
        path: commentPath(deleteId), client: author, ifMatch: deleteEtag,
      });
      assert.equal(deleteStale.status, 412);
      assert.equal(deleteStale.body?.error?.code, 'precondition_failed');
      assert.equal(deleteStale.body?.error?.currentEtag, bumped.etag);

      // PUT /comments/{id}/curation: the full matrix on the curator endpoint.
      const curateSeed = await postComment(origin, config.productOrigin, author, target, 'Curate me');
      assert.equal(curateSeed.status, 201);
      const curateId = curateSeed.body!.id;
      const curationMissing = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(curateId), client: owner, body: curationBody(true, 'reason'),
      });
      assert.equal(curationMissing.status, 428);
      assert.equal(curationMissing.body?.error?.code, 'precondition_required');
      for (const tag of malformed) {
        const rejected = await sendMutation({
          origin, productOrigin: config.productOrigin, method: 'PUT',
          path: curationPath(curateId), client: owner,
          body: curationBody(true, 'reason'), ifMatch: tag,
        });
        assert.equal(rejected.status, 400, `malformed If-Match ${tag}`);
        assert.equal(rejected.body?.error?.code, 'invalid_request');
      }
      const virtualCuration = await rawGet<CurationWire>(origin, curationPath(curateId), owner.cookie);
      assert.equal(virtualCuration.status, 200);
      assert.match(virtualCuration.etag ?? '', CURATION_ETAG);
      assert.equal(virtualCuration.body!.revision, '1');
      assert.equal(virtualCuration.body!.hidden, false);
      const hidden = await sendMutation<CurationWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(curateId), client: owner,
        body: curationBody(true, 'hide it'), ifMatch: virtualCuration.etag!,
      });
      assert.equal(hidden.status, 200);
      assert.equal(hidden.body!.hidden, true);
      assert.equal(hidden.body!.reason, 'hide it');
      assert.equal(hidden.body!.revision, '2');
      assert.match(hidden.etag ?? '', CURATION_ETAG);
      assert.notEqual(hidden.etag, virtualCuration.etag);
      const curationStale = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(curateId), client: owner,
        body: curationBody(false, 'unhide'), ifMatch: virtualCuration.etag!,
      });
      assert.equal(curationStale.status, 412);
      assert.equal(curationStale.body?.error?.code, 'precondition_failed');
      assert.equal(curationStale.body?.error?.currentEtag, hidden.etag);

      // PUT /comment-settings: missing + malformed + stale.
      const settingsMissing = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: settingsBody(collectionId, false, 'reason'),
      });
      assert.equal(settingsMissing.status, 428);
      assert.equal(settingsMissing.body?.error?.code, 'precondition_required');
      for (const tag of malformed) {
        const rejected = await sendMutation({
          origin, productOrigin: config.productOrigin, method: 'PUT',
          path: '/api/v1/community/comment-settings', client: owner,
          body: settingsBody(collectionId, false, 'reason'), ifMatch: tag,
        });
        assert.equal(rejected.status, 400, `malformed If-Match ${tag}`);
        assert.equal(rejected.body?.error?.code, 'invalid_request');
      }
      const virtualSettings = await rawGet<SettingsWire>(origin, settingsPath(collectionId), owner.cookie);
      assert.equal(virtualSettings.status, 200);
      assert.match(virtualSettings.etag ?? '', SETTINGS_ETAG);
      assert.equal(virtualSettings.body!.revision, '1');
      assert.equal(virtualSettings.body!.locked, false);
      const locked = await sendMutation<SettingsWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: settingsBody(collectionId, true, 'freeze'), ifMatch: virtualSettings.etag!,
      });
      assert.equal(locked.status, 200);
      assert.equal(locked.body!.locked, true);
      assert.equal(locked.body!.reason, 'freeze');
      assert.equal(locked.body!.revision, '2');
      assert.match(locked.etag ?? '', SETTINGS_ETAG);
      assert.notEqual(locked.etag, virtualSettings.etag);
      const settingsStale = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: settingsBody(collectionId, false, 'reopen'), ifMatch: virtualSettings.etag!,
      });
      assert.equal(settingsStale.status, 412);
      assert.equal(settingsStale.body?.error?.code, 'precondition_failed');
      assert.equal(settingsStale.body?.error?.currentEtag, locked.etag);
    } finally {
      await app.close();
    }
  }, 60_000);

  /* ------------------------------------------------------------------ */
  /* Group 3: the three ETag authorities stay distinct.                  */
  /* ------------------------------------------------------------------ */

  test('comment, curation, and settings ETags are never interchangeable', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner-xetag');
      const author = await session(factory, 'author-xetag');
      const collectionId = `cm-xetag-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await seedCollection(collectionId, owner.subjectId, 'public', `cm-xetag-${randomUUID().slice(0, 8)}`);
      const target = collectionTarget(collectionId);

      const created = await postComment(origin, config.productOrigin, author, target, 'Cross-tag me');
      assert.equal(created.status, 201);
      const commentId = created.body!.id;
      const commentEtag = (await rawGet<CommentWire>(origin, commentPath(commentId))).etag!;
      const curationEtag = (await rawGet<CurationWire>(origin, curationPath(commentId), owner.cookie)).etag!;
      const settingsEtag = (await rawGet<SettingsWire>(origin, settingsPath(collectionId), owner.cookie)).etag!;
      // Three independent authorities mint three unrelated tags.
      assert.notEqual(commentEtag, curationEtag);
      assert.notEqual(commentEtag, settingsEtag);
      assert.notEqual(curationEtag, settingsEtag);

      // Every tag is a strong entity-tag, so each foreign swap reaches the
      // command and fails its own CAS compare as 412 — never an accidental hit.
      const patchWithCuration = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PATCH',
        path: commentPath(commentId), client: author,
        body: { body: 'foreign tag' }, ifMatch: curationEtag,
      });
      assert.equal(patchWithCuration.status, 412);
      assert.equal(patchWithCuration.body?.error?.code, 'precondition_failed');
      const deleteWithSettings = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'DELETE',
        path: commentPath(commentId), client: author, ifMatch: settingsEtag,
      });
      assert.equal(deleteWithSettings.status, 412);
      assert.equal(deleteWithSettings.body?.error?.code, 'precondition_failed');
      const curateWithComment = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(commentId), client: owner,
        body: curationBody(true, 'foreign tag'), ifMatch: commentEtag,
      });
      assert.equal(curateWithComment.status, 412);
      assert.equal(curateWithComment.body?.error?.code, 'precondition_failed');
      const settingsWithComment = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: settingsBody(collectionId, true, 'foreign tag'), ifMatch: commentEtag,
      });
      assert.equal(settingsWithComment.status, 412);
      assert.equal(settingsWithComment.body?.error?.code, 'precondition_failed');
      const settingsWithCuration = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: settingsBody(collectionId, true, 'foreign tag'), ifMatch: curationEtag,
      });
      assert.equal(settingsWithCuration.status, 412);
      assert.equal(settingsWithCuration.body?.error?.code, 'precondition_failed');
    } finally {
      await app.close();
    }
  }, 60_000);
});
