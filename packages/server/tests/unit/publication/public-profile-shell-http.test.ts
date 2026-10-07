import assert from 'node:assert/strict';
import { afterAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createWebShellCache } from '../../../src/infrastructure/http/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import {
  PUBLIC_SHELL_CACHE_CONTROL,
  PUBLIC_SHELL_CDN_CACHE_CONTROL,
  PUBLIC_SHELL_CONTENT_TYPE,
  PUBLIC_SHELL_VARY,
} from '../../../src/transport/public-shell-routes.js';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

const baseEnv = {
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example',
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
};
const onConfig = loadConfig({
  ...baseEnv,
  KNOWN_FEATURE_PUBLIC_PROFILE_SHELL: 'true',
  WEB_SHELL_ORIGIN: 'http://web:80',
});
const offConfig = loadConfig(baseEnv);

let exists = true;
let collections: Array<{ id: string; slug: string; title: string; summary: null; kind: 'bookmarks'; updatedAt: string }> = [];
let hasMore = false;
let bio = 'Public bio.';
let shellAvailable = true;
let excludedIds = new Set<string>();

function limiter() {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  });
}

function publicProfileQuery() {
  return {
    async get(input: { handle: string; limit?: number }) {
      if (!exists || input.handle !== 'ada_curator') {
        throw Object.assign(new Error('missing'), { code: 'resource_not_found' });
      }
      assert.equal(input.limit, 100);
      return {
        profile: {
          profileId: 'private-profile-id',
          handle: 'ada_curator',
          displayName: 'Ada Curator',
          avatarUrl: 'https://cdn.example/avatar.png',
          about: bio,
        },
        collections,
        page: { cursor: hasMore ? 'next-page' : null, hasMore },
      };
    },
  };
}

function publicShell() {
  return {
    cache: createWebShellCache({
      origin: 'http://web:80',
      fetch: async () => shellAvailable
        ? new Response(PUBLIC_SHELL_FIXTURE, { status: 200, headers: { etag: '"profile-shell"' } })
        : new Response('down', { status: 503 }),
    }),
    loadNodeCountBySlug: async () => null,
    loadOwnerDisplayName: async () => null,
    excludedCollectionIds: async (ids: readonly string[]) => new Set(ids.filter((id) => excludedIds.has(id))),
  };
}

const onApp = buildApiApp({
  config: onConfig,
  publicProfileQuery: publicProfileQuery(),
  publicShell: publicShell(),
  exploreDirectoryRateLimiter: limiter(),
});
const offApp = buildApiApp({
  config: offConfig,
  publicProfileQuery: publicProfileQuery(),
  exploreDirectoryRateLimiter: limiter(),
});

afterAll(async () => {
  await onApp.close();
  await offApp.close();
});

beforeEach(() => {
  exists = true;
  collections = [{
    id: 'collection-1', slug: 'engineering-notes', title: 'Engineering notes', summary: null,
    kind: 'bookmarks', updatedAt: '2026-08-20T00:00:00Z',
  }];
  shellAvailable = true;
  hasMore = false;
  bio = 'Public bio.';
  excludedIds = new Set();
});

function assertPublicHeaders(headers: Record<string, unknown>, contentType = PUBLIC_SHELL_CONTENT_TYPE) {
  assert.equal(headers['content-type'], contentType);
  assert.equal(headers['cache-control'], PUBLIC_SHELL_CACHE_CONTROL);
  assert.equal(headers['cloudflare-cdn-cache-control'], PUBLIC_SHELL_CDN_CACHE_CONTROL);
  assert.equal(headers.vary, PUBLIC_SHELL_VARY);
}

test('GET/HEAD /u/:handle share status, headers, and Content-Length while HEAD has no body', async () => {
  const get = await onApp.inject({ method: 'GET', url: '/u/ada_curator', headers: { accept: 'text/html' } });
  const head = await onApp.inject({ method: 'HEAD', url: '/u/ada_curator', headers: { accept: 'text/html' } });
  assert.equal(get.statusCode, 200);
  assert.match(get.body, /<title>Ada Curator \(@ada_curator\) — Know-N<\/title>/u);
  assertPublicHeaders(get.headers);
  assert.equal(head.statusCode, get.statusCode);
  assertPublicHeaders(head.headers);
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.equal(head.body, '');
});

