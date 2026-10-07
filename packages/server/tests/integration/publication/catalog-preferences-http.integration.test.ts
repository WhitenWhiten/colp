import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresCatalogPreferencesQuery,
  createPostgresCatalogPreferencesUnitOfWork,
} from '../../../src/infrastructure/governance/postgres-catalog-preferences.js';
import { createPostgresExploreCreatorsQueryPort } from '../../../src/infrastructure/identity/index.js';
import { createPostgresSharedExposureFactsPort } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresExplorePageReadPort,
  createPostgresSearchCatalogDisplayTargetPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createPostgresSearchAuthorityPort,
  createPostgresSearchCandidatePort,
} from '../../../src/infrastructure/search/index.js';
import { createPostgresReportUnitOfWork } from '../../../src/infrastructure/reports/index.js';
import {
  createSearchCursorSigner,
  executeSearchQuery,
} from '../../../src/modules/search/index.js';
import {
  createSession,
  ensureAccountFromOidcIdentity,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import {
  createExploreGovernanceCursorSigner,
  EXPLORE_GOVERNANCE_CURSOR_PURPOSE,
} from '../../../src/modules/governance/application/explore-cursor.js';
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
const HMAC = Buffer.alloc(32, 11).toString('base64url');
const CREATE_COMMAND = '11111111-1111-4111-8111-111111111111';
const CATALOG_COMMAND = '22222222-2222-4222-8222-222222222222';
const PREF_COMMAND = '33333333-3333-4333-8333-333333333333';
const PREF_REPLAY = '33333333-3333-4333-8333-333333333333';
const PREF_CHANGED = '44444444-4444-4444-8444-444444444444';

type ApiApp = ReturnType<typeof buildApiApp>;
interface Client {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly subjectId: string;
}

describeWithPostgres('CG-01 catalog preferences HTTP', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('catalog_prefs_cg01');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  }, 120_000);

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table catalog_preferences, product_command_receipts, outbox_events, audit_events,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, nodes, collections, resource_id_ledger,
      digest_editions, digest_members, digest_series,
      oidc_login_transactions, sessions, account_identities, profile_handles, profiles, accounts cascade`);
  });

  afterAll(async () => isolated?.close());

  async function harness(enabled = true): Promise<{
    app: ApiApp;
    client: Client;
    identityUnitOfWork: IdentityUnitOfWork;
  }> {
    const config = loadConfig({
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
      KNOWN_FEATURE_CONTENT_GOVERNANCE: enabled ? 'true' : 'false',
      KNOWN_FEATURE_REPORTS: 'true',
      KNOWN_FEATURE_REPORTS_PUBLIC: 'true',
      ...(enabled ? { GOVERNANCE_CURSOR_HMAC_KEY: HMAC } : {}),
    });
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db);
    const client = await issueSession(identityUnitOfWork);
    const app = buildApiApp({
      config,
      identityUnitOfWork,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      catalogPreferencesUnitOfWork: createPostgresCatalogPreferencesUnitOfWork(runtime.db),
      catalogPreferencesQuery: createPostgresCatalogPreferencesQuery(runtime.db),
      explorePageQuery: createPostgresExplorePageReadPort(runtime),
      exploreCreatorsQuery: createPostgresExploreCreatorsQueryPort(runtime.db),
      reportsUnitOfWork: createPostgresReportUnitOfWork(runtime.db),
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      searchRateLimiter: memoryExploreDirectoryLimiter(),
      searchQuery: {
        execute: (input) => executeSearchQuery({
          candidates: createPostgresSearchCandidatePort(runtime.db),
          authority: createPostgresSearchAuthorityPort(runtime.db),
          cursors: createSearchCursorSigner({
            current: { id: 'cg01-search', key: 'cg01-search-cursor-secret-material' },
          }),
          clock: { now: () => new Date() },
          sharedExposure: createPostgresSharedExposureFactsPort(runtime),
        }, input),
        loadCatalogDisplayTargets: (items) => createPostgresSearchCatalogDisplayTargetPort(runtime).load(items),
      },
    });
    return { app, client, identityUnitOfWork };
  }

  async function issueSession(
    unitOfWork: IdentityUnitOfWork,
    identity: { readonly subject: string; readonly email: string; readonly handle: string } = {
      subject: 'catalog-pref-subject',
      email: 'catalog@example.test',
      handle: 'catalog-owner',
    },
  ): Promise<Client> {
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example/realms/known',
        subject: identity.subject,
        email: identity.email,
        displayName: 'Catalog Owner',
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

  async function publishIndexedCollection(
    app: ApiApp,
    client: Client,
    title: string,
    slug: string,
  ): Promise<{ readonly id: string; readonly slug: string }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutationHeaders(client, crypto.randomUUID(), 'application/json'),
      payload: { kind: 'bookmarks', title, summary: `${title} summary` },
    });
    assert.equal(created.statusCode, 201, created.body);
    const body = created.json() as { collection: { id: string; etag: string } };
    const published = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${body.collection.id}`,
      headers: mutationHeaders(client, crypto.randomUUID(), 'application/merge-patch+json', body.collection.etag),
      payload: { visibility: 'public', publicationSlug: slug, allowSearchIndexing: true },
    });
    assert.equal(published.statusCode, 200, published.body);
    return { id: body.collection.id, slug };
  }

  function mutationHeaders(client: Client, commandId: string, mediaType: string, ifMatch?: string) {
    return {
      cookie: client.cookie,
      origin: ORIGIN,
      'x-csrf-token': client.csrfToken,
      'known-command-id': commandId,
      'content-type': mediaType,
      ...(ifMatch ? { 'if-match': ifMatch } : {}),
    };
  }

  test('collection catalog GET/PATCH, replay, and preference CAS through real auth', async () => {
    const { app, client, identityUnitOfWork } = await harness();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutationHeaders(client, CREATE_COMMAND, 'application/json'),
      payload: { kind: 'bookmarks', title: 'Catalog Notes', summary: 'tagged' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const collectionId = (created.json() as { collection: { id: string; etag: string } }).collection.id;
    const collectionEtag = (created.json() as { collection: { etag: string } }).collection.etag;

    const missing = await app.inject({ method: 'GET', url: `/api/v1/collections/${collectionId}/catalog` });
    assert.equal(missing.statusCode, 401);
    assert.equal(errorCode(missing), 'authentication_required');

    const nonemptyGet = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: { cookie: client.cookie, 'content-type': 'application/json' },
      payload: { extra: true },
    });
    assert.equal(nonemptyGet.statusCode, 400);
    assert.equal(errorCode(nonemptyGet), 'invalid_request');

    const extraQuery = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}/catalog?foo=1`,
      headers: { cookie: client.cookie },
    });
    assert.equal(extraQuery.statusCode, 400);

    const catalogGet = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: { cookie: client.cookie },
    });
    assert.equal(catalogGet.statusCode, 200, catalogGet.body);
    assert.equal(catalogGet.headers['cache-control'], 'private, no-store');
    const initial = catalogGet.json() as { tags: string[]; language: string | null; revision: string };
    assert.deepEqual(Object.keys(initial).sort(), ['language', 'revision', 'tags']);
    assert.deepEqual(initial.tags, []);
    assert.equal(initial.language, null);
    const catalogEtag = catalogGet.headers.etag as string;
    assert.equal(catalogEtag, collectionEtag);

    const emptyPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: mutationHeaders(client, CATALOG_COMMAND, 'application/merge-patch+json', catalogEtag),
      payload: {},
    });
    assert.equal(emptyPatch.statusCode, 400);
    assert.equal(errorCode(emptyPatch), 'invalid_request');

    const wrongType = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: mutationHeaders(client, '12121212-1212-4121-8121-121212121212', 'application/json', catalogEtag),
      payload: { tags: ['design'] },
    });
    assert.equal(wrongType.statusCode, 415);

    const nullTags = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: mutationHeaders(client, '55555555-5555-4555-8555-555555555555', 'application/merge-patch+json', catalogEtag),
      payload: { tags: null },
    });
    assert.equal(nullTags.statusCode, 400);

    const unknownKey = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: mutationHeaders(client, '66666666-6666-4666-8666-666666666666', 'application/merge-patch+json', catalogEtag),
      payload: { tags: ['ok'], extra: true },
    });
    assert.equal(unknownKey.statusCode, 400);

    const missingIfMatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: mutationHeaders(client, '77777777-7777-4777-8777-777777777777', 'application/merge-patch+json'),
      payload: { tags: ['design'] },
    });
    assert.equal(missingIfMatch.statusCode, 428);

    const weak = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: {
        ...mutationHeaders(client, '88888888-8888-4888-8888-888888888888', 'application/merge-patch+json'),
        'if-match': 'W/"1"',
      },
      payload: { tags: ['design'] },
    });
    assert.equal(weak.statusCode, 400);

    const star = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: {
        ...mutationHeaders(client, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'application/merge-patch+json'),
        'if-match': '*',
      },
      payload: { tags: ['design'] },
    });
    assert.equal(star.statusCode, 400);

    const foreign = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/not-a-collection-id/catalog',
      headers: { cookie: client.cookie },
    });
    assert.equal(foreign.statusCode, 404);

    const catalogHead = await app.inject({
      method: 'HEAD',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: { cookie: client.cookie },
    });
    assert.equal(catalogHead.statusCode, 405);

    const catalogPost = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: { cookie: client.cookie },
    });
    assert.equal(catalogPost.statusCode, 405);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: mutationHeaders(client, CATALOG_COMMAND, 'application/merge-patch+json', catalogEtag),
      payload: { tags: ['design'], language: 'EN-us' },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    const updated = patched.json() as { tags: string[]; language: string | null; revision: string };
    assert.deepEqual(Object.keys(updated).sort(), ['language', 'revision', 'tags']);
    assert.deepEqual(updated.tags, ['design']);
    assert.equal(updated.language, 'en-US');
    const newEtag = patched.headers.etag as string;
    assert.notEqual(newEtag, catalogEtag);

    const persisted = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: { cookie: client.cookie },
    });
    assert.equal(persisted.statusCode, 200, persisted.body);
    assert.deepEqual(persisted.json(), patched.json());
    assert.equal(persisted.headers.etag, newEtag);

    const replay = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: mutationHeaders(client, CATALOG_COMMAND, 'application/merge-patch+json', catalogEtag),
      payload: { tags: ['design'], language: 'EN-us' },
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), patched.json());

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: mutationHeaders(client, '99999999-9999-4999-8999-999999999999', 'application/merge-patch+json', catalogEtag),
      payload: { tags: ['other'] },
    });
    assert.equal(stale.statusCode, 412);

    const changedCatalogFingerprint = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: mutationHeaders(client, CATALOG_COMMAND, 'application/merge-patch+json', newEtag),
      payload: { tags: ['other'] },
    });
    assert.equal(changedCatalogFingerprint.statusCode, 409);

    const stranger = await issueSession(identityUnitOfWork, {
      subject: 'catalog-stranger-subject',
      email: 'stranger@example.test',
      handle: 'catalog-stranger',
    });
    const concealed = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(concealed.statusCode, 404);

    const unauthPrefs = await app.inject({ method: 'GET', url: '/api/v1/me/catalog-preferences' });
    assert.equal(unauthPrefs.statusCode, 401);
    assert.equal(errorCode(unauthPrefs), 'authentication_required');

    const prefs = await app.inject({
      method: 'GET',
      url: '/api/v1/me/catalog-preferences',
      headers: { cookie: client.cookie },
    });
    assert.equal(prefs.statusCode, 200, prefs.body);
    const virtual = prefs.json() as {
      revision: string;
      hiddenTags: string[];
      hiddenOwnerAccountIds: string[];
      hiddenTitleKeywords: string[];
      preferredLanguages: string[];
      updatedAt: string;
    };
    assert.deepEqual(Object.keys(virtual).sort(), [
      'hiddenOwnerAccountIds', 'hiddenTags', 'hiddenTitleKeywords', 'preferredLanguages', 'revision', 'updatedAt',
    ]);
    assert.equal(virtual.revision, '1');
    assert.deepEqual(virtual.hiddenTags, []);
    assert.deepEqual(virtual.hiddenOwnerAccountIds, []);
    assert.deepEqual(virtual.hiddenTitleKeywords, []);
    assert.deepEqual(virtual.preferredLanguages, []);
    assert.match(virtual.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const prefEtag = prefs.headers.etag as string;
    assert.equal(prefEtag, '"1"');
    const prefsAgain = await app.inject({
      method: 'GET',
      url: '/api/v1/me/catalog-preferences',
      headers: { cookie: client.cookie },
    });
    assert.equal((prefsAgain.json() as { updatedAt: string }).updatedAt, virtual.updatedAt);

    const prefsHead = await app.inject({
      method: 'HEAD',
      url: '/api/v1/me/catalog-preferences',
      headers: { cookie: client.cookie },
    });
    assert.equal(prefsHead.statusCode, 405);

    const emptyPrefs = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/catalog-preferences',
      headers: mutationHeaders(client, '14141414-1414-4141-8141-141414141414', 'application/json', prefEtag),
      payload: {},
    });
    assert.equal(emptyPrefs.statusCode, 400);

    const unknownPrefKey = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/catalog-preferences',
      headers: mutationHeaders(client, '15151515-1515-4151-8151-151515151515', 'application/json', prefEtag),
      payload: { hiddenTags: ['design'], extra: true },
    });
    assert.equal(unknownPrefKey.statusCode, 400);

    const prefPatch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/catalog-preferences',
      headers: mutationHeaders(client, PREF_COMMAND, 'application/json', prefEtag),
      payload: { hiddenTags: ['design'], preferredLanguages: ['en'] },
    });
    assert.equal(prefPatch.statusCode, 200, prefPatch.body);
    const savedPrefs = prefPatch.json() as { revision: string; hiddenTags: string[] };
    assert.equal(savedPrefs.revision, '2');
    assert.deepEqual(savedPrefs.hiddenTags, ['design']);

    const prefReplay = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/catalog-preferences',
      headers: mutationHeaders(client, PREF_REPLAY, 'application/json', '"1"'),
      payload: { hiddenTags: ['design'], preferredLanguages: ['en'] },
    });
    assert.equal(prefReplay.statusCode, 200, prefReplay.body);

    const changedFingerprint = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/catalog-preferences',
      headers: mutationHeaders(client, PREF_COMMAND, 'application/json', prefPatch.headers.etag as string),
      payload: { hiddenTags: ['other'] },
    });
    assert.equal(changedFingerprint.statusCode, 409);
    await app.close();
  });

  test('feature off hides catalog resources with 404', async () => {
    const { app, client } = await harness(false);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutationHeaders(client, CREATE_COMMAND, 'application/json'),
      payload: { kind: 'bookmarks', title: 'Off', summary: null },
    });
    const collectionId = (created.json() as { collection: { id: string } }).collection.id;
    const catalog = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: { cookie: client.cookie },
    });
    assert.equal(catalog.statusCode, 404);
    const catalogPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}/catalog`,
      headers: mutationHeaders(client, CATALOG_COMMAND, 'application/merge-patch+json', '"1"'),
      payload: { tags: ['design'] },
    });
    assert.equal(catalogPatch.statusCode, 404);
    const prefs = await app.inject({
      method: 'GET',
      url: '/api/v1/me/catalog-preferences',
      headers: { cookie: client.cookie },
    });
    assert.equal(prefs.statusCode, 404);
    const reportCatalog = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/any-report/catalog',
      headers: { cookie: client.cookie },
    });
    assert.equal(reportCatalog.statusCode, 404);
    const explore = await app.inject({ method: 'GET', url: '/api/v1/explore/collections' });
    assert.equal(explore.statusCode, 200);
    assert.equal(explore.headers['cache-control'], 'public, max-age=60');
    const languageOff = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?language=en' });
    assert.equal(languageOff.statusCode, 400);
    const oldCursor = Buffer.from(JSON.stringify({
      sort: 'updated', micros: '1', id: 'col-1',
    }), 'utf8').toString('base64url');
    const staleExplore = await app.inject({
      method: 'GET',
      url: `/api/v1/explore/collections?cursor=${encodeURIComponent(oldCursor)}`,
    });
    assert.equal(staleExplore.statusCode, 200);
    const publicReports = await app.inject({ method: 'GET', url: '/api/v1/public-reports' });
    assert.equal(publicReports.statusCode, 200);
    assert.equal(publicReports.headers['cache-control'], 'public, max-age=30, must-revalidate');
    await app.close();
  });

  test('Explore language is strict when governance is on and anonymous requests skip personal prefs', async () => {
    const { app, client } = await harness();
    const invalid = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?language=not%20a%20tag' });
    assert.equal(invalid.statusCode, 400);
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?language=en' });
    assert.equal(anonymous.statusCode, 200);
    assert.equal(anonymous.headers['cache-control'], 'public, max-age=0, must-revalidate');
    const authed = await app.inject({
      method: 'GET',
      url: '/api/v1/explore/collections',
      headers: { cookie: client.cookie },
    });
    assert.equal(authed.statusCode, 200);
    assert.equal(authed.headers['cache-control'], 'private, no-store');
    const emptyLanguage = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?language=' });
    assert.equal(emptyLanguage.statusCode, 400);
    const head = await app.inject({ method: 'HEAD', url: '/api/v1/explore/collections?language=en' });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['cache-control'], 'public, max-age=0, must-revalidate');
    const oldCursor = Buffer.from(JSON.stringify({
      sort: 'updated', micros: '1', id: 'col-1',
    }), 'utf8').toString('base64url');
    const staleExplore = await app.inject({
      method: 'GET',
      url: `/api/v1/explore/collections?cursor=${encodeURIComponent(oldCursor)}`,
    });
    assert.equal(staleExplore.statusCode, 400);
    const oversize = await app.inject({
      method: 'GET',
      url: `/api/v1/explore/collections?cursor=${'A'.repeat(513)}`,
    });
    assert.equal(oversize.statusCode, 400);
    assert.equal(errorCode(oversize), 'invalid_cursor');
    const publicInvalid = await app.inject({ method: 'GET', url: '/api/v1/public-reports?language=not%20a%20tag' });
    assert.equal(publicInvalid.statusCode, 400);
    const publicOk = await app.inject({ method: 'GET', url: '/api/v1/public-reports?language=en' });
    assert.equal(publicOk.statusCode, 200);
    assert.equal(publicOk.headers['cache-control'], 'public, max-age=0, must-revalidate');
    const truncatedQ = await app.inject({
      method: 'GET',
      url: `/api/v1/explore/collections?q=${'a'.repeat(300)}`,
    });
    assert.equal(truncatedQ.statusCode, 200);
    const invalidHead = await app.inject({ method: 'HEAD', url: '/api/v1/explore/collections?language=not%20a%20tag' });
    assert.equal(invalidHead.statusCode, 400);
    const signer = createExploreGovernanceCursorSigner(HMAC);
    try {
      const expired = signer.sign({
        v: 1,
        purpose: EXPLORE_GOVERNANCE_CURSOR_PURPOSE,
        sort: 'updated',
        language: null,
        viewer: null,
        prefRev: null,
        after: { micros: '1', id: 'col-1' },
        issuedAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T00:15:00.000Z',
      });
      const expiredResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/explore/collections?cursor=${encodeURIComponent(expired)}`,
      });
      assert.equal(expiredResponse.statusCode, 409);
      assert.equal(errorCode(expiredResponse), 'snapshot_expired');
    } finally {
      signer.destroy();
    }
    await app.close();
  });

  test('Explore personal mute fills after filter and invalidates cursors on preference revision change', async () => {
    const { app, client } = await harness();
    await seedPublicCollections(runtime, client.subjectId);
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/explore/collections?limit=1',
    });
    assert.equal(anonymous.statusCode, 200, anonymous.body);
    assert.equal((anonymous.json() as { items: Array<{ id: string }> }).items[0]?.id, 'cg01-hide');

    const prefs = await app.inject({
      method: 'GET',
      url: '/api/v1/me/catalog-preferences',
      headers: { cookie: client.cookie },
    });
    const prefPatch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/catalog-preferences',
      headers: mutationHeaders(client, PREF_COMMAND, 'application/json', prefs.headers.etag as string),
      payload: { hiddenTags: ['spam'] },
    });
    assert.equal(prefPatch.statusCode, 200, prefPatch.body);

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/explore/collections?limit=1',
      headers: { cookie: client.cookie },
    });
    assert.equal(filtered.statusCode, 200, filtered.body);
    const page = filtered.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(page.items[0]?.id, 'cg01-keep-a');
    assert.equal(typeof page.nextCursor, 'string');

    const anonymousAfterMute = await app.inject({
      method: 'GET',
      url: '/api/v1/explore/collections?limit=1',
    });
    assert.equal((anonymousAfterMute.json() as { items: Array<{ id: string }> }).items[0]?.id, 'cg01-hide');

    const leakedCursor = await app.inject({
      method: 'GET',
      url: `/api/v1/explore/collections?limit=1&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
    });
    assert.equal(leakedCursor.statusCode, 400);

    const nextPref = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/catalog-preferences',
      headers: mutationHeaders(client, PREF_CHANGED, 'application/json', prefPatch.headers.etag as string),
      payload: { hiddenTags: ['spam', 'other'] },
    });
    assert.equal(nextPref.statusCode, 200, nextPref.body);
    const reused = await app.inject({
      method: 'GET',
      url: `/api/v1/explore/collections?limit=1&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
      headers: { cookie: client.cookie },
    });
    assert.equal(reused.statusCode, 400);
    await app.close();
  });

  test('authenticated Search applies catalog mute, fills the page, and binds cursors to prefRev', async () => {
    const { app, client, identityUnitOfWork } = await harness();
    const other = await issueSession(identityUnitOfWork, {
      subject: 'catalog-search-other',
      email: 'search-other@example.test',
      handle: 'search-other',
    });
    const hidden = await publishIndexedCollection(app, other, 'cg01searchhit HiddenSpam Notes', 'cg01-search-hide');
    const keepA = await publishIndexedCollection(app, client, 'cg01searchhit Keep Alpha Notes', 'cg01-search-keep-a');
    const keepB = await publishIndexedCollection(app, client, 'cg01searchhit Keep Beta Notes', 'cg01-search-keep-b');
    const prefs = await app.inject({
      method: 'GET',
      url: '/api/v1/me/catalog-preferences',
      headers: { cookie: client.cookie },
    });
    const prefPatch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/catalog-preferences',
      headers: mutationHeaders(client, PREF_COMMAND, 'application/json', prefs.headers.etag as string),
      payload: { hiddenOwnerAccountIds: [other.accountId] },
    });
    assert.equal(prefPatch.statusCode, 200, prefPatch.body);

    const authed = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=cg01searchhit&type=collection&limit=2',
      headers: { cookie: client.cookie },
    });
    assert.equal(authed.statusCode, 200, authed.body);
    assert.equal(authed.headers['cache-control'], 'private, no-store');
    const authedPage = authed.json() as { items: Array<{ resourceId: string }>; page: { nextCursor: string | null } };
    const authedIds = authedPage.items.map((item) => item.resourceId);
    assert.equal(authedIds.includes(hidden.id), false);
    assert.ok(authedIds.includes(keepA.id) || authedIds.includes(keepB.id));
    assert.equal(authedPage.items.length, 2);

    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=cg01searchhit&type=collection&limit=3',
    });
    assert.equal(anonymous.statusCode, 200, anonymous.body);
    const anonymousIds = (anonymous.json() as { items: Array<{ resourceId: string }> }).items.map((item) => item.resourceId);
    assert.ok(anonymousIds.includes(hidden.id));

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=cg01searchhit&type=collection&limit=1',
      headers: { cookie: client.cookie },
    });
    const firstPage = first.json() as { page: { nextCursor: string | null } };
    assert.equal(typeof firstPage.page.nextCursor, 'string');
    const nextPref = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/catalog-preferences',
      headers: mutationHeaders(client, PREF_CHANGED, 'application/json', prefPatch.headers.etag as string),
      payload: { hiddenOwnerAccountIds: [other.accountId], hiddenTitleKeywords: ['beta'] },
    });
    assert.equal(nextPref.statusCode, 200, nextPref.body);
    const reused = await app.inject({
      method: 'GET',
      url: `/api/v1/search?q=cg01searchhit&type=collection&cursor=${encodeURIComponent(firstPage.page.nextCursor ?? '')}`,
      headers: { cookie: client.cookie },
    });
    assert.equal(reused.statusCode, 400);
    assert.equal(errorCode(reused), 'invalid_cursor');
    await app.close();
  });

  test('report catalog GET/PATCH, replay, and language filter through real auth', async () => {
    const { app, client, identityUnitOfWork } = await harness();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: mutationHeaders(client, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'application/json'),
      payload: { title: 'Catalog Digest', summary: 'series', slug: 'catalog-digest', visibility: 'private' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const reportId = (created.json() as { id: string }).id;
    const unauth = await app.inject({ method: 'GET', url: `/api/v1/reports/${reportId}/catalog` });
    assert.equal(unauth.statusCode, 401);
    const catalogGet = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: { cookie: client.cookie },
    });
    assert.equal(catalogGet.statusCode, 200, catalogGet.body);
    assert.equal(catalogGet.headers['cache-control'], 'private, no-store');
    const initial = catalogGet.json() as { tags: string[]; language: string | null; revision: string };
    assert.deepEqual(Object.keys(initial).sort(), ['language', 'revision', 'tags']);
    const etag = catalogGet.headers.etag as string;
    const emptyPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: mutationHeaders(client, 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1', 'application/merge-patch+json', etag),
      payload: {},
    });
    assert.equal(emptyPatch.statusCode, 400);
    const unknownKey = await app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: mutationHeaders(client, 'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2', 'application/merge-patch+json', etag),
      payload: { tags: ['weekly'], extra: true },
    });
    assert.equal(unknownKey.statusCode, 400);
    const missingIfMatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: mutationHeaders(client, 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3', 'application/merge-patch+json'),
      payload: { tags: ['weekly'] },
    });
    assert.equal(missingIfMatch.statusCode, 428);
    const wrongType = await app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: mutationHeaders(client, 'c4c4c4c4-c4c4-44c4-84c4-c4c4c4c4c4c4', 'application/json', etag),
      payload: { tags: ['weekly'] },
    });
    assert.equal(wrongType.statusCode, 415);
    const reportHead = await app.inject({
      method: 'HEAD',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: { cookie: client.cookie },
    });
    assert.equal(reportHead.statusCode, 405);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: mutationHeaders(client, CATALOG_COMMAND, 'application/merge-patch+json', etag),
      payload: { tags: ['weekly'], language: 'EN-us' },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    const catalog = patched.json() as { tags: string[]; language: string | null };
    assert.deepEqual(catalog.tags, ['weekly']);
    assert.equal(catalog.language, 'en-US');
    const persisted = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: { cookie: client.cookie },
    });
    assert.equal(persisted.statusCode, 200, persisted.body);
    assert.deepEqual(persisted.json(), patched.json());
    const replay = await app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: mutationHeaders(client, CATALOG_COMMAND, 'application/merge-patch+json', etag),
      payload: { tags: ['weekly'], language: 'EN-us' },
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), patched.json());
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: mutationHeaders(client, 'c5c5c5c5-c5c5-45c5-85c5-c5c5c5c5c5c5', 'application/merge-patch+json', etag),
      payload: { tags: ['other'] },
    });
    assert.equal(stale.statusCode, 412);
    const changedFingerprint = await app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: mutationHeaders(client, CATALOG_COMMAND, 'application/merge-patch+json', patched.headers.etag as string),
      payload: { tags: ['other'] },
    });
    assert.equal(changedFingerprint.statusCode, 409);
    const stranger = await issueSession(identityUnitOfWork, {
      subject: 'report-stranger-subject',
      email: 'report-stranger@example.test',
      handle: 'report-stranger',
    });
    const concealed = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${reportId}/catalog`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(concealed.statusCode, 404);
    const missingReport = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/not-a-report-id/catalog',
      headers: { cookie: client.cookie },
    });
    assert.equal(missingReport.statusCode, 404);
    await app.close();
  });
});

