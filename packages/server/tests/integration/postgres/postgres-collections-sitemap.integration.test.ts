import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicationSitemapReadPort } from '../../../src/infrastructure/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  COLLECTIONS_SITEMAP_CONTENT_TYPE,
  COLLECTIONS_SITEMAP_ROUTE,
} from '../../../src/transport/collections-sitemap-routes.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('T-20 collections sitemap', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('collections_sitemap');
    await runMigrations(isolated.runtime.db, 'latest');
    await seedSitemapFixtures(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('lists the public slug and omits the unlisted slug', async () => {
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
      publicationSitemapQuery: createPostgresPublicationSitemapReadPort(isolated.runtime),
    });
    try {
      const response = await app.inject({ method: 'GET', url: COLLECTIONS_SITEMAP_ROUTE });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], COLLECTIONS_SITEMAP_CONTENT_TYPE);
      assert.match(response.body, /<urlset\b/u);
      assert.match(response.body, /https:\/\/know-n\.com\/c\/sitemap-public/u);
      assert.doesNotMatch(response.body, /sitemap-unlisted/u);
      assert.doesNotMatch(response.body, /sitemap-seed/u, 'seed-registered public collection stays out of the urlset');
      assert.match(response.body, /<lastmod>2026-07-23T00:00:00\.000Z<\/lastmod>/u);
    } finally {
      await app.close();
    }
  });
});

async function seedSitemapFixtures(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into accounts(id, subject_id, status) values ('01SITEMAPACCOUNT000AA', 'sitemap-owner', 'active')`,
    );
    await client.query(
      `insert into profiles(account_id, display_name) values ('01SITEMAPACCOUNT000AA', 'Sitemap Curator')`,
    );
    await client.query(
      `insert into profile_handles(handle, account_id) values ('sitemap_curator', '01SITEMAPACCOUNT000AA')`,
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ('sitemap-public', 'collection'), ('sitemap-public-root', 'node'),
              ('sitemap-unlisted', 'collection'), ('sitemap-unlisted-root', 'node'),
              ('col-u98-sitemap-seed', 'collection'), ('sitemap-seed-root', 'node')`,
    );
    await client.query(
      `insert into collections
        (id, owner_subject_id, title, summary, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, publication_slug, published_at, updated_at)
       values
        ('sitemap-public', 'sitemap-owner', 'Sitemap Public', 'Public for the urlset.',
         'bookmarks', 'public', 'sitemap-public-root', 'r1', 'c1', 'p1', 'sitemap-public',
         '2026-07-01T00:00:00Z', '2026-07-23T00:00:00Z'),
        ('sitemap-unlisted', 'sitemap-owner', 'Sitemap Unlisted', 'Must not appear.',
         'bookmarks', 'unlisted', 'sitemap-unlisted-root', 'r1', 'c1', 'p1', 'sitemap-unlisted',
         '2026-07-01T00:00:00Z', '2026-07-23T00:00:00Z'),
        ('col-u98-sitemap-seed', 'sitemap-owner', 'Sitemap Seed', 'Public demo fixture, seed-registered.',
         'bookmarks', 'public', 'sitemap-seed-root', 'r1', 'c1', 'p1', 'sitemap-seed',
         '2026-07-01T00:00:00Z', '2026-07-24T00:00:00Z')`,
    );
    await client.query(
      `insert into seed_rows(seed_key, version, table_name, pk)
       values ('demo', 'integration-fixture', 'collections', jsonb_build_array('col-u98-sitemap-seed'))`,
    );
    await client.query(
      `insert into nodes
        (id, collection_id, kind, is_root, title, visibility, resource_revision, children_revision)
       values
        ('sitemap-public-root', 'sitemap-public', 'folder', true, 'Sitemap Public', 'inherit', 'r1', 'ch1'),
        ('sitemap-unlisted-root', 'sitemap-unlisted', 'folder', true, 'Sitemap Unlisted', 'inherit', 'r1', 'ch1'),
        ('sitemap-seed-root', 'col-u98-sitemap-seed', 'folder', true, 'Sitemap Seed', 'inherit', 'r1', 'ch1')`,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
