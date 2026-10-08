import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import {
  createPostgresLinkHealthEnqueueUnitOfWork,
  createPostgresLinkHealthWorkerRepository,
  LinkHealthWorkerLoop,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { HardenedEgressError } from '../../../src/infrastructure/egress/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  enqueueMyLinkHealthChecks,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const OWNER = 'lh02-owner-subject';
const OUTSIDER = 'lh02-outsider-subject';
const PRINCIPAL = 'lh02-owner-account';
const COLLECTION_ID = 'lh02col0000000000000001';
const ROOT_ID = 'lh02-root';
const BOOKMARK_REDIRECT = 'lh02-bookmark-redirect';
const BOOKMARK_HEALTHY = 'lh02-bookmark-healthy';
const BOOKMARK_DENIED = 'lh02-bookmark-denied';
const BOOKMARK_DELETED = 'lh02-bookmark-deleted';
const OUTSIDER_COLLECTION = 'lh02col0000000000000002';
const OUTSIDER_ROOT = 'lh02-outsider-root';
const OUTSIDER_NODE = 'lh02-outsider-bookmark';
const PUBLIC_PIN = '1.1.1.1';
const START = 'https://bookmarks.test/from';
const FINAL = 'https://bookmarks.test/to';
const SAME = 'https://bookmarks.test/same';
const DENIED = 'https://bookmarks.test/denied';
const DELETED_URL = 'https://bookmarks.test/deleted';
const SECRET = 'https://bookmarks.test/secret';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

describeWithPostgres('LH-02 PostgreSQL link-health worker claim, CAS, and probe', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('lh02_link_health_worker', { maxConnections: 6 });
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
          collection_policies, collection_members, collection_link_health, nodes, collections,
          resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $2, 'active', 0), ('lh02-outsider-account', $3, 'active', 0)`,
        [PRINCIPAL, OWNER, OUTSIDER],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'LH-02 owner', null), ('lh02-outsider-account', 'LH-02 outsider', null)`,
        [PRINCIPAL],
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'node'), ($4, 'node'), ($5, 'node'),
         ($6, 'node'), ($7, 'collection'), ($8, 'node'), ($9, 'node')`,
        [COLLECTION_ID, ROOT_ID, BOOKMARK_REDIRECT, BOOKMARK_HEALTHY, BOOKMARK_DENIED,
          BOOKMARK_DELETED, OUTSIDER_COLLECTION, OUTSIDER_ROOT, OUTSIDER_NODE],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values
         ($1, $2, 'Owned library', null, 'bookmarks', 'private', $3, 'col-r1', 'col-c1', 'col-p1', 1),
         ($4, $5, 'Outsider library', null, 'bookmarks', 'private', $6, 'out-r1', 'out-c1', 'out-p1', 1)`,
        [COLLECTION_ID, OWNER, ROOT_ID, OUTSIDER_COLLECTION, OUTSIDER, OUTSIDER_ROOT],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision, created_at, deleted_at
         ) values
         ($1, $8, null, 'folder', true, 'Root', null, null, '[]'::jsonb, 'inherit', null, 'root-r1', 'root-cr1', $10, null),
         ($2, $8, $1, 'bookmark', false, 'Redirect', $11, null, '[]'::jsonb, 'inherit', 'A', 'redir-r1', 'redir-cr1', $10, null),
         ($3, $8, $1, 'bookmark', false, 'Healthy', $12, null, '[]'::jsonb, 'inherit', 'B', 'ok-r1', 'ok-cr1', $10, null),
         ($4, $8, $1, 'bookmark', false, 'Denied', $13, null, '[]'::jsonb, 'inherit', 'C', 'den-r1', 'den-cr1', $10, null),
         ($5, $8, $1, 'bookmark', false, 'Deleted', $14, null, '[]'::jsonb, 'inherit', 'D', 'del-r1', 'del-cr1', $10, $10),
         ($6, $9, null, 'folder', true, 'Outsider root', null, null, '[]'::jsonb, 'inherit', null, 'out-root-r1', 'out-root-cr1', $10, null),
         ($7, $9, $6, 'bookmark', false, 'Secret', $15, null, '[]'::jsonb, 'inherit', 'A', 'out-node-r1', 'out-node-cr1', $10, null)`,
        [
          ROOT_ID, BOOKMARK_REDIRECT, BOOKMARK_HEALTHY, BOOKMARK_DENIED, BOOKMARK_DELETED,
          OUTSIDER_ROOT, OUTSIDER_NODE, COLLECTION_ID, OUTSIDER_COLLECTION, new Date('2026-08-22T08:00:00.000Z'),
          START, SAME, DENIED, DELETED_URL, SECRET,
        ],
      );
      await client.query(
        `insert into collection_link_health (node_id, collection_id, status)
         values ($1, $5, 'pending'), ($2, $5, 'pending'), ($3, $5, 'pending'),
                ($4, $6, 'pending')`,
        [BOOKMARK_REDIRECT, BOOKMARK_HEALTHY, BOOKMARK_DENIED, OUTSIDER_NODE, COLLECTION_ID, OUTSIDER_COLLECTION],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  function repository() {
    return createPostgresLinkHealthWorkerRepository(isolated.runtime.pool);
  }

  test('flag-off worker composition does not start a probe loop', async () => {
    await resetLibrary();
    const off = buildWorker(loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      KNOWN_FEATURE_LINK_HEALTH: 'false',
    }), isolated.runtime, new InMemoryMetrics());
    assert.equal(off.linkHealth, undefined);
    const on = buildWorker(loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      KNOWN_FEATURE_LINK_HEALTH: 'true',
    }), isolated.runtime, new InMemoryMetrics(), {
      linkHealth: {
        resolve: async () => [PUBLIC_PIN],
        connect: async () => new Response(null, { status: 200 }),
      },
    });
    assert.ok(on.linkHealth);
    assert.equal(on.linkHealth.loop.isRunning(), false);
  });

  test('301 then 200 on a different URL is redirect from the last wrapped-connect hop', async () => {
    await resetLibrary();
    await isolated.runtime.pool.query(
      `update collection_link_health set status = 'healthy' where node_id <> $1`,
      [BOOKMARK_REDIRECT],
    );
    const hops: string[] = [];
    const worker = new LinkHealthWorkerLoop({
      repository: repository(),
      logger: silentLogger,
      workerId: 'lh02-redirect',
      probeTimeoutMs: 8_000,
      connectTimeoutMs: 3_000,
      concurrency: 1,
      perHostGapMs: 0,
      pollIntervalMs: 1_000,
      leaseDurationMs: 60_000,
      resolve: async () => [PUBLIC_PIN],
      connect: async (target, init) => {
        hops.push(target.url.href);
        assert.equal(target.ip, PUBLIC_PIN);
        const headers = new Headers(init.headers);
        assert.equal(headers.get('user-agent'), 'Known-LinkHealth/1');
        assert.equal(headers.get('cookie'), null);
        if (target.url.pathname === '/from') {
          return new Response(null, { status: 301, headers: { location: FINAL } });
        }
        return new Response(null, { status: 200 });
      },
    });
    assert.equal(await worker.runOnce(), true);
    const row = await isolated.runtime.pool.query<{
      status: string; http_status: number | null; final_url: string | null; error_class: string | null;
    }>(`select status, http_status, final_url, error_class from collection_link_health where node_id = $1`,
    [BOOKMARK_REDIRECT]);
    assert.equal(row.rows[0]?.status, 'redirect');
    assert.equal(row.rows[0]?.http_status, 200);
    assert.equal(row.rows[0]?.final_url, FINAL);
    assert.equal(hops[hops.length - 1], FINAL);
    assert.equal(hops.includes(''), false);
  });

  test('200 on the same URL is healthy', async () => {
    await resetLibrary();
    await isolated.runtime.pool.query(
      `update collection_link_health set status = 'healthy' where node_id <> $1`,
      [BOOKMARK_HEALTHY],
    );
    const worker = new LinkHealthWorkerLoop({
      repository: repository(),
      logger: silentLogger,
      workerId: 'lh02-healthy',
      probeTimeoutMs: 8_000,
      connectTimeoutMs: 3_000,
      concurrency: 1,
      perHostGapMs: 0,
      pollIntervalMs: 1_000,
      leaseDurationMs: 60_000,
      resolve: async () => [PUBLIC_PIN],
      connect: async (target) => {
        assert.equal(target.url.href, SAME);
        return new Response(null, { status: 200 });
      },
    });
    assert.equal(await worker.runOnce(), true);
    const row = await isolated.runtime.pool.query<{
      status: string; final_url: string | null; error_class: string | null;
    }>(`select status, final_url, error_class from collection_link_health where node_id = $1`,
    [BOOKMARK_HEALTHY]);
    assert.equal(row.rows[0]?.status, 'healthy');
    assert.equal(row.rows[0]?.final_url, null);
    assert.equal(row.rows[0]?.error_class, null);
  });

  test('denied_address from connect is broken and resolve was called', async () => {
    await resetLibrary();
    await isolated.runtime.pool.query(
      `update collection_link_health set status = 'healthy' where node_id <> $1`,
      [BOOKMARK_DENIED],
    );
    const resolved: string[] = [];
    let connectCalls = 0;
    const worker = new LinkHealthWorkerLoop({
      repository: repository(),
      logger: silentLogger,
      workerId: 'lh02-denied',
      probeTimeoutMs: 8_000,
      connectTimeoutMs: 3_000,
      concurrency: 1,
      perHostGapMs: 0,
      pollIntervalMs: 1_000,
      leaseDurationMs: 60_000,
      resolve: async (hostname) => {
        resolved.push(hostname);
        return [PUBLIC_PIN];
      },
      connect: async (target) => {
        connectCalls += 1;
        assert.equal(target.ip, PUBLIC_PIN);
        throw new HardenedEgressError('denied_address', 'link-health resolves to a disallowed address');
      },
    });
    assert.equal(await worker.runOnce(), true);
    const row = await isolated.runtime.pool.query<{
      status: string; error_class: string | null; http_status: number | null;
    }>(`select status, error_class, http_status from collection_link_health where node_id = $1`,
    [BOOKMARK_DENIED]);
    assert.equal(row.rows[0]?.status, 'broken');
    assert.equal(row.rows[0]?.error_class, 'denied');
    assert.equal(row.rows[0]?.http_status, null);
    assert.equal(resolved.includes('bookmarks.test'), true);
    assert.equal(connectCalls, 1);
  });

  test('soft-deleted bookmarks are not claimed', async () => {
    await resetLibrary();
    await isolated.runtime.pool.query(
      `insert into collection_link_health (node_id, collection_id, status)
       values ($1, $2, 'pending')
       on conflict (node_id) do update set status = 'pending', lease_until = null, lease_owner = null`,
      [BOOKMARK_DELETED, COLLECTION_ID],
    );
    const claims = await repository().claimDue({
      limit: 4, leaseOwner: 'lh02-claim', leaseDurationMs: 60_000,
    });
    assert.equal(claims.some((claim) => claim.nodeId === BOOKMARK_DELETED), false);
  });

  test('lost lease must not overwrite the row', async () => {
    await resetLibrary();
    await isolated.runtime.pool.query(
      `update collection_link_health set status = 'healthy' where node_id <> $1`,
      [BOOKMARK_HEALTHY],
    );
    const repo = repository();
    const claims = await repo.claimDue({
      limit: 1, leaseOwner: 'lh02-lease-a', leaseDurationMs: 60_000,
    });
    assert.equal(claims[0]?.nodeId, BOOKMARK_HEALTHY);
    await isolated.runtime.pool.query(
      `update collection_link_health set lease_owner = 'lh02-lease-b' where node_id = $1`,
      [BOOKMARK_HEALTHY],
    );
    const written = await repo.completeProbe({
      nodeId: BOOKMARK_HEALTHY,
      leaseOwner: 'lh02-lease-a',
      fact: { status: 'healthy', httpStatus: 200, finalUrl: null, errorClass: null },
      checkedAt: new Date(),
    });
    assert.equal(written, false);
    const row = await isolated.runtime.pool.query<{ status: string; checked_at: Date | null }>(
      `select status, checked_at from collection_link_health where node_id = $1`,
      [BOOKMARK_HEALTHY],
    );
    assert.equal(row.rows[0]?.status, 'pending');
    assert.equal(row.rows[0]?.checked_at, null);
  });

  test('enqueue marks only this owner pending and replays the first receipt', async () => {
    await resetLibrary();
    await isolated.runtime.pool.query(
      `update collection_link_health
          set status = 'healthy', http_status = 200, checked_at = $2, final_url = $3
        where node_id = any($1::text[])`,
      [[BOOKMARK_REDIRECT, BOOKMARK_HEALTHY, OUTSIDER_NODE], new Date('2026-08-22T07:00:00.000Z'), SAME],
    );
    const uow = createPostgresLinkHealthEnqueueUnitOfWork(isolated.runtime.db);
    const commandId = randomUUID();
    const first = await uow.execute((ports) => enqueueMyLinkHealthChecks(ports, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId,
      filter: { collectionId: COLLECTION_ID },
    }));
    assert.equal(first.kind, 'succeeded');
    if (first.kind === 'succeeded') assert.equal(first.queued, 3);
    const owned = await isolated.runtime.pool.query<{ node_id: string; status: string }>(
      `select h.node_id, h.status from collection_link_health h
       join nodes n on n.id = h.node_id
       join collections c on c.id = n.collection_id
       where c.owner_subject_id = $1`,
      [OWNER],
    );
    assert.equal(owned.rows.every((row) => row.status === 'pending'), true);
    const outsider = await isolated.runtime.pool.query<{ status: string }>(
      `select status from collection_link_health where node_id = $1`,
      [OUTSIDER_NODE],
    );
    assert.equal(outsider.rows[0]?.status, 'healthy');
    await isolated.runtime.pool.query(
      `update collection_link_health set status = 'healthy' where node_id = $1`,
      [BOOKMARK_HEALTHY],
    );
    const replay = await uow.execute((ports) => enqueueMyLinkHealthChecks(ports, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId,
      filter: { collectionId: COLLECTION_ID },
    }));
    assert.equal(replay.kind, 'replay');
    const afterReplay = await isolated.runtime.pool.query<{ status: string }>(
      `select status from collection_link_health where node_id = $1`,
      [BOOKMARK_HEALTHY],
    );
    assert.equal(afterReplay.rows[0]?.status, 'healthy');
  });
});
