import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import type { SearchPrincipal, SearchQueryResult, SearchCandidate, SearchCandidatePort,
  SearchAuthorityFact, SearchAuthorityPort } from '../../../src/modules/search/index.js';
import { SEARCH_FIRST_PAGE_CACHE_TTL_MS, createSearchCursorSigner, createSearchFirstPageCache,
  executeSearchQuery } from '../../../src/modules/search/index.js';
import type { SharedExposureFactsPort } from '../../../src/modules/attachments/index.js';
import { canonicalJson } from '../../../src/modules/commands/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import {
  SEARCH_QUERY_MAX_CODE_POINTS,
  SEARCH_QUERY_MAX_COMBINING_MARKS,
  SEARCH_QUERY_MAX_TOKENS,
  SEARCH_QUERY_MAX_WILDCARD_COMPLEXITY,
  SEARCH_RAW_QUERY_MAX_BYTES,
} from '../../../src/transport/product/search-routes.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';

const apps: Array<ReturnType<typeof buildApiApp>> = [];
const config = loadConfig({
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
  PRODUCT_ORIGIN: 'https://app.example.test',
  ALLOWED_ORIGINS: 'https://app.example.test',
  OIDC_ISSUER: 'https://issuer.example.test',
  OIDC_CLIENT_ID: 'known-web',
  OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
  OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/authorize',
  OIDC_TOKEN_ENDPOINT: 'https://issuer.example.test/token',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  LOG_LEVEL: 'silent',
});

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function result(principal: SearchPrincipal, query = 'open api',
  types: readonly ('collection' | 'node' | 'profile' | 'annotation')[] = ['collection', 'node', 'profile', 'annotation']): SearchQueryResult {
  return {
    normalizedQuery: query,
    types,
    items: [{ resourceType: 'collection', resourceId: 'collection-1', title: 'Open API',
      snippet: 'A bounded plain-text result.', rank: 0.875 }],
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
    cache: principal.kind === 'anonymous'
      ? { class: 'shared-public', partition: 'anonymous-representation-partition' }
      : { class: 'private-no-store', partition: null },
    consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
  };
}

function generousLimiter(): ReturnType<typeof createMemorySearchRateLimiter> {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000,
    accountMaxRequests: 10_000,
    windowMs: 60_000,
  });
}

function appWithQuery(execute: (input: {
  principal: SearchPrincipal; query: string; types?: readonly ('collection' | 'node' | 'profile' | 'annotation')[];
  pageSize?: number; cursor?: string; timeoutMs?: number; signal?: AbortSignal;
}) => Promise<SearchQueryResult>) {
  const app = buildApiApp({ config, searchQuery: { execute }, searchRateLimiter: generousLimiter() });
  apps.push(app);
  return app;
}

