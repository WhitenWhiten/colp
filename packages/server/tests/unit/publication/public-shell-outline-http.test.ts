import assert from 'node:assert/strict';
import { afterAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createWebShellCache, type PublicShellMarkdownNode } from '../../../src/infrastructure/http/index.js';
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

let owner: { displayName: string; handle: string } | null = { displayName: 'Ada Curator', handle: 'ada_curator' };
const SNAPSHOT: readonly PublicShellMarkdownNode[] = [
  { id: 'root', parentId: null, kind: 'root', title: 'root', position: null },
  { id: 'f1', parentId: 'root', kind: 'folder', title: 'Papers', position: 'a' },
  { id: 'b1', parentId: 'f1', kind: 'bookmark', title: 'Attention', url: 'https://arxiv.org/abs/1706.03762', position: 'a' },
  { id: 'b2', parentId: 'root', kind: 'bookmark', title: 'Hugging Face', url: 'https://huggingface.co/models', position: 'b' },
];
let snapshot: readonly PublicShellMarkdownNode[] | null = SNAPSHOT;
let displayNameCalls = 0;
let excludedIds = new Set<string>();

const record: PublicationMetadataRecord = {
  id: 'collection-1', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'LLM path',
  summary: 'From intuition to alignment.', visibility: 'public', publicationSlug: 'llm-path',
  rootNodeId: 'root', rootAvailable: true, contentRevision: 'c1', policyRevision: 'p1',
  tags: [], language: 'en', membershipRole: null,
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-29T04:19:21.427Z', deletedAt: null,
};

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
    loadOwnerDisplayName: async () => {
      displayNameCalls += 1;
      return 'legacy display name';
    },
    loadOwnerPublicProfile: async () => owner,
    loadSnapshotNodes: async () => snapshot,
    excludedCollectionIds: async (ids: readonly string[]) => new Set(ids.filter((id) => excludedIds.has(id))),
  },
  exploreDirectoryRateLimiter: createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  }),
});

afterAll(async () => { await app.close(); });
beforeEach(() => {
  owner = { displayName: 'Ada Curator', handle: 'ada_curator' };
  displayNameCalls = 0;
  excludedIds = new Set();
  snapshot = SNAPSHOT;
});

