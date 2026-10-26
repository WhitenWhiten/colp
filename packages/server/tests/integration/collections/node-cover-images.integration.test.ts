import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import { createDatabaseImageStore } from '../../../src/infrastructure/collections/image-database-store.js';
import { createPostgresNodeCoverCommandUnitOfWork } from '../../../src/infrastructure/collections/node-cover-postgres.js';
import { createPostgresImagePublicAccess } from '../../../src/infrastructure/collections/image-public-access.js';
import { createPostgresLinkPreviewReadPort } from '../../../src/infrastructure/collections/link-preview-read-postgres.js';
import { loadEditorProjectionRevision } from '../../../src/infrastructure/collections/editor-projection-revision.js';
import { attachBookmarkPreviewImages } from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createIsolatedPostgresRuntime, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { resetCollectionNodeContractFixture } from '../../support/collection-node-contract-postgres.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { createIdentityMemoryState, createIdentityMemoryUnitOfWork, issueTestSession } from '../../support/product-http-harness.js';
import { makePng } from '../../support/link-preview-fixtures.js';
import { loadConfig } from '../../support/test-config.js';

const ORIGIN = 'https://cover.example.test';
const id = (n: number) => Buffer.alloc(16, n).toString('base64url');
const COL = id(1), ROOT = id(2), FOLDER = id(3), BOOKMARK = id(4), OTHER = id(5);
const IMAGE_BODY = makePng(800, 400);
const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date()));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
const owner = await issueTestSession({ factory, subject: 'cover-owner', handle: 'coverowner' });
const editor = await issueTestSession({ factory, subject: 'cover-editor', handle: 'coverediter' });
const viewer = await issueTestSession({ factory, subject: 'cover-viewer', handle: 'coverviewer' });
const outsider = await issueTestSession({ factory, subject: 'cover-outsider', handle: 'coveroutside' });

