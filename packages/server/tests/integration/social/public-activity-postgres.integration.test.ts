import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresFollowCommandUnitOfWork,
  createPostgresFollowQueryUnitOfWork,
  createPostgresPublicActivityQueryUnitOfWork,
} from '../../../src/infrastructure/social/index.js';
import {
  createFeedCursorKeyring,
  createFollowCursorKeyring,
  createPublicActivityCursorKeyring,
  FEED_CURSOR_PURPOSE,
  FEED_CURSOR_TTL_MS,
  queryCurrentPublicActivity,
} from '../../../src/modules/social/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryPublicActivityLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  authenticatedMutationHeaders,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const ISSUER = 'https://issuer.example.test/realms/known';
const SECRET_TITLE = 'PA01-SECRET-TITLE-NEVER-LEAK';
const SECOND_TITLE = 'PA01-SECOND-PUBLIC-TITLE';
const HANDLE = 'pa01-owner';
const FOLLOWER_HANDLE = 'pa01-follower';

type ApiApp = ReturnType<typeof buildApiApp>;
type WorkerRuntime = ReturnType<typeof buildWorker>;

describeWithPostgres('PA-01 public Profile collection-change activity', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let worker: WorkerRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('pa01_public_activity');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
    worker = buildWorker(workerConfig(), isolated.runtime);
    assert.ok(worker.outbox);
  }, 120_000);

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table publisher_idempotency, product_command_receipts,
      outbox_events, audit_events, operations, policy_revisions, content_revisions,
      children_revisions, resource_revisions, collection_policies, collection_members,
      nodes, collections, resource_id_ledger, oidc_login_transactions, sessions,
      follows, social_feed_items, social_public_activity, social_feed_watermarks,
      notifications, notification_deliveries, notification_preferences,
      account_identities, profile_handles, profiles, accounts,
      known_auth_session_metadata, "auth_sessions", "auth_accounts", "auth_users",
      auth_user_account_map cascade`);
  });

  afterAll(async () => isolated?.close());

  function baseEnv(): Record<string, string> {
    return {
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
      KNOWN_FEATURE_FOLLOW: 'true',
      KNOWN_FEATURE_FEED: 'true',
    };
  }

  function config() {
    return loadConfig(baseEnv());
  }

  function workerConfig() {
    return loadConfig({
      ...baseEnv(),
      WORKER_CONCURRENCY: '1',
      WORKER_BATCH_SIZE: '1',
      WORKER_POLL_INTERVAL_MS: '5',
    });
  }

  async function drain(limit = 80): Promise<void> {
    assert.ok(worker.outbox);
    for (let index = 0; index < limit; index += 1) {
      await runtime.pool.query(`update outbox_events set available_at=current_timestamp
        where state='retryable'`);
      if (!await worker.outbox.runOnce()) return;
    }
    throw new Error('PA-01 worker drain exceeded its bounded test budget');
  }

  async function ownerClient(): Promise<AuthenticatedTestClient> {
    return issueTestSession({
      factory,
      subject: 'pa01-activity-owner',
      handle: HANDLE,
      displayName: 'PA-01 Owner',
    });
  }

  async function followerClient(): Promise<AuthenticatedTestClient> {
    return issueTestSession({
      factory,
      subject: 'pa01-activity-follower',
      handle: FOLLOWER_HANDLE,
      displayName: 'PA-01 Follower',
    });
  }

  function app(): {
    readonly application: ApiApp;
    readonly destroy: () => void;
  } {
    const loaded = config();
    const followCursors = createFollowCursorKeyring(loaded.follow!.cursorKeys);
    const activityCursors = createPublicActivityCursorKeyring(loaded.publicActivity.cursorKeys);
    const activityUoW = createPostgresPublicActivityQueryUnitOfWork(runtime, activityCursors);
    const application = buildApiApp({
      config: loaded,
      publicActivityRateLimiter: memoryPublicActivityLimiter(),
      identityUnitOfWork: createPostgresIdentityUnitOfWork(runtime.db),
      browserSessionAuthority: factory.authority,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      followCommandUnitOfWork: createPostgresFollowCommandUnitOfWork(runtime.db),
      followQueryUnitOfWork: createPostgresFollowQueryUnitOfWork(runtime.db, followCursors),
      publicActivityQuery: {
        get: (input) => activityUoW.execute((ports) => queryCurrentPublicActivity(ports, input)),
      },
    });
    return {
      application,
      destroy() {
        followCursors.destroy();
        activityCursors.destroy();
      },
    };
  }

  function headers(client: AuthenticatedTestClient, commandId: string, contentType: string) {
    return authenticatedMutationHeaders({
      client,
      origin: ORIGIN,
      contentType,
      extra: { 'known-command-id': commandId },
    });
  }

  async function createCollection(application: ApiApp, owner: AuthenticatedTestClient, title: string) {
    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: headers(owner, randomUUID(), 'application/json'),
      payload: { kind: 'bookmarks', title, summary: 'pa01 summary' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as { collection: { id: string; etag: string } };
  }

  async function patchCollection(
    application: ApiApp,
    owner: AuthenticatedTestClient,
    collection: { id: string; etag: string },
    patch: Record<string, unknown>,
  ) {
    const response = await application.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collection.id}`,
      headers: {
        ...headers(owner, randomUUID(), 'application/merge-patch+json'),
        'if-match': collection.etag,
      },
      payload: patch,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { collection: { id: string; etag: string } };
  }

  async function follow(application: ApiApp, actor: AuthenticatedTestClient, targetProfileId: string) {
    const response = await application.inject({
      method: 'PUT',
      url: `/api/v1/profiles/${targetProfileId}/follow`,
      headers: {
        cookie: actor.cookie,
        origin: ORIGIN,
        'x-csrf-token': actor.csrfToken,
        'known-command-id': randomUUID(),
      },
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  async function unfollow(application: ApiApp, actor: AuthenticatedTestClient, targetProfileId: string) {
    const response = await application.inject({
      method: 'DELETE',
      url: `/api/v1/profiles/${targetProfileId}/follow`,
      headers: {
        cookie: actor.cookie,
        origin: ORIGIN,
        'x-csrf-token': actor.csrfToken,
        'known-command-id': randomUUID(),
      },
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  async function getActivity(application: ApiApp, handle: string, query = '') {
    return application.inject({
      method: 'GET',
      url: `/api/v1/profiles/${handle}/activity${query}`,
    });
  }

  test('public mutation drains to Activity with title and slug while zero followers stay out of Feed', async () => {
    const owner = await ownerClient();
    const harness = app();
    try {
      const created = await createCollection(harness.application, owner, SECRET_TITLE);
      const published = await patchCollection(harness.application, owner, created.collection, {
        visibility: 'public', publicationSlug: 'pa01-public',
      });
      await drain();
      const response = await getActivity(harness.application, HANDLE);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'public, max-age=60');
      const page = response.json() as {
        items: Array<{
          activityId: string; kind: string; collectionId: string;
          collectionTitle: string | null; publicationSlug: string | null;
          publishedAt: string; summary: string | null;
        }>;
        nextCursor: string | null;
      };
      assert.equal(page.items.length, 1);
      assert.deepEqual(Object.keys(page.items[0]!).sort(), [
        'activityId', 'collectionId', 'collectionTitle', 'kind', 'publicationSlug', 'publishedAt', 'summary',
      ]);
      assert.equal(page.items[0]!.kind, 'collection_change');
      assert.equal(page.items[0]!.collectionId, published.collection.id);
      assert.equal(page.items[0]!.collectionTitle, SECRET_TITLE);
      assert.equal(page.items[0]!.publicationSlug, 'pa01-public');
      assert.equal(page.items[0]!.summary, 'public_collection_updated');
      assert.doesNotMatch(JSON.stringify(page.items), /"details"|nodeIds/u);
      assert.equal(
        Number((await runtime.pool.query<{ count: string }>(
          'select count(*)::text count from social_feed_items where actor_profile_id = $1',
          [owner.accountId],
        )).rows[0]!.count),
        0,
      );
      assert.equal(
        Number((await runtime.pool.query<{ count: string }>(
          'select count(*)::text count from social_public_activity where actor_profile_id = $1',
          [owner.accountId],
        )).rows[0]!.count) > 0,
        true,
      );
    } finally {
      await harness.application.close();
      harness.destroy();
    }
  });

  test('unfollow may withdraw Feed rows while public Activity remains', async () => {
    const owner = await ownerClient();
    const follower = await followerClient();
    const harness = app();
    try {
      await follow(harness.application, follower, owner.accountId);
      const created = await createCollection(harness.application, owner, SECRET_TITLE);
      await patchCollection(harness.application, owner, created.collection, {
        visibility: 'public', publicationSlug: 'pa01-followed',
      });
      await drain();
      const beforeUnfollow = Number((await runtime.pool.query<{ count: string }>(
        `select count(*)::text count from social_feed_items
          where actor_profile_id = $1 and recipient_profile_id = $2 and state = 'visible'`,
        [owner.accountId, follower.accountId],
      )).rows[0]!.count);
      assert.ok(beforeUnfollow >= 1);
      await unfollow(harness.application, follower, owner.accountId);
      await drain();
      const afterUnfollow = Number((await runtime.pool.query<{ count: string }>(
        `select count(*)::text count from social_feed_items
          where actor_profile_id = $1 and recipient_profile_id = $2 and state = 'visible'`,
        [owner.accountId, follower.accountId],
      )).rows[0]!.count);
      assert.equal(afterUnfollow, 0);
      const activity = await getActivity(harness.application, HANDLE);
      assert.equal(activity.statusCode, 200, activity.body);
      const page = activity.json() as { items: Array<{ collectionTitle: string | null }> };
      assert.equal(page.items.length >= 1, true);
      assert.equal(page.items[0]!.collectionTitle, SECRET_TITLE);
    } finally {
      await harness.application.close();
      harness.destroy();
    }
  });

  test('two successive public mutations keep two Activity rows with distinct ids', async () => {
    const owner = await ownerClient();
    const harness = app();
    try {
      const created = await createCollection(harness.application, owner, SECRET_TITLE);
      const published = await patchCollection(harness.application, owner, created.collection, {
        visibility: 'public', publicationSlug: 'pa01-twice',
      });
      await drain();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await patchCollection(harness.application, owner, published.collection, { title: SECOND_TITLE });
      await drain();
      const response = await getActivity(harness.application, HANDLE);
      assert.equal(response.statusCode, 200, response.body);
      const page = response.json() as {
        items: Array<{ activityId: string; publishedAt: string; collectionTitle: string | null }>;
      };
      assert.equal(page.items.length, 2);
      assert.notEqual(page.items[0]!.activityId, page.items[1]!.activityId);
      assert.notEqual(page.items[0]!.publishedAt, page.items[1]!.publishedAt);
      assert.equal(new Set(page.items.map((item) => item.collectionTitle)).has(SECOND_TITLE), true);
    } finally {
      await harness.application.close();
      harness.destroy();
    }
  });

  test('private mutation hides the row and does not leak the title', async () => {
    const owner = await ownerClient();
    const harness = app();
    try {
      const created = await createCollection(harness.application, owner, SECRET_TITLE);
      const published = await patchCollection(harness.application, owner, created.collection, {
        visibility: 'public', publicationSlug: 'pa01-private',
      });
      await drain();
      await patchCollection(harness.application, owner, published.collection, { visibility: 'private' });
      await drain();
      const response = await getActivity(harness.application, HANDLE);
      assert.equal(response.statusCode, 200, response.body);
      const body = response.body;
      assert.equal(body.includes(SECRET_TITLE), false);
      const page = response.json() as { items: unknown[] };
      assert.equal(page.items.length, 0);
      assert.equal(JSON.stringify(page).includes(SECRET_TITLE), false);
    } finally {
      await harness.application.close();
      harness.destroy();
    }
  });

  test('Activity cursor pages without duplicates and rejects Feed or tampered cursors', async () => {
    const owner = await ownerClient();
    const harness = app();
    try {
      const created = await createCollection(harness.application, owner, SECRET_TITLE);
      const published = await patchCollection(harness.application, owner, created.collection, {
        visibility: 'public', publicationSlug: 'pa01-cursor',
      });
      await drain();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await patchCollection(harness.application, owner, published.collection, { title: SECOND_TITLE });
      await drain();
      const first = await getActivity(harness.application, HANDLE, '?limit=1');
      assert.equal(first.statusCode, 200, first.body);
      const firstPage = first.json() as { items: Array<{ activityId: string }>; nextCursor: string | null };
      assert.equal(firstPage.items.length, 1);
      assert.equal(typeof firstPage.nextCursor, 'string');
      const second = await getActivity(harness.application, HANDLE, `?cursor=${encodeURIComponent(firstPage.nextCursor!)}`);
      assert.equal(second.statusCode, 200, second.body);
      const secondPage = second.json() as { items: Array<{ activityId: string }> };
      assert.equal(secondPage.items.length, 1);
      assert.notEqual(secondPage.items[0]!.activityId, firstPage.items[0]!.activityId);
      const tampered = `${firstPage.nextCursor!.slice(0, -1)}x`;
      const invalid = await getActivity(harness.application, HANDLE, `?cursor=${encodeURIComponent(tampered)}`);
      assert.equal(invalid.statusCode, 400, invalid.body);
      assert.equal(invalid.json().error.code, 'invalid_cursor');
      const loaded = config();
      const feedCursors = createFeedCursorKeyring(loaded.feed!.cursorKeys);
      try {
        const now = new Date();
        const feedCursor = feedCursors.feed.seal({
          v: 1,
          purpose: FEED_CURSOR_PURPOSE,
          principalId: owner.accountId,
          filter: '',
          limit: 1,
          comparatorVersion: 1,
          after: {
            publishedAt: now.toISOString(),
            sourceEventId: owner.accountId,
            feedItemId: owner.accountId,
          },
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + FEED_CURSOR_TTL_MS).toISOString(),
        });
        const foreign = await getActivity(harness.application, HANDLE, `?cursor=${encodeURIComponent(feedCursor)}`);
        assert.equal(foreign.statusCode, 400, foreign.body);
        assert.equal(foreign.json().error.code, 'invalid_cursor');
      } finally {
        feedCursors.destroy();
      }
    } finally {
      await harness.application.close();
      harness.destroy();
    }
  });

  test('unknown handle is resource_not_found like public Profile', async () => {
    const owner = await ownerClient();
    const harness = app();
    try {
      const response = await getActivity(harness.application, 'no-such-pa01-handle');
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.json().error.code, 'resource_not_found');
      const encoded = await getActivity(harness.application, 'pa01%25owner');
      assert.equal(encoded.statusCode, 404, encoded.body);
      assert.equal(encoded.json().error.code, 'resource_not_found');
    } finally {
      await harness.application.close();
      harness.destroy();
    }
  });
});
