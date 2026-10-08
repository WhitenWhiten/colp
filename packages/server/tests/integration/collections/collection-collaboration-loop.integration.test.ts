/**
 * SC-06 closed collaboration loop against real Fastify + PostgreSQL.
 * create → invite → mailbox still 1 (SC-04) → B accept → B editor create node
 * → A members include B → A remove B → B editor conceal.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import { processOne } from '../../../src/modules/access-policy/index.js';
import { createTestCollaborationListCursors } from '../../support/collaboration-list-cursors.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsEditorReadUnitOfWork,
  createPostgresCollectionsUnitOfWork,
  createPostgresSharedCollectionsReadPort,
  createPostgresCollectionBookmarkCountReadPort,
} from '../../../src/infrastructure/collections/index.js';
import { createPostgresCollaborationUnitOfWork } from '../../../src/infrastructure/collaboration/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresInviteEmailDeliveryRepository } from '../../../src/infrastructure/access-policy/invite-email-worker-postgres.js';
import {
  createInviteEmailAdapter,
  createInviteEmailMailboxSink,
} from '../../../src/infrastructure/email/invite-email-adapter.js';
import { createMemoryCollaborationInviteRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import {
  createProductEditorCursorSigner,
  createProductSharedCollectionsCursorSigner,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://known.example';
const INVITE_201_KEYS = ['collectionId', 'expiresAt', 'inviteId', 'policyEtag', 'role'];
const COLLECTION_TITLE = 'Loop shared collection';

describeWithPostgres('collection collaboration closed loop', () => {
  let isolated: IsolatedPostgresRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('sc06_collab_loop', { maxConnections: 8 });
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
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'sc06-editor-cursor-key',
      COLLABORATION_INVITE_EMAIL_ENABLED: 'true',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
  }, 180_000);

  afterAll(async () => isolated?.close());

  test('create, invite, mailbox stays 1, accept, editor write, members, remove, conceal', async () => {
    const app = composeApp();
    const sink = createInviteEmailMailboxSink();
    try {
      const owner = await login('sc06-owner', 'sc06-owner@example.test', 'Loop Owner');
      const editor = await login('sc06-editor', 'sc06-editor@example.test', 'Loop Editor');
      const collection = await createOwnedCollection(app, owner, COLLECTION_TITLE, '10000000-0000-4000-8000-00000000c601');

      const invited = await app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.id}/members/invites`,
        headers: mutationHeaders(owner, '10000000-0000-4000-8000-00000000c602', {
          'if-match': collection.policyEtag,
        }),
        payload: { email: 'sc06-editor@example.test', role: 'editor' },
      });
      assert.equal(invited.statusCode, 201, invited.payload);
      assert.deepEqual(Object.keys(invited.json() as object).sort(), INVITE_201_KEYS);
      const inviteId = invited.json().inviteId as string;

      const delivered = await drainMailbox(sink, inviteId);
      assert.equal(delivered, 1);
      assert.equal(sink.entries.length, 1, 'mailbox-still-1: one 201 invite queues exactly one letter');
      assert.equal(sink.entries[0]?.to, 'sc06-editor@example.test');

      const pending = await app.inject({
        method: 'GET',
        url: '/api/v1/me/collaboration-invites',
        headers: { cookie: editor.cookie },
      });
      assert.equal(pending.statusCode, 200, pending.payload);
      const pendingItem = pending.json().items.find((item: { inviteId: string }) => item.inviteId === inviteId);
      assert.equal(pendingItem?.collectionTitle, COLLECTION_TITLE);
      assert.equal(pendingItem?.collectionId, collection.id);

      const accept = await app.inject({
        method: 'POST',
        url: `/api/v1/me/collaboration-invites/${inviteId}/accept`,
        headers: {
          cookie: editor.cookie,
          origin: ORIGIN,
          'x-csrf-token': editor.csrfToken,
          'known-command-id': '10000000-0000-4000-8000-00000000c603',
        },
      });
      assert.equal(accept.statusCode, 200, accept.payload);
      assert.equal(accept.json().subjectId, editor.subjectId);
      assert.equal(accept.json().role, 'editor');

      const shared = await app.inject({
        method: 'GET',
        url: '/api/v1/me/shared-collections',
        headers: { cookie: editor.cookie, accept: 'application/json' },
      });
      assert.equal(shared.statusCode, 200, shared.payload);
      assert.ok(shared.json().items.some((item: { collection: { id: string } }) => item.collection.id === collection.id));

      const editorPage = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.id}/editor`,
        headers: { cookie: editor.cookie },
      });
      assert.equal(editorPage.statusCode, 200, editorPage.payload);
      assert.equal(editorPage.json().capabilities.createNode, true);

      const createdNode = await app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.id}/nodes`,
        headers: mutationHeaders(editor, '10000000-0000-4000-8000-00000000c604'),
        payload: {
          parentId: collection.rootId,
          afterId: null,
          beforeId: null,
          node: {
            kind: 'bookmark',
            title: 'Editor bookmark',
            url: 'https://example.test/loop',
            description: null,
            tags: [],
            visibility: 'inherit',
          },
        },
      });
      assert.equal(createdNode.statusCode, 201, createdNode.payload);

      const members = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.id}/members`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(members.statusCode, 200, members.payload);
      assert.ok(members.json().members.some((member: { subjectId: string; role: string }) => (
        member.subjectId === editor.subjectId && member.role === 'editor'
      )));

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${collection.id}/members/${editor.subjectId}`,
        headers: {
          cookie: owner.cookie,
          origin: ORIGIN,
          'x-csrf-token': owner.csrfToken,
          'known-command-id': '10000000-0000-4000-8000-00000000c605',
          'if-match': members.json().policyEtag as string,
        },
      });
      assert.equal(removed.statusCode, 204, removed.payload);

      const concealed = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.id}/editor`,
        headers: { cookie: editor.cookie },
      });
      assert.equal(concealed.statusCode, 404, concealed.payload);
      assert.equal(concealed.json().error.code, 'resource_not_found');

      const sharedAfter = await app.inject({
        method: 'GET',
        url: '/api/v1/me/shared-collections',
        headers: { cookie: editor.cookie, accept: 'application/json' },
      });
      assert.equal(sharedAfter.statusCode, 200, sharedAfter.payload);
      assert.equal(
        sharedAfter.json().items.some((item: { collection: { id: string } }) => item.collection.id === collection.id),
        false,
      );
      assert.equal(sink.entries.length, 1, 'mailbox-still-1 after the rest of the loop');
    } finally {
      await app.close();
    }
  });

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
      sharedCollectionsQuery: {
        reads: createPostgresSharedCollectionsReadPort(isolated.runtime.db),
        cursors: createProductSharedCollectionsCursorSigner({
          current: config.productOwnedCollectionsCursor.current,
          previous: config.productOwnedCollectionsCursor.previous,
        }),
        clock: { now: async () => new Date() },
      },
      bookmarkCounts: createPostgresCollectionBookmarkCountReadPort(isolated.runtime.db),
      browserSessionAuthority: factory.authority,
      productCollaboration: {
        identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db, {
          oidcTransactionSecrets: config.oidcTransactionSecrets,
        }),
        allowedOrigins: [ORIGIN],
        unitOfWork: createPostgresCollaborationUnitOfWork(isolated.runtime.db, {
          inviteEmailEnabled: true,
        }),
        rateLimiter: createMemoryCollaborationInviteRateLimiter({
          keySecret: Buffer.alloc(32, 26),
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

  async function createOwnedCollection(
    app: ReturnType<typeof composeApp>,
    owner: { cookie: string; csrfToken: string },
    title: string,
    commandId: string,
  ): Promise<{ id: string; policyEtag: string; rootId: string }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutationHeaders(owner, commandId),
      payload: { kind: 'bookmarks', title, summary: null },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const collectionId = created.json().collection.id as string;
    const rootId = created.json().root.id as string;
    const members = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}/members`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(members.statusCode, 200, members.payload);
    return { id: collectionId, policyEtag: members.json().policyEtag as string, rootId };
  }

  async function drainMailbox(
    sink: ReturnType<typeof createInviteEmailMailboxSink>,
    inviteId: string,
  ): Promise<number> {
    const repository = createPostgresInviteEmailDeliveryRepository(isolated.runtime.pool);
    const sender = createInviteEmailAdapter({
      provider: sink.provider,
      logger: createLogger('silent'),
    });
    let count = 0;
    for (let i = 0; i < 8; i += 1) {
      const result = await processOne({
        repository,
        sender,
        loginUrl: `${ORIGIN}/login?returnTo=/library`,
        leaseDurationMs: 30_000,
        inviteId,
      });
      if (result.disposition === 'idle') break;
      count += 1;
    }
    return count;
  }
});

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
