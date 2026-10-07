import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildPublicationDirectoryStatement,
  createPostgresPublicationDirectoryReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createPublicationCursorKeyring,
  getPublicationDirectoryPage,
  type PublicationPrincipal,
} from '../../../src/modules/publication/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';

const OWNER = 'directory-owner';
const MEMBER = 'directory-member';
const OUTSIDER = 'directory-outsider';

describeWithPostgres('Phase 2 PostgreSQL Publication Directory evidence', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2_publication_directory', {
      maxConnections: 6,
      applicationName: 'known-phase2-publication-directory',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedDirectoryFixture(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('traverses same-millisecond microseconds and same-timestamp C ids exactly', async () => {
    const ports = queryPorts(isolated);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getPublicationDirectoryPage(ports, {
        principal: { kind: 'anonymous' },
        query: { limit: 1, ...(cursor === undefined ? {} : { cursor }) },
      });
      ids.push(...page.directory.collections.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.deepEqual(ids, [
      ...publicIds(),
      ...Array.from({ length: 600 }, (_, index) => `plan-${String(index + 1).padStart(4, '0')}`),
    ]);
    assert.equal(new Set(ids).size, ids.length);
    ports.cursors.destroy();
  });

  test('enforces visibility and lifecycle for anonymous, owner, member, and outsider', async () => {
    assert.deepEqual(await idsFor(isolated, { kind: 'anonymous' }), publicIds());
    assert.deepEqual(await idsFor(isolated, account('owner-account', OWNER)), [
      ...publicIds(), 'protected-owner',
    ]);
    assert.deepEqual(await idsFor(isolated, account('member-account', MEMBER)), [
      ...publicIds(), 'protected-member',
    ]);
    assert.deepEqual(await idsFor(isolated, account('outsider-account', OUTSIDER)), publicIds());
    for (const excluded of ['unlisted', 'private', 'deleted', 'unpublished', 'protected-outsider']) {
      assert.equal((await idsFor(isolated, account('member-account', MEMBER))).includes(excluded), false);
    }
    const publicNew = await createPostgresPublicationDirectoryReadPort(isolated.runtime).loadPage({
      principal: 'anonymous', filter: { q: 'public-new' }, limit: 1,
    });
    assert.equal(publicNew[0]?.nodeCount, 1, 'soft-deleted nodes must not contribute to nodeCount');
  });

  test('covers empty, final, and limit+1 boundaries', async () => {
    const reads = createPostgresPublicationDirectoryReadPort(isolated.runtime);
    assert.deepEqual(await reads.loadPage({ principal: 'anonymous', filter: { q: 'absent-value' }, limit: 2 }), []);
    const candidates = await reads.loadPage({ principal: 'anonymous', filter: {}, limit: 2 });
    assert.equal(candidates.length, 3);
    const ports = queryPorts(isolated);
    const final = await getPublicationDirectoryPage(ports, {
      principal: { kind: 'anonymous' }, query: { limit: 500, q: 'public' },
    });
    assert.equal(final.nextCursor, null);
    assert.deepEqual(
      final.directory.collections.map((row) => row.id).filter((id) => !id.startsWith('plan-')),
      publicIds(),
    );
    ports.cursors.destroy();
  });

  test('traverses the anonymous Directory over production HTTP and PostgreSQL ports', async () => {
    const cursors = createPublicationCursorKeyring({
      active: { id: 'directory-http-pg-v1', secret: Buffer.alloc(32, 47).toString('base64') },
      retained: [],
    });
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused/known',
      PRODUCT_ORIGIN: 'https://known.example',
      PUBLICATION_ORIGIN: 'https://known.example',
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    });
    const app = buildApiApp({
      config,
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      publicationDirectoryQuery: {
        reads: createPostgresPublicationDirectoryReadPort(isolated.runtime),
        cursors,
        origin: config.publication.origin,
        maxPageSize: config.publication.maxPageSize,
      },
    });
    try {
      const ids: string[] = [];
      let target = '/colp/v0.1/directory?limit=200';
      while (true) {
        const response = await app.inject({
          method: 'GET',
          url: target,
          headers: {
            accept: 'application/vnd.collection-protocol.catalog+json;version=0.1',
            'collection-protocol-version': '0.1',
          },
        });
        assert.equal(response.statusCode, 200);
        ids.push(...response.json().collections.map((row: { id: string }) => row.id));
        const next = /<([^>]+)>/u.exec(response.headers.link ?? '')?.[1];
        if (!next) {
          assert.equal(response.headers.link, undefined);
          break;
        }
        const nextUrl = new URL(next);
        assert.equal(nextUrl.origin, config.publication.origin);
        assert.equal(nextUrl.pathname, '/colp/v0.1/directory');
        assert.equal(nextUrl.searchParams.get('limit'), '200');
        target = `${nextUrl.pathname}${nextUrl.search}`;
      }
      assert.deepEqual(ids, [
        ...publicIds(),
        ...Array.from({ length: 600 }, (_, index) => `plan-${String(index + 1).padStart(4, '0')}`),
      ]);
      assert.equal(new Set(ids).size, ids.length);
    } finally {
      await app.close();
      cursors.destroy();
    }
  });

  test('defines concurrent update semantics as a live, non-snapshot traversal', async () => {
    const ports = queryPorts(isolated);
    const first = await getPublicationDirectoryPage(ports, {
      principal: { kind: 'anonymous' }, query: { limit: 1 },
    });
    assert.equal(first.directory.collections[0]?.id, 'public-new');
    await isolated.runtime.pool.query(
      `update collections set updated_at = '2026-07-24T00:00:01.000100Z' where id = 'public-old'`,
    );
    const continued = await getPublicationDirectoryPage(ports, {
      principal: { kind: 'anonymous' }, query: { limit: 1, cursor: first.nextCursor! },
    });
    assert.notEqual(continued.directory.collections[0]?.id, 'public-old');
    const fresh = await getPublicationDirectoryPage(ports, {
      principal: { kind: 'anonymous' }, query: { limit: 1 },
    });
    assert.equal(fresh.directory.collections[0]?.id, 'public-old');
    ports.cursors.destroy();
  });

  test('plans the exact production wide SELECT through the Directory index with bounded work', async () => {
    const statement = buildPublicationDirectoryStatement({ principal: 'anonymous', filter: {}, limit: 50 });
    // The cached count is adjusted for public moderation before it is exposed.
    assert.match(statement.text, /c\.live_node_count\b/u);
    assert.doesNotMatch(statement.text, /select count\(\*\) from nodes/i);
    assert.match(statement.text, /ordering_updated_at_micros/u);
    const explained = await isolated.runtime.pool.query<{ 'QUERY PLAN': readonly ExplainPlan[] }>(
      `explain (analyze, buffers, format json) ${statement.text}`,
      [...statement.values],
    );
    const plan = explained.rows[0]?.['QUERY PLAN'][0];
    assert.ok(plan);
    const nodes = flattenPlan(plan.Plan);
    assert.ok(nodes.some((node) => node['Index Name'] === 'collections_publication_directory_order_idx'));
    assert.equal(nodes.some((node) => node['Node Type'] === 'Sort'), false);
    assert.equal(nodes.some((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'collections'), false);
    assert.ok((plan.Plan['Actual Rows'] ?? 0) <= 51);
    assert.ok(sharedBlocks(nodes) > 0);
    assert.ok(sharedBlocks(nodes) < 20_000);
  });
});

