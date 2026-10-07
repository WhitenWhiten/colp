import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsEditorReadUnitOfWork,
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
import { createWebShellCache, toPublicShellMarkdownNode } from '../../../src/infrastructure/http/index.js';
import {
  createPostgresExplorePageReadPort,
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationNodeCountReadPort,
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
  createPostgresSearchAuthorityPort,
  createPostgresSearchCandidatePort,
} from '../../../src/infrastructure/search/index.js';
import { grantModerationRole } from '../../../src/modules/governance/application/moderation-roles.js';
import {
  createPublicationCursorKeyring,
  getPublicationSnapshotPage,
} from '../../../src/modules/publication/index.js';
import {
  createSearchCursorSigner,
  executeSearchQuery,
} from '../../../src/modules/search/index.js';
import { createProductEditorCursorSigner } from '../../../src/modules/collections/index.js';
import { PUBLIC_SHELL_FIXTURE } from '../../unit/publication/public-shell-fixture.js';
import {
  createSession,
  ensureAccountFromOidcIdentity,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import { GOVERNANCE_BOOKMARK_CONTROL_HANDLER_NAME } from '../../../src/infrastructure/governance/postgres-moderation-outbox.js';
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
const CURSOR_KEY = { id: 'cg04-a', secret: Buffer.alloc(32, 91).toString('base64') };
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
);

/** Actual bookmark public exits covered by this suite. Empty cells are not N/A. */
export const BOOKMARK_CONTROL_SURFACES = Object.freeze([
  { url: 'GET/HEAD /api/v1/collections/{slug}', media: 'json nodes', control: 'hide_public tombstones the page node, snapshot still omits it; sibling stays; origin before body', permission: 'anonymous vs owner member' },
  { url: 'GET/HEAD /colp/v0.1/collections/{id}/snapshot', media: 'colp snapshot', control: 'hide_public omits node; sibling stays; origin before 304', permission: 'anonymous' },
  { url: 'GET /c/{slug} /share/{slug} /path/{slug} /graph/{slug}', media: 'html/md/OG', control: 'snapshot outline omits hidden bookmark', permission: 'anonymous' },
  { url: 'GET /api/v1/search?type=node', media: 'json', control: 'SQL delist+hide before page', permission: 'anonymous' },
  { url: 'GET /api/v1/favicon/{faviconId}', media: 'image', control: 'origin hide_public before body', permission: 'anonymous object' },
  { url: 'GET /api/v1/collections/{id}/editor', media: 'json', control: 'owner editor not 403', permission: 'owner' },
  { url: 'PATCH /api/v1/collections/{id}/nodes/{nodeId}', media: 'json', control: 'owner write after hide', permission: 'owner' },
] as const);

type ApiApp = ReturnType<typeof buildApiApp>;
interface Client {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly subjectId: string;
}

