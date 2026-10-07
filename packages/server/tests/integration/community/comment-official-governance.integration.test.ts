import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createProductCommunityClient,
  createProductGovernanceClient,
} from '../../../generated/openapi/product-v1.client.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresModerationRoleUnitOfWork } from '../../../src/infrastructure/governance/postgres-moderation-roles.js';
import { grantModerationRole } from '../../../src/modules/governance/application/moderation-roles.js';
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

const GOVERNANCE_HMAC = Buffer.alloc(32, 21).toString('base64url');

describeWithPostgres('community official comment hide and lock', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_comment_official', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  const { testConfig, startApp, seedCollection } = createCommentHttpFixture(() => isolated);

  test('official hide_comment snapshots the parent owner and lock_comments rejects new writes', async () => {
    const config = testConfig({
      KNOWN_FEATURE_CONTENT_GOVERNANCE: 'true',
      GOVERNANCE_CURSOR_HMAC_KEY: GOVERNANCE_HMAC,
    });
    const { app, origin, factory } = await startApp(config, { governance: true });
    try {
      const author = await issueTestSession({
        factory,
        subject: `cmt-off-author-${randomUUID()}`,
        handle: `oa${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      });
      const owner = await issueTestSession({
        factory,
        subject: `cmt-off-owner-${randomUUID()}`,
        handle: `oo${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      });
      const reporter = await issueTestSession({
        factory,
        subject: `cmt-off-reporter-${randomUUID()}`,
        handle: `or${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      });
      const moderator = await issueTestSession({
        factory,
        subject: `cmt-off-mod-${randomUUID()}`,
        handle: `om${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      });
      const collectionId = `cmt-off-${randomUUID().slice(0, 8)}`;
      await seedCollection(collectionId, owner.subjectId, 'public', `cmt-off-${collectionId.slice(-6)}`);
      const client = createProductCommunityClient({
        origin, sessionCookie: author.cookie, originHeader: config.productOrigin, csrfToken: author.csrfToken,
      });
      const ownerClient = createProductCommunityClient({
        origin, sessionCookie: owner.cookie, originHeader: config.productOrigin, csrfToken: owner.csrfToken,
      });
      const view = await client.resolveTarget({ kind: 'collection', id: collectionId });
      const created = await client.createComment(
        { target: view.target, body: 'Please hide me', replyToId: null }, randomUUID());
      assert.equal(created.state, 'visible');

      const granted = await createPostgresModerationRoleUnitOfWork(isolated.runtime.db).execute((ports) =>
        grantModerationRole(ports, {
          accountId: moderator.accountId,
          role: 'moderator',
          reason: 'official comment fixture',
        }));
      assert.equal(granted.changed, true);

      const reporterGov = createProductGovernanceClient({
        origin, sessionCookie: reporter.cookie, originHeader: config.productOrigin, csrfToken: reporter.csrfToken,
      });
      const ownerGov = createProductGovernanceClient({
        origin, sessionCookie: owner.cookie, originHeader: config.productOrigin, csrfToken: owner.csrfToken,
      });
      const authorGov = createProductGovernanceClient({
        origin, sessionCookie: author.cookie, originHeader: config.productOrigin, csrfToken: author.csrfToken,
      });
      const moderatorGov = createProductGovernanceClient({
        origin, sessionCookie: moderator.cookie, originHeader: config.productOrigin, csrfToken: moderator.csrfToken,
      });

      const reported = await reporterGov.submitModerationReport({
        target: { kind: 'comment', id: created.id },
        category: 'spam',
        description: 'unsolicited comment advertising',
      }, randomUUID());
      const hide = await moderatorGov.createModerationAction({
        caseId: reported.id,
        target: { kind: 'comment', id: created.id },
        action: 'hide_comment',
        reason: 'official hide',
      }, randomUUID());
      const stored = await isolated.runtime.pool.query<{ owner_account_id: string | null }>(
        `select owner_account_id from moderation_actions where id=$1`, [hide.id]);
      assert.equal(stored.rows[0]?.owner_account_id, owner.accountId);

      const hidden = await client.getComment(created.id);
      assert.equal(hidden.state, 'hidden');
      assert.equal(hidden.body, null);

      const ownerActions = await ownerGov.listActionsAffectingMe({});
      assert.equal(ownerActions.items.some((item) => item.id === hide.id), true);
      const authorActions = await authorGov.listActionsAffectingMe({});
      assert.equal(authorActions.items.some((item) => item.id === hide.id), false);

      const appeal = await ownerGov.createModerationAppeal({
        actionId: hide.id,
        description: 'please restore this comment',
      }, randomUUID());
      assert.equal(typeof appeal.id, 'string');
      await assert.rejects(
        () => authorGov.createModerationAppeal({
          actionId: hide.id,
          description: 'the comment author is not the parent owner',
        }, randomUUID()),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'),
      );

      const collectionCase = await reporterGov.submitModerationReport({
        target: { kind: 'collection', id: collectionId },
        category: 'spam',
        description: 'lock the comment area',
      }, randomUUID());
      await moderatorGov.createModerationAction({
        caseId: collectionCase.id,
        target: { kind: 'collection', id: collectionId },
        action: 'lock_comments',
        reason: 'official lock',
      }, randomUUID());
      const createdAt = await isolated.runtime.pool.query<{ created_at: Date }>(
        `select created_at from collections where id=$1`, [collectionId]);
      const settings = await ownerClient.getCommentSettings({
        kind: 'collection', id: collectionId, generation: view.target.generation,
      });
      assert.equal(settings.data.locked, true);
      assert.equal(settings.data.reason, null);
      assert.equal(settings.data.revision, '1');
      assert.notEqual(settings.data.updatedAt, '1970-01-01T00:00:00.000Z');
      assert.equal(Date.parse(settings.data.updatedAt), createdAt.rows[0]!.created_at.getTime());
      await assert.rejects(
        () => client.createComment(
          { target: view.target, body: 'Should not post', replyToId: null }, randomUUID()),
        (error: unknown) => isProductClientError(error, 403, 'insufficient_permission'),
      );
    } finally {
      await app.close();
    }
  }, 60_000);

  test('official lock_comments stays effective across a curator unlock write (CS-C02)', async () => {
    const config = testConfig({
      KNOWN_FEATURE_CONTENT_GOVERNANCE: 'true',
      GOVERNANCE_CURSOR_HMAC_KEY: GOVERNANCE_HMAC,
    });
    const { app, origin, factory } = await startApp(config, { governance: true });
    try {
      const author = await issueTestSession({
        factory,
        subject: `cmt-off2-author-${randomUUID()}`,
        handle: `oa2${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      });
      const owner = await issueTestSession({
        factory,
        subject: `cmt-off2-owner-${randomUUID()}`,
        handle: `oo2${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      });
      const reporter = await issueTestSession({
        factory,
        subject: `cmt-off2-reporter-${randomUUID()}`,
        handle: `or2${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      });
      const moderator = await issueTestSession({
        factory,
        subject: `cmt-off2-mod-${randomUUID()}`,
        handle: `om2${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      });
      const collectionId = `cmt-off2-${randomUUID().slice(0, 8)}`;
      await seedCollection(collectionId, owner.subjectId, 'public', `cmt-off2-${collectionId.slice(-6)}`);
      const client = createProductCommunityClient({
        origin, sessionCookie: author.cookie, originHeader: config.productOrigin, csrfToken: author.csrfToken,
      });
      const ownerClient = createProductCommunityClient({
        origin, sessionCookie: owner.cookie, originHeader: config.productOrigin, csrfToken: owner.csrfToken,
      });
      const moderatorGov = createProductGovernanceClient({
        origin, sessionCookie: moderator.cookie, originHeader: config.productOrigin, csrfToken: moderator.csrfToken,
      });
      const reporterGov = createProductGovernanceClient({
        origin, sessionCookie: reporter.cookie, originHeader: config.productOrigin, csrfToken: reporter.csrfToken,
      });
      const view = await client.resolveTarget({ kind: 'collection', id: collectionId });

      const granted = await createPostgresModerationRoleUnitOfWork(isolated.runtime.db).execute((ports) =>
        grantModerationRole(ports, {
          accountId: moderator.accountId,
          role: 'moderator',
          reason: 'official comment fixture two',
        }));
      assert.equal(granted.changed, true);

      const collectionCase = await reporterGov.submitModerationReport({
        target: { kind: 'collection', id: collectionId },
        category: 'spam',
        description: 'lock the comment area twice',
      }, randomUUID());
      const lock = await moderatorGov.createModerationAction({
        caseId: collectionCase.id,
        target: { kind: 'collection', id: collectionId },
        action: 'lock_comments',
        reason: 'official lock two',
      }, randomUUID());

      // The virtual settings read reports the official lock.
      const before = await ownerClient.getCommentSettings({
        kind: 'collection', id: collectionId, generation: view.target.generation,
      });
      assert.equal(before.data.locked, true);

      // The curator writes unlock against the virtual ETag. The durable
      // row stores the unlock intent, but the response must reflect the
      // authoritative effective state — the official lock is still active.
      const unlocked = await ownerClient.setCommentSettings(
        { target: view.target, locked: false, reason: 'curator unlock while official lock active' },
        before.etag!, randomUUID());
      assert.equal(unlocked.data.locked, true,
        'unlock PUT must not report unlocked while the official lock is active');
      const stored = await isolated.runtime.pool.query<{ locked: boolean; revision: string }>(
        `select locked, revision::text as revision from community_comment_settings
         where target_kind='collection' and target_id=$1`, [collectionId]);
      assert.equal(stored.rows[0]?.locked, false);
      assert.equal(stored.rows[0]?.revision, '2');

      // The read side stays authoritative: still locked, still rejecting
      // new writes. When the official action ends the durable unlock shows.
      const after = await ownerClient.getCommentSettings({
        kind: 'collection', id: collectionId, generation: view.target.generation,
      });
      assert.equal(after.data.locked, true);
      assert.equal(after.data.revision, '2');
      await assert.rejects(
        () => client.createComment(
          { target: view.target, body: 'Still locked', replyToId: null }, randomUUID()),
        (error: unknown) => isProductClientError(error, 403, 'insufficient_permission'),
      );
      // When the official action ends the durable unlock surfaces.
      await moderatorGov.revokeModerationAction(
        lock.id, { reason: 'official lock lifted' }, randomUUID(), `"${lock.revision}"`);
      const lifted = await ownerClient.getCommentSettings({
        kind: 'collection', id: collectionId, generation: view.target.generation,
      });
      assert.equal(lifted.data.locked, false,
        'the durable curator unlock surfaces once the official action ends');
    } finally {
      await app.close();
    }
  }, 60_000);
});