interface ExplainNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly Plans?: readonly ExplainNode[];
}
interface ExplainPlan { readonly Plan: ExplainNode }

function flattenPlan(node: ExplainNode): readonly ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

function sharedBlocks(nodes: readonly ExplainNode[]): number {
  return nodes.reduce((sum, node) => sum + (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0), 0);
}

function queryPorts(isolatedRuntime: IsolatedPostgresRuntime) {
  return {
    reads: createPostgresPublicationDirectoryReadPort(isolatedRuntime.runtime),
    cursors: createPublicationCursorKeyring({
      active: { id: 'directory-pg-v1', secret: Buffer.alloc(32, 43).toString('base64') },
      retained: [],
    }),
    origin: 'https://known.example',
  };
}

function account(principalId: string, subjectId: string): PublicationPrincipal {
  return { kind: 'account', principalId, subjectId };
}

async function idsFor(isolatedRuntime: IsolatedPostgresRuntime, principal: PublicationPrincipal): Promise<readonly string[]> {
  const ports = queryPorts(isolatedRuntime);
  try {
    const page = await getPublicationDirectoryPage(ports, { principal, query: { limit: 500 } });
    return page.directory.collections.map((row) => row.id).filter((id) => !id.startsWith('plan-'));
  } finally {
    ports.cursors.destroy();
  }
}

