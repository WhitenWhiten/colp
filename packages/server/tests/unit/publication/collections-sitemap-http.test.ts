import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import {
  COLLECTIONS_SITEMAP_CACHE_CONTROL,
  COLLECTIONS_SITEMAP_CDN_CACHE_CONTROL,
  COLLECTIONS_SITEMAP_CONTENT_TYPE,
  COLLECTIONS_SITEMAP_ROUTE,
  COLLECTIONS_SITEMAP_VARY,
} from '../../../src/transport/collections-sitemap-routes.js';
import type { CollectionsSitemapEntry } from '../../../src/infrastructure/http/index.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example',
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});

function limiter() {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  });
}

async function withSitemapApp(
  entries: readonly CollectionsSitemapEntry[],
  run: (app: ReturnType<typeof buildApiApp>) => Promise<void>,
): Promise<void> {
  const app = buildApiApp({
    config,
    exploreDirectoryRateLimiter: limiter(),
    publicationSitemapQuery: {
      async listIndexable() { return entries; },
    },
  });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test('serves XML headers and a public loc; HEAD is empty', async () => {
  await withSitemapApp([
    { publicationSlug: 'seed-public', updatedAt: '2026-07-23T00:00:00.000Z', visibility: 'public' },
  ], async (app) => {
    const response = await app.inject({ method: 'GET', url: COLLECTIONS_SITEMAP_ROUTE });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], COLLECTIONS_SITEMAP_CONTENT_TYPE);
    assert.equal(response.headers['cache-control'], COLLECTIONS_SITEMAP_CACHE_CONTROL);
    assert.equal(response.headers['cloudflare-cdn-cache-control'], COLLECTIONS_SITEMAP_CDN_CACHE_CONTROL);
    assert.equal(response.headers.vary, COLLECTIONS_SITEMAP_VARY);
    assert.match(response.body, /<urlset\b/u);
    assert.match(response.body, /https:\/\/know-n\.com\/c\/seed-public/u);

    const head = await app.inject({ method: 'HEAD', url: COLLECTIONS_SITEMAP_ROUTE });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-type'], COLLECTIONS_SITEMAP_CONTENT_TYPE);
    assert.equal(head.headers['content-length'], response.headers['content-length']);
  });
});

test('empty catalog is 200 empty urlset; other methods are 405', async () => {
  await withSitemapApp([], async (app) => {
    const response = await app.inject({ method: 'GET', url: COLLECTIONS_SITEMAP_ROUTE });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /<urlset\b/u);
    assert.doesNotMatch(response.body, /<url>/u);
    const post = await app.inject({ method: 'POST', url: COLLECTIONS_SITEMAP_ROUTE });
    assert.equal(post.statusCode, 405);
  });
});

test('registers without the public-shell feature flag', async () => {
  assert.equal(config.publicShellMeta.enabled, false);
  await withSitemapApp([], async (app) => {
    const response = await app.inject({ method: 'GET', url: COLLECTIONS_SITEMAP_ROUTE });
    assert.equal(response.statusCode, 200);
  });
});
