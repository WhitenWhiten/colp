import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { composeProfileSitemapQuery, composePublicProfileProjection } from '../../../src/bootstrap/public-profile-projection.js';
import {
  createPostgresSharedExposureFactsPort,
  runMigrations,
  type DatabaseRuntime,
} from '../../../src/infrastructure/database/index.js';
import {
  createPersistentAvatarStore,
  createPostgresExploreCreatorsQueryPort,
  createPostgresIdentityUnitOfWork,
  createPostgresPublicProfileFactsReadPort,
} from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresCatalogPreferencesQuery,
  createPostgresCatalogPreferencesUnitOfWork,
} from '../../../src/infrastructure/governance/postgres-catalog-preferences.js';
import {
  createPostgresModerationActionMethods,
} from '../../../src/infrastructure/governance/postgres-moderation-actions.js';
import {
  createPostgresModerationCommandUnitOfWork,
  createPostgresModerationQueryPorts,
} from '../../../src/infrastructure/governance/postgres-moderation.js';
import { createPostgresModerationRoleUnitOfWork } from '../../../src/infrastructure/governance/postgres-moderation-roles.js';
import {
  createPostgresExplorePageReadPort,
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationSnapshotReadPort,
  createPostgresProductPublicCollectionLocatorReadPort,
  createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicMarksReadPort,
  createPostgresProfileSitemapReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createWebShellCache } from '../../../src/infrastructure/http/index.js';
import {
  createPostgresSearchAuthorityPort,
  createPostgresSearchCandidatePort,
} from '../../../src/infrastructure/search/index.js';
import {
  createPostgresCollectionFollowCommandUnitOfWork,
  createPostgresCollectionFollowQueryUnitOfWork,
  createPostgresFeedQueryUnitOfWork,
  createPostgresFollowCommandUnitOfWork,
  createPostgresFollowQueryUnitOfWork,
  createPostgresPublicActivityQueryUnitOfWork,
} from '../../../src/infrastructure/social/index.js';
import { GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME } from '../../../src/infrastructure/governance/postgres-moderation-outbox.js';
import { grantModerationRole } from '../../../src/modules/governance/application/moderation-roles.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import {
  createSearchCursorSigner,
  executeSearchQuery,
} from '../../../src/modules/search/index.js';
import {
  createFeedCursorKeyring,
  createFollowCursorKeyring,
  createFollowedCollectionsCursorKeyring,
  createPublicActivityCursorKeyring,
  queryCurrentPublicActivity,
} from '../../../src/modules/social/index.js';
import { PUBLIC_SHELL_FIXTURE } from '../../unit/publication/public-shell-fixture.js';
import {
  createSession,
  ensureAccountFromOidcIdentity,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { SESSION_COOKIE_NAME } from '../../../src/transport/session-cookie.js';
import {
  memoryExploreDirectoryLimiter,
  memoryPublicActivityLimiter,
} from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const HMAC = Buffer.alloc(32, 19).toString('base64url');
const CURSOR_KEY = { id: 'cg06-a', secret: Buffer.alloc(32, 23).toString('base64') };
const FOLLOW_SECRET = Buffer.alloc(32, 29).toString('base64');
const COLLECTION_FOLLOW_SECRET = Buffer.alloc(32, 31).toString('base64');
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
);

/** Actual account exits covered by this suite. Empty cells are not N/A. */
export const ACCOUNT_CONTROL_SURFACES = Object.freeze([
  { url: 'GET/HEAD /api/v1/profiles/{handle}', media: 'json', control: 'restrict_publication 404 before body/304', permission: 'anonymous' },
  { url: 'GET/HEAD /u/{handle}', media: 'html/md', control: 'restrict_publication via same projection', permission: 'anonymous' },
  { url: 'GET /api/v1/avatar/{avatarId}', media: 'image', control: 'origin restrict_publication before body', permission: 'anonymous object' },
  { url: 'GET /api/v1/explore/collections', media: 'json creators', control: 'restrict_publication redacts creator', permission: 'anonymous discovery' },
  { url: 'GET /api/v1/feed', media: 'json', control: 'restrict_publication omits actor items', permission: 'follower' },
  { url: 'PUT /api/v1/profiles/{id}/follow', media: 'json', control: 'restrict_interaction on old session', permission: 'restricted actor' },
  { url: 'PUT /api/v1/collections/{id}/follow', media: 'json', control: 'restrict_interaction on actor lock', permission: 'restricted actor' },
  { url: 'PATCH /api/v1/collections/{id} visibility=public', media: 'json', control: 'restrict_publication denies new publish', permission: 'owner' },
  { url: 'GET /sitemap-profiles.xml', media: 'xml', control: 'restrict_publication omits handle', permission: 'anonymous' },
  { url: 'GET /api/v1/profiles/{handle}/activity', media: 'json', control: 'restrict_publication 404', permission: 'anonymous' },
  { url: 'GET /api/v1/search?type=profile', media: 'json', control: 'restrict_publication omits profile', permission: 'anonymous' },
] as const);

type ApiApp = ReturnType<typeof buildApiApp>;
interface Client {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly subjectId: string;
}

