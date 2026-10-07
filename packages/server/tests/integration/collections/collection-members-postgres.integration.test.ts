/**
 * SC-02 collection member HTTP against real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsEditorReadUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { createPostgresCollaborationUnitOfWork } from '../../../src/infrastructure/collaboration/index.js';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createMemoryCollaborationInviteRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { createTestCollaborationListCursors } from '../../support/collaboration-list-cursors.js';
import { createProductEditorCursorSigner } from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://known.example';
const INVITES_HEAD = '202609080100_collection_invites';
const TITLE_SNAPSHOT = '202609080200_collection_invite_title_snapshot';
const INVITE_201_KEYS = ['collectionId', 'expiresAt', 'inviteId', 'policyEtag', 'role'];

describeWithPostgres('collection members postgres product HTTP', () => {
  let isolated: IsolatedPostgresRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('sc02_members_http', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
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
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'sc02-editor-cursor-key',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
  }, 180_000);

  afterAll(async () => isolated?.close());

  function composeApp() {
    return buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db, {
        oidcTransactionSecrets: config.oidcTransactionSecrets,
      }),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      collectionsEditorReadUnitOfWork: createPostgresCollectionsEditorReadUnitOfWork(isolated.runtime.db, {
        cursorSigner: createProductEditorCursorSigner({
          current: config.productEditorCursor.current,
          previous: config.productEditorCursor.previous,
        }),
        cursorTtlMs: config.productEditorCursor.ttlMs,
      }),
      browserSessionAuthority: factory.authority,
      productCollaboration: {
        identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db, {
          oidcTransactionSecrets: config.oidcTransactionSecrets,
        }),
        allowedOrigins: [ORIGIN],
        unitOfWork: createPostgresCollaborationUnitOfWork(isolated.runtime.db),
        rateLimiter: createMemoryCollaborationInviteRateLimiter({
          keySecret: Buffer.alloc(32, 23),
          environment: 'test',
        }),
        cursors: createTestCollaborationListCursors(),
      },
    });
  }

  async function login(subject: string, email: string, displayName: string) {
    return issueTestSession({
      factory,
      subject,
      handle: subject.replace(/[^a-z0-9]/giu, '').slice(0, 16).toLowerCase(),
      email,
      displayName,
    });
  }

  function mutationHeaders(
    client: { cookie: string; csrfToken: string },
    commandId: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      cookie: client.cookie,
      origin: ORIGIN,
      'x-csrf-token': client.csrfToken,
      'known-command-id': commandId,
      'content-type': 'application/json',
      ...extra,
    };
  }

  async function createOwnedCollection(
    app: ReturnType<typeof composeApp>,
    owner: { cookie: string; csrfToken: string },
    title: string,
    commandId: string,
  ): Promise<{ id: string; policyEtag: string }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutationHeaders(owner, commandId),
      payload: { kind: 'bookmarks', title, summary: null },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const collectionId = created.json().collection.id as string;
    const members = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}/members`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(members.statusCode, 200, members.payload);
    return { id: collectionId, policyEtag: members.json().policyEtag as string };
  }

  test('invite then accept then GET editor createNode is true for editor and false for viewer', async () => {
    const app = composeApp();
    try {
      const owner = await login('sc02-owner-editor', 'sc02-owner-editor@example.test', 'Owner Editor');
      const editor = await login('sc02-invitee-editor', 'sc02-invitee-editor@example.test', 'Ed Invitee');
      const viewer = await login('sc02-invitee-viewer', 'sc02-invitee-viewer@example.test', 'Vic Invitee');
      const collection = await createOwnedCollection(
        app, owner, 'Shared editor collection', '10000000-0000-4000-8000-00000000c201',
      );

      const inviteEditor = await app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.id}/members/invites`,
        headers: mutationHeaders(owner, '10000000-0000-4000-8000-00000000c202', {
          'if-match': collection.policyEtag,
        }),
        payload: { email: 'sc02-invitee-editor@example.test', role: 'editor' },
      });
      assert.equal(inviteEditor.statusCode, 201, inviteEditor.payload);
      assert.deepEqual(Object.keys(inviteEditor.json()).sort(), INVITE_201_KEYS);
      const acceptEditor = await app.inject({
        method: 'POST',
        url: `/api/v1/me/collaboration-invites/${inviteEditor.json().inviteId}/accept`,
        headers: {
          cookie: editor.cookie,
          origin: ORIGIN,
          'x-csrf-token': editor.csrfToken,
          'known-command-id': '10000000-0000-4000-8000-00000000c203',
        },
      });
      assert.equal(acceptEditor.statusCode, 200, acceptEditor.payload);

      const membersAfterEditor = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.id}/members`,
        headers: { cookie: owner.cookie },
      });
      const inviteViewer = await app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.id}/members/invites`,
        headers: mutationHeaders(owner, '10000000-0000-4000-8000-00000000c204', {
          'if-match': membersAfterEditor.json().policyEtag as string,
        }),
        payload: { email: 'sc02-invitee-viewer@example.test', role: 'viewer' },
      });
      assert.equal(inviteViewer.statusCode, 201, inviteViewer.payload);
      const acceptViewer = await app.inject({
        method: 'POST',
        url: `/api/v1/me/collaboration-invites/${inviteViewer.json().inviteId}/accept`,
        headers: {
          cookie: viewer.cookie,
          origin: ORIGIN,
          'x-csrf-token': viewer.csrfToken,
          'known-command-id': '10000000-0000-4000-8000-00000000c205',
        },
      });
      assert.equal(acceptViewer.statusCode, 200, acceptViewer.payload);

      const editorPage = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.id}/editor`,
        headers: { cookie: editor.cookie },
      });
      assert.equal(editorPage.statusCode, 200, editorPage.payload);
      assert.equal(editorPage.json().capabilities.createNode, true);

      const viewerPage = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.id}/editor`,
        headers: { cookie: viewer.cookie },
      });
      assert.equal(viewerPage.statusCode, 200, viewerPage.payload);
      assert.equal(viewerPage.json().capabilities.createNode, false);
    } finally {
      await app.close();
    }
  });

  test('GET members joins profile avatarUrl and fail-closes invalid URLs', async () => {
    const app = composeApp();
    try {
      const owner = await login('sc02-owner-avatar', 'sc02-owner-avatar@example.test', 'Owner Avatar');
      const collection = await createOwnedCollection(
        app, owner, 'Avatar members', '10000000-0000-4000-8000-00000000c231',
      );
      await isolated.runtime.pool.query(
        `update profiles set avatar_url = $1 where account_id = $2`,
        ['https://cdn.example.test/owner-avatar.png', owner.accountId],
      );
      const listed = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.id}/members`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(listed.statusCode, 200, listed.payload);
      const ownerRow = (listed.json().members as Array<{
        subjectId: string; avatarUrl: string | null; initials: string;
      }>).find((row) => row.subjectId === owner.subjectId);
      assert.equal(ownerRow?.avatarUrl, 'https://cdn.example.test/owner-avatar.png');
      assert.equal(ownerRow?.initials, 'OA');

      await isolated.runtime.pool.query(
        `update profiles set avatar_url = $1 where account_id = $2`,
        ['javascript:alert(1)', owner.accountId],
      );
      const listedAgain = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.id}/members`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(listedAgain.statusCode, 200, listedAgain.payload);
      const unsafeRow = (listedAgain.json().members as Array<{
        subjectId: string; avatarUrl: string | null;
      }>).find((row) => row.subjectId === owner.subjectId);
      assert.equal(unsafeRow?.avatarUrl, null);
    } finally {
      await app.close();
    }
  });

  test('owner A cannot list owner B members', async () => {
    const app = composeApp();
    try {
      const ownerA = await login('sc02-owner-a', 'sc02-owner-a@example.test', 'Owner A');
      const ownerB = await login('sc02-owner-b', 'sc02-owner-b@example.test', 'Owner B');
      const collectionA = await createOwnedCollection(
        app, ownerA, 'A private', '10000000-0000-4000-8000-00000000c211',
      );
      const collectionB = await createOwnedCollection(
        app, ownerB, 'B private', '10000000-0000-4000-8000-00000000c212',
      );
      const aOnB = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collectionB.id}/members`,
        headers: { cookie: ownerA.cookie },
      });
      const bOnA = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collectionA.id}/members`,
        headers: { cookie: ownerB.cookie },
      });
      assert.equal(aOnB.statusCode, 404);
      assert.equal(aOnB.json().error.code, 'resource_not_found');
      assert.equal(bOnA.statusCode, 404);
      assert.equal(bOnA.json().error.code, 'resource_not_found');
    } finally {
      await app.close();
    }
  });

  test('201 invite inserts a delivery row without changing the 201 keys', async () => {
    const app = composeApp();
    try {
      const owner = await login('sc02-owner-outbox', 'sc02-owner-outbox@example.test', 'Owner Outbox');
      const collection = await createOwnedCollection(
        app, owner, 'No delivery', '10000000-0000-4000-8000-00000000c221',
      );
      const invited = await app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.id}/members/invites`,
        headers: mutationHeaders(owner, '10000000-0000-4000-8000-00000000c222', {
          'if-match': collection.policyEtag,
        }),
        payload: { email: 'nobody-sc02@example.test', role: 'editor' },
      });
      assert.equal(invited.statusCode, 201, invited.payload);
      assert.deepEqual(Object.keys(invited.json() as object).sort(), INVITE_201_KEYS);
      const deliveries = await isolated.runtime.pool.query<{ n: string }>(
        `select count(*)::text as n from collection_invite_deliveries`,
      );
      assert.equal(deliveries.rows[0]?.n === '0', false);
      const outbox = await isolated.runtime.pool.query<{ n: string }>(
        `select count(*)::text as n from outbox_events
          where event_type like '%invite%' or handler_name like '%invite%'`,
      );
      assert.notEqual(outbox.rows[0]?.n, '0');
    } finally {
      await app.close();
    }
  });

  test('production migrations include the title-snapshot expand after collection_invites', async () => {
    const upgrade = await createIsolatedPostgresRuntime('sc02_title_snapshot_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const toInvites = await migrator.migrateTo(INVITES_HEAD);
      if (toInvites.error) throw toInvites.error;
      const before = await upgrade.runtime.pool.query<{ n: string }>(
        `select count(*)::text as n from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'collection_invites'
            and column_name = 'collection_title_snapshot'`,
      );
      assert.equal(before.rows[0]?.n, '0');
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const after = await upgrade.runtime.pool.query<{
        column_name: string;
        is_nullable: string;
      }>(
        `select column_name, is_nullable from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'collection_invites'
            and column_name = 'collection_title_snapshot'`,
      );
      assert.equal(after.rows[0]?.column_name, 'collection_title_snapshot');
      assert.equal(after.rows[0]?.is_nullable, 'NO');
      const names = await upgrade.runtime.pool.query<{ name: string }>(
        `select name from kysely_migration where name = $1`,
        [TITLE_SNAPSHOT],
      );
      assert.equal(names.rows[0]?.name, TITLE_SNAPSHOT);
    } finally {
      await upgrade.close();
    }
  });
});
