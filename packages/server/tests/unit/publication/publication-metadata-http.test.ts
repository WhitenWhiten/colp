import assert from 'node:assert/strict';
import { createPublicationRepresentationEtag } from '@know-n/colp/server';
import { afterAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import type { PublicationMetadataRecord } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';

let current = record();
beforeEach(() => {
  current = record();
});
const now = new Date('2026-07-24T00:00:00Z');
const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example', LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});
const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(now));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
const app = buildApiApp({
  config,
  identityUnitOfWork,
  browserSessionAuthority: factory.authority,
  publicationMetadataQuery: {
    reads: { async load() { return current; } },
    origin: 'https://known.example',
    now: () => now,
  },
  exploreDirectoryRateLimiter: createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  }),
});
afterAll(() => app.close());

test('serves Metadata GET/HEAD/304 with canonical links and public cache', async () => {
  const first = await app.inject({
    method: 'GET', url: '/colp/v0.1/collections/collection-1',
    headers: { accept: 'application/vnd.collection-protocol.collection+json;version=0.1' },
  });
  assert.equal(first.statusCode, 200);
  assert.match(first.headers['content-type'] ?? '', /^application\/vnd\.collection-protocol\.collection\+json;version=0\.1/u);
  assert.match(first.headers['cache-control'] ?? '', /public/u);
  assertVary(first.headers.vary);
  assert.match(first.headers.link ?? '', /rel="https:\/\/know-n\.com\/colp\/rels\/snapshot"/u);
  assert.equal(first.json().collection.id, 'collection-1');
  assert.equal(first.headers.etag, createPublicationRepresentationEtag({
    representation: Buffer.from(first.rawPayload),
    revision: 'c1.p1',
    projectionKey: 'anonymous-public-metadata',
    queryContract: 'none',
    query: {},
    negotiatedMediaType: 'application/vnd.collection-protocol.collection+json;version=0.1',
    protocolVersion: '0.1',
  }));
  const head = await app.inject({ method: 'HEAD', url: '/colp/v0.1/collections/collection-1' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers.etag, first.headers.etag);
  assert.equal(head.headers['content-length'], first.headers['content-length']);
  assert.equal(head.headers.link, first.headers.link);
  assertVary(head.headers.vary);
  const cached = await app.inject({
    method: 'GET', url: '/colp/v0.1/collections/collection-1',
    headers: { 'if-none-match': first.headers.etag! },
  });
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.body, '');
  assert.equal(cached.headers.link, first.headers.link);
  assertVary(cached.headers.vary);

  // FIX-L-020: a stale or unrelated validator never suppresses the body —
  // only an actual match may answer 304 (PUB-R13).
  for (const validator of ['"stale-validator"', '"unrelated", "also-unrelated"']) {
    const staleGet = await app.inject({
      method: 'GET', url: '/colp/v0.1/collections/collection-1',
      headers: { 'if-none-match': validator },
    });
    assert.equal(staleGet.statusCode, 200, validator);
    assert.equal(staleGet.body, first.body, validator);
    assert.equal(staleGet.headers.etag, first.headers.etag, validator);
    assert.equal(staleGet.headers['content-length'], first.headers['content-length'], validator);
    const staleHead = await app.inject({
      method: 'HEAD', url: '/colp/v0.1/collections/collection-1',
      headers: { 'if-none-match': validator },
    });
    assert.equal(staleHead.statusCode, 200, validator);
    assert.equal(staleHead.body, '', validator);
    assert.equal(staleHead.headers.etag, first.headers.etag, validator);
    assert.equal(staleHead.headers['content-length'], first.headers['content-length'], validator);
  }

  current = record({ title: 'Collection changed by one byte' });
  const changed = await app.inject({ method: 'GET', url: '/colp/v0.1/collections/collection-1' });
  assert.notEqual(changed.headers.etag, first.headers.etag);
});

test('returns retained 410 only at the original canonical URL and conceals unsafe locators', async () => {
  const colp = {
    accept: 'application/vnd.collection-protocol.collection+json;version=0.1',
    'collection-protocol-version': '0.1',
  };
  current = record({ deletedAt: '2026-07-01T00:00:01.000Z' });
  const metadata = await app.inject({ method: 'GET', url: '/colp/v0.1/collections/collection-1' });
  assert.equal(metadata.statusCode, 404);
  const gone = await app.inject({ method: 'GET', url: '/c/collection', headers: colp });
  assert.equal(gone.statusCode, 410);
  assert.match(gone.headers['content-type'] ?? '', /^application\/problem\+json/u);
  assert.equal(gone.json().code, 'https://know-n.com/colp/problems/collection-deleted');
  assert.equal(gone.headers.link, undefined);
  assertVary(gone.headers.vary);
  const goneHead = await app.inject({ method: 'HEAD', url: '/c/collection', headers: colp });
  assert.equal(goneHead.statusCode, 410);
  assert.equal(goneHead.body, '');
  assert.equal(goneHead.headers.link, undefined);
  assert.equal(goneHead.headers['content-length'], gone.headers['content-length']);
  assertVary(goneHead.headers.vary);
  current = record({ deletedAt: '2026-06-24T00:00:00.000Z' });
  const expired = await app.inject({ method: 'GET', url: '/c/collection', headers: colp });
  assert.equal(expired.statusCode, 404);
  current = record({ visibility: 'private', deletedAt: '2026-07-01T00:00:01.000Z' });
  const concealed = await app.inject({ method: 'GET', url: '/c/collection', headers: colp });
  assert.equal(concealed.statusCode, 404);
  current = record({ publicationSlug: null, deletedAt: '2026-07-01T00:00:01.000Z' });
  const unpublished = await app.inject({ method: 'GET', url: '/c/collection', headers: colp });
  assert.equal(unpublished.statusCode, 404);
});

