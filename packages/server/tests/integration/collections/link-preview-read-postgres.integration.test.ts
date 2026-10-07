/**
 * LP-04: previewImage on the three bookmark read views (public page over
 * HTTP, children layer and editor page through their real read units of
 * work), plus the emit rules: ready only, never generic, never vetoed,
 * bookmarks only, and null everywhere when the feature is off.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import {
  createPostgresBookmarkIconReadPort,
  createPostgresCollectionChildrenReadUnitOfWork,
  createPostgresCollectionsEditorReadUnitOfWork,
  createPostgresLinkPreviewReadPort,
} from '../../../src/infrastructure/collections/index.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresProductPublicCollectionLocatorReadPort,
  createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createCollectionChildrenCursorSigner,
  createProductEditorCursorSigner,
  getCollectionEditorPage,
  linkPreviewTargetIdentity,
  listCollectionChildren,
} from '../../../src/modules/collections/index.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { loadConfig } from '../../support/test-config.js';

const PRODUCT_ORIGIN = 'https://known.example';
const OWNER = 'lp04-owner-subject';
const COLLECTION = 'lp04col01lp04col01lp04';
const OBJECT_READY = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OBJECT_GENERIC = '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const READY_URL = 'https://ready.example.com/article';
const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN, PUBLICATION_ORIGIN: PRODUCT_ORIGIN, LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});
const keyA = { id: 'lp04-a', secret: Buffer.alloc(32, 44).toString('base64') };
const expectedImage = { url: `${PRODUCT_ORIGIN}/api/v1/link-preview/${OBJECT_READY}`, width: 1200, height: 630 };

type Node = { id: string; kind: string; previewImage?: unknown };

function byId(nodes: readonly Node[]): Map<string, Node> {
  return new Map(nodes.map((node) => [node.id, node]));
}

/** Rules shared by every view (the owner sees the same as the public here). */
function assertEmitRules(nodes: readonly Node[]): void {
  const map = byId(nodes);
  assert.deepEqual(map.get('lp04-ready')?.previewImage, expectedImage);
  assert.equal(map.get('lp04-vetoed')?.previewImage, null, 'the owner veto wins over a ready target');
  assert.equal(map.get('lp04-generic')?.previewImage, null, 'a site-wide default card is never shown');
  assert.equal(map.get('lp04-missing')?.previewImage, null);
  assert.equal(Object.hasOwn(map.get('lp04-folder') ?? {}, 'previewImage'), false, 'folders never carry the field');
}