describeWithPostgres('CG-04 bookmark hide/delist surfaces', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('moderation_cg04');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  }, 120_000);

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table moderation_actions, moderation_evidence, moderation_cases, moderation_roles,
      catalog_preferences, product_command_receipts, outbox_events, audit_events,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, bookmark_icons, nodes, collections, resource_id_ledger,
      oidc_login_transactions, sessions, account_identities, profile_handles, profiles, accounts cascade`);
  });

  afterAll(async () => isolated?.close());

  async function harness(): Promise<{
    app: ApiApp;
    owner: Client;
    moderator: Client;
    identityUnitOfWork: IdentityUnitOfWork;
    config: ReturnType<typeof loadConfig>;
    faviconStore: {
      put(objectId: string, body: Buffer, contentType: string): Promise<void>;
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
      KNOWN_FEATURE_PUBLIC_SHELL_META: 'true',
      WEB_SHELL_ORIGIN: 'http://web:80',
      GOVERNANCE_CURSOR_HMAC_KEY: HMAC,
    });
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db);
    const owner = await issueSession(identityUnitOfWork, {
      subject: 'cg04-owner', email: 'owner@example.test', handle: 'cg04owner',
    });
    const moderator = await issueSession(identityUnitOfWork, {
      subject: 'cg04-mod', email: 'mod@example.test', handle: 'cg04mod',
    });
    const cursors = createPublicationCursorKeyring({ active: CURSOR_KEY, retained: [] });
    const collectionControl = createPostgresModerationActionMethods(runtime.db);
    const directoryReads = createPostgresPublicationDirectoryReadPort(runtime);
    const nodeCount = createPostgresPublicationNodeCountReadPort(runtime);
    const faviconStore = {
      objects: new Map<string, { contentType: string; body: Buffer }>(),
      async put(objectId: string, body: Buffer, contentType: string) {
        this.objects.set(objectId, { contentType, body: Buffer.from(body) });
      },
      async get(objectId: string) {
        const row = this.objects.get(objectId);
        return row ? { contentType: row.contentType, body: Buffer.from(row.body) } : null;
      },
      async delete(objectId: string) {
        this.objects.delete(objectId);
      },
    };
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
      collectionsEditorReadUnitOfWork: createPostgresCollectionsEditorReadUnitOfWork(runtime.db, {
        cursorSigner: createProductEditorCursorSigner({
          current: config.productEditorCursor.current,
          previous: config.productEditorCursor.previous,
        }),
        cursorTtlMs: config.productEditorCursor.ttlMs,
        productOrigin: ORIGIN,
      }),
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
            current: { id: 'cg04-search', key: 'cg04-search-cursor-secret-material' },
          }),
          clock: { now: () => new Date() },
          sharedExposure,
        }, input),
      },
      faviconStore,
      faviconPublicAccess: {
        isHiddenPublic: (objectId) => collectionControl.isFaviconHiddenPublic(objectId),
      },
      publicShell: {
        cache: createWebShellCache({
          origin: 'http://web:80',
          fetch: async () => new Response(PUBLIC_SHELL_FIXTURE, {
            status: 200, headers: { etag: '"shell"' },
          }),
        }),
        loadNodeCountBySlug: (slug) => nodeCount.loadByPublicationSlug(slug),
        loadOwnerDisplayName: async () => 'Owner',
        loadSnapshotNodes: async (collectionId, signal) => {
          try {
            const page = await getPublicationSnapshotPage(snapshotQuery, {
              collectionId,
              principal: { kind: 'anonymous' },
              query: { limit: 500 },
            }, signal);
            return page.snapshot.nodes
              .map(toPublicShellMarkdownNode)
              .filter((node): node is NonNullable<typeof node> => node !== null);
          } catch {
            return null;
          }
        },
      },
    });
    return { app, owner, moderator, identityUnitOfWork, config, faviconStore };
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
    readonly rootId: string;
    readonly etag: string;
  }> {
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
      payload: { visibility: 'public', publicationSlug: slug, allowSearchIndexing: true },
    });
    assert.equal(published.statusCode, 200, published.body);
    return {
      id: body.collection.id,
      slug,
      rootId: body.root.id,
      etag: String(published.headers.etag ?? body.collection.etag),
    };
  }

  async function createBookmark(
    app: ApiApp,
    client: Client,
    collectionId: string,
    rootId: string,
    title: string,
    url: string,
  ): Promise<{ readonly id: string; readonly etag: string }> {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collectionId}/nodes`,
      headers: mutationHeaders(client, crypto.randomUUID()),
      payload: {
        parentId: rootId,
        afterId: null,
        beforeId: null,
        node: { kind: 'bookmark', title, url, description: `${title} description`, tags: ['cg04'], visibility: 'inherit' },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const body = created.json() as { node: { id: string; etag: string } };
    return { id: body.node.id, etag: body.node.etag };
  }

  async function bindFavicon(nodeId: string, collectionId: string): Promise<string> {
    const objectId = crypto.randomUUID();
    await runtime.pool.query(
      `insert into bookmark_icons (node_id, collection_id, object_id, content_type, byte_size, digest_sha256)
       values ($1, $2, $3::uuid, 'image/png', $4, $5)`,
      [nodeId, collectionId, objectId, PNG.byteLength, createHash('sha256').update(PNG).digest()],
    );
    return objectId;
  }

  async function reportBookmark(
    app: ApiApp,
    client: Client,
    collectionId: string,
    nodeId: string,
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(client, crypto.randomUUID()),
      payload: {
        target: { kind: 'bookmark', id: nodeId, collectionId },
        category: 'spam',
        description: 'phishing bookmark on a public collection',
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    return (created.json() as { id: string }).id;
  }

  async function grantModerator(accountId: string): Promise<void> {
    const granted = await createPostgresModerationRoleUnitOfWork(runtime.db).execute((ports) =>
      grantModerationRole(ports, { accountId, role: 'moderator', reason: 'cg04 fixture' }));
    assert.equal(granted.changed, true);
  }

  function bookmarkIds(nodes: readonly { id: string; kind?: string }[]): string[] {
    return nodes.filter((node) => node.kind === 'bookmark').map((node) => node.id);
  }

  test('surface inventory lists real bookmark exits only', () => {
    assert.ok(BOOKMARK_CONTROL_SURFACES.length >= 6);
    assert.equal(BOOKMARK_CONTROL_SURFACES.some((row) => /N\/A/u.test(row.control)), false);
  });

  test('unsupported pairs stay 400; bookmark hide/delist 201 only with matching case and surface enforcement', async () => {
    const { app, owner, moderator, faviconStore } = await harness();
    await grantModerator(moderator.accountId);
    const collection = await publishCollection(app, owner, 'Sibling Notes', 'cg04-siblings');
    const hidden = await createBookmark(
      app, owner, collection.id, collection.rootId, 'Hidden Alpha Bookmark', 'https://example.test/hidden-alpha',
    );
    const sibling = await createBookmark(
      app, owner, collection.id, collection.rootId, 'Live Beta Bookmark', 'https://example.test/live-beta',
    );
    const hiddenIcon = await bindFavicon(hidden.id, collection.id);
    const siblingIcon = await bindFavicon(sibling.id, collection.id);
    await faviconStore.put(hiddenIcon, PNG, 'image/png');
    await faviconStore.put(siblingIcon, PNG, 'image/png');
    const caseId = await reportBookmark(app, owner, collection.id, hidden.id);

    const digest = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'digest_series', id: collection.id },
        action: 'hide_public',
        reason: 'digest not enabled',
      },
    });
    assert.equal(digest.statusCode, 400);
    const account = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'account', id: owner.accountId },
        action: 'restrict_publication',
        reason: 'account not enabled',
      },
    });
    assert.equal(account.statusCode, 400);
    const lock = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'bookmark', id: hidden.id, collectionId: collection.id },
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
        caseId,
        target: { kind: 'comment', id: hidden.id },
        action: 'hide_comment',
        reason: 'comments do not exist',
      },
    });
    assert.equal(comment.statusCode, 400);
    const edition = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'digest_edition', id: hidden.id, seriesId: collection.id },
        action: 'hide_public',
        reason: 'digest not enabled',
      },
    });
    assert.equal(edition.statusCode, 400);
    const mismatchedParent = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'bookmark', id: hidden.id, collectionId: sibling.id },
        action: 'hide_public',
        reason: 'parent locator must match the case',
      },
    });
    assert.equal(mismatchedParent.statusCode, 400);

    const publicBefore = await app.inject({ method: 'GET', url: `/api/v1/collections/${collection.slug}` });
    assert.equal(publicBefore.statusCode, 200, publicBefore.body);
    const beforeNodes = bookmarkIds((publicBefore.json() as { nodes: Array<{ id: string; kind: string }> }).nodes);
    assert.equal(beforeNodes.includes(hidden.id), true);
    assert.equal(beforeNodes.includes(sibling.id), true);
    const publicHeadBefore = await app.inject({ method: 'HEAD', url: `/api/v1/collections/${collection.slug}` });
    assert.equal(publicHeadBefore.statusCode, 200);
    const snapshotBefore = await app.inject({
      method: 'GET',
      url: `/colp/v0.1/collections/${collection.id}/snapshot`,
      headers: { accept: 'application/vnd.collection-protocol.snapshot+json;version=0.1' },
    });
    assert.equal(snapshotBefore.statusCode, 200, snapshotBefore.body);
    const snapshotBeforeBody = snapshotBefore.json() as { snapshotId: string; revision: string };
    const snapshotBeforeEtag = String(snapshotBefore.headers.etag ?? '');
    assert.notEqual(snapshotBeforeEtag, '');
    assert.notEqual(snapshotBeforeBody.snapshotId, '');
    const hiddenFaviconBefore = await app.inject({ method: 'GET', url: `/api/v1/favicon/${hiddenIcon}` });
    assert.equal(hiddenFaviconBefore.statusCode, 200, hiddenFaviconBefore.body);
    const searchHiddenBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=Hidden%20Alpha%20Bookmark&type=node&limit=100',
    });
    assert.equal(searchHiddenBefore.statusCode, 200, searchHiddenBefore.body);
    assert.equal(
      (searchHiddenBefore.json() as { items: Array<{ resourceId: string }> }).items
        .some((item) => item.resourceId === hidden.id),
      true,
    );

    const hide = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'bookmark', id: hidden.id, collectionId: collection.id },
        action: 'hide_public',
        reason: 'hide this bookmark only',
      },
    });
    assert.equal(hide.statusCode, 201, hide.body);
    const hideAction = hide.json() as { id: string; state: string };
    assert.equal(hideAction.state, 'active');
    const visibility = await runtime.pool.query<{ visibility: string }>(
      `select visibility from collections where id=$1`,
      [collection.id],
    );
    assert.equal(visibility.rows[0]?.visibility, 'public');
    const outbox = await runtime.pool.query<{ handler_name: string; state: string }>(
      `select handler_name, state from outbox_events where handler_name=$1 and aggregate_id=$2`,
      [GOVERNANCE_BOOKMARK_CONTROL_HANDLER_NAME, hidden.id],
    );
    assert.equal(outbox.rows.length >= 1, true);
    assert.equal(outbox.rows[0]?.state, 'pending');

    const publicAfter = await app.inject({ method: 'GET', url: `/api/v1/collections/${collection.slug}` });
    assert.equal(publicAfter.statusCode, 200, publicAfter.body);
    const afterPage = publicAfter.json() as {
      nodes: Array<{ id: string; kind: string; title: string; url: string | null; iconUrl: string | null; state?: string }>;
    };
    const afterIds = bookmarkIds(afterPage.nodes);
    const hiddenTombstone = afterPage.nodes.find((node) => node.id === hidden.id);
    assert.ok(hiddenTombstone, 'hidden bookmark stays positioned as a tombstone on the public Reader page');
    assert.equal(hiddenTombstone.state, 'hidden');
    assert.equal(hiddenTombstone.title, 'Bookmark hidden');
    assert.equal(hiddenTombstone.url, null);
    assert.equal(hiddenTombstone.iconUrl, null);
    assert.equal(afterIds.includes(sibling.id), true, 'hiding A must not hide sibling B');
    assert.equal(afterPage.nodes.some((node) => node.title === 'Hidden Alpha Bookmark'), false);
    const publicHeadAfter = await app.inject({ method: 'HEAD', url: `/api/v1/collections/${collection.slug}` });
    assert.equal(publicHeadAfter.statusCode, 200);

    const ownerPage = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collection.slug}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(ownerPage.statusCode, 200, ownerPage.body);
    assert.equal(
      bookmarkIds((ownerPage.json() as { nodes: Array<{ id: string; kind: string }> }).nodes).includes(hidden.id),
      true,
      'owner member projection must still see the hidden bookmark',
    );

    const editor = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collection.id}/editor`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(editor.statusCode, 200, editor.body);
    const editorBody = editor.json() as {
      collection: { etag: string };
      nodes: Array<{ id: string }>;
    };
    assert.equal(editorBody.nodes.some((node) => node.id === hidden.id), true);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collection.id}/nodes/${hidden.id}`,
      headers: mutationHeaders(owner, crypto.randomUUID(), {
        'content-type': 'application/merge-patch+json',
        'if-match': hidden.etag,
      }),
      payload: { url: 'https://example.test/rewritten-hidden' },
    });
    assert.notEqual(patched.statusCode, 403);
    assert.equal(patched.statusCode, 200, patched.body);
    const afterRewrite = await app.inject({ method: 'GET', url: `/api/v1/collections/${collection.slug}` });
    assert.equal(afterRewrite.statusCode, 200, afterRewrite.body);
    const rewriteNodes = (afterRewrite.json() as { nodes: Array<{ id: string; kind: string; state?: string }> }).nodes;
    assert.equal(
      rewriteNodes.some((node) => node.id === hidden.id && node.state === 'hidden'),
      true,
      'URL rewrite must not drop the action',
    );

    const snapshot = await app.inject({
      method: 'GET',
      url: `/colp/v0.1/collections/${collection.id}/snapshot`,
      headers: { accept: 'application/vnd.collection-protocol.snapshot+json;version=0.1' },
    });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    const snapshotBody = snapshot.json() as {
      snapshotId: string;
      revision: string;
      nodes: Array<{ id: string; kind: string; title?: string }>;
    };
    assert.notEqual(snapshotBody.snapshotId, snapshotBeforeBody.snapshotId);
    const snapshotNodes = snapshotBody.nodes;
    const snapshotIds = bookmarkIds(snapshotNodes);
    assert.equal(snapshotIds.includes(hidden.id), false);
    assert.equal(snapshotIds.includes(sibling.id), true, 'snapshot must keep the live sibling');
    const snapshotHead = await app.inject({
      method: 'HEAD',
      url: `/colp/v0.1/collections/${collection.id}/snapshot`,
      headers: { accept: 'application/vnd.collection-protocol.snapshot+json;version=0.1' },
    });
    assert.equal(snapshotHead.statusCode, 200);
    const stale304 = await app.inject({
      method: 'GET',
      url: `/colp/v0.1/collections/${collection.id}/snapshot`,
      headers: {
        accept: 'application/vnd.collection-protocol.snapshot+json;version=0.1',
        'if-none-match': snapshotBeforeEtag,
      },
    });
    assert.notEqual(stale304.statusCode, 304, 'origin must re-evaluate hide before 304');
    assert.equal(stale304.statusCode, 200, stale304.body);
    assert.equal(
      bookmarkIds((stale304.json() as { nodes: Array<{ id: string; kind: string }> }).nodes).includes(hidden.id),
      false,
    );
    for (const url of [
      `/c/${collection.slug}`,
      `/share/${collection.slug}`,
      `/path/${collection.slug}`,
      `/graph/${collection.slug}`,
    ]) {
      const html = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      assert.equal(html.statusCode, 200, url);
      assert.equal(html.body.includes('Hidden Alpha Bookmark'), false, url);
      assert.equal(html.body.includes('Live Beta Bookmark'), true, url);
      assert.equal(html.body.includes('and 1 more'), false, url);
    }
    const searchHiddenAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=Hidden%20Alpha%20Bookmark&type=node&limit=100',
    });
    assert.equal(searchHiddenAfter.statusCode, 200, searchHiddenAfter.body);
    assert.equal(
      (searchHiddenAfter.json() as { items: Array<{ resourceId: string }> }).items
        .some((item) => item.resourceId === hidden.id),
      false,
      'hide_public must delist the bookmark from search before paging',
    );
    const searchSibling = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=Live%20Beta%20Bookmark&type=node&limit=100',
    });
    assert.equal(searchSibling.statusCode, 200, searchSibling.body);
    assert.equal(
      (searchSibling.json() as { items: Array<{ resourceId: string }> }).items
        .some((item) => item.resourceId === sibling.id),
      true,
    );
    const hiddenFaviconAfter = await app.inject({ method: 'GET', url: `/api/v1/favicon/${hiddenIcon}` });
    assert.equal(hiddenFaviconAfter.statusCode, 404);
    const siblingFaviconAfter = await app.inject({ method: 'GET', url: `/api/v1/favicon/${siblingIcon}` });
    assert.equal(siblingFaviconAfter.statusCode, 200, siblingFaviconAfter.body);

    const explore = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?limit=100' });
    assert.equal(explore.statusCode, 200, explore.body);
    assert.equal(
      (explore.json() as { items: Array<{ id: string }> }).items.some((item) => item.id === collection.id),
      true,
      'bookmark hide must not require or imply collection hide',
    );

    const copied = await createBookmark(
      app, owner, collection.id, collection.rootId, 'Copied Gamma Bookmark', 'https://example.test/rewritten-hidden',
    );
    const publicCopy = await app.inject({ method: 'GET', url: `/api/v1/collections/${collection.slug}` });
    const copyPage = publicCopy.json() as { nodes: Array<{ id: string; kind: string; state?: string }> };
    assert.equal(
      bookmarkIds(copyPage.nodes).includes(copied.id), true, 'new node id must not inherit the old penalty');
    assert.equal(copyPage.nodes.some((node) => node.id === copied.id && node.state === 'hidden'), false);
    assert.equal(copyPage.nodes.some((node) => node.id === hidden.id && node.state === 'hidden'), true);
  });

  test('delist excludes bookmark discovery but keeps known collection URL', async () => {
    const { app, owner, moderator } = await harness();
    await grantModerator(moderator.accountId);
    const collection = await publishCollection(app, owner, 'Listed Notes', 'cg04-listed');
    const listed = await createBookmark(
      app, owner, collection.id, collection.rootId, 'Discoverable Bookmark Title', 'https://example.test/discoverable',
    );
    const caseId = await reportBookmark(app, owner, collection.id, listed.id);
    const searchBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=Discoverable%20Bookmark%20Title&type=node&limit=100',
    });
    assert.equal(searchBefore.statusCode, 200, searchBefore.body);
    const beforeItems = (searchBefore.json() as { items: Array<{ resourceId: string }> }).items;
    assert.equal(beforeItems.some((item) => item.resourceId === listed.id), true);

    const delist = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'bookmark', id: listed.id, collectionId: collection.id },
        action: 'delist',
        reason: 'remove from search only',
      },
    });
    assert.equal(delist.statusCode, 201, delist.body);
    const listedPublic = await app.inject({ method: 'GET', url: `/api/v1/collections/${collection.slug}` });
    assert.equal(listedPublic.statusCode, 200, listedPublic.body);
    assert.equal(
      bookmarkIds((listedPublic.json() as { nodes: Array<{ id: string; kind: string }> }).nodes).includes(listed.id),
      true,
      'delist must keep the known collection URL listing',
    );
    const searchAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=Discoverable%20Bookmark%20Title&type=node&limit=100',
    });
    assert.equal(searchAfter.statusCode, 200, searchAfter.body);
    const afterItems = (searchAfter.json() as { items: Array<{ resourceId: string }> }).items;
    assert.equal(afterItems.some((item) => item.resourceId === listed.id), false);
  });

  test('hide_public keeps blocking replaced and deleted favicon object URLs', async () => {
    const { app, owner, moderator, faviconStore } = await harness();
    await grantModerator(moderator.accountId);
    const collection = await publishCollection(app, owner, 'Favicon History Notes', 'cg04-favicon-history');
    const bookmark = await createBookmark(
      app, owner, collection.id, collection.rootId, 'Iconed Bookmark', 'https://example.test/iconed',
    );

    async function uploadIcon(commandId: string): Promise<string> {
      const uploaded = await app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.id}/nodes/${bookmark.id}/favicon`,
        headers: mutationHeaders(owner, commandId, { 'content-type': 'image/png' }),
        payload: PNG,
      });
      assert.equal(uploaded.statusCode, 200, uploaded.body);
      const view = uploaded.json() as { iconUrl?: string | null };
      assert.ok(view.iconUrl);
      return view.iconUrl.split('/').pop() ?? '';
    }

    const firstObjectId = await uploadIcon(crypto.randomUUID());
    const firstBefore = await app.inject({ method: 'GET', url: `/api/v1/favicon/${firstObjectId}` });
    assert.equal(firstBefore.statusCode, 200, firstBefore.body);

    const caseId = await reportBookmark(app, owner, collection.id, bookmark.id);
    const hide = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'bookmark', id: bookmark.id, collectionId: collection.id },
        action: 'hide_public',
        reason: 'favicon history fixture',
      },
    });
    assert.equal(hide.statusCode, 201, hide.body);

    // Replacing the icon through the real upload route best-effort deletes
    // the old object; re-add it to the store to simulate a failed cleanup and
    // verify hide_public still blocks the historical URL.
    const secondObjectId = await uploadIcon(crypto.randomUUID());
    assert.notEqual(secondObjectId, firstObjectId);
    await faviconStore.put(firstObjectId, PNG, 'image/png');
    const firstAfterReplace = await app.inject({ method: 'GET', url: `/api/v1/favicon/${firstObjectId}` });
    assert.equal(firstAfterReplace.statusCode, 404, 'replaced favicon object must stay blocked for a hidden bookmark');
    const secondAfterReplace = await app.inject({ method: 'GET', url: `/api/v1/favicon/${secondObjectId}` });
    assert.equal(secondAfterReplace.statusCode, 404, 'the replacement object is blocked while hide_public is active');

    // Deleting the icon removes the bookmark_icons row; the durable
    // attribution rows stay, so both object URLs remain blocked.
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}/nodes/${bookmark.id}/favicon`,
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        'x-csrf-token': owner.csrfToken,
        'known-command-id': crypto.randomUUID(),
      },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    await faviconStore.put(firstObjectId, PNG, 'image/png');
    await faviconStore.put(secondObjectId, PNG, 'image/png');
    const firstAfterDelete = await app.inject({ method: 'GET', url: `/api/v1/favicon/${firstObjectId}` });
    assert.equal(firstAfterDelete.statusCode, 404, 'deleted favicon object must stay blocked');
    const secondAfterDelete = await app.inject({ method: 'GET', url: `/api/v1/favicon/${secondObjectId}` });
    assert.equal(secondAfterDelete.statusCode, 404, 'deleted replacement object must stay blocked');
  });

  test('discovery cards exclude hidden bookmark counts', async () => {
    const { app, owner, moderator } = await harness();
    await grantModerator(moderator.accountId);
    const collection = await publishCollection(app, owner, 'Counted Notes', 'cg04-counted');
    const first = await createBookmark(
      app, owner, collection.id, collection.rootId, 'Counted Alpha', 'https://example.test/counted-alpha',
    );
    await createBookmark(
      app, owner, collection.id, collection.rootId, 'Counted Beta', 'https://example.test/counted-beta',
    );

    const directoryBefore = await app.inject({
      method: 'GET',
      url: '/colp/v0.1/directory',
      headers: { accept: 'application/vnd.collection-protocol.catalog+json;version=0.1' },
    });
    assert.equal(directoryBefore.statusCode, 200, directoryBefore.body);
    const dirItemBefore = (directoryBefore.json() as { collections: Array<{ id: string; nodeCount: number }> })
      .collections.find((item) => item.id === collection.id);
    assert.equal(dirItemBefore?.nodeCount, 3, JSON.stringify(dirItemBefore));
    const exploreBefore = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?limit=100' });
    assert.equal(exploreBefore.statusCode, 200, exploreBefore.body);
    const exploreItemBefore = (exploreBefore.json() as { items: Array<{ id: string; nodeCount: number }> })
      .items.find((item) => item.id === collection.id);
    assert.equal(exploreItemBefore?.nodeCount, 3, JSON.stringify(exploreItemBefore));

    const caseId = await reportBookmark(app, owner, collection.id, first.id);
    const hide = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId,
        target: { kind: 'bookmark', id: first.id, collectionId: collection.id },
        action: 'hide_public',
        reason: 'count fixture',
      },
    });
    assert.equal(hide.statusCode, 201, hide.body);

    const directoryAfter = await app.inject({
      method: 'GET',
      url: '/colp/v0.1/directory',
      headers: { accept: 'application/vnd.collection-protocol.catalog+json;version=0.1' },
    });
    assert.equal(directoryAfter.statusCode, 200, directoryAfter.body);
    const dirItemAfter = (directoryAfter.json() as { collections: Array<{ id: string; nodeCount: number }> })
      .collections.find((item) => item.id === collection.id);
    assert.equal(dirItemAfter?.nodeCount, 2, 'COLP directory nodeCount must exclude the hidden bookmark');
    const exploreAfter = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?limit=100' });
    assert.equal(exploreAfter.statusCode, 200, exploreAfter.body);
    const exploreItemAfter = (exploreAfter.json() as { items: Array<{ id: string; nodeCount: number }> })
      .items.find((item) => item.id === collection.id);
    assert.equal(exploreItemAfter?.nodeCount, 2, 'Explore card nodeCount must exclude the hidden bookmark');
  });
});