describe('durable node covers over real PostgreSQL and Product HTTP', () => {
  let isolated: IsolatedPostgresRuntime;
  let app: ReturnType<typeof buildApiApp>;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('node_covers');
    const migrated = await createMigrator(isolated.runtime.db, 'migrations', isolated.schema).migrateToLatest();
    if (migrated.error) throw migrated.error;
    app = buildApiApp({ config: loadConfig({ DATABASE_URL: isolated.databaseUrl, PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN, NODE_ENV: 'test', LOG_LEVEL: 'silent', KNOWN_FEATURE_LINK_PREVIEW: 'false',
      OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'cover-tests-provider-secret-not-production' }),
    identityUnitOfWork: identity, browserSessionAuthority: factory.authority,
    coverImages: { store: createDatabaseImageStore(isolated.runtime.db),
      publicAccess: createPostgresImagePublicAccess(isolated.runtime.db),
      commands: createPostgresNodeCoverCommandUnitOfWork(isolated.runtime.db) } });
    await app.ready();
  }, 120_000);
  afterAll(async () => { await app?.close(); await isolated?.close(); });
  beforeEach(() => seed());

  async function seed(visibility: 'public' | 'private' = 'public', folderVisibility: 'inherit' | 'private' = 'inherit') {
    await resetCollectionNodeContractFixture(isolated.runtime, {
      principals: [owner, editor, viewer, outsider].map(client => ({ principalId: client.accountId, subjectId: client.subjectId })),
      collection: { id: COL, ownerSubjectId: owner.subjectId, rootNodeId: ROOT, visibility,
        publicationSlug: visibility === 'public' ? 'cover-tests' : null, publishedAt: visibility === 'public' ? new Date() : null,
        resourceRevision: id(10), contentRevision: id(11), policyRevision: id(12), commitOrdinal: 1n },
      memberships: [{ subjectId: editor.subjectId, role: 'editor' }, { subjectId: viewer.subjectId, role: 'viewer' }],
      nodes: [
        { id: ROOT, parentId: null, kind: 'folder', isRoot: true, positionToken: null, resourceRevision: id(13), childrenRevision: id(14) },
        { id: FOLDER, parentId: ROOT, kind: 'folder', positionToken: 'a0', resourceRevision: id(15), childrenRevision: id(16), visibility: folderVisibility },
        { id: BOOKMARK, parentId: FOLDER, kind: 'bookmark', url: 'https://example.com/page', positionToken: 'a0', resourceRevision: id(17), childrenRevision: id(18) },
        { id: OTHER, parentId: ROOT, kind: 'bookmark', url: 'https://example.com/page', positionToken: 'a1', resourceRevision: id(19), childrenRevision: id(20) },
      ],
    });
  }
  function headers(client = owner) {
    return { cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrfToken,
      'known-command-id': randomUUID(), 'content-type': 'application/json' };
  }
  async function upload(client = owner, body = IMAGE_BODY, commandHeaders = headers(client)) {
    return app.inject({ method: 'POST', url: `/api/v1/collections/${COL}/images`,
      headers: { ...commandHeaders, 'content-type': 'image/png' }, payload: body });
  }
  async function bind(assetId: string | null, revision: string, nodeId = BOOKMARK, mode = 'custom', client = owner, commandHeaders = headers(client)) {
    return app.inject({ method: 'PUT', url: `/api/v1/collections/${COL}/nodes/${nodeId}/cover`,
      headers: { ...commandHeaders, 'if-match': `"cover:${revision}"` }, payload: { mode, assetId } });
  }
  async function projection() {
    return isolated.runtime.db.transaction().execute(tx => loadEditorProjectionRevision(tx, COL, { productOrigin: ORIGIN, linkPreviews: false }));
  }

  test('uploads are immutable, durable and idempotent; replacement changes URL and read revision', async () => {
    const h = headers();
    const first = await upload(owner, IMAGE_BODY, h);
    expect(first.statusCode, first.body).toBe(201);
    expect((await upload(owner, IMAGE_BODY, h)).json()).toEqual(first.json());
    expect((await upload(owner, makePng(800, 400, 12), h)).statusCode).toBe(409);
    const a = first.json();
    expect((await app.inject({ url: a.image.url })).statusCode).toBe(404);
    const before = await projection();
    expect((await bind(a.assetId, '0')).statusCode).toBe(200);
    expect(await projection()).not.toBe(before);
    const delivered = await app.inject({ url: a.image.url });
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect(delivered.rawPayload).toEqual(IMAGE_BODY);
    expect(delivered.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(delivered.headers['vary']).toBe('Cookie');
    const conditional = await app.inject({ url: a.image.url, headers: { 'if-none-match': `W/${delivered.headers.etag}` } });
    expect(conditional.statusCode).toBe(304);
    expect(conditional.rawPayload.length).toBe(0);
    const second = (await upload()).json();
    expect(second.image.url).not.toBe(a.image.url);
    const h2 = headers();
    const replacement = await bind(second.assetId, '1', BOOKMARK, 'custom', owner, h2);
    expect(replacement.statusCode, replacement.body).toBe(200);
    expect((await bind(second.assetId, '1', BOOKMARK, 'custom', owner, h2)).json()).toEqual(replacement.json());
    expect((await bind(a.assetId, '1')).statusCode).toBe(412);
    const revoked = await app.inject({ url: a.image.url, headers: { 'if-none-match': delivered.headers.etag! } });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.headers['cache-control']).toBe('private, no-store');
    // Retired and long-unvisited uploads remain in durable storage.
    await isolated.runtime.pool.query("UPDATE image_assets SET created_at = now() - interval '100 years'");
    expect((await createDatabaseImageStore(isolated.runtime.db).get(a.assetId))?.body).toEqual(IMAGE_BODY);
    expect((await app.inject({ url: second.image.url })).statusCode).toBe(200);
    await expect(createDatabaseImageStore(isolated.runtime.db).put(a.assetId, makePng(1, 1), 'image/png')).rejects.toThrow();
  });

  test('custom covers are node-local, work without OG, support folders, none and restoring auto', async () => {
    const asset = (await upload()).json();
    expect((await bind(asset.assetId, '0')).statusCode).toBe(200);
    expect((await bind(asset.assetId, '0', FOLDER)).statusCode).toBe(200);
    const nodes = [{ id: BOOKMARK, kind: 'bookmark', url: 'https://example.com/page' },
      { id: OTHER, kind: 'bookmark', url: 'https://example.com/page' }, { id: FOLDER, kind: 'folder' }];
    const read = () => attachBookmarkPreviewImages(createPostgresLinkPreviewReadPort(isolated.runtime.db, { ogEnabled: false }), ORIGIN, nodes);
    let projected = await read() as Array<{ coverImage?: unknown; coverMode?: string }>;
    expect(projected[0]?.coverImage).toEqual(asset.image);
    expect(projected[1]?.coverImage).toBeNull();
    expect(projected[2]?.coverImage).toEqual(asset.image);
    expect((await bind(null, '1', BOOKMARK, 'none')).statusCode).toBe(200);
    projected = await read();
    expect(projected[0]).toMatchObject({ coverMode: 'none', coverImage: null });
    expect((await bind(null, '2', BOOKMARK, 'auto')).statusCode).toBe(200);
    expect((await read())[0]).toMatchObject({ coverMode: 'auto', coverRevision: '3', coverImage: null });
  });

  test('private and ancestor-hidden covers require membership, and conditional requests cannot bypass it', async () => {
    await seed('private');
    const asset = (await upload(editor)).json();
    expect((await bind(asset.assetId, '0', BOOKMARK, 'custom', editor)).statusCode).toBe(200);
    const visible = await app.inject({ url: asset.image.url, headers: { cookie: viewer.cookie } });
    expect(visible.statusCode, visible.body).toBe(200);
    expect(visible.headers['cache-control']).toBe('private, max-age=604800, immutable');
    for (const cookie of ['', outsider.cookie]) {
      expect((await app.inject({ url: asset.image.url, headers: { cookie, 'if-none-match': visible.headers.etag! } })).statusCode).toBe(404);
    }
    await seed('public', 'private');
    const hidden = (await upload()).json();
    expect((await bind(hidden.assetId, '0')).statusCode).toBe(200);
    expect((await app.inject({ url: hidden.image.url })).statusCode).toBe(404);
    expect((await app.inject({ url: hidden.image.url, headers: { cookie: owner.cookie } })).statusCode).toBe(200);
  });

  test('rejects unauthorized writes, malformed images, invalid bindings and missing preconditions', async () => {
    expect((await upload(viewer)).statusCode).toBe(403);
    expect((await upload(outsider)).statusCode).toBe(404);
    expect((await upload(owner, Buffer.from('not a png'))).statusCode).toBe(422);
    expect((await upload(owner, Buffer.alloc(2 * 1024 * 1024 + 1))).statusCode).toBe(413);
    const asset = (await upload()).json();
    expect((await bind(asset.assetId, '0', BOOKMARK, 'none')).statusCode).toBe(422);
    expect((await bind(randomUUID(), '0')).statusCode).toBe(404);
    const noPrecondition = await app.inject({ method: 'PUT', url: `/api/v1/collections/${COL}/nodes/${BOOKMARK}/cover`,
      headers: headers(), payload: { mode: 'auto' } });
    expect(noPrecondition.statusCode).toBe(428);
    expect((await isolated.runtime.pool.query('SELECT count(*)::int AS n FROM node_cover_prefs')).rows[0].n).toBe(0);
  });
});