test('P2B-24 maps a bounded anonymous GET and conditional HEAD through Search query', async () => {
  const calls: Array<{ query: string; types?: readonly string[]; pageSize?: number; signal?: AbortSignal }> = [];
  const app = appWithQuery(async (input) => { calls.push(input); return result(input.principal, input.query,
    input.types ?? ['collection', 'node', 'profile', 'annotation']); });
  const first = await app.inject({ method: 'GET', url: '/api/v1/search?q=open+api&type=node&type=profile&limit=10',
    headers: { accept: 'application/json' } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(first.headers['cache-control'], 'public, max-age=30, must-revalidate');
  assert.match(String(first.headers.vary), /Accept/u);
  assert.match(String(first.headers.vary), /Cookie/u);
  assert.match(String(first.headers.vary), /Authorization/u);
  assert.match(String(first.headers.etag), /^"sha256-[A-Za-z0-9_-]{43}"$/u);
  const digest = createHash('sha256').update('known-product-search\n1.7.0\n')
    .update(canonicalJson({ kind: 'anonymous', partition: 'anonymous-representation-partition' }))
    .update('\n').update(Buffer.from(first.body, 'utf8')).digest('base64url');
  assert.equal(first.headers.etag, `"sha256-${digest}"`);
  assert.equal(first.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(first.json().items[0], result({ kind: 'anonymous' }).items[0]);
  assert.deepEqual(calls[0]?.types, ['node', 'profile']);
  assert.equal(calls[0]?.query, 'open api');
  assert.equal(calls[0]?.pageSize, 10);
  assert.ok(calls[0]?.signal instanceof AbortSignal);

  const head = await app.inject({ method: 'HEAD', url: '/api/v1/search?q=open%20api&type=node&type=profile&limit=10',
    headers: { accept: 'application/json', origin: 'https://app.example.test' } });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers.etag, first.headers.etag);
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(first.body)));
  assert.match(String(head.headers.vary), /Origin/u);

  const conditional = await app.inject({ method: 'HEAD', url: '/api/v1/search?q=open%20api&type=node&type=profile&limit=10',
    headers: { accept: 'application/json', 'if-none-match': String(first.headers.etag) } });
  assert.equal(conditional.statusCode, 304);
  assert.equal(conditional.body, '');
  for (const validator of [`W/${String(first.headers.etag)}`, `"other", ${String(first.headers.etag)}`, '*']) {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=open%20api&type=node&type=profile&limit=10',
      headers: { 'if-none-match': validator } });
    assert.equal(response.statusCode, 304, validator);
    assert.equal(response.body, '');
  }
  // FIX-L-020: a stale or unrelated validator never suppresses the body —
  // only an actual match may answer 304 (PUB-R13).
  for (const validator of ['"stale-validator"', '"unrelated", "also-unrelated"']) {
    const staleGet = await app.inject({ method: 'GET', url: '/api/v1/search?q=open%20api&type=node&type=profile&limit=10',
      headers: { 'if-none-match': validator } });
    assert.equal(staleGet.statusCode, 200, validator);
    assert.equal(staleGet.body, first.body, validator);
    assert.equal(staleGet.headers.etag, first.headers.etag, validator);
    assert.equal(staleGet.headers['content-length'], String(Buffer.byteLength(first.body)), validator);
    const staleHead = await app.inject({ method: 'HEAD', url: '/api/v1/search?q=open%20api&type=node&type=profile&limit=10',
      headers: { 'if-none-match': validator } });
    assert.equal(staleHead.statusCode, 200, validator);
    assert.equal(staleHead.body, '', validator);
    assert.equal(staleHead.headers.etag, first.headers.etag, validator);
    assert.equal(staleHead.headers['content-length'], String(Buffer.byteLength(first.body)), validator);
  }
  assert.equal(calls.length, 10,
    'every conditional GET/HEAD, matched or not, must follow a fresh origin SQL/query execute; 304 does not skip Search execution');
});

test('P2B-24 anonymous empty results stay cacheable under the bounded must-revalidate policy', async () => {
  const app = appWithQuery(async (input) => ({ ...result(input.principal, input.query,
    input.types ?? ['collection', 'node', 'profile', 'annotation']), items: [] }));
  const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=no-matches' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'public, max-age=30, must-revalidate',
    'empty anonymous results keep the same bounded shared-cache policy as non-empty results');
  assert.deepEqual(response.json().items, []);
});

