/**
 * LP-03: link preview worker against PostgreSQL with a fake egress and an
 * in-memory object store. No real network, no R2.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';
import {
  createPostgresLinkPreviewPublicAccess,
  createPostgresLinkPreviewRepository,
  LinkPreviewWorkerLoop,
  type LinkPreviewRepository,
} from '../../../src/infrastructure/collections/index.js';
import { createPostgresNodeWritePort } from '../../../src/infrastructure/collections/repositories.js';
import { classifyParentAncestry } from '../../../src/modules/collections/application/ancestry-validation.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { linkPreviewTargetIdentity } from '../../../src/modules/collections/index.js';
import {
  createFakeEgress,
  createMemoryObjectStore,
  htmlResponse,
  imageResponse,
  makePng,
  type FakeRoute,
  type MemoryObjectStore,
} from '../../support/link-preview-fixtures.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  truncateGuardedTablesInTransaction,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const OWNER = 'lp-owner-subject';
const COLLECTION_ID = 'lpcol01lpcol01lpcol01A';
const PRIVATE_COLLECTION_ID = 'lpcol02lpcol02lpcol02B';
const silentLogger = { info() {}, warn() {}, error() {} };
const immediateGate = { run: (_host: string, work: () => Promise<void>) => work() };
const CARD = makePng(1200, 630, 90);

describeWithPostgres('LP-03 link preview worker', () => {
  let isolated: IsolatedPostgresRuntime;
  let repository: LinkPreviewRepository;
  let store: MemoryObjectStore;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('lp03_link_preview', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
    repository = createPostgresLinkPreviewRepository(isolated.runtime.pool, {
      cancelBackend: (pid) => isolated.runtime.cancelBackend(pid),
    });
  }, 180_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => {
    store = createMemoryObjectStore();
    await isolated.runtime.pool.query(`
      TRUNCATE link_preview_targets, link_preview_objects, link_preview_collection_sweeps, bookmark_preview_prefs
    `);
  });

  const pool = () => isolated.runtime.pool;
  const target = async (url: string) => (await pool().query(
    'SELECT * FROM link_preview_targets WHERE url_key = $1', [linkPreviewTargetIdentity(url)!.urlKey],
  )).rows[0];
  const enqueue = (...urls: string[]) => repository.enqueue(urls.map((url) => linkPreviewTargetIdentity(url)!));

  function worker(routes: Map<string, FakeRoute>, options: {
    readonly privateHosts?: ReadonlySet<string>;
    readonly repository?: LinkPreviewRepository;
    readonly metrics?: InMemoryMetrics;
    readonly sweepUrlLimit?: number;
  } = {}) {
    const egress = createFakeEgress(routes, options.privateHosts);
    const loop = new LinkPreviewWorkerLoop({
      repository: options.repository ?? repository,
      store,
      logger: silentLogger,
      retentionSeconds: 31_536_000,
      resolve: egress.resolve,
      connect: egress.connect,
      hostGate: immediateGate,
      concurrency: 8,
      ...(options.sweepUrlLimit === undefined ? {} : { sweepUrlLimit: options.sweepUrlLimit }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    });
    return { loop, egress };
  }

  describe('fetch pipeline', () => {
    test('an og:image page becomes a ready target backed by a stored object', async () => {
      await enqueue('https://news.example.com/story');
      const { loop } = worker(new Map([
        ['https://news.example.com/story', () => htmlResponse('<meta property="og:image" content="/card.png">')],
        ['https://news.example.com/card.png', () => imageResponse(CARD)],
      ]));
      assert.equal(await loop.runOnce(), true);
      const row = await target('https://news.example.com/story');
      assert.equal(row.status, 'ready');
      assert.equal(row.source, 'og');
      assert.deepEqual([row.width, row.height, row.mime], [1200, 630, 'image/png']);
      assert.equal(row.lease_owner, null);
      assert.deepEqual(store.objects.get(row.object_id)?.body, CARD);
      const ledger = await pool().query('SELECT * FROM link_preview_objects WHERE object_id = $1', [row.object_id]);
      assert.equal(ledger.rowCount, 1);
      // Nothing is due any more.
      assert.equal(await loop.runOnce(), false);
    });

    test('fetches trailing-slash pages at their original path', async () => {
      await enqueue('https://news.example.com/articles/');
      const { loop, egress } = worker(new Map([
        ['https://news.example.com/articles/', () => htmlResponse('<meta property="og:image" content="card.png">')],
        ['https://news.example.com/articles/card.png', () => imageResponse(CARD)],
      ]));
      await loop.runOnce();
      assert.equal((await target('https://news.example.com/articles/')).status, 'ready');
      assert.ok(egress.requested.includes('https://news.example.com/articles/'));
      assert.ok(!egress.requested.includes('https://news.example.com/articles'));
    });

    test('source rules skip the page; twitter-only and image_src-only pages still get a card', async () => {
      await enqueue('https://github.com/git-bug/git-bug', 'https://a.example.com/t', 'https://b.example.com/s');
      const { loop, egress } = worker(new Map([
        ['https://opengraph.githubassets.com/1/git-bug/git-bug', () => imageResponse(makePng(1200, 600, 10))],
        ['https://a.example.com/t', () => htmlResponse('<meta name="twitter:image" content="https://cdn.example.com/t.png">')],
        ['https://cdn.example.com/t.png', () => imageResponse(makePng(800, 418, 20))],
        ['https://b.example.com/s', () => htmlResponse('<link rel="image_src" href="/s.png">')],
        ['https://b.example.com/s.png', () => imageResponse(makePng(600, 400, 30))],
      ]));
      await loop.runOnce();
      assert.equal((await target('https://github.com/git-bug/git-bug')).source, 'rule');
      assert.ok(!egress.requested.includes('https://github.com/git-bug/git-bug'), 'rule URLs never fetch the page');
      assert.equal((await target('https://a.example.com/t')).source, 'twitter');
      assert.equal((await target('https://b.example.com/s')).source, 'image_src');
    });

    test('unusable candidates fall through to the next; nothing usable ends as none', async () => {
      await enqueue(
        'https://c.example.com/fallthrough',
        'https://c.example.com/nothing',
        'https://c.example.com/doc.pdf',
        'https://intranet.example.com/page',
      );
      const metrics = new InMemoryMetrics();
      const { loop } = worker(new Map([
        ['https://c.example.com/fallthrough', () => htmlResponse(`
          <meta property="og:image" content="/tiny.png">
          <meta property="og:image" content="/garbage.png">
          <meta name="twitter:image" content="/good.png">`)],
        ['https://c.example.com/tiny.png', () => imageResponse(makePng(64, 64))],
        ['https://c.example.com/garbage.png', () => imageResponse(Buffer.from('<html>not an image</html>'))],
        ['https://c.example.com/good.png', () => imageResponse(makePng(900, 500, 40))],
        ['https://c.example.com/nothing', () => htmlResponse('<meta property="og:image" content="/banner.png">')],
        ['https://c.example.com/banner.png', () => imageResponse(makePng(2400, 300))],
        ['https://c.example.com/doc.pdf', () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } })],
        ['https://intranet.example.com/page', () => htmlResponse('<meta property="og:image" content="/x.png">')],
      ]), { privateHosts: new Set(['intranet.example.com']), metrics });
      await loop.runOnce();
      const fell = await target('https://c.example.com/fallthrough');
      assert.equal(fell.status, 'ready');
      assert.equal(fell.source, 'twitter');
      assert.equal((await target('https://c.example.com/nothing')).status, 'none');
      assert.equal((await target('https://c.example.com/doc.pdf')).status, 'none');
      assert.equal((await target('https://intranet.example.com/page')).status, 'none');
      assert.equal(metrics.get('collections.link_preview.rejected_small'), 1);
      assert.equal(metrics.get('collections.link_preview.rejected_shape'), 1);
      assert.equal(metrics.get('collections.link_preview.rejected_type'), 1);
    });

    test('transport failures back off, and a failed refresh keeps the previous image', async () => {
      await enqueue('https://d.example.com/flaky');
      await worker(new Map([
        ['https://d.example.com/flaky', () => htmlResponse('<meta property="og:image" content="/a.png">')],
        ['https://d.example.com/a.png', () => imageResponse(CARD)],
      ])).loop.runOnce();
      const ready = await target('https://d.example.com/flaky');
      // Make the ready row stale and due, then fail its refresh.
      await pool().query(`UPDATE link_preview_targets SET fetched_at = now() - interval '40 days',
        updated_at = now() - interval '2 days', next_attempt_at = now() - interval '1 second'`);
      await worker(new Map([['https://d.example.com/flaky', () => new Response('down', { status: 503 })]])).loop.runOnce();
      const after = await target('https://d.example.com/flaky');
      assert.equal(after.status, 'ready');
      assert.equal(after.object_id, ready.object_id);
      assert.equal(after.failures, 1);
      assert.ok(after.next_attempt_at.getTime() > Date.now(), 'the retry is scheduled in the future');

      await enqueue('https://e.example.com/down');
      await worker(new Map()).loop.runOnce();
      const failed = await target('https://e.example.com/down');
      assert.equal(failed.status, 'failed');
      assert.equal(failed.object_id, null);
    });

    test('one user adding duplicate-image URLs cannot hide other bookmarks globally', async () => {
      const logo = makePng(1200, 630, 200);
      const routes = new Map<string, FakeRoute>();
      for (const path of ['one', 'two', 'three']) {
        routes.set(`https://blog.example.org/${path}`, () => htmlResponse('<meta property="og:image" content="https://cdn.example.org/logo.png">'));
      }
      routes.set('https://cdn.example.org/logo.png', () => imageResponse(logo));
      await enqueue('https://blog.example.org/one', 'https://blog.example.org/two');
      await worker(routes).loop.runOnce();
      assert.equal((await target('https://blog.example.org/one')).generic, false);
      await enqueue('https://blog.example.org/three');
      await worker(routes).loop.runOnce();
      for (const path of ['one', 'two', 'three']) {
        assert.equal((await target(`https://blog.example.org/${path}`)).generic, false, path);
      }
    });
    test('refreshing images preserves operator suppression without spreading it', async () => {
      await enqueue('https://github.com/example/repository', 'https://github.com/example/repository?a=1',
        'https://github.com/example/repository?a=2');
      const routes = new Map<string, FakeRoute>([
        ['https://opengraph.githubassets.com/1/example/repository', () => imageResponse(CARD)],
      ]);
      await worker(routes).loop.runOnce();
      const original = await target('https://github.com/example/repository');
      assert.equal(original.generic, false);
      await pool().query("UPDATE link_preview_targets SET generic = true, next_attempt_at = now() WHERE url_key = $1", [original.url_key]);
      await worker(routes).loop.runOnce();
      assert.equal((await target('https://github.com/example/repository')).generic, true);
      assert.equal((await target('https://github.com/example/repository?a=1')).generic, false);
      assert.equal((await target('https://github.com/example/repository?a=2')).generic, false);
    });

  });

  describe('durability', () => {
    test('an object orphaned by a lost lease is collected; referenced objects survive prune and GC', async () => {
      await enqueue('https://f.example.com/lost', 'https://f.example.com/kept');
      const routes = new Map<string, FakeRoute>([
        ['https://f.example.com/lost', () => htmlResponse('<meta property="og:image" content="/l.png">')],
        ['https://f.example.com/l.png', () => imageResponse(makePng(1200, 630, 1))],
        ['https://f.example.com/kept', () => htmlResponse('<meta property="og:image" content="/k.png">')],
        ['https://f.example.com/k.png', () => imageResponse(makePng(1200, 630, 2))],
      ]);
      const lostKey = linkPreviewTargetIdentity('https://f.example.com/lost')!.urlKey;
      const stealing: LinkPreviewRepository = {
        ...repository,
        async completeReady(input) {
          if (input.claim.urlKey === lostKey) {
            await pool().query('UPDATE link_preview_targets SET lease_owner = gen_random_uuid() WHERE url_key = $1', [lostKey]);
          }
          return repository.completeReady(input);
        },
      };
      await worker(routes, { repository: stealing }).loop.runOnce();
      const lost = await target('https://f.example.com/lost');
      const kept = await target('https://f.example.com/kept');
      assert.equal(lost.status, 'pending');
      assert.equal(store.puts.length, 2, 'both objects reached the store');
      const orphan = store.puts.find((id) => id !== kept.object_id)!;

      // Everything is past retention; only the unreferenced object may go.
      await pool().query(`UPDATE link_preview_objects SET deletable_at = now() - interval '1 second'`);
      await pool().query('UPDATE link_preview_targets SET next_attempt_at = \'infinity\'');
      await worker(routes).loop.runOnce();
      assert.deepEqual(store.deletes, [orphan]);
      assert.ok(store.objects.has(kept.object_id));
      const ledger = await pool().query('SELECT object_id FROM link_preview_objects');
      assert.deepEqual(ledger.rows.map((row) => row.object_id), [kept.object_id]);

      // Pruning an abandoned target restarts the retention clock of its object.
      await pool().query(`UPDATE link_preview_targets SET last_requested_at = now() - interval '200 days',
        lease_owner = NULL, lease_until = NULL`);
      await worker(routes).loop.runOnce();
      assert.equal((await pool().query('SELECT count(*)::int AS n FROM link_preview_targets')).rows[0].n, 0);
      assert.ok(store.objects.has(kept.object_id), 'a just-displaced object outlives its cache lifetime');
      const retained = await pool().query('SELECT deletable_at FROM link_preview_objects WHERE object_id = $1', [kept.object_id]);
      assert.ok(retained.rows[0].deletable_at.getTime() > Date.now() + 300 * 86_400_000);
    });

    test('lease renewal extends owned claims but cannot revive expired claims', async () => {
      await enqueue('https://lease.example.com/page');
      const [claim] = await repository.claimDue({ limit: 1,
        leaseOwner: '00000000-0000-4000-8000-000000000001', leaseDurationMs: 120_000 });
      assert.ok(claim);
      assert.equal(await repository.renewLease(claim, 240_000), true);
      const row = await target(claim.normalizedUrl);
      assert.ok(row.lease_until.getTime() > Date.now() + 200_000);
      assert.equal(await repository.renewLease({ ...claim, leaseOwner: '00000000-0000-4000-8000-000000000002' }, 240_000), false);
      await pool().query("UPDATE link_preview_targets SET lease_until = now() - interval '1 second'");
      assert.equal(await repository.renewLease(claim, 240_000), false);
    });

    test('an unchanged image is not uploaded again on refresh', async () => {
      await enqueue('https://g.example.com/same');
      const routes = new Map<string, FakeRoute>([
        ['https://g.example.com/same', () => htmlResponse('<meta property="og:image" content="/s.png">')],
        ['https://g.example.com/s.png', () => imageResponse(CARD)],
      ]);
      await worker(routes).loop.runOnce();
      await pool().query(`UPDATE link_preview_targets SET next_attempt_at = now() - interval '1 second'`);
      await worker(routes).loop.runOnce();
      assert.equal(store.puts.length, 1);
    });
  });

  describe('enqueue and sweep', () => {
    async function seedLibrary(): Promise<void> {
      const client = await pool().connect();
      try {
        await client.query('begin');
        await truncateGuardedTablesInTransaction(client, `
          truncate table product_command_receipts, outbox_events, audit_events, operations,
            policy_revisions, content_revisions, children_revisions, resource_revisions,
            collection_policies, collection_members, nodes, collections, resource_id_ledger,
            profiles, accounts cascade
        `);
        await client.query(`insert into accounts(id, subject_id, status, security_epoch) values ('lp-owner-account', $1, 'active', 0)`, [OWNER]);
        const nodes = [
          // id, collection, parent, kind, root, url, visibility, position
          ['lp-root', COLLECTION_ID, null, 'folder', true, null, 'inherit', null],
          ['lp-open', COLLECTION_ID, 'lp-root', 'bookmark', false, 'https://open.example.com/a', 'inherit', 'A'],
          ['lp-folder', COLLECTION_ID, 'lp-root', 'folder', false, null, 'inherit', 'B'],
          ['lp-nested', COLLECTION_ID, 'lp-folder', 'bookmark', false, 'https://open.example.com/nested', 'inherit', 'A'],
          ['lp-private-folder', COLLECTION_ID, 'lp-root', 'folder', false, null, 'private', 'C'],
          ['lp-secret', COLLECTION_ID, 'lp-private-folder', 'bookmark', false, 'https://secret.example.com/x', 'inherit', 'A'],
          ['lp-protected', COLLECTION_ID, 'lp-root', 'bookmark', false, 'https://secret.example.com/p', 'protected', 'D'],
          ['lp-vetoed', COLLECTION_ID, 'lp-root', 'bookmark', false, 'https://vetoed.example.com/v', 'inherit', 'E'],
          ['lp-root-2', PRIVATE_COLLECTION_ID, null, 'folder', true, null, 'inherit', null],
          ['lp-private-lib', PRIVATE_COLLECTION_ID, 'lp-root-2', 'bookmark', false, 'https://mine.example.com/m', 'inherit', 'A'],
        ] as const;
        await client.query(
          `insert into resource_id_ledger(resource_id, resource_type) select unnest($1::text[]), 'node'`,
          [nodes.map((node) => node[0])],
        );
        await client.query(`insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'collection')`,
          [COLLECTION_ID, PRIVATE_COLLECTION_ID]);
        await client.query(`
          insert into collections (id, owner_subject_id, title, summary, kind, visibility, root_node_id,
            resource_revision, content_revision, policy_revision, commit_ordinal, publication_slug, published_at)
          values ($1, $3, 'Public shelf', null, 'bookmarks', 'public', 'lp-root', 'r1', 'c1', 'p1', 1, 'public-shelf', now()),
                 ($2, $3, 'Private shelf', null, 'bookmarks', 'private', 'lp-root-2', 'r1', 'c1', 'p1', 1, null, null)
        `, [COLLECTION_ID, PRIVATE_COLLECTION_ID, OWNER]);
        for (const [id, collection, parent, kind, isRoot, url, visibility, position] of nodes) {
          await client.query(`
            insert into nodes (id, collection_id, parent_id, kind, is_root, title, url, description, tags,
              visibility, position_token, resource_revision, children_revision)
            values ($1, $2, $3, $4, $5, $1, $6, null, '[]'::jsonb, $7, $8, $1 || '-r1', $1 || '-cr1')
          `, [id, collection, parent, kind, isRoot, url, visibility, position]);
        }
        await client.query(`insert into bookmark_preview_prefs (node_id, collection_id, mode) values ('lp-vetoed', $1, 'none')`, [COLLECTION_ID]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }

    const urls = async () => (await pool().query('SELECT normalized_url FROM link_preview_targets ORDER BY 1')).rows
      .map((row) => row.normalized_url);

    test('a published collection enqueues only what anonymous readers can see', async () => {
      await seedLibrary();
      await worker(new Map()).loop.runOnce();
      assert.deepEqual(await urls(), ['https://open.example.com/a', 'https://open.example.com/nested']);
      const sweep = await pool().query('SELECT * FROM link_preview_collection_sweeps');
      assert.deepEqual(sweep.rows.map((row) => [row.collection_id, row.content_revision]), [[COLLECTION_ID, 'c1']]);
    });

    test('a sweep claimed before a collection becomes private cannot read its URLs', async () => {
      await seedLibrary();
      const claim = await repository.claimSweep({
        leaseOwner: '00000000-0000-4000-8000-000000000001', leaseDurationMs: 120_000, resweepAfterMs: 86_400_000,
      });
      assert.equal(claim?.collectionId, COLLECTION_ID);
      await pool().query("UPDATE collections SET visibility = 'private' WHERE id = $1", [COLLECTION_ID]);
      assert.deepEqual((await repository.listSweepUrls(COLLECTION_ID, 5_000)).urls, []);
      await pool().query(`
        WITH deleted_nodes AS (UPDATE nodes SET deleted_at = now() WHERE collection_id = $1)
        UPDATE collections SET visibility = 'public', deleted_at = now() WHERE id = $1
      `, [COLLECTION_ID]);
      assert.deepEqual((await repository.listSweepUrls(COLLECTION_ID, 5_000)).urls, []);
    });

    test('a disconnected cycle finishes and a parent cycle is not servable', async () => {
      await seedLibrary();
      await pool().query(`
        INSERT INTO resource_id_ledger(resource_id, resource_type) VALUES ('lp-cycle-a', 'node'), ('lp-cycle-b', 'node')
      `);
      await pool().query(`
        INSERT INTO nodes (id, collection_id, parent_id, kind, is_root, title, url, description, tags,
          visibility, position_token, resource_revision, children_revision)
        VALUES ('lp-cycle-b', $1, 'lp-root', 'folder', false, 'b', null, null, '[]'::jsonb, 'inherit', 'Y', 'b-r', 'b-c')
      `, [COLLECTION_ID]);
      await pool().query(`
        INSERT INTO nodes (id, collection_id, parent_id, kind, is_root, title, url, description, tags,
          visibility, position_token, resource_revision, children_revision)
        VALUES ('lp-cycle-a', $1, 'lp-cycle-b', 'folder', false, 'a', null, null, '[]'::jsonb, 'inherit', 'Z', 'a-r', 'a-c')
      `, [COLLECTION_ID]);
      await pool().query(`UPDATE nodes SET parent_id = 'lp-cycle-a' WHERE id = 'lp-cycle-b'`);
      const started = Date.now();
      const page = await repository.listSweepUrls(COLLECTION_ID, 5_000);
      assert.ok(Date.now() - started < 5_000);
      assert.equal(page.corrupted, false);
      assert.deepEqual(page.urls, ['https://open.example.com/a', 'https://open.example.com/nested']);
      const objectId = '11111111-1111-4111-8111-111111111111';
      await pool().query(`
        INSERT INTO link_preview_objects (object_id, url_key, digest, deletable_at)
        VALUES ($1, public.link_preview_url_key('https://open.example.com/a'), repeat('a', 64), now() + interval '1 day')
      `, [objectId]);
      await pool().query(`
        INSERT INTO link_preview_targets (
          url_key, normalized_url, site, status, object_id, width, height, mime, digest, generic, source
        ) VALUES (
          public.link_preview_url_key('https://open.example.com/a'), 'https://open.example.com/a', 'open.example.com',
          'ready', $1, 10, 10, 'image/png', repeat('a', 64), false, 'og'
        )
      `, [objectId]);
      const access = (await import('../../../src/infrastructure/collections/link-preview-public-access.js'))
        .createPostgresLinkPreviewPublicAccess(isolated.runtime.db, {
          cancelBackend: (pid) => isolated.runtime.cancelBackend(pid),
        });
      assert.equal(await access.isServable(objectId), true);
      await pool().query(`UPDATE nodes SET parent_id = 'lp-cycle-a' WHERE id = 'lp-open'`);
      assert.equal(await access.isServable(objectId), false);
    });

    test('a legal ancestry depth stays servable and is not reported corrupt', async () => {
      await seedLibrary();
      const legalUrl = 'https://legal.example.com/max';
      const pastUrl = 'https://past.example.com/too-deep';
      const hops = 256;
      const ids: string[] = [];
      const parents: string[] = [];
      const kinds: string[] = [];
      const urls: Array<string | null> = [];
      let parent = 'lp-root';
      for (let hop = 1; hop <= hops + 1; hop += 1) {
        const id = `lp-hop-${String(hop).padStart(4, '0')}`;
        ids.push(id);
        parents.push(parent);
        kinds.push(hop === hops + 1 ? 'bookmark' : 'folder');
        urls.push(hop === hops + 1 ? legalUrl : null);
        parent = id;
      }
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        await client.query(
          `INSERT INTO resource_id_ledger(resource_id, resource_type)
           SELECT id, 'node' FROM unnest($1::text[]) AS ids(id)`,
          [ids],
        );
        await client.query(
          `INSERT INTO nodes (id, collection_id, parent_id, kind, is_root, title, url, description, tags,
             visibility, position_token, resource_revision, children_revision)
           SELECT id, $2, parent_id, kind, false, id, url, null, '[]'::jsonb, 'inherit', id, rev, rev
             FROM unnest($1::text[], $3::text[], $4::text[], $5::text[], $6::text[])
               AS row(id, parent_id, kind, url, rev)`,
          [ids, COLLECTION_ID, parents, kinds, urls, ids],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const legalParent = `lp-hop-${String(hops).padStart(4, '0')}`;
      const legalBookmark = `lp-hop-${String(hops + 1).padStart(4, '0')}`;
      const ancestry = async (parentId: string) => isolated.runtime.db.transaction().execute(async (tx) =>
        createPostgresNodeWritePort(tx).readParentAncestry!(COLLECTION_ID, parentId, hops));
      const legalRows = await ancestry(legalParent);
      assert.equal(legalRows.at(-1)?.id, 'lp-root');
      assert.deepEqual(
        classifyParentAncestry(legalRows.map((row, index) => ({ ...row, depth: index })), COLLECTION_ID, legalBookmark, legalParent, true),
        { ok: true },
      );
      const page = await repository.listSweepUrls(COLLECTION_ID, 5_000);
      assert.equal(page.corrupted, false);
      assert.ok(page.urls.includes(legalUrl));
      const objectId = '22222222-2222-4222-8222-222222222222';
      await pool().query(`
        INSERT INTO link_preview_objects (object_id, url_key, digest, deletable_at)
        VALUES ($1, public.link_preview_url_key($2), repeat('b', 64), now() + interval '1 day')
      `, [objectId, legalUrl]);
      await pool().query(`
        INSERT INTO link_preview_targets (
          url_key, normalized_url, site, status, object_id, width, height, mime, digest, generic, source
        ) VALUES (
          public.link_preview_url_key($2), $2, 'legal.example.com',
          'ready', $1, 10, 10, 'image/png', repeat('b', 64), false, 'og'
        )
      `, [objectId, legalUrl]);
      const access = createPostgresLinkPreviewPublicAccess(isolated.runtime.db, {
        cancelBackend: (pid) => isolated.runtime.cancelBackend(pid),
      });
      assert.equal(await access.isServable(objectId), true);

      const pastClient = await pool().connect();
      try {
        await pastClient.query('BEGIN');
        await pastClient.query('SET CONSTRAINTS ALL DEFERRED');
        await pastClient.query(`INSERT INTO resource_id_ledger(resource_id, resource_type) VALUES ('lp-past-folder', 'node'), ('lp-past-mark', 'node')`);
        await pastClient.query(`
          INSERT INTO nodes (id, collection_id, parent_id, kind, is_root, title, url, description, tags,
            visibility, position_token, resource_revision, children_revision)
          VALUES ('lp-past-folder', $1, $2, 'folder', false, 'past', null, null, '[]'::jsonb, 'inherit', 'lp-past-folder', 'past-r', 'past-c')
        `, [COLLECTION_ID, legalParent]);
        await pastClient.query(`
          INSERT INTO nodes (id, collection_id, parent_id, kind, is_root, title, url, description, tags,
            visibility, position_token, resource_revision, children_revision)
          VALUES ('lp-past-mark', $1, 'lp-past-folder', 'bookmark', false, 'past mark', $2, null, '[]'::jsonb, 'inherit', 'lp-past-mark', 'past-m-r', 'past-m-c')
        `, [COLLECTION_ID, pastUrl]);
        await pastClient.query('COMMIT');
      } catch (error) {
        await pastClient.query('ROLLBACK');
        throw error;
      } finally {
        pastClient.release();
      }
      const pastRows = await ancestry('lp-past-folder');
      assert.notEqual(pastRows.at(-1)?.id, 'lp-root');
      assert.deepEqual(
        classifyParentAncestry(pastRows.map((row, index) => ({ ...row, depth: index })), COLLECTION_ID, 'lp-past-mark', 'lp-past-folder', true),
        { ok: false, code: 'depth' },
      );
      const past = await repository.listSweepUrls(COLLECTION_ID, 5_000);
      assert.equal(past.corrupted, true);
      assert.ok(past.urls.includes(legalUrl));
      assert.ok(!past.urls.includes(pastUrl));
      const pastObjectId = '33333333-3333-4333-8333-333333333333';
      await pool().query(`
        INSERT INTO link_preview_objects (object_id, url_key, digest, deletable_at)
        VALUES ($1, public.link_preview_url_key($2), repeat('c', 64), now() + interval '1 day')
      `, [pastObjectId, pastUrl]);
      await pool().query(`
        INSERT INTO link_preview_targets (
          url_key, normalized_url, site, status, object_id, width, height, mime, digest, generic, source
        ) VALUES (
          public.link_preview_url_key($2), $2, 'past.example.com',
          'ready', $1, 10, 10, 'image/png', repeat('c', 64), false, 'og'
        )
      `, [pastObjectId, pastUrl]);
      assert.equal(await access.isServable(objectId), true);
      assert.equal(await access.isServable(pastObjectId), false);
    });

    test('abort during a lock wait cancels the sweep statement', async () => {
      await seedLibrary();
      const locker = await pool().connect();
      const controller = new AbortController();
      try {
        await locker.query('BEGIN');
        await locker.query('LOCK TABLE nodes IN ACCESS EXCLUSIVE MODE');
        const pending = repository.listSweepUrls(COLLECTION_ID, 20, null, { signal: controller.signal });
        await new Promise((resolve) => { setTimeout(resolve, 200); });
        controller.abort(new DOMException('client gone', 'AbortError'));
        await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
        await locker.query('COMMIT');
      } finally {
        locker.release();
      }
      const next = await pool().query('SELECT 1 AS ok');
      assert.equal(Number(next.rows[0].ok), 1);
    });
  });
});
