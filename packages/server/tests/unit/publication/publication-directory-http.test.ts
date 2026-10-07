import assert from 'node:assert/strict';
import { createPublicationRepresentationEtag } from '@know-n/colp/server';
import { afterAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createPublicationCursorKeyring,
  type PublicationDirectoryQueryPorts,
  type PublicationDirectoryRecord,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';

const rows: readonly PublicationDirectoryRecord[] = [
  row('newest', '2026-07-24T02:00:00.000Z'),
  row('older', '2026-07-24T01:00:00.000Z'),
  row('oldest', '2026-07-24T00:00:00.000Z'),
];
const protectedMember = {
  ...row('protected-member', '2026-07-23T23:00:00.000Z'),
  visibility: 'protected' as const,
  protectedAuthorized: true,
};
function row(id: string, updatedAt: string): PublicationDirectoryRecord {
  return {
    id, ownerSubjectId: 'owner', title: id, summary: null, kind: 'bookmarks', visibility: 'public',
    publicationSlug: id, tags: ['typescript'], language: null, nodeCount: 1, updatedAt, protectedAuthorized: false,
    orderingUpdatedAtMicros: String(BigInt(Date.parse(updatedAt)) * 1000n),
  };
}
const cursors = createPublicationCursorKeyring({
  active: { id: 'directory-http-v1', secret: Buffer.alloc(32, 29).toString('base64') }, retained: [],
});
const query: PublicationDirectoryQueryPorts = {
  cursors,
  origin: 'https://known.example',
  maxPageSize: 200,
  reads: {
    async loadPage(request) {
      let visibleRows = request.principal === 'anonymous' ? [...rows] : [...rows, protectedMember];
      if (request.filter.tag) visibleRows = visibleRows.filter((candidate) => candidate.tags.includes(request.filter.tag!));
      if (request.filter.creator) visibleRows = visibleRows.filter((candidate) => candidate.ownerSubjectId === request.filter.creator);
      if (request.filter.kind) visibleRows = visibleRows.filter((candidate) => candidate.kind === request.filter.kind);
      if (request.filter.updatedSince) {
        visibleRows = visibleRows.filter((candidate) => candidate.updatedAt >= request.filter.updatedSince!);
      }
      if (request.filter.q) {
        visibleRows = visibleRows.filter((candidate) =>
          candidate.title.toLowerCase().includes(request.filter.q!)
          || candidate.summary?.toLowerCase().includes(request.filter.q!) === true);
      }
      const start = request.after
        ? visibleRows.findIndex((candidate) => candidate.orderingUpdatedAtMicros === request.after?.orderingUpdatedAtMicros) + 1
        : 0;
      return visibleRows.slice(start, start + request.limit + 1);
    },
  },
};
const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example', LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});
const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState('2026-07-24T00:00:00.000Z'));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
function memoryExploreLimiter() {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  });
}

const app = buildApiApp({
  config, identityUnitOfWork, browserSessionAuthority: factory.authority, publicationDirectoryQuery: query,
  exploreDirectoryRateLimiter: memoryExploreLimiter(),
});

afterAll(async () => {
  cursors.destroy();
  await app.close();
});

