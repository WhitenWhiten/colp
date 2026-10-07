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
  createPostgresCommunityRankingRefreshUnitOfWork,
  createPostgresCommunityTargetQueryUnitOfWork,
  createPostgresCommunityVoteCommandUnitOfWork,
} from '../../../src/infrastructure/community/index.js';
import { refreshCommunityRanking } from '../../../src/modules/community/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { RESOURCE_PAYLOAD_SCHEMA_VERSION } from '../../../src/modules/collections/index.js';

describeWithPostgres('community official governance eligibility', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_governance_elig', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function seedCollection(collectionId: string, ownerSubjectId: string, slug: string): Promise<void> {
    const rootId = `root-${collectionId}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
        [collectionId, rootId],
      );
      // `collections_payload_authority_consistency` only accepts `payload_json`
      // together with a non-null schema version and the matching authority
      // status, so a fixture that wants a canonical payload has to set all three.
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
        commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values($1,$2,'Governance target','bookmarks','public',$4,current_timestamp,$3,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp,
          '{"extensions":{"tags":["ML","LLM"],"language":"zh"}}'::jsonb,$5,'backfilled')`,
      [collectionId, ownerSubjectId, rootId, slug, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
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

  async function insertAction(input: {
    readonly actorAccountId: string;
    readonly ownerAccountId: string;
    readonly targetKind: 'collection' | 'account';
    readonly targetId: string;
    readonly action: 'hide_public' | 'restrict_interaction' | 'delist';
  }): Promise<void> {
    const caseId = `case_${randomUUID()}`;
    const actionId = `act_${randomUUID()}`;
    const fingerprint = `${input.targetKind}:${input.targetId}:${actionId}`;
    const targetJson = JSON.stringify({ kind: input.targetKind, id: input.targetId });
    await isolated.runtime.pool.query(
      `insert into moderation_cases (
         id, reporter_account_id, target_kind, target_id, target_json, target_fingerprint,
         category, description, status, revision, created_at, updated_at)
       values ($1,$2,$3,$4,$5::jsonb,$6,'spam','fixture','in_review','1',current_timestamp,current_timestamp)`,
      [caseId, input.actorAccountId, input.targetKind, input.targetId, targetJson, fingerprint],
    );
    await isolated.runtime.pool.query(
      `insert into moderation_actions (
         id, case_id, target_kind, target_id, target_json, target_fingerprint, action, reason,
         actor_account_id, state, revision, created_at, owner_account_id)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,'official fixture',$8,'active','1',current_timestamp,$9)`,
      [
        actionId, caseId, input.targetKind, input.targetId, targetJson, fingerprint,
        input.action, input.actorAccountId, input.ownerAccountId,
      ],
    );
  }

  function communityApp() {
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000',
      KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 19).toString('base64'),
    });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const app = buildApiApp({
      config,
      identityUnitOfWork: identity,
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
      }),
    });
    return { config, factory, app };
  }

  test('hide_public conceals resolve and drops the collection from ranking', async () => {
    const { factory, app } = communityApp();
    const owner = await issueTestSession({
      factory,
      subject: `gov-owner-${randomUUID()}`,
      handle: `g${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const voter = await issueTestSession({
      factory,
      subject: `gov-voter-${randomUUID()}`,
      handle: `h${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const collectionId = `gov-hide-${randomUUID().slice(0, 8)}`;
    await seedCollection(collectionId, owner.subjectId, `gov-hide-${collectionId.slice(-6)}`);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductCommunityClient({
        origin, sessionCookie: voter.cookie, originHeader: 'http://127.0.0.1:3000', csrfToken: voter.csrfToken,
      });
      const before = await client.resolveTarget({ kind: 'collection', id: collectionId });
      assert.equal(before.target.id, collectionId);
      await insertAction({
        actorAccountId: owner.accountId,
        ownerAccountId: owner.accountId,
        targetKind: 'collection',
        targetId: collectionId,
        action: 'hide_public',
      });
      await assert.rejects(
        () => client.resolveTarget({ kind: 'collection', id: collectionId }),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'),
      );
      await createPostgresCommunityRankingRefreshUnitOfWork(isolated.runtime.db)
        .execute((ports) => refreshCommunityRanking(ports));
      const page = await client.listRanking({});
      assert.equal(page.items.some((item) => item.target.id === collectionId), false);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('delist drops a collection from the current ranking page without a rebuild', async () => {
    const { factory, app } = communityApp();
    const owner = await issueTestSession({
      factory,
      subject: `gov-delist-owner-${randomUUID()}`,
      handle: `d${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const voter = await issueTestSession({
      factory,
      subject: `gov-delist-voter-${randomUUID()}`,
      handle: `e${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const collectionId = `gov-delist-${randomUUID().slice(0, 8)}`;
    await seedCollection(collectionId, owner.subjectId, `gov-delist-${collectionId.slice(-6)}`);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductCommunityClient({
        origin, sessionCookie: voter.cookie, originHeader: 'http://127.0.0.1:3000', csrfToken: voter.csrfToken,
      });
      const view = await client.resolveTarget({ kind: 'collection', id: collectionId });
      await client.setVote({ target: view.target, value: 1 }, randomUUID());
      await createPostgresCommunityRankingRefreshUnitOfWork(isolated.runtime.db)
        .execute((ports) => refreshCommunityRanking(ports));
      const before = await client.listRanking({});
      assert.equal(before.items.some((item) => item.target.id === collectionId), true);
      await insertAction({
        actorAccountId: owner.accountId,
        ownerAccountId: owner.accountId,
        targetKind: 'collection',
        targetId: collectionId,
        action: 'delist',
      });
      const page = await client.listRanking({});
      assert.equal(page.items.some((item) => item.target.id === collectionId), false);
      const stillDirect = await client.resolveTarget({ kind: 'collection', id: collectionId });
      assert.equal(stillDirect.target.id, collectionId);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('restrict_interaction conceals a new vote the same way as an inactive account', async () => {
    const { factory, app } = communityApp();
    const owner = await issueTestSession({
      factory,
      subject: `gov-rint-owner-${randomUUID()}`,
      handle: `i${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const voter = await issueTestSession({
      factory,
      subject: `gov-rint-voter-${randomUUID()}`,
      handle: `j${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const collectionId = `gov-rint-${randomUUID().slice(0, 8)}`;
    await seedCollection(collectionId, owner.subjectId, `gov-rint-${collectionId.slice(-6)}`);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductCommunityClient({
        origin, sessionCookie: voter.cookie, originHeader: 'http://127.0.0.1:3000', csrfToken: voter.csrfToken,
      });
      const view = await client.resolveTarget({ kind: 'collection', id: collectionId });
      await insertAction({
        actorAccountId: owner.accountId,
        ownerAccountId: voter.accountId,
        targetKind: 'account',
        targetId: voter.accountId,
        action: 'restrict_interaction',
      });
      await assert.rejects(
        () => client.setVote({ target: view.target, value: 1 }, randomUUID()),
        (error: unknown) => isProductClientError(error, 404, 'resource_not_found'),
      );
    } finally {
      await app.close();
    }
  }, 60_000);
});

function isProductClientError(error: unknown, status: number, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { status?: unknown; problem?: { error?: { code?: unknown } } };
  return value.status === status && value.problem?.error?.code === code;
}
