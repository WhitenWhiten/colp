import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, test } from 'vitest';
import { createProductCommunityClient } from '../../../generated/openapi/product-v1.client.js';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresCollaborationUnitOfWork } from '../../../src/infrastructure/collaboration/index.js';
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
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createMemoryCollaborationInviteRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { createPostgresReportUnitOfWork } from '../../../src/infrastructure/reports/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import { createTestCollaborationListCursors } from '../../support/collaboration-list-cursors.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { isProductClientError } from './comment-http-helpers.js';

/*
 * CS-04 curator-authority revocation through the REAL public lifecycle
 * routes — no fixture bypass for the grant/revoke writes under test:
 *
 * - digest_series: owner grants an editor through
 *   PUT /api/v1/reports/:reportId/members/:subjectId (upsertDigestMember on
 *   the Postgres reports UoW), the editor curates a comment, then
 *   DELETE …/members/:subjectId (revokeDigestMember) sets
 *   digest_members.revoked_at and the same curation route answers 403.
 * - collection: owner grants an editor through the invite → accept loop
 *   (POST …/members/invites, POST /api/v1/me/collaboration-invites/:id/accept)
 *   then removes them through DELETE /api/v1/collections/:id/members/:subjectId
 *   (removeMember on the Postgres collaboration UoW) and curation 403s.
 *
 * The curator predicate is the production SQL
 * (communityTargetCurator → seriesCurator/collectionCurator): owner OR
 * active owner/editor member of the governing resource.
 */

const ORIGIN = 'http://127.0.0.1:3000';

