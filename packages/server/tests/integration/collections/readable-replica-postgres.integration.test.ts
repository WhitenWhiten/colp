import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import {
  createMozillaReadableArticleExtractor,
  createPostgresReadableReplicaUnitOfWork,
  createPostgresReadableReplicaWorkerRepository,
  ReadableReplicaWorkerLoop,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  getNodeReadableReplica,
  ReadableReplicaNotFoundError,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const NOW = new Date('2026-08-24T08:00:00.000Z');
const OWNER = 'rr-owner-subject';
const VIEWER = 'rr-viewer-subject';
const OUTSIDER = 'rr-outsider-subject';
const COLLECTION_ID = 'rrcol01rrcol01rrcol01A';
const ROOT_ID = 'rr-canonical-root';
const BOOKMARK_ID = 'rr-bookmark-article';
const FOLDER_ID = 'rr-folder';
const STORED_ETAG = '"rr-sidecar-pg-1"';
const BOOKMARK_URL = 'https://example.test/readable-article';
const PUBLIC_PIN = '1.1.1.1';
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/readable-replica');
const silentLogger = { info() {}, warn() {}, error() {} };

describeWithPostgres('RX-01 PostgreSQL readable replica GET join', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('rr01_readable_replica', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  async function resetLibrary(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, outbox_events, audit_events, operations,
          policy_revisions, content_revisions, children_revisions, resource_revisions,
          collection_policies, collection_members, collection_readable_replicas, nodes, collections,
          resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ('rr-owner-account', $1, 'active', 0), ('rr-viewer-account', $2, 'active', 0),
                ('rr-outsider-account', $3, 'active', 0)`,
        [OWNER, VIEWER, OUTSIDER],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ('rr-owner-account', 'Readable owner', null),
                ('rr-viewer-account', 'Readable viewer', null),
                ('rr-outsider-account', 'Readable outsider', null)`,
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'node'), ($4, 'node')`,
        [COLLECTION_ID, ROOT_ID, BOOKMARK_ID, FOLDER_ID],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values
         ($1, $2, 'Readable library', null, 'bookmarks', 'private', $3, 'col-r1', 'col-c1', 'col-p1', 1)`,
        [COLLECTION_ID, OWNER, ROOT_ID],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision, created_at
         ) values
         ($1, $3, null, 'folder', true, 'Root', null, null, '[]'::jsonb, 'inherit', null, 'root-r1', 'root-cr1', $5),
         ($2, $3, $1, 'bookmark', false, 'Article', $6, null, '[]'::jsonb,
          'inherit', 'A', 'node-a-r1', 'node-a-cr1', $5),
         ($4, $3, $1, 'folder', false, 'Notes', null, null, '[]'::jsonb, 'inherit', 'B', 'folder-r1', 'folder-cr1', $5)`,
        [ROOT_ID, BOOKMARK_ID, COLLECTION_ID, FOLDER_ID, NOW, BOOKMARK_URL],
      );
      await client.query(
        `insert into collection_members (collection_id, subject_id, role) values ($1, $2, 'viewer')`,
        [COLLECTION_ID, VIEWER],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function readAs(subjectId: string, nodeId: string) {
    const unit = createPostgresReadableReplicaUnitOfWork(isolated.runtime.db);
    return unit.execute((ports) => getNodeReadableReplica(ports, {
      actor: { principalId: `${subjectId}-principal`, subjectId },
      collectionId: COLLECTION_ID,
      nodeId,
    }));
  }

  test('owner and viewer GET none when the sidecar row is absent', async () => {
    await resetLibrary();
    const owner = await readAs(OWNER, BOOKMARK_ID);
    assert.equal(owner.status, 'none');
    assert.equal(owner.etag, null);
    assert.deepEqual(owner.sections, []);
    assert.equal(owner.sourceUrl, BOOKMARK_URL);
    const viewer = await readAs(VIEWER, BOOKMARK_ID);
    assert.equal(viewer.status, 'none');
    assert.equal(viewer.etag, null);
  });

  test('sidecar row returns the stored etag column', async () => {
    await resetLibrary();
    await isolated.runtime.pool.query(
      `insert into collection_readable_replicas (
         node_id, collection_id, status, source_url, title, byline, word_count, sections,
         failure_code, etag, extracted_at, updated_at
       ) values ($1, $2, 'ready', $3, 'Article', 'Ada', 4, $4::jsonb, null, $5, $6, $6)`,
      [
        BOOKMARK_ID,
        COLLECTION_ID,
        BOOKMARK_URL,
        JSON.stringify([{ id: 's0', heading: 'Intro', paragraphs: [{ id: 's0-p0', text: 'Hello' }] }]),
        STORED_ETAG,
        NOW,
      ],
    );
    const view = await readAs(OWNER, BOOKMARK_ID);
    assert.equal(view.status, 'ready');
    assert.equal(view.etag, STORED_ETAG);
    assert.equal(view.title, 'Article');
    assert.equal(view.sections.length, 1);
  });

  test('folder, unknown node, outsider, and public non-member are not found', async () => {
    await resetLibrary();
    await assert.rejects(() => readAs(OWNER, FOLDER_ID), ReadableReplicaNotFoundError);
    await assert.rejects(() => readAs(OWNER, 'rr-missing-node'), ReadableReplicaNotFoundError);
    await assert.rejects(() => readAs(OUTSIDER, BOOKMARK_ID), ReadableReplicaNotFoundError);
    await isolated.runtime.pool.query(
      `update collections
         set visibility = 'public', publication_slug = 'rr-public-lib', published_at = $2
       where id = $1`,
      [COLLECTION_ID, NOW],
    );
    await assert.rejects(() => readAs(OUTSIDER, BOOKMARK_ID), ReadableReplicaNotFoundError);
  });
});

describeWithPostgres('RX-02 PostgreSQL readable replica worker extract', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('rr02_readable_replica', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  async function resetLibrary(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, outbox_events, audit_events, operations,
          policy_revisions, content_revisions, children_revisions, resource_revisions,
          collection_policies, collection_members, collection_readable_replicas, nodes, collections,
          resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ('rr-owner-account', $1, 'active', 0)`,
        [OWNER],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ('rr-owner-account', 'Readable owner', null)`,
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'node')`,
        [COLLECTION_ID, ROOT_ID, BOOKMARK_ID],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values
         ($1, $2, 'Readable library', null, 'bookmarks', 'private', $3, 'col-r1', 'col-c1', 'col-p1', 1)`,
        [COLLECTION_ID, OWNER, ROOT_ID],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision, created_at
         ) values
         ($1, $3, null, 'folder', true, 'Root', null, null, '[]'::jsonb, 'inherit', null, 'root-r1', 'root-cr1', $4),
         ($2, $3, $1, 'bookmark', false, 'Article', $5, null, '[]'::jsonb,
          'inherit', 'A', 'node-a-r1', 'node-a-cr1', $4)`,
        [ROOT_ID, BOOKMARK_ID, COLLECTION_ID, NOW, BOOKMARK_URL],
      );
      await client.query(
        `insert into collection_readable_replicas (
           node_id, collection_id, status, source_url, title, byline, word_count, sections,
           failure_code, etag, extracted_at, updated_at, enqueued_at
         ) values ($1, $2, 'pending', $3, null, null, 0, '[]'::jsonb, null, '"rr-pending"', null, $4, $4)`,
        [BOOKMARK_ID, COLLECTION_ID, BOOKMARK_URL, NOW],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  test('flag-off worker composition does not start a readable-replica loop', async () => {
    await resetLibrary();
    const off = buildWorker(loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      KNOWN_FEATURE_READABLE_REPLICA: 'false',
    }), isolated.runtime, new InMemoryMetrics());
    assert.equal(off.readableReplica, undefined);
    const on = buildWorker(loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      KNOWN_FEATURE_READABLE_REPLICA: 'true',
    }), isolated.runtime, new InMemoryMetrics(), {
      readableReplica: {
        resolve: async () => [PUBLIC_PIN],
        connect: async () => new Response('<html></html>', {
          status: 200, headers: { 'content-type': 'text/html' },
        }),
      },
    });
    assert.ok(on.readableReplica);
    assert.equal(on.readableReplica.loop.isRunning(), false);
  });

  test('injected HTML fixture becomes ready with extractor sections', async () => {
    await resetLibrary();
    const html = readFileSync(join(fixturesDir, 'blog-article.html'), 'utf8');
    const expected = createMozillaReadableArticleExtractor()({ html, url: BOOKMARK_URL });
    assert.equal(expected.kind, 'article');
    const worker = new ReadableReplicaWorkerLoop({
      repository: createPostgresReadableReplicaWorkerRepository(isolated.runtime.pool),
      logger: silentLogger,
      workerId: 'rr02-html',
      probeTimeoutMs: 8_000,
      connectTimeoutMs: 3_000,
      concurrency: 1,
      perHostGapMs: 0,
      pollIntervalMs: 1_000,
      leaseDurationMs: 60_000,
      resolve: async () => [PUBLIC_PIN],
      connect: async () => new Response(html, {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    });
    assert.equal(await worker.runOnce(), true);
    const row = await isolated.runtime.pool.query<{
      status: string;
      failure_code: string | null;
      sections: unknown;
      lease_owner: string | null;
      lease_until: Date | null;
      title: string | null;
    }>(
      `select status, failure_code, sections, lease_owner, lease_until, title
         from collection_readable_replicas where node_id = $1`,
      [BOOKMARK_ID],
    );
    assert.equal(row.rows[0]?.status, 'ready');
    assert.equal(row.rows[0]?.failure_code, null);
    assert.equal(row.rows[0]?.lease_owner, null);
    assert.equal(row.rows[0]?.lease_until, null);
    if (expected.kind === 'article') {
      assert.equal(row.rows[0]?.title, expected.title);
      assert.deepEqual(row.rows[0]?.sections, expected.sections);
    }
  });

  test('injected non-HTML response is unsupported with not_html', async () => {
    await resetLibrary();
    const worker = new ReadableReplicaWorkerLoop({
      repository: createPostgresReadableReplicaWorkerRepository(isolated.runtime.pool),
      logger: silentLogger,
      workerId: 'rr02-pdf',
      probeTimeoutMs: 8_000,
      connectTimeoutMs: 3_000,
      concurrency: 1,
      perHostGapMs: 0,
      pollIntervalMs: 1_000,
      leaseDurationMs: 60_000,
      resolve: async () => [PUBLIC_PIN],
      connect: async () => new Response('%PDF-1.4', {
        status: 200, headers: { 'content-type': 'application/pdf' },
      }),
    });
    assert.equal(await worker.runOnce(), true);
    const row = await isolated.runtime.pool.query<{
      status: string;
      failure_code: string | null;
      lease_owner: string | null;
    }>(
      `select status, failure_code, lease_owner from collection_readable_replicas where node_id = $1`,
      [BOOKMARK_ID],
    );
    assert.equal(row.rows[0]?.status, 'unsupported');
    assert.equal(row.rows[0]?.failure_code, 'not_html');
    assert.equal(row.rows[0]?.lease_owner, null);
  });

  test('claimDue skips pending rows whose collection is soft-deleted', async () => {
    await resetLibrary();
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(
        `update collections set deleted_at = $2 where id = $1`,
        [COLLECTION_ID, NOW],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    const liveBookmark = await isolated.runtime.pool.query<{ deleted_at: Date | null }>(
      `select deleted_at from nodes where id = $1`,
      [BOOKMARK_ID],
    );
    assert.equal(liveBookmark.rows[0]?.deleted_at, null);
    const claims = await createPostgresReadableReplicaWorkerRepository(isolated.runtime.pool).claimDue({
      limit: 4, leaseOwner: 'rr-deleted-col', leaseDurationMs: 60_000,
    });
    assert.deepEqual(claims, []);
  });
});
