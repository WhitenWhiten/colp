import assert from 'node:assert/strict';
import { afterAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createWebShellCache, PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE } from '../../../src/infrastructure/http/index.js';
import type { ExplorePageReadPort, ExplorePageReadRequest, ExplorePageRecord } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import {
  PUBLIC_SHELL_CACHE_CONTROL,
  PUBLIC_SHELL_CDN_CACHE_CONTROL,
  PUBLIC_SHELL_CONTENT_TYPE,
  PUBLIC_SHELL_VARY,
} from '../../../src/transport/public-shell-routes.js';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example',
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  WEB_SHELL_ORIGIN: 'http://web:80',
});

let shellAvailable = true;
let requests: ExplorePageReadRequest[] = [];
let rows: ExplorePageRecord[] = [];

function row(id: string, extras: Partial<ExplorePageRecord> = {}): ExplorePageRecord {
  return {
    id,
    ownerSubjectId: `owner-${id}`,
    title: `Title ${id}`,
    summary: `Summary ${id}.`,
    kind: 'bookmarks',
    visibility: 'public',
    publicationSlug: id,
    tags: [],
    nodeCount: 3,
    orderingNodeCount: 3,
    language: null,
    hiddenPublic: false,
    viewCount: 0,
    updatedAt: '2026-08-29T00:00:00.000Z',
    orderingUpdatedAtMicros: '1',
    ...extras,
  };
}

const page: ExplorePageReadPort = {
  async loadPage(request) {
    requests.push(request);
    return rows.slice(0, request.limit);
  },
};

function limiter() {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  });
}

function publicShell(fetch: () => Promise<Response>) {
  return {
    cache: createWebShellCache({ origin: 'http://web:80', fetch }),
    loadNodeCountBySlug: async () => null,
    loadOwnerDisplayName: async () => null,
  };
}

const app = buildApiApp({
  config,
  explorePageQuery: page,
  publicShell: publicShell(async () => shellAvailable
    ? new Response(PUBLIC_SHELL_FIXTURE, { status: 200, headers: { etag: '"explore-shell"' } })
    : new Response('down', { status: 503 })),
  exploreDirectoryRateLimiter: limiter(),
});
// Cold cache whose origin is always down: the 60s shell cache must not mask it.
const appShellDown = buildApiApp({
  config,
  explorePageQuery: page,
  publicShell: publicShell(async () => new Response('down', { status: 503 })),
  exploreDirectoryRateLimiter: limiter(),
});
const appWithoutShell = buildApiApp({
  config,
  explorePageQuery: page,
  exploreDirectoryRateLimiter: limiter(),
});

afterAll(async () => {
  await app.close();
  await appShellDown.close();
  await appWithoutShell.close();
});

beforeEach(() => {
  shellAvailable = true;
  requests = [];
  rows = [row('newest-path'), row('older-notes', { nodeCount: 1 })];
});

function assertPublicHeaders(headers: Record<string, unknown>, contentType = PUBLIC_SHELL_CONTENT_TYPE) {
  assert.equal(headers['content-type'], contentType);
  assert.equal(headers['cache-control'], PUBLIC_SHELL_CACHE_CONTROL);
  assert.equal(headers['cloudflare-cdn-cache-control'], PUBLIC_SHELL_CDN_CACHE_CONTROL);
  assert.equal(headers.vary, PUBLIC_SHELL_VARY);
  if (contentType.startsWith('text/html')) {
    assert.match(String(headers['content-security-policy']), /script-src 'self'/u);
    assert.match(String(headers['content-security-policy']), /object-src 'none'/u);
    assert.equal(headers['x-frame-options'], 'DENY');
  } else assert.equal(headers['content-security-policy'], undefined);
}

test('GET /explore injects the newest public collections and asks the page port for the shell limit', async () => {
  const response = await app.inject({ method: 'GET', url: '/explore', headers: { accept: 'text/html' } });
  assert.equal(response.statusCode, 200);
  assertPublicHeaders(response.headers);
  assert.match(response.body, /<title>Explore — Know-N<\/title>/u);
  assert.match(response.body, /<link rel="canonical" href="https:\/\/know-n\.com\/explore" \/>/u);
  assert.match(response.body, /<a href="\/c\/newest-path">Title newest-path<\/a> — Summary newest-path\. · 3 items/u);
  assert.match(response.body, /<a href="\/c\/older-notes">Title older-notes<\/a> — Summary older-notes\. · 1 item/u);
  assert.equal(requests.length, 1);
  assert.deepEqual({ ...requests[0], signal: undefined }, { filter: {}, sort: 'updated', limit: 50, signal: undefined });
});

test('HEAD /explore mirrors GET headers and Content-Length with an empty body', async () => {
  const get = await app.inject({ method: 'GET', url: '/explore' });
  const head = await app.inject({ method: 'HEAD', url: '/explore' });
  assert.equal(head.statusCode, 200);
  assertPublicHeaders(head.headers);
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.equal(head.body, '');
});

test('Accept: text/markdown returns the markdown listing without touching the shell cache', async () => {
  shellAvailable = false;
  const response = await app.inject({ method: 'GET', url: '/explore', headers: { accept: 'text/markdown' } });
  assert.equal(response.statusCode, 200);
  assertPublicHeaders(response.headers, PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE);
  assert.match(response.body, /^# Explore collections\n/u);
  assert.match(response.body, /- \[Title newest-path\]\(\/c\/newest-path\) — Summary newest-path\. · 3 items · updated 2026-08-29/u);
});

test('shell unavailable or missing is a 503 problem so nginx can fall back, never a 404', async () => {
  const down = await appShellDown.inject({ method: 'GET', url: '/explore' });
  assert.equal(down.statusCode, 503);
  assert.equal(down.headers['retry-after'], '1');

  const missing = await appWithoutShell.inject({ method: 'GET', url: '/explore' });
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.headers['retry-after'], '1');
});

test('a warm shell cache keeps serving Explore while the web origin is briefly down', async () => {
  await app.inject({ method: 'GET', url: '/explore' });
  shellAvailable = false;
  const response = await app.inject({ method: 'GET', url: '/explore' });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /<title>Explore — Know-N<\/title>/u);
});

test('an empty catalog is still a 200 document', async () => {
  rows = [];
  const response = await app.inject({ method: 'GET', url: '/explore' });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /<p>No public collections yet\.<\/p>/u);
  assert.match(response.body, /"numberOfItems": 0/u);
});

test('POST /explore is 405 at the API (nginx only proxies GET/HEAD)', async () => {
  const response = await app.inject({ method: 'POST', url: '/explore' });
  assert.equal(response.statusCode, 405);
});

test('explore HTML validators include changes to the catalog without emitting Last-Modified', async () => {
  rows = [row('older', { updatedAt: '2026-08-01T00:00:00.000Z' }), row('newer', { updatedAt: '2026-08-30T05:57:39.270Z' })];
  const response = await app.inject({ method: 'GET', url: '/explore' });
  assert.equal(response.headers['last-modified'], undefined);
  assert.match(String(response.headers.etag), /^W\/"html-/u);
  rows = [];
  const empty = await app.inject({ method: 'GET', url: '/explore', headers: { 'if-none-match': String(response.headers.etag) } });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.headers['last-modified'], undefined);
  assert.notEqual(empty.headers.etag, response.headers.etag);
});