describeWithPostgres('LP-04 link preview read path', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('lp04_link_preview_read', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seed(isolated);
  }, 180_000);
  afterAll(async () => isolated?.close());

  function publicApp(withPreviews: boolean) {
    const cursors = createPublicationCursorKeyring({ active: keyA, retained: [] });
    const app = buildApiApp({
      config,
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      productPublicCollectionQuery: {
        locators: createPostgresProductPublicCollectionLocatorReadPort(isolated.runtime),
        viewCounts: createPostgresProductPublicCollectionViewCountReadPort(isolated.runtime),
        cursors,
        owners: createPostgresPublicProfileFactsReadPort(isolated.runtime),
        productOrigin: PRODUCT_ORIGIN,
        bookmarkIcons: createPostgresBookmarkIconReadPort(isolated.runtime.db),
        ...(withPreviews ? { linkPreviews: createPostgresLinkPreviewReadPort(isolated.runtime.db) } : {}),
        snapshot: {
          reads: createPostgresPublicationSnapshotReadPort(isolated.runtime),
          accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
          cursors,
          origin: config.publication.origin,
          now: () => new Date(),
          sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
        },
      },
    });
    app.addHook('onClose', () => cursors.destroy());
    return app;
  }

  describe('public collection page', () => {
    test('emits previewImage by the rules when link previews are on', async () => {
      const app = publicApp(true);
      try {
        const response = await app.inject({ method: 'GET', url: '/api/v1/collections/lp04-page' });
        assert.equal(response.statusCode, 200, response.body);
        const nodes = (response.json() as { nodes: Node[] }).nodes;
        assertEmitRules(nodes);
        assert.equal(Object.hasOwn(nodes.find((node) => node.kind === 'root') ?? {}, 'previewImage'), false);
        assert.doesNotMatch(response.body, /ready\.example\.com\/card/u, 'no third-party image URL leaks');
      } finally {
        await app.close();
      }
    });

    test('feature off: every bookmark serializes null', async () => {
      const app = publicApp(false);
      try {
        const nodes = ((await app.inject({ method: 'GET', url: '/api/v1/collections/lp04-page' })).json() as { nodes: Node[] }).nodes;
        for (const node of nodes.filter((entry) => entry.kind === 'bookmark')) assert.equal(node.previewImage, null, node.id);
      } finally {
        await app.close();
      }
    });
  });

  test('children layer through the read unit of work', async () => {
    const unit = createPostgresCollectionChildrenReadUnitOfWork(isolated.runtime.db, {
      cursorSigner: createCollectionChildrenCursorSigner(Buffer.alloc(32, 7).toString('base64url')),
      productOrigin: PRODUCT_ORIGIN,
      linkPreviews: true,
    });
    const page = await unit.execute((ports) => listCollectionChildren(ports, {
      actor: { principalId: `${OWNER}-principal`, subjectId: OWNER },
      collectionId: COLLECTION,
    }));
    assertEmitRules(page.items as unknown as Node[]);
    const off = createPostgresCollectionChildrenReadUnitOfWork(isolated.runtime.db, {
      cursorSigner: createCollectionChildrenCursorSigner(Buffer.alloc(32, 7).toString('base64url')),
      productOrigin: PRODUCT_ORIGIN,
    });
    const offPage = await off.execute((ports) => listCollectionChildren(ports, {
      actor: { principalId: `${OWNER}-principal`, subjectId: OWNER },
      collectionId: COLLECTION,
    }));
    assert.equal(byId(offPage.items as unknown as Node[]).get('lp04-ready')?.previewImage, null);
  });

  test('editor page through the read unit of work', async () => {
    const unit = createPostgresCollectionsEditorReadUnitOfWork(isolated.runtime.db, {
      cursorSigner: createProductEditorCursorSigner({
        current: config.productEditorCursor.current,
        previous: config.productEditorCursor.previous,
      }),
      productOrigin: PRODUCT_ORIGIN,
      linkPreviews: true,
    });
    const page = await unit.execute((ports) => getCollectionEditorPage(ports, {
      actor: { principalId: `${OWNER}-principal`, subjectId: OWNER },
      collectionId: COLLECTION,
    }));
    assertEmitRules(page.nodes as unknown as Node[]);
  });

  test('empty inputs issue no SQL', async () => {
    let queries = 0;
    const counted = isolated.runtime.db.withPlugin({
      transformQuery(args) {
        queries += 1;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const port = createPostgresLinkPreviewReadPort(counted);
    assert.equal((await port.findReadyByUrlKeys([])).size, 0);
    assert.equal((await port.findVetoedNodeIds([])).size, 0);
    assert.equal(queries, 0);
  });
});

async function seed(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  const account = 'TFA0TFA0TFA0TFA0TFA0TA';
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(`insert into accounts(id, subject_id) values ($1, $2)`, [account, OWNER]);
    await client.query(`insert into profiles(account_id, display_name) values ($1, 'Owner')`, [account]);
    await client.query(`insert into profile_handles(handle, account_id) values ('lp04-owner', $1)`, [account]);
    const nodes: ReadonlyArray<readonly [string, string | null, 'folder' | 'bookmark', string | null]> = [
      ['lp04-root', null, 'folder', null],
      ['lp04-folder', 'lp04-root', 'folder', null],
      ['lp04-ready', 'lp04-root', 'bookmark', READY_URL],
      // Same URL as lp04-ready: the veto is per node, the target is per URL.
      ['lp04-vetoed', 'lp04-root', 'bookmark', READY_URL],
      ['lp04-generic', 'lp04-root', 'bookmark', 'https://generic.example.com/post'],
      ['lp04-missing', 'lp04-root', 'bookmark', 'https://missing.example.com/'],
    ];
    await client.query(`insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection')`, [COLLECTION]);
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) select unnest($1::text[]), 'node'`,
      [nodes.map(([id]) => id)],
    );
    await client.query(`
      insert into collections (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
        content_revision, policy_revision, publication_slug, published_at)
      values ($1, $2, 'Preview shelf', 'bookmarks', 'public', 'lp04-root', 'r1', 'c1', 'p1', 'lp04-page', now())
    `, [COLLECTION, OWNER]);
    for (const [index, [id, parent, kind, url]] of nodes.entries()) {
      await client.query(`
        insert into nodes (id, collection_id, parent_id, kind, is_root, title, url, visibility, position_token,
          resource_revision, children_revision)
        values ($1, $2, $3, $4, $5, $1, $6, 'inherit', $7, 'r1', 'ch1')
      `, [id, COLLECTION, parent, kind, parent === null, url, parent === null ? null : String(index).padStart(12, '0')]);
    }
    await client.query(`insert into bookmark_preview_prefs (node_id, collection_id, mode) values ('lp04-vetoed', $1, 'none')`, [COLLECTION]);
    const ready = linkPreviewTargetIdentity(READY_URL)!;
    const generic = linkPreviewTargetIdentity('https://generic.example.com/post')!;
    await client.query(`
      insert into link_preview_targets (url_key, normalized_url, site, status, object_id, width, height, mime, digest, generic, source, next_attempt_at)
      values ($1, $2, $3, 'ready', $4, 1200, 630, 'image/png', 'd1', false, 'og', 'infinity'),
             ($5, $6, $7, 'ready', $8, 1200, 630, 'image/png', 'd2', true, 'og', 'infinity')
    `, [ready.urlKey, ready.normalizedUrl, ready.site, OBJECT_READY, generic.urlKey, generic.normalizedUrl, generic.site, OBJECT_GENERIC]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
