import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createReportMcpReadToolPort } from '../../../src/bootstrap/api-mcp-surface-composition.js';
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
import { createWebShellCache } from '../../../src/infrastructure/http/index.js';
import {
  createPostgresExplorePageReadPort,
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationSnapshotReadPort,
  createPostgresProductPublicCollectionLocatorReadPort,
  createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicMarksReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresSharedExposureFactsPort } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import { createPostgresReportUnitOfWork } from '../../../src/infrastructure/reports/index.js';
import type { ReportCacheReader } from '../../../src/infrastructure/reports/report-cache.js';
import {
  attachDigestEdition,
  createDigestSeries,
  followDigestSeries,
  publishDigestEdition,
  type PublicReportSeries,
} from '../../../src/modules/reports/index.js';
import { grantModerationRole } from '../../../src/modules/governance/application/moderation-roles.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { createMcpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import { PUBLIC_SHELL_FIXTURE } from '../../unit/publication/public-shell-fixture.js';
import {
  createSession,
  ensureAccountFromOidcIdentity,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import { GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME } from '../../../src/infrastructure/governance/postgres-moderation-outbox.js';
import { createGovernanceCollectionControlRoutes } from '../../../src/infrastructure/outbox/index.js';
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
const CURSOR_KEY = { id: 'cg05-a', secret: Buffer.alloc(32, 91).toString('base64') };

/** Actual digest public exits covered by this suite. Empty cells are not N/A. */
export const DIGEST_CONTROL_SURFACES = Object.freeze([
  { url: 'GET /api/v1/public-reports', media: 'json directory', control: 'series delist+hide before page', permission: 'anonymous discovery' },
  { url: 'GET /api/v1/public-reports/{slug}', media: 'json series', control: 'series hide 404; delist still 200', permission: 'anonymous' },
  { url: 'GET /api/v1/public-reports/{slug}/issues', media: 'json listing', control: 'edition hide/delist omit; series hide 404', permission: 'anonymous' },
  { url: 'GET /api/v1/public-reports/{slug}/issues/{editionId}', media: 'json issue', control: 'edition+source+series hide; series delist not auto-404', permission: 'anonymous' },
  { url: 'GET/HEAD /reports', media: 'html/md/OG directory', control: 'delist+hide', permission: 'anonymous' },
  { url: 'GET/HEAD /reports/{slug}', media: 'html/md/OG series', control: 'series hide_public', permission: 'anonymous' },
  { url: 'GET/HEAD /reports/{slug}/issues/{editionId}', media: 'html/md/OG issue', control: 'edition+source hide; series delist not auto-404', permission: 'anonymous' },
  { url: 'GET/HEAD /sitemap-reports.xml', media: 'xml', control: 'delist+hide before urls', permission: 'anonymous' },
  { url: 'POST MCP reports.list/get/issues.list', media: 'mcp', control: 'same public-query ports', permission: 'compat read' },
  { url: 'GET /api/v1/me/followed-reports', media: 'json', control: 'series hide_public tombstones (#21)', permission: 'follower' },
  { url: 'GET /api/v1/me/followed-reports/issues', media: 'json', control: 'series/edition hide tombstones; source hide omits; old rows cannot resurrect', permission: 'follower' },
  { url: 'GET /api/v1/reports/{id}', media: 'json', control: 'owner management kept', permission: 'owner' },
] as const);

type ApiApp = ReturnType<typeof buildApiApp>;
interface Client {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly subjectId: string;
}

describeWithPostgres('CG-05 digest hide/delist surfaces', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('moderation_cg05');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  }, 120_000);

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table moderation_actions, moderation_evidence, moderation_cases, moderation_roles,
      catalog_preferences, product_command_receipts, outbox_events, audit_events,
      digest_runs, digest_schedules, digest_follows, digest_members, digest_editions, digest_series, digest_audit_events,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, nodes, collections, resource_id_ledger,
      oidc_login_transactions, sessions, account_identities, profile_handles, profiles, accounts cascade`);
  });

  afterAll(async () => isolated?.close());

  async function harness(options: {
    readonly reportCache?: ReportCacheReader;
  } = {}): Promise<{
    app: ApiApp;
    owner: Client;
    follower: Client;
    moderator: Client;
    reportsUnitOfWork: ReturnType<typeof createPostgresReportUnitOfWork>;
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
      KNOWN_FEATURE_REPORTS: 'true',
      KNOWN_FEATURE_REPORTS_PUBLIC: 'true',
      KNOWN_FEATURE_PUBLIC_SHELL_META: 'true',
      WEB_SHELL_ORIGIN: 'http://web:80',
      GOVERNANCE_CURSOR_HMAC_KEY: HMAC,
    });
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db);
    const owner = await issueSession(identityUnitOfWork, {
      subject: 'cg05-owner', email: 'owner@example.test', handle: 'cg05owner',
    });
    const follower = await issueSession(identityUnitOfWork, {
      subject: 'cg05-follower', email: 'follower@example.test', handle: 'cg05follow',
    });
    const moderator = await issueSession(identityUnitOfWork, {
      subject: 'cg05-mod', email: 'mod@example.test', handle: 'cg05mod',
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
    const reportsUnitOfWork = createPostgresReportUnitOfWork(runtime.db);
    const limiter = memoryExploreDirectoryLimiter();
    const app = buildApiApp({
      config,
      identityUnitOfWork,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      moderationCommandUnitOfWork: createPostgresModerationCommandUnitOfWork(runtime.db),
      moderationQueryPorts: createPostgresModerationQueryPorts(runtime.db),
      explorePageQuery: createPostgresExplorePageReadPort(runtime),
      exploreDirectoryRateLimiter: limiter,
      reportsUnitOfWork,
      ...(options.reportCache === undefined ? {} : { reportCache: options.reportCache }),
      reportsRateLimiter: limiter,
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
      publicationDirectoryQuery: {
        reads: directoryReads,
        cursors,
        origin: config.publication.origin,
        maxPageSize: 500,
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
    });
    return { app, owner, follower, moderator, reportsUnitOfWork };
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
      grantModerationRole(ports, { accountId, role: 'moderator', reason: 'cg05 fixture' }));
    assert.equal(granted.changed, true);
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

  async function publishDigest(
    reportsUnitOfWork: ReturnType<typeof createPostgresReportUnitOfWork>,
    client: Client,
    input: {
      readonly title: string;
      readonly slug: string;
      readonly sourceId: string;
      readonly issues: readonly { readonly key: string; readonly title: string; readonly summary: string }[];
    },
  ): Promise<{ readonly id: string; readonly slug: string; readonly editions: readonly { readonly id: string; readonly title: string }[] }> {
    const actor = { principalId: client.subjectId, subjectId: client.subjectId };
    const created = await createDigestSeries(reportsUnitOfWork, {
      actor,
      commandId: crypto.randomUUID(),
      title: input.title,
      summary: `${input.title} summary`,
      slug: input.slug,
      visibility: 'public',
      allowSearchIndexing: true,
    });
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') throw new Error('series create failed');
    const editions: { id: string; title: string }[] = [];
    for (const issue of input.issues) {
      const attached = await attachDigestEdition(reportsUnitOfWork, {
        actor,
        commandId: crypto.randomUUID(),
        seriesId: created.value.id,
        sourceCollectionId: input.sourceId,
        issueKey: issue.key,
        titleSnapshot: issue.title,
        summarySnapshot: issue.summary,
      });
      assert.equal(attached.kind, 'succeeded', 'attach edition');
      if (attached.kind !== 'succeeded') throw new Error('attach failed');
      const published = await publishDigestEdition(reportsUnitOfWork, {
        actor,
        commandId: crypto.randomUUID(),
        seriesId: created.value.id,
        editionId: attached.value.id,
        expectedRevision: `"${attached.value.resourceRevision}"`,
      });
      assert.equal(published.kind, 'succeeded', 'publish edition');
      if (published.kind !== 'succeeded') throw new Error('publish failed');
      editions.push({ id: attached.value.id, title: issue.title });
    }
    return { id: created.value.id, slug: input.slug, editions };
  }

  async function reportTarget(
    app: ApiApp,
    client: Client,
    target: Record<string, string>,
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(client, crypto.randomUUID()),
      payload: {
        target,
        category: 'spam',
        description: 'unsolicited digest advertising',
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    return (created.json() as { id: string }).id;
  }

  async function moderate(
    app: ApiApp,
    moderator: Client,
    caseId: string,
    target: Record<string, string>,
    action: 'delist' | 'hide_public',
  ): Promise<{ readonly id: string; readonly statusCode: number }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: { caseId, target, action, reason: `${action} digest fixture` },
    });
    return { id: (response.json() as { id?: string }).id ?? '', statusCode: response.statusCode };
  }

  test('surface inventory lists real digest exits only', () => {
    assert.ok(DIGEST_CONTROL_SURFACES.length >= 8);
    assert.equal(DIGEST_CONTROL_SURFACES.some((row) => /N\/A/u.test(row.control)), false);
  });

  test('account restrict_publication conceals an owned public digest', async () => {
    const { app, owner, follower, moderator, reportsUnitOfWork } = await harness();
    await grantModerator(moderator.accountId);
    const source = await publishCollection(app, owner, 'Restricted source', 'cg05-account-source');
    const digest = await publishDigest(reportsUnitOfWork, owner, {
      title: 'Restricted digest', slug: 'cg05-account-digest', sourceId: source.id,
      issues: [{ key: 'one', title: 'Issue one', summary: 'Issue summary' }],
    });
    const caseId = await reportTarget(app, follower, { kind: 'account', id: owner.accountId });
    const restricted = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_publication',
        reason: 'account publication is restricted',
      },
    });
    assert.equal(restricted.statusCode, 201, restricted.body);
    const direct = await app.inject({ method: 'GET', url: `/api/v1/public-reports/${digest.slug}` });
    assert.equal(direct.statusCode, 404, direct.body);
    const directory = await app.inject({ method: 'GET', url: '/api/v1/public-reports?limit=100' });
    assert.equal(directory.statusCode, 200, directory.body);
    const items = (directory.json() as { items: Array<{ slug: string }> }).items;
    assert.equal(items.some((item) => item.slug === digest.slug), false);
  });

  test('unsupported pairs stay 400; digest series/edition hide/delist 201 with matching case', async () => {
    const { app, owner, moderator, reportsUnitOfWork } = await harness();
    await grantModerator(moderator.accountId);
    const source = await publishCollection(app, owner, 'Source Notes', 'cg05-source-a');
    const digest = await publishDigest(reportsUnitOfWork, owner, {
      title: 'Pair Digest',
      slug: 'cg05-pair',
      sourceId: source.id,
      issues: [{ key: 'w1', title: 'Pair Issue', summary: 'pair body' }],
    });
    const seriesCase = await reportTarget(app, owner, { kind: 'digest_series', id: digest.id });
    const editionCase = await reportTarget(app, owner, {
      kind: 'digest_edition', id: digest.editions[0]!.id, seriesId: digest.id,
    });

    const lock = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: seriesCase,
        target: { kind: 'digest_series', id: digest.id },
        action: 'lock_comments',
        reason: 'comments do not exist',
      },
    });
    assert.equal(lock.statusCode, 201, lock.body);
    const comment = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: seriesCase,
        target: { kind: 'comment', id: digest.id },
        action: 'hide_comment',
        reason: 'comments do not exist',
      },
    });
    assert.equal(comment.statusCode, 400);
    assert.equal((comment.json() as { error: { code: string } }).error.code, 'invalid_request');
    const account = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: seriesCase,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_publication',
        reason: 'account not enabled',
      },
    });
    assert.equal(account.statusCode, 400);
    const restrictInteraction = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: seriesCase,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_interaction',
        reason: 'account not enabled',
      },
    });
    assert.equal(restrictInteraction.statusCode, 400);
    const mismatched = await moderate(
      app, moderator, seriesCase,
      { kind: 'digest_edition', id: digest.editions[0]!.id, seriesId: digest.id },
      'hide_public',
    );
    assert.equal(mismatched.statusCode, 400);

    const hideSeries = await moderate(
      app, moderator, seriesCase, { kind: 'digest_series', id: digest.id }, 'hide_public',
    );
    assert.equal(hideSeries.statusCode, 201, 'digest_series hide_public');
    const delistEdition = await moderate(
      app, moderator, editionCase,
      { kind: 'digest_edition', id: digest.editions[0]!.id, seriesId: digest.id },
      'delist',
    );
    assert.equal(delistEdition.statusCode, 201, 'digest_edition delist');
    const collectionCase = await reportTarget(app, owner, { kind: 'collection', id: source.id });
    const collectionDelist = await moderate(
      app, moderator, collectionCase, { kind: 'collection', id: source.id }, 'delist',
    );
    assert.equal(collectionDelist.statusCode, 201, 'collection delist remains enabled');
  });

  test('independently enforces series, edition, and live source on every digest exit', async () => {
    const { app, owner, follower, moderator, reportsUnitOfWork } = await harness();
    await grantModerator(moderator.accountId);
    const sourceA = await publishCollection(app, owner, 'Alpha Source', 'cg05-alpha-source');
    const sourceB = await publishCollection(app, owner, 'Beta Source', 'cg05-beta-source');
    const hiddenSeries = await publishDigest(reportsUnitOfWork, owner, {
      title: 'Hidden Weekly',
      slug: 'cg05-hidden',
      sourceId: sourceA.id,
      issues: [
        { key: 'h1', title: 'Hidden Issue One', summary: 'hidden body one' },
        { key: 'h2', title: 'Hidden Issue Two', summary: 'hidden body two' },
      ],
    });
    const listedSeries = await publishDigest(reportsUnitOfWork, owner, {
      title: 'Listed Weekly',
      slug: 'cg05-listed',
      sourceId: sourceB.id,
      issues: [
        { key: 'l1', title: 'Listed Issue One', summary: 'listed body one' },
        { key: 'l2', title: 'Listed Issue Two', summary: 'listed body two' },
      ],
    });
    const editionA = hiddenSeries.editions[0]!;
    const editionB = hiddenSeries.editions[1]!;
    const listedEdition = listedSeries.editions[0]!;

    const follow = await followDigestSeries(reportsUnitOfWork, {
      actor: {
        principalId: follower.subjectId,
        subjectId: follower.subjectId,
        profileId: follower.accountId,
      },
      commandId: crypto.randomUUID(),
      seriesId: hiddenSeries.id,
    });
    assert.equal(follow.kind, 'succeeded');

    const publicBefore = await app.inject({ method: 'GET', url: `/api/v1/public-reports/${hiddenSeries.slug}` });
    assert.equal(publicBefore.statusCode, 200, publicBefore.body);
    assert.equal((publicBefore.json() as { issues: Array<{ id: string }> }).issues.length, 2);
    const publicBeforeEtag = String(publicBefore.headers.etag ?? '"digest-series"');
    const issueBefore = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}/issues/${editionA.id}`,
    });
    assert.equal(issueBefore.statusCode, 200, issueBefore.body);
    assert.equal((issueBefore.json() as { sourceCollectionSlug: string }).sourceCollectionSlug, sourceA.slug);
    const issueBeforeEtag = String(issueBefore.headers.etag ?? '"digest-issue"');
    const issueHtmlBefore = await app.inject({
      method: 'GET',
      url: `/reports/${hiddenSeries.slug}/issues/${editionA.id}`,
      headers: { accept: 'text/html' },
    });
    assert.equal(issueHtmlBefore.statusCode, 200, issueHtmlBefore.body);
    assert.equal(issueHtmlBefore.body.includes('Hidden Issue One'), true);
    const issueHtmlEtag = String(issueHtmlBefore.headers.etag);
    assert.match(issueHtmlEtag, /^W\/"html-/u);
    assert.equal(issueHtmlBefore.headers['last-modified'], undefined);
    const issueUnchanged = await app.inject({
      method: 'GET', url: `/reports/${hiddenSeries.slug}/issues/${editionA.id}`,
      headers: { accept: 'text/html', 'if-none-match': issueHtmlEtag },
    });
    assert.equal(issueUnchanged.statusCode, 304);
    const followedSeriesBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/me/followed-reports?limit=50',
      headers: { cookie: follower.cookie },
    });
    assert.equal(followedSeriesBefore.statusCode, 200, followedSeriesBefore.body);
    assert.equal(
      (followedSeriesBefore.json() as { items: Array<{ id: string }> }).items
        .some((item) => item.id === hiddenSeries.id),
      true,
    );
    const followedIssuesBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/me/followed-reports/issues?limit=50',
      headers: { cookie: follower.cookie },
    });
    assert.equal(followedIssuesBefore.statusCode, 200, followedIssuesBefore.body);
    assert.equal(
      (followedIssuesBefore.json() as { items: Array<{ id: string }> }).items
        .some((item) => item.id === editionA.id),
      true,
    );

    const editionCase = await reportTarget(app, owner, {
      kind: 'digest_edition', id: editionA.id, seriesId: hiddenSeries.id,
    });
    const hideEdition = await moderate(
      app, moderator, editionCase,
      { kind: 'digest_edition', id: editionA.id, seriesId: hiddenSeries.id },
      'hide_public',
    );
    assert.equal(hideEdition.statusCode, 201);
    const hiddenIssue = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}/issues/${editionA.id}`,
    });
    assert.equal(hiddenIssue.statusCode, 404);
    const staleIssueJson = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}/issues/${editionA.id}`,
      headers: { 'if-none-match': issueBeforeEtag },
    });
    assert.notEqual(staleIssueJson.statusCode, 304, 'origin must re-evaluate edition hide before 304');
    assert.equal(staleIssueJson.statusCode, 404);
    assert.equal(staleIssueJson.body.includes('hidden body one'), false);
    const staleIssueHtml = await app.inject({
      method: 'GET',
      url: `/reports/${hiddenSeries.slug}/issues/${editionA.id}`,
      headers: {
        accept: 'text/html',
        'if-none-match': issueHtmlEtag,
      },
    });
    assert.notEqual(staleIssueHtml.statusCode, 304);
    assert.equal(staleIssueHtml.statusCode, 404);
    assert.equal(staleIssueHtml.body.includes('Hidden Issue One'), false);
    assert.equal(staleIssueHtml.body.includes('hidden body one'), false);
    const siblingIssue = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}/issues/${editionB.id}`,
    });
    assert.equal(siblingIssue.statusCode, 200, siblingIssue.body);
    const issuesListingAfterHideA = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}/issues?limit=50`,
    });
    assert.equal(issuesListingAfterHideA.statusCode, 200, issuesListingAfterHideA.body);
    const listedAfterHideA = (issuesListingAfterHideA.json() as {
      items: Array<{ id: string; title: string; url: string | null; summary: string | null; sourceCollectionSlug?: string | null; state?: string }>;
    }).items;
    // Position is kept (B published after A, ordinal 2 sorts first): the
    // hidden edition stays in place as an inert tombstone.
    assert.deepEqual(listedAfterHideA.map((issue) => issue.id), [editionB.id, editionA.id]);
    const tombstoneA = listedAfterHideA.find((issue) => issue.id === editionA.id)!;
    assert.equal(tombstoneA.state, 'hidden');
    assert.equal(tombstoneA.title, 'Issue hidden');
    assert.equal(tombstoneA.url, null);
    assert.equal(tombstoneA.summary, null);
    assert.equal(tombstoneA.sourceCollectionSlug ?? null, null);
    assert.equal(listedAfterHideA.some((issue) => issue.title === 'Hidden Issue One'), false);
    const listedIssueB = listedAfterHideA.find((issue) => issue.id === editionB.id)!;
    assert.equal(listedIssueB.state ?? 'visible', 'visible');
    assert.equal(listedIssueB.title, 'Hidden Issue Two');
    assert.equal(listedIssueB.url !== null, true);
    const seriesAfterEditionHide = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}`,
    });
    const seriesIssues = (seriesAfterEditionHide.json() as { issues: Array<{ id: string; title: string; state?: string }> }).issues;
    const seriesTombstoneA = seriesIssues.find((issue) => issue.id === editionA.id);
    assert.equal(seriesTombstoneA?.state, 'hidden');
    assert.equal(seriesTombstoneA?.title, 'Issue hidden');
    assert.equal(seriesIssues.some((issue) => issue.title === 'Hidden Issue One'), false);
    assert.ok(seriesIssues.some((issue) => issue.id === editionB.id && issue.state !== 'hidden'));
    // The series-level live source slug comes from the first VISIBLE issue.
    assert.equal(
      (seriesAfterEditionHide.json() as { sourceCollectionSlug?: string }).sourceCollectionSlug,
      sourceA.slug,
    );
    const seriesHtmlBeforeHide = await app.inject({
      method: 'GET',
      url: `/reports/${hiddenSeries.slug}`,
      headers: { accept: 'text/html' },
    });
    assert.equal(seriesHtmlBeforeHide.statusCode, 200, seriesHtmlBeforeHide.body);
    const seriesHtmlEtag = String(seriesHtmlBeforeHide.headers.etag);
    assert.match(seriesHtmlEtag, /^W\/"html-/u);
    assert.equal(seriesHtmlBeforeHide.headers['last-modified'], undefined);

    const delistEditionBCase = await reportTarget(app, owner, {
      kind: 'digest_edition', id: editionB.id, seriesId: hiddenSeries.id,
    });
    const delistEditionB = await moderate(
      app, moderator, delistEditionBCase,
      { kind: 'digest_edition', id: editionB.id, seriesId: hiddenSeries.id },
      'delist',
    );
    assert.equal(delistEditionB.statusCode, 201);
    const issuesListingAfterDelistB = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}/issues?limit=50`,
    });
    assert.equal(issuesListingAfterDelistB.statusCode, 200, issuesListingAfterDelistB.body);
    const listedAfterDelistB = (issuesListingAfterDelistB.json() as { items: Array<{ id: string }> }).items;
    assert.equal(listedAfterDelistB.some((issue) => issue.id === editionB.id), false);
    const delistedDirect = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}/issues/${editionB.id}`,
    });
    assert.equal(delistedDirect.statusCode, 200, delistedDirect.body);
    const delistedDirectHead = await app.inject({
      method: 'HEAD',
      url: `/reports/${hiddenSeries.slug}/issues/${editionB.id}`,
      headers: { accept: 'text/html' },
    });
    assert.equal(delistedDirectHead.statusCode, 200);

    const seriesCase = await reportTarget(app, owner, { kind: 'digest_series', id: listedSeries.id });
    const delist = await moderate(
      app, moderator, seriesCase, { kind: 'digest_series', id: listedSeries.id }, 'delist',
    );
    assert.equal(delist.statusCode, 201);
    const directory = await app.inject({ method: 'GET', url: '/api/v1/public-reports?limit=100' });
    assert.equal(directory.statusCode, 200, directory.body);
    const directoryItems = (directory.json() as { items: Array<{ slug: string }> }).items;
    assert.equal(directoryItems.some((item) => item.slug === listedSeries.slug), false);
    assert.equal(directoryItems.some((item) => item.slug === hiddenSeries.slug), true);
    const listedDirect = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${listedSeries.slug}`,
    });
    assert.equal(listedDirect.statusCode, 200, listedDirect.body);
    const listedIssueDirect = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${listedSeries.slug}/issues/${listedEdition.id}`,
    });
    assert.equal(listedIssueDirect.statusCode, 200, listedIssueDirect.body);
    const listedHtml = await app.inject({
      method: 'GET',
      url: `/reports/${listedSeries.slug}/issues/${listedEdition.id}`,
      headers: { accept: 'text/html' },
    });
    assert.equal(listedHtml.statusCode, 200, listedHtml.body);
    const listedIssuesListing = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${listedSeries.slug}/issues?limit=50`,
    });
    assert.equal(listedIssuesListing.statusCode, 200, listedIssuesListing.body);
    assert.equal(
      (listedIssuesListing.json() as { items: Array<{ id: string }> }).items
        .some((issue) => issue.id === listedEdition.id),
      true,
    );
    const listedMarkdown = await app.inject({
      method: 'GET',
      url: `/reports/${listedSeries.slug}/issues/${listedEdition.id}`,
      headers: { accept: 'text/markdown' },
    });
    assert.equal(listedMarkdown.statusCode, 200, listedMarkdown.body);
    const sitemapAfterDelist = await app.inject({ method: 'GET', url: '/sitemap-reports.xml' });
    assert.equal(sitemapAfterDelist.statusCode, 200, sitemapAfterDelist.body);
    assert.equal(sitemapAfterDelist.body.includes(listedSeries.slug), false);
    const sitemapHead = await app.inject({ method: 'HEAD', url: '/sitemap-reports.xml' });
    assert.equal(sitemapHead.statusCode, 200);

    const hideSeriesCase = await reportTarget(app, owner, { kind: 'digest_series', id: hiddenSeries.id });
    const hideSeries = await moderate(
      app, moderator, hideSeriesCase, { kind: 'digest_series', id: hiddenSeries.id }, 'hide_public',
    );
    assert.equal(hideSeries.statusCode, 201);
    const outbox = await runtime.pool.query<{ handler_name: string; event_type: string }>(
      `select handler_name, event_type from outbox_events
        where aggregate_scope=$1 and handler_name=$2`,
      [hiddenSeries.id, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME],
    );
    assert.equal(outbox.rows.length >= 1, true);
    const hiddenSeriesGet = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}`,
    });
    assert.equal(hiddenSeriesGet.statusCode, 404);
    const staleSeriesJson = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}`,
      headers: { 'if-none-match': publicBeforeEtag },
    });
    assert.notEqual(staleSeriesJson.statusCode, 304, 'origin must re-evaluate series hide before 304');
    assert.equal(staleSeriesJson.statusCode, 404);
    const hiddenIssueAfterSeries = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}/issues/${editionB.id}`,
    });
    assert.equal(hiddenIssueAfterSeries.statusCode, 404);
    const hiddenIssuesListing = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${hiddenSeries.slug}/issues?limit=50`,
    });
    assert.equal(hiddenIssuesListing.statusCode, 404);
    const hiddenHtml = await app.inject({
      method: 'GET',
      url: `/reports/${hiddenSeries.slug}`,
      headers: {
        accept: 'text/html',
        'if-none-match': seriesHtmlEtag,
      },
    });
    assert.notEqual(hiddenHtml.statusCode, 304);
    assert.equal(hiddenHtml.statusCode, 404);
    assert.equal(hiddenHtml.body.includes('Hidden Issue Two'), false);
    const hiddenMarkdown = await app.inject({
      method: 'GET',
      url: `/reports/${hiddenSeries.slug}`,
      headers: { accept: 'text/markdown' },
    });
    assert.equal(hiddenMarkdown.statusCode, 404);
    assert.equal(hiddenMarkdown.body.includes('Hidden Issue Two'), false);
    const hiddenHead = await app.inject({
      method: 'HEAD',
      url: `/reports/${hiddenSeries.slug}`,
      headers: { accept: 'text/html' },
    });
    assert.equal(hiddenHead.statusCode, 404);
    const ownerSeries = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${hiddenSeries.id}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(ownerSeries.statusCode, 200, ownerSeries.body);

    const followedSeries = await app.inject({
      method: 'GET',
      url: '/api/v1/me/followed-reports?limit=50',
      headers: { cookie: follower.cookie },
    });
    assert.equal(followedSeries.statusCode, 200, followedSeries.body);
    // #21: the followed list keeps the hidden digest's slot as an inert
    // tombstone instead of letting it vanish silently.
    const followedSeriesItems = (followedSeries.json() as {
      items: Array<{ id: string; title: string; summary: string | null; slug: string | null; hiddenPublic?: boolean }>;
    }).items;
    const followedSeriesTombstone = followedSeriesItems.find((item) => item.id === hiddenSeries.id);
    assert.ok(followedSeriesTombstone, 'hidden series stays listed in the followed feed');
    assert.equal(followedSeriesTombstone.title, 'Digest hidden');
    assert.equal(followedSeriesTombstone.summary, null);
    assert.equal(followedSeriesTombstone.slug, null);
    assert.equal(followedSeriesTombstone.hiddenPublic, true);
    assert.equal(followedSeriesItems.some((item) => item.title === 'Hidden Weekly'), false);
    const followed = await app.inject({
      method: 'GET',
      url: '/api/v1/me/followed-reports/issues?limit=50',
      headers: { cookie: follower.cookie },
    });
    assert.equal(followed.statusCode, 200, followed.body);
    const followedItems = (followed.json() as {
      items: Array<{
        id: string;
        titleSnapshot: string;
        summarySnapshot: string | null;
        state: string;
        series: { title: string; slug: string | null; hiddenPublic?: boolean };
      }>;
    }).items;
    // Both editions keep their keyset slots as tombstones: series-level hide
    // conceals every edition of the digest in the followed timeline.
    assert.deepEqual(
      followedItems.map((item) => item.id),
      [editionB.id, editionA.id],
    );
    for (const item of followedItems) {
      assert.equal(item.state, 'hidden');
      assert.equal(item.titleSnapshot, 'Issue hidden');
      assert.equal(item.summarySnapshot, null);
      assert.equal(item.series.title, 'Digest hidden');
      assert.equal(item.series.slug, null);
      assert.equal(item.series.hiddenPublic, true);
    }
    assert.equal(followedItems.some((item) => item.titleSnapshot.startsWith('Hidden Issue')), false);

    const sourceCase = await reportTarget(app, owner, { kind: 'collection', id: sourceB.id });
    const hideSource = await moderate(
      app, moderator, sourceCase, { kind: 'collection', id: sourceB.id }, 'hide_public',
    );
    assert.equal(hideSource.statusCode, 201);
    const listedAfterSourceHide = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${listedSeries.slug}`,
    });
    assert.equal(listedAfterSourceHide.statusCode, 200, listedAfterSourceHide.body);
    const listedAfterBody = listedAfterSourceHide.json() as {
      issues: Array<{ id: string; sourceCollectionSlug: string; summary: string | null }>;
      sourceCollectionSlug?: string;
    };
    assert.equal(listedAfterBody.issues.length, 0);
    assert.equal(listedAfterBody.sourceCollectionSlug, undefined);
    const listedIssueAfterSourceHide = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${listedSeries.slug}/issues/${listedEdition.id}`,
    });
    assert.equal(listedIssueAfterSourceHide.statusCode, 404);
    assert.equal(listedIssueAfterSourceHide.body.includes('listed body one'), false);
    const sourcePublic = await app.inject({ method: 'GET', url: `/api/v1/collections/${sourceB.slug}` });
    assert.equal(sourcePublic.statusCode, 404);

    await runtime.pool.query(
      `update collections set visibility = 'private' where id = $1`,
      [sourceB.id],
    );
    const listedAfterPrivate = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${listedSeries.slug}/issues/${listedEdition.id}`,
    });
    assert.equal(listedAfterPrivate.statusCode, 404);
    assert.equal(listedAfterPrivate.body.includes('Beta Source'), false);

    const mcp = createReportMcpReadToolPort(reportsUnitOfWork, {
      active: { id: 'k', secret: Buffer.alloc(32, 1).toString('base64') },
      retained: [],
    });
    const anonymous = createMcpApplicationContext({
      principal: {
        kind: 'anonymous', principalId: 'public', resourceAudience: 'a', securityEpoch: 'e',
      },
      scopes: [],
      abortSignal: new AbortController().signal,
      budgets: { maxDepth: 16, maxNodes: 10, maxBytes: 4000, maxOperations: 10 },
      correlationId: 'cg05',
    });
    const mcpGet = await mcp.callTool(anonymous, 'reports.get', { slug: hiddenSeries.slug });
    assert.equal(mcpGet.kind, 'rejected');
    const mcpIssues = await mcp.callTool(anonymous, 'reports.issues.list', { slug: hiddenSeries.slug });
    assert.equal(mcpIssues.kind, 'rejected');
    const mcpListedIssues = await mcp.callTool(anonymous, 'reports.issues.list', { slug: listedSeries.slug });
    assert.equal(mcpListedIssues.kind, 'complete');
    if (mcpListedIssues.kind === 'complete') {
      const items = (mcpListedIssues.structuredContent as { items: Array<{ id: string; summary?: string | null }> }).items;
      assert.equal(items.some((issue) => issue.id === listedEdition.id), false);
    }
    const mcpList = await mcp.callTool(anonymous, 'reports.list', { limit: 50 });
    assert.equal(mcpList.kind, 'complete');
    if (mcpList.kind === 'complete') {
      const items = (mcpList.structuredContent as { items: Array<{ slug: string }> }).items;
      assert.equal(items.some((item) => item.slug === hiddenSeries.slug), false);
      assert.equal(items.some((item) => item.slug === listedSeries.slug), false);
    }

    const htmlDirectory = await app.inject({
      method: 'GET', url: '/reports', headers: { accept: 'text/html' },
    });
    assert.equal(htmlDirectory.statusCode, 200, htmlDirectory.body);
    assert.equal(htmlDirectory.body.includes('Hidden Weekly'), false);
    assert.equal(htmlDirectory.body.includes('Listed Weekly'), false);
    const htmlDirectoryHead = await app.inject({
      method: 'HEAD', url: '/reports', headers: { accept: 'text/html' },
    });
    assert.equal(htmlDirectoryHead.statusCode, 200);

    const routes = createGovernanceCollectionControlRoutes({
      provider: { async purge() {} },
      publicationOrigin: ORIGIN,
      productOrigin: ORIGIN,
    });
    assert.equal(routes.length, 3);
    assert.equal(routes.every((route) => route.handlerName === GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME), true);
  });

  test('origin skips reportCache after hide_public even when a stale reader is composed', async () => {
    const cachedTitle = 'cg05-cached-pre-hide-body';
    const canned = (slug: string): PublicReportSeries => ({
      id: 'cached-series',
      title: cachedTitle,
      summary: 'cached pre-hide summary',
      slug,
      visibility: 'public',
      indexable: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      issues: [],
    });
    const reportCache: ReportCacheReader = {
      series: async (_unit, slug) => canned(slug),
      issue: async (_unit, slug) => ({
        series: canned(slug),
        issue: {
          id: 'cached-issue',
          title: cachedTitle,
          summary: null,
          publishedAt: '2026-01-01T00:00:00.000Z',
          url: `https://know-n.com/reports/${slug}/issues/cached-issue`,
          issueKey: 'w1',
          editionOrdinal: 1,
          periodStart: null,
          periodEnd: null,
          sourceCollectionSlug: 'cached-source',
        },
      }),
      directory: async () => ({ items: [canned('cached-slug')], nextCursor: null }),
    };
    const { app, owner, moderator, reportsUnitOfWork } = await harness({ reportCache });
    await grantModerator(moderator.accountId);
    const source = await publishCollection(app, owner, 'Cache Skip Source', 'cg05-cache-skip-source');
    const digest = await publishDigest(reportsUnitOfWork, owner, {
      title: 'Cache Skip Weekly',
      slug: 'cg05-cache-skip',
      sourceId: source.id,
      issues: [{ key: 'w1', title: 'Cache Skip Issue', summary: 'origin body' }],
    });
    const seriesCase = await reportTarget(app, owner, { kind: 'digest_series', id: digest.id });
    const hideSeries = await moderate(
      app, moderator, seriesCase, { kind: 'digest_series', id: digest.id }, 'hide_public',
    );
    assert.equal(hideSeries.statusCode, 201);

    const json = await app.inject({ method: 'GET', url: `/api/v1/public-reports/${digest.slug}` });
    assert.equal(json.statusCode, 404, json.body);
    assert.equal(json.body.includes(cachedTitle), false);
    const html = await app.inject({
      method: 'GET',
      url: `/reports/${digest.slug}`,
      headers: { accept: 'text/html' },
    });
    assert.equal(html.statusCode, 404, html.body);
    assert.equal(html.body.includes(cachedTitle), false);
  });

  test('follow state read conceals a hide_public series', async () => {
    const { app, owner, follower, moderator, reportsUnitOfWork } = await harness();
    await grantModerator(moderator.accountId);
    const source = await publishCollection(app, owner, 'Follow Source', 'cg05-follow-source');
    const digest = await publishDigest(reportsUnitOfWork, owner, {
      title: 'Follow Weekly',
      slug: 'cg05-follow-weekly',
      sourceId: source.id,
      issues: [{ key: 'f1', title: 'Follow Issue', summary: 'follow body' }],
    });
    const follow = await followDigestSeries(reportsUnitOfWork, {
      actor: {
        principalId: follower.subjectId,
        subjectId: follower.subjectId,
        profileId: follower.accountId,
      },
      commandId: crypto.randomUUID(),
      seriesId: digest.id,
    });
    assert.equal(follow.kind, 'succeeded');

    const stateBefore = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${digest.id}/follow`,
      headers: { cookie: follower.cookie },
    });
    assert.equal(stateBefore.statusCode, 200, stateBefore.body);
    assert.equal((stateBefore.json() as { following: boolean }).following, true);

    const seriesCase = await reportTarget(app, owner, { kind: 'digest_series', id: digest.id });
    const hideSeries = await moderate(
      app, moderator, seriesCase, { kind: 'digest_series', id: digest.id }, 'hide_public',
    );
    assert.equal(hideSeries.statusCode, 201);

    const stateAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${digest.id}/follow`,
      headers: { cookie: follower.cookie },
    });
    assert.equal(stateAfter.statusCode, 404,
      'hide_public must conceal the follow state read (existence + follower count)');
  });
});
