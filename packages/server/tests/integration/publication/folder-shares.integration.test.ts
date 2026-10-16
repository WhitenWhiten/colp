import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../../src/bootstrap/config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { runMigrations, createPostgresSharedExposureFactsPort } from '../../../src/infrastructure/database/index.js';
import { createPostgresLibraryCollectionUnitOfWork } from '../../../src/infrastructure/collections/library-collection-postgres.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/canonical-product-unit-of-work.js';
import { createPostgresCollectionsUnitOfWork, createPostgresCollectionsEditorReadUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createPostgresFolderShareUnitOfWork } from '../../../src/infrastructure/publication/folder-shares-postgres.js';
import { createPostgresPublicFolderShareReadPort } from '../../../src/infrastructure/publication/folder-share-public-postgres.js';
import { createPostgresProductPublicCollectionLocatorReadPort, createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicationSnapshotReadPort } from '../../../src/infrastructure/publication/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { ensureLibraryCollection, type LibraryCollection } from '../../../src/modules/collections/application/ensure-library-collection.js';
import { createProductEditorCursorSigner } from '../../../src/modules/collections/index.js';
import { createIdentityMemoryState, createIdentityMemoryUnitOfWork, issueTestSession } from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const origin = 'https://known.example';
const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date()));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
type Client = Awaited<ReturnType<typeof issueTestSession>>;