function publicIds(): readonly string[] {
  return ['public-new', 'public-middle', 'public-A', 'public-a', 'public-old'];
}

async function seedDirectoryFixture(isolatedRuntime: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolatedRuntime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    const fixtures = [
      ['public-new', 'public', '2026-07-24T00:00:00.000900Z', OWNER, true, false],
      ['public-middle', 'public', '2026-07-24T00:00:00.000800Z', OWNER, true, false],
      ['public-A', 'public', '2026-07-24T00:00:00.000700Z', OWNER, true, false],
      ['public-a', 'public', '2026-07-24T00:00:00.000700Z', OWNER, true, false],
      ['public-old', 'public', '2026-07-24T00:00:00.000600Z', OWNER, true, false],
      ['protected-owner', 'protected', '2026-07-23T00:00:00Z', OWNER, true, false],
      ['protected-member', 'protected', '2026-07-22T00:00:00Z', 'another-owner', true, false],
      ['protected-outsider', 'protected', '2026-07-21T00:00:00Z', 'another-owner', true, false],
      ['unlisted', 'unlisted', '2026-07-20T00:00:00Z', OWNER, true, false],
      ['private', 'private', '2026-07-19T00:00:00Z', OWNER, true, false],
      ['deleted', 'public', '2026-07-18T00:00:00Z', OWNER, true, true],
      ['unpublished', 'protected', '2026-07-17T00:00:00Z', OWNER, false, false],
    ] as const;
    for (const [index, [id, visibility, updatedAt, owner, published, deleted]] of fixtures.entries()) {
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [id, `${id}-root`],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at, deleted_at, updated_at)
         values ($1, $2, $1, 'bookmarks', $3, $4, 'r1', 'c1', 'p1', $8,
                 case when $5 then $6::timestamptz else null end,
                 case when $7 then $6::timestamptz else null end, $6::timestamptz)`,
        [id, owner, visibility, `${id}-root`, published, updatedAt, deleted, `directory-${index}`],
      );
      await client.query(
        `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision, deleted_at)
         values ($1, $2, 'folder', true, $2, 'r1', 'ch1', case when $3 then $4::timestamptz else null end)`,
        [`${id}-root`, id, deleted, updatedAt],
      );
    }
    await client.query(
      `insert into collection_members(collection_id, subject_id, role)
       values ('protected-member', $1, 'viewer')`,
      [MEMBER],
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ('public-new-soft-node', 'node')`,
    );
    await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, is_root, title, position_token,
         resource_revision, children_revision, deleted_at, deleted_commit_ordinal)
       values ('public-new-soft-node', 'public-new', 'public-new-root', 'folder', false,
               'Soft deleted', 'A001', 'r1', 'ch1', '2026-07-24T00:00:00Z', 1)`,
    );
    await seedPlanRows(client);
    await client.query('commit');
    await isolatedRuntime.runtime.pool.query('analyze collections');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seedPlanRows(client: import('pg').PoolClient): Promise<void> {
  await client.query(`
    insert into resource_id_ledger(resource_id, resource_type)
    select 'plan-' || lpad(n::text, 4, '0'), 'collection' from generate_series(1, 600) n
    union all
    select 'plan-root-' || lpad(n::text, 4, '0'), 'node' from generate_series(1, 600) n
  `);
  await client.query(`
    insert into collections
      (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
       content_revision, policy_revision, publication_slug, published_at, updated_at)
    select 'plan-' || lpad(n::text, 4, '0'), $1, 'Plan ' || n, 'bookmarks', 'public',
           'plan-root-' || lpad(n::text, 4, '0'), 'r1', 'c1', 'p1',
           'plan-' || lpad(n::text, 4, '0'), '2026-01-01T00:00:00Z'::timestamptz,
           '2026-01-01T00:00:00Z'::timestamptz - n * interval '1 second'
      from generate_series(1, 600) n
  `, [OWNER]);
  await client.query(`
    insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
    select 'plan-root-' || lpad(n::text, 4, '0'), 'plan-' || lpad(n::text, 4, '0'),
           'folder', true, 'Plan root ' || n, 'r1', 'ch1'
      from generate_series(1, 600) n
  `);
}