describeWithPostgres('CG-06 account restrict_interaction/restrict_publication', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('moderation_cg06');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  }, 120_000);

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table moderation_actions, moderation_evidence, moderation_cases, moderation_roles,
      catalog_preferences, product_command_receipts, outbox_events, audit_events,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, nodes, collections, resource_id_ledger,
      follows, collection_follows, social_feed_items, social_public_activity,
      oidc_login_transactions, sessions, account_identities,
      profile_handles, profiles, accounts cascade`);
  });

  afterAll(async () => isolated?.close());

  async function harness(): Promise<{
    app: ApiApp;
    owner: Client;
    follower: Client;
    moderator: Client;
    avatarStore: {
      put(id: string, body: Buffer, contentType: string, accountId?: string): Promise<void>;
      get(id: string): Promise<{ contentType: string; body: Buffer } | null>;
    };
  }> {
    const config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN,
      PUBLICATION_ORIGIN: ORIGIN,
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
      KNOWN_FEATURE_CONTENT_GOVERNANCE: 'true',
      KNOWN_FEATURE_FOLLOW: 'true',
      KNOWN_FEATURE_FEED: 'true',
      KNOWN_FEATURE_COLLECTION_FOLLOW: 'true',
      KNOWN_FEATURE_PUBLIC_PROFILE_SHELL: 'true',
      WEB_SHELL_ORIGIN: 'http://web:80',
      FOLLOW_CURSOR_ACTIVE_KEY_ID: 'cg06-follow',
      FOLLOW_CURSOR_ACTIVE_SECRET: FOLLOW_SECRET,
      FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'cg06-cfollow',
      FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: COLLECTION_FOLLOW_SECRET,
      GOVERNANCE_CURSOR_HMAC_KEY: HMAC,
    });
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db);
    const owner = await issueSession(identityUnitOfWork, {
      subject: 'cg06-owner', email: 'owner@example.test', handle: 'cg06owner',
    });
    const follower = await issueSession(identityUnitOfWork, {
      subject: 'cg06-follow', email: 'follow@example.test', handle: 'cg06follow',
    });
    const moderator = await issueSession(identityUnitOfWork, {
      subject: 'cg06-mod', email: 'mod@example.test', handle: 'cg06mod',
    });
    const cursors = createPublicationCursorKeyring({ active: CURSOR_KEY, retained: [] });
    const followCursors = createFollowCursorKeyring(config.follow!.cursorKeys);
    const feedCursors = createFeedCursorKeyring(config.feed!.cursorKeys);
    const activityCursors = createPublicActivityCursorKeyring(config.publicActivity.cursorKeys);
    const followedCursors = createFollowedCollectionsCursorKeyring(config.collectionFollow.cursorKeys);
    const collectionControl = createPostgresModerationActionMethods(runtime.db);
    const directoryReads = createPostgresPublicationDirectoryReadPort(runtime);
    const sharedExposure = createPostgresSharedExposureFactsPort(runtime);
    const profileFacts = createPostgresPublicProfileFactsReadPort(runtime);
    const snapshotQuery = {
      reads: createPostgresPublicationSnapshotReadPort(runtime),
      accessPolicy: createPostgresAccessPolicyFactsPort(runtime.db),
      cursors,
      origin: config.publication.origin,
      sharedExposure,
      collectionControl,
    };
    const avatarObjects = new Map<string, { contentType: string; body: Buffer }>();
    // Production wraps the provider store in src/bootstrap/api.ts so that
    // avatar_objects carries the uploader attribution the
    // profile_avatar_upload_authority trigger requires; this harness must too.
    const avatarStore = createPersistentAvatarStore(runtime.db, {
      async put(id: string, body: Buffer, contentType: string) {
        avatarObjects.set(id, { contentType, body: Buffer.from(body) });
      },
      async get(id: string) { return avatarObjects.get(id) ?? null; },
      async delete(id: string) { avatarObjects.delete(id); },
    });
    const app = buildApiApp({
      config,
      identityUnitOfWork,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      moderationCommandUnitOfWork: createPostgresModerationCommandUnitOfWork(runtime.db),
      moderationQueryPorts: createPostgresModerationQueryPorts(runtime.db),
      explorePageQuery: createPostgresExplorePageReadPort(runtime),
      exploreCreatorsQuery: createPostgresExploreCreatorsQueryPort(runtime.db),
      catalogPreferencesUnitOfWork: createPostgresCatalogPreferencesUnitOfWork(runtime.db),
      catalogPreferencesQuery: createPostgresCatalogPreferencesQuery(runtime.db),
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      searchRateLimiter: memoryExploreDirectoryLimiter(),
      publicActivityRateLimiter: memoryPublicActivityLimiter(),
      followCommandUnitOfWork: createPostgresFollowCommandUnitOfWork(runtime.db),
      followQueryUnitOfWork: createPostgresFollowQueryUnitOfWork(runtime.db, followCursors),
      collectionFollowCommandUnitOfWork: createPostgresCollectionFollowCommandUnitOfWork(runtime.db),
      collectionFollowQueryUnitOfWork: createPostgresCollectionFollowQueryUnitOfWork(
        runtime.db,
        followedCursors,
      ),
      feedQueryUnitOfWork: createPostgresFeedQueryUnitOfWork(runtime, feedCursors),
      publicActivityQuery: {
        get: (input) => createPostgresPublicActivityQueryUnitOfWork(runtime, activityCursors)
          .execute((ports) => queryCurrentPublicActivity(ports, input)),
      },
      searchQuery: {
        execute: (input) => executeSearchQuery({
          candidates: createPostgresSearchCandidatePort(runtime.db),
          authority: createPostgresSearchAuthorityPort(runtime.db),
          cursors: createSearchCursorSigner({
            current: { id: 'cg06-search', key: 'cg06-search-cursor-secret-material' },
          }),
          clock: { now: () => new Date() },
          sharedExposure,
        }, input),
      },
      publicShell: {
        cache: createWebShellCache({
          origin: 'http://web:80',
          fetch: async () => new Response(PUBLIC_SHELL_FIXTURE, {
            status: 200, headers: { etag: '"shell"' },
          }),
        }),
        loadNodeCountBySlug: async () => 0,
        loadOwnerDisplayName: async () => 'Owner',
      },
      avatarStore,
      avatarPublicAccess: {
        isPublicationRestricted: (objectId) => collectionControl.isAvatarPublicationRestricted(objectId),
      },
      publicationMetadataQuery: {
        reads: createPostgresPublicationMetadataReadPort(runtime),
        origin: config.publication.origin,
        collectionControl,
      },
      publicationSnapshotQuery: snapshotQuery,
      productPublicCollectionQuery: {
        locators: createPostgresProductPublicCollectionLocatorReadPort(runtime),
        viewCounts: createPostgresProductPublicCollectionViewCountReadPort(runtime),
        cursors,
        owners: profileFacts,
        snapshot: snapshotQuery,
        publicMarks: createPostgresPublicMarksReadPort(runtime),
      },
      publicProfileQuery: composePublicProfileProjection({
        profiles: profileFacts,
        collections: directoryReads,
        cursors,
        sharedExposure,
        accountControl: collectionControl,
      }),
      profileSitemapQuery: composeProfileSitemapQuery({
        candidates: createPostgresProfileSitemapReadPort(runtime),
      }),
    });
    return { app, owner, follower, moderator, avatarStore };
  }

  async function issueSession(
    unitOfWork: IdentityUnitOfWork,
    identity: { readonly subject: string; readonly email: string; readonly handle: string },
  ): Promise<Client> {
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example/realms/known',
        subject: identity.subject,
        email: identity.email,
        displayName: identity.handle,
        handle: identity.handle,
      });
      const secrets = await createSession(ports, { accountId: ensured.account.id });
      return { ensured, secrets };
    });
    return {
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.secrets.rawSessionToken)}`,
      csrfToken: issued.secrets.rawCsrfToken,
      accountId: issued.ensured.account.id,
      subjectId: issued.ensured.account.subjectId,
    };
  }

  function mutationHeaders(client: Client, commandId: string, extra: Record<string, string> = {}) {
    return {
      cookie: client.cookie,
      origin: ORIGIN,
      'x-csrf-token': client.csrfToken,
      'known-command-id': commandId,
      'content-type': extra['content-type'] ?? 'application/json',
      ...extra,
    };
  }

  async function grantModerator(accountId: string): Promise<void> {
    const granted = await createPostgresModerationRoleUnitOfWork(runtime.db).execute((ports) =>
      grantModerationRole(ports, { accountId, role: 'moderator', reason: 'cg06 fixture' }));
    assert.equal(granted.changed, true);
  }

  async function publishCollection(app: ApiApp, client: Client, title: string, slug: string): Promise<{
    readonly id: string;
    readonly slug: string;
    readonly etag: string;
  }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutationHeaders(client, crypto.randomUUID()),
      payload: { kind: 'bookmarks', title, summary: `${title} summary` },
    });
    assert.equal(created.statusCode, 201, created.body);
    const body = created.json() as { collection: { id: string; etag: string } };
    const published = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${body.collection.id}`,
      headers: mutationHeaders(client, crypto.randomUUID(), {
        'content-type': 'application/merge-patch+json',
        'if-match': body.collection.etag,
      }),
      payload: { visibility: 'public', publicationSlug: slug, allowSearchIndexing: true },
    });
    assert.equal(published.statusCode, 200, published.body);
    return {
      id: body.collection.id,
      slug,
      etag: (published.json() as { collection: { etag: string } }).collection.etag,
    };
  }

  async function reportAccount(app: ApiApp, client: Client, accountId: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(client, crypto.randomUUID()),
      payload: {
        target: { kind: 'account', id: accountId },
        category: 'spam',
        description: 'coordinated inauthentic account',
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    return (created.json() as { id: string }).id;
  }

  async function reportCollection(app: ApiApp, client: Client, collectionId: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(client, crypto.randomUUID()),
      payload: {
        target: { kind: 'collection', id: collectionId },
        category: 'spam',
        description: 'unsolicited advertising network',
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    return (created.json() as { id: string }).id;
  }

  test('surface inventory lists real account exits only', () => {
    assert.ok(ACCOUNT_CONTROL_SURFACES.length >= 8);
    assert.equal(ACCOUNT_CONTROL_SURFACES.some((row) => /N\/A/u.test(row.control)), false);
  });

  test('account hide_public/delist is 400; restrict_interaction/restrict_publication 201; comments 400', async () => {
    const { app, owner, follower, moderator } = await harness();
    await grantModerator(moderator.accountId);
    const caseId = await reportAccount(app, follower, owner.accountId);
    const hide = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'hide_public',
        reason: 'hide_public is not an account action',
      },
    });
    assert.equal(hide.statusCode, 400);
    assert.equal((hide.json() as { error: { code: string } }).error.code, 'invalid_request');
    const delist = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'delist',
        reason: 'delist is not an account action',
      },
    });
    assert.equal(delist.statusCode, 400);
    const lock = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'lock_comments',
        reason: 'comments do not exist',
      },
    });
    assert.equal(lock.statusCode, 400);
    const comment = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'comment', id: owner.accountId },
        action: 'hide_comment',
        reason: 'comments do not exist',
      },
    });
    assert.equal(comment.statusCode, 400);
    const mismatched = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: follower.accountId },
        action: 'restrict_publication',
        reason: 'case target must match',
      },
    });
    assert.equal(mismatched.statusCode, 400);
    const publication = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_publication',
        reason: 'spam farm public distribution',
      },
    });
    assert.equal(publication.statusCode, 201, publication.body);
    const interaction = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_interaction',
        reason: 'spam farm social writes',
      },
    });
    assert.equal(interaction.statusCode, 201, interaction.body);
  });

  test('parent credential and collection owner are not official moderators', async () => {
    const { app, owner, follower } = await harness();
    const caseId = await reportAccount(app, follower, owner.accountId);
    const asOwner = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_publication',
        reason: 'owner is not an official moderator',
      },
    });
    assert.equal(asOwner.statusCode, 403);
    const grant = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/roles',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { accountId: owner.accountId, role: 'moderator', reason: 'self grant' },
    });
    assert.equal([404, 405].includes(grant.statusCode), true);
  });

  test('restrict_publication 404s public profile before 304 and keeps private owner management', async () => {
    const { app, owner, follower, moderator } = await harness();
    await grantModerator(moderator.accountId);
    const published = await publishCollection(app, owner, 'Public Farm', 'cg06-public');
    await runtime.pool.query(
      `insert into follows(actor_profile_id, target_profile_id, followed_at)
        values($1,$2,current_timestamp - interval '1 hour')`,
      [follower.accountId, owner.accountId],
    );
    await runtime.pool.query(`insert into social_feed_items(
      feed_item_id, source_event_id, kind, recipient_profile_id, actor_profile_id, collection_id,
      source_event_version, source_commit_ordinal, publication_revision, discoverability_recheck_key,
      published_at, retain_until)
      values($1,$2,'collection_change',$3,$4,$5,1,1,'c1.p1',$6,
        current_timestamp - interval '1 minute',
        current_timestamp - interval '1 minute' + interval '90 days')`,
    [
      'cg06-feed-item',
      'cg06-feed-event',
      follower.accountId,
      owner.accountId,
      published.id,
      `publication.collection:${published.id}`,
    ]);
    const publicBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/cg06owner?limit=100',
      headers: { accept: 'application/json' },
    });
    assert.equal(publicBefore.statusCode, 200, publicBefore.body);
    const beforeBody = publicBefore.json() as { profile: { handle: string; displayName: string } };
    assert.equal(beforeBody.profile.handle, 'cg06owner');
    const publicEtag = String(publicBefore.headers.etag ?? '');
    const headBefore = await app.inject({
      method: 'HEAD',
      url: '/api/v1/profiles/cg06owner?limit=100',
      headers: { accept: 'application/json' },
    });
    assert.equal(headBefore.statusCode, 200);
    const htmlBefore = await app.inject({
      method: 'GET',
      url: '/u/cg06owner',
      headers: { accept: 'text/html' },
    });
    assert.equal(htmlBefore.statusCode, 200, htmlBefore.body);
    assert.match(htmlBefore.body, /cg06owner/u);
    const htmlEtag = String(htmlBefore.headers.etag);
    assert.match(htmlEtag, /^W\/"html-/u);
    assert.equal(htmlBefore.headers['last-modified'], undefined);
    const markdownBefore = await app.inject({
      method: 'GET',
      url: '/u/cg06owner',
      headers: { accept: 'text/markdown' },
    });
    assert.equal(markdownBefore.statusCode, 200, markdownBefore.body);
    const sitemapBefore = await app.inject({ method: 'GET', url: '/sitemap-profiles.xml' });
    assert.equal(sitemapBefore.statusCode, 200, sitemapBefore.body);
    assert.match(sitemapBefore.body, /\/u\/cg06owner/u);
    const activityBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/cg06owner/activity',
    });
    assert.equal(activityBefore.statusCode, 200, activityBefore.body);
    const searchBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=cg06owner&type=profile&limit=100',
    });
    assert.equal(searchBefore.statusCode, 200, searchBefore.body);
    assert.equal(
      (searchBefore.json() as { items: Array<{ resourceType: string; resourceId: string; handle?: string }> })
        .items.some((item) => item.resourceType === 'profile'
          && (item.resourceId === 'cg06owner' || item.handle === 'cg06owner')),
      true,
      searchBefore.body,
    );
    const feedBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/feed?limit=100',
      headers: { cookie: follower.cookie },
    });
    assert.equal(feedBefore.statusCode, 200, feedBefore.body);
    assert.equal(
      (feedBefore.json() as { items: Array<{ feedItemId: string; actorProfileId?: string }> })
        .items.some((item) => item.feedItemId === 'cg06-feed-item'),
      true,
      feedBefore.body,
    );
    const caseId = await reportAccount(app, follower, owner.accountId);
    const restrict = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_publication',
        reason: 'remove public profile directory',
      },
    });
    assert.equal(restrict.statusCode, 201, restrict.body);
    const outbox = await runtime.pool.query<{ handler_name: string }>(
      `select handler_name from outbox_events where aggregate_id=$1 and handler_name=$2`,
      [owner.accountId, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME],
    );
    assert.equal(outbox.rows.length >= 1, true);
    const publicAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/cg06owner?limit=100',
      headers: { accept: 'application/json' },
    });
    assert.equal(publicAfter.statusCode, 404);
    assert.equal((publicAfter.json() as { profile?: unknown }).profile, undefined);
    const stale304 = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/cg06owner?limit=100',
      headers: { accept: 'application/json', 'if-none-match': publicEtag },
    });
    assert.notEqual(stale304.statusCode, 304);
    assert.equal(stale304.statusCode, 404);
    const staleHead = await app.inject({
      method: 'HEAD',
      url: '/api/v1/profiles/cg06owner?limit=100',
      headers: { accept: 'application/json', 'if-none-match': publicEtag },
    });
    assert.notEqual(staleHead.statusCode, 304);
    assert.equal(staleHead.statusCode, 404);
    const htmlAfter = await app.inject({
      method: 'GET',
      url: '/u/cg06owner',
      headers: { accept: 'text/html', 'if-none-match': htmlEtag },
    });
    assert.notEqual(htmlAfter.statusCode, 304);
    assert.equal(htmlAfter.statusCode, 404);
    assert.doesNotMatch(htmlAfter.body, /<title>[^<]*cg06owner/iu);
    const htmlHead = await app.inject({
      method: 'HEAD',
      url: '/u/cg06owner',
      headers: { accept: 'text/html' },
    });
    assert.equal(htmlHead.statusCode, 404);
    const markdownAfter = await app.inject({
      method: 'GET',
      url: '/u/cg06owner',
      headers: { accept: 'text/markdown' },
    });
    assert.equal(markdownAfter.statusCode, 404);
    const sitemapAfter = await app.inject({ method: 'GET', url: '/sitemap-profiles.xml' });
    assert.equal(sitemapAfter.statusCode, 200, sitemapAfter.body);
    assert.doesNotMatch(sitemapAfter.body, /\/u\/cg06owner/u);
    const activityAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/cg06owner/activity',
    });
    assert.equal(activityAfter.statusCode, 404);
    const searchAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=cg06owner&type=profile&limit=100',
    });
    assert.equal(searchAfter.statusCode, 200, searchAfter.body);
    assert.equal(
      (searchAfter.json() as { items: Array<{ resourceType: string; resourceId: string; handle?: string }> })
        .items.some((item) => item.resourceType === 'profile'
          && (item.resourceId === 'cg06owner' || item.handle === 'cg06owner')),
      false,
      searchAfter.body,
    );
    const feedAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/feed?limit=100',
      headers: { cookie: follower.cookie },
    });
    assert.equal(feedAfter.statusCode, 200, feedAfter.body);
    assert.equal(
      (feedAfter.json() as { items: Array<{ feedItemId: string }> })
        .items.some((item) => item.feedItemId === 'cg06-feed-item'),
      false,
      feedAfter.body,
    );
    const explore = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?limit=100' });
    assert.equal(explore.statusCode, 200, explore.body);
    const exploreItem = (explore.json() as {
      items: Array<{ id: string; creators: Array<{ id: string; handle: string | null; name: string; avatar: string | null }> }>;
    }).items.find((item) => item.id === published.id);
    assert.ok(exploreItem);
    assert.deepEqual(exploreItem.creators[0], {
      id: 'unknown', name: 'Unknown', handle: null, avatar: null,
    });
    assert.equal(JSON.stringify(exploreItem).includes(owner.accountId), false);
    assert.equal(JSON.stringify(exploreItem).includes(owner.subjectId), false);
    assert.equal(JSON.stringify(exploreItem).includes('cg06owner'), false);
    const prefs = await app.inject({
      method: 'GET',
      url: '/api/v1/me/catalog-preferences',
      headers: { cookie: follower.cookie },
    });
    assert.equal(prefs.statusCode, 200, prefs.body);
    const mute = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/catalog-preferences',
      headers: mutationHeaders(follower, crypto.randomUUID(), {
        'if-match': String(prefs.headers.etag ?? ''),
      }),
      payload: { hiddenOwnerAccountIds: [owner.accountId] },
    });
    assert.equal(mute.statusCode, 200, mute.body);
    const mutedExplore = await app.inject({
      method: 'GET',
      url: '/api/v1/explore/collections?limit=24',
      headers: { cookie: follower.cookie },
    });
    assert.equal(mutedExplore.statusCode, 200, mutedExplore.body);
    assert.equal(
      (mutedExplore.json() as { items: Array<{ id: string }> }).items
        .some((item) => item.id === published.id),
      false,
    );
    const anonymousExplore = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?limit=24' });
    assert.equal(anonymousExplore.statusCode, 200, anonymousExplore.body);
    const anonymousItem = (anonymousExplore.json() as {
      items: Array<{ id: string; creators: Array<{ id: string; handle: string | null; name: string; avatar: string | null }> }>;
    }).items.find((item) => item.id === published.id);
    assert.ok(anonymousItem);
    assert.deepEqual(anonymousItem.creators[0], {
      id: 'unknown', name: 'Unknown', handle: null, avatar: null,
    });
    assert.equal(JSON.stringify(anonymousItem).includes(owner.accountId), false);
    assert.equal(JSON.stringify(anonymousItem).includes(owner.subjectId), false);
    const ownerPrivate = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${published.id}/catalog`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(ownerPrivate.statusCode, 200, ownerPrivate.body);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { kind: 'bookmarks', title: 'Still private', summary: 'owner management remains' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdBody = created.json() as { collection: { id: string; etag: string } };
    const publishDenied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${createdBody.collection.id}`,
      headers: mutationHeaders(owner, crypto.randomUUID(), {
        'content-type': 'application/merge-patch+json',
        'if-match': createdBody.collection.etag,
      }),
      payload: { visibility: 'public', publicationSlug: 'cg06-blocked', allowSearchIndexing: true },
    });
    assert.equal(publishDenied.statusCode, 403);
  });

  test('restrict_interaction is observed on the next request of an old session', async () => {
    const { app, owner, follower, moderator } = await harness();
    await grantModerator(moderator.accountId);
    const followHeaders = (commandId: string) => ({
      cookie: owner.cookie,
      origin: ORIGIN,
      'x-csrf-token': owner.csrfToken,
      'known-command-id': commandId,
    });
    const followedCollection = await publishCollection(app, follower, 'Followable Notes', 'cg06-followable');
    const before = await app.inject({
      method: 'PUT',
      url: `/api/v1/profiles/${follower.accountId}/follow`,
      headers: followHeaders(crypto.randomUUID()),
    });
    assert.equal(before.statusCode, 200, before.body);
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/profiles/${follower.accountId}/follow`,
      headers: followHeaders(crypto.randomUUID()),
    });
    const collectionFollowBefore = await app.inject({
      method: 'PUT',
      url: `/api/v1/collections/${followedCollection.id}/follow`,
      headers: followHeaders(crypto.randomUUID()),
    });
    assert.equal(collectionFollowBefore.statusCode, 200, collectionFollowBefore.body);
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${followedCollection.id}/follow`,
      headers: followHeaders(crypto.randomUUID()),
    });
    const caseId = await reportAccount(app, follower, owner.accountId);
    const restrict = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_interaction',
        reason: 'pause social writes immediately',
      },
    });
    assert.equal(restrict.statusCode, 201, restrict.body);
    const after = await app.inject({
      method: 'PUT',
      url: `/api/v1/profiles/${follower.accountId}/follow`,
      headers: followHeaders(crypto.randomUUID()),
    });
    assert.notEqual(after.statusCode, 200);
    assert.equal([403, 404].includes(after.statusCode), true, after.body);
    const collectionFollowAfter = await app.inject({
      method: 'PUT',
      url: `/api/v1/collections/${followedCollection.id}/follow`,
      headers: followHeaders(crypto.randomUUID()),
    });
    assert.notEqual(collectionFollowAfter.statusCode, 200);
    assert.equal([403, 404].includes(collectionFollowAfter.statusCode), true, collectionFollowAfter.body);
  });

  test('account restrict stacks with collection hide; revoke one does not clear the other or resurrect private content', async () => {
    const { app, owner, follower, moderator } = await harness();
    await grantModerator(moderator.accountId);
    const hidden = await publishCollection(app, owner, 'Stacked Notes', 'cg06-stack');
    const collectionCase = await reportCollection(app, follower, hidden.id);
    const accountCase = await reportAccount(app, follower, owner.accountId);
    const hide = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: collectionCase,
        target: { kind: 'collection', id: hidden.id },
        action: 'hide_public',
        reason: 'hide the collection independently',
      },
    });
    assert.equal(hide.statusCode, 201, hide.body);
    const hideAction = hide.json() as { id: string; revision: string };
    const restrict = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: accountCase,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_publication',
        reason: 'restrict the account independently',
      },
    });
    assert.equal(restrict.statusCode, 201, restrict.body);
    const restrictAction = restrict.json() as { id: string; revision: string };
    const collectionHidden = await app.inject({ method: 'GET', url: `/api/v1/collections/${hidden.slug}` });
    assert.equal(collectionHidden.statusCode, 404);
    const profileHidden = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/cg06owner',
      headers: { accept: 'application/json' },
    });
    assert.equal(profileHidden.statusCode, 404);
    const revokeRestrict = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/actions/${restrictAction.id}/revoke`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), { 'if-match': `"${restrictAction.revision}"` }),
      payload: { reason: 'revoke only the account restrict' },
    });
    assert.equal(revokeRestrict.statusCode, 200, revokeRestrict.body);
    const stillHidden = await app.inject({ method: 'GET', url: `/api/v1/collections/${hidden.slug}` });
    assert.equal(stillHidden.statusCode, 404);
    const profileBack = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/cg06owner',
      headers: { accept: 'application/json' },
    });
    assert.equal(profileBack.statusCode, 200, profileBack.body);
    const revokeHide = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/actions/${hideAction.id}/revoke`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), { 'if-match': `"${hideAction.revision}"` }),
      payload: { reason: 'revoke only the collection hide' },
    });
    assert.equal(revokeHide.statusCode, 200, revokeHide.body);
    const collectionVisible = await app.inject({ method: 'GET', url: `/api/v1/collections/${hidden.slug}` });
    assert.equal(collectionVisible.statusCode, 200, collectionVisible.body);
    const restrictAgain = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: accountCase,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_publication',
        reason: 'restrict again before making source private',
      },
    });
    assert.equal(restrictAgain.statusCode, 201, restrictAgain.body);
    const restrictAgainAction = restrictAgain.json() as { id: string; revision: string };
    const privatize = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${hidden.id}`,
      headers: mutationHeaders(owner, crypto.randomUUID(), {
        'content-type': 'application/merge-patch+json',
        'if-match': hidden.etag,
      }),
      payload: { visibility: 'private' },
    });
    assert.equal(privatize.statusCode, 200, privatize.body);
    const revokeAgain = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/actions/${restrictAgainAction.id}/revoke`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), {
        'if-match': `"${restrictAgainAction.revision}"`,
      }),
      payload: { reason: 'revoke must not resurrect private content' },
    });
    assert.equal(revokeAgain.statusCode, 200, revokeAgain.body);
    const stillPrivate = await app.inject({ method: 'GET', url: `/api/v1/collections/${hidden.slug}` });
    assert.equal(stillPrivate.statusCode, 404);
  });

  test('restrict_publication blocks avatar origin GET before the object body', async () => {
    const { app, owner, follower, moderator, avatarStore } = await harness();
    await grantModerator(moderator.accountId);
    const avatarId = '123e4567-e89b-42d3-a456-426614174099';
    const avatarUrl = `${ORIGIN}/api/v1/avatar/${avatarId}`;
    await avatarStore.put(avatarId, PNG, 'image/png', owner.accountId);
    await runtime.pool.query(`update profiles set avatar_url=$1 where account_id=$2`, [avatarUrl, owner.accountId]);
    const before = await app.inject({ method: 'GET', url: `/api/v1/avatar/${avatarId}` });
    assert.equal(before.statusCode, 200, before.body);
    const headBefore = await app.inject({ method: 'HEAD', url: `/api/v1/avatar/${avatarId}` });
    assert.equal(headBefore.statusCode, 200);
    const caseId = await reportAccount(app, follower, owner.accountId);
    const restrict = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_publication',
        reason: 'avatars are public objects',
      },
    });
    assert.equal(restrict.statusCode, 201, restrict.body);
    const after = await app.inject({ method: 'GET', url: `/api/v1/avatar/${avatarId}` });
    assert.equal(after.statusCode, 404);
    assert.equal(after.rawPayload.equals(PNG), false);
    const staleAvatar = await app.inject({
      method: 'GET',
      url: `/api/v1/avatar/${avatarId}`,
      headers: { 'if-none-match': String(before.headers.etag ?? '"stale-avatar"') },
    });
    assert.notEqual(staleAvatar.statusCode, 304);
    assert.equal(staleAvatar.statusCode, 404);
    const headAfter = await app.inject({ method: 'HEAD', url: `/api/v1/avatar/${avatarId}` });
    assert.equal(headAfter.statusCode, 404);
    assert.equal(headAfter.body, '');
  });

  test('restrict_publication keeps blocking replaced and cleared avatar object URLs', async () => {
    const { app, owner, follower, moderator, avatarStore } = await harness();
    await grantModerator(moderator.accountId);

    async function uploadAvatarObject(commandId: string): Promise<string> {
      const uploaded = await app.inject({
        method: 'POST',
        url: '/api/v1/me/avatar',
        headers: mutationHeaders(owner, commandId, { 'content-type': 'image/png' }),
        payload: PNG,
      });
      assert.equal(uploaded.statusCode, 200, uploaded.body);
      const avatarUrl = (uploaded.json() as { profile: { avatarUrl: string } }).profile.avatarUrl;
      const objectId = avatarUrl.split('/').pop() ?? '';
      assert.match(objectId, /^[0-9a-f-]{36}$/u);
      return objectId;
    }

    // A real upload records the object in the durable attribution mapping and
    // writes the object to the store.
    const firstObjectId = await uploadAvatarObject(crypto.randomUUID());
    const firstBefore = await app.inject({ method: 'GET', url: `/api/v1/avatar/${firstObjectId}` });
    assert.equal(firstBefore.statusCode, 200, firstBefore.body);

    const caseId = await reportAccount(app, follower, owner.accountId);
    const restrict = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_publication',
        reason: 'avatars stay restricted after replacement and clearing',
      },
    });
    assert.equal(restrict.statusCode, 201, restrict.body);

    // Replacing the avatar best-effort deletes the old object; simulate a
    // failed cleanup (object still present in the store) and verify the old
    // URL stays blocked through the historical attribution mapping.
    const secondObjectId = await uploadAvatarObject(crypto.randomUUID());
    assert.notEqual(secondObjectId, firstObjectId);
    await avatarStore.put(firstObjectId, PNG, 'image/png', owner.accountId);
    const firstAfterReplace = await app.inject({ method: 'GET', url: `/api/v1/avatar/${firstObjectId}` });
    assert.equal(firstAfterReplace.statusCode, 404, 'replaced avatar object must stay blocked for a restricted account');
    const secondAfterReplace = await app.inject({ method: 'GET', url: `/api/v1/avatar/${secondObjectId}` });
    assert.equal(secondAfterReplace.statusCode, 404, 'the replacement object is blocked while restriction is active');

    // Clearing the avatar through PATCH /me never touches the object store:
    // both object URLs must remain blocked through the historical mapping.
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: owner.cookie } });
    assert.equal(me.statusCode, 200, me.body);
    const meBody = me.json() as { profile: { handle: string; displayName: string } };
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: mutationHeaders(owner, crypto.randomUUID(), {
        'content-type': 'application/json',
      }),
      payload: {
        handle: meBody.profile.handle,
        displayName: meBody.profile.displayName,
        avatarUrl: null,
      },
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    const firstAfterClear = await app.inject({ method: 'GET', url: `/api/v1/avatar/${firstObjectId}` });
    assert.equal(firstAfterClear.statusCode, 404, 'cleared avatar object must stay blocked');
    const secondAfterClear = await app.inject({ method: 'GET', url: `/api/v1/avatar/${secondObjectId}` });
    assert.equal(secondAfterClear.statusCode, 404, 'cleared replacement object must stay blocked');
  });

  test('malformed object ids 404 instead of failing the origin cast check', async () => {
    const { app, owner, follower, moderator } = await harness();
    await grantModerator(moderator.accountId);
    // 36 chars of [a-f0-9-] that is NOT a well-formed UUID (9-4-4-4-11 groups).
    const malformedAvatar = '123456789-1234-1234-1234-123456789ab';
    const malformedFavicon = 'abcdefghi-1234-1234-1234-123456789ab';
    const avatarGet = await app.inject({ method: 'GET', url: `/api/v1/avatar/${malformedAvatar}` });
    assert.equal(avatarGet.statusCode, 404, 'malformed avatar id must 404, not 500');
    const faviconGet = await app.inject({ method: 'GET', url: `/api/v1/favicon/${malformedFavicon}` });
    assert.equal(faviconGet.statusCode, 404, 'malformed favicon id must 404, not 500');
    // Also after a restriction is in force (the historical-attribution branch
    // with the uuid cast is the one that used to blow up).
    const caseId = await reportAccount(app, follower, owner.accountId);
    const restrict = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_publication',
        reason: 'malformed id probe',
      },
    });
    assert.equal(restrict.statusCode, 201, restrict.body);
    const restrictedAvatarGet = await app.inject({ method: 'GET', url: `/api/v1/avatar/${malformedAvatar}` });
    assert.equal(restrictedAvatarGet.statusCode, 404, 'malformed avatar id must stay 404 after restriction');
  });

  test('hide_public withdraws the collection from the public profile activity feed', async () => {
    const { app, owner, follower, moderator } = await harness();
    await grantModerator(moderator.accountId);
    const collection = await publishCollection(app, owner, 'Active Activity', 'cg06-active-activity');
    await runtime.pool.query(
      `insert into social_public_activity
         (activity_id, source_event_id, actor_profile_id, collection_id, kind, published_at, publication_revision, discoverability_recheck_key)
       values ('cg06-activity-1', 'cg06-source-1', $1, $2, 'collection_change', now(), 'rev-1', 'publication.collection:' || $2)`,
      [owner.accountId, collection.id],
    );

    const before = await app.inject({ method: 'GET', url: '/api/v1/profiles/cg06owner/activity?limit=50' });
    assert.equal(before.statusCode, 200, before.body);
    const beforeItems = (before.json() as { items: Array<{ collectionId: string }> }).items;
    assert.equal(beforeItems.some((item) => item.collectionId === collection.id), true, 'activity must list the collection before hide');

    const caseId = await reportAccount(app, follower, owner.accountId);
    const caseForCollection = await app.inject({
      method: 'POST', url: '/api/v1/moderation/reports',
      headers: mutationHeaders(follower, crypto.randomUUID()),
      payload: { target: { kind: 'collection', id: collection.id }, category: 'spam', description: 'activity fixture' },
    });
    assert.equal(caseForCollection.statusCode, 201, caseForCollection.body);
    const hide = await app.inject({
      method: 'POST', url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: (caseForCollection.json() as { id: string }).id,
        target: { kind: 'collection', id: collection.id },
        action: 'hide_public',
        reason: 'cg06 activity hide fixture',
      },
    });
    assert.equal(hide.statusCode, 201, hide.body);

    const after = await app.inject({ method: 'GET', url: '/api/v1/profiles/cg06owner/activity?limit=50' });
    assert.equal(after.statusCode, 200, after.body);
    const afterItems = (after.json() as { items: Array<{ collectionId: string }> }).items;
    assert.equal(afterItems.some((item) => item.collectionId === collection.id), false, 'hide_public must withdraw the activity row');
    assert.equal(after.headers['cache-control'], 'public, max-age=0, must-revalidate');
  });
});
