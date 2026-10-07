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
  collectionTarget,
  commentPath,
  createCommentManagementHttpFixture,
  curationBody,
  curationPath,
  postComment,
  rawGet,
  sendMutation,
  session,
  settingsBody,
  settingsPath,
  type CommentWire,
  type CurationWire,
  type SettingsWire,
} from './comment-management-http-helpers.js';

/**
 * CS-04 comment management authority over real HTTP: authorship and curator
 * capability gates, uniform concealment when the target turns private,
 * comment-area lock semantics with independent overlays, and the closed
 * mutation bodies + concealed-id contract shared by every endpoint.
 */
describeWithPostgres('community-social comment management authority', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_comment_mgmt_auth', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  const { testConfig, startApp, seedCollection, setCollectionVisibility } =
    createCommentManagementHttpFixture(() => isolated);

  /* ------------------------------------------------------------------ */
  /* Group 1: authorship / curator authority / concealed targets.        */
  /* ------------------------------------------------------------------ */

  test('non-authors and non-curators are rejected; a private target conceals every endpoint', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner-auth');
      const author = await session(factory, 'author-auth');
      const stranger = await session(factory, 'stranger-auth');
      const collectionId = `cm-auth-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await seedCollection(collectionId, owner.subjectId, 'public', `cm-auth-${randomUUID().slice(0, 8)}`);
      const target = collectionTarget(collectionId);

      const created = await postComment(origin, config.productOrigin, author, target, 'Mine alone');
      assert.equal(created.status, 201);
      const commentId = created.body!.id;
      const etag = (await rawGet<CommentWire>(origin, commentPath(commentId))).etag!;

      // Author-only operations: a non-author with the correct ETag is 403.
      const strangerPatch = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PATCH',
        path: commentPath(commentId), client: stranger,
        body: { body: 'Hostile edit' }, ifMatch: etag,
      });
      assert.equal(strangerPatch.status, 403);
      assert.equal(strangerPatch.body?.error?.code, 'insufficient_permission');
      const strangerDelete = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'DELETE',
        path: commentPath(commentId), client: stranger, ifMatch: etag,
      });
      assert.equal(strangerDelete.status, 403);
      assert.equal(strangerDelete.body?.error?.code, 'insufficient_permission');

      // Curator-only operations: an authenticated non-curator and an
      // anonymous viewer are both 403 on the curation/settings surfaces.
      const strangerCurate = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(commentId), client: stranger,
        body: curationBody(true, 'hostile hide'), ifMatch: '"any-strong-tag"',
      });
      assert.equal(strangerCurate.status, 403);
      assert.equal(strangerCurate.body?.error?.code, 'insufficient_permission');
      const strangerCurationRead = await rawGet(origin, curationPath(commentId), stranger.cookie);
      assert.equal(strangerCurationRead.status, 403);
      assert.equal(strangerCurationRead.body?.error?.code, 'insufficient_permission');
      const anonymousCurationRead = await rawGet(origin, curationPath(commentId));
      assert.equal(anonymousCurationRead.status, 403);
      assert.equal(anonymousCurationRead.body?.error?.code, 'insufficient_permission');
      const strangerSettingsPut = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: stranger,
        body: settingsBody(collectionId, true, 'hostile lock'), ifMatch: '"any-strong-tag"',
      });
      assert.equal(strangerSettingsPut.status, 403);
      assert.equal(strangerSettingsPut.body?.error?.code, 'insufficient_permission');
      const strangerSettingsRead = await rawGet(origin, settingsPath(collectionId), stranger.cookie);
      assert.equal(strangerSettingsRead.status, 403);
      assert.equal(strangerSettingsRead.body?.error?.code, 'insufficient_permission');
      const anonymousSettingsRead = await rawGet(origin, settingsPath(collectionId));
      assert.equal(anonymousSettingsRead.status, 403);
      assert.equal(anonymousSettingsRead.body?.error?.code, 'insufficient_permission');

      // The author is not a curator either.
      const authorCurate = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(commentId), client: author,
        body: curationBody(true, 'self hide'), ifMatch: '"any-strong-tag"',
      });
      assert.equal(authorCurate.status, 403);
      assert.equal(authorCurate.body?.error?.code, 'insufficient_permission');

      // Flipping the target private conceals the whole management surface:
      // all six endpoints collapse to the same resource_not_found.
      await setCollectionVisibility(collectionId, 'private');
      const concealedGet = await rawGet(origin, commentPath(commentId));
      assert.equal(concealedGet.status, 404);
      assert.equal(concealedGet.body?.error?.code, 'resource_not_found');
      const concealedPatch = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PATCH',
        path: commentPath(commentId), client: author,
        body: { body: 'too late' }, ifMatch: etag,
      });
      assert.equal(concealedPatch.status, 404);
      assert.equal(concealedPatch.body?.error?.code, 'resource_not_found');
      const concealedDelete = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'DELETE',
        path: commentPath(commentId), client: author, ifMatch: etag,
      });
      assert.equal(concealedDelete.status, 404);
      assert.equal(concealedDelete.body?.error?.code, 'resource_not_found');
      const concealedCurationGet = await rawGet(origin, curationPath(commentId), owner.cookie);
      assert.equal(concealedCurationGet.status, 404);
      assert.equal(concealedCurationGet.body?.error?.code, 'resource_not_found');
      const concealedCurationPut = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(commentId), client: owner,
        body: curationBody(true, 'too late'), ifMatch: '"any-strong-tag"',
      });
      assert.equal(concealedCurationPut.status, 404);
      assert.equal(concealedCurationPut.body?.error?.code, 'resource_not_found');
      const concealedSettingsGet = await rawGet(origin, settingsPath(collectionId), owner.cookie);
      assert.equal(concealedSettingsGet.status, 404);
      assert.equal(concealedSettingsGet.body?.error?.code, 'resource_not_found');
      const concealedSettingsPut = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: settingsBody(collectionId, false, 'too late'), ifMatch: '"any-strong-tag"',
      });
      assert.equal(concealedSettingsPut.status, 404);
      assert.equal(concealedSettingsPut.body?.error?.code, 'resource_not_found');
    } finally {
      await app.close();
    }
  }, 60_000);

  /* ------------------------------------------------------------------ */
  /* Group 2: comment-area lock semantics + independent overlays.        */
  /* ------------------------------------------------------------------ */

  test('a locked comment area rejects comment and reply creation until unlocked', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner-lock');
      const author = await session(factory, 'author-lock');
      const collectionId = `cm-lock-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await seedCollection(collectionId, owner.subjectId, 'public', `cm-lock-${randomUUID().slice(0, 8)}`);
      const target = collectionTarget(collectionId);

      const root = await postComment(origin, config.productOrigin, author, target, 'Pre-lock root');
      assert.equal(root.status, 201);
      const rootId = root.body!.id;

      const settingsGet = await rawGet<SettingsWire>(origin, settingsPath(collectionId), owner.cookie);
      assert.equal(settingsGet.status, 200);
      const locked = await sendMutation<SettingsWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: settingsBody(collectionId, true, 'freeze the area'), ifMatch: settingsGet.etag!,
      });
      assert.equal(locked.status, 200);
      assert.equal(locked.body!.locked, true);

      // Both root comments and replies reject while the area is locked.
      const lockedRoot = await postComment(origin, config.productOrigin, author, target, 'Locked out');
      assert.equal(lockedRoot.status, 403);
      assert.equal(lockedRoot.body?.error?.code, 'insufficient_permission');
      const lockedReply = await postComment(origin, config.productOrigin, author, target, 'Locked reply', rootId);
      assert.equal(lockedReply.status, 403);
      assert.equal(lockedReply.body?.error?.code, 'insufficient_permission');
      // Even the curator cannot post into a locked area.
      const lockedOwner = await postComment(origin, config.productOrigin, owner, target, 'Curator locked out');
      assert.equal(lockedOwner.status, 403);

      // Unlock restores the write path for everyone.
      const unlocked = await sendMutation<SettingsWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: settingsBody(collectionId, false, 'reopen the area'), ifMatch: locked.etag!,
      });
      assert.equal(unlocked.status, 200);
      assert.equal(unlocked.body!.locked, false);
      assert.equal(unlocked.body!.revision, '3');
      const after = await postComment(origin, config.productOrigin, author, target, 'Back in');
      assert.equal(after.status, 201);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('hide and lock are independent overlays — undoing one never clears the other', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner-over');
      const author = await session(factory, 'author-over');
      const collectionId = `cm-over-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await seedCollection(collectionId, owner.subjectId, 'public', `cm-over-${randomUUID().slice(0, 8)}`);
      const target = collectionTarget(collectionId);

      const created = await postComment(origin, config.productOrigin, author, target, 'Overlap target');
      assert.equal(created.status, 201);
      const commentId = created.body!.id;

      // Stack both restrictions: curation hide + area lock.
      const curation = await rawGet<CurationWire>(origin, curationPath(commentId), owner.cookie);
      assert.equal(curation.status, 200);
      const hidden = await sendMutation<CurationWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(commentId), client: owner,
        body: curationBody(true, 'hide while locked'), ifMatch: curation.etag!,
      });
      assert.equal(hidden.status, 200);
      let curationEtag = hidden.etag!;
      const settingsGet = await rawGet<SettingsWire>(origin, settingsPath(collectionId), owner.cookie);
      const locked = await sendMutation<SettingsWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: settingsBody(collectionId, true, 'lock while hidden'), ifMatch: settingsGet.etag!,
      });
      assert.equal(locked.status, 200);
      let settingsEtag = locked.etag!;

      // Undoing the hide leaves the lock intact: reads clear, writes still reject.
      const unhidden = await sendMutation<CurationWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(commentId), client: owner,
        body: curationBody(false, 'unhide only'), ifMatch: curationEtag,
      });
      assert.equal(unhidden.status, 200);
      assert.equal(unhidden.body!.hidden, false);
      assert.equal(unhidden.body!.reason, null);
      curationEtag = unhidden.etag!;
      const visible = await rawGet<CommentWire>(origin, commentPath(commentId));
      assert.equal(visible.status, 200);
      assert.equal(visible.body!.state, 'visible');
      assert.equal(visible.body!.body, 'Overlap target');
      const stillLocked = await postComment(origin, config.productOrigin, author, target, 'Still locked');
      assert.equal(stillLocked.status, 403);

      // Re-hide, then undo only the lock: the overlay survives the unlock.
      const rehidden = await sendMutation<CurationWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(commentId), client: owner,
        body: curationBody(true, 'hide again'), ifMatch: curationEtag,
      });
      assert.equal(rehidden.status, 200);
      curationEtag = rehidden.etag!;
      const unlocked = await sendMutation<SettingsWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: settingsBody(collectionId, false, 'unlock only'), ifMatch: settingsEtag,
      });
      assert.equal(unlocked.status, 200);
      settingsEtag = unlocked.etag!;
      const stillHidden = await rawGet<CommentWire>(origin, commentPath(commentId));
      assert.equal(stillHidden.status, 200);
      assert.equal(stillHidden.body!.state, 'hidden');
      assert.equal(stillHidden.body!.body, null);
      const postingBack = await postComment(origin, config.productOrigin, author, target, 'Posting back');
      assert.equal(postingBack.status, 201);

      // Final unhide restores the visible projection; the settings row is
      // untouched (still unlocked at its own revision).
      const restored = await sendMutation<CurationWire>({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(commentId), client: owner,
        body: curationBody(false, 'restore'), ifMatch: curationEtag,
      });
      assert.equal(restored.status, 200);
      const final = await rawGet<CommentWire>(origin, commentPath(commentId));
      assert.equal(final.status, 200);
      assert.equal(final.body!.state, 'visible');
      assert.equal(final.body!.body, 'Overlap target');
      const settingsNow = await rawGet<SettingsWire>(origin, settingsPath(collectionId), owner.cookie);
      assert.equal(settingsNow.status, 200);
      assert.equal(settingsNow.body!.locked, false);
      assert.equal(settingsNow.etag, settingsEtag);
    } finally {
      await app.close();
    }
  }, 60_000);

  /* ------------------------------------------------------------------ */
  /* Group 3: closed bodies; unknown comment ids conceal to 404.         */
  /* ------------------------------------------------------------------ */

  test('closed bodies reject unknown keys and missing comment ids are 404', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner-closed');
      const author = await session(factory, 'author-closed');
      const collectionId = `cm-closed-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await seedCollection(collectionId, owner.subjectId, 'public', `cm-closed-${randomUUID().slice(0, 8)}`);
      const target = collectionTarget(collectionId);

      const created = await postComment(origin, config.productOrigin, author, target, 'Closed bodies');
      assert.equal(created.status, 201);
      const commentId = created.body!.id;
      const commentEtag = (await rawGet<CommentWire>(origin, commentPath(commentId))).etag!;
      const curationEtag = (await rawGet<CurationWire>(origin, curationPath(commentId), owner.cookie)).etag!;
      const settingsEtag = (await rawGet<SettingsWire>(origin, settingsPath(collectionId), owner.cookie)).etag!;

      // Unknown keys reject on all three closed body contracts.
      const patchExtra = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PATCH',
        path: commentPath(commentId), client: author,
        body: { body: 'x', state: 'deleted' }, ifMatch: commentEtag,
      });
      assert.equal(patchExtra.status, 400);
      assert.equal(patchExtra.body?.error?.code, 'invalid_request');
      const curationExtra = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(commentId), client: owner,
        body: { hidden: true, reason: 'r', commentId }, ifMatch: curationEtag,
      });
      assert.equal(curationExtra.status, 400);
      assert.equal(curationExtra.body?.error?.code, 'invalid_request');
      const settingsExtra = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: { ...settingsBody(collectionId, true, 'r'), updatedBy: owner.accountId },
        ifMatch: settingsEtag,
      });
      assert.equal(settingsExtra.status, 400);
      assert.equal(settingsExtra.body?.error?.code, 'invalid_request');
      // Required keys missing is the same closed-object rejection.
      const curationMissingKey = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(commentId), client: owner,
        body: { hidden: true }, ifMatch: curationEtag,
      });
      assert.equal(curationMissingKey.status, 400);
      assert.equal(curationMissingKey.body?.error?.code, 'invalid_request');

      // A well-formed but nonexistent comment id conceals to 404 on every
      // comment-scoped endpoint.
      const missingId = `missing-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const missingGet = await rawGet(origin, commentPath(missingId));
      assert.equal(missingGet.status, 404);
      assert.equal(missingGet.body?.error?.code, 'resource_not_found');
      const missingPatch = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PATCH',
        path: commentPath(missingId), client: author,
        body: { body: 'x' }, ifMatch: '"any-strong-tag"',
      });
      assert.equal(missingPatch.status, 404);
      assert.equal(missingPatch.body?.error?.code, 'resource_not_found');
      const missingDelete = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'DELETE',
        path: commentPath(missingId), client: author, ifMatch: '"any-strong-tag"',
      });
      assert.equal(missingDelete.status, 404);
      assert.equal(missingDelete.body?.error?.code, 'resource_not_found');
      const missingCurationGet = await rawGet(origin, curationPath(missingId), owner.cookie);
      assert.equal(missingCurationGet.status, 404);
      assert.equal(missingCurationGet.body?.error?.code, 'resource_not_found');
      const missingCurationPut = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: curationPath(missingId), client: owner,
        body: curationBody(true, 'r'), ifMatch: '"any-strong-tag"',
      });
      assert.equal(missingCurationPut.status, 404);
      assert.equal(missingCurationPut.body?.error?.code, 'resource_not_found');
      // And a nonexistent settings target conceals on read and write alike.
      const ghostCollection = `ghost-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const ghostSettingsGet = await rawGet(origin, settingsPath(ghostCollection), owner.cookie);
      assert.equal(ghostSettingsGet.status, 404);
      assert.equal(ghostSettingsGet.body?.error?.code, 'resource_not_found');
      const ghostSettingsPut = await sendMutation({
        origin, productOrigin: config.productOrigin, method: 'PUT',
        path: '/api/v1/community/comment-settings', client: owner,
        body: settingsBody(ghostCollection, true, 'r'), ifMatch: '"any-strong-tag"',
      });
      assert.equal(ghostSettingsPut.status, 404);
      assert.equal(ghostSettingsPut.body?.error?.code, 'resource_not_found');
    } finally {
      await app.close();
    }
  }, 60_000);
});
