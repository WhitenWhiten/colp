import assert from 'node:assert/strict';
import { afterAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createWebShellCache } from '../../../src/infrastructure/http/index.js';
import type { PublicationMetadataRecord } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import {
  PUBLIC_SHELL_CACHE_CONTROL,
  PUBLIC_SHELL_CDN_CACHE_CONTROL,
  PUBLIC_SHELL_CONTENT_TYPE,
  PUBLIC_SHELL_VARY,
} from '../../../src/transport/public-shell-routes.js';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

let current: PublicationMetadataRecord | null = record();
let owners = new Map<string, string>([['owner', 'Ada']]);
let nodeCounts = new Map<string, number>([['collection', 3]]);
let shellAvailable = true;
let hidePublicControl = false;

function record(overrides: Partial<PublicationMetadataRecord> = {}): PublicationMetadataRecord {
  return {
    id: 'collection-1', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Collection',
    summary: 'A summary.', visibility: 'public', publicationSlug: 'collection',
    rootNodeId: 'root-1', rootAvailable: true, contentRevision: 'c1', policyRevision: 'p1',
    tags: [], language: null, membershipRole: null,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
    deletedAt: null, ...overrides,
  };
}

const offConfig = loadConfig({
  DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example', LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});
const onConfig = loadConfig({
  DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example', LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  KNOWN_FEATURE_PUBLIC_SHELL_META: 'true',
  WEB_SHELL_ORIGIN: 'http://web:80',
});

function limiter() {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  });
}

function query() {
  return {
    reads: { async load() { return current; } },
    origin: 'https://known.example',
    now: () => new Date('2026-07-24T00:00:00Z'),
    collectionControl: { async collectionControl() { return { hidePublic: hidePublicControl, delisted: hidePublicControl }; } },
  };
}

function publicShell() {
  return {
    cache: createWebShellCache({
      origin: 'http://web:80',
      fetch: async () => {
        if (!shellAvailable) return new Response('down', { status: 503 });
        return new Response(PUBLIC_SHELL_FIXTURE, { status: 200, headers: { etag: '"shell"' } });
      },
    }),
    loadNodeCountBySlug: async (slug: string) => nodeCounts.get(slug) ?? null,
    loadOwnerDisplayName: async (ownerSubjectId: string) => owners.get(ownerSubjectId) ?? null,
  };
}

const offApp = buildApiApp({
  config: offConfig,
  publicationMetadataQuery: query(),
  exploreDirectoryRateLimiter: limiter(),
});
const onApp = buildApiApp({
  config: onConfig,
  publicationMetadataQuery: query(),
  publicShell: publicShell(),
  exploreDirectoryRateLimiter: limiter(),
});
afterAll(async () => {
  await offApp.close();
  await onApp.close();
});

beforeEach(() => {
  current = record();
  owners = new Map([['owner', 'Ada']]);
  nodeCounts = new Map([['collection', 3]]);
  shellAvailable = true;
  hidePublicControl = false;
});

function assertHtmlHeaders(headers: Record<string, unknown>): void {
  assert.equal(headers['content-type'], PUBLIC_SHELL_CONTENT_TYPE);
  assert.equal(headers['cache-control'], PUBLIC_SHELL_CACHE_CONTROL);
  assert.equal(headers['cloudflare-cdn-cache-control'], PUBLIC_SHELL_CDN_CACHE_CONTROL);
  assert.equal(headers.vary, PUBLIC_SHELL_VARY);
  assert.equal(headers['last-modified'], undefined);
  // The API baseline `default-src 'none'` would blank the SPA shell in a
  // browser; the document must ship without the API-only headers, exactly
  // like the nginx-served /index.html it replaces.
  assert.match(String(headers['content-security-policy']), /script-src 'self'/u);
  assert.match(String(headers['content-security-policy']), /object-src 'none'/u);
  assert.ok(headers['x-frame-options'] === 'DENY' || headers['x-frame-options'] === undefined);
  assert.equal(headers['cross-origin-opener-policy'], undefined);
  assert.equal(headers['x-content-type-options'], 'nosniff');
}

