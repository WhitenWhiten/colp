/**
 * LP-03: link preview worker against PostgreSQL with a fake egress and an
 * in-memory object store. No real network, no R2.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import {
  createPostgresLinkPreviewRepository,
  LinkPreviewWorkerLoop,
  type LinkPreviewRepository,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { linkPreviewTargetIdentity } from '../../../src/modules/collections/index.js';
import {
  createFakeEgress,
  createMemoryObjectStore,
  type FakeRoute,
  type MemoryObjectStore,
} from '../../support/link-preview-fixtures.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  truncateGuardedTablesInTransaction,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { loadConfig } from '../../support/test-config.js';

const OWNER = 'lp-owner-subject';
const COLLECTION_ID = 'lpcol01lpcol01lpcol01A';
const PRIVATE_COLLECTION_ID = 'lpcol02lpcol02lpcol02B';
const silentLogger = { info() {}, warn() {}, error() {} };
const immediateGate = { run: (_host: string, work: () => Promise<void>) => work() };

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

    test('stopping during a sweep releases the lease and keeps the saved cursor', async () => {
      await seedLibrary();
      await pool().query(`
        INSERT INTO link_preview_collection_sweeps (collection_id, cursor_url, cursor_revision)
        VALUES ($1, 'https://open.example.com/a', 'c1')
      `, [COLLECTION_ID]);
      const locker = await pool().connect();
      try {
        await locker.query('BEGIN');
        await locker.query('LOCK TABLE nodes IN ACCESS EXCLUSIVE MODE');
        const { loop } = worker(new Map());
        loop.start();
        await new Promise((resolve) => { setTimeout(resolve, 200); });
        const held = (await pool().query(
          'SELECT lease_owner, lease_until, cursor_url FROM link_preview_collection_sweeps WHERE collection_id = $1',
          [COLLECTION_ID],
        )).rows[0];
        assert.ok(held.lease_owner, 'the sweep lease is held while the scan is blocked');
        assert.equal(held.cursor_url, 'https://open.example.com/a');
        await loop.stop();
        await locker.query('COMMIT');
      } finally {
        locker.release();
      }
      const row = (await pool().query(
        'SELECT lease_owner, lease_until, cursor_url, cursor_revision, content_revision, swept_at FROM link_preview_collection_sweeps WHERE collection_id = $1',
        [COLLECTION_ID],
      )).rows[0];
      assert.equal(row.lease_owner, null);
      assert.equal(row.lease_until, null);
      assert.equal(row.cursor_url, 'https://open.example.com/a');
      assert.equal(row.cursor_revision, 'c1');
      assert.equal(row.content_revision, null);
      assert.equal(row.swept_at, null);
    });

    test('a new content revision re-sweeps; an unchanged collection waits for the periodic re-sweep', async () => {
      await seedLibrary();
      await worker(new Map()).loop.runOnce();
      await pool().query(`UPDATE nodes SET url = 'https://open.example.com/b' WHERE id = 'lp-open'`);
      await worker(new Map()).loop.runOnce();
      assert.ok(!(await urls()).includes('https://open.example.com/b'), 'same revision: no re-sweep yet');
      await pool().query(`UPDATE collections SET content_revision = 'c2' WHERE id = $1`, [COLLECTION_ID]);
      await worker(new Map()).loop.runOnce();
      assert.ok((await urls()).includes('https://open.example.com/b'));
      await pool().query(`UPDATE link_preview_collection_sweeps SET swept_at = now() - interval '31 days'`);
      await pool().query(`UPDATE link_preview_targets SET last_requested_at = now() - interval '10 days'`);
      await worker(new Map()).loop.runOnce();
      const touched = await pool().query(`SELECT count(*)::int AS n FROM link_preview_targets WHERE last_requested_at > now() - interval '1 hour'`);
      assert.ok(touched.rows[0].n >= 2, 'the periodic re-sweep refreshes last_requested_at');
    });

    test('continues capped sweeps across worker restarts and resets the cursor on edits', async () => {
      await seedLibrary();
      await worker(new Map(), { sweepUrlLimit: 1 }).loop.runOnce();
      assert.deepEqual(await urls(), ['https://open.example.com/a']);
      const partial = (await pool().query('SELECT * FROM link_preview_collection_sweeps')).rows[0];
      assert.equal(partial.content_revision, null);
      assert.equal(partial.cursor_url, 'https://open.example.com/a');
      await worker(new Map(), { sweepUrlLimit: 1 }).loop.runOnce();
      assert.deepEqual(await urls(), ['https://open.example.com/a', 'https://open.example.com/nested']);
      const done = (await pool().query('SELECT * FROM link_preview_collection_sweeps')).rows[0];
      assert.equal(done.content_revision, 'c1');
      assert.equal(done.cursor_url, null);
      await pool().query("UPDATE link_preview_collection_sweeps SET cursor_url = 'https://z.example.com/z', cursor_revision = 'c1'");
      await pool().query("UPDATE collections SET content_revision = 'c2' WHERE id = $1", [COLLECTION_ID]);
      const claim = await repository.claimSweep({
        leaseOwner: '00000000-0000-4000-8000-000000000001', leaseDurationMs: 120_000, resweepAfterMs: 86_400_000,
      });
      assert.equal(claim?.afterUrl, null);
    });

    test('enqueue revives stale terminal rows and leaves fresh ones parked', async () => {
      await enqueue('https://h.example.com/none', 'https://h.example.com/fresh');
      await pool().query(`UPDATE link_preview_targets SET status = 'none', next_attempt_at = 'infinity',
        updated_at = CASE WHEN normalized_url LIKE '%none' THEN now() - interval '15 days' ELSE now() END`);
      await enqueue('https://h.example.com/none', 'https://h.example.com/fresh', 'https://h.example.com/none');
      assert.ok((await target('https://h.example.com/none')).next_attempt_at.getTime() <= Date.now());
      assert.equal((await target('https://h.example.com/fresh')).next_attempt_at, Infinity);
    });
  });

  test('buildWorker composes the loop only with the flag on and a store present', () => {
    const env = {
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    };
    assert.equal(buildWorker(loadConfig(env), isolated.runtime, new InMemoryMetrics()).linkPreview, undefined);
    const enabled = loadConfig({ ...env, KNOWN_FEATURE_LINK_PREVIEW: 'true' });
    assert.throws(() => buildWorker(enabled, isolated.runtime, new InMemoryMetrics()), /link preview object store/u);
    const on = buildWorker(enabled, isolated.runtime, new InMemoryMetrics(), { linkPreview: { store } });
    assert.ok(on.linkPreview);
    assert.equal(on.linkPreview.loop.isRunning(), false);
  });
});