test('traverses complete filtered next Links and computes ETags from exact wire bytes and composer identity', async () => {
  const url = '/colp/v0.1/directory?limit=1&tag=typescript&creator=owner&kind=bookmarks&updatedSince=2026-07-01T00%3A00%3A00Z&q=e';
  const first = await app.inject({
    method: 'GET', url,
    headers: {
      accept: 'application/vnd.collection-protocol.catalog+json;version=0.1',
      origin: 'https://known.example',
    },
  });
  assert.equal(first.statusCode, 200);
  assert.match(first.headers['content-type'] ?? '', /^application\/vnd\.collection-protocol\.catalog\+json;version=0\.1/u);
  assert.match(first.headers['cache-control'] ?? '', /public/u);
  assertDirectoryHeaders(first.headers);
  assert.match(first.headers.vary ?? '', /Origin/iu);
  assert.equal(first.headers['access-control-allow-origin'], 'https://known.example');
  assert.match(first.headers.link ?? '', /rel="next"/u);
  assert.deepEqual(first.json().collections.map((item: { id: string }) => item.id), ['newest']);
  const expectedEtag = createPublicationRepresentationEtag({
    representation: first.rawPayload,
    revision: 'directory-v1',
    projectionKey: 'anonymous-public-directory',
    queryContract: 'directoryQuery',
    query: {
      limit: 1, tag: 'typescript', creator: 'owner', kind: 'bookmarks',
      updatedSince: '2026-07-01T00:00:00Z', q: 'e',
    },
    negotiatedMediaType: 'application/vnd.collection-protocol.catalog+json;version=0.1',
    protocolVersion: '0.1',
    pageIdentity: { key: 'updatedAt-desc-id-asc' },
  });
  assert.equal(first.headers.etag, expectedEtag);
  const mutated = Buffer.from(first.rawPayload);
  mutated[mutated.length - 2] ^= 1;
  assert.notEqual(createPublicationRepresentationEtag({
    representation: mutated,
    revision: 'directory-v1', projectionKey: 'anonymous-public-directory',
    queryContract: 'directoryQuery',
    query: {
      limit: 1, tag: 'typescript', creator: 'owner', kind: 'bookmarks',
      updatedSince: '2026-07-01T00:00:00Z', q: 'e',
    },
    negotiatedMediaType: 'application/vnd.collection-protocol.catalog+json;version=0.1',
    protocolVersion: '0.1', pageIdentity: { key: 'updatedAt-desc-id-asc' },
  }), first.headers.etag);
  const nextTarget = /<([^>]+)>/u.exec(first.headers.link ?? '')?.[1];
  assert.ok(nextTarget);
  const nextUrl = new URL(nextTarget);
  assert.equal(nextUrl.searchParams.get('q'), 'e');
  assert.equal(nextUrl.searchParams.get('limit'), '1');
  assert.equal(nextUrl.searchParams.get('tag'), 'typescript');
  assert.equal(nextUrl.searchParams.get('creator'), 'owner');
  assert.equal(nextUrl.searchParams.get('kind'), 'bookmarks');
  assert.equal(nextUrl.searchParams.get('updatedSince'), '2026-07-01T00:00:00Z');

  const ids = ['newest'];
  let next: URL | null = nextUrl;
  while (next !== null) {
    const page = await app.inject({ method: 'GET', url: `${next.pathname}${next.search}` });
    assert.equal(page.statusCode, 200);
    ids.push(...page.json().collections.map((item: { id: string }) => item.id));
    const target = /<([^>]+)>/u.exec(page.headers.link ?? '')?.[1];
    next = target ? new URL(target) : null;
  }
  assert.deepEqual(ids, ['newest', 'older', 'oldest']);
  assert.equal(new Set(ids).size, ids.length);

  const head = await app.inject({ method: 'HEAD', url });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers.etag, first.headers.etag);
  const cached = await app.inject({
    method: 'GET', url,
    headers: { 'if-none-match': first.headers.etag! },
  });
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.body, '');
  assert.equal(cached.headers.link, first.headers.link);
  assertDirectoryHeaders(cached.headers);

  // FIX-L-020: a stale or unrelated validator never suppresses the body —
  // only an actual match may answer 304 (PUB-R13).
  for (const validator of ['"stale-validator"', '"unrelated", "also-unrelated"']) {
    const staleGet = await app.inject({ method: 'GET', url, headers: { 'if-none-match': validator } });
    assert.equal(staleGet.statusCode, 200, validator);
    assert.equal(staleGet.body, first.body, validator);
    assert.equal(staleGet.headers.etag, first.headers.etag, validator);
    assert.equal(staleGet.headers['content-length'], first.headers['content-length'], validator);
    const staleHead = await app.inject({ method: 'HEAD', url, headers: { 'if-none-match': validator } });
    assert.equal(staleHead.statusCode, 200, validator);
    assert.equal(staleHead.body, '', validator);
    assert.equal(staleHead.headers.etag, first.headers.etag, validator);
    assert.equal(staleHead.headers['content-length'], first.headers['content-length'], validator);
  }
});

test('maps only Directory input failures to COLP Problems with GET/HEAD header parity', async () => {
  for (const entry of [
    { url: '/colp/v0.1/directory?unknown=x', status: 400, code: 'invalid_query' },
    { url: '/colp/v0.1/directory?limit=1&limit=2', status: 400, code: 'invalid_query' },
    { url: '/colp/v0.1/directory?q=', status: 400, code: 'invalid_query' },
    { url: '/colp/v0.1/directory?cursor=product.cursor', status: 400, code: 'invalid_cursor_scope' },
  ]) {
    const get = await app.inject({ method: 'GET', url: entry.url });
    const head = await app.inject({ method: 'HEAD', url: entry.url });
    assert.equal(get.statusCode, entry.status);
    assert.equal(head.statusCode, entry.status);
    assert.match(get.headers['content-type'] ?? '', /^application\/problem\+json/u);
    assert.equal(get.json().code, entry.code);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assertDirectoryHeaders(get.headers);
    assertDirectoryHeaders(head.headers);
  }
  const unsupported = await app.inject({
    method: 'GET', url: '/colp/v0.1/directory',
    headers: {
      accept: 'application/vnd.collection-protocol.catalog+json;version=2',
      origin: 'https://known.example',
    },
  });
  assert.equal(unsupported.statusCode, 406);
  assert.equal(unsupported.json().code, 'unsupported_version');
  assertDirectoryHeaders(unsupported.headers);
  assert.match(unsupported.headers.vary ?? '', /Origin/iu);
});