test('feature flag off returns 404 on HTML /c /share /path /graph and keeps COLP 410', async () => {
  current = record({ deletedAt: '2026-07-01T00:00:01.000Z' });
  const html = await offApp.inject({
    method: 'GET', url: '/c/collection', headers: { accept: 'text/html' },
  });
  assert.equal(html.statusCode, 404);
  const share = await offApp.inject({ method: 'GET', url: '/share/collection' });
  assert.equal(share.statusCode, 404);
  const path = await offApp.inject({ method: 'GET', url: '/path/collection' });
  assert.equal(path.statusCode, 404);
  const graph = await offApp.inject({ method: 'GET', url: '/graph/collection' });
  assert.equal(graph.statusCode, 404);
  const colp = await offApp.inject({
    method: 'GET', url: '/c/collection',
    headers: { accept: 'application/vnd.collection-protocol.collection+json;version=0.1' },
  });
  assert.equal(colp.statusCode, 410);
});

test('HTML revalidation tracks a web release even when collection updatedAt is unchanged', async () => {
  let build = 'old';
  const app = buildApiApp({
    config: onConfig,
    publicationMetadataQuery: query(),
    publicShell: {
      ...publicShell(),
      cache: createWebShellCache({
        origin: 'http://web:80', ttlMs: 0,
        fetch: async () => new Response(PUBLIC_SHELL_FIXTURE.replace(
          '</head>', `<script type="module" src="/assets/index-${build}.js"></script></head>`,
        )),
      }),
    },
    exploreDirectoryRateLimiter: limiter(),
  });
  try {
    const url = '/share/collection?embed=1';
    const before = await app.inject({ url });
    const oldEtag = String(before.headers.etag);
    assert.match(oldEtag, /^W\/"html-[a-f0-9]{64}"$/u);
    build = 'new';
    for (const method of ['GET', 'HEAD'] as const) {
      for (const headers of [
        { 'if-modified-since': new Date(current!.updatedAt).toUTCString() },
        { 'if-none-match': oldEtag, 'if-modified-since': new Date(current!.updatedAt).toUTCString() },
      ]) {
        const response = await app.inject({ method, url, headers });
        assert.equal(response.statusCode, 200);
        assert.notEqual(response.headers.etag, oldEtag);
        assert.equal(response.headers['last-modified'], undefined);
        if (method === 'GET') assert.match(response.body, /\/assets\/index-new\.js/u);
        else assert.equal(response.body, '');
      }
    }
  } finally {
    await app.close();
  }
});

test('unchanged HTML accepts weak/strong/list/star validators for GET and HEAD', async () => {
  const url = '/share/collection?embed=1';
  const first = await onApp.inject({ url });
  const etag = String(first.headers.etag);
  for (const method of ['GET', 'HEAD'] as const) {
    for (const condition of [etag, etag.slice(2), `"unrelated,tag", ${etag}`, '*']) {
      const response = await onApp.inject({ method, url, headers: {
        'if-none-match': condition,
        'if-modified-since': 'Thu, 01 Jan 1970 00:00:00 GMT',
      } });
      assert.equal(response.statusCode, 304, condition);
      assert.equal(response.body, '');
      assert.equal(response.headers.etag, etag);
      assert.equal(response.headers['cache-control'], first.headers['cache-control']);
      assert.equal(response.headers.vary, first.headers.vary);
      assert.equal(response.headers['cloudflare-cdn-cache-control'], first.headers['cloudflare-cdn-cache-control']);
      assert.equal(response.headers['last-modified'], undefined);
      assert.equal(response.headers['content-length'], undefined);
    }
  }
  for (const condition of ['"unrelated"', `invalid, ${etag}`, `${etag}, *`, `"unterminated, ${etag}`]) {
    const response = await onApp.inject({ url, headers: { 'if-none-match': condition } });
    assert.equal(response.statusCode, 200, condition);
  }
});

test('curator changes invalidate HTML without changing the collection timestamp', async () => {
  const url = '/share/collection?embed=1';
  const first = await onApp.inject({ url });
  owners.set('owner', 'Grace');
  const response = await onApp.inject({ url, headers: { 'if-none-match': String(first.headers.etag) } });
  assert.equal(response.statusCode, 200);
  assert.notEqual(response.headers.etag, first.headers.etag);
  assert.match(response.body, /Grace/u);
});

