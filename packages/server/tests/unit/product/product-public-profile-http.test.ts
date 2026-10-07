import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createPublicationCursorKeyring,
  type PublicationDirectoryRecord,
} from '../../../src/modules/publication/index.js';
import type { PublicProfileFactsReadPort } from '../../../src/modules/identity/index.js';
import {
  composePublicProfileProjection,
  type PublicProfileProjectionPorts,
} from '../../../src/bootstrap/public-profile-projection.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';

const CONTRACT_VERSION = '1.2.0';
const MEDIA_TYPE = 'application/json';
const instant = '2026-07-24T00:00:00.000Z';
let displayName = 'Alice';
let about = 'I collect bookmarks.';
let profileExists = true;
let reads = 0;

const collections: readonly PublicationDirectoryRecord[] = Object.freeze([
  Object.freeze({
    id: 'collection-1', ownerSubjectId: 'subject-alice', title: 'Public notes', summary: null,
    kind: 'knowledge_collection', visibility: 'public', publicationSlug: 'public-notes', tags: [],
    language: null, nodeCount: 3, updatedAt: instant,
    orderingUpdatedAtMicros: String(BigInt(Date.parse(instant)) * 1000n), protectedAuthorized: false,
  }),
]);
const cursors = createPublicationCursorKeyring({
  active: { id: 'profile-http-v1', secret: Buffer.alloc(32, 91).toString('base64') }, retained: [],
});
const facts: PublicProfileFactsReadPort = {
  async findByCanonicalHandle(handle) {
    reads += 1;
    if (!profileExists || handle !== 'alice') return null;
    return Object.freeze({
      profileId: 'IiIiIiIiIiIiIiIiIiIiIg',
      handle: 'alice', displayName, avatarUrl: 'https://cdn.example.test/alice.png',
      about,
      ownerSubjectId: 'subject-alice',
    });
  },
};
const query: PublicProfileProjectionPorts = {
  profiles: facts,
  sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
  collections: {
    async loadPage(request) {
      assert.equal(request.principal, 'anonymous');
      assert.deepEqual(request.filter, { creator: 'subject-alice' });
      return collections.slice(0, request.limit + 1);
    },
  },
  cursors,
};
const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date(instant)));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example', LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});
const app = buildApiApp({
  config,
  identityUnitOfWork,
  browserSessionAuthority: factory.authority,
  publicProfileQuery: composePublicProfileProjection(query),
  exploreDirectoryRateLimiter: createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  }),
});

afterAll(async () => {
  cursors.destroy();
  await app.close();
});

