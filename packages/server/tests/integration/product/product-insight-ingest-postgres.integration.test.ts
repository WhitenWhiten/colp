import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresSharedExposureFactsPort, createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresPublicationInsightFactsPort,
  createPostgresPublicationInsightStore,
  createPostgresPublicationSnapshotReadPort,
  createVisitorHashPort,
} from '../../../src/infrastructure/publication/index.js';
import { createMemoryPublishingInsightsIngestRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import {
  createPublicationCursorKeyring,
  recordInsightEvent,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
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
const PEPPER = Buffer.alloc(32, 29);
const RATE_PEPPER = Buffer.alloc(32, 31);
const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(INSTANT));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });

describeWithPostgres('product insight ingest postgres', () => {
  let isolated: IsolatedPostgresRuntime;
  let ownerA: Awaited<ReturnType<typeof issueTestSession>>;
  let ownerB: Awaited<ReturnType<typeof issueTestSession>>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('pi02_insight_ingest');
    await runMigrations(isolated.runtime.db, 'latest');
    ownerA = await issueTestSession({ factory, subject: 'owner-a', handle: 'insight-owner-a' });
    ownerB = await issueTestSession({ factory, subject: 'owner-b', handle: 'insight-owner-b' });
    await seedFixtures(isolated, { ownerA: ownerA.subjectId, ownerB: ownerB.subjectId });
  }, 180_000);

  afterAll(async () => isolated?.close());

  test('anonymous ingest writes real daily/events and owner self-view does not', async () => {
    const app = buildIngestApp(isolated);
    try {
      const anonymous = await ingest(app, 'alpha-notes');
      assert.equal(anonymous.statusCode, 204);
      assert.equal(await eventCount(isolated, 'col-alpha-a'), 1);
      assert.equal(await dailyCount(isolated, 'col-alpha-a', 'collection_view'), 1);

      const owner = await ingest(app, 'alpha-notes', {
        cookie: ownerA.cookie,
        csrf: ownerA.csrfToken,
      });
      assert.equal(owner.statusCode, 204);
      assert.equal(await eventCount(isolated, 'col-alpha-a'), 1);
      assert.equal(await dailyCount(isolated, 'col-alpha-a', 'collection_view'), 1);
    } finally {
      await app.close();
    }
  });

  test('owner A and owner B public collections with similar titles stay isolated', async () => {
    const app = buildIngestApp(isolated);
    try {
      const beforeB = await eventCount(isolated, 'col-alpha-b');
      const writeA = await ingest(app, 'alpha-notes', {
        eventType: 'preview_open',
      });
      assert.equal(writeA.statusCode, 204);
      assert.equal(await eventCount(isolated, 'col-alpha-b'), beforeB);
      assert.equal(await dailyCount(isolated, 'col-alpha-b', 'preview_open'), 0);

      const writeB = await ingest(app, 'alpha-notes-live', {
        eventType: 'preview_open',
      });
      assert.equal(writeB.statusCode, 204);
      assert.equal(await dailyCount(isolated, 'col-alpha-a', 'preview_open') > 0, true);
      assert.equal(await dailyCount(isolated, 'col-alpha-b', 'preview_open'), 1);
      assert.equal(await eventCount(isolated, 'col-alpha-a', 'preview_open')
        === await dailyCount(isolated, 'col-alpha-a', 'preview_open'), true);
      void ownerB;
    } finally {
      await app.close();
    }
  });

  test('COLP snapshot GET does not insert insight rows', async () => {
    const app = buildIngestApp(isolated);
    try {
      const before = await totalInsightRows(isolated);
      const snapshot = await app.inject({
        method: 'GET',
        url: '/colp/v0.1/collections/col-alpha-a/snapshot?limit=20',
        headers: {
          accept: 'application/vnd.collection-protocol.snapshot+json;version=0.1',
          'collection-protocol-version': '0.1',
        },
      });
      assert.equal(snapshot.statusCode, 200);
      assert.equal(await totalInsightRows(isolated), before);
    } finally {
      await app.close();
    }
  });

  test('private collection conceals as 404 without a new row', async () => {
    const app = buildIngestApp(isolated);
    try {
      const before = await totalInsightRows(isolated);
      const response = await ingest(app, 'alpha-notes-private');
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error.code, 'resource_not_found');
      assert.equal(await totalInsightRows(isolated), before);
    } finally {
      await app.close();
    }
  });

  test('injected limiter with limit 1 returns 429 and Retry-After', async () => {
    const limiter = createMemoryPublishingInsightsIngestRateLimiter({
      keySecret: RATE_PEPPER,
      viewPreviewMaxRequests: 1,
      resourceOpenMaxRequests: 1,
    });
    const app = buildIngestApp(isolated, limiter);
    try {
      const first = await ingest(app, 'alpha-notes-rate');
      assert.equal(first.statusCode, 204);
      const second = await ingest(app, 'alpha-notes-rate');
      assert.equal(second.statusCode, 429);
      assert.equal(second.json().error.code, 'rate_limited');
      assert.ok(Number(second.headers['retry-after']) >= 1);
      assert.equal(typeof second.json().error.retryAfterSeconds, 'number');
      assert.ok(second.json().error.retryAfterSeconds >= 1);
    } finally {
      await app.close();
    }
  });

  test('HTTP ingest does not delete expired insight rows in the same request', async () => {
    const expiredAt = new Date('2026-05-19T12:00:00.000Z');
    const cutoff = new Date('2026-05-20T12:00:00.000Z');
    const hash = Buffer.alloc(32, 5);
    await isolated.runtime.pool.query(
      `insert into publication_insight_events
         (id, collection_id, event_type, node_id, visitor_hash, occurred_at)
       values ('evt-http-expired', 'col-alpha-a', 'preview_open', null, $1, $2)`,
      [hash, expiredAt],
    );
    await isolated.runtime.pool.query(
      `insert into publication_insight_daily
         (collection_id, day, event_type, node_id, count)
       values ('col-alpha-a', date '2026-05-19', 'preview_open', 'http-expired', 1)`,
    );
    const expiredEvents = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from publication_insight_events where occurred_at < $1`,
      [cutoff],
    );
    const expiredDaily = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from publication_insight_daily where day < date '2026-05-20'`,
    );
    const app = buildIngestApp(isolated);
    try {
      const response = await ingest(app, 'alpha-notes', { eventType: 'preview_open' });
      assert.equal(response.statusCode, 204);
      const eventsAfter = await isolated.runtime.pool.query<{ n: number }>(
        `select count(*)::int as n from publication_insight_events where occurred_at < $1`,
        [cutoff],
      );
      const dailyAfter = await isolated.runtime.pool.query<{ n: number }>(
        `select count(*)::int as n from publication_insight_daily where day < date '2026-05-20'`,
      );
      assert.equal(eventsAfter.rows[0]?.n, expiredEvents.rows[0]?.n);
      assert.equal(dailyAfter.rows[0]?.n, expiredDaily.rows[0]?.n);
    } finally {
      await app.close();
    }
  });
});

