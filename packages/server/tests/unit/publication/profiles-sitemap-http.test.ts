import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import {
  PROFILES_SITEMAP_CACHE_CONTROL,
  PROFILES_SITEMAP_CDN_CACHE_CONTROL,
  PROFILES_SITEMAP_CONTENT_TYPE,
  PROFILES_SITEMAP_ROUTE,
  PROFILES_SITEMAP_VARY,
} from '../../../src/transport/collections-sitemap-routes.js';
import type { ProfilesSitemapEntry } from '../../../src/infrastructure/http/index.js';

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

async function withApp(entries: readonly ProfilesSitemapEntry[], run: (app: ReturnType<typeof buildApiApp>) => Promise<void>) {
  let receivedSignal: AbortSignal | undefined;
  const app = buildApiApp({
    config,
    exploreDirectoryRateLimiter: limiter(),
    profileSitemapQuery: {
      async listIndexable(signal) { receivedSignal = signal; return entries; },
    },
  });
  try {
    await run(app);
    assert.ok(receivedSignal instanceof AbortSignal, 'HTTP request cancellation signal reaches the read model');
  } finally {
    await app.close();
  }
}

test('GET serves XML cache headers and HEAD has identical headers without a body', async () => {
  await withApp([{ canonicalHandle: 'ada_curator', updatedAt: '2026-08-30T00:00:00.000Z' }], async (app) => {
    const get = await app.inject({ method: 'GET', url: PROFILES_SITEMAP_ROUTE });
    assert.equal(get.statusCode, 200);
    assert.equal(get.headers['content-type'], PROFILES_SITEMAP_CONTENT_TYPE);
    assert.equal(get.headers['cache-control'], PROFILES_SITEMAP_CACHE_CONTROL);
    assert.equal(get.headers['cloudflare-cdn-cache-control'], PROFILES_SITEMAP_CDN_CACHE_CONTROL);
    assert.equal(get.headers.vary, PROFILES_SITEMAP_VARY);
    assert.match(get.body, /https:\/\/know-n\.com\/u\/ada_curator/u);

    const head = await app.inject({ method: 'HEAD', url: PROFILES_SITEMAP_ROUTE });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.headers['cache-control'], get.headers['cache-control']);
    assert.equal(head.headers['cloudflare-cdn-cache-control'], get.headers['cloudflare-cdn-cache-control']);
    assert.equal(head.headers.vary, get.headers.vary);
  });
});

test('empty catalog is 200 valid empty urlset and other methods are 405', async () => {
  await withApp([], async (app) => {
    const get = await app.inject({ method: 'GET', url: PROFILES_SITEMAP_ROUTE });
    assert.equal(get.statusCode, 200);
    assert.match(get.body, /<urlset\b/u);
    assert.doesNotMatch(get.body, /<url>/u);
    assert.equal((await app.inject({ method: 'POST', url: PROFILES_SITEMAP_ROUTE })).statusCode, 405);
  });
});
