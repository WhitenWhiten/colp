import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import { composePublicProfileProjection } from '../../../src/bootstrap/public-profile-projection.js';
import { buildWorker, type WorkerRuntime } from '../../../src/bootstrap/worker.js';
import {
  createPostgresCollectionsEditorReadUnitOfWork,
  createPostgresOwnedCollectionsReadPort,
  createPostgresCollectionBookmarkCountReadPort,
} from '../../../src/infrastructure/collections/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import { createPostgresPublicationDirectoryReadPort } from '../../../src/infrastructure/publication/index.js';
import { createPostgresSharedExposureFactsPort, createDatabaseRuntime, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresCanonicalMutationUnitOfWork, createPostgresCollectionsUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import {
  PostgresCollectionMutationProjectionSink,
  SOCIAL_COLLECTION_CHANGE_HANDLER_NAME,
  SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME,
} from '../../../src/infrastructure/outbox/index.js';
import {
  claimHandle,
  createProductEditorCursorSigner,
  createProductOwnedCollectionsCursorSigner,
  createPublicationCursorKeyring,
} from '../../../src/modules/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const COMMAND = Object.freeze({
  collectionCreate: '10000000-0000-4000-8000-000000000001',
  collectionUpdate: '10000000-0000-4000-8000-000000000002',
  staleCollectionUpdate: '10000000-0000-4000-8000-000000000003',
  folderCreate: '10000000-0000-4000-8000-000000000004',
  bookmarkCreate: '10000000-0000-4000-8000-000000000005',
  bookmarkUpdate: '10000000-0000-4000-8000-000000000006',
  bookmarkMove: '10000000-0000-4000-8000-000000000007',
  missingPrecondition: '10000000-0000-4000-8000-000000000008',
  bookmarkDelete: '10000000-0000-4000-8000-000000000009',
  restartedCollectionCreate: '10000000-0000-4000-8000-000000000010',
});

type ApiApp = ReturnType<typeof buildApiApp>;

interface BrowserClient {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface CollectionDocument {
  readonly collection: {
    readonly id: string;
    readonly rootNodeId: string;
    readonly etag: string;
    readonly contentRevision: string;
    readonly title: string;
  };
  readonly root: {
    readonly id: string;
    readonly childrenRevision: string;
  };
}

interface NodeDocument {
  readonly node: {
    readonly id: string;
    readonly etag: string;
    readonly parentId: string;
    readonly title: string;
    readonly childrenRevision?: string;
  };
  readonly parent: { readonly id: string; readonly childrenRevision: string };
  readonly fence: { readonly contentRevision: string };
}

interface EditorPageDocument {
  readonly collection: { readonly id: string; readonly title: string };
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly parentId: string;
    readonly title: string;
  }>;
  readonly page: {
    readonly returnedCount: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

describeWithPostgres('Product HTTP + PostgreSQL black-box lifecycle', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  const profileCursors = createPublicationCursorKeyring({
    active: { id: 'product-profile-black-box-v1', secret: Buffer.alloc(32, 92).toString('base64') },
    retained: [],
  });
  const ownedCollectionCursors = createProductOwnedCollectionsCursorSigner({
    current: { id: 'owned-black-box-v1', key: 'owned-black-box-cursor-secret-material-32-bytes' },
  });

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('product_http_black_box', {
      maxConnections: 8,
      applicationName: 'known-product-http-black-box',
    });
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
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'black-box-editor-cursor-key',
      WORKER_POLL_INTERVAL_MS: '5',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
  });

  afterAll(async () => {
    ownedCollectionCursors.destroy();
    profileCursors.destroy();
    await isolated?.close();
  });