test('existing thin profile is 200 noindex; unknown and invalid handles are true generic-shell 404s', async () => {
  collections = [];
  const thin = await onApp.inject({ method: 'GET', url: '/u/ada_curator' });
  assert.equal(thin.statusCode, 200);
  assert.match(thin.body, /name="robots" content="noindex"/u);

  exists = false;
  const unknown = await onApp.inject({ method: 'GET', url: '/u/unknown' });
  const unknownHead = await onApp.inject({ method: 'HEAD', url: '/u/unknown' });
  assert.equal(unknown.statusCode, 404);
  assertPublicHeaders(unknown.headers);
  assert.match(unknown.body, /<title>Know-N<\/title>/u);
  assert.doesNotMatch(unknown.body, /Ada Curator/u);
  assert.equal(unknownHead.statusCode, 404);
  assert.equal(unknownHead.headers['content-length'], unknown.headers['content-length']);
  assert.equal(unknownHead.headers['cache-control'], unknown.headers['cache-control']);
  assert.equal(unknownHead.body, '');

  for (const url of ['/u/UPPER', '/u/%2E%2E', '/u/a%2Fb', '/u/%22%3E%3Cscript%3E']) {
    const invalid = await onApp.inject({ method: 'GET', url });
    assert.equal(invalid.statusCode, 404, url);
  }
  // R15-24: a mistyped handle that reaches the route gets the styled shell
  // 404, not application/problem+json.
  for (const url of ['/u/UPPER', '/profile/UPPER', '/u/%22%3E%3Cscript%3E']) {
    const invalid = await onApp.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
    assert.equal(invalid.statusCode, 404, url);
    assertPublicHeaders(invalid.headers);
    assert.match(invalid.body, /<title>Know-N<\/title>/u, url);
  }
});

