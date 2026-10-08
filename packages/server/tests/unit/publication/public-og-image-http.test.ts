import assert from 'node:assert/strict';
import { afterAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createWebShellCache } from '../../../src/infrastructure/http/index.js';
import type { PublicationMetadataRecord } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example', LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  KNOWN_FEATURE_PUBLIC_SHELL_META: 'true',
  WEB_SHELL_ORIGIN: 'http://web:80',
});

const PNG_BYTES = Buffer.from('fake-png-bytes');
let record: PublicationMetadataRecord | null = {
  id: 'collection-1', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'LLM path',
  summary: 'From intuition to alignment.', visibility: 'public', publicationSlug: 'llm-path',
  rootNodeId: 'root', rootAvailable: true, contentRevision: 'c1', policyRevision: 'p1',
  tags: [], language: 'en', membershipRole: null,
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-29T04:19:21.427Z', deletedAt: null,
};
let renderCalls: Array<Record<string, unknown>> = [];

const app = buildApiApp({
  config,
  publicationMetadataQuery: {
    reads: { async load() { return record; } },
    origin: 'https://known.example',
    now: () => new Date('2026-08-30T00:00:00Z'),
  },
  publicShell: {
    cache: createWebShellCache({
      origin: 'http://web:80',
      fetch: async () => new Response(PUBLIC_SHELL_FIXTURE, { status: 200, headers: { etag: '"shell"' } }),
    }),
    loadNodeCountBySlug: async () => 7,
    loadOwnerDisplayName: async () => 'legacy display name',
    loadOwnerPublicProfile: async () => ({ displayName: 'Ada Curator', handle: 'ada_curator' }),
  },
  collectionOgImageRenderer: {
    get size() { return renderCalls.length; },
    async render(input) {
      renderCalls.push(input as unknown as Record<string, unknown>);
      return PNG_BYTES;
    },
  },
  exploreDirectoryRateLimiter: createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  }),
});

afterAll(async () => { await app.close(); });
beforeEach(() => {
  renderCalls = [];
  record = {
    id: 'collection-1', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'LLM path',
    summary: 'From intuition to alignment.', visibility: 'public', publicationSlug: 'llm-path',
    rootNodeId: 'root', rootAvailable: true, contentRevision: 'c1', policyRevision: 'p1',
    tags: [], language: 'en', membershipRole: null,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-29T04:19:21.427Z', deletedAt: null,
  };
});

test('GET /og/collections/:slug.png renders the card with shell parity headers', async () => {
  const response = await app.inject({ method: 'GET', url: '/og/collections/llm-path.png' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.equal(response.headers['cloudflare-cdn-cache-control'], 'max-age=60');
  assert.equal(response.headers['last-modified'], new Date('2026-08-29T04:19:21.427Z').toUTCString());
  assert.ok(response.rawPayload.equals(PNG_BYTES));
  assert.equal(renderCalls.length, 1);
  assert.deepEqual(renderCalls[0], {
    slug: 'llm-path',
    title: 'LLM path',
    curator: 'Ada Curator',
    itemCount: 7,
    updatedAt: '2026-08-29T04:19:21.427Z',
  });
});

test('HEAD sends the image headers without the body', async () => {
  const response = await app.inject({ method: 'HEAD', url: '/og/collections/llm-path.png' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['content-length'], String(PNG_BYTES.byteLength));
  assert.equal(response.rawPayload.length, 0);
});

test('unknown or hidden slugs are the same generic 404 as the HTML shell', async () => {
  record = null;
  const response = await app.inject({ method: 'GET', url: '/og/collections/llm-path.png' });
  assert.equal(response.statusCode, 404);
  assert.match(String(response.headers['content-type']), /application\/problem\+json/u);
  assert.equal(renderCalls.length, 0);
});

test('non-canonical slugs never reach the query ports', async () => {
  const response = await app.inject({ method: 'GET', url: '/og/collections/LLM-PATH.png' });
  assert.equal(response.statusCode, 404);
  assert.equal(renderCalls.length, 0);
});