  function composeApp(): ApiApp {
    const identity = createPostgresIdentityUnitOfWork(runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    return buildApiApp({
      config,
      readiness: runtime,
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      identityUnitOfWork: identity,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      collectionsEditorReadUnitOfWork: createPostgresCollectionsEditorReadUnitOfWork(runtime.db, {
        cursorSigner: createProductEditorCursorSigner({
          current: config.productEditorCursor.current,
          previous: config.productEditorCursor.previous,
        }),
        cursorTtlMs: config.productEditorCursor.ttlMs,
      }),
      browserSessionAuthority: factory.authority,
      publicProfileQuery: composePublicProfileProjection({
        profiles: createPostgresPublicProfileFactsReadPort(runtime),
        collections: createPostgresPublicationDirectoryReadPort(runtime),
        cursors: profileCursors,
        sharedExposure: createPostgresSharedExposureFactsPort(runtime),
      }),
      ownedCollectionsQuery: {
        reads: createPostgresOwnedCollectionsReadPort(runtime.db),
        cursors: ownedCollectionCursors,
        clock: { now: async () => new Date() },
      },
      bookmarkCounts: createPostgresCollectionBookmarkCountReadPort(runtime.db),
    });
  }

  function composeProjectionWorker(): WorkerRuntime {
    const projectionDatabase = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 4,
      applicationName: 'known-product-http-black-box-worker',
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 1_000,
    });
    return buildWorker(config, projectionDatabase);
  }

  async function logIn(_app: ApiApp, subject: string): Promise<BrowserClient> {
    const client = await issueTestSession({
      factory,
      subject,
      displayName: `Black Box ${subject}`,
      handle: `bb_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    });
    return { cookie: client.cookie, csrfToken: client.csrfToken };
  }

  function mutationHeaders(
    client: BrowserClient,
    commandId: string,
    mediaType: string | null = 'application/json',
  ): Record<string, string> {
    return {
      cookie: client.cookie,
      origin: ORIGIN,
      'x-csrf-token': client.csrfToken,
      'known-command-id': commandId,
      ...(mediaType === null ? {} : { 'content-type': mediaType }),
    };
  }

  async function drainOutbox(worker: WorkerRuntime): Promise<void> {
    assert.ok(worker.outbox);
    while (await worker.outbox.runOnce()) {
      // Each iteration claims and commits one durable projection delivery.
    }
  }

  test('lists only the Session subject through real Fastify, Session guard, mapper, cursor, and PostgreSQL', async () => {
    const app = composeApp();
    try {
      const owner = await logIn(app, 'owned-list-owner');
      const outsider = await logIn(app, 'owned-list-outsider');
      for (const [client, title, commandId] of [
        [owner, 'Owner first private title', '20000000-0000-4000-8000-000000000001'],
        [owner, 'Owner second private title', '20000000-0000-4000-8000-000000000002'],
        [outsider, 'Outsider secret title', '20000000-0000-4000-8000-000000000003'],
      ] as const) {
        const created = await app.inject({ method: 'POST', url: '/api/v1/collections',
          headers: mutationHeaders(client, commandId),
          payload: { kind: 'bookmarks', title, summary: null } });
        assert.equal(created.statusCode, 201);
      }

      const first = await app.inject({ method: 'GET', url: '/api/v1/collections?kind=bookmarks&visibility=private&limit=1',
        headers: { cookie: owner.cookie, accept: 'application/json' } });
      assert.equal(first.statusCode, 200); assert.equal(first.headers['cache-control'], 'private, no-store');
      const firstBody = first.json() as { items: Array<{ collection: { id: string; title: string } }>;
        page: { hasMore: boolean; nextCursor: string | null } };
      assert.equal(firstBody.items.length, 1); assert.equal(firstBody.page.hasMore, true); assert.ok(firstBody.page.nextCursor);
      const second = await app.inject({ method: 'GET',
        url: `/api/v1/collections?cursor=${encodeURIComponent(firstBody.page.nextCursor)}`,
        headers: { cookie: owner.cookie } });
      assert.equal(second.statusCode, 200);
      const all = [...firstBody.items, ...(second.json() as typeof firstBody).items];
      assert.deepEqual(new Set(all.map((item) => item.collection.title)),
        new Set(['Owner first private title', 'Owner second private title']));
      assert.equal(JSON.stringify(all).includes('Outsider secret title'), false);

      const outsiderList = await app.inject({ method: 'GET', url: '/api/v1/collections',
        headers: { cookie: outsider.cookie } });
      assert.equal(outsiderList.statusCode, 200);
      assert.deepEqual((outsiderList.json() as typeof firstBody).items.map((item) => item.collection.title),
        ['Outsider secret title']);
    } finally {
      await app.close();
    }
  });

  test('proves the client-visible lifecycle, durable delivery, and restart persistence', async () => {
    let app = composeApp();
    let primaryAppClosed = false;
    let restartedApp: ApiApp | undefined;
    let worker: WorkerRuntime | undefined;
    let restartedWorker: WorkerRuntime | undefined;
    try {
      const unauthenticated = await app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: {
          origin: ORIGIN,
          'known-command-id': randomUUID(),
          'content-type': 'application/json',
        },
        payload: { kind: 'bookmarks', title: 'Denied', summary: null },
      });
      assertProductError(unauthenticated, 401, 'authentication_required');

      const owner = await logIn(app, 'black-box-owner');
      const stranger = await logIn(app, 'black-box-stranger');

      const wrongOrigin = await app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: {
          ...mutationHeaders(owner, randomUUID()),
          origin: 'https://evil.example.test',
        },
        payload: { kind: 'bookmarks', title: 'Denied', summary: null },
      });
      assertProductError(wrongOrigin, 403, 'csrf_failed');

      const createPayload = {
        kind: 'bookmarks',
        title: 'Black-box collection',
        summary: 'real HTTP and PostgreSQL',
      };
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: mutationHeaders(owner, COMMAND.collectionCreate),
        payload: createPayload,
      });
      assert.equal(created.statusCode, 201);
      const collection = created.json() as CollectionDocument;

      const replay = await app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: mutationHeaders(owner, COMMAND.collectionCreate),
        payload: createPayload,
      });
      assert.equal(replay.statusCode, created.statusCode);
      assert.equal(replay.body, created.body);
      assert.equal(replay.headers.etag, created.headers.etag);
      assert.equal(replay.headers.location, created.headers.location);

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${collection.collection.id}`,
        headers: {
          ...mutationHeaders(owner, COMMAND.collectionUpdate, 'application/merge-patch+json'),
          'if-match': collection.collection.etag,
        },
        payload: { title: 'Black-box collection updated' },
      });
      assert.equal(updated.statusCode, 200);
      const updatedCollection = updated.json() as { collection: CollectionDocument['collection'] };

      const stale = await app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${collection.collection.id}`,
        headers: {
          ...mutationHeaders(owner, COMMAND.staleCollectionUpdate, 'application/merge-patch+json'),
          'if-match': collection.collection.etag,
        },
        payload: { title: 'Must conflict' },
      });
      assertProductError(stale, 412, 'precondition_failed');

      const folder = await app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`,
        headers: mutationHeaders(owner, COMMAND.folderCreate),
        payload: {
          parentId: collection.root.id,
          afterId: null,
          beforeId: null,
          node: {
            kind: 'folder', title: 'Destination', description: null, tags: [], visibility: 'inherit',
          },
        },
      });
      assert.equal(folder.statusCode, 201);
      const folderBody = folder.json() as NodeDocument;
      assert.equal(typeof folderBody.node.childrenRevision, 'string');

      const bookmark = await app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`,
        headers: mutationHeaders(owner, COMMAND.bookmarkCreate),
        payload: {
          parentId: collection.root.id,
          afterId: folderBody.node.id,
          beforeId: null,
          node: {
            kind: 'bookmark',
            title: 'HTTP bookmark',
            url: 'https://example.test/original',
            description: null,
            tags: ['black-box'],
            visibility: 'inherit',
          },
        },
      });
      assert.equal(bookmark.statusCode, 201);
      const bookmarkBody = bookmark.json() as NodeDocument;

      const bookmarkUpdated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${collection.collection.id}/nodes/${bookmarkBody.node.id}`,
        headers: {
          ...mutationHeaders(owner, COMMAND.bookmarkUpdate, 'application/merge-patch+json'),
          'if-match': bookmarkBody.node.etag,
        },
        payload: { title: 'HTTP bookmark updated', url: 'https://example.test/updated' },
      });
      assert.equal(bookmarkUpdated.statusCode, 200);
      const bookmarkUpdatedBody = bookmarkUpdated.json() as {
        node: NodeDocument['node']; fence: NodeDocument['fence'];
      };

      const pageOne = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.collection.id}/editor?limit=1`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(pageOne.statusCode, 200);
      const pageOneBody = pageOne.json() as EditorPageDocument;
      assert.equal(pageOneBody.page.returnedCount, 1);
      assert.equal(pageOneBody.page.hasMore, true);
      assert.ok(pageOneBody.page.nextCursor);
      const pageTwo = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.collection.id}/editor?cursor=${encodeURIComponent(pageOneBody.page.nextCursor)}`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(pageTwo.statusCode, 200);
      const pageTwoBody = pageTwo.json() as EditorPageDocument;
      assert.ok(pageTwoBody.nodes.length >= 1);
      assert.equal(
        new Set([...pageOneBody.nodes, ...pageTwoBody.nodes].map((node) => node.id)).size,
        pageOneBody.nodes.length + pageTwoBody.nodes.length,
      );

      const concealed = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.collection.id}/editor`,
        headers: { cookie: stranger.cookie },
      });
      assertProductError(concealed, 404, 'resource_not_found');

      const missingPrecondition = await app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${collection.collection.id}/nodes/${bookmarkBody.node.id}`,
        headers: mutationHeaders(owner, COMMAND.missingPrecondition, 'application/merge-patch+json'),
        payload: { title: 'Missing precondition' },
      });
      assertProductError(missingPrecondition, 428, 'precondition_required');

      const moved = await app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes/${bookmarkBody.node.id}/move`,
        headers: {
          ...mutationHeaders(owner, COMMAND.bookmarkMove),
          'if-match': bookmarkUpdatedBody.node.etag,
        },
        payload: {
          newParentId: folderBody.node.id,
          afterId: null,
          beforeId: null,
          baseSourceParentRevision: bookmarkBody.parent.childrenRevision,
          baseTargetParentRevision: folderBody.node.childrenRevision!,
        },
      });
      assert.equal(moved.statusCode, 200);
      const movedBody = moved.json() as {
        node: NodeDocument['node']; targetParent: { childrenRevision: string };
        fence: NodeDocument['fence'];
      };

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${collection.collection.id}/nodes/${bookmarkBody.node.id}?recursive=false`,
        headers: {
          ...mutationHeaders(owner, COMMAND.bookmarkDelete, null),
          'if-match': movedBody.node.etag,
        },
      });
      assert.equal(deleted.statusCode, 200);

      worker = composeProjectionWorker();
      assert.ok(worker.projectionSink instanceof PostgresCollectionMutationProjectionSink);
      await drainOutbox(worker);
      const delivered = await runtime.pool.query<{
        pending: string;
        completed: string;
        projection_completed: string;
        social_completed: string;
        projection_rows: string;
      }>(
        `select
           count(*) filter (where state <> 'completed')::text as pending,
           count(*) filter (where state = 'completed')::text as completed,
           count(*) filter (where state = 'completed' and handler_name not in ($1, $2))::text
             as projection_completed,
           count(*) filter (where state = 'completed' and handler_name = $1)::text
             as social_completed,
           (select count(*)::text from collection_mutation_projection_applied) as projection_rows
         from outbox_events`,
        [SOCIAL_COLLECTION_CHANGE_HANDLER_NAME, SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME],
      );
      assert.equal(delivered.rows[0]?.pending, '0');
      assert.ok(BigInt(delivered.rows[0]?.completed ?? '0') >= 7n);
      assert.equal(delivered.rows[0]?.projection_rows, delivered.rows[0]?.projection_completed);
      assert.equal(delivered.rows[0]?.social_completed, delivered.rows[0]?.projection_completed);

      await app.close();
      primaryAppClosed = true;
      await worker.stop();
      worker = undefined;
      restartedApp = composeApp();

      const restartedCollection = await restartedApp.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: mutationHeaders(owner, COMMAND.restartedCollectionCreate),
        payload: {
          kind: 'bookmarks',
          title: 'Created after restart',
          summary: 'must be processed by the restarted worker',
        },
      });
      assert.equal(restartedCollection.statusCode, 201);
      const restartedCollectionBody = restartedCollection.json() as CollectionDocument;
      const pendingAfterRestart = await runtime.pool.query<{ state: string }>(
        'select state from outbox_events where aggregate_id = $1',
        [restartedCollectionBody.collection.id],
      );
      assert.deepEqual(
        pendingAfterRestart.rows.map((row) => row.state),
        ['pending', 'pending', 'pending'],
      );

      restartedWorker = composeProjectionWorker();
      assert.ok(restartedWorker.projectionSink instanceof PostgresCollectionMutationProjectionSink);
      await drainOutbox(restartedWorker);

      const completedAfterRestart = await runtime.pool.query<{ state: string }>(
        'select state from outbox_events where aggregate_id = $1',
        [restartedCollectionBody.collection.id],
      );
      assert.deepEqual(
        completedAfterRestart.rows.map((row) => row.state),
        ['completed', 'completed', 'completed'],
      );
      const projectedAfterRestart = await restartedWorker.projectionSink.repository.getResource(
        restartedCollectionBody.collection.id,
        'collection',
        restartedCollectionBody.collection.id,
      );
      assert.ok(projectedAfterRestart);
      assert.equal(projectedAfterRestart.deleted, false);

      const persistedSession = await restartedApp.inject({
        method: 'GET',
        url: '/api/v1/session',
        headers: { cookie: owner.cookie },
      });
      assert.equal(persistedSession.statusCode, 200);
      assert.equal((persistedSession.json() as { authenticated: boolean }).authenticated, true);

      const persistedEditor = await restartedApp.inject({
        method: 'GET',
        url: `/api/v1/collections/${collection.collection.id}/editor`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(persistedEditor.statusCode, 200);
      const persistedBody = persistedEditor.json() as EditorPageDocument;
      assert.equal(persistedBody.collection.title, 'Black-box collection updated');
      assert.equal(persistedBody.nodes.some((node) => node.id === bookmarkBody.node.id), false);
      assert.equal(persistedBody.nodes.some((node) => node.id === folderBody.node.id), true);

      const persistedReceipt = await restartedApp.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: mutationHeaders(owner, COMMAND.collectionCreate),
        payload: createPayload,
      });
      assert.equal(persistedReceipt.statusCode, created.statusCode);
      assert.equal(persistedReceipt.body, created.body);

      const persistedProjection = await runtime.pool.query<{
        resource_type: string; resource_id: string; deleted: boolean; state_json: unknown;
      }>(
        `select resource_type, resource_id, deleted, state_json
         from collection_mutation_projection_resources
         where collection_id = $1 order by resource_type, resource_id`,
        [collection.collection.id],
      );
      const projectedCollection = persistedProjection.rows.find(
        (row) => row.resource_type === 'collection' && row.resource_id === collection.collection.id,
      );
      const projectedBookmark = persistedProjection.rows.find(
        (row) => row.resource_type === 'node' && row.resource_id === bookmarkBody.node.id,
      );
      assert.ok(projectedCollection);
      assert.equal(
        (projectedCollection.state_json as { title: string }).title,
        updatedCollection.collection.title,
      );
      assert.ok(projectedBookmark);
      assert.equal(projectedBookmark.deleted, true);
    } finally {
      await worker?.stop();
      await restartedWorker?.stop();
      await restartedApp?.close();
      if (!primaryAppClosed) await app.close();
    }
  }, 30_000);

  test('OIDC /me advertises only its persisted handle and the empty public Profile resolves', async () => {
    const app = composeApp();
    try {
      const client = await logIn(app, 'no-preferred-username-profile');
      const meResponse = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: client.cookie } });
      assert.equal(meResponse.statusCode, 200);
      const me = meResponse.json() as { profile: { handle: string; displayName: string } };
      assert.match(me.profile.handle, /^[a-z0-9._~-]{1,64}$/u);
      assert.equal(me.profile.handle.includes('no-preferred-username-profile'), false);

      const profileResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/profiles/${encodeURIComponent(me.profile.handle)}`,
      });
      assert.equal(profileResponse.statusCode, 200);
      const profile = profileResponse.json() as {
        profile: { handle: string; displayName: string };
        collections: unknown[];
      };
      assert.equal(profile.profile.handle, me.profile.handle);
      assert.equal(profile.profile.displayName, me.profile.displayName);
      assert.deepEqual(profile.collections, []);
    } finally {
      await app.close();
    }
  }, 30_000);

  test('concurrent OIDC login converges on one handle and failed profile rename rolls back', async () => {
    const app = composeApp();
    try {
      const [first, second] = await Promise.all([
        logIn(app, 'concurrent-profile-user'),
        logIn(app, 'concurrent-profile-user'),
      ]);
      const rows = await runtime.pool.query<{ account_id: string; handle: string }>(`
        select a.id as account_id, h.handle
          from accounts a
          join auth_user_account_map m on m.account_id = a.id
          join auth_users u on u.id = m.auth_user_id
          join profile_handles h on h.account_id = a.id
         where u.email = $1
      `, ['concurrent-profile-user@example.test']);
      assert.equal(rows.rows.length, 1);

      const meResponses = await Promise.all([first, second].map((client) => app.inject({
        method: 'GET', url: '/api/v1/me', headers: { cookie: client.cookie },
      })));
      for (const response of meResponses) {
        assert.equal(response.statusCode, 200);
        assert.equal((response.json() as { profile: { handle: string } }).profile.handle, rows.rows[0]!.handle);
      }

      const rejected = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: mutationHeaders(first, '10000000-0000-4000-8000-000000000011'),
        payload: { handle: 'rename_must_rollback', displayName: '' },
      });
      assertProductError(rejected, 422, 'invalid_display_name');
      const after = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: first.cookie } });
      assert.equal(after.statusCode, 200);
      assert.equal((after.json() as { profile: { handle: string } }).profile.handle, rows.rows[0]!.handle);
      assert.equal(await runtime.pool.query(
        `select 1 from profile_handles where handle = 'rename_must_rollback'`,
      ).then((result) => result.rowCount), 0);
    } finally {
      await app.close();
    }
  }, 30_000);

  test('serves anonymous public Profile GET, HEAD, and conditional GET over real HTTP and PostgreSQL', async () => {
    const app = composeApp();
    try {
      await logIn(app, 'public-profile-black-box');
      const identity = await runtime.pool.query<{ account_id: string; subject_id: string }>(
        `select a.id as account_id, a.subject_id
           from accounts a
           join auth_user_account_map m on m.account_id = a.id
           join auth_users u on u.id = m.auth_user_id
          where u.email = $1`,
        ['public-profile-black-box@example.test'],
      );
      const account = identity.rows[0];
      assert.ok(account);
      const claimed = await createPostgresIdentityUnitOfWork(runtime.db, {
        oidcTransactionSecrets: config.oidcTransactionSecrets,
      }).execute((ports) => claimHandle(ports, {
        accountId: account.account_id,
        handle: 'public.profile~black-box',
      }));
      const row = { ...account, handle: claimed.handle };
      await runtime.pool.query(
        `update profiles set display_name = 'Public Profile',
            avatar_url = 'https://cdn.example.test/profile.png',
            about = 'I collect bookmarks.'
          where account_id = $1`,
        [row.account_id],
      );
      const client = await runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query('set constraints all deferred');
        await client.query(
          `insert into resource_id_ledger(resource_id, resource_type)
           values ('profile-http-collection', 'collection'), ('profile-http-root', 'node')`,
        );
        await client.query(
          `insert into collections
             (id, owner_subject_id, title, summary, kind, visibility, root_node_id,
              resource_revision, content_revision, policy_revision, publication_slug, published_at, updated_at)
           values
             ('profile-http-collection', $1, 'Profile collection', null, 'bookmarks', 'public',
              'profile-http-root', 'r1', 'c1', 'p1', 'profile-http-collection', current_timestamp, current_timestamp)`,
          [row.subject_id],
        );
        await client.query(
          `insert into nodes
             (id, collection_id, kind, is_root, title, resource_revision, children_revision)
           values ('profile-http-root', 'profile-http-collection', 'folder', true, 'Profile collection', 'r1', 'ch1')`,
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const url = `${origin}/api/v1/profiles/${encodeURIComponent(row.handle)}?limit=20`;
      const get = await fetch(url, { headers: { accept: 'application/json' } });
      assert.equal(get.status, 200);
      const bytes = Buffer.from(await get.arrayBuffer());
      const etag = get.headers.get('etag');
      assert.ok(etag);
      assert.equal(
        etag,
        `"sha256-${createHash('sha256').update('known-product-profile\n1.2.0\napplication/json\n').update(bytes).digest('base64url')}"`,
      );
      const document = JSON.parse(bytes.toString('utf8')) as {
        profile: { handle: string; displayName: string };
        collections: ReadonlyArray<{ id: string }>;
      };
      assert.deepEqual(document.profile, {
        profileId: row.account_id,
        handle: row.handle,
        displayName: 'Public Profile',
        avatarUrl: 'https://cdn.example.test/profile.png',
        about: 'I collect bookmarks.',
      });
      assert.deepEqual(document.collections.map((collection) => collection.id), ['profile-http-collection']);

      const head = await fetch(url, { method: 'HEAD', headers: { accept: 'application/json' } });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      assert.equal(head.headers.get('etag'), etag);
      assert.equal(head.headers.get('content-length'), String(bytes.byteLength));

      const notModified = await fetch(url, { headers: { accept: 'application/json', 'if-none-match': etag } });
      assert.equal(notModified.status, 304);
      assert.equal(await notModified.text(), '');
      assert.equal(notModified.headers.get('etag'), etag);
    } finally {
      await app.close();
    }
  }, 30_000);
});

function assertProductError(
  response: { readonly statusCode: number; json(): unknown },
  statusCode: number,
  code: string,
): void {
  assert.equal(response.statusCode, statusCode);
  assert.equal((response.json() as { error: { code: string } }).error.code, code);
}
