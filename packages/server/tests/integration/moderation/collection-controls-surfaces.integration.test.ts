import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpToolOutputUnavailableError,
  createAnonymousPublicBinding,
  type Mcp20260728RequestContext,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresModerationActionMethods,
} from '../../../src/infrastructure/governance/postgres-moderation-actions.js';
import {
  createPostgresModerationCommandUnitOfWork,
  createPostgresModerationQueryPorts,
} from '../../../src/infrastructure/governance/postgres-moderation.js';
import { createPostgresModerationRoleUnitOfWork } from '../../../src/infrastructure/governance/postgres-moderation-roles.js';
import { createPostgresExploreCreatorsQueryPort } from '../../../src/infrastructure/identity/index.js';
import { composePublicProfileProjection } from '../../../src/bootstrap/public-profile-projection.js';
import { createWebShellCache } from '../../../src/infrastructure/http/index.js';
import {
  createPostgresExplorePageReadPort,
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationSitemapReadPort,
  createPostgresPublicationSnapshotReadPort,
  createPostgresProductPublicCollectionLocatorReadPort,
  createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicMarksReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresSharedExposureFactsPort } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresNotificationInboxQueryUnitOfWork,
  createPostgresNotificationPreferenceCommandUnitOfWork,
  createPostgresNotificationReadCommandUnitOfWork,
  getPostgresNotificationPreferences,
} from '../../../src/infrastructure/notifications/index.js';
import {
  createPostgresSearchAuthorityPort,
  createPostgresSearchCandidatePort,
} from '../../../src/infrastructure/search/index.js';
import { createPostgresFeedQueryUnitOfWork } from '../../../src/infrastructure/social/index.js';
import { grantModerationRole } from '../../../src/modules/governance/application/moderation-roles.js';
import {
  PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
  createPhase4bMcpNodeResourceProjection,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpRequestContext,
  createPhase4bMcpSnapshotResourceProjection,
  type Phase4bMcpReadToolAdapterBundle,
} from '../../../src/modules/mcp/index.js';
import { createNotificationInboxCursorKeyring } from '../../../src/modules/notifications/index.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import {
  createSearchCursorSigner,
  executeSearchQuery,
} from '../../../src/modules/search/index.js';
import { createFeedCursorKeyring } from '../../../src/modules/social/index.js';
import { PUBLIC_SHELL_FIXTURE } from '../../unit/publication/public-shell-fixture.js';
import {
  createSession,
  ensureAccountFromOidcIdentity,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import { GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME } from '../../../src/infrastructure/governance/postgres-moderation-outbox.js';
import {
  createGovernanceCollectionControlRoutes,
} from '../../../src/infrastructure/outbox/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { SESSION_COOKIE_NAME } from '../../../src/transport/session-cookie.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const HMAC = Buffer.alloc(32, 13).toString('base64url');
const CURSOR_KEY = { id: 'cg03-a', secret: Buffer.alloc(32, 91).toString('base64') };
const MCP_SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const MCP_AUDIENCE = `${ORIGIN}/collections/-/mcp`;

/** Actual collection public exits covered by this suite. Empty cells are not N/A. */
export const COLLECTION_CONTROL_SURFACES = Object.freeze([
  { url: 'GET/HEAD /api/v1/collections/{slug}', media: 'json', control: 'hide_public before body/304', permission: 'anonymous/public vs owner member' },
  { url: 'GET /api/v1/explore/collections', media: 'json', control: 'SQL delist excludes; hide_public tombstones (#21)', permission: 'anonymous discovery' },
  { url: 'GET /sitemap-collections.xml', media: 'xml', control: 'SQL delist+hide before urls', permission: 'anonymous' },
  { url: 'GET /colp/v0.1/directory', media: 'colp catalog', control: 'SQL delist+hide', permission: 'anonymous' },
  { url: 'GET /colp/v0.1/collections/{id}', media: 'colp metadata', control: 'hide_public before 304', permission: 'anonymous vs owner' },
  { url: 'GET /c/{slug}', media: 'html/json', control: 'metadata hide_public', permission: 'anonymous' },
  { url: 'GET /share/{slug} /path/{slug} /graph/{slug}', media: 'html', control: 'public-shell hide_public', permission: 'anonymous' },
  { url: 'GET /colp/v0.1/collections/{id}/snapshot', media: 'colp snapshot', control: 'hide_public before 304', permission: 'anonymous vs owner' },
  { url: 'GET /api/v1/profiles/{handle}', media: 'json', control: 'directory SQL', permission: 'anonymous profile directory' },
  { url: 'GET /api/v1/search', media: 'json', control: 'candidate SQL delist+hide', permission: 'anonymous' },
  { url: 'GET /api/v1/feed', media: 'json', control: 'hide_public tombstones (#21) collection_change', permission: 'follower' },
  { url: 'GET /api/v1/me/notifications', media: 'json', control: 'hide_public omits collection_change', permission: 'recipient' },
  { url: 'POST collections.get MCP', media: 'mcp', control: 'same metadata/snapshot ports', permission: 'compat read' },
  { url: 'GET /api/v1/collections/{id}/catalog', media: 'json', control: 'owner management kept', permission: 'owner' },
] as const);

type ApiApp = ReturnType<typeof buildApiApp>;
interface Client {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly subjectId: string;
}

describeWithPostgres('CG-03 collection hide/delist surfaces', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('moderation_cg03');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  }, 120_000);

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table moderation_actions, moderation_evidence, moderation_cases, moderation_roles,
      catalog_preferences, product_command_receipts, outbox_events, audit_events,
      follows, collection_follows, social_feed_items, social_public_activity,
      notifications, notification_preferences,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, nodes, collections, resource_id_ledger,
      oidc_login_transactions, sessions, account_identities, profile_handles, profiles, accounts cascade`);
  });

  afterAll(async () => isolated?.close());

  async function harness(enabled = true): Promise<{
    app: ApiApp;
    owner: Client;
    follower: Client;
    moderator: Client;
    reviewer: Client;
    identityUnitOfWork: IdentityUnitOfWork;
    collectionControl: ReturnType<typeof createPostgresModerationActionMethods>;
    snapshotQuery: {
      readonly reads: ReturnType<typeof createPostgresPublicationSnapshotReadPort>;
      readonly accessPolicy: ReturnType<typeof createPostgresAccessPolicyFactsPort>;
      readonly cursors: ReturnType<typeof createPublicationCursorKeyring>;
      readonly origin: string;
      readonly sharedExposure: ReturnType<typeof createPostgresSharedExposureFactsPort>;
      readonly collectionControl: ReturnType<typeof createPostgresModerationActionMethods>;
    };
    directoryReads: ReturnType<typeof createPostgresPublicationDirectoryReadPort>;
    sharedExposure: ReturnType<typeof createPostgresSharedExposureFactsPort>;
    cursors: ReturnType<typeof createPublicationCursorKeyring>;
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
      KNOWN_FEATURE_CONTENT_GOVERNANCE: enabled ? 'true' : 'false',
      KNOWN_FEATURE_FEED: 'true',
      KNOWN_FEATURE_NOTIFICATIONS: 'true',
      KNOWN_FEATURE_PUBLIC_SHELL_META: 'true',
      WEB_SHELL_ORIGIN: 'http://web:80',
      ...(enabled ? { GOVERNANCE_CURSOR_HMAC_KEY: HMAC } : {}),
    });
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db);
    const owner = await issueSession(identityUnitOfWork, {
      subject: 'cg03-owner', email: 'owner@example.test', handle: 'cg03owner',
    });
    const follower = await issueSession(identityUnitOfWork, {
      subject: 'cg03-follow', email: 'follow@example.test', handle: 'cg03follow',
    });
    const moderator = await issueSession(identityUnitOfWork, {
      subject: 'cg03-mod', email: 'mod@example.test', handle: 'cg03mod',
    });
    const reviewer = await issueSession(identityUnitOfWork, {
      subject: 'cg03-rev', email: 'rev@example.test', handle: 'cg03rev',
    });
    const cursors = createPublicationCursorKeyring({ active: CURSOR_KEY, retained: [] });
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
    const app = buildApiApp({
      config,
      identityUnitOfWork,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      moderationCommandUnitOfWork: createPostgresModerationCommandUnitOfWork(runtime.db),
      moderationQueryPorts: createPostgresModerationQueryPorts(runtime.db),
      explorePageQuery: createPostgresExplorePageReadPort(runtime),
      exploreCreatorsQuery: createPostgresExploreCreatorsQueryPort(runtime.db),
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      searchRateLimiter: memoryExploreDirectoryLimiter(),
      publicationSitemapQuery: createPostgresPublicationSitemapReadPort(runtime),
      publicationDirectoryQuery: {
        reads: directoryReads,
        cursors,
        origin: config.publication.origin,
        maxPageSize: 500,
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
      }),
      searchQuery: {
        execute: (input) => executeSearchQuery({
          candidates: createPostgresSearchCandidatePort(runtime.db),
          authority: createPostgresSearchAuthorityPort(runtime.db),
          cursors: createSearchCursorSigner({
            current: { id: 'cg03-search', key: 'cg03-search-cursor-secret-material' },
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
      feedQueryUnitOfWork: createPostgresFeedQueryUnitOfWork(
        runtime, createFeedCursorKeyring(config.feed!.cursorKeys),
      ),
      notificationQueryUnitOfWork: createPostgresNotificationInboxQueryUnitOfWork(
        runtime.db, createNotificationInboxCursorKeyring(config.notifications!.cursorKeys),
      ),
      notificationReadCommandUnitOfWork: createPostgresNotificationReadCommandUnitOfWork(runtime.db),
      notificationPreferenceRead: getPostgresNotificationPreferences(runtime.db),
      notificationPreferenceCommandUnitOfWork:
        createPostgresNotificationPreferenceCommandUnitOfWork(runtime.db),
    });
    return {
      app, owner, follower, moderator, reviewer, identityUnitOfWork,
      collectionControl, snapshotQuery, directoryReads, sharedExposure, cursors,
    };
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

  async function publishCollection(app: ApiApp, client: Client, title: string, slug: string): Promise<{
    readonly id: string;
    readonly slug: string;
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
    return { id: body.collection.id, slug };
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

  async function grantModerator(accountId: string): Promise<void> {
    const granted = await createPostgresModerationRoleUnitOfWork(runtime.db).execute((ports) =>
      grantModerationRole(ports, { accountId, role: 'moderator', reason: 'cg03 fixture' }));
    assert.equal(granted.changed, true);
  }

  async function grantReviewer(accountId: string): Promise<void> {
    const granted = await createPostgresModerationRoleUnitOfWork(runtime.db).execute((ports) =>
      grantModerationRole(ports, { accountId, role: 'reviewer', reason: 'cg03 reviewer fixture' }));
    assert.equal(granted.changed, true);
  }

  test('surface inventory lists real collection exits only', () => {
    assert.ok(COLLECTION_CONTROL_SURFACES.length >= 8);
    assert.equal(COLLECTION_CONTROL_SURFACES.some((row) => /N\/A/u.test(row.control)), false);
  });

  test('feature off does not 201 collection actions', async () => {
    const { app, owner } = await harness(false);
    const headers = mutationHeaders(owner, crypto.randomUUID(), { 'if-match': '"1"' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers,
      payload: {
        caseId: 'case_missing',
        target: { kind: 'collection', id: 'col_missing' },
        action: 'hide_public',
        reason: 'should not write',
      },
    });
    assert.equal(created.statusCode, 404);
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v1/moderation/cases/case_missing',
      headers,
      payload: { status: 'in_review' },
    });
    assert.equal(patched.statusCode, 404);
    const got = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/actions/act_missing',
      headers: { cookie: owner.cookie },
    });
    assert.equal(got.statusCode, 404);
    const revoked = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions/act_missing/revoke',
      headers,
      payload: { reason: 'should not revoke' },
    });
    assert.equal(revoked.statusCode, 404);
    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-actions',
      headers: { cookie: owner.cookie },
    });
    assert.equal(mine.statusCode, 404);
  });

  test('unsupported action pairs are 400 and bookmark is not 201', async () => {
    const { app, owner, moderator } = await harness();
    await grantModerator(moderator.accountId);
    const collection = await publishCollection(app, owner, 'Pair Notes', 'cg03-pair');
    const caseId = await reportCollection(app, owner, collection.id);
    const bookmark = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'bookmark', id: 'node_1', collectionId: collection.id },
        action: 'hide_public',
        reason: 'bookmark not enabled',
      },
    });
    assert.equal(bookmark.statusCode, 400);
    assert.equal((bookmark.json() as { error: { code: string } }).error.code, 'invalid_request');
    const lock = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'collection', id: collection.id },
        action: 'lock_comments',
        reason: 'comments do not exist',
      },
    });
    assert.equal(lock.statusCode, 201, lock.body);
    const unsupported = [
      { target: { kind: 'digest_series', id: collection.id }, action: 'hide_public' },
      { target: { kind: 'digest_edition', id: collection.id, seriesId: collection.id }, action: 'delist' },
      { target: { kind: 'account', id: owner.accountId }, action: 'restrict_interaction' },
      { target: { kind: 'account', id: owner.accountId }, action: 'restrict_publication' },
      { target: { kind: 'comment', id: collection.id }, action: 'hide_comment' },
    ] as const;
    for (const pair of unsupported) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/moderation/actions',
        headers: mutationHeaders(moderator, crypto.randomUUID()),
        payload: {
          caseId,
          target: pair.target,
          action: pair.action,
          reason: 'not enabled for CG-03',
        },
      });
      assert.equal(response.statusCode, 400, `${pair.target.kind}:${pair.action}`);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'invalid_request');
    }
  });

  test('hide_public blocks public GET/HEAD immediately and keeps owner management; delist is discovery-only', async () => {
    const { app, owner, moderator, reviewer } = await harness();
    await grantModerator(moderator.accountId);
    await grantReviewer(reviewer.accountId);
    const hidden = await publishCollection(app, owner, 'Hidden Notes', 'cg03-hidden');
    const listed = await publishCollection(app, owner, 'Listed Notes', 'cg03-listed');
    const hiddenCase = await reportCollection(app, owner, hidden.id);
    const listedCase = await reportCollection(app, owner, listed.id);

    const caseGet = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/cases/${hiddenCase}`,
      headers: { cookie: moderator.cookie },
    });
    assert.equal(caseGet.statusCode, 200, caseGet.body);
    const caseEtag = String(caseGet.headers.etag);
    const reviewed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/moderation/cases/${hiddenCase}`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), { 'if-match': caseEtag }),
      payload: { status: 'in_review' },
    });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    assert.equal((reviewed.json() as { case: { status: string } }).case.status, 'in_review');
    const actionsAfterPatch = await runtime.pool.query<{ n: string }>(
      `select count(*)::text as n from moderation_actions where case_id=$1`,
      [hiddenCase],
    );
    assert.equal(actionsAfterPatch.rows[0]?.n, '0');
    const closed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/moderation/cases/${hiddenCase}`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), {
        'if-match': String(reviewed.headers.etag),
      }),
      payload: { status: 'resolved' },
    });
    assert.equal(closed.statusCode, 400);
    assert.equal((closed.json() as { error: { code: string } }).error.code, 'invalid_request');
    const reviewerPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/moderation/cases/${hiddenCase}`,
      headers: mutationHeaders(reviewer, crypto.randomUUID(), { 'if-match': caseEtag }),
      payload: { status: 'in_review' },
    });
    assert.equal(reviewerPatch.statusCode, 403);

    const publicBefore = await app.inject({ method: 'GET', url: `/api/v1/collections/${hidden.slug}` });
    assert.equal(publicBefore.statusCode, 200, publicBefore.body);
    const publicEtag = String(publicBefore.headers.etag ?? '');

    const hide = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: hiddenCase,
        target: { kind: 'collection', id: hidden.id },
        action: 'hide_public',
        reason: 'illegal content on the public collection',
      },
    });
    assert.equal(hide.statusCode, 201, hide.body);
    const hideAction = hide.json() as { id: string; revision: string; state: string };
    assert.equal(hideAction.state, 'active');
    const caseAfterHide = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/cases/${hiddenCase}`,
      headers: { cookie: moderator.cookie },
    });
    assert.equal(caseAfterHide.statusCode, 200, caseAfterHide.body);
    assert.deepEqual((caseAfterHide.json() as { actionIds: string[] }).actionIds, [hideAction.id]);
    const visibility = await runtime.pool.query<{ visibility: string }>(
      `select visibility from collections where id=$1`,
      [hidden.id],
    );
    assert.equal(visibility.rows[0]?.visibility, 'public');
    const reviewerCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(reviewer, crypto.randomUUID()),
      payload: {
        caseId: hiddenCase,
        target: { kind: 'collection', id: hidden.id },
        action: 'delist',
        reason: 'reviewer cannot write actions',
      },
    });
    assert.equal(reviewerCreate.statusCode, 403);
    const ownerGetAction = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/actions/${hideAction.id}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(ownerGetAction.statusCode, 403);
    const reviewerGetAction = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/actions/${hideAction.id}`,
      headers: { cookie: reviewer.cookie },
    });
    assert.equal(reviewerGetAction.statusCode, 200, reviewerGetAction.body);
    const outbox = await runtime.pool.query<{ handler_name: string; state: string }>(
      `select handler_name, state from outbox_events where aggregate_id=$1 and handler_name=$2`,
      [hidden.id, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME],
    );
    assert.equal(outbox.rows.length >= 1, true);
    assert.equal(outbox.rows[0]?.state, 'pending');

    const publicAfter = await app.inject({ method: 'GET', url: `/api/v1/collections/${hidden.slug}` });
    assert.equal(publicAfter.statusCode, 404);
    assert.match(String(publicAfter.headers['cache-control'] ?? ''), /private,\s*no-store/u);
    const publicHead = await app.inject({ method: 'HEAD', url: `/api/v1/collections/${hidden.slug}` });
    assert.equal(publicHead.statusCode, 404);
    if (publicEtag) {
      const stale304 = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${hidden.slug}`,
        headers: { 'if-none-match': publicEtag },
      });
      assert.notEqual(stale304.statusCode, 304);
      assert.equal(stale304.statusCode, 404);
    }

    const ownerCatalog = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${hidden.id}/catalog`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(ownerCatalog.statusCode, 200, ownerCatalog.body);

    const exploreHidden = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?limit=100' });
    assert.equal(exploreHidden.statusCode, 200, exploreHidden.body);
    // #21: the hidden collection keeps its Explore slot as an inert
    // tombstone instead of vanishing from the board.
    const exploreItems = (exploreHidden.json() as {
      items: Array<{
        id: string;
        title: string;
        summary: string | null;
        publicationSlug: string | null;
        tags: string[];
        curatorNote: string | null;
        hiddenPublic?: boolean;
      }>;
    }).items;
    const exploreTombstone = exploreItems.find((item) => item.id === hidden.id);
    assert.ok(exploreTombstone, 'hidden collection stays listed on Explore');
    assert.equal(exploreTombstone.title, 'Collection hidden');
    assert.equal(exploreTombstone.summary, null);
    assert.equal(exploreTombstone.publicationSlug, null);
    assert.deepEqual(exploreTombstone.tags, []);
    assert.equal(exploreTombstone.curatorNote, null);
    assert.equal(exploreTombstone.hiddenPublic, true);
    assert.equal(exploreItems.some((item) => item.title === 'Hidden Notes'), false);
    assert.equal(exploreItems.some((item) => item.id === listed.id), true);
    const profileBeforeDelist = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/cg03owner?limit=100',
      headers: { accept: 'application/json' },
    });
    assert.equal(profileBeforeDelist.statusCode, 200, profileBeforeDelist.body);
    const profileBeforeItems = (profileBeforeDelist.json() as { collections: Array<{ id: string }> }).collections;
    assert.equal(profileBeforeItems.some((item) => item.id === hidden.id), false);
    assert.equal(profileBeforeItems.some((item) => item.id === listed.id), true);
    const searchBeforeDelist = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=Listed%20Notes&type=collection&limit=100',
    });
    assert.equal(searchBeforeDelist.statusCode, 200, searchBeforeDelist.body);
    const searchBeforeItems = (searchBeforeDelist.json() as { items: Array<{ resourceId: string }> }).items;
    assert.equal(searchBeforeItems.some((item) => item.resourceId === listed.id), true);

    const delist = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: listedCase,
        target: { kind: 'collection', id: listed.id },
        action: 'delist',
        reason: 'remove from Explore only',
      },
    });
    assert.equal(delist.statusCode, 201, delist.body);
    const listedPublic = await app.inject({ method: 'GET', url: `/api/v1/collections/${listed.slug}` });
    assert.equal(listedPublic.statusCode, 200, listedPublic.body);
    assert.equal(listedPublic.headers['cache-control'], 'public, max-age=0, must-revalidate');
    const exploreAfterDelist = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?limit=100' });
    const afterItems = (exploreAfterDelist.json() as { items: Array<{ id: string }> }).items;
    assert.equal(afterItems.some((item) => item.id === listed.id), false);

    const sitemap = await app.inject({ method: 'GET', url: '/sitemap-collections.xml' });
    assert.equal(sitemap.statusCode, 200, sitemap.body);
    assert.equal(sitemap.body.includes(hidden.slug), false);
    assert.equal(sitemap.body.includes(listed.slug), false);

    const metadata = await app.inject({
      method: 'GET',
      url: `/colp/v0.1/collections/${hidden.id}`,
      headers: { accept: 'application/vnd.collection-protocol.collection+json;version=0.1' },
    });
    assert.notEqual(metadata.statusCode, 200);
    const snapshot = await app.inject({
      method: 'GET',
      url: `/colp/v0.1/collections/${hidden.id}/snapshot`,
      headers: { accept: 'application/vnd.collection-protocol.snapshot+json;version=0.1' },
    });
    assert.notEqual(snapshot.statusCode, 200);
    const directory = await app.inject({
      method: 'GET',
      url: '/colp/v0.1/directory',
      headers: { accept: 'application/vnd.collection-protocol.catalog+json;version=0.1' },
    });
    assert.equal(directory.statusCode, 200, directory.body);
    assert.equal(directory.body.includes(hidden.slug), false);
    assert.equal(directory.body.includes(listed.slug), false);
    const canonical = await app.inject({
      method: 'GET',
      url: `/c/${hidden.slug}`,
      headers: { accept: 'application/vnd.collection-protocol.collection+json;version=0.1' },
    });
    assert.notEqual(canonical.statusCode, 200);
    for (const url of [`/share/${hidden.slug}`, `/path/${hidden.slug}`, `/graph/${hidden.slug}`]) {
      const html = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      assert.equal(html.statusCode, 404, url);
      assert.equal(html.body.includes('Hidden Notes'), false, url);
    }
    const listedShare = await app.inject({
      method: 'GET',
      url: `/share/${listed.slug}`,
      headers: { accept: 'text/html' },
    });
    assert.equal(listedShare.statusCode, 200, listedShare.body);
    // Governed mode must not grant the edge a 60s freshness window: the CDN
    // override header is dropped so `public, max-age=0, must-revalidate` wins.
    assert.equal(listedShare.headers['cloudflare-cdn-cache-control'], undefined,
      'governed shell HTML must not carry the CDN max-age=60 override');
    const profile = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/cg03owner?limit=100',
      headers: { accept: 'application/json' },
    });
    assert.equal(profile.statusCode, 200, profile.body);
    const profileCollections = (profile.json() as { collections: Array<{ id: string }> }).collections;
    assert.equal(profileCollections.some((item) => item.id === hidden.id), false);
    assert.equal(profileCollections.some((item) => item.id === listed.id), false);
    const searchHidden = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=Hidden%20Notes&type=collection&limit=100',
    });
    assert.equal(searchHidden.statusCode, 200, searchHidden.body);
    const searchHiddenItems = (searchHidden.json() as { items: Array<{ resourceId: string }> }).items;
    assert.equal(searchHiddenItems.some((item) => item.resourceId === hidden.id), false);
    const searchListed = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=Listed%20Notes&type=collection&limit=100',
    });
    assert.equal(searchListed.statusCode, 200, searchListed.body);
    const searchListedItems = (searchListed.json() as { items: Array<{ resourceId: string }> }).items;
    assert.equal(searchListedItems.some((item) => item.resourceId === listed.id), false);

    const hide2 = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: hiddenCase,
        target: { kind: 'collection', id: hidden.id },
        action: 'hide_public',
        reason: 'second overlapping hide',
      },
    });
    assert.equal(hide2.statusCode, 201, hide2.body);
    const hide2Action = hide2.json() as { id: string; revision: string };
    const reviewerRevoke = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/actions/${hideAction.id}/revoke`,
      headers: mutationHeaders(reviewer, crypto.randomUUID(), {
        'if-match': `"${hideAction.revision}"`,
      }),
      payload: { reason: 'reviewer cannot revoke' },
    });
    assert.equal(reviewerRevoke.statusCode, 403);
    const revokeFirst = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/actions/${hideAction.id}/revoke`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), {
        'if-match': `"${hideAction.revision}"`,
      }),
      payload: { reason: 'revoke only the first hide' },
    });
    assert.equal(revokeFirst.statusCode, 200, revokeFirst.body);
    const stillHidden = await app.inject({ method: 'GET', url: `/api/v1/collections/${hidden.slug}` });
    assert.equal(stillHidden.statusCode, 404);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-actions',
      headers: { cookie: owner.cookie },
    });
    assert.equal(mine.statusCode, 200, mine.body);
    const mineBody = mine.json() as { items: Array<Record<string, unknown>> };
    assert.equal(mineBody.items.length >= 1, true);
    assert.equal(Object.hasOwn(mineBody.items[0]!, 'actorAccountId'), false);
    assert.equal(Object.hasOwn(mineBody.items[0]!, 'caseId'), false);

    const officialAction = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/actions/${hide2Action.id}`,
      headers: { cookie: moderator.cookie },
    });
    assert.equal(officialAction.statusCode, 200, officialAction.body);

    const routes = createGovernanceCollectionControlRoutes({
      provider: { async purge() {} },
      publicationOrigin: ORIGIN,
      productOrigin: ORIGIN,
    });
    assert.equal(routes.length, 3);
    assert.equal(routes[0]?.handlerName, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME);
    assert.equal(routes[1]?.handlerName, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME);
    assert.equal(routes[2]?.handlerName, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME);
  });

  test('hide_public tombstones follower feed rows, omits recipient notifications, and hides MCP collections.get (#21)', async () => {
    const {
      app, owner, follower, moderator, collectionControl, snapshotQuery,
      directoryReads, sharedExposure, cursors,
    } = await harness();
    await grantModerator(moderator.accountId);
    const hidden = await publishCollection(app, owner, 'Hidden Feed Notes', 'cg03-feed-hidden');
    const listed = await publishCollection(app, owner, 'Listed Feed Notes', 'cg03-feed-listed');
    await runtime.pool.query(
      `insert into follows(actor_profile_id, target_profile_id, followed_at)
        values($1,$2,current_timestamp - interval '1 hour')`,
      [follower.accountId, owner.accountId],
    );
    await insertCollectionChangeFeedItem({
      feedItemId: 'cg03-feed-hidden-item',
      sourceEventId: 'cg03-feed-hidden-event',
      recipientId: follower.accountId,
      actorId: owner.accountId,
      collectionId: hidden.id,
    });
    await insertCollectionChangeFeedItem({
      feedItemId: 'cg03-feed-listed-item',
      sourceEventId: 'cg03-feed-listed-event',
      recipientId: follower.accountId,
      actorId: owner.accountId,
      collectionId: listed.id,
    });
    await insertCollectionChangeNotification({
      notificationId: 'cg03-note-hidden',
      recipientId: follower.accountId,
      actorId: owner.accountId,
      collectionId: hidden.id,
    });
    await insertCollectionChangeNotification({
      notificationId: 'cg03-note-listed',
      recipientId: follower.accountId,
      actorId: owner.accountId,
      collectionId: listed.id,
    });
    const mcp = createCollectionMcpTools({
      collectionControl, snapshotQuery, directoryReads, sharedExposure, cursors,
    });
    try {
      const feedBefore = await app.inject({
        method: 'GET',
        url: '/api/v1/feed?limit=100',
        headers: { cookie: follower.cookie },
      });
      assert.equal(feedBefore.statusCode, 200, feedBefore.body);
      const feedBeforeItems = (feedBefore.json() as {
        items: Array<{ feedItemId: string; collectionTitle?: string | null }>;
      }).items;
      assert.equal(feedBeforeItems.some((item) => item.feedItemId === 'cg03-feed-hidden-item'), true);
      assert.equal(feedBeforeItems.some((item) => item.feedItemId === 'cg03-feed-listed-item'), true);
      assert.equal(
        feedBeforeItems.find((item) => item.feedItemId === 'cg03-feed-hidden-item')?.collectionTitle,
        'Hidden Feed Notes',
      );

      const notesBefore = await app.inject({
        method: 'GET',
        url: '/api/v1/me/notifications?limit=100',
        headers: { cookie: follower.cookie },
      });
      assert.equal(notesBefore.statusCode, 200, notesBefore.body);
      const notesBeforeItems = (notesBefore.json() as {
        items: Array<{ notificationId: string; collectionId: string | null }>;
      }).items;
      assert.equal(notesBeforeItems.some((item) => item.notificationId === 'cg03-note-hidden'), true);
      assert.equal(notesBeforeItems.some((item) => item.notificationId === 'cg03-note-listed'), true);

      const mcpHiddenBefore = await mcp.surface.adapter.callTool(
        mcpToolContext('collections.get', hidden.id),
        { name: 'collections.get', arguments: { collectionId: hidden.id } },
      );
      assert.equal(
        (mcpHiddenBefore.structuredContent as { collection?: { id?: string } }).collection?.id,
        hidden.id,
      );
      const mcpSnapshotBefore = await mcp.surface.adapter.callTool(
        mcpToolContext('collections.get_snapshot', hidden.id),
        { name: 'collections.get_snapshot', arguments: { collectionId: hidden.id } },
      );
      assert.equal(JSON.stringify(mcpSnapshotBefore).includes(hidden.id), true);

      const hiddenCase = await reportCollection(app, owner, hidden.id);
      const listedCase = await reportCollection(app, owner, listed.id);
      const hide = await app.inject({
        method: 'POST',
        url: '/api/v1/moderation/actions',
        headers: mutationHeaders(moderator, crypto.randomUUID()),
        payload: {
          caseId: hiddenCase,
          target: { kind: 'collection', id: hidden.id },
          action: 'hide_public',
          reason: 'remove the public collection from follower surfaces',
        },
      });
      assert.equal(hide.statusCode, 201, hide.body);
      const delist = await app.inject({
        method: 'POST',
        url: '/api/v1/moderation/actions',
        headers: mutationHeaders(moderator, crypto.randomUUID()),
        payload: {
          caseId: listedCase,
          target: { kind: 'collection', id: listed.id },
          action: 'delist',
          reason: 'discovery-only; follower rows stay',
        },
      });
      assert.equal(delist.statusCode, 201, delist.body);

      const feedAfter = await app.inject({
        method: 'GET',
        url: '/api/v1/feed?limit=100',
        headers: { cookie: follower.cookie },
      });
      assert.equal(feedAfter.statusCode, 200, feedAfter.body);
      const feedAfterItems = (feedAfter.json() as {
        items: Array<{
          feedItemId: string; collectionTitle?: string | null;
          publicationSlug?: string | null; summary?: string | null; hiddenPublic?: boolean;
        }>;
      }).items;
      // #21: hide_public keeps the follower feed row as an inert tombstone
      // instead of omitting it; delist still leaves the listed row untouched.
      const feedHiddenAfter = feedAfterItems.find((item) => item.feedItemId === 'cg03-feed-hidden-item');
      assert.ok(feedHiddenAfter, 'hide_public keeps a tombstone row in the follower feed (#21)');
      assert.equal(feedHiddenAfter.hiddenPublic, true);
      assert.equal(feedHiddenAfter.collectionTitle, 'Collection hidden');
      assert.equal(feedHiddenAfter.publicationSlug, null);
      assert.equal(feedHiddenAfter.summary, null);
      assert.equal(JSON.stringify(feedAfterItems).includes('Hidden Feed Notes'), false);
      assert.equal(feedAfterItems.some((item) => item.feedItemId === 'cg03-feed-listed-item'), true);
      assert.equal(
        feedAfterItems.find((item) => item.feedItemId === 'cg03-feed-listed-item')?.collectionTitle,
        'Listed Feed Notes',
      );

      const notesAfter = await app.inject({
        method: 'GET',
        url: '/api/v1/me/notifications?limit=100',
        headers: { cookie: follower.cookie },
      });
      assert.equal(notesAfter.statusCode, 200, notesAfter.body);
      const notesAfterItems = (notesAfter.json() as { items: Array<{ notificationId: string }> }).items;
      assert.equal(notesAfterItems.some((item) => item.notificationId === 'cg03-note-hidden'), false);
      assert.equal(notesAfterItems.some((item) => item.notificationId === 'cg03-note-listed'), true);

      await assert.rejects(
        () => mcp.surface.adapter.callTool(
          mcpToolContext('collections.get', hidden.id),
          { name: 'collections.get', arguments: { collectionId: hidden.id } },
        ),
        McpToolOutputUnavailableError,
      );
      await assert.rejects(
        () => mcp.surface.adapter.callTool(
          mcpToolContext('collections.get_snapshot', hidden.id),
          { name: 'collections.get_snapshot', arguments: { collectionId: hidden.id } },
        ),
        McpToolOutputUnavailableError,
      );
      const mcpListed = await mcp.surface.adapter.callTool(
        mcpToolContext('collections.get', listed.id),
        { name: 'collections.get', arguments: { collectionId: listed.id } },
      );
      assert.equal(
        (mcpListed.structuredContent as { collection?: { id?: string } }).collection?.id,
        listed.id,
      );
    } finally {
      mcp.destroy();
    }
  });

  async function insertCollectionChangeFeedItem(input: {
    readonly feedItemId: string;
    readonly sourceEventId: string;
    readonly recipientId: string;
    readonly actorId: string;
    readonly collectionId: string;
  }): Promise<void> {
    await runtime.pool.query(`insert into social_feed_items(
      feed_item_id, source_event_id, kind, recipient_profile_id, actor_profile_id, collection_id,
      source_event_version, source_commit_ordinal, publication_revision, discoverability_recheck_key,
      published_at, retain_until)
      values($1,$2,'collection_change',$3,$4,$5,1,1,'c1.p1',$6,
        current_timestamp - interval '1 minute',
        current_timestamp - interval '1 minute' + interval '90 days')`,
    [
      input.feedItemId,
      input.sourceEventId,
      input.recipientId,
      input.actorId,
      input.collectionId,
      `publication.collection:${input.collectionId}`,
    ]);
  }

  async function insertCollectionChangeNotification(input: {
    readonly notificationId: string;
    readonly recipientId: string;
    readonly actorId: string;
    readonly collectionId: string;
  }): Promise<void> {
    await runtime.pool.query(`insert into notifications(
      notification_id, recipient_account_id, source_event_id, notification_type,
      actor_profile_id, subject_type, subject_id, state, occurred_at, retain_until)
      values($1,$2,$3,'collection_change',$4,'collection',$5,'unread',
        current_timestamp - interval '1 minute',
        current_timestamp - interval '1 minute' + interval '365 days')`,
    [
      input.notificationId,
      input.recipientId,
      `event-${input.notificationId}`,
      input.actorId,
      input.collectionId,
    ]);
  }

  function createCollectionMcpTools(input: {
    readonly collectionControl: ReturnType<typeof createPostgresModerationActionMethods>;
    readonly snapshotQuery: {
      readonly reads: ReturnType<typeof createPostgresPublicationSnapshotReadPort>;
      readonly accessPolicy: ReturnType<typeof createPostgresAccessPolicyFactsPort>;
      readonly cursors: ReturnType<typeof createPublicationCursorKeyring>;
      readonly origin: string;
      readonly sharedExposure: ReturnType<typeof createPostgresSharedExposureFactsPort>;
      readonly collectionControl: ReturnType<typeof createPostgresModerationActionMethods>;
    };
    readonly directoryReads: ReturnType<typeof createPostgresPublicationDirectoryReadPort>;
    readonly sharedExposure: ReturnType<typeof createPostgresSharedExposureFactsPort>;
    readonly cursors: ReturnType<typeof createPublicationCursorKeyring>;
  }): { readonly surface: Phase4bMcpReadToolAdapterBundle; destroy(): void } {
    const mcpConfig = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PRODUCT_ORIGIN: ORIGIN,
      PUBLICATION_ORIGIN: ORIGIN,
      PUBLICATION_SERVER_UUID: MCP_SERVER_UUID,
      ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/protocol/openid-connect/certs',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      KNOWN_FEATURE_MCP_READ: 'true',
      MCP_SERVER_UUID: MCP_SERVER_UUID,
      MCP_ALLOWED_ORIGINS: ORIGIN,
      MCP_OAUTH_ISSUER: `${ORIGIN}/api/v1/auth`,
      MCP_OAUTH_AUDIENCE: MCP_AUDIENCE,
      MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
        `${ORIGIN}/.well-known/oauth-authorization-server/api/v1/auth`,
      MCP_OAUTH_JWKS_URI: `${ORIGIN}/api/v1/auth/jwks`,
      MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
    }).mcp!;
    const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
      active: { id: 'cg03-mcp-v1', secret: Buffer.alloc(32, 123).toString('base64') },
      retained: [],
      ttlMs: 60_000,
    });
    const collectionProjection = createPhase4bMcpCollectionResourceProjection({
      config: mcpConfig,
      directoryQuery: {
        reads: input.directoryReads,
        cursors: input.cursors,
        origin: ORIGIN,
        maxPageSize: 500,
      },
      metadataQuery: {
        reads: createPostgresPublicationMetadataReadPort(runtime),
        origin: ORIGIN,
        collectionControl: input.collectionControl,
      },
      accessPolicy: createPostgresAccessPolicyFactsPort(runtime.db),
      cursorKeys: mcpCursors,
      now: () => new Date(),
      sharedExposure: input.sharedExposure,
    });
    const snapshotProjection = createPhase4bMcpSnapshotResourceProjection({
      config: mcpConfig,
      snapshotQuery: input.snapshotQuery,
      now: () => new Date(),
    });
    const nodeProjection = createPhase4bMcpNodeResourceProjection({
      config: mcpConfig,
      snapshotQuery: input.snapshotQuery,
      now: () => new Date(),
    });
    return {
      surface: createPhase4bMcpReadToolAdapter({
        collectionProjection,
        snapshotProjection,
        nodeProjection,
        serverUuid: MCP_SERVER_UUID,
      }),
      destroy() { mcpCursors.destroy(); },
    };
  }

  function mcpToolContext(name: string, collectionId: string): Mcp20260728RequestContext {
    return createPhase4bMcpRequestContext({
      headers: Object.freeze([
        Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
        Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
        Object.freeze({ name: 'Mcp-Name', value: name }),
        Object.freeze({ name: 'Mcp-Param-X-Collection-Id', value: collectionId }),
      ]),
      httpMethod: 'POST',
      body: Object.freeze({
        method: 'tools/call',
        params: Object.freeze({
          _meta: Object.freeze({
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': Object.freeze({
              tools: Object.freeze({ call: true }),
            }),
          }),
          name,
          arguments: Object.freeze({ collectionId }),
        }),
      }),
      binding: createAnonymousPublicBinding({
        resourceAudience: MCP_AUDIENCE,
        securityEpoch: 'epoch-1',
      }),
      scope: ['mcp:read:public'],
      authorization: Object.freeze({}),
      budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
      paramDeclarations: PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
    });
  }
});
