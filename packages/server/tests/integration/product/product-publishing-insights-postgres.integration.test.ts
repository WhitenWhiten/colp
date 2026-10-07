import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Kysely, KyselyPlugin } from 'kysely';
import { loadConfig } from '../../support/test-config.js';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import {
  createPostgresPublicationInsightFactsPort,
  createPostgresPublicationInsightStore,
  createPostgresPublishingInsightsDashboardPort,
  createVisitorHashPort,
} from '../../../src/infrastructure/publication/index.js';
import { createMemoryPublishingInsightsIngestRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { getPublishingInsights, recordInsightEvent, PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://known.example';
const INSTANT = '2026-08-18T12:00:00.000Z';
const NOW = new Date(INSTANT);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PEPPER = Buffer.alloc(32, 37);
const RATE_PEPPER = Buffer.alloc(32, 41);
const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(INSTANT));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });

function utcDay(offsetDays: number): string {
  return new Date(NOW.getTime() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

describeWithPostgres('product publishing insights postgres', () => {
  let isolated: IsolatedPostgresRuntime;
  let ownerA: Awaited<ReturnType<typeof issueTestSession>>;
  let ownerB: Awaited<ReturnType<typeof issueTestSession>>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('pi03_publishing_insights');
    await runMigrations(isolated.runtime.db, 'latest');
    ownerA = await issueTestSession({ factory, subject: 'owner-a', handle: 'insight-dash-a' });
    ownerB = await issueTestSession({ factory, subject: 'owner-b', handle: 'insight-dash-b' });
    await seedFixtures(isolated, { ownerA: ownerA.subjectId, ownerB: ownerB.subjectId });
    await isolated.runtime.pool.query('analyze publication_insight_daily');
    await isolated.runtime.pool.query('analyze publication_insight_events');
    await isolated.runtime.pool.query('analyze collections');
    await isolated.runtime.pool.query('analyze nodes');
  }, 180_000);

  afterAll(async () => isolated?.close());

  test('owner A cannot see owner B counts despite similar titles and slugs', async () => {
    const app = buildDashboardApp(isolated);
    try {
      const responseA = await getInsights(app, ownerA.cookie);
      const responseB = await getInsights(app, ownerB.cookie);
      assert.equal(responseA.statusCode, 200);
      assert.equal(responseB.statusCode, 200);
      const bodyA = responseA.json();
      const bodyB = responseB.json();
      assert.equal(bodyA.funnel[0].value, 10);
      assert.equal(bodyA.funnel[1].value, 3);
      assert.equal(bodyB.funnel[0].value, 7);
      assert.equal(bodyB.funnel[1].value, 2);
      assert.equal(bodyA.topResources[0]?.title, 'Shared Title');
      assert.equal(bodyB.topResources[0]?.title, 'Shared Title');
      assert.equal(bodyA.topResources[0]?.collectionId, 'col-alpha-a');
      assert.equal(bodyB.topResources[0]?.collectionId, 'col-alpha-b');
      assert.notEqual(bodyA.topResources[0]?.id, bodyB.topResources[0]?.id);
    } finally {
      await app.close();
    }
  });

  test('HTTP GET matches SUM of publication_insight_daily for the window', async () => {
    const fromDay = utcDay(-29);
    const toDay = utcDay(1);
    const summed = await isolated.runtime.pool.query<{ event_type: string; total: string }>(
      `select d.event_type, sum(d.count)::text as total
         from publication_insight_daily d
         inner join collections c on c.id = d.collection_id
        where c.owner_subject_id = $1
          and c.deleted_at is null
          and c.visibility in ('public', 'unlisted')
          and c.publication_slug is not null
          and c.published_at is not null
          and d.day >= $2::date
          and d.day < $3::date
          and d.event_type in ('collection_view', 'preview_open')
        group by d.event_type`,
      [ownerA.subjectId, fromDay, toDay],
    );
    const byType = Object.fromEntries(summed.rows.map((row) => [row.event_type, Number(row.total)]));
    const app = buildDashboardApp(isolated);
    try {
      const response = await getInsights(app, ownerA.cookie);
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.funnel[0].value, byType.collection_view ?? 0);
      assert.equal(body.funnel[1].value, byType.preview_open ?? 0);
      const eventsWouldAdd = await isolated.runtime.pool.query<{ n: string }>(
        `select count(*)::text as n from publication_insight_events
          where collection_id = 'col-alpha-a' and event_type = 'collection_view'`,
      );
      assert.notEqual(Number(eventsWouldAdd.rows[0]?.n ?? 0), body.funnel[0].value);
    } finally {
      await app.close();
    }
  });

  test('dashboard EXPLAIN uses compiled listDailyCounts and the daily owner-window index', async () => {
    const compiled = await compileListDailyCounts(isolated.runtime.db, {
      ownerSubjectId: ownerA.subjectId,
      fromDayInclusive: utcDay(-29),
      toDayExclusive: utcDay(1),
      eventTypes: PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES,
    });
    assert.match(compiled.sql, /publication_insight_daily/i);
    assert.match(compiled.sql, /owner_subject_id/i);
    assert.match(compiled.sql, /d\.event_type IN \(\$\d+, \$\d+\)/i);
    assert.equal(compiled.parameters.includes('collection_view'), true);
    assert.equal(compiled.parameters.includes('preview_open'), true);
    assert.equal(compiled.parameters.includes('resource_open'), false);
    assert.doesNotMatch(compiled.sql, /resource_open/i);
    assert.doesNotMatch(compiled.sql, /publication_insight_events/i);
    const natural = await isolated.runtime.pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN ${compiled.sql}`,
      [...compiled.parameters],
    );
    const plan = natural.rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.doesNotMatch(plan, /Seq Scan on publication_insight_events/i);
    assert.doesNotMatch(plan, /publication_insight_events/i);
    // T-09 (202609260500) drops the (collection_id, day) window index as a
    // strict prefix duplicate; the composite PK serves the owner window read.
    const indexes = await isolated.runtime.pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = current_schema()
          and indexname in ('publication_insight_daily_owner_window_idx',
                            'publication_insight_daily_pkey')`,
    );
    assert.deepEqual(indexes.rows.map((row) => row.indexname), ['publication_insight_daily_pkey']);
  });

  test('ingest POST then owner GET matches dual-written daily counts', async () => {
    const app = buildDashboardApp(isolated);
    try {
      const before = await getInsights(app, ownerA.cookie);
      assert.equal(before.statusCode, 200);
      const viewsBefore = before.json().funnel[0].value as number;
      const ingest = await app.inject({
        method: 'POST',
        url: '/api/v1/public-collections/alpha-notes/insight-events',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: { eventType: 'collection_view' },
      });
      assert.equal(ingest.statusCode, 204);
      const after = await getInsights(app, ownerA.cookie);
      assert.equal(after.statusCode, 200);
      assert.equal(after.json().funnel[0].value, viewsBefore + 1);
    } finally {
      await app.close();
    }
  });

  test('application query on postgres matches HTTP for an empty other subject', async () => {
    const outsider = await issueTestSession({ factory, subject: 'owner-c', handle: 'insight-dash-c' });
    const dashboard = createPostgresPublishingInsightsDashboardPort(isolated.runtime.db);
    const result = await getPublishingInsights({ dashboard }, { subjectId: outsider.subjectId }, NOW);
    assert.deepEqual(result.funnel.map((item) => item.value), [0, 0]);
    assert.deepEqual(result.weekly.map((item) => item.views), [0, 0, 0, 0]);
    assert.deepEqual(result.topResources, []);
    const app = buildDashboardApp(isolated);
    try {
      const response = await getInsights(app, outsider.cookie);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), result);
    } finally {
      await app.close();
    }
  });

  test('listDailyCounts SQL excludes resource_open even when hundreds of daily rows exist', async () => {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      for (let index = 0; index < 220; index += 1) {
        await insertDaily(client, 'col-alpha-a', utcDay(-1), 'resource_open', `flood-${index}`, 3);
      }
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const dashboard = createPostgresPublishingInsightsDashboardPort(isolated.runtime.db);
    const listed = await dashboard.listDailyCounts({
      ownerSubjectId: ownerA.subjectId,
      fromDayInclusive: utcDay(-29),
      toDayExclusive: utcDay(1),
      eventTypes: PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES,
    });
    assert.equal(listed.some((row) => row.eventType === 'resource_open'), false);
    assert.ok(listed.some((row) => row.eventType === 'collection_view'));
    assert.ok(listed.some((row) => row.eventType === 'preview_open'));

    const viewsOnly = await dashboard.listDailyCounts({
      ownerSubjectId: ownerA.subjectId,
      fromDayInclusive: utcDay(-29),
      toDayExclusive: utcDay(1),
      eventTypes: ['collection_view'],
    });
    assert.equal(viewsOnly.length > 0, true);
    assert.equal(viewsOnly.every((row) => row.eventType === 'collection_view'), true);
    assert.equal(viewsOnly.some((row) => row.eventType === 'preview_open'), false);

    const compiled = await compileListDailyCounts(isolated.runtime.db, {
      ownerSubjectId: ownerA.subjectId,
      fromDayInclusive: utcDay(-29),
      toDayExclusive: utcDay(1),
      eventTypes: PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES,
    });
    const raw = await isolated.runtime.pool.query<{ event_type: string }>(
      compiled.sql,
      [...compiled.parameters],
    );
    assert.equal(raw.rows.some((row) => row.event_type === 'resource_open'), false);
    assert.ok(raw.rows.some((row) => row.event_type === 'collection_view'));
    assert.ok(raw.rows.some((row) => row.event_type === 'preview_open'));

    const app = buildDashboardApp(isolated);
    try {
      const response = await getInsights(app, ownerA.cookie);
      assert.equal(response.statusCode, 200);
      const body = response.json();
      const views = listed
        .filter((row) => row.eventType === 'collection_view')
        .reduce((sum, row) => sum + row.count, 0);
      const previews = listed
        .filter((row) => row.eventType === 'preview_open')
        .reduce((sum, row) => sum + row.count, 0);
      assert.equal(body.funnel[0].value, views);
      assert.equal(body.funnel[1].value, previews);
      assert.ok(views >= 10);
      assert.equal(body.topResources[0]?.id, 'bm-a');
      assert.equal(body.topResources[0]?.opens, 6);
      assert.equal(body.weekly.length, 4);
    } finally {
      await app.close();
    }
  });
});