async function seedPublicCollections(
  database: DatabaseRuntime,
  ownerSubjectId: string,
): Promise<void> {
  const rows: Array<{
    id: string;
    title: string;
    updatedAt: string;
    tags: readonly string[];
    language: string;
  }> = [
    { id: 'cg01-hide', title: 'Hidden Spam Notes', updatedAt: '2026-08-22T12:00:00.000Z', tags: ['spam'], language: 'en' },
    { id: 'cg01-hide-2', title: 'More Hidden Spam', updatedAt: '2026-08-21T18:00:00.000Z', tags: ['spam'], language: 'en' },
    { id: 'cg01-keep-a', title: 'Keep Alpha Notes', updatedAt: '2026-08-21T12:00:00.000Z', tags: ['ok'], language: 'en' },
    { id: 'cg01-keep-b', title: 'Keep Beta Notes', updatedAt: '2026-08-20T12:00:00.000Z', tags: ['ok'], language: 'en' },
  ];
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    for (const row of rows) {
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [row.id, `${row.id}-root`],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at, updated_at,
           payload_json, payload_schema_version, payload_authority_status)
         values ($1, $2, $3, 'bookmarks', 'public', $4, 'r1', 'c1', 'p1', $1, $5::timestamptz, $5::timestamptz,
                 $6::jsonb, 1, 'backfilled')`,
        [
          row.id,
          ownerSubjectId,
          row.title,
          `${row.id}-root`,
          row.updatedAt,
          JSON.stringify({ extensions: { tags: row.tags, language: row.language } }),
        ],
      );
      await client.query(
        `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
         values ($1, $2, 'folder', true, $2, 'r1', 'ch1')`,
        [`${row.id}-root`, row.id],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
