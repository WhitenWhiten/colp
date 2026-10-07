import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionChildrenReadUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { createCollectionChildrenCursorSigner } from '../../../src/modules/collections/index.js';

const ORIGIN = 'https://app.example.test';
const ISSUER = 'https://issuer.example.test/realms/known';
const CURSOR_KEY = Buffer.alloc(32, 42).toString('base64url');

describeWithPostgres('collection children official hide_public', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('fo_children_gov', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function seedPublicCollection(ownerSubjectId: string): Promise<{
    collectionId: string;
    rootId: string;
    bookmarkId: string;
  }> {
    const collectionId = `chgov-${randomUUID().slice(0, 8)}`;
    const rootId = `root-${collectionId}`;
    const bookmarkId = `bm-${collectionId}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type)
         values ($1, 'collection'), ($2, 'node'), ($3, 'node')`,
        [collectionId, rootId, bookmarkId],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, commit_ordinal, created_at, updated_at,
           publication_slug, published_at)
         values ($1,$2,'Children gov','bookmarks','public',$3,'1','1','1',1,now(),now(),$4,now())`,
        [collectionId, ownerSubjectId, rootId, `chgov-${collectionId.slice(-6)}`],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at)
         values ($1,$2,null,'folder',true,'Root',null,null,'1','1',now(),now())`,
        [rootId, collectionId],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at)
         values ($1,$2,$3,'bookmark',false,'Hidden bookmark','https://example.test/x','A1','1','1',now(),now())`,
        [bookmarkId, collectionId, rootId],
      );
      await client.query(
        `insert into collection_members(collection_id, subject_id, role, granted_at)
         values ($1,$2,'owner',now())`,
        [collectionId, ownerSubjectId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    return { collectionId, rootId, bookmarkId };
  }

  async function insertHide(input: {
    readonly actorAccountId: string;
    readonly ownerAccountId: string;
    readonly targetKind: 'collection' | 'bookmark';
    readonly targetId: string;
    readonly parentId?: string;
  }): Promise<void> {
    const caseId = `case_${randomUUID()}`;
    const actionId = `act_${randomUUID()}`;
    const fingerprint = `${input.targetKind}:${input.targetId}:${actionId}`;
    const targetJson = JSON.stringify({
      kind: input.targetKind,
      id: input.targetId,
      ...(input.parentId === undefined ? {} : { collectionId: input.parentId }),
    });
    await isolated.runtime.pool.query(
      `insert into moderation_cases (
         id, reporter_account_id, target_kind, target_id, parent_id, target_json, target_fingerprint,
         category, description, status, revision, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,'spam','fixture','in_review','1',now(),now())`,
      [caseId, input.actorAccountId, input.targetKind, input.targetId, input.parentId ?? null, targetJson, fingerprint],
    );
    await isolated.runtime.pool.query(
      `insert into moderation_actions (
         id, case_id, target_kind, target_id, parent_id, target_json, target_fingerprint, action, reason,
         actor_account_id, state, revision, created_at, owner_account_id)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,'hide_public','fixture',$8,'active','1',now(),$9)`,
      [
        actionId, caseId, input.targetKind, input.targetId, input.parentId ?? null,
        targetJson, fingerprint, input.actorAccountId, input.ownerAccountId,
      ],
    );
  }

  function buildApp(factory: ReturnType<typeof createPostgresBetterAuthTestFactory>) {
    const config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
      OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`,
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_FAVICON_POLICY: 'true',
      FAVICON_CURSOR_HMAC_KEY: CURSOR_KEY,
    });
    return buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(
        isolated.runtime.db, { productOrigin: ORIGIN }),
      collectionChildrenReadUnitOfWork: createPostgresCollectionChildrenReadUnitOfWork(
        isolated.runtime.db, {
          cursorSigner: createCollectionChildrenCursorSigner(config.faviconPolicy.cursorHmacKey),
          productOrigin: ORIGIN,
        }),
      browserSessionAuthority: factory.authority,
    });
  }

  test('hide_public collection conceals anonymous children and keeps owner management', async () => {
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const owner = await issueTestSession({
      factory,
      subject: `chgov-owner-${randomUUID()}`,
      handle: `cgo${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const seeded = await seedPublicCollection(owner.subjectId);
    const app = buildApp(factory);
    try {
      const before = await app.inject({ method: 'GET', url: `/api/v1/collections/${seeded.collectionId}/children` });
      assert.equal(before.statusCode, 200, before.body);
      await insertHide({
        actorAccountId: owner.accountId,
        ownerAccountId: owner.accountId,
        targetKind: 'collection',
        targetId: seeded.collectionId,
      });
      const anon = await app.inject({ method: 'GET', url: `/api/v1/collections/${seeded.collectionId}/children` });
      assert.equal(anon.statusCode, 404, anon.body);
      const owned = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${seeded.collectionId}/children`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(owned.statusCode, 200, owned.body);
      const body = owned.json() as { items: Array<{ id: string }> };
      assert.equal(body.items.some((item) => item.id === seeded.bookmarkId), true);
    } finally {
      await app.close();
    }
  }, 60_000);

  async function insertRestrictPublication(input: {
    readonly actorAccountId: string;
    readonly accountId: string;
  }): Promise<void> {
    const caseId = `case_${randomUUID()}`;
    const actionId = `act_${randomUUID()}`;
    const fingerprint = `account:${input.accountId}:${actionId}`;
    const targetJson = JSON.stringify({ kind: 'account', id: input.accountId });
    await isolated.runtime.pool.query(
      `insert into moderation_cases (
         id, reporter_account_id, target_kind, target_id, target_json, target_fingerprint,
         category, description, status, revision, created_at, updated_at)
       values ($1,$2,'account',$3,$4::jsonb,$5,'spam','fixture','in_review','1',now(),now())`,
      [caseId, input.actorAccountId, input.accountId, targetJson, fingerprint],
    );
    await isolated.runtime.pool.query(
      `insert into moderation_actions (
         id, case_id, target_kind, target_id, target_json, target_fingerprint, action, reason,
         actor_account_id, state, revision, created_at, owner_account_id)
       values ($1,$2,'account',$3,$4::jsonb,$5,'restrict_publication','fixture',$6,'active','1',now(),$3)`,
      [actionId, caseId, input.accountId, targetJson, fingerprint, input.actorAccountId],
    );
  }

  test('restrict_publication conceals anonymous children and keeps owner management', async () => {
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const owner = await issueTestSession({
      factory,
      subject: `chgov-rpub-${randomUUID()}`,
      handle: `cgr${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const seeded = await seedPublicCollection(owner.subjectId);
    const app = buildApp(factory);
    try {
      const before = await app.inject({ method: 'GET', url: `/api/v1/collections/${seeded.collectionId}/children` });
      assert.equal(before.statusCode, 200, before.body);
      await insertRestrictPublication({
        actorAccountId: owner.accountId,
        accountId: owner.accountId,
      });
      const anon = await app.inject({ method: 'GET', url: `/api/v1/collections/${seeded.collectionId}/children` });
      assert.equal(anon.statusCode, 404, anon.body);
      const owned = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${seeded.collectionId}/children`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(owned.statusCode, 200, owned.body);
      const body = owned.json() as { items: Array<{ id: string }> };
      assert.equal(body.items.some((item) => item.id === seeded.bookmarkId), true);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('hide_public bookmark is tombstoned for anonymous children and kept for the owner', async () => {
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const owner = await issueTestSession({
      factory,
      subject: `chgov-bm-${randomUUID()}`,
      handle: `cgb${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const seeded = await seedPublicCollection(owner.subjectId);
    await insertHide({
      actorAccountId: owner.accountId,
      ownerAccountId: owner.accountId,
      targetKind: 'bookmark',
      targetId: seeded.bookmarkId,
      parentId: seeded.collectionId,
    });
    const app = buildApp(factory);
    try {
      const anon = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${seeded.collectionId}/children`,
      });
      assert.equal(anon.statusCode, 200, anon.body);
      const anonBody = anon.json() as {
        items: Array<{ id: string; title: string; url: string | null; iconUrl: string | null; state?: string }>;
      };
      const tombstone = anonBody.items.find((item) => item.id === seeded.bookmarkId);
      assert.ok(tombstone, 'the hidden bookmark stays in the page as a tombstone');
      assert.equal(tombstone.state, 'hidden');
      assert.equal(tombstone.title, 'Bookmark hidden');
      assert.equal(tombstone.url, null);
      assert.equal(tombstone.iconUrl, null);
      const owned = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${seeded.collectionId}/children`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(owned.statusCode, 200, owned.body);
      const ownedBody = owned.json() as { items: Array<{ id: string }> };
      assert.equal(ownedBody.items.some((item) => item.id === seeded.bookmarkId), true);
    } finally {
      await app.close();
    }
  }, 60_000);
});
