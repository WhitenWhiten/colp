import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresReadingProgressReadUnitOfWork,
  createPostgresReadingProgressUnitOfWork,
  createPostgresSavedResourceReadUnitOfWork,
  createPostgresSavedResourceUnitOfWork,
} from '../../../src/infrastructure/reading-progress/index.js';
import {
  createReadingProgressCursorSigner,
  createSavedResourceCursorSigner,
} from '../../../src/modules/reading-progress/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';

const ORIGIN = 'https://app.example.test';

describeWithPostgres('hide_public access for saved resources and reading progress', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('reading_hide_public_access');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
    config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
  }, 120_000);

  afterAll(async () => isolated?.close());

  function app() {
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    return buildApiApp({
      config,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      savedResourceUnitOfWork: createPostgresSavedResourceUnitOfWork(runtime.db),
      savedResourceReadUnitOfWork: createPostgresSavedResourceReadUnitOfWork(runtime.db, {
        cursorSigner: createSavedResourceCursorSigner({
          current: { id: 'hide-saved-v1', key: 'hide-saved-postgres-secret' },
        }),
      }),
      readingProgressUnitOfWork: createPostgresReadingProgressUnitOfWork(runtime.db),
      readingProgressReadUnitOfWork: createPostgresReadingProgressReadUnitOfWork(runtime.db, {
        cursorSigner: createReadingProgressCursorSigner({
          current: { id: 'hide-progress-v1', key: 'hide-progress-postgres-secret' },
        }),
      }),
    });
  }

  async function login(label: string) {
    const client = await issueTestSession({
      factory,
      subject: `${label}-${randomUUID()}`,
      displayName: label,
      handle: `hide_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    });
    return { cookie: client.cookie, csrf: client.csrfToken, accountId: client.accountId, subjectId: client.subjectId };
  }

  async function insertPublicTarget(ownerSubjectId: string) {
    const prefix = `hide-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const collectionId = `${prefix}-collection`;
    const rootId = `${prefix}-root`;
    const nodeId = `${prefix}-bookmark`;
    const connection = await runtime.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`
        insert into resource_id_ledger(resource_id, resource_type)
        values ($1,'collection'),($2,'node'),($3,'node')`, [collectionId, rootId, nodeId]);
      await connection.query(`
        insert into collections(id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
          root_node_id, resource_revision, content_revision, policy_revision, commit_ordinal)
        values ($1,$2,'Visible collection','bookmarks','public',$4,current_timestamp,$3,'r1','c1','p1',1)`,
      [collectionId, ownerSubjectId, rootId, `${prefix}-public`]);
      await connection.query(`
        insert into nodes(id, collection_id, parent_id, kind, is_root, title, url, tags,
          visibility, position_token, resource_revision, children_revision)
        values ($1,$2,null,'folder',true,'Root',null,'[]','inherit',null,'r-root','c-root'),
               ($3,$2,$1,'bookmark',false,'Hidden bookmark','https://example.test/hidden','[]',
                'inherit','A','r-bookmark','c-bookmark')`, [rootId, collectionId, nodeId]);
      await connection.query('commit');
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }
    return { collectionId, nodeId };
  }

  async function addMember(collectionId: string, subjectId: string) {
    await runtime.pool.query(`
      insert into collection_members(collection_id, subject_id, role)
      values ($1,$2,'viewer')`, [collectionId, subjectId]);
  }

  async function addHideAction(input: {
    readonly targetKind: 'collection' | 'bookmark';
    readonly targetId: string;
    readonly parentId?: string;
    readonly actorAccountId: string;
  }) {
    const suffix = randomUUID().replaceAll('-', '');
    const caseId = `hide-case-${suffix}`;
    const actionId = `hide-action-${suffix}`;
    const targetJson = input.targetKind === 'collection'
      ? { kind: 'collection', id: input.targetId }
      : { kind: 'bookmark', id: input.targetId, collectionId: input.parentId };
    await runtime.pool.query(`
      insert into moderation_cases(
        id, reporter_account_id, target_kind, target_id, parent_id, target_json,
        target_fingerprint, category, description, status, revision, created_at, updated_at)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7,'spam','hide-public fixture','submitted','1',now(),now())`, [
      caseId,
      input.actorAccountId,
      input.targetKind,
      input.targetId,
      input.parentId ?? null,
      JSON.stringify(targetJson),
      `hide-fingerprint-${suffix}`,
    ]);
    await runtime.pool.query(`
      insert into moderation_actions(
        id, case_id, target_kind, target_id, parent_id, target_json, target_fingerprint,
        action, reason, actor_account_id, state, revision, created_at)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7,'hide_public','hide-public fixture',$8,'active','1',now())`, [
      actionId,
      caseId,
      input.targetKind,
      input.targetId,
      input.parentId ?? null,
      JSON.stringify(targetJson),
      `hide-action-fingerprint-${suffix}`,
      input.actorAccountId,
    ]);
    return actionId;
  }

  async function revokeHideAction(actionId: string) {
    await runtime.pool.query(`
      update moderation_actions
         set state='revoked', revoked_at=now(), revoke_reason='fixture revoke', revision='2'
       where id=$1`, [actionId]);
  }

  function readHeaders(client: Awaited<ReturnType<typeof login>>) {
    return { cookie: client.cookie };
  }

  function writeHeaders(client: Awaited<ReturnType<typeof login>>, commandId = randomUUID()) {
    return {
      cookie: client.cookie,
      origin: ORIGIN,
      'x-csrf-token': client.csrf,
      'known-command-id': commandId,
      'content-type': 'application/json',
    };
  }

  function savedWriteHeaders(client: Awaited<ReturnType<typeof login>>, commandId = randomUUID()) {
    return {
      cookie: client.cookie,
      origin: ORIGIN,
      'x-csrf-token': client.csrf,
      'known-command-id': commandId,
    };
  }

  test('collection and bookmark hide_public conceal public access while preserving owner/member access', async () => {
    const api = app();
    try {
      const owner = await login('hide-owner');
      const member = await login('hide-member');
      const outsider = await login('hide-outsider');
      const target = await insertPublicTarget(owner.subjectId);
      await addMember(target.collectionId, member.subjectId);

      const outsiderSavedCollection = await api.inject({
        method: 'PUT',
        url: `/api/v1/saved-resources/collection/${target.collectionId}`,
        headers: savedWriteHeaders(outsider),
      });
      const outsiderSavedBookmark = await api.inject({
        method: 'PUT',
        url: `/api/v1/saved-resources/node/${target.nodeId}`,
        headers: savedWriteHeaders(outsider),
      });
      assert.equal(outsiderSavedCollection.statusCode, 201, outsiderSavedCollection.body);
      assert.equal(outsiderSavedBookmark.statusCode, 201, outsiderSavedBookmark.body);

      const outsiderProgressCollection = await api.inject({
        method: 'PUT',
        url: `/api/v1/reading-progress/collection/${target.collectionId}`,
        headers: writeHeaders(outsider),
        payload: { status: 'in_progress', progress: 0.25 },
      });
      const outsiderProgressBookmark = await api.inject({
        method: 'PUT',
        url: `/api/v1/reading-progress/node/${target.nodeId}`,
        headers: writeHeaders(outsider),
        payload: { status: 'in_progress', progress: 0.5 },
      });
      assert.equal(outsiderProgressCollection.statusCode, 201, outsiderProgressCollection.body);
      assert.equal(outsiderProgressBookmark.statusCode, 201, outsiderProgressBookmark.body);

      const collectionHide = await addHideAction({
        targetKind: 'collection', targetId: target.collectionId, actorAccountId: owner.accountId,
      });

      const hiddenSaved = await api.inject({
        method: 'GET', url: '/api/v1/saved-resources?limit=10', headers: readHeaders(outsider),
      });
      assert.equal(hiddenSaved.statusCode, 200, hiddenSaved.body);
      assert.equal(hiddenSaved.json().items.length, 2);
      assert.deepEqual(hiddenSaved.json().items.map((item: { target: unknown }) => item.target), [
        { availability: 'unavailable', collectionId: null, title: null, url: null },
        { availability: 'unavailable', collectionId: null, title: null, url: null },
      ]);
      const hiddenProgress = await api.inject({
        method: 'GET', url: '/api/v1/reading-progress?limit=10', headers: readHeaders(outsider),
      });
      assert.equal(hiddenProgress.statusCode, 200, hiddenProgress.body);
      assert.equal(hiddenProgress.json().items.length, 2);
      assert.equal(hiddenProgress.json().items.every((item: { target: { availability: string } }) =>
        item.target.availability === 'unavailable'), true);

      for (const request of [
        api.inject({ method: 'PUT', url: `/api/v1/saved-resources/node/${target.nodeId}`, headers: savedWriteHeaders(outsider) }),
        api.inject({ method: 'PUT', url: `/api/v1/reading-progress/node/${target.nodeId}`, headers: writeHeaders(outsider), payload: { status: 'completed', progress: 1 } }),
      ]) {
        assert.equal((await request).statusCode, 404);
      }

      const ownerProgress = await api.inject({
        method: 'PUT', url: `/api/v1/reading-progress/node/${target.nodeId}`,
        headers: writeHeaders(owner), payload: { status: 'completed', progress: 1 },
      });
      const memberSaved = await api.inject({
        method: 'PUT', url: `/api/v1/saved-resources/node/${target.nodeId}`, headers: savedWriteHeaders(member),
      });
      assert.equal(ownerProgress.statusCode, 201, ownerProgress.body);
      assert.equal(memberSaved.statusCode, 201, memberSaved.body);
      const ownerProgressItem = await api.inject({
        method: 'GET', url: `/api/v1/reading-progress/node/${target.nodeId}`, headers: readHeaders(owner),
      });
      assert.equal(ownerProgressItem.statusCode, 200, ownerProgressItem.body);
      assert.equal(ownerProgressItem.json().target.availability, 'available');

      await revokeHideAction(collectionHide);
      const restored = await api.inject({
        method: 'PUT', url: `/api/v1/saved-resources/node/${target.nodeId}`, headers: savedWriteHeaders(outsider),
      });
      assert.equal(restored.statusCode, 200, restored.body);
      const restoredProgress = await api.inject({
        method: 'GET', url: `/api/v1/reading-progress/node/${target.nodeId}`, headers: readHeaders(outsider),
      });
      assert.equal(restoredProgress.statusCode, 200, restoredProgress.body);
      assert.equal(restoredProgress.json().target.availability, 'available');

      const bookmarkHide = await addHideAction({
        targetKind: 'bookmark', targetId: target.nodeId, parentId: target.collectionId, actorAccountId: owner.accountId,
      });
      const bookmarkHidden = await api.inject({
        method: 'GET', url: `/api/v1/reading-progress/node/${target.nodeId}`, headers: readHeaders(outsider),
      });
      assert.equal(bookmarkHidden.statusCode, 200, bookmarkHidden.body);
      assert.equal(bookmarkHidden.json().target.availability, 'unavailable');
      const collectionStillVisible = await api.inject({
        method: 'GET', url: `/api/v1/reading-progress/collection/${target.collectionId}`, headers: readHeaders(outsider),
      });
      assert.equal(collectionStillVisible.statusCode, 200, collectionStillVisible.body);
      assert.equal(collectionStillVisible.json().target.availability, 'available');
      const memberProgress = await api.inject({
        method: 'PUT', url: `/api/v1/reading-progress/node/${target.nodeId}`,
        headers: writeHeaders(member), payload: { status: 'in_progress', progress: 0.4 },
      });
      assert.equal(memberProgress.statusCode, 201, memberProgress.body);
      const memberBookmark = await api.inject({
        method: 'GET', url: `/api/v1/reading-progress/node/${target.nodeId}`, headers: readHeaders(member),
      });
      assert.equal(memberBookmark.statusCode, 200, memberBookmark.body);
      assert.equal(memberBookmark.json().target.availability, 'available');

      await revokeHideAction(bookmarkHide);
      const bookmarkRestored = await api.inject({
        method: 'GET', url: `/api/v1/reading-progress/node/${target.nodeId}`, headers: readHeaders(outsider),
      });
      assert.equal(bookmarkRestored.statusCode, 200, bookmarkRestored.body);
      assert.equal(bookmarkRestored.json().target.availability, 'available');
    } finally {
      await api.close();
    }
  }, 60_000);
});