test('HTML /c/:slug carries the snapshot outline, a /u/ curator link, the remaining count and ItemList JSON-LD', async () => {
  const response = await app.inject({ method: 'GET', url: '/c/llm-path', headers: { accept: 'text/html' } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /<p>Curated by <a href="\/u\/ada_curator">Ada Curator<\/a> · 7 items · updated 2026-08-29<\/p>/u);
  assert.match(response.body, /<h2>Papers<\/h2>\n<ul>\n {2}<li><a href="https:\/\/arxiv\.org\/abs\/1706\.03762" rel="nofollow ugc noopener">Attention<\/a><\/li>\n {2}<li><a href="https:\/\/huggingface\.co\/models" rel="nofollow ugc noopener">Hugging Face<\/a><\/li>\n<\/ul>/u);
  assert.match(response.body, /<p>and 3 more<\/p>/u);
  assert.match(response.body, /"creator": \{\s*"@type": "Person",\s*"name": "Ada Curator",\s*"url": "https:\/\/know-n\.com\/u\/ada_curator"/u);
  assert.match(response.body, /"inLanguage": "en"/u);
  assert.match(response.body, /"dateModified": "2026-08-29T04:19:21\.427Z"/u);
  assert.match(response.body, /"itemListElement": \[/u);
  assert.match(response.body, /<meta name="description" content="From intuition to alignment\." \/>/u);
  assert.equal(displayNameCalls, 0, 'loadOwnerPublicProfile supersedes loadOwnerDisplayName');
});

test('wrapper surfaces render the same outline with the /c canonical', async () => {
  for (const url of ['/share/llm-path', '/path/llm-path', '/graph/llm-path']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, url);
    assert.match(response.body, /<link rel="canonical" href="https:\/\/know-n\.com\/c\/llm-path" \/>/u, url);
    assert.match(response.body, /rel="nofollow ugc noopener">Attention<\/a>/u, url);
  }
});

test('owner without a public Profile keeps a plain curator and no creator URL', async () => {
  owner = null;
  const response = await app.inject({ method: 'GET', url: '/c/llm-path' });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /<p>Curated by Know-N · 7 items/u);
  assert.doesNotMatch(response.body, /href="\/u\/|"creator"/u);
});

test('a non-canonical handle from the authority is dropped rather than linked', async () => {
  owner = { displayName: 'Ada', handle: 'Not Canonical!' };
  const response = await app.inject({ method: 'GET', url: '/c/llm-path' });
  assert.match(response.body, /<p>Curated by Ada · 7 items/u);
  assert.doesNotMatch(response.body, /href="\/u\//u);
  assert.match(response.body, /"creator": \{\s*"@type": "Person",\s*"name": "Ada"\s*\}/u);
});

test('markdown variant uses the same owner authority for the curator line', async () => {
  const response = await app.inject({ method: 'GET', url: '/c/llm-path', headers: { accept: 'text/markdown' } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /^Curated by Ada Curator · updated 2026-08-29$/mu);
  assert.match(response.body, /- \[Attention\]\(https:\/\/arxiv\.org\/abs\/1706\.03762\)/u);
  assert.equal(displayNameCalls, 0);
});

test('a snapshot that vanished between reads still yields the header-only document, not a 404', async () => {
  snapshot = null;
  try {
    const response = await app.inject({ method: 'GET', url: '/c/llm-path' });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /<p>Curated by <a href="\/u\/ada_curator">Ada Curator<\/a>/u);
    assert.doesNotMatch(response.body, /<ul>|and \d+ more/u);
  } finally {
    snapshot = SNAPSHOT;
  }
});

test('HTML validates the whole document while markdown retains its existing timestamp policy', async () => {
  const expected = new Date('2026-08-29T04:19:21.427Z').toUTCString();
  for (const [url, accept] of [['/c/llm-path', 'text/html'], ['/c/llm-path', 'text/markdown'], ['/graph/llm-path', 'text/html']] as const) {
    const response = await app.inject({ method: 'GET', url, headers: { accept } });
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.headers['last-modified'], accept === 'text/html' ? undefined : expected, `${url} ${accept}`);
    if (accept === 'text/html') assert.match(String(response.headers.etag), /^W\/"html-/u);
  }
  const head = await app.inject({ method: 'HEAD', url: '/c/llm-path' });
  assert.equal(head.headers['last-modified'], undefined);
  assert.match(String(head.headers.etag), /^W\/"html-/u);
});

test('a seed-registered public collection renders on every surface with noindex and stays out of nothing else', async () => {
  excludedIds = new Set(['collection-1']);
  for (const [url, accept] of [['/c/llm-path', 'text/html'], ['/share/llm-path', 'text/html'], ['/graph/llm-path', 'text/html']] as const) {
    const response = await app.inject({ method: 'GET', url, headers: { accept } });
    assert.equal(response.statusCode, 200, url);
    assert.match(response.body, /<meta name="robots" content="noindex" \/>/u, url);
    assert.match(response.body, /rel="nofollow ugc noopener">Attention<\/a>/u, `${url} still renders the outline`);
  }
  const markdown = await app.inject({ method: 'GET', url: '/c/llm-path', headers: { accept: 'text/markdown' } });
  assert.equal(markdown.statusCode, 200);
  assert.match(markdown.body, /^robots: noindex$/mu);

  excludedIds = new Set();
  const indexable = await app.inject({ method: 'GET', url: '/c/llm-path' });
  assert.doesNotMatch(indexable.body, /name="robots"/u);
});