function buildDashboardApp(runtime: IsolatedPostgresRuntime) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: ORIGIN,
    PUBLICATION_ORIGIN: ORIGIN,
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  });
  const visitorHash = createVisitorHashPort(PEPPER);
  const limiter = createMemoryPublishingInsightsIngestRateLimiter({
    keySecret: RATE_PEPPER,
    viewPreviewMaxRequests: 10_000,
    resourceOpenMaxRequests: 10_000,
  });
  const dashboard = createPostgresPublishingInsightsDashboardPort(runtime.runtime.db);
  return buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    productPublicInsight: {
      allowedOrigins: config.allowedOrigins,
      identityUnitOfWork,
      visitorHash,
      rateLimiter: limiter,
      rateLimitKeySecret: RATE_PEPPER,
      insightCookieSigningKey: PEPPER,
      record: (input) => createUnitOfWork(runtime.runtime.db).execute(async ({ transaction }) => (
        recordInsightEvent({
          facts: createPostgresPublicationInsightFactsPort(transaction),
          store: createPostgresPublicationInsightStore(transaction),
          visitorHash,
        }, input)
      )),
      now: () => NOW,
    },
    productPublishingInsights: {
      identityUnitOfWork,
      getInsights: (actor, now) => getPublishingInsights({ dashboard }, actor, now),
      now: () => NOW,
    },
  });
}