test('markdown negotiation returns 200/404 and GET/HEAD parity', async () => {
  const get = await onApp.inject({ method: 'GET', url: '/u/ada_curator', headers: { accept: 'text/markdown' } });
  const head = await onApp.inject({ method: 'HEAD', url: '/u/ada_curator', headers: { accept: 'text/markdown' } });
  assert.equal(get.statusCode, 200);
  assertPublicHeaders(get.headers, 'text/markdown; charset=utf-8');
  assert.match(get.body, /^# Ada Curator/mu);
  assert.match(get.body, /- \[Engineering notes\]\(\/c\/engineering-notes\)/u);
  assert.equal(head.statusCode, 200);
  assertPublicHeaders(head.headers, 'text/markdown; charset=utf-8');
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.equal(head.body, '');

  exists = false;
  const missing = await onApp.inject({ method: 'GET', url: '/u/unknown', headers: { accept: 'text/markdown' } });
  const missingHead = await onApp.inject({ method: 'HEAD', url: '/u/unknown', headers: { accept: 'text/markdown' } });
  assert.equal(missing.statusCode, 404);
  assertPublicHeaders(missing.headers, 'text/markdown; charset=utf-8');
  assert.match(missing.body, /^# Profile not found/mu);
  assert.equal(missingHead.statusCode, 404);
  assert.equal(missingHead.headers['content-length'], missing.headers['content-length']);
  assert.equal(missingHead.headers['content-type'], missing.headers['content-type']);
  assert.equal(missingHead.body, '');
});

test('HTTP projection carries one-item grammar and 100-item hasMore truth into HTML and markdown', async () => {
  bio = '';
  collections = [collections[0]!];
  collections[0] = { ...collections[0]!, title: 'Only collection' };
  const one = await onApp.inject({ method: 'GET', url: '/u/ada_curator' });
  assert.match(one.body, /Ada Curator curates 1 public collection on Know-N/u);

  collections = Array.from({ length: 100 }, (_, index) => ({
    id: `collection-${index}`,
    slug: `collection-${index}`,
    title: `Collection ${index}`,
    summary: null,
    kind: 'bookmarks' as const,
    updatedAt: '2026-08-20T00:00:00Z',
  }));
  hasMore = true;
  const html = await onApp.inject({ method: 'GET', url: '/u/ada_curator' });
  assert.match(html.body, /more than 100 public collections/u);
  assert.match(html.body, /More public collections are available\./u);
  const markdown = await onApp.inject({
    method: 'GET', url: '/u/ada_curator', headers: { accept: 'text/markdown' },
  });
  assert.match(markdown.body, /more than 100 public collections/u);
  assert.match(markdown.body, /More public collections are available\./u);
});

test('/profile/:handle redirects permanently to the canonical /u URL for GET and HEAD', async () => {
  const get = await onApp.inject({ method: 'GET', url: '/profile/ada_curator?utm_source=old' });
  const head = await onApp.inject({ method: 'HEAD', url: '/profile/ada_curator?utm_source=old' });
  assert.equal(get.statusCode, 301);
  assert.equal(get.headers.location, '/u/ada_curator');
  assert.equal(head.statusCode, 301);
  assert.equal(head.headers.location, '/u/ada_curator');
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.equal(head.body, '');
});

test('other methods are 405 and the independent flag defaults to hard 404', async () => {
  for (const url of ['/u/ada_curator', '/profile/ada_curator']) {
    const response = await onApp.inject({ method: 'POST', url });
    assert.equal(response.statusCode, 405, url);
    assert.match(String(response.headers.allow), /GET/u);
    assert.match(String(response.headers.allow), /HEAD/u);
  }
  const disabledHtml = await offApp.inject({ method: 'GET', url: '/u/ada_curator' });
  const disabledLegacy = await offApp.inject({ method: 'GET', url: '/profile/ada_curator' });
  const disabledMarkdown = await offApp.inject({
    method: 'GET', url: '/u/ada_curator', headers: { accept: 'text/markdown' },
  });
  assert.equal(disabledHtml.statusCode, 404);
  assert.equal(disabledLegacy.statusCode, 404);
  assert.equal(disabledMarkdown.statusCode, 404);
  assert.equal(disabledMarkdown.headers['content-type'], 'text/markdown; charset=utf-8');
});

test('empty shell cache returns 503 for nginx fallback', async () => {
  const fresh = buildApiApp({
    config: onConfig,
    publicProfileQuery: publicProfileQuery(),
    publicShell: publicShell(),
    exploreDirectoryRateLimiter: limiter(),
  });
  try {
    shellAvailable = false;
    const response = await fresh.inject({ method: 'GET', url: '/u/ada_curator' });
    assert.equal(response.statusCode, 503);
  } finally {
    await fresh.close();
  }
});

test('profile HTML validators include changes to the public collection list', async () => {
  collections = [
    { id: 'c1', slug: 'older', title: 'Older', summary: null, kind: 'bookmarks', updatedAt: '2026-08-01T00:00:00Z' },
    { id: 'c2', slug: 'newer', title: 'Newer', summary: null, kind: 'bookmarks', updatedAt: '2026-08-21T10:00:00Z' },
  ];
  const response = await onApp.inject({ method: 'GET', url: '/u/ada_curator' });
  assert.equal(response.headers['last-modified'], undefined);
  assert.match(String(response.headers.etag), /^W\/"html-/u);
  collections = [];
  const thin = await onApp.inject({ method: 'GET', url: '/u/ada_curator', headers: { 'if-none-match': String(response.headers.etag) } });
  assert.equal(thin.statusCode, 200);
  assert.equal(thin.headers['last-modified'], undefined);
  assert.notEqual(thin.headers.etag, response.headers.etag);
  exists = false;
  const missing = await onApp.inject({ method: 'GET', url: '/u/ada_curator' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers['last-modified'], undefined);
});

test('a Profile backed only by seed collections is served with noindex while still listing them', async () => {
  excludedIds = new Set(['collection-1']);
  const response = await onApp.inject({ method: 'GET', url: '/u/ada_curator' });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /<meta name="robots" content="noindex" \/>/u);
  assert.match(response.body, /<a href="\/c\/engineering-notes">Engineering notes<\/a>/u);
  const markdown = await onApp.inject({ method: 'GET', url: '/u/ada_curator', headers: { accept: 'text/markdown' } });
  assert.match(markdown.body, /^robots: noindex$/mu);
});