describeWithPostgres('CS-04 curator permission revocation', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_curator_revoke', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  function testConfig() {
    return loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', LOG_LEVEL: 'silent', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: ORIGIN, ALLOWED_ORIGINS: ORIGIN,
      KNOWN_FEATURE_COMMUNITY: 'true', KNOWN_FEATURE_REPORTS: 'true',
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
      reportsUnitOfWork: createPostgresReportUnitOfWork(isolated.runtime.db),
      reportsRateLimiter: createFixedWindowRateLimiter({
        maxRequests: 10_000, windowMs: 60_000 }),
      productCollaboration: {
        identityUnitOfWork: identity,
        allowedOrigins: [ORIGIN],
        unitOfWork: createPostgresCollaborationUnitOfWork(isolated.runtime.db),
        rateLimiter: createMemoryCollaborationInviteRateLimiter({
          keySecret: Buffer.alloc(32, 26), environment: 'test' }),
        cursors: createTestCollaborationListCursors(),
      },
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, origin, factory };
  }

  function mutationHeaders(client: { cookie: string; csrfToken: string },
    commandId: string, extra: Record<string, string> = {}): Record<string, string> {
    return { cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrfToken,
      'known-command-id': commandId, 'content-type': 'application/json', ...extra };
  }

  /** Command headers for body-less mutations (a bare JSON content-type on an
   *  empty body is rejected as invalid_json at the transport boundary). */
  function emptyBodyHeaders(client: { cookie: string; csrfToken: string },
    commandId: string, extra: Record<string, string> = {}): Record<string, string> {
    const { 'content-type': _drop, ...rest } = mutationHeaders(client, commandId, extra);
    return rest;
  }

  async function seedPublicCollection(collectionId: string, ownerSubjectId: string): Promise<void> {
    const rootId = `root-${collectionId}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
        [collectionId, rootId]);
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
        commit_ordinal,created_at,updated_at)
        values($1,$2,$3,'bookmarks','public',$4,current_timestamp,$5,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, ownerSubjectId, 'Curated collection', `cur-${collectionId}`, rootId]);
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
  }

  test('digest editor loses curation rights when the owner revokes membership', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const owner = await issueTestSession({ factory, subject: `cr-own-${suffix}`,
        handle: `crdo${suffix}`, email: `cr-owner-${suffix}@example.test` });
      const curator = await issueTestSession({ factory, subject: `cr-cur-${suffix}`,
        handle: `crdc${suffix}`, email: `cr-curator-${suffix}@example.test` });
      const commenter = await issueTestSession({ factory, subject: `cr-com-${suffix}`,
        handle: `crdm${suffix}` });

      // Real series-create route: POST /api/v1/reports (public so the
      // community target resolves for non-members).
      const created = await app.inject({ method: 'POST', url: '/api/v1/reports',
        headers: mutationHeaders(owner, randomUUID()),
        payload: { title: 'Curated digest', summary: null, slug: `curated-${suffix}`,
          visibility: 'public', allowSearchIndexing: false } });
      assert.equal(created.statusCode, 201, created.payload);
      const series = created.json() as { id: string; policyRevision: string };

      // Grant: real report member PUT → digest_members gains an editor row.
      const granted = await app.inject({ method: 'PUT',
        url: `/api/v1/reports/${series.id}/members/${curator.subjectId}`,
        headers: mutationHeaders(owner, randomUUID(), { 'if-match': `"${series.policyRevision}"` }),
        payload: { role: 'editor' } });
      assert.equal(granted.statusCode, 200, granted.payload);
      const memberRows = async () => (await isolated.runtime.pool.query<{
        role: string; revoked_at: Date | null }>(
        `select role, revoked_at from digest_members where series_id=$1 and subject_id=$2`,
        [series.id, curator.subjectId])).rows;
      assert.equal((await memberRows())[0]?.role, 'editor');
      assert.equal((await memberRows())[0]?.revoked_at, null);

      const commenterClient = createProductCommunityClient({ origin,
        sessionCookie: commenter.cookie, originHeader: ORIGIN,
        csrfToken: commenter.csrfToken });
      const curatorClient = createProductCommunityClient({ origin,
        sessionCookie: curator.cookie, originHeader: ORIGIN,
        csrfToken: curator.csrfToken });
      const target = (await commenterClient.resolveTarget(
        { kind: 'digest_series', id: series.id })).target;
      const comment = await commenterClient.createComment(
        { target, body: 'a comment on the digest series', replyToId: null }, randomUUID());

      // The editor is a live curator: GET + PUT curation both succeed.
      const before = await curatorClient.getCuration(comment.id);
      const curated = await curatorClient.setCuration(comment.id,
        { hidden: true, reason: 'curator review' }, before.etag!, randomUUID());
      assert.equal(curated.data.hidden, true);

      // The same editor holds the comment-settings write for the series
      // area while the grant stands.
      const settingsBefore = await curatorClient.getCommentSettings(
        { kind: 'digest_series', id: series.id, generation: target.generation });
      const locked = await curatorClient.setCommentSettings(
        { target, locked: true, reason: 'moderation freeze' },
        settingsBefore.etag!, randomUUID());
      assert.equal(locked.data.locked, true);

      // Revoke: real report member DELETE → revoked_at is stamped.
      const currentPolicy = await isolated.runtime.pool.query<{ policy_revision: string }>(
        `select policy_revision from digest_series where id=$1`, [series.id]);
      const revoked = await app.inject({ method: 'DELETE',
        url: `/api/v1/reports/${series.id}/members/${curator.subjectId}`,
        headers: emptyBodyHeaders(owner, randomUUID(),
          { 'if-match': `"${currentPolicy.rows[0]!.policy_revision}"` }) });
      assert.equal(revoked.statusCode, 204, revoked.payload);
      assert.ok((await memberRows())[0]?.revoked_at !== null,
        'revoked_at must be stamped on the membership row');

      // The revoked editor is no longer a curator: read and write both 403.
      // canCurate is checked before the If-Match CAS, so the stale tag is
      // fine — the denial is the permission gate, not a precondition miss.
      await assert.rejects(curatorClient.getCuration(comment.id), (error) =>
        isProductClientError(error, 403, 'insufficient_permission'));
      await assert.rejects(curatorClient.setCuration(comment.id,
        { hidden: false, reason: 'unhide' }, curated.etag!, randomUUID()), (error) =>
        isProductClientError(error, 403, 'insufficient_permission'));

      // The revoked_at row also closes the comment-settings surface: both
      // the curator-gated read and the write reject with 403.
      await assert.rejects(curatorClient.getCommentSettings(
        { kind: 'digest_series', id: series.id, generation: target.generation }),
        (error) => isProductClientError(error, 403, 'insufficient_permission'));
      await assert.rejects(curatorClient.setCommentSettings(
        { target, locked: false, reason: 'reopen' }, locked.etag!, randomUUID()),
        (error) => isProductClientError(error, 403, 'insufficient_permission'));

      // Revocation never rewrites history: the earlier curation stands.
      const overlay = await isolated.runtime.pool.query<{ hidden: boolean }>(
        `select hidden from community_comment_curations where comment_id=$1`, [comment.id]);
      assert.equal(overlay.rows[0]?.hidden, true);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('collection editor loses curation rights when the owner removes membership', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const owner = await issueTestSession({ factory, subject: `cc-own-${suffix}`,
        handle: `ccdo${suffix}`, email: `cc-owner-${suffix}@example.test` });
      const editor = await issueTestSession({ factory, subject: `cc-ed-${suffix}`,
        handle: `ccde${suffix}`, email: `cc-editor-${suffix}@example.test` });
      const commenter = await issueTestSession({ factory, subject: `cc-com-${suffix}`,
        handle: `ccdm${suffix}` });
      const collectionId = `crcol-${suffix}`;
      await seedPublicCollection(collectionId, owner.subjectId);

      // Grant: real invite → accept loop binds collection_members.editor.
      let members = await app.inject({ method: 'GET',
        url: `/api/v1/collections/${collectionId}/members`,
        headers: { cookie: owner.cookie } });
      assert.equal(members.statusCode, 200, members.payload);
      const invited = await app.inject({ method: 'POST',
        url: `/api/v1/collections/${collectionId}/members/invites`,
        headers: mutationHeaders(owner, randomUUID(),
          { 'if-match': members.json().policyEtag as string }),
        payload: { email: `cc-editor-${suffix}@example.test`, role: 'editor' } });
      assert.equal(invited.statusCode, 201, invited.payload);
      const inviteId = invited.json().inviteId as string;
      const accepted = await app.inject({ method: 'POST',
        url: `/api/v1/me/collaboration-invites/${inviteId}/accept`,
        headers: emptyBodyHeaders(editor, randomUUID()) });
      assert.equal(accepted.statusCode, 200, accepted.payload);
      assert.equal(accepted.json().role, 'editor');

      const commenterClient = createProductCommunityClient({ origin,
        sessionCookie: commenter.cookie, originHeader: ORIGIN,
        csrfToken: commenter.csrfToken });
      const editorClient = createProductCommunityClient({ origin,
        sessionCookie: editor.cookie, originHeader: ORIGIN,
        csrfToken: editor.csrfToken });
      const target = (await commenterClient.resolveTarget(
        { kind: 'collection', id: collectionId })).target;
      const comment = await commenterClient.createComment(
        { target, body: 'a comment on the shared collection', replyToId: null }, randomUUID());

      const before = await editorClient.getCuration(comment.id);
      const curated = await editorClient.setCuration(comment.id,
        { hidden: true, reason: 'editor review' }, before.etag!, randomUUID());
      assert.equal(curated.data.hidden, true);

      // The editor also holds the comment-settings write for the
      // collection area while the grant stands.
      const settingsBefore = await editorClient.getCommentSettings(
        { kind: 'collection', id: collectionId, generation: target.generation });
      const locked = await editorClient.setCommentSettings(
        { target, locked: true, reason: 'moderation freeze' },
        settingsBefore.etag!, randomUUID());
      assert.equal(locked.data.locked, true);

      // Remove: real member DELETE deletes the collection_members row.
      members = await app.inject({ method: 'GET',
        url: `/api/v1/collections/${collectionId}/members`,
        headers: { cookie: owner.cookie } });
      const removed = await app.inject({ method: 'DELETE',
        url: `/api/v1/collections/${collectionId}/members/${editor.subjectId}`,
        headers: emptyBodyHeaders(owner, randomUUID(),
          { 'if-match': members.json().policyEtag as string }) });
      assert.equal(removed.statusCode, 204, removed.payload);
      const remaining = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text count from collection_members
         where collection_id=$1 and subject_id=$2`, [collectionId, editor.subjectId]);
      assert.equal(remaining.rows[0]?.count, '0', 'membership row is gone after removal');

      await assert.rejects(editorClient.getCuration(comment.id), (error) =>
        isProductClientError(error, 403, 'insufficient_permission'));
      await assert.rejects(editorClient.setCuration(comment.id,
        { hidden: false, reason: 'unhide' }, curated.etag!, randomUUID()), (error) =>
        isProductClientError(error, 403, 'insufficient_permission'));

      // Row deletion also closes the comment-settings surface.
      await assert.rejects(editorClient.getCommentSettings(
        { kind: 'collection', id: collectionId, generation: target.generation }),
        (error) => isProductClientError(error, 403, 'insufficient_permission'));
      await assert.rejects(editorClient.setCommentSettings(
        { target, locked: false, reason: 'reopen' }, locked.etag!, randomUUID()),
        (error) => isProductClientError(error, 403, 'insufficient_permission'));
    } finally {
      await app.close();
    }
  }, 60_000);
});