test('uses strict shared media/version negotiation and rejects cardinality and configured size overflow', async () => {
  for (const accept of [
    'application/*',
    '*/*',
    'application/vnd.collection-protocol.catalog+json;version="0.1";note="quoted;value"',
    'application/json;q=1, application/*;q=1',
  ]) {
    const response = await app.inject({
      method: 'GET', url: '/colp/v0.1/directory',
      headers: { accept, 'collection-protocol-version': '0.1' },
    });
    assert.equal(response.statusCode, 200, accept);
  }
  for (const accept of [
    'application/vnd.collection-protocol.catalog+json;q="1"',
    'application/vnd.collection-protocol.catalog+json;q=1;q=0.5',
    'application/vnd.collection-protocol.catalog+json;version=9.9',
    'application/vnd.collection-protocol.catalog+json;q=0, application/*;q=1',
    'application/vnd.collection-protocol.catalog+json;q=0, */*;q=1',
    'application/vnd.collection-protocol.catalog+json;q=0, application/json;q=1',
    'application/json;q=1, application/*;q=0',
    'application/*;q=0, application/json;q=1',
    'application/json;q=1, */*;q=0',
    'application/json;q=0',
  ]) {
    const response = await app.inject({ method: 'GET', url: '/colp/v0.1/directory', headers: { accept } });
    assert.equal(response.statusCode, 406, accept);
    assertDirectoryHeaders(response.headers);
  }
  const version = await app.inject({
    method: 'GET', url: '/colp/v0.1/directory',
    headers: { 'collection-protocol-version': '9.9' },
  });
  assert.equal(version.statusCode, 406);
  const duplicateVersion = await app.inject({
    method: 'GET', url: '/colp/v0.1/directory',
    headers: { 'collection-protocol-version': ['0.1', '0.1'] },
  });
  assert.equal(duplicateVersion.statusCode, 400);
  assert.equal(duplicateVersion.json().code, 'invalid_query');
  assertDirectoryHeaders(duplicateVersion.headers);

  const bounded = buildApiApp({
    config,
    publicationDirectoryQuery: { ...query, maxPageSize: 1 },
    exploreDirectoryRateLimiter: memoryExploreLimiter(),
  });
  try {
    const overflow = await bounded.inject({ method: 'GET', url: '/colp/v0.1/directory?limit=2' });
    assert.equal(overflow.statusCode, 400);
    assert.equal(overflow.json().code, 'invalid_query');
  } finally {
    await bounded.close();
  }
});

test('partitions protected member Directory cache and ETags by authenticated principal', async () => {
  const firstClient = await issueTestSession({
    factory, subject: 'directory-member-1', handle: 'directory-member-1',
  });
  const secondClient = await issueTestSession({
    factory, subject: 'directory-member-2', handle: 'directory-member-2',
  });
  const anonymous = await app.inject({ method: 'GET', url: '/colp/v0.1/directory?limit=10' });
  const member = await app.inject({
    method: 'GET', url: '/colp/v0.1/directory?limit=10', headers: { cookie: firstClient.cookie },
  });
  const otherMember = await app.inject({
    method: 'GET', url: '/colp/v0.1/directory?limit=10', headers: { cookie: secondClient.cookie },
  });
  assert.deepEqual(anonymous.json().collections.map((item: { id: string }) => item.id), ['newest', 'older', 'oldest']);
  assert.deepEqual(member.json().collections.map((item: { id: string }) => item.id), [
    'newest', 'older', 'oldest', 'protected-member',
  ]);
  assert.match(anonymous.headers['cache-control'] ?? '', /public/u);
  assert.match(member.headers['cache-control'] ?? '', /private/u);
  assert.notEqual(member.headers.etag, anonymous.headers.etag);
  assert.notEqual(member.headers.etag, otherMember.headers.etag);
  assertDirectoryHeaders(member.headers);
});

test('does not classify unexpected read failures as invalid query', async () => {
  const failing = buildApiApp({
    config,
    publicationDirectoryQuery: {
      ...query,
      reads: { async loadPage() { throw new Error('schema or database failure'); } },
    },
    exploreDirectoryRateLimiter: memoryExploreLimiter(),
  });
  try {
    const response = await failing.inject({ method: 'GET', url: '/colp/v0.1/directory' });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().code, 'internal_error');
  } finally {
    await failing.close();
  }
});

function assertDirectoryHeaders(headers: Record<string, string | string[] | undefined>): void {
  const vary = new Set((Array.isArray(headers.vary) ? headers.vary : [headers.vary ?? ''])
    .flatMap((value) => value.split(',')).map((value) => value.trim().toLowerCase()).filter(Boolean));
  for (const name of ['accept', 'collection-protocol-version', 'cookie', 'authorization']) {
    assert.ok(vary.has(name), `Vary is missing ${name}: ${String(headers.vary)}`);
  }
  assert.equal(headers['x-robots-tag'], 'noindex, nofollow');
}