test('hidden and withdrawn pages cannot reuse a formerly public HTML validator', async () => {
  for (const url of ['/c/collection', '/share/collection?embed=1', '/path/collection', '/graph/collection']) {
    current = record();
    hidePublicControl = false;
    const first = await onApp.inject({ url });
    for (const condition of [String(first.headers.etag), '*']) {
      hidePublicControl = true;
      const hidden = await onApp.inject({ url, headers: { 'if-none-match': condition } });
      assert.equal(hidden.statusCode, 404);
      assert.equal(hidden.headers.etag, undefined);
      hidePublicControl = false;
      current = record({ visibility: 'private' });
      const withdrawn = await onApp.inject({ url, headers: { 'if-none-match': condition } });
      assert.equal(withdrawn.statusCode, 404);
      assert.equal(withdrawn.headers.etag, undefined);
      current = record();
    }
  }
});

test('injects public collection HTML on /c /share /path /graph', async () => {
  current = record({ language: 'zh-cn' });
  for (const url of ['/c/collection', '/share/collection', '/path/collection', '/graph/collection']) {
    const response = await onApp.inject({
      method: 'GET', url, headers: { accept: 'text/html' },
    });
    assert.equal(response.statusCode, 200, url);
    assertHtmlHeaders(response.headers);
    assert.equal(response.headers['x-frame-options'], url.startsWith('/share/') ? undefined : 'DENY');
    assert.ok(String(response.headers['content-security-policy']).includes(
      url.startsWith('/share/') ? 'frame-ancestors *' : "frame-ancestors 'none'"));
    assert.match(response.body, /<title>Collection — Know-N<\/title>/u);
    assert.match(response.body, /<link rel="canonical" href="https:\/\/know-n\.com\/c\/collection" \/>/u);
    assert.match(response.body, /<html lang="zh-CN">/u);
    assert.match(response.body, /property="og:locale" content="zh_CN"/u);
    assert.equal([...response.body.matchAll(/property="og:locale"/gu)].length, 1);
    if (url.startsWith('/share')) {
      assert.match(response.body, /og:url" content="https:\/\/know-n\.com\/share\/collection"/u);
    }
    if (url.startsWith('/graph')) {
      assert.match(response.body, /og:url" content="https:\/\/know-n\.com\/graph\/collection"/u);
    }
  }
});

test('hide_public blocks HTML /c /share /path /graph without leaking the collection title', async () => {
  hidePublicControl = true;
  for (const url of ['/c/collection', '/share/collection', '/path/collection', '/graph/collection']) {
    const response = await onApp.inject({
      method: 'GET', url, headers: { accept: 'text/html' },
    });
    assert.equal(response.statusCode, 404, url);
    assert.equal(response.body.includes('Collection — Know-N'), false, url);
  }
});

test('control query failure does not serve a stale public HTML body', async () => {
  const failApp = buildApiApp({
    config: onConfig,
    publicationMetadataQuery: {
      ...query(),
      collectionControl: {
        async collectionControl() {
          throw new Error('governance control store unavailable');
        },
      },
    },
    publicShell: publicShell(),
    exploreDirectoryRateLimiter: limiter(),
  });
  try {
    for (const url of ['/c/collection', '/share/collection', '/path/collection', '/graph/collection']) {
      const response = await failApp.inject({
        method: 'GET', url, headers: { accept: 'text/html' },
      });
      assert.notEqual(response.statusCode, 200, url);
      assert.equal(response.body.includes('Collection — Know-N'), false, url);
    }
  } finally {
    await failApp.close();
  }
});

test('tracker query on HTML /c still injects; COLP stays strict', async () => {
  const html = await onApp.inject({
    method: 'GET', url: '/c/collection?utm_source=twitter', headers: { accept: 'text/html' },
  });
  assert.equal(html.statusCode, 200);
  assertHtmlHeaders(html.headers);
  assert.match(html.body, /<title>Collection — Know-N<\/title>/u);
  assert.match(html.body, /<link rel="canonical" href="https:\/\/know-n\.com\/c\/collection" \/>/u);
  const colp = await onApp.inject({
    method: 'GET', url: '/c/collection?utm_source=twitter',
    headers: { accept: 'application/vnd.collection-protocol.collection+json;version=0.1' },
  });
  assert.equal(colp.statusCode, 400);
  assert.equal((colp.json() as { error: { code: string } }).error.code, 'invalid_query');
});

test('HEAD matches GET headers with an empty body', async () => {
  current = record({ language: 'zh-cn' });
  for (const url of ['/c/collection', '/share/collection', '/path/collection', '/graph/collection']) {
    const get = await onApp.inject({ method: 'GET', url });
    const head = await onApp.inject({ method: 'HEAD', url });
    assert.match(get.body, /<html lang="zh-CN">/u);
    assert.match(get.body, /property="og:locale" content="zh_CN"/u);
    assert.equal(head.statusCode, 200, url);
    assert.equal(head.body, '', url);
    assert.equal(head.headers['content-length'], get.headers['content-length'], url);
    assertHtmlHeaders(head.headers);
  }
});

test('other methods are 405', async () => {
  for (const url of ['/c/collection', '/share/collection', '/path/collection', '/graph/collection']) {
    const response = await onApp.inject({ method: 'POST', url });
    assert.equal(response.statusCode, 405, url);
  }
});

test('unknown slug and private collections return 404 plus the generic shell', async () => {
  current = null;
  const unknown = await onApp.inject({ method: 'GET', url: '/c/collection' });
  assert.equal(unknown.statusCode, 404);
  assertHtmlHeaders(unknown.headers);
  assert.match(unknown.body, /<title>Know-N<\/title>/u);
  assert.doesNotMatch(unknown.body, /Collection — Know-N/u);

  current = record({ visibility: 'private' });
  const hidden = await onApp.inject({ method: 'GET', url: '/c/collection' });
  assert.equal(hidden.statusCode, 404);
  assert.doesNotMatch(hidden.body, /Collection — Know-N/u);
});

test('unlisted is 200 with noindex', async () => {
  current = record({ visibility: 'unlisted' });
  const response = await onApp.inject({ method: 'GET', url: '/c/collection' });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /name="robots" content="noindex"/u);
});

test('invalid slugs stay 404', async () => {
  const response = await onApp.inject({ method: 'GET', url: '/c/NOT_A_SLUG' });
  assert.equal(response.statusCode, 404);
});

test('shell unavailable and empty cache returns 503', async () => {
  shellAvailable = true;
  const fresh = buildApiApp({
    config: onConfig,
    publicationMetadataQuery: query(),
    publicShell: publicShell(),
    exploreDirectoryRateLimiter: limiter(),
  });
  try {
    shellAvailable = false;
    const response = await fresh.inject({ method: 'GET', url: '/c/collection' });
    assert.equal(response.statusCode, 503);
  } finally {
    await fresh.close();
  }
});

test('XSS title is escaped on the HTML surface', async () => {
  current = record({ title: '"><script>alert(1)</script>' });
  const response = await onApp.inject({ method: 'GET', url: '/c/collection' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes('<script>alert(1)</script>'), false);
  assert.match(response.body, /&lt;script&gt;/u);
});

test('R15-24: a mistyped slug gets the styled shell 404 in a browser, not problem+json', async () => {
  for (const url of ['/c/Not_Canonical', '/share/Not_Canonical', '/path/Not_Canonical', '/graph/Not_Canonical']) {
    const response = await onApp.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
    assert.equal(response.statusCode, 404, url);
    assertHtmlHeaders(response.headers);
    assert.ok(response.body.includes('id="root"'), `${url} must be the hydratable shell`);
  }
  // COLP clients still get the protocol answer, not HTML.
  const colp = await onApp.inject({
    method: 'GET', url: '/c/Not_Canonical',
    headers: { accept: 'application/vnd.collection-protocol.collection+json;version=0.1' },
  });
  assert.notEqual(colp.headers['content-type'], PUBLIC_SHELL_CONTENT_TYPE);
  // Without a readable shell the problem document is still the honest answer.
  shellAvailable = false;
  const fresh = buildApiApp({
    config: onConfig,
    publicationMetadataQuery: query(),
    publicShell: publicShell(),
    exploreDirectoryRateLimiter: limiter(),
  });
  try {
    const down = await fresh.inject({ method: 'GET', url: '/c/Not_Canonical', headers: { accept: 'text/html' } });
    assert.equal(down.statusCode, 404);
    assert.match(String(down.headers['content-type']), /problem\+json/u);
  } finally {
    await fresh.close();
  }
});