async function getInsights(app: ReturnType<typeof buildApiApp>, cookie: string) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/me/publishing-insights',
    headers: { cookie },
  });
}

async function seedFixtures(
  runtime: IsolatedPostgresRuntime,
  owners: { readonly ownerA: string; readonly ownerB: string },
): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    const collections: ReadonlyArray<{
      id: string;
      owner: string;
      title: string;
      visibility: 'private' | 'public' | 'unlisted' | 'protected';
      slug: string | null;
      publishedAt: Date | null;
      deletedAt: Date | null;
    }> = [
      { id: 'col-alpha-a', owner: owners.ownerA, title: 'Alpha Notes', visibility: 'public', slug: 'alpha-notes', publishedAt: NOW, deletedAt: null },
      { id: 'col-alpha-b', owner: owners.ownerB, title: 'Alpha Notes', visibility: 'public', slug: 'alpha-notes-live', publishedAt: NOW, deletedAt: null },
      { id: 'col-alpha-unlisted', owner: owners.ownerA, title: 'Alpha Notes', visibility: 'unlisted', slug: 'alpha-notes-quiet', publishedAt: NOW, deletedAt: null },
      { id: 'col-alpha-private', owner: owners.ownerA, title: 'Alpha Notes', visibility: 'private', slug: 'alpha-notes-private', publishedAt: NOW, deletedAt: null },
      { id: 'col-alpha-draft', owner: owners.ownerA, title: 'Alpha Notes', visibility: 'protected', slug: null, publishedAt: null, deletedAt: null },
      { id: 'col-alpha-deleted', owner: owners.ownerA, title: 'Alpha Notes', visibility: 'public', slug: 'alpha-notes-gone', publishedAt: NOW, deletedAt: NOW },
    ];
    for (const collection of collections) {
      const rootId = `root-${collection.id.slice(4)}`;
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type, committed_at)
         values ($1,'collection',current_timestamp), ($2,'node',current_timestamp)`,
        [collection.id, rootId],
      );
      await client.query(
        `insert into collections(
           id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
           root_node_id, root_node_is_root, resource_revision, content_revision, policy_revision,
           commit_ordinal, created_at, updated_at, deleted_at)
         values ($1,$2,$3,'bookmarks',$4,$5,$6,$7,true,'r1','c1','p1',1,
           current_timestamp,current_timestamp,$8)`,
        [
          collection.id,
          collection.owner,
          collection.title,
          collection.visibility,
          collection.slug,
          collection.publishedAt,
          rootId,
          collection.deletedAt,
        ],
      );
      await client.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at, deleted_at)
         values ($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
           current_timestamp,current_timestamp,$3)`,
        [rootId, collection.id, collection.deletedAt],
      );
    }

    await insertBookmark(client, 'bm-a', 'col-alpha-a', 'Shared Title');
    await insertBookmark(client, 'bm-b', 'col-alpha-b', 'Shared Title');
    await insertBookmark(client, 'bm-unlisted', 'col-alpha-unlisted', 'Quiet bookmark');
    await insertBookmark(client, 'bm-private', 'col-alpha-private', 'Hidden bookmark');

    await insertDaily(client, 'col-alpha-a', utcDay(-1), 'collection_view', '', 8);
    await insertDaily(client, 'col-alpha-unlisted', utcDay(-1), 'collection_view', '', 2);
    await insertDaily(client, 'col-alpha-a', utcDay(-1), 'preview_open', '', 3);
    await insertDaily(client, 'col-alpha-a', utcDay(-1), 'resource_open', 'bm-a', 6);
    await insertDaily(client, 'col-alpha-b', utcDay(-1), 'collection_view', '', 7);
    await insertDaily(client, 'col-alpha-b', utcDay(-1), 'preview_open', '', 2);
    await insertDaily(client, 'col-alpha-b', utcDay(-1), 'resource_open', 'bm-b', 4);
    await insertDaily(client, 'col-alpha-private', utcDay(-1), 'collection_view', '', 40);
    await insertDaily(client, 'col-alpha-draft', utcDay(-1), 'collection_view', '', 40);
    await insertDaily(client, 'col-alpha-deleted', utcDay(-1), 'collection_view', '', 40);
    await insertDaily(client, 'col-alpha-a', utcDay(-31), 'collection_view', '', 99);
    await insertDaily(client, 'col-alpha-a', utcDay(-30), 'collection_view', '', 50);

    await client.query(
      `insert into publication_insight_events (
         id, collection_id, event_type, node_id, visitor_hash, occurred_at)
       values ($1,'col-alpha-a','collection_view',null,$2,$3)`,
      ['evt-decoy-a', Buffer.alloc(32, 9), NOW],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertBookmark(
  client: { query(text: string, values?: unknown[]): Promise<unknown> },
  id: string,
  collectionId: string,
  title: string,
): Promise<void> {
  await client.query(
    `insert into resource_id_ledger(resource_id, resource_type, committed_at)
     values ($1,'node',current_timestamp)`,
    [id],
  );
  await client.query(
    `insert into nodes(
       id, collection_id, parent_id, kind, is_root, title, url, position_token,
       resource_revision, children_revision, created_at, updated_at, deleted_at)
     values ($1,$2,$3,'bookmark',false,$4,'https://example.invalid/x','pos','r1','ch1',
       current_timestamp,current_timestamp,null)`,
    [id, collectionId, `root-${collectionId.slice(4)}`, title],
  );
}

async function compileListDailyCounts(
  db: Kysely<DatabaseSchema>,
  input: {
    readonly ownerSubjectId: string;
    readonly fromDayInclusive: string;
    readonly toDayExclusive: string;
    readonly eventTypes: readonly (typeof PUBLISHING_INSIGHTS_FUNNEL_EVENT_TYPES)[number][];
  },
): Promise<{ sql: string; parameters: readonly unknown[] }> {
  const executor = db.getExecutor();
  let compiled: { sql: string; parameters: readonly unknown[] } | undefined;
  const capturing = db.withPlugin({
    transformQuery(args) {
      const next = executor.compileQuery(args.node, args.queryId);
      if (next.sql.includes('publication_insight_daily')) compiled = next;
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  } satisfies KyselyPlugin);
  await createPostgresPublishingInsightsDashboardPort(capturing).listDailyCounts(input);
  assert.ok(compiled, 'expected listDailyCounts SELECT compilation');
  return compiled;
}

async function insertDaily(
  client: { query(text: string, values?: unknown[]): Promise<unknown> },
  collectionId: string,
  day: string,
  eventType: string,
  nodeId: string,
  count: number,
): Promise<void> {
  await client.query(
    `insert into publication_insight_daily (collection_id, day, event_type, node_id, count)
     values ($1, $2::date, $3, $4, $5)`,
    [collectionId, day, eventType, nodeId, count],
  );
}