test('GET emits exact final bytes and a contract/media-bound representation ETag', async () => {
  const response = await app.inject({
    method: 'GET', url: '/api/v1/profiles/Alice?limit=1',
    headers: { accept: 'application/json', origin: 'https://known.example' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assertVary(response.headers.vary, ['Accept', 'Origin']);
  assert.deepEqual(response.json(), {
    profile: { profileId: 'IiIiIiIiIiIiIiIiIiIiIg', handle: 'alice', displayName: 'Alice', avatarUrl: 'https://cdn.example.test/alice.png', about: 'I collect bookmarks.' },
    collections: [{
      id: 'collection-1', slug: 'public-notes', title: 'Public notes', summary: null,
      kind: 'knowledge_collection', updatedAt: instant,
    }],
    page: { cursor: null, hasMore: false },
  });
  assert.equal(
    response.headers.etag,
    `"sha256-${createHash('sha256').update(`known-product-profile\n${CONTRACT_VERSION}\n${MEDIA_TYPE}\n`).update(response.rawPayload).digest('base64url')}"`,
  );
});

test('HEAD executes the same projection and header calculation without a body', async () => {
  const before = reads;
  const get = await app.inject({ method: 'GET', url: '/api/v1/profiles/alice?limit=1' });
  const head = await app.inject({ method: 'HEAD', url: '/api/v1/profiles/alice?limit=1' });
  assert.equal(reads, before + 2);
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers.etag, get.headers.etag);
  assert.equal(head.headers['content-length'], String(get.rawPayload.byteLength));
  assert.equal(head.headers['cache-control'], get.headers['cache-control']);
  assert.equal(head.headers['content-type'], get.headers['content-type']);
});

test('conditional GET recomputes the current representation before returning 304', async () => {
  displayName = 'Before';
  const first = await app.inject({ method: 'GET', url: '/api/v1/profiles/alice?limit=1' });
  const firstReads = reads;
  const unchanged = await app.inject({
    method: 'GET', url: '/api/v1/profiles/alice?limit=1', headers: { 'if-none-match': first.headers.etag! },
  });
  assert.equal(reads, firstReads + 1);
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.body, '');
  assert.equal(unchanged.headers.etag, first.headers.etag);
  assert.equal(unchanged.headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300');
  assert.equal(unchanged.headers['x-content-type-options'], 'nosniff');
  assertVary(unchanged.headers.vary, ['Accept']);

  for (const validator of [`W/${first.headers.etag!}`, `"unrelated", W/${first.headers.etag!}`, '*']) {
    const matched = await app.inject({
      method: 'GET', url: '/api/v1/profiles/alice?limit=1', headers: { 'if-none-match': validator },
    });
    assert.equal(matched.statusCode, 304, validator);
    assert.equal(matched.headers.etag, first.headers.etag, validator);
  }

  displayName = 'After';
  const changed = await app.inject({
    method: 'GET', url: '/api/v1/profiles/alice?limit=1', headers: { 'if-none-match': first.headers.etag! },
  });
  assert.equal(changed.statusCode, 200);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.equal(changed.json().profile.displayName, 'After');
  displayName = 'Alice';
});

test('a valid Session cannot add fields or change public cache bytes', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/api/v1/profiles/alice?limit=1' });
  const client = await issueTestSession({
    factory, subject: 'profile-viewer', handle: 'viewer',
  });
  const member = await app.inject({
    method: 'GET', url: '/api/v1/profiles/alice?limit=1', headers: { cookie: client.cookie },
  });
  assert.equal(member.statusCode, 200);
  assert.equal(member.body, anonymous.body);
  assert.equal(member.headers.etag, anonymous.headers.etag);
  assert.equal(member.headers['cache-control'], anonymous.headers['cache-control']);
  assert.doesNotMatch(member.headers.vary ?? '', /cookie/iu);
});

test('strictly validates Accept, canonical query, raw conditional headers, and path encoding', async () => {
  const cases: ReadonlyArray<readonly [string, number, string]> = [
    ['/api/v1/profiles/alice?unknown=1', 400, 'invalid_query'],
    ['/api/v1/profiles/alice?limit=', 400, 'invalid_query'],
    ['/api/v1/profiles/alice?cursor=', 400, 'invalid_query'],
    ['/api/v1/profiles/alice?limit=01', 400, 'invalid_query'],
    ['/api/v1/profiles/alice?limit=101', 400, 'invalid_query'],
    ['/api/v1/profiles/alice?limit=1&limit=2', 400, 'invalid_query'],
    ['/api/v1/profiles/alice?cursor=not-a-signed-cursor', 400, 'invalid_cursor'],
    // FIX-L-004: a malformed URL on a profile path now shares the unified
    // invalid_request envelope instead of the old profile-specific 404.
    ['/api/v1/profiles/%', 400, 'invalid_request'],
    ['/api/v1/profiles/%2F', 404, 'resource_not_found'],
  ];
  for (const [url, status, code] of cases) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, status, url);
    assert.equal(response.json().error.code, code, url);
    assert.match(response.headers['content-type'] ?? '', /application\/json/iu);
  }

  for (const accept of ['text/html', 'application/json;q=0', 'application/json;version=1.1.0']) {
    const response = await app.inject({ method: 'GET', url: '/api/v1/profiles/alice', headers: { accept } });
    assert.equal(response.statusCode, 406, accept);
    assert.equal(response.json().error.code, 'not_acceptable');
  }
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const duplicateConditional = await rawRequest(origin, {
    'If-None-Match': ['"first"', '"second"'],
  });
  assert.equal(duplicateConditional.statusCode, 400);
  assert.equal(JSON.parse(duplicateConditional.body).error.code, 'invalid_request');

  const duplicateAccept = await rawRequest(origin, {
    Accept: ['application/json', '*/*'],
  });
  assert.equal(duplicateAccept.statusCode, 400);
  assert.equal(JSON.parse(duplicateAccept.body).error.code, 'invalid_request');

  const malformedConditional = await app.inject({
    method: 'GET', url: '/api/v1/profiles/alice', headers: { 'if-none-match': 'not-an-entity-tag' },
  });
  assert.equal(malformedConditional.statusCode, 400);
  assert.equal(malformedConditional.json().error.code, 'invalid_request');
});

test('missing and concealed Profiles share the same external 404 shape', async () => {
  const unknown = await app.inject({ method: 'GET', url: '/api/v1/profiles/unknown' });
  profileExists = false;
  try {
    const concealed = await app.inject({ method: 'GET', url: '/api/v1/profiles/alice' });
    assert.equal(unknown.statusCode, 404);
    assert.equal(concealed.statusCode, 404);
    assert.deepEqual(
      { ...unknown.json().error, requestId: '<request>' },
      { ...concealed.json().error, requestId: '<request>' },
    );
  } finally {
    profileExists = true;
  }
});

test('restrict_publication 404s public profile before a stale 304', async () => {
  const first = await app.inject({ method: 'GET', url: '/api/v1/profiles/alice?limit=1' });
  assert.equal(first.statusCode, 200);
  const restricted = buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    publicProfileQuery: composePublicProfileProjection({
      ...query,
      accountControl: {
        async accountControl() { return { restrictPublication: true }; },
      },
    }),
    exploreDirectoryRateLimiter: createMemorySearchRateLimiter({
      anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
    }),
  });
  try {
    const blocked = await restricted.inject({
      method: 'GET', url: '/api/v1/profiles/alice?limit=1',
      headers: { 'if-none-match': String(first.headers.etag ?? '') },
    });
    assert.notEqual(blocked.statusCode, 304);
    assert.equal(blocked.statusCode, 404);
    assert.equal(blocked.json().profile, undefined);
  } finally {
    await restricted.close();
  }
});

function assertVary(value: string | undefined, expected: readonly string[]): void {
  const actual = new Set((value ?? '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean));
  for (const field of expected) assert.ok(actual.has(field.toLowerCase()), `Vary is missing ${field}: ${value}`);
}

async function rawRequest(
  origin: string,
  headers: Readonly<Record<string, string | readonly string[]>>,
): Promise<{ readonly statusCode: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/v1/profiles/alice`, {
      method: 'GET',
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}
