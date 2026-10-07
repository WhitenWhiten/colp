import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresModerationCommandUnitOfWork,
  createPostgresModerationQueryPorts,
} from '../../../src/infrastructure/governance/postgres-moderation.js';
import { createPostgresModerationRoleUnitOfWork } from '../../../src/infrastructure/governance/postgres-moderation-roles.js';
import { createPostgresModerationStore } from '../../../src/infrastructure/governance/postgres-moderation-store.js';
import type { ModerationCaseRecord } from '../../../src/modules/governance/application/moderation-ports.js';
import { createPostgresPublicationMetadataReadPort } from '../../../src/infrastructure/publication/index.js';
import { createPostgresReportUnitOfWork } from '../../../src/infrastructure/reports/index.js';
import { grantModerationRole } from '../../../src/modules/governance/application/moderation-roles.js';
import {
  createSession,
  ensureAccountFromOidcIdentity,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import {
  attachDigestEdition,
  createDigestSeries,
  publishDigestEdition,
} from '../../../src/modules/reports/index.js';
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

type ApiApp = ReturnType<typeof buildApiApp>;
interface Client {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly subjectId: string;
}

describeWithPostgres('CG-02 report and case HTTP', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('moderation_cg02');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  }, 120_000);

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table community_comments, moderation_actions, moderation_evidence, moderation_cases, moderation_roles,
      catalog_preferences, product_command_receipts, outbox_events, audit_events,
      digest_runs, digest_schedules, digest_follows, digest_members, digest_editions, digest_series, digest_audit_events,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, nodes, collections, resource_id_ledger,
      oidc_login_transactions, sessions, account_identities, profile_handles, profiles, accounts cascade`);
  });

  afterAll(async () => isolated?.close());

  async function harness(enabled = true): Promise<{
    app: ApiApp;
    owner: Client;
    stranger: Client;
    moderator: Client;
    identityUnitOfWork: IdentityUnitOfWork;
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
      KNOWN_FEATURE_CONTENT_GOVERNANCE: enabled ? 'true' : 'false',
      KNOWN_FEATURE_REPORTS: 'true',
      KNOWN_FEATURE_REPORTS_PUBLIC: 'true',
      ...(enabled ? { GOVERNANCE_CURSOR_HMAC_KEY: HMAC } : {}),
    });
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db);
    const owner = await issueSession(identityUnitOfWork, {
      subject: 'moderation-owner',
      email: 'owner@example.test',
      handle: 'mod-owner',
    });
    const stranger = await issueSession(identityUnitOfWork, {
      subject: 'moderation-stranger',
      email: 'stranger@example.test',
      handle: 'mod-stranger',
    });
    const moderator = await issueSession(identityUnitOfWork, {
      subject: 'moderation-moderator',
      email: 'moderator@example.test',
      handle: 'mod-moderator',
    });
    const reportsUnitOfWork = createPostgresReportUnitOfWork(runtime.db);
    const app = buildApiApp({
      config,
      identityUnitOfWork,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      moderationCommandUnitOfWork: createPostgresModerationCommandUnitOfWork(runtime.db),
      moderationQueryPorts: createPostgresModerationQueryPorts(runtime.db),
      reportsUnitOfWork,
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      publicationMetadataQuery: {
        reads: createPostgresPublicationMetadataReadPort(runtime),
        origin: config.publication.origin,
      },
    });
    return { app, owner, stranger, moderator, identityUnitOfWork, reportsUnitOfWork };
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

  function errorCode(response: { readonly json: () => unknown }): string | undefined {
    const body = response.json() as { error?: { code?: string } };
    return body.error?.code;
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

  async function createCollection(app: ApiApp, client: Client, commandId: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutationHeaders(client, commandId),
      payload: { kind: 'bookmarks', title: 'Notes', summary: 'private notes' },
    });
    assert.equal(created.statusCode, 201, created.body);
    return (created.json() as { collection: { id: string } }).collection.id;
  }

  async function publishUnlistedCollection(
    app: ApiApp,
    client: Client,
    title: string,
    slug: string,
  ): Promise<{ readonly id: string; readonly slug: string; readonly rootId: string }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutationHeaders(client, crypto.randomUUID()),
      payload: { kind: 'bookmarks', title, summary: `${title} summary` },
    });
    assert.equal(created.statusCode, 201, created.body);
    const body = created.json() as {
      collection: { id: string; etag: string };
      root: { id: string };
    };
    const published = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${body.collection.id}`,
      headers: mutationHeaders(client, crypto.randomUUID(), {
        'content-type': 'application/merge-patch+json',
        'if-match': body.collection.etag,
      }),
      payload: { visibility: 'unlisted', publicationSlug: slug, allowSearchIndexing: false },
    });
    assert.equal(published.statusCode, 200, published.body);
    return { id: body.collection.id, slug, rootId: body.root.id };
  }

  async function publishPublicCollection(
    app: ApiApp,
    client: Client,
    title: string,
    slug: string,
  ): Promise<{ readonly id: string; readonly slug: string }> {
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

  async function createBookmark(
    app: ApiApp,
    client: Client,
    collectionId: string,
    rootId: string,
    title: string,
    url: string,
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collectionId}/nodes`,
      headers: mutationHeaders(client, crypto.randomUUID()),
      payload: {
        parentId: rootId,
        afterId: null,
        beforeId: null,
        node: {
          kind: 'bookmark',
          title,
          url,
          description: `${title} description`,
          tags: ['cg02'],
          visibility: 'inherit',
        },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    return (created.json() as { node: { id: string } }).node.id;
  }

  const CG02_PATHS = [
    { method: 'POST' as const, url: '/api/v1/moderation/reports' },
    { method: 'GET' as const, url: '/api/v1/me/moderation-reports' },
    { method: 'GET' as const, url: '/api/v1/me/moderation-reports/case_missing' },
    { method: 'GET' as const, url: '/api/v1/moderation/cases' },
    { method: 'GET' as const, url: '/api/v1/moderation/cases/case_missing' },
    { method: 'GET' as const, url: '/api/v1/moderation/cases/case_missing/evidence/ev_missing' },
  ];

  function assertMyCase(value: unknown): asserts value is Record<string, unknown> {
    assert.equal(typeof value, 'object');
    assert.ok(value);
    const record = value as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), [
      'category', 'createdAt', 'id', 'publicResolution', 'revision', 'status', 'target', 'updatedAt',
    ]);
    assert.equal(Object.hasOwn(record, 'description'), false);
    assert.equal(Object.hasOwn(record, 'reporterAccountId'), false);
    assert.equal(Object.hasOwn(record, 'internalNote'), false);
    assert.equal(Object.hasOwn(record, 'evidenceIds'), false);
    assert.equal(Object.hasOwn(record, 'actionIds'), false);
  }

  function assertOfficialCase(value: unknown): asserts value is {
    readonly case: Record<string, unknown>;
    readonly reporterAccountId: string;
    readonly description: string;
    readonly assignedToAccountId: string | null;
    readonly evidenceIds: readonly string[];
    readonly actionIds: readonly string[];
    readonly internalNote: string | null;
  } {
    assert.equal(typeof value, 'object');
    assert.ok(value);
    const record = value as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), [
      'actionIds', 'assignedToAccountId', 'case', 'description', 'evidenceIds', 'internalNote', 'reporterAccountId',
    ]);
    assertMyCase(record.case);
  }

  function assertEvidence(value: unknown): asserts value is Record<string, unknown> {
    assert.equal(typeof value, 'object');
    assert.ok(value);
    const record = value as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), [
      'capturedAt', 'caseId', 'id', 'sourceRevision', 'sourceUrl', 'target', 'text', 'title', 'truncated',
    ]);
    assert.equal(typeof record.truncated, 'boolean');
  }

  async function grantReviewer(accountId: string): Promise<void> {
    const granted = await createPostgresModerationRoleUnitOfWork(runtime.db).execute((ports) =>
      grantModerationRole(ports, {
        accountId,
        role: 'reviewer',
        reason: 'integration fixture',
      }));
    assert.equal(granted.changed, true);
    assert.ok(granted.auditId);
  }

  async function grantModerator(accountId: string): Promise<void> {
    const granted = await createPostgresModerationRoleUnitOfWork(runtime.db).execute((ports) =>
      grantModerationRole(ports, {
        accountId,
        role: 'moderator',
        reason: 'integration fixture',
      }));
    assert.equal(granted.changed, true);
    assert.ok(granted.auditId);
  }

  async function seedCollectionComment(
    commentId: string,
    collectionId: string,
    authorAccountId: string,
  ): Promise<void> {
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values ($1, 'community_comment', current_timestamp)`,
      [commentId],
    );
    await runtime.pool.query(
      `insert into community_comments(
         comment_id, target_kind, target_id, target_collection_id, target_series_id,
         target_generation, root_id, reply_to_id, depth, author_account_id, body, state,
         revision, created_at, updated_at)
       values ($1, 'collection', $2, null, null, 'static-v1', $1, null, 0, $3,
         'leftover comment', 'visible', 1, current_timestamp, current_timestamp)`,
      [commentId, collectionId, authorAccountId],
    );
  }

  async function reportDigestEdition(
    app: ApiApp,
    client: Client,
    edition: { readonly id: string; readonly seriesId: string },
    description: string,
  ): Promise<Awaited<ReturnType<ApiApp['inject']>>> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(client, crypto.randomUUID()),
      payload: {
        target: { kind: 'digest_edition', id: edition.id, seriesId: edition.seriesId },
        category: 'spam',
        description,
      },
    });
  }

  test('feature off returns 404 for every CG-02 operation', async () => {
    const { app, owner } = await harness(false);
    for (const route of CG02_PATHS) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: route.method === 'POST'
          ? mutationHeaders(owner, '11111111-1111-4111-8111-111111111111')
          : { cookie: owner.cookie },
        ...(route.method === 'POST'
          ? { payload: { target: { kind: 'collection', id: 'x' }, category: 'spam', description: 'ads' } }
          : {}),
      });
      assert.equal(response.statusCode, 404, `${route.method} ${route.url}`);
    }
  });

  test('submit, replay, open-case dedupe, and reporter reads through real auth', async () => {
    const { app, owner, stranger } = await harness();
    const collectionId = await createCollection(app, owner, '11111111-1111-4111-8111-111111111111');
    const body = {
      target: { kind: 'collection', id: collectionId },
      category: 'spam',
      description: 'unsolicited advertising',
    };

    const unauth = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'known-command-id': 'aaaaaaaa-1111-4111-8111-111111111111' },
      payload: body,
    });
    assert.equal(unauth.statusCode, 401);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, '22222222-2222-4222-8222-222222222222'),
      payload: { ...body, evidenceUrl: 'https://evil.test/shot.png' },
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(errorCode(unknown), 'invalid_request');

    const comment = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, '33333333-3333-4333-8333-333333333333'),
      payload: { target: { kind: 'comment', id: 'cmt_1' }, category: 'spam', description: 'comment spam' },
    });
    // Comments are a live report target; a missing comment conceals as 404.
    assert.equal(comment.statusCode, 404);
    assert.equal(errorCode(comment), 'resource_not_found');

    const foreign = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, '44444444-4444-4444-8444-444444444444'),
      payload: body,
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(errorCode(foreign), 'resource_not_found');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, '55555555-5555-4555-8555-555555555555'),
      payload: body,
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.headers['cache-control'], 'private, no-store');
    const mine = created.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(mine).sort(), [
      'category', 'createdAt', 'id', 'publicResolution', 'revision', 'status', 'target', 'updatedAt',
    ]);
    assert.equal(mine.status, 'submitted');
    assert.equal(Object.hasOwn(mine, 'description'), false);
    assert.equal(Object.hasOwn(mine, 'evidenceIds'), false);
    assert.equal(Object.hasOwn(mine, 'actionIds'), false);
    const caseId = mine.id as string;

    const storedCases = await runtime.db.selectFrom('moderation_cases').selectAll().execute();
    assert.equal(storedCases.length, 1);
    const storedEvidence = await runtime.db
      .selectFrom('moderation_evidence')
      .selectAll()
      .where('case_id', '=', caseId)
      .execute();
    assert.equal(storedEvidence.length, 1);
    assert.equal(await countPunitive(), 0);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, '55555555-5555-4555-8555-555555555555'),
      payload: body,
    });
    assert.equal(replay.statusCode, 201);
    assert.equal((replay.json() as { id: string }).id, caseId);

    const dedupe = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, '66666666-6666-4666-8666-666666666666'),
      payload: body,
    });
    assert.equal(dedupe.statusCode, 200, dedupe.body);
    assert.equal((dedupe.json() as { id: string }).id, caseId);
    const cases = await runtime.db.selectFrom('moderation_cases').selectAll().execute();
    assert.equal(cases.length, 1);

    const nonempty = await app.inject({
      method: 'GET',
      url: `/api/v1/me/moderation-reports/${caseId}`,
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      payload: { extra: true },
    });
    assert.equal(nonempty.statusCode, 400);

    const ownGet = await app.inject({
      method: 'GET',
      url: `/api/v1/me/moderation-reports/${caseId}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(ownGet.statusCode, 200);
    const ownBody = ownGet.json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(ownBody, 'reporterAccountId'), false);
    assert.equal(Object.hasOwn(ownBody, 'evidenceIds'), false);
    assert.equal(Object.hasOwn(ownBody, 'actionIds'), false);

    const strangerGet = await app.inject({
      method: 'GET',
      url: `/api/v1/me/moderation-reports/${caseId}`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(strangerGet.statusCode, 404);

    const unofficial = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/cases',
      headers: { cookie: owner.cookie },
    });
    assert.equal(unofficial.statusCode, 403);
    assert.equal(errorCode(unofficial), 'insufficient_permission');

    const granted = await createPostgresModerationRoleUnitOfWork(runtime.db).execute((ports) =>
      grantModerationRole(ports, {
        accountId: stranger.accountId,
        role: 'reviewer',
        reason: 'integration fixture',
      }));
    assert.equal(granted.changed, true);
    assert.ok(granted.auditId);

    const officialList = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/cases',
      headers: { cookie: stranger.cookie },
    });
    assert.equal(officialList.statusCode, 200, officialList.body);
    const page = officialList.json() as { items: Array<{ reporterAccountId?: string; description?: string; evidenceIds?: string[] }> };
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.reporterAccountId, owner.accountId);
    assert.equal(page.items[0]?.description, 'unsolicited advertising');
    const evidenceId = page.items[0]?.evidenceIds?.[0];
    assert.ok(evidenceId);

    const reporterEvidence = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/cases/${caseId}/evidence/${evidenceId}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(reporterEvidence.statusCode, 403);

    const officialEvidence = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/cases/${caseId}/evidence/${evidenceId}`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(officialEvidence.statusCode, 200, officialEvidence.body);
    const evidence = officialEvidence.json() as { truncated: boolean; sourceUrl: string | null };
    assert.equal(typeof evidence.truncated, 'boolean');
    assert.equal(evidence.sourceUrl, null);

    const head = await app.inject({
      method: 'HEAD',
      url: '/api/v1/me/moderation-reports',
      headers: { cookie: owner.cookie },
    });
    assert.equal(head.statusCode, 405);
  });

  test('comment reports conceal a private parent and keep owner access', async () => {
    const { app, owner, stranger } = await harness();
    const privateId = await createCollection(app, owner, crypto.randomUUID());
    await seedCollectionComment('cmt_private_parent', privateId, owner.accountId);
    const strangerPrivate = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: {
        target: { kind: 'comment', id: 'cmt_private_parent' },
        category: 'spam',
        description: 'comment on a private collection',
      },
    });
    assert.equal(strangerPrivate.statusCode, 404);
    assert.equal(errorCode(strangerPrivate), 'resource_not_found');
    const ownerPrivate = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: {
        target: { kind: 'comment', id: 'cmt_private_parent' },
        category: 'spam',
        description: 'owner leftover comment report',
      },
    });
    assert.equal(ownerPrivate.statusCode, 201, ownerPrivate.body);
    assertMyCase(ownerPrivate.json());

    const published = await publishPublicCollection(app, owner, 'Public Notes', 'cg02-comment-public');
    await seedCollectionComment('cmt_public_parent', published.id, owner.accountId);
    const strangerPublic = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: {
        target: { kind: 'comment', id: 'cmt_public_parent' },
        category: 'spam',
        description: 'comment on a public collection',
      },
    });
    assert.equal(strangerPublic.statusCode, 201, strangerPublic.body);
    assertMyCase(strangerPublic.json());
  });

  test('stranger can report unlisted collection, bookmark, and series they can open', async () => {
    const { app, owner, stranger, reportsUnitOfWork } = await harness();
    const collection = await publishUnlistedCollection(app, owner, 'Quiet Notes', 'cg02-unlisted-notes');
    const colpAccept = {
      accept: 'application/vnd.collection-protocol.collection+json;version=0.1',
    };
    const metadata = await app.inject({
      method: 'GET',
      url: `/colp/v0.1/collections/${collection.id}`,
      headers: { cookie: stranger.cookie, ...colpAccept },
    });
    assert.equal(metadata.statusCode, 200, metadata.body);

    const collectionReport = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: {
        target: { kind: 'collection', id: collection.id },
        category: 'spam',
        description: 'unsolicited advertising on an unlisted collection',
      },
    });
    assert.equal(collectionReport.statusCode, 201, collectionReport.body);
    assertMyCase(collectionReport.json());

    const bookmarkId = await createBookmark(
      app,
      owner,
      collection.id,
      collection.rootId,
      'Quiet Link',
      'https://example.test/quiet',
    );
    const bookmarkReport = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: {
        target: { kind: 'bookmark', id: bookmarkId, collectionId: collection.id },
        category: 'spam',
        description: 'unsolicited advertising on an unlisted bookmark',
      },
    });
    assert.equal(bookmarkReport.statusCode, 201, bookmarkReport.body);
    assertMyCase(bookmarkReport.json());

    const seriesSlug = 'cg02-unlisted-digest';
    const createdSeries = await createDigestSeries(reportsUnitOfWork, {
      actor: { principalId: owner.subjectId, subjectId: owner.subjectId },
      commandId: crypto.randomUUID(),
      title: 'Quiet Digest',
      summary: 'unlisted digest summary',
      slug: seriesSlug,
      visibility: 'unlisted',
      allowSearchIndexing: false,
    });
    assert.equal(createdSeries.kind, 'succeeded');
    if (createdSeries.kind !== 'succeeded') throw new Error('series create failed');
    const seriesGet = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${seriesSlug}`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(seriesGet.statusCode, 200, seriesGet.body);
    const seriesReport = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: {
        target: { kind: 'digest_series', id: createdSeries.value.id },
        category: 'spam',
        description: 'unsolicited advertising on an unlisted series',
      },
    });
    assert.equal(seriesReport.statusCode, 201, seriesReport.body);
    assertMyCase(seriesReport.json());

    const privateId = await createCollection(app, owner, crypto.randomUUID());
    const privateMetadata = await app.inject({
      method: 'GET',
      url: `/colp/v0.1/collections/${privateId}`,
      headers: { cookie: stranger.cookie, ...colpAccept },
    });
    assert.notEqual(privateMetadata.statusCode, 200);
    const privateReport = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: {
        target: { kind: 'collection', id: privateId },
        category: 'spam',
        description: 'unsolicited advertising on a private collection',
      },
    });
    assert.equal(privateReport.statusCode, 404);
    assert.equal(errorCode(privateReport), 'resource_not_found');
  });

  test('digest edition reports follow the direct public read standard', async () => {
    const { app, owner, stranger, moderator, reportsUnitOfWork } = await harness();
    const actor = { principalId: owner.subjectId, subjectId: owner.subjectId };
    const createdSeries = await createDigestSeries(reportsUnitOfWork, {
      actor,
      commandId: crypto.randomUUID(),
      title: 'Reportable Digest',
      summary: 'digest summary',
      slug: 'cg02-reportable-digest',
      visibility: 'public',
      allowSearchIndexing: true,
    });
    assert.equal(createdSeries.kind, 'succeeded');
    if (createdSeries.kind !== 'succeeded') throw new Error('series create failed');

    async function attachAndPublish(
      sourceId: string,
      issueKey: string,
      title: string,
    ): Promise<{ readonly id: string; readonly seriesId: string }> {
      const attached = await attachDigestEdition(reportsUnitOfWork, {
        actor,
        commandId: crypto.randomUUID(),
        seriesId: createdSeries.value.id,
        sourceCollectionId: sourceId,
        issueKey,
        titleSnapshot: title,
        summarySnapshot: `${title} body`,
      });
      assert.equal(attached.kind, 'succeeded');
      if (attached.kind !== 'succeeded') throw new Error('attach failed');
      const published = await publishDigestEdition(reportsUnitOfWork, {
        actor,
        commandId: crypto.randomUUID(),
        editionId: attached.value.id,
        expectedRevision: `"${attached.value.resourceRevision}"`,
      });
      assert.equal(published.kind, 'succeeded');
      return { id: attached.value.id, seriesId: createdSeries.value.id };
    }

    // A published edition sourced from an eligible public Collection remains
    // reportable by a stranger, exactly like the public issue GET.
    const source = await publishPublicCollection(app, owner, 'Live Source', 'cg02-live-source');
    const live = await attachAndPublish(source.id, 'cg02-live', 'Live Issue');
    const liveReport = await reportDigestEdition(app, stranger, live, 'spam on a live edition');
    assert.equal(liveReport.statusCode, 201, liveReport.body);
    assertMyCase(liveReport.json());

    // A draft (never published) edition is concealed even when its opaque ID
    // leaks, so no official evidence can be manufactured from it.
    const draftSource = await publishPublicCollection(app, owner, 'Draft Source', 'cg02-draft-source');
    const draft = await attachDigestEdition(reportsUnitOfWork, {
      actor,
      commandId: crypto.randomUUID(),
      seriesId: createdSeries.value.id,
      sourceCollectionId: draftSource.id,
      issueKey: 'cg02-draft',
      titleSnapshot: 'Draft Issue',
      summarySnapshot: 'draft body',
    });
    assert.equal(draft.kind, 'succeeded');
    const draftEdition = { id: draft.value.id, seriesId: createdSeries.value.id };
    const draftReport = await reportDigestEdition(app, stranger, draftEdition, 'spam on a draft');
    assert.equal(draftReport.statusCode, 404);
    assert.equal(errorCode(draftReport), 'resource_not_found');

    // A source that goes private after publication stops the report path too,
    // matching the public issue GET that CG-05 already turns into a 404.
    const privateSource = await publishPublicCollection(app, owner, 'Private Source', 'cg02-private-source');
    const privateEdition = await attachAndPublish(privateSource.id, 'cg02-private', 'Private Issue');
    await runtime.pool.query(`update collections set visibility = 'private' where id = $1`, [privateSource.id]);
    const privateGet = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${createdSeries.value.slug}/issues/${privateEdition.id}`,
    });
    assert.equal(privateGet.statusCode, 404, privateGet.body);
    const privateReport = await reportDigestEdition(app, stranger, privateEdition, 'spam after private');
    assert.equal(privateReport.statusCode, 404);
    assert.equal(errorCode(privateReport), 'resource_not_found');

    // An unlisted source under a public series is not reportable either: a
    // public series cannot override a source that is no longer an eligible
    // public live source.
    const unlistedSource = await publishPublicCollection(app, owner, 'Unlisted Source', 'cg02-unlisted-source');
    const unlistedEdition = await attachAndPublish(unlistedSource.id, 'cg02-unlisted', 'Unlisted Issue');
    await runtime.pool.query(`update collections set visibility = 'unlisted' where id = $1`, [unlistedSource.id]);
    const unlistedGet = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${createdSeries.value.slug}/issues/${unlistedEdition.id}`,
    });
    assert.equal(unlistedGet.statusCode, 404, unlistedGet.body);
    const unlistedReport = await reportDigestEdition(app, stranger, unlistedEdition, 'spam after unlisted');
    assert.equal(unlistedReport.statusCode, 404);
    assert.equal(errorCode(unlistedReport), 'resource_not_found');

    // An edition officially hide_public'd stops the report path as the public
    // issue GET does, so hidden content cannot be re-surfaced as evidence.
    await grantModerator(moderator.accountId);
    const hidden = await attachAndPublish(source.id, 'cg02-hidden', 'Hidden Issue');
    const hiddenCase = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: {
        target: { kind: 'digest_edition', id: hidden.id, seriesId: hidden.seriesId },
        category: 'spam',
        description: 'spam before hide',
      },
    });
    assert.equal(hiddenCase.statusCode, 201, hiddenCase.body);
    const hideAction = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: (hiddenCase.json() as { id: string }).id,
        target: { kind: 'digest_edition', id: hidden.id, seriesId: hidden.seriesId },
        action: 'hide_public',
        reason: 'hidden edition fixture',
      },
    });
    assert.equal(hideAction.statusCode, 201, hideAction.body);
    const hiddenGet = await app.inject({
      method: 'GET',
      url: `/api/v1/public-reports/${createdSeries.value.slug}/issues/${hidden.id}`,
    });
    assert.equal(hiddenGet.statusCode, 404, hiddenGet.body);
    const hiddenReport = await reportDigestEdition(app, stranger, hidden, 'spam after hide');
    assert.equal(hiddenReport.statusCode, 404);
    assert.equal(errorCode(hiddenReport), 'resource_not_found');
  });

  test('report targets follow current public readability for hide_public and private nodes', async () => {
    const { app, owner, stranger, moderator, reportsUnitOfWork } = await harness();
    await grantModerator(moderator.accountId);
    const colpAccept = { accept: 'application/vnd.collection-protocol.collection+json;version=0.1' };

    // -- hide_public'd collection is not reportable through the origin path --
    const hiddenColl = await publishPublicCollection(app, owner, 'Hidden Coll', 'cg02-hidden-coll');
    const hiddenCollCase = await app.inject({
      method: 'POST', url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: { target: { kind: 'collection', id: hiddenColl.id }, category: 'spam', description: 'before hide' },
    });
    assert.equal(hiddenCollCase.statusCode, 201, hiddenCollCase.body);
    const hideColl = await app.inject({
      method: 'POST', url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: (hiddenCollCase.json() as { id: string }).id,
        target: { kind: 'collection', id: hiddenColl.id },
        action: 'hide_public',
        reason: 'P1-A hidden collection fixture',
      },
    });
    assert.equal(hideColl.statusCode, 201, hideColl.body);
    const strangerCollReport = await app.inject({
      method: 'POST', url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: { target: { kind: 'collection', id: hiddenColl.id }, category: 'spam', description: 'hidden collection' },
    });
    assert.equal(strangerCollReport.statusCode, 404);
    assert.equal(errorCode(strangerCollReport), 'resource_not_found');
    const ownerCollReport = await app.inject({
      method: 'POST', url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { target: { kind: 'collection', id: hiddenColl.id }, category: 'spam', description: 'owner management' },
    });
    assert.equal(ownerCollReport.statusCode, 201, ownerCollReport.body);

    // -- a private bookmark node under an origin-readable collection is not
    // reportable by a stranger, but stays reportable by the owner --
    const privColl = await publishUnlistedCollection(app, owner, 'Priv Notes', 'cg02-priv-notes');
    const privateNodeCreated = await app.inject({
      method: 'POST', url: `/api/v1/collections/${privColl.id}/nodes`,
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: {
        parentId: privColl.rootId, afterId: null, beforeId: null,
        node: {
          kind: 'bookmark', title: 'Private Secret', url: 'https://example.test/secret',
          description: 'private description', tags: [], visibility: 'private',
        },
      },
    });
    assert.equal(privateNodeCreated.statusCode, 201, privateNodeCreated.body);
    const privateNodeId = (privateNodeCreated.json() as { node: { id: string } }).node.id;
    const strangerNodeReport = await app.inject({
      method: 'POST', url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: {
        target: { kind: 'bookmark', id: privateNodeId, collectionId: privColl.id },
        category: 'spam', description: 'private node probe',
      },
    });
    assert.equal(strangerNodeReport.statusCode, 404, strangerNodeReport.body);
    assert.equal(errorCode(strangerNodeReport), 'resource_not_found');
    const ownerNodeReport = await app.inject({
      method: 'POST', url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: {
        target: { kind: 'bookmark', id: privateNodeId, collectionId: privColl.id },
        category: 'spam', description: 'owner sees the node',
      },
    });
    assert.equal(ownerNodeReport.statusCode, 201, ownerNodeReport.body);

    // -- hide_public'd digest series is not reportable through the origin path --
    const actor = { principalId: owner.subjectId, subjectId: owner.subjectId };
    const hiddenSeries = await createDigestSeries(reportsUnitOfWork, {
      actor, commandId: crypto.randomUUID(),
      title: 'Hidden Series', summary: 'hidden summary',
      slug: 'cg02-hidden-series', visibility: 'public', allowSearchIndexing: true,
    });
    assert.equal(hiddenSeries.kind, 'succeeded');
    if (hiddenSeries.kind !== 'succeeded') throw new Error('series create failed');
    const hiddenSeriesCase = await app.inject({
      method: 'POST', url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: { target: { kind: 'digest_series', id: hiddenSeries.value.id }, category: 'spam', description: 'before hide' },
    });
    assert.equal(hiddenSeriesCase.statusCode, 201, hiddenSeriesCase.body);
    const hideSeries = await app.inject({
      method: 'POST', url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId: (hiddenSeriesCase.json() as { id: string }).id,
        target: { kind: 'digest_series', id: hiddenSeries.value.id },
        action: 'hide_public',
        reason: 'P1-A hidden series fixture',
      },
    });
    assert.equal(hideSeries.statusCode, 201, hideSeries.body);
    const strangerSeriesReport = await app.inject({
      method: 'POST', url: '/api/v1/moderation/reports',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: { target: { kind: 'digest_series', id: hiddenSeries.value.id }, category: 'spam', description: 'hidden series' },
    });
    assert.equal(strangerSeriesReport.statusCode, 404);
    assert.equal(errorCode(strangerSeriesReport), 'resource_not_found');
    const ownerSeriesReport = await app.inject({
      method: 'POST', url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { target: { kind: 'digest_series', id: hiddenSeries.value.id }, category: 'spam', description: 'owner management' },
    });
    assert.equal(ownerSeriesReport.statusCode, 201, ownerSeriesReport.body);
  });

  test('wrong methods are 405 on CG-02 reporter and case read routes', async () => {
    const { app, owner } = await harness();
    const collectionId = await createCollection(app, owner, '11111111-1111-4111-8111-111111111111');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, '22222222-2222-4222-8222-222222222222'),
      payload: {
        target: { kind: 'collection', id: collectionId },
        category: 'spam',
        description: 'unsolicited advertising',
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const caseId = (created.json() as { id: string }).id;

    const wrong = [
      { method: 'GET' as const, url: '/api/v1/moderation/reports' },
      { method: 'HEAD' as const, url: '/api/v1/me/moderation-reports' },
      { method: 'POST' as const, url: '/api/v1/me/moderation-reports' },
      { method: 'HEAD' as const, url: `/api/v1/me/moderation-reports/${caseId}` },
      { method: 'POST' as const, url: `/api/v1/me/moderation-reports/${caseId}` },
      { method: 'HEAD' as const, url: '/api/v1/moderation/cases' },
      { method: 'POST' as const, url: '/api/v1/moderation/cases' },
      { method: 'HEAD' as const, url: `/api/v1/moderation/cases/${caseId}` },
      { method: 'POST' as const, url: `/api/v1/moderation/cases/${caseId}/evidence/ev_missing` },
      { method: 'HEAD' as const, url: `/api/v1/moderation/cases/${caseId}/evidence/ev_missing` },
    ];
    for (const route of wrong) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie: owner.cookie },
      });
      assert.equal(response.statusCode, 405, `${route.method} ${route.url}`);
    }
  });

  test('list mine, official get, evidence schema, query negatives, and changed-fingerprint replay', async () => {
    const { app, owner, stranger } = await harness();
    const firstId = await createCollection(app, owner, '11111111-1111-4111-8111-111111111111');
    const secondId = await createCollection(app, owner, '12121212-1212-4121-8121-121212121212');
    const firstBody = {
      target: { kind: 'collection', id: firstId },
      category: 'spam',
      description: 'unsolicited advertising',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, '55555555-5555-4555-8555-555555555555'),
      payload: firstBody,
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.ok(String(created.headers.etag ?? '').startsWith('"'));
    const mine = created.json() as Record<string, unknown>;
    assertMyCase(mine);
    const caseId = mine.id as string;

    const missingFields = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
      payload: { target: firstBody.target, category: 'spam' },
    });
    assert.equal(missingFields.statusCode, 400);
    assert.equal(errorCode(missingFields), 'invalid_request');

    const missingCommand = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        'x-csrf-token': owner.csrfToken,
        'content-type': 'application/json',
      },
      payload: firstBody,
    });
    assert.equal(missingCommand.statusCode, 400);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, '55555555-5555-4555-8555-555555555555'),
      payload: { ...firstBody, description: 'a different complaint' },
    });
    assert.equal(changed.statusCode, 409);
    assert.equal(errorCode(changed), 'command_id_reused');

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, '77777777-7777-4777-8777-777777777777'),
      payload: {
        target: { kind: 'collection', id: secondId },
        category: 'harassment',
        description: 'targeted abuse',
      },
    });
    assert.equal(second.statusCode, 201, second.body);

    const unauthList = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-reports',
    });
    assert.equal(unauthList.statusCode, 401);

    const invalidStatus = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-reports?status=open',
      headers: { cookie: owner.cookie },
    });
    assert.equal(invalidStatus.statusCode, 400);
    assert.equal(errorCode(invalidStatus), 'invalid_query');

    const unknownQuery = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-reports?foo=1',
      headers: { cookie: owner.cookie },
    });
    assert.equal(unknownQuery.statusCode, 400);

    const invalidLimit = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-reports?limit=101',
      headers: { cookie: owner.cookie },
    });
    assert.equal(invalidLimit.statusCode, 400);
    assert.equal(errorCode(invalidLimit), 'invalid_query');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-reports',
      headers: { cookie: owner.cookie },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.headers['cache-control'], 'private, no-store');
    const page = listed.json() as { items: unknown[]; nextCursor: string | null };
    assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
    assert.equal(page.items.length, 2);
    assert.equal(page.nextCursor, null);
    for (const item of page.items) assertMyCase(item);

    const paged = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-reports?limit=1',
      headers: { cookie: owner.cookie },
    });
    assert.equal(paged.statusCode, 200, paged.body);
    const firstPage = paged.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(firstPage.items.length, 1);
    assert.equal(typeof firstPage.nextCursor, 'string');
    assert.ok((firstPage.nextCursor as string).length <= 2048);
    assert.match(firstPage.nextCursor as string, /^[A-Za-z0-9_-]+$/u);

    const nextPage = await app.inject({
      method: 'GET',
      url: `/api/v1/me/moderation-reports?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor as string)}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(nextPage.statusCode, 200, nextPage.body);
    const secondPage = nextPage.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(secondPage.items[0]?.id, firstPage.items[0]?.id);

    const tampered = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-reports?cursor=not-a-cursor',
      headers: { cookie: owner.cookie },
    });
    assert.equal(tampered.statusCode, 400);
    assert.equal(errorCode(tampered), 'invalid_cursor');

    const unofficialGet = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/cases/${caseId}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(unofficialGet.statusCode, 403);
    assert.equal(errorCode(unofficialGet), 'insufficient_permission');

    await grantReviewer(stranger.accountId);

    const officialGet = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/cases/${caseId}`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(officialGet.statusCode, 200, officialGet.body);
    assert.equal(officialGet.headers['cache-control'], 'private, no-store');
    assert.ok(String(officialGet.headers.etag ?? '').startsWith('"'));
    const official = officialGet.json();
    assertOfficialCase(official);
    assert.equal(official.reporterAccountId, owner.accountId);
    assert.equal(official.description, 'unsolicited advertising');
    assert.equal(official.assignedToAccountId, null);
    assert.equal(official.internalNote, null);
    assert.equal(official.case.id, caseId);
    assert.deepEqual(official.actionIds, []);
    const evidenceId = official.evidenceIds[0];
    assert.ok(evidenceId);

    const missingCase = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/cases/no_such_case',
      headers: { cookie: stranger.cookie },
    });
    assert.equal(missingCase.statusCode, 404);

    const officialList = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/cases?status=submitted',
      headers: { cookie: stranger.cookie },
    });
    assert.equal(officialList.statusCode, 200, officialList.body);
    const officialPage = officialList.json() as { items: unknown[]; nextCursor: string | null };
    assert.equal(officialPage.items.length, 2);
    assert.equal(officialPage.nextCursor, null);
    for (const item of officialPage.items) assertOfficialCase(item);

    const invalidAssignee = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/cases?assignee=***',
      headers: { cookie: stranger.cookie },
    });
    assert.equal(invalidAssignee.statusCode, 400);
    assert.equal(errorCode(invalidAssignee), 'invalid_query');

    const evidence = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/cases/${caseId}/evidence/${evidenceId}`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(evidence.statusCode, 200, evidence.body);
    assert.equal(evidence.headers['cache-control'], 'private, no-store');
    const snapshot = evidence.json();
    assertEvidence(snapshot);
    assert.equal(snapshot.caseId, caseId);
    assert.equal(snapshot.id, evidenceId);
    assert.equal(snapshot.sourceUrl, null);
    assert.deepEqual(snapshot.target, { kind: 'collection', id: firstId });

    const missingEvidence = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/cases/${caseId}/evidence/no_such_evidence`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(missingEvidence.statusCode, 404);
  });

  test('report rate is consumed at HTTP admission after ten requests', async () => {
    const { app, owner } = await harness();
    const collectionId = await createCollection(app, owner, '11111111-1111-4111-8111-111111111111');
    const body = {
      target: { kind: 'collection', id: collectionId },
      category: 'spam',
      description: 'unsolicited advertising',
    };
    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/moderation/reports',
        headers: mutationHeaders(owner, `aaaaaaa${index}-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`),
        payload: body,
      });
      assert.ok(response.statusCode === 201 || response.statusCode === 200, response.body);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      payload: body,
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(errorCode(limited), 'rate_limited');
    assert.ok(Number(limited.headers['retry-after']) >= 1);
  });


test('CG-F008 a primary-key collision is a real error, not duplicate_open', async () => {
  const store = createPostgresModerationStore(isolated.runtime.db as never);
  const record: ModerationCaseRecord = {
    id: 'cg008-collision-case',
    reporterAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    target: { kind: 'collection', id: 'cg008-collection' },
    targetFingerprint: 'cg008-fingerprint',
    category: 'spam',
    description: 'cg008 fixture',
    status: 'submitted',
    publicResolution: null,
    assignedToAccountId: null,
    internalNote: null,
    revision: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    evidenceIds: [],
    actionIds: [],
  };
  // Seed an accounts row because insertCase FK-references the reporter.
  await isolated.runtime.pool.query(
    `insert into accounts(id, subject_id, status) values ($1, 'cg008-reporter', 'active')
     on conflict (id) do nothing`, [record.reporterAccountId]);
  assert.equal(await store.insertCase({ ...record }), 'inserted');
  // Identical fingerprint must dedupe; a PRIMARY-KEY collision must NOT be
  // classified as duplicate_open (it throws instead of the 500-misroute).
  const dedupe = await store.insertCase({ ...record, id: 'cg008-collision-case-2' });
  assert.equal(dedupe, 'duplicate_open');
  await assert.rejects(() => store.insertCase({ ...record }),
    (error: unknown) => (error as { code?: string }).code !== '23505'
      || (error as { constraint?: string }).constraint === 'moderation_cases_pkey',
    'a primary-key collision must surface as a constraint error, not duplicate_open');
});

  async function countPunitive(): Promise<number> {
    const result = await sql<{ actions: string }>`
      SELECT count(*)::text AS actions FROM moderation_actions
    `.execute(runtime.db);
    return Number(result.rows[0]?.actions ?? 0);
  }
});
