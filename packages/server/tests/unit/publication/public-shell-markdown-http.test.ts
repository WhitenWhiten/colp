import assert from 'node:assert/strict';
import { afterAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createWebShellCache,
  PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE,
  type PublicShellMarkdownNode,
} from '../../../src/infrastructure/http/index.js';
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
let snapshotNodes: readonly PublicShellMarkdownNode[] = [
  {
    id: 'root-1', parentId: null, kind: 'root', title: 'Root', url: null, position: null,
  },
  {
    id: 'bm-1', parentId: 'root-1', kind: 'bookmark', title: 'Example',
    url: 'https://example.test/paper', position: 'a',
  },
];

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
  };
}

function publicShell() {
  return {
    cache: createWebShellCache({
      origin: 'http://web:80',
      fetch: async () => new Response(PUBLIC_SHELL_FIXTURE, {
        status: 200, headers: { etag: '"shell"' },
      }),
    }),
    loadNodeCountBySlug: async (slug: string) => nodeCounts.get(slug) ?? null,
    loadOwnerDisplayName: async (ownerSubjectId: string) => owners.get(ownerSubjectId) ?? null,
    loadSnapshotNodes: async () => snapshotNodes,
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
  snapshotNodes = [
    { id: 'root-1', parentId: null, kind: 'root', title: 'Root', url: null, position: null },
    {
      id: 'bm-1', parentId: 'root-1', kind: 'bookmark', title: 'Example',
      url: 'https://example.test/paper', position: 'a',
    },
  ];
});

function assertMarkdownHeaders(headers: Record<string, unknown>): void {
  assert.equal(headers['content-type'], PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE);
  assert.equal(headers['cache-control'], PUBLIC_SHELL_CACHE_CONTROL);
  assert.equal(headers['cloudflare-cdn-cache-control'], PUBLIC_SHELL_CDN_CACHE_CONTROL);
  assert.equal(headers.vary, PUBLIC_SHELL_VARY);
}

test('Accept text/markdown returns structured markdown on /c only', async () => {
  const response = await onApp.inject({
    method: 'GET', url: '/c/collection', headers: { accept: 'text/markdown' },
  });
  assert.equal(response.statusCode, 200);
  assertMarkdownHeaders(response.headers);
  assert.match(response.body, /^# Collection$/mu);
  assert.match(response.body, /Curated by Ada/u);
  assert.match(response.body, /A summary\./u);
  assert.match(response.body, /- \[Example\]\(https:\/\/example\.test\/paper\)/u);
  assert.match(response.body, /\/colp\/v0\.1\/collections\/collection-1\/snapshot/u);
  assert.match(response.body, /\/llms\.txt/u);

  const html = await onApp.inject({
    method: 'GET', url: '/c/collection', headers: { accept: 'text/html' },
  });
  assert.equal(html.statusCode, 200);
  assert.equal(html.headers['content-type'], PUBLIC_SHELL_CONTENT_TYPE);
  assert.match(html.body, /<title>Collection — Know-N<\/title>/u);

  const share = await onApp.inject({
    method: 'GET', url: '/share/collection', headers: { accept: 'text/markdown' },
  });
  assert.equal(share.statusCode, 200);
  assert.equal(share.headers['content-type'], PUBLIC_SHELL_CONTENT_TYPE);
});

test('tracker query on markdown /c still injects', async () => {
  const tracked = await onApp.inject({
    method: 'GET', url: '/c/collection?utm_source=twitter', headers: { accept: 'text/markdown' },
  });
  assert.equal(tracked.statusCode, 200);
  assertMarkdownHeaders(tracked.headers);
  assert.match(tracked.body, /^# Collection$/mu);
  assert.match(tracked.body, /\/llms\.txt/u);
});

test('HEAD markdown matches GET headers with an empty body', async () => {
  const get = await onApp.inject({
    method: 'GET', url: '/c/collection', headers: { accept: 'text/markdown' },
  });
  const head = await onApp.inject({
    method: 'HEAD', url: '/c/collection', headers: { accept: 'text/markdown' },
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assertMarkdownHeaders(head.headers);
});

test('unknown slug and private collections return 404 markdown', async () => {
  current = null;
  const unknown = await onApp.inject({
    method: 'GET', url: '/c/collection', headers: { accept: 'text/markdown' },
  });
  assert.equal(unknown.statusCode, 404);
  assertMarkdownHeaders(unknown.headers);
  assert.match(unknown.body, /\/sitemap\.xml/u);
  assert.match(unknown.body, /\/llms\.txt/u);
  assert.doesNotMatch(unknown.body, /# Collection$/mu);

  current = record({ visibility: 'private' });
  const hidden = await onApp.inject({
    method: 'GET', url: '/c/collection', headers: { accept: 'text/markdown' },
  });
  assert.equal(hidden.statusCode, 404);
  assert.match(hidden.body, /\/sitemap\.xml/u);

  const invalid = await onApp.inject({
    method: 'GET', url: '/c/NOT_A_SLUG', headers: { accept: 'text/markdown' },
  });
  assert.equal(invalid.statusCode, 404);
  assert.equal(invalid.headers['content-type'], PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE);
  assert.match(invalid.body, /\/sitemap\.xml/u);
});

test('unlisted is 200 markdown with robots: noindex', async () => {
  current = record({ visibility: 'unlisted' });
  const response = await onApp.inject({
    method: 'GET', url: '/c/collection', headers: { accept: 'text/markdown' },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /robots: noindex/u);
});

test('feature flag off returns 404 markdown; COLP 410 still wins', async () => {
  current = record({ deletedAt: '2026-07-01T00:00:01.000Z' });
  const markdown = await offApp.inject({
    method: 'GET', url: '/c/collection', headers: { accept: 'text/markdown' },
  });
  assert.equal(markdown.statusCode, 404);
  assert.equal(markdown.headers['content-type'], PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE);
  assert.match(markdown.body, /\/sitemap\.xml/u);
  const colp = await offApp.inject({
    method: 'GET', url: '/c/collection',
    headers: {
      accept: 'text/markdown, application/vnd.collection-protocol.collection+json;version=0.1',
    },
  });
  assert.equal(colp.statusCode, 410);
});

test('wildcard Accept stays on HTML', async () => {
  const response = await onApp.inject({
    method: 'GET', url: '/c/collection', headers: { accept: '*/*' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], PUBLIC_SHELL_CONTENT_TYPE);
});