describeWithPostgres('live unlisted library folder shares', () => {
  let isolated: IsolatedPostgresRuntime, app: ReturnType<typeof buildApiApp>, owner: Client, outsider: Client;
  let library: LibraryCollection;
  let nextSlug: string | undefined;
  const readSizes: number[] = [];
  const cursors = createPublicationCursorKeyring({ active: { id: 'shares', secret: Buffer.alloc(32, 17).toString('base64') }, retained: [] });
  const editorCursor = createProductEditorCursorSigner({ current: { id: 'shares', key: 'folder-share-editor-key-32-bytes-secret' } });
  const headers = (client = owner, command = randomUUID()) => ({ cookie: client.cookie, origin,
    'x-csrf-token': client.csrfToken, 'known-command-id': command });
  const shareUrl = (nodeId: string, collectionId = library.id) => `/api/v1/collections/${collectionId}/nodes/${nodeId}/share`;
  const put = (nodeId: string, command?: string) => app.inject({ method: 'PUT', url: shareUrl(nodeId), headers: headers(owner, command), payload: {} });
  const getPage = (slug: string, query = '') => app.inject({ method: 'GET', url: `/api/v1/collections/${slug}${query}` });
  const editor = async () => (await app.inject({ method: 'GET', url: `/api/v1/collections/${library.id}/editor`, headers: { cookie: owner.cookie } })).json();
  async function node(parentId: string, title: string, kind: 'folder' | 'bookmark' = 'folder', visibility = 'inherit') {
    const reply = await app.inject({ method: 'POST', url: `/api/v1/collections/${library.id}/nodes`, headers: headers(),
      payload: { parentId, afterId: null, beforeId: null, node: { kind, title, visibility, description: null, tags: [],
        ...(kind === 'bookmark' ? { url: `https://example.test/${title.toLowerCase().replaceAll(' ', '-')}` } : {}) } } });
    assert.equal(reply.statusCode, 201, reply.body); return reply.json().node;
  }
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('folder_shares', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    owner = await issueTestSession({ factory, subject: 'share-owner', handle: 'share-owner', displayName: 'Share owner' });
    outsider = await issueTestSession({ factory, subject: 'share-outsider', handle: 'share-outsider' });
    await isolated.runtime.db.insertInto('accounts').values({ id: owner.accountId, subject_id: owner.subjectId,
      status: 'active', security_epoch: 0n, created_at: new Date() }).execute();
    await isolated.runtime.db.insertInto('profiles').values({ account_id: owner.accountId, display_name: 'Share owner' }).execute();
    await isolated.runtime.db.insertInto('profile_handles').values({ account_id: owner.accountId, handle: 'share-owner', created_at: new Date() }).execute();
    const unit = createPostgresLibraryCollectionUnitOfWork(isolated.runtime.db);
    library = await ensureLibraryCollection(unit, { principalId: owner.accountId, subjectId: owner.subjectId });
    const config = loadConfig({ DATABASE_URL: 'postgres://unused/shares', PRODUCT_ORIGIN: origin, ALLOWED_ORIGINS: origin, LOG_LEVEL: 'silent', OIDC_JWKS_URI: 'https://issuer.example/certs' });
    app = buildApiApp({ config, identityUnitOfWork: identity, browserSessionAuthority: factory.authority,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db), libraryCollectionUnitOfWork: unit,
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db), collectionMetadataMutationRoutes: 'enabled',
      collectionsEditorReadUnitOfWork: createPostgresCollectionsEditorReadUnitOfWork(isolated.runtime.db, { cursorSigner: editorCursor, cursorTtlMs: 60_000 }),
      folderShares: createPostgresFolderShareUnitOfWork(isolated.runtime.db, { newSlug: () => nextSlug ?? `folder-${randomUUID()}` }),
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      productPublicCollectionQuery: { folderShares: createPostgresPublicFolderShareReadPort(isolated.runtime.db.withPlugin({
        transformQuery: args => args.node,
        async transformResult(args) { readSizes.push(args.result.rows.length); return args.result; },
      })),
        locators: createPostgresProductPublicCollectionLocatorReadPort(isolated.runtime),
        viewCounts: createPostgresProductPublicCollectionViewCountReadPort(isolated.runtime), cursors,
        owners: createPostgresPublicProfileFactsReadPort(isolated.runtime),
        snapshot: { reads: createPostgresPublicationSnapshotReadPort(isolated.runtime), accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
          cursors, origin, sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime) } },
    });
    await app.ready();
  }, 120_000);
  afterAll(async () => { await app?.close(); cursors.destroy(); editorCursor.destroy(); await isolated?.close(); });

  test('owner-only reads and CSRF/command guarded writes; root and bookmark shares refused', async () => {
    const roles = (await editor()).nodes;
    assert.equal(roles.find((n: { id: string }) => n.id === library.bookmarksBarId).folderRole, 'bookmarks-bar');
    assert.equal(roles.find((n: { id: string }) => n.id === library.otherBookmarksId).folderRole, 'other-bookmarks');
    const folder = await node(library.bookmarksBarId, 'Owner folder');
    assert.equal((await app.inject({ method: 'GET', url: shareUrl(folder.id) })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: shareUrl(folder.id), headers: { cookie: outsider.cookie } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: shareUrl(folder.id), headers: { cookie: owner.cookie, origin }, payload: {} })).statusCode, 403);
    const noCommand = { ...headers() }; delete (noCommand as Partial<typeof noCommand>)['known-command-id'];
    assert.equal((await app.inject({ method: 'PUT', url: shareUrl(folder.id), headers: noCommand, payload: {} })).statusCode, 400);
    assert.equal((await put(library.rootNodeId)).statusCode, 422);
    const bookmark = await node(folder.id, 'Cannot share bookmark', 'bookmark');
    assert.equal((await put(bookmark.id)).statusCode, 422);
  });

  test('restricted targets cannot create links and existing links report their effective restriction', async () => {
    for (const visibility of ['private', 'protected']) {
      const parent = await node(library.bookmarksBarId, `Hidden ${visibility}`, 'folder', visibility);
      const child = await node(parent.id, `Inherited ${visibility}`);
      for (const target of [parent, child]) {
        const state = await app.inject({ method: 'GET', url: shareUrl(target.id), headers: { cookie: owner.cookie } });
        assert.equal(state.json().unavailableReason, 'folder_restricted');
        assert.equal(state.json().share, null);
        const created = await put(target.id);
        assert.equal(created.statusCode, 422, created.body);
        assert.match(created.json().error.message, /private or protected/);
        assert.equal((await isolated.runtime.db.selectFrom('folder_shares').select('id').where('node_id', '=', target.id).execute()).length, 0);
      }
    }
    const folder = await node(library.bookmarksBarId, 'Later restricted');
    const shared = await put(folder.id);
    assert.equal(shared.json().unavailableReason, null);
    const share = shared.json().share;
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/collections/${library.id}/nodes/${folder.id}`, headers: {
      ...headers(), 'if-match': folder.etag, 'content-type': 'application/merge-patch+json' }, payload: { visibility: 'private' } });
    assert.equal(patch.statusCode, 200, patch.body);
    const state = await app.inject({ method: 'GET', url: shareUrl(folder.id), headers: { cookie: owner.cookie } });
    assert.equal(state.json().share.id, share.id);
    assert.equal(state.json().unavailableReason, 'folder_restricted');
    assert.equal((await getPage(share.slug)).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: shareUrl(folder.id), headers: headers() })).statusCode, 200);
  });

  test('owner share state and anonymous access agree on account publication restrictions', async () => {
    const folder = await node(library.bookmarksBarId, 'Publication control');
    const slug = (await put(folder.id)).json().share.slug;
    const caseId = randomUUID(), actionId = randomUUID();
    await isolated.runtime.pool.query(`INSERT INTO moderation_cases(id,reporter_account_id,target_kind,target_id,target_json,
      target_fingerprint,category,description,status,revision,created_at,updated_at)
      VALUES($1,$2,'account',$2,'{}',$1,'privacy','Fixture restriction','resolved','1',now(),now())`, [caseId, owner.accountId]);
    await isolated.runtime.pool.query(`INSERT INTO moderation_actions(id,case_id,target_kind,target_id,target_json,
      target_fingerprint,action,reason,actor_account_id,state,revision,created_at)
      VALUES($1,$2,'account',$3,'{}',$2,'restrict_publication','Fixture restriction',$3,'active','1',now())`, [actionId, caseId, owner.accountId]);
    try {
      const state = await app.inject({ method: 'GET', url: shareUrl(folder.id), headers: { cookie: owner.cookie } });
      assert.equal(state.json().unavailableReason, 'publication_restricted');
      assert.equal((await put(folder.id)).statusCode, 422);
      assert.equal((await getPage(slug)).statusCode, 404);
    } finally {
      await isolated.runtime.pool.query("UPDATE moderation_actions SET state='revoked', revoked_at=now() WHERE id=$1", [actionId]);
    }
    assert.equal((await getPage(slug)).statusCode, 200);
  });

  test('share creation is idempotent, editor marks it, and revocation kills every old page and cursor', async () => {
    const folder = await node(library.bookmarksBarId, 'Shared reading');
    await node(folder.id, 'Page one', 'bookmark'); await node(folder.id, 'Page two', 'bookmark');
    const command = randomUUID(), created = await put(folder.id, command);
    assert.equal(created.statusCode, 200, created.body); const share = created.json().share;
    assert.equal((await put(folder.id, command)).body, created.body);
    assert.equal((await put(folder.id)).json().share.id, share.id);
    const concurrent = await Promise.all([put(folder.id), put(folder.id)]);
    assert.ok(concurrent.every(reply => reply.json().share.id === share.id));
    assert.equal((await editor()).nodes.find((n: { id: string }) => n.id === folder.id).shared, true);
    const page = await getPage(share.slug, '?limit=2'); assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.headers['cache-control'], 'private, no-store');
    assert.equal(page.json().collection.title, 'Shared reading'); assert.equal(page.json().collection.rootNodeId, folder.id);
    assert.equal(page.json().collection.folderShare, true);
    const revoked = await app.inject({ method: 'DELETE', url: shareUrl(folder.id), headers: headers() });
    assert.equal(revoked.statusCode, 200, revoked.body); assert.equal(revoked.json().share, null);
    assert.equal((await getPage(share.slug)).statusCode, 404);
    assert.equal((await getPage(share.slug, `?limit=2&cursor=${encodeURIComponent(page.json().page.cursor)}`)).statusCode, 404);
    assert.equal((await editor()).nodes.find((n: { id: string }) => n.id === folder.id).shared, undefined);
    const newShare = (await put(folder.id)).json().share; assert.notEqual(newShare.slug, share.slug);
    await put(folder.id, command); assert.equal((await getPage(share.slug)).statusCode, 404); // receipt replay never resurrects a link
  });

  test('only the live subtree is visible; siblings, private/protected branches and owner-only marks stay hidden', async () => {
    const folder = await node(library.otherBookmarksId, 'Subtree');
    const visible = await node(folder.id, 'Visible page', 'bookmark');
    const nested = await node(folder.id, 'Nested'); await node(nested.id, 'Nested page', 'bookmark');
    await node(folder.id, 'Secret page', 'bookmark', 'private');
    const restricted = await node(folder.id, 'Restricted', 'folder', 'protected'); await node(restricted.id, 'Restricted child', 'bookmark');
    const sibling = await node(library.otherBookmarksId, 'Sibling secret', 'bookmark');
    const slug = (await put(folder.id)).json().share.slug;
    const relation = async (from: string, to: string, type = 'related') => {
      const id = randomUUID(), at = new Date().toISOString();
      await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values($1,'relation')", [id]);
      await isolated.runtime.pool.query(`insert into relations(id,collection_id,from_node_id,to_node_id,type,visibility,
        resource_revision,created_at,updated_at,payload_json) values($1,$2,$3,$4,$5,'public','r1',$6,$6,$7)`,
      [id, library.id, from, to, type, at, { id, collectionId: library.id, fromNodeId: from, toNodeId: to,
        type, visibility: 'public', revision: 'r1', createdAt: at, updatedAt: at }]);
    };
    await relation(visible.id, nested.id); await relation(visible.id, sibling.id, 'mentions');
    for (const [subject, text, visibility, fixedId, fixedAt] of [
      [visible.id, 'Inside public note', 'public'], [sibling.id, 'Outside note', 'public'], [nested.id, 'Private note', 'private'],
      [visible.id, 'Earlier tied note', 'public', 'ffffffff-ffff-4fff-8fff-fffffffffff1', '2030-01-01T00:00:00Z'],
      [visible.id, 'Latest tied note', 'public', 'ffffffff-ffff-4fff-8fff-fffffffffff2', '2030-01-01T00:00:00Z'],
    ]) {
      const id = fixedId ?? randomUUID(), at = fixedAt ?? new Date().toISOString();
      await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values($1,'annotation')", [id]);
      await isolated.runtime.pool.query(`insert into annotations(id,collection_id,subject_type,subject_id,creator_principal_id,type,format,
        value_json,visibility,resource_revision,created_at,updated_at,payload_json)
        values($1,$2,'node',$3,$4,'note','plain',$5,$6,'r1',$7,$7,$8)`,
      [id, library.id, subject, owner.accountId, JSON.stringify(text), visibility, at,
        { id, collectionId: library.id, subject: { type: 'node', id: subject }, creator: { id: `${origin}/profiles/share-owner`, name: 'Share owner' },
          type: 'note', format: 'plain', value: text, visibility, revision: 'r1', createdAt: at, updatedAt: at }]);
    }
    for (const cookie of [undefined, owner.cookie, outsider.cookie]) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/collections/${slug}?include=relations`, headers: cookie ? { cookie } : {} });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json(); assert.equal(body.nodes.length, 4); assert.equal(body.nodes[0].parentId, null);
      assert.equal(body.nodes.find((n: { id: string }) => n.id === visible.id).note, 'Latest tied note');
      assert.equal(body.relations.length, 1); assert.equal(body.relations[0].toNodeId, nested.id);
      assert.ok(!/Sibling secret|Secret page|Restricted|Outside note|Private note|Bookmarks/.test(response.body));
    }
    let next: string | null = null; let count = 0; let relationCount = 0; let sequence = 0;
    do {
      const response = await getPage(slug, `?limit=2&include=relations${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
      assert.equal(response.statusCode, 200, response.body); const body = response.json();
      assert.equal(body.page.sequence, ++sequence); count += body.nodes.length; relationCount += body.relations.length;
      next = body.page.cursor;
    } while (next);
    assert.equal(count, 4); assert.equal(relationCount, 1);
    const page = await getPage(slug, '?limit=2&include=relations'); const cursor = page.json().page.cursor;
    const move = await app.inject({ method: 'POST', url: `/api/v1/collections/${library.id}/nodes/${visible.id}/move`, headers: {
      ...headers(), 'if-match': visible.etag }, payload: { newParentId: library.bookmarksBarId,
      afterId: null, beforeId: null, baseSourceParentRevision: (await editor()).nodes.find((n: { id: string }) => n.id === folder.id).childrenRevision,
      baseTargetParentRevision: (await editor()).nodes.find((n: { id: string }) => n.id === library.bookmarksBarId).childrenRevision } });
    assert.equal(move.statusCode, 200, move.body);
    assert.equal((await getPage(slug)).json().nodes.some((n: { id: string }) => n.id === visible.id), false);
    assert.equal((await getPage(slug, `?limit=2&include=relations&cursor=${encodeURIComponent(cursor)}`)).statusCode, 200);
    const incoming = await node(library.bookmarksBarId, 'Moved in', 'bookmark');
    const current = await editor();
    const movedIn = await app.inject({ method: 'POST', url: `/api/v1/collections/${library.id}/nodes/${incoming.id}/move`,
      headers: { ...headers(), 'if-match': incoming.etag }, payload: { newParentId: folder.id, afterId: null, beforeId: null,
        baseSourceParentRevision: current.nodes.find((n: { id: string }) => n.id === library.bookmarksBarId).childrenRevision,
        baseTargetParentRevision: current.nodes.find((n: { id: string }) => n.id === folder.id).childrenRevision } });
    assert.equal(movedIn.statusCode, 200, movedIn.body);
    assert.equal((await getPage(slug)).json().nodes.some((n: { id: string }) => n.id === incoming.id), true);
  });

  test('bounded pages traverse a large share while unrelated browser sync keeps writing', async () => {
    const folder = await node(library.bookmarksBarId, 'Large share');
    const template = await node(folder.id, 'Template', 'bookmark');
    const prefix = randomUUID();
    await isolated.runtime.pool.query(`INSERT INTO resource_id_ledger(resource_id,resource_type)
      SELECT $1 || '-' || i, 'node' FROM generate_series(1,1200) i`, [prefix]);
    await isolated.runtime.pool.query(`INSERT INTO nodes(id,collection_id,parent_id,kind,title,url,description,tags,
      position_token,resource_revision,children_revision,visibility,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
      SELECT $1 || '-' || i, collection_id,parent_id,kind,'Seed ' || i,url,description,tags,
        'zz' || lpad(i::text,5,'0'),resource_revision,children_revision,visibility,created_at,updated_at,
        payload_json || jsonb_build_object('id',$1 || '-' || i,'title','Seed ' || i,'position','zz' || lpad(i::text,5,'0')),
        payload_schema_version,payload_authority_status FROM nodes CROSS JOIN generate_series(1,1200) i WHERE id=$2`, [prefix, template.id]);
    const slug = (await put(folder.id)).json().share.slug;
    const seen = new Set<string>();
    let cursor: string | null = null, sequence = 0;
    do {
      readSizes.length = 0;
      const response = await getPage(slug, `?limit=37${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(response.statusCode, 200, response.body);
      const page = response.json();
      assert.equal(page.page.sequence, ++sequence);
      assert.ok(page.nodes.length <= 37);
      assert.ok(Math.max(...readSizes) <= 74, `unbounded database result: ${readSizes}`);
      for (const item of page.nodes) { assert.ok(!seen.has(item.id)); seen.add(item.id); }
      cursor = page.page.cursor;
      // A real product write outside this share changes the library revision on every page.
      await node(library.otherBookmarksId, `Concurrent sync ${sequence}`, 'bookmark');
    } while (cursor);
    assert.equal(seen.size, 1202);
    assert.ok(sequence > 30);
    readSizes.length = 0;
    assert.equal((await getPage(slug, '?limit=37&cursor=invalid')).statusCode, 400);
    assert.deepEqual(readSizes, []);
  });

  test('deleting the shared folder, or restricting an ancestor, ends public access', async () => {
    const parent = await node(library.bookmarksBarId, 'Private ancestor');
    const folder = await node(parent.id, 'Disposable'); const slug = (await put(folder.id)).json().share.slug;
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/collections/${library.id}/nodes/${parent.id}`, headers: {
      ...headers(), 'if-match': parent.etag, 'content-type': 'application/merge-patch+json' }, payload: { visibility: 'private' } });
    assert.equal(patch.statusCode, 200, patch.body); assert.equal((await getPage(slug)).statusCode, 404);
    const clean = await node(library.bookmarksBarId, 'Delete me'); const cleanSlug = (await put(clean.id)).json().share.slug;
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/collections/${library.id}/nodes/${clean.id}`, headers: { ...headers(), 'if-match': clean.etag } });
    assert.equal(deleted.statusCode, 200, deleted.body); assert.equal((await getPage(cleanSlug)).statusCode, 404);
    const ended = await isolated.runtime.pool.query('select revoked_at from folder_shares where slug=$1', [cleanSlug]);
    assert.ok(ended.rows[0].revoked_at); // Restoring the node cannot resurrect the old link.
  });

  test('a collection publication slug and a folder slug cannot collide in either direction or concurrently', async () => {
    const makeCollection = async () => {
      const result = await app.inject({ method: 'POST', url: '/api/v1/collections', headers: headers(), payload: { kind: 'bookmarks', title: 'Fixture', summary: null } });
      assert.equal(result.statusCode, 201, result.body); return result.json().collection;
    };
    const publish = (collection: { id: string; etag: string }, slug: string) => app.inject({ method: 'PATCH', url: `/api/v1/collections/${collection.id}`,
      headers: { ...headers(), 'if-match': collection.etag, 'content-type': 'application/merge-patch+json' }, payload: { visibility: 'unlisted', publicationSlug: slug } });
    const collection = await makeCollection(); const published = await publish(collection, 'reserved-address'); assert.equal(published.statusCode, 200, published.body);
    const folder = await node(library.bookmarksBarId, 'Collision'); nextSlug = 'reserved-address';
    try { const response = await put(folder.id); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().error.code, 'publication_slug_conflict'); }
    finally { nextSlug = undefined; }
    const ownShare = (await put(folder.id)).json().share;
    const reverse = await publish(await makeCollection(), ownShare.slug); assert.equal(reverse.statusCode, 409, reverse.body);
    const racingFolder = await node(library.bookmarksBarId, 'Racing'); const racingCollection = await makeCollection(); nextSlug = 'race-address';
    try {
      const race = await Promise.all([put(racingFolder.id), publish(racingCollection, 'race-address')]);
      assert.deepEqual(race.map(response => response.statusCode).sort(), [200, 409]);
      const claims = await isolated.runtime.pool.query('select * from publication_slug_claims where slug=$1', ['race-address']); assert.equal(claims.rowCount, 1);
    } finally { nextSlug = undefined; }
  });
});