function buildIngestApp(
  runtime: IsolatedPostgresRuntime,
  limiter = createMemoryPublishingInsightsIngestRateLimiter({
    keySecret: RATE_PEPPER,
    viewPreviewMaxRequests: 10_000,
    resourceOpenMaxRequests: 10_000,
  }),
) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: ORIGIN,
    PUBLICATION_ORIGIN: ORIGIN,
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  });
  const visitorHash = createVisitorHashPort(PEPPER);
  const cursors = createPublicationCursorKeyring({
    active: { id: 'pi02-v1', secret: Buffer.alloc(32, 41).toString('base64') },
    retained: [],
  });
  const app = buildApiApp({
    config,
    exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    publicationSnapshotQuery: {
      reads: createPostgresPublicationSnapshotReadPort(runtime.runtime),
      accessPolicy: createPostgresAccessPolicyFactsPort(runtime.runtime.db),
      cursors,
      origin: config.publication.origin,
      now: () => NOW,
      sharedExposure: createPostgresSharedExposureFactsPort(runtime.runtime),
    },
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
  });
  app.addHook('onClose', () => cursors.destroy());
  return app;
}

async function ingest(
  app: ReturnType<typeof buildApiApp>,
  slug: string,
  options: {
    readonly eventType?: 'collection_view' | 'preview_open' | 'resource_open';
    readonly nodeId?: string;
    readonly cookie?: string;
    readonly csrf?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    'content-type': 'application/json',
  };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf;
  const payload: Record<string, unknown> = { eventType: options.eventType ?? 'collection_view' };
  if (options.nodeId !== undefined) payload.nodeId = options.nodeId;
  return app.inject({
    method: 'POST',
    url: `/api/v1/public-collections/${slug}/insight-events`,
    headers,
    payload,
  });
}

async function eventCount(
  runtime: IsolatedPostgresRuntime,
  collectionId: string,
  eventType?: string,
): Promise<number> {
  const result = eventType === undefined
    ? await runtime.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from publication_insight_events where collection_id = $1`,
      [collectionId],
    )
    : await runtime.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from publication_insight_events
        where collection_id = $1 and event_type = $2`,
      [collectionId, eventType],
    );
  return result.rows[0]?.n ?? 0;
}

async function dailyCount(
  runtime: IsolatedPostgresRuntime,
  collectionId: string,
  eventType: string,
  nodeId = '',
): Promise<number> {
  const result = await runtime.runtime.pool.query<{ count: string }>(
    `select count from publication_insight_daily
      where collection_id = $1 and event_type = $2 and node_id = $3`,
    [collectionId, eventType, nodeId],
  );
  return result.rows[0] ? Number(result.rows[0].count) : 0;
}

async function totalInsightRows(runtime: IsolatedPostgresRuntime): Promise<number> {
  const events = await runtime.runtime.pool.query<{ n: number }>(
    `select count(*)::int as n from publication_insight_events`,
  );
  const daily = await runtime.runtime.pool.query<{ n: number }>(
    `select count(*)::int as n from publication_insight_daily`,
  );
  return (events.rows[0]?.n ?? 0) + (daily.rows[0]?.n ?? 0);
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
      visibility: 'private' | 'public' | 'unlisted';
      slug: string | null;
    }> = [
      { id: 'col-alpha-a', owner: owners.ownerA, title: 'Alpha Notes', visibility: 'public', slug: 'alpha-notes' },
      { id: 'col-alpha-b', owner: owners.ownerB, title: 'Alpha Notes', visibility: 'public', slug: 'alpha-notes-live' },
      {
        id: 'col-alpha-private', owner: owners.ownerA, title: 'Alpha Notes', visibility: 'private',
        slug: 'alpha-notes-private',
      },
      { id: 'col-alpha-rate', owner: owners.ownerA, title: 'Alpha Notes Rate', visibility: 'public', slug: 'alpha-notes-rate' },
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
           current_timestamp,current_timestamp,null)`,
        [
          collection.id,
          collection.owner,
          collection.title,
          collection.visibility,
          collection.slug,
          collection.slug === null ? null : NOW,
          rootId,
        ],
      );
      await client.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at, deleted_at)
         values ($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
           current_timestamp,current_timestamp,null)`,
        [rootId, collection.id],
      );
    }
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