test('P2B-24 rejects raw/decode/normalization and cardinality attacks without reflecting input', async () => {
  let calls = 0;
  const app = appWithQuery(async (input) => { calls += 1; return result(input.principal, input.query,
    input.types ?? ['collection', 'node', 'profile', 'annotation']); });
  const invalidUrls = [
    '/api/v1/search', '/api/v1/search?q=', '/api/v1/search?q=a&q=b',
    '/api/v1/search?q=a&cursor=x&limit=2', '/api/v1/search?q=a&unknown=x',
    '/api/v1/search?q=a&type=node&type=bogus', '/api/v1/search?q=a&type=node&type=node',
    '/api/v1/search?q=a&type=node,node',
    '/api/v1/search?q=%', '/api/v1/search?q=%C0%AF', '/api/v1/search?q=%00hidden',
    `/api/v1/search?q=${encodeURIComponent(`a${String.fromCharCode(0x85)}b`)}`,
    `/api/v1/search?q=${encodeURIComponent(`a${'\u0301'.repeat(65)}`)}`,
    `/api/v1/search?q=${encodeURIComponent('word '.repeat(65))}`,
    `/api/v1/search?q=${encodeURIComponent('*'.repeat(17))}`,
    `/api/v1/search?q=${'a'.repeat(2049)}`,
    `/api/v1/search?q=${'%E4%B8%AD'.repeat(228)}`,
  ];
  for (const url of invalidUrls) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 400, url);
    assert.ok(['invalid_query', 'invalid_cursor'].includes(response.json().error.code), url);
    assert.doesNotMatch(response.body, /hidden|word word|aaaaaa|PostgreSQL|syntax error/iu);
  }
  assert.equal(calls, 0);

  for (const q of ['C%2B%2B', '%22quoted%22', 'title%3Aopen', 'a%25b', 'a_b', 'a%5Cb']) {
    const response = await app.inject({ method: 'GET', url: `/api/v1/search?q=${q}` });
    assert.equal(response.statusCode, 200, q);
  }
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/search?q=${'%E4%B8%AD'.repeat(227)}` })).statusCode, 200);
  assert.equal(calls, 7);
});

test('P2B-24 negotiates Accept, validates entity tags, maps timeout/unavailable, and admits bounded rate', async () => {
  const timeout = appWithQuery(async () => {
    const error = new Error('sensitive raw query') as Error & { code: string };
    error.code = 'search_timeout';
    throw error;
  });
  const timed = await timeout.inject({ method: 'GET', url: '/api/v1/search?q=secret-marker' });
  assert.equal(timed.statusCode, 503);
  assert.equal(timed.json().error.code, 'feature_temporarily_unavailable');
  assert.equal(timed.headers['retry-after'], '1');
  assert.equal(timed.headers['cache-control'], 'private, no-store',
    'Search error responses carry the product admission no-store default; shared caches cannot store them');
  assert.doesNotMatch(timed.body, /secret-marker|sensitive raw query/u);

  const unavailable = appWithQuery(async () => {
    throw Object.assign(new Error('postgresql://secret@db/internal'), { cause: { code: 'ECONNRESET' } });
  });
  const failed = await unavailable.inject({ method: 'GET', url: '/api/v1/search?q=database-secret-marker' });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().error.code, 'feature_temporarily_unavailable');
  assert.equal(failed.headers['retry-after'], '1');
  assert.equal(failed.headers['cache-control'], 'private, no-store');
  assert.doesNotMatch(failed.body, /database-secret-marker|postgresql:\/\/secret/u);

  const app = appWithQuery(async (input) => result(input.principal, input.query,
    input.types ?? ['collection', 'node', 'profile', 'annotation']));
  for (const accept of ['', 'text/html', 'application/problem+json']) {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=valid', headers: { accept } });
    assert.equal(response.statusCode, 406, accept);
    assert.equal(response.json().error.code, 'not_acceptable', accept);
  }
  for (const headers of [{ cookie: '__Host-known_session=invalid' }, { authorization: 'Bearer forged' }]) {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=valid', headers });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'authentication_required');
  }
  for (const validator of ['not-an-etag', '*, "other"', '"unterminated', 'W/not-quoted']) {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=valid',
      headers: { 'if-none-match': validator } });
    assert.equal(response.statusCode, 400, validator);
  }

  let limitedCalls = 0;
  const limited = buildApiApp({ config, searchQuery: { execute: async (input) => {
    limitedCalls += 1;
    return result(input.principal, input.query, input.types ?? ['collection', 'node', 'profile', 'annotation']);
  } },
    searchRateLimiter: createMemorySearchRateLimiter({ anonymousMaxRequests: 1, accountMaxRequests: 1, windowMs: 60_000 }) });
  apps.push(limited);
  assert.equal((await limited.inject({ method: 'GET', url: '/api/v1/search?q=first' })).statusCode, 200);
  const rejected = await limited.inject({ method: 'GET', url: '/api/v1/search?q=private-rate-limit-marker' });
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.headers['retry-after'], '60');
  assert.equal(rejected.headers['ratelimit-policy'], 'search:anonymous:1:60000');
  assert.equal(rejected.headers['cache-control'], 'private, no-store');
  assert.equal(rejected.json().error.code, 'rate_limited');
  assert.doesNotMatch(rejected.body, /private-rate-limit-marker/u);
  assert.equal(limitedCalls, 1);
});

test('FIX-M-006 anonymous Search budget keys on the trusted client IP; spoofed XFF never opens a second bucket', async () => {
  const limiter = createMemorySearchRateLimiter({ anonymousMaxRequests: 2, accountMaxRequests: 2, windowMs: 60_000 });
  const app = buildApiApp({ config, searchQuery: { execute: async (input) => result(input.principal, input.query,
    input.types ?? ['collection', 'node', 'profile', 'annotation']) }, searchRateLimiter: limiter });
  apps.push(app);

  // Client A exhausts its own anonymous budget.
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/search?q=one', remoteAddress: '203.0.113.10' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/search?q=two', remoteAddress: '203.0.113.10' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/search?q=three', remoteAddress: '203.0.113.10' })).statusCode, 429);

  // A DIFFERENT client IP stays fully isolated.
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/search?q=other', remoteAddress: '198.51.100.20' })).statusCode, 200);

  // Spoofed X-Forwarded-For from the same untrusted peer shares the PEER
  // bucket: the peer's budget is exhausted regardless of the header.
  const spoofed = await app.inject({ method: 'GET', url: '/api/v1/search?q=spoofed',
    remoteAddress: '203.0.113.10', headers: { 'x-forwarded-for': '9.9.9.9' } });
  assert.equal(spoofed.statusCode, 429, 'an untrusted peer cannot rotate the rate-limit identity');
  assert.equal(spoofed.headers['ratelimit-policy'], 'search:anonymous:2:60000');
});

test('FIX-M-006 a trusted ingress peer resolves the real client: buckets are per forwarded client IP', async () => {
  const proxied = loadConfig({
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example.test',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/authorize',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example.test/token',
    NODE_ENV: 'test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
    // The nginx peer (10.0.0.2) is trusted; XFF carries the real client.
    TRUSTED_INGRESS: '10.0.0.0/8',
  });
  const limiter = createMemorySearchRateLimiter({ anonymousMaxRequests: 2, accountMaxRequests: 2, windowMs: 60_000 });
  const app = buildApiApp({ config: proxied, searchQuery: { execute: async (input) => result(input.principal,
    input.query, input.types ?? ['collection', 'node', 'profile', 'annotation']) }, searchRateLimiter: limiter });
  apps.push(app);
  const viaProxy = (xff: string) => ({ method: 'GET', url: '/api/v1/search?q=probe',
    remoteAddress: '10.0.0.2', headers: { 'x-forwarded-for': xff } });

  // Client 203.0.113.10 (behind nginx) exhausts its own bucket...
  assert.equal((await app.inject(viaProxy('203.0.113.10'))).statusCode, 200);
  assert.equal((await app.inject(viaProxy('203.0.113.10'))).statusCode, 200);
  assert.equal((await app.inject(viaProxy('203.0.113.10'))).statusCode, 429);
  // ...while client 198.51.100.20 through the SAME nginx peer is isolated.
  assert.equal((await app.inject(viaProxy('198.51.100.20'))).statusCode, 200);
  assert.equal((await app.inject(viaProxy('198.51.100.20'))).statusCode, 200);
  assert.equal((await app.inject(viaProxy('198.51.100.20'))).statusCode, 429);
});

test('P2B-24 enforces every raw/decode budget at its exported constant boundary', async () => {
  let calls = 0;
  const app = appWithQuery(async (input) => { calls += 1; return result(input.principal, input.query,
    input.types ?? ['collection', 'node', 'profile', 'annotation']); });
  assert.equal(SEARCH_RAW_QUERY_MAX_BYTES, 2_048);
  assert.equal(SEARCH_QUERY_MAX_CODE_POINTS, 512);
  assert.equal(SEARCH_QUERY_MAX_TOKENS, 64);
  assert.equal(SEARCH_QUERY_MAX_COMBINING_MARKS, 64);
  assert.equal(SEARCH_QUERY_MAX_WILDCARD_COMPLEXITY, 16);
  const boundaries: ReadonlyArray<readonly [name: string, build: (count: number) => string, budget: number]> = [
    ['raw query bytes', (count) => '中'.repeat(count),
      Math.floor(SEARCH_RAW_QUERY_MAX_BYTES / encodeURIComponent('中').length)],
    ['query code points', (count) => 'a'.repeat(count), SEARCH_QUERY_MAX_CODE_POINTS],
    ['query tokens', (count) => 'word '.repeat(count), SEARCH_QUERY_MAX_TOKENS],
    ['combining marks', (count) => `a${'\u0301'.repeat(count)}`, SEARCH_QUERY_MAX_COMBINING_MARKS],
    ['wildcard complexity', (count) => '*'.repeat(count), SEARCH_QUERY_MAX_WILDCARD_COMPLEXITY],
  ];
  for (const [name, build, budget] of boundaries) {
    const accepted = await app.inject({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent(build(budget))}` });
    assert.equal(accepted.statusCode, 200, `${name} at budget ${budget}`);
    const rejected = await app.inject({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent(build(budget + 1))}` });
    assert.equal(rejected.statusCode, 400, `${name} one over budget ${budget}`);
    assert.equal(rejected.json().error.code, 'invalid_query', name);
    assert.doesNotMatch(rejected.body, /PostgreSQL|syntax error/iu, name);
  }
  assert.equal(calls, boundaries.length, 'every accepted boundary must reach the Search execution');
});

test('P2B-24 propagates the route timeout into the Search signal and maps it to a 503', async () => {
  const app = buildApiApp({ config, searchTimeoutMs: 30, searchRateLimiter: generousLimiter(), searchQuery: { execute: async (input) => {
    await new Promise<void>((_resolve, reject) => input.signal?.addEventListener('abort',
      () => reject(input.signal?.reason), { once: true }));
    return result(input.principal, input.query,
      input.types ?? ['collection', 'node', 'profile', 'annotation']);
  } } });
  apps.push(app);
  const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=hang' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
  assert.match(response.json().error.message, /timed out/u);
  assert.equal(response.headers['retry-after'], '1');
  assert.equal(response.headers['cache-control'], 'private, no-store');
});

test('P2B-24 resolves account principals from the session boundary with a stringified security epoch', async () => {
  const state = createIdentityMemoryState(new Date('2026-07-25T12:00:00.000Z'));
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(state);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const client = await issueTestSession({ factory,
    subject: 'search-subject', handle: 'search-handle' });
  const epoch = state.accounts.get(client.accountId)!.securityEpoch.toString();
  let seen: SearchPrincipal | undefined;
  const app = buildApiApp({ config, identityUnitOfWork, browserSessionAuthority: factory.authority, searchRateLimiter: generousLimiter(), searchQuery: { execute: async (input) => {
    seen = input.principal;
    return result(input.principal, input.query,
      input.types ?? ['collection', 'node', 'profile', 'annotation']);
  } } });
  apps.push(app);
  const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=account',
    headers: { cookie: client.cookie, origin: 'https://app.example.test' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.body)));
  assert.match(String(response.headers.vary), /Cookie/u);
  assert.match(String(response.headers.vary), /Authorization/u);
  assert.deepEqual(seen, { kind: 'account', accountId: client.accountId, principalId: client.accountId,
    subjectId: client.subjectId, securityEpoch: epoch });
});

test('P-05 authenticated Search omits ETag and never 304s after a fresh origin execute', async () => {
  const state = createIdentityMemoryState(new Date('2026-07-25T12:00:00.000Z'));
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(state);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const client = await issueTestSession({ factory,
    subject: 'search-etag-subject', handle: 'search-etag-handle' });
  const calls: SearchPrincipal[] = [];
  const app = buildApiApp({ config, identityUnitOfWork, browserSessionAuthority: factory.authority,
    searchRateLimiter: generousLimiter(),
    searchQuery: { execute: async (input) => {
      calls.push(input.principal);
      return result(input.principal, input.query,
        input.types ?? ['collection', 'node', 'profile', 'annotation']);
    } } });
  apps.push(app);

  const anonymous = await app.inject({ method: 'GET', url: '/api/v1/search?q=account' });
  assert.equal(anonymous.statusCode, 200);
  assert.match(String(anonymous.headers.etag), /^"sha256-[A-Za-z0-9_-]{43}"$/u);
  const anonymousEtag = String(anonymous.headers.etag);

  const first = await app.inject({ method: 'GET', url: '/api/v1/search?q=account',
    headers: { cookie: client.cookie, origin: 'https://app.example.test' } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['cache-control'], 'private, no-store');
  assert.equal(first.headers.etag, undefined);
  assert.equal(first.headers['content-length'], String(Buffer.byteLength(first.body)));
  assert.ok(first.body.length > 0);

  for (const validator of [anonymousEtag, '*', '"sha256-fabricated-account-tag"', 'not-an-etag']) {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=account',
      headers: { cookie: client.cookie, origin: 'https://app.example.test', 'if-none-match': validator } });
    assert.equal(response.statusCode, 200, validator);
    assert.equal(response.headers['cache-control'], 'private, no-store', validator);
    assert.equal(response.headers.etag, undefined, validator);
    assert.equal(response.body, first.body, validator);
    assert.equal(response.headers['content-length'], String(Buffer.byteLength(first.body)), validator);
  }

  const head = await app.inject({ method: 'HEAD', url: '/api/v1/search?q=account',
    headers: { cookie: client.cookie, origin: 'https://app.example.test', 'if-none-match': '*' } });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers.etag, undefined);
  assert.equal(head.headers['cache-control'], 'private, no-store');
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(first.body)));
  assert.equal(calls.length, 7,
    'authenticated If-None-Match never skips origin Search execute, including * and malformed validators');
  assert.ok(calls.every((principal) => principal.kind === 'account' || principal.kind === 'anonymous'));
  assert.equal(calls.filter((principal) => principal.kind === 'account').length, 6);
});

test('P2B-24 route wiring that only a static scan can prove stays explicit', () => {
  // Static proof boundary: observable route behavior (raw/decode budgets at
  // the exported constants, timeout->abort->503 mapping, account principal
  // epoch stringification, cache headers, Vary, 304/400 envelopes) is
  // asserted behaviorally in this file and in the PG/HTTP integration suite.
  // The scans below prove wiring that behavior cannot distinguish:
  // - the route binds the shared budget constants instead of inline literals;
  // - a client disconnect ('aborted'/'close') cancels the in-flight Search,
  //   which needs a socket-level test;
  // - the anonymous cache policy has no SWR extension (no purge channel);
  // - error concealment is an absence property: the route never logs
  //   query/cursor/snippet, telemetry sees only the raw path, and the
  //   FIX-L-004 malformed-URL envelope never echoes the raw path.
  const source = readFileSync('src/transport/product/search-routes.ts', 'utf8');
  const telemetry = readFileSync('src/infrastructure/telemetry/index.ts', 'utf8');
  const appSource = readFileSync('src/transport/app.ts', 'utf8');
  for (const symbol of ['SEARCH_RAW_QUERY_MAX_BYTES', 'SEARCH_QUERY_MAX_CODE_POINTS', 'SEARCH_QUERY_MAX_TOKENS',
    'SEARCH_QUERY_MAX_COMBINING_MARKS', 'SEARCH_QUERY_MAX_WILDCARD_COMPLEXITY',
    'SEARCH_TYPE_FILTER_MAX_CARDINALITY', 'SEARCH_SINGLE_PARAMETER_MAX_CARDINALITY']) {
    assert.match(source, new RegExp(symbol));
  }
  assert.match(source, /request\.raw\.once\('aborted'|reply\.raw\.once\('close'/u);
  assert.doesNotMatch(source, /stale-while-revalidate/u);
  assert.match(source, /304 is a body elision after a fresh origin search, not a[\s/]*DB skip/u);
  assert.match(source, /skip createSearchEtag hashing, omit ETag, and never 304/u);
  assert.match(source, /principal\.kind === 'anonymous'[\s\S]{0,120}createSearchEtag/u);
  assert.match(source, /There is no pre-SQL ETag cache/u);
  assert.doesNotMatch(source, /request\.log\.(?:info|warn|error)\([^\n]*(?:query|cursor|snippet)/u);
  assert.match(telemetry, /rawUrl\.split\('\?', 1\)/u);
  // FIX-L-004: the unified malformed-URL branch keeps error concealment —
  // a fixed message on /api/v1/** that never echoes the raw path — while
  // Search's own invalid_query message stays in the route module.
  assert.match(source, /The Search query is invalid\./u);
  assert.match(appSource, /The request URL is invalid\./u);
  assert.doesNotMatch(appSource, /The request URL is invalid\.[\s\S]{0,300}`\$\{path\}`/u);
});

test('omitted Search limiter fails closed at composition when shared is off', () => {
  assert.throws(
    () => buildApiApp({ config, searchQuery: { execute: async (input) => result(input.principal, input.query,
      input.types ?? ['collection', 'node', 'profile', 'annotation']) } }),
    /injected searchRateLimiter whenever Search routes are registered/,
  );
});

test('shared Search adapter without an injected limiter fails closed at composition', () => {
  const shared = loadConfig({
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example.test',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/authorize',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example.test/token',
    NODE_ENV: 'test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
    SEARCH_RATE_LIMIT_SHARED: 'true',
    SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
  });
  assert.throws(
    () => buildApiApp({ config: shared, searchQuery: { execute: async (input) => result(input.principal, input.query,
      input.types ?? ['collection', 'node', 'profile', 'annotation']) } }),
    /injected searchRateLimiter.*SEARCH_RATE_LIMIT_SHARED=true/s,
  );
});

const NO_SEARCH_BLOBS: SharedExposureFactsPort = Object.freeze({ async listBlobFacts() { return []; } });

function firstPageHarness(): {
  ports: Parameters<typeof executeSearchQuery>[0]; facts: Map<string, SearchAuthorityFact>;
  advance(ms: number): void;
} {
  const candidates: readonly SearchCandidate[] = [
    { resourceType: 'collection', resourceId: 'a', collectionId: 'a', title: 'Alpha', urlHost: null,
      snippetSource: 'alpha snippet', rank: 1, exclusive: { rank: 1, resourceType: 'collection', resourceId: 'a' } },
    { resourceType: 'collection', resourceId: 'b', collectionId: 'b', title: 'Beta', urlHost: null,
      snippetSource: 'beta snippet', rank: 0.9, exclusive: { rank: 0.9, resourceType: 'collection', resourceId: 'b' } },
    { resourceType: 'collection', resourceId: 'c', collectionId: 'c', title: 'Gamma', urlHost: null,
      snippetSource: 'gamma snippet', rank: 0.8, exclusive: { rank: 0.8, resourceType: 'collection', resourceId: 'c' } },
  ];
  const facts = new Map<string, SearchAuthorityFact>(candidates.map((candidate) =>
    [`collection:${candidate.resourceId}`, { resourceType: 'collection', resourceId: candidate.resourceId,
      collectionId: candidate.resourceId, ownerSubjectId: 'subject-owner', membershipRole: null,
      visibility: 'public', allowSearchIndexing: true, policyRevision: 'p1', deleted: false,
      title: candidate.title, snippetSource: candidate.snippetSource }]));
  let now = new Date('2026-07-25T12:00:00.000Z');
  const candidatePort: SearchCandidatePort = {
    async listAnonymousCandidates(input) { return this.listCandidates({ ...input,
      types: ['collection', 'node', 'profile', 'annotation'], projection: { kind: 'anonymous' }, timeoutMs: 5_000 }); },
    async listCandidates(input) {
      if (input.signal?.aborted) throw input.signal.reason;
      const start = input.after === undefined ? 0 : candidates.findIndex((item) =>
        item.exclusive.resourceType === input.after?.resourceType
          && item.exclusive.resourceId === input.after?.resourceId
          && item.exclusive.rank === input.after?.rank) + 1;
      const filtered = candidates.slice(start).filter((item) => input.types.includes(item.resourceType));
      return { items: filtered.slice(0, input.limit), hasMore: filtered.length > input.limit };
    },
  };
  const authorityPort: SearchAuthorityPort = { async loadBatch(input) {
    if (input.signal?.aborted) throw input.signal.reason;
    return input.candidates.flatMap((candidate) => {
      const fact = facts.get(`${candidate.resourceType}:${candidate.resourceId}`);
      return fact === undefined ? [] : [fact];
    });
  } };
  const ports = { candidates: candidatePort, authority: authorityPort,
    cursors: createSearchCursorSigner({ current: { id: 'search-route-v1', key: 'search-route-cursor-secret-material-32' } }),
    clock: { now: () => now }, sharedExposure: NO_SEARCH_BLOBS, firstPageCache: createSearchFirstPageCache() };
  return { ports, facts, advance(ms: number) { now = new Date(now.getTime() + ms); } };
}

test('FIX-L-025 anonymous first-page responses with more pages revalidate 304 inside the hard TTL and rotate after it', async () => {
  const harness = firstPageHarness();
  const app = buildApiApp({ config, searchQuery: { execute: (input) => executeSearchQuery(harness.ports, input) },
    searchRateLimiter: generousLimiter() });
  apps.push(app);
  const url = '/api/v1/search?q=stable&limit=1';
  const first = await app.inject({ method: 'GET', url, headers: { accept: 'application/json' } });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json<{ page: { nextCursor: string | null } }>();
  assert.ok(firstBody.page.nextCursor, 'a first page with more pages must carry a cursor');
  const etag = String(first.headers.etag);

  // Advancing the clock INSIDE the hard TTL: the same If-None-Match must hit
  // 304 because the response bytes (including the reused cursor) are stable.
  harness.advance(5 * 60_000);
  const revalidated = await app.inject({ method: 'GET', url,
    headers: { accept: 'application/json', 'if-none-match': etag } });
  assert.equal(revalidated.statusCode, 304);
  assert.equal(revalidated.body, '');
  const refetched = await app.inject({ method: 'GET', url, headers: { accept: 'application/json' } });
  assert.equal(refetched.statusCode, 200);
  assert.equal(refetched.body, first.body);
  assert.equal(String(refetched.headers.etag), etag);

  // Past the hard TTL a fresh cursor/ETag is generated, so the stale
  // validator answers 200 with the new representation.
  harness.advance(SEARCH_FIRST_PAGE_CACHE_TTL_MS + 60_000);
  const rotated = await app.inject({ method: 'GET', url,
    headers: { accept: 'application/json', 'if-none-match': etag } });
  assert.equal(rotated.statusCode, 200);
  assert.notEqual(String(rotated.headers.etag), etag);
  assert.notEqual(rotated.json<{ page: { nextCursor: string | null } }>().page.nextCursor,
    firstBody.page.nextCursor);
});

test('FIX-L-025 a first-page data change invalidates the reused cursor and ETag within the hard TTL', async () => {
  const harness = firstPageHarness();
  const app = buildApiApp({ config, searchQuery: { execute: (input) => executeSearchQuery(harness.ports, input) },
    searchRateLimiter: generousLimiter() });
  apps.push(app);
  const url = '/api/v1/search?q=stable&limit=1';
  const first = await app.inject({ method: 'GET', url });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json<{ items: Array<{ resourceId: string }> }>().items.map((item) => item.resourceId), ['a']);
  const etag = String(first.headers.etag);

  // Revoking the first candidate inside the TTL must not reuse the cached
  // cursor: the response bytes change, the stale validator answers 200.
  harness.facts.set('collection:a', { resourceType: 'collection', resourceId: 'a', collectionId: 'a',
    ownerSubjectId: 'subject-owner', membershipRole: null, visibility: 'private', allowSearchIndexing: true,
    policyRevision: 'p2', deleted: false, title: 'Alpha', snippetSource: 'alpha snippet' });
  harness.advance(5 * 60_000);
  const after = await app.inject({ method: 'GET', url, headers: { 'if-none-match': etag } });
  assert.equal(after.statusCode, 200);
  assert.notEqual(String(after.headers.etag), etag);
  assert.deepEqual(after.json<{ items: Array<{ resourceId: string }> }>().items.map((item) => item.resourceId), ['b']);
});
