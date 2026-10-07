import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresPublicationInsightFactsPort,
  createPostgresPublicationInsightStore,
  createPostgresPublishingInsightsDashboardPort,
  createVisitorHashPort,
} from '../../../src/infrastructure/publication/index.js';
import { createMemoryPublishingInsightsIngestRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { getPublishingInsights, recordInsightEvent } from '../../../src/modules/publication/index.js';
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
const PEPPER = Buffer.alloc(32, 53);
const RATE_PEPPER = Buffer.alloc(32, 59);
const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(INSTANT));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });

describeWithPostgres('publishing insights closed loop', () => {
  let isolated: IsolatedPostgresRuntime;
  let owner: Awaited<ReturnType<typeof issueTestSession>>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('pi05_insights_loop');
    await runMigrations(isolated.runtime.db, 'latest');
    owner = await issueTestSession({ factory, subject: 'loop-owner', handle: 'loop-owner' });
    await seedPublicCollection(isolated, owner.subjectId);
  }, 180_000);

  afterAll(async () => isolated?.close());

  test('anonymous collection_view ingest is visible on owner GET funnel[0].value', async () => {
    const app = buildLoopApp(isolated);
    try {
      const before = await app.inject({
        method: 'GET',
        url: '/api/v1/me/publishing-insights',
        headers: { cookie: owner.cookie },
      });
      assert.equal(before.statusCode, 200);
      assert.equal(before.json().funnel[0].value, 0);

      const ingest = await app.inject({
        method: 'POST',
        url: '/api/v1/public-collections/loop-notes/insight-events',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: { eventType: 'collection_view' },
      });
      assert.equal(ingest.statusCode, 204);

      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/me/publishing-insights',
        headers: { cookie: owner.cookie },
      });
      assert.equal(after.statusCode, 200);
      const body = after.json() as {
        funnel: Array<{ label: string; value: number }>;
        weekly: Array<{ w: string; views: number }>;
        topResources: Array<{ collectionId: string; opens: number }>;
      };
      assert.ok(body.funnel[0].value >= 1);
      assert.equal(body.funnel[0].label, 'Collection views');
      assert.equal(body.weekly.length, 4);
      assert.equal(typeof body.weekly[0]?.w, 'string');
      assert.ok(Array.isArray(body.topResources));
    } finally {
      await app.close();
    }
  });
});

function buildLoopApp(runtime: IsolatedPostgresRuntime) {
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

async function seedPublicCollection(
  runtime: IsolatedPostgresRuntime,
  ownerSubjectId: string,
): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values ($1,'collection',current_timestamp), ($2,'node',current_timestamp)`,
      ['col-loop', 'root-loop'],
    );
    await client.query(
      `insert into collections(
         id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
         root_node_id, root_node_is_root, resource_revision, content_revision, policy_revision,
         commit_ordinal, created_at, updated_at, deleted_at)
       values ($1,$2,$3,'bookmarks','public',$4,$5,$6,true,'r1','c1','p1',1,
         current_timestamp,current_timestamp,null)`,
      ['col-loop', ownerSubjectId, 'Loop Notes', 'loop-notes', NOW, 'root-loop'],
    );
    await client.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at, deleted_at)
       values ($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
         current_timestamp,current_timestamp,null)`,
      ['root-loop', 'col-loop'],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