test('strictly negotiates Metadata media and protocol versions with complete problem Vary', async () => {
  for (const [accept, status] of [
    ['application/vnd.collection-protocol.collection+json;version=0.1', 200],
    ['application/*;q=0, */*;q=1', 406],
    ['application/vnd.collection-protocol.collection+json;q="1"', 406],
    ['application/vnd.collection-protocol.collection+json;q=0.1234', 406],
    ['application/vnd.collection-protocol.collection+json;version=9.9, */*;q=0.5', 200],
    ['application/vnd.collection-protocol.collection+json;version="0.1"', 200],
    ['application/vnd.collection-protocol.collection+json;q=1;q=0', 406],
    ['application/vnd.collection-protocol.collection+json;q=0, application/json;q=1', 406],
    ['application/json;q=1, application/*;q=0', 406],
    ['application/*;q=0, application/json;q=1', 406],
    ['application/json;q=1, */*;q=0', 406],
    ['application/json;q=0', 406],
    ['application/json;q=1, application/*;q=1', 200],
  ] as const) {
    const response = await app.inject({
      method: 'GET', url: '/colp/v0.1/collections/collection-1',
      headers: { accept, cookie: 'known_session=invalid', authorization: 'Bearer ignored' },
    });
    assert.equal(response.statusCode, status, accept);
    assertVary(response.headers.vary);
  }
  const version = await app.inject({
    method: 'GET', url: '/colp/v0.1/collections/collection-1',
    headers: { 'collection-protocol-version': '9.9' },
  });
  assert.equal(version.statusCode, 406);
  assertVary(version.headers.vary);
});

test('serves private Metadata only to its member with a private cache partition', async () => {
  const client = await issueTestSession({
    factory,
    subject: 'metadata-member',
    handle: 'metadata-member',
  });
  current = record({ visibility: 'private', ownerSubjectId: client.subjectId });
  try {
    const member = await app.inject({
      method: 'GET',
      url: '/colp/v0.1/collections/collection-1',
      headers: { cookie: client.cookie },
    });
    assert.equal(member.statusCode, 200);
    assert.match(member.headers['cache-control'] ?? '', /private/u);
    assert.match(member.headers.vary ?? '', /Cookie/iu);

    const anonymous = await app.inject({ method: 'GET', url: '/colp/v0.1/collections/collection-1' });
    assert.equal(anonymous.statusCode, 404);
  } finally {
    current = record();
  }
});

test('uses the final projection for cache policy and partitions invalid credentials', async () => {
  const client = await issueTestSession({
    factory,
    subject: 'metadata-outsider',
    handle: 'metadata-outsider',
  });
  const outsider = await app.inject({
    method: 'GET', url: '/colp/v0.1/collections/collection-1', headers: { cookie: client.cookie },
  });
  assert.equal(outsider.statusCode, 200);
  assert.match(outsider.headers['cache-control'] ?? '', /public/u);
  assertVary(outsider.headers.vary);

  current = record({ ownerSubjectId: client.subjectId });
  try {
    const member = await app.inject({
      method: 'GET', url: '/colp/v0.1/collections/collection-1', headers: { cookie: client.cookie },
    });
    assert.equal(member.statusCode, 200);
    assert.match(member.headers['cache-control'] ?? '', /private/u);
    assert.notEqual(member.headers.etag, outsider.headers.etag);
  } finally {
    current = record();
  }

  const invalid = await app.inject({
    method: 'GET', url: '/colp/v0.1/collections/collection-1',
    headers: { cookie: 'known_session=invalid', authorization: 'Bearer invalid' },
  });
  assert.equal(invalid.statusCode, 200);
  assert.match(invalid.headers['cache-control'] ?? '', /public/u);
  assertVary(invalid.headers.vary);
});

function assertVary(value: string | undefined): void {
  const names = new Set((value ?? '').split(',').map((name) => name.trim().toLowerCase()));
  for (const expected of ['accept', 'collection-protocol-version', 'cookie', 'authorization']) {
    assert.equal(names.has(expected), true, `Vary is missing ${expected}: ${value}`);
  }
}

function record(overrides: Partial<PublicationMetadataRecord> = {}): PublicationMetadataRecord {
  return {
    id: 'collection-1', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Collection', summary: null,
    visibility: 'public', publicationSlug: 'collection', rootNodeId: 'root-1', rootAvailable: true, contentRevision: 'c1',
    policyRevision: 'p1', tags: [], language: null, membershipRole: null,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
    deletedAt: null, ...overrides,
  };
}
