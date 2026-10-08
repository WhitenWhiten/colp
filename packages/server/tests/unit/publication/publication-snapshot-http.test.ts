import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createPublicationRepresentationEtag,
  PUBLICATION_SNAPSHOT_MEDIA_TYPE,
} from '@know-n/colp/server';
import { afterAll, beforeEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createPublicationCursorKeyring,
  PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
  PUBLICATION_RELATION_COMPARATOR_VERSION,
  type PublicationAnnotationRecord,
  type PublicationCollectionRecord,
  type PublicationNodeRecord,
  type PublicationRelationRecord,
  type PublicationSnapshotQueryPorts,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';
import { publicationAnnotation } from '../../fixtures/phase2/publication-annotations.js';

const instant = '2026-07-24T00:00:00.000Z';
let visibility: PublicationCollectionRecord['visibility'] = 'public';
let authorizedSubjectId = 'owner';
const collection = (): PublicationCollectionRecord => ({
  id: 'collection-1', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Published', summary: null,
  visibility, publicationSlug: 'published', rootNodeId: 'root-1', contentRevision: 'c1',
  policyRevision: 'p1', createdAt: instant, updatedAt: instant, deletedAt: null,
});
const node = (id: string): PublicationNodeRecord => ({
  id, collectionId: 'collection-1', parentId: 'root-1', kind: 'bookmark', isRoot: false,
  title: id, url: `https://example.test/${id}`, description: null, tags: [], visibility: 'inherit',
  ancestorRestricted: false, position: id.toUpperCase(), resourceRevision: `rev-${id}`,
  createdAt: instant, updatedAt: instant,
});
const root: PublicationNodeRecord = {
  ...node('root-1'), parentId: null, kind: 'folder', isRoot: true, url: null, position: null, title: 'Root',
};
const records = [node('a'), node('b'), node('d')];
let annotationRecords: PublicationAnnotationRecord[] = [];
let relationRecords: PublicationRelationRecord[] = [];
beforeEach(() => {
  visibility = 'public';
  authorizedSubjectId = 'owner';
  annotationRecords = [];
  relationRecords = [];
});
const cursors = createPublicationCursorKeyring({
  active: { id: 'http-v1', secret: Buffer.alloc(32, 19).toString('base64') }, retained: [],
});
const ports: PublicationSnapshotQueryPorts = {
  cursors,
  origin: 'https://known.example',
  // P4A-R06: deny-by-default exposure gate over logical blob facts; no blobs in this unit harness.
  sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
  accessPolicy: {
    async loadCollectionFacts() {
      return {
        collectionId: 'collection-1', ownerSubjectId: authorizedSubjectId, visibility,
        policyRevision: 'p1', membershipRole: null, deleted: false,
      };
    },
  },
  reads: {
    async loadPage(request) {
      const start = request.afterLocator
        ? records.findIndex((item) => locator(item.id) === request.afterLocator) + 1
        : 0;
      return {
        isolation: 'repeatable read', comparatorVersion: 'parent-position-id-v1',
        collection: collection(), root, candidates: records.slice(start, start + request.limit + 1),
      };
    },
  },
  annotations: {
    async loadPage(request) {
      return {
        isolation: 'repeatable read', comparatorVersion: PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
        contentRevision: 'c1', policyRevision: 'p1',
        candidates: annotationRecords.slice(0, request.limit + 1),
      };
    },
  },
  relations: {
    async loadPage(request) {
      return {
        isolation: 'repeatable read', comparatorVersion: PUBLICATION_RELATION_COMPARATOR_VERSION,
        contentRevision: 'c1', policyRevision: 'p1', candidates: relationRecords.slice(0, request.limit + 1),
      };
    },
  },
};
const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example',
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});
const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(instant));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
const app = buildApiApp({
  config, identityUnitOfWork, browserSessionAuthority: factory.authority, publicationSnapshotQuery: ports,
  exploreDirectoryRateLimiter: createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  }),
});

afterAll(async () => {
  cursors.destroy();
  await app.close();
});

test('serves validated GET/HEAD pages with final-byte ETag, cache, next Link, and 304', async () => {
  const url = '/colp/v0.1/collections/collection-1/snapshot?root=root-1&depth=1&include=relations&include=annotations&limit=2';
  const first = await app.inject({
    method: 'GET', url,
    headers: {
      accept: 'application/vnd.collection-protocol.snapshot+json;version="0.1";note="quoted;parameter"',
      'collection-protocol-version': '0.1',
    },
  });
  assert.equal(first.statusCode, 200);
  assert.match(first.headers['content-type'] ?? '', /^application\/vnd\.collection-protocol\.snapshot\+json;version=0\.1/u);
  assert.match(first.headers['cache-control'] ?? '', /public/u);
  // FIX-L-013: even anonymous responses must declare Cookie/Authorization so a
  // shared cache revalidates before serving the public projection to a member.
  assertVary(first.headers.vary, ['Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization']);
  assert.match(first.headers.etag ?? '', /^"[^"]+"$/u);
  assert.match(first.headers.link ?? '', /rel="next"/u);
  assert.deepEqual(first.json().nodes.map((item: { id: string }) => item.id), ['root-1', 'a']);
  const firstBody = first.json() as {
    revision: string;
    snapshotId: string;
    page: { sequence: number };
  };
  const expectedEtag = createPublicationRepresentationEtag({
    representation: first.rawPayload,
    revision: firstBody.revision,
    projectionKey: 'anonymous-public',
    principalScope: 'anonymous:collection-1',
    queryContract: 'snapshotQuery',
    query: { root: 'root-1', depth: 1, include: ['relations', 'annotations'], limit: 2 },
    negotiatedMediaType: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};version=0.1`,
    protocolVersion: '0.1',
    snapshotIdentity: { snapshotId: firstBody.snapshotId, sequence: firstBody.page.sequence },
    pageIdentity: { pageNumber: firstBody.page.sequence },
  });
  assert.equal(first.headers.etag, expectedEtag);
  const mutatedBytes = Buffer.from(first.rawPayload);
  mutatedBytes[mutatedBytes.length - 2] ^= 1;
  assert.notEqual(createPublicationRepresentationEtag({
    representation: mutatedBytes,
    revision: firstBody.revision,
    projectionKey: 'anonymous-public',
    principalScope: 'anonymous:collection-1',
    queryContract: 'snapshotQuery',
    query: { root: 'root-1', depth: 1, include: ['relations', 'annotations'], limit: 2 },
    negotiatedMediaType: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};version=0.1`,
    protocolVersion: '0.1',
    snapshotIdentity: { snapshotId: firstBody.snapshotId, sequence: firstBody.page.sequence },
    pageIdentity: { pageNumber: firstBody.page.sequence },
  }), first.headers.etag);

  const head = await app.inject({
    method: 'HEAD', url,
    headers: { accept: '*/*', 'collection-protocol-version': '0.1' },
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers.etag, first.headers.etag);
  assert.equal(head.headers.link, first.headers.link);
  assert.equal(head.headers['content-length'], first.headers['content-length']);
  assertVary(head.headers.vary, ['Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization']);

  const notModified = await app.inject({
    method: 'GET', url,
    headers: { 'if-none-match': `W/${first.headers.etag}`, 'collection-protocol-version': '0.1' },
  });
  assert.equal(notModified.statusCode, 304);
  assert.equal(notModified.body, '');
  assert.equal(notModified.headers.etag, first.headers.etag);
  assert.equal(notModified.headers.link, first.headers.link);
  assertVary(notModified.headers.vary, ['Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization']);

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

  const target = /<([^>]+)>/u.exec(first.headers.link ?? '')?.[1];
  assert.ok(target);
  const next = new URL(target);
  assert.equal(next.origin, 'https://known.example');
  assert.equal(next.pathname, '/colp/v0.1/collections/collection-1/snapshot');
  assert.equal(next.searchParams.get('root'), 'root-1');
  assert.equal(next.searchParams.get('depth'), '1');
  assert.deepEqual(next.searchParams.getAll('include'), ['annotations', 'relations']);
  assert.equal(next.searchParams.get('limit'), '2');
  assert.match(next.searchParams.get('pageCursor') ?? '', /^psc1\./u);
  assert.equal(next.searchParams.size, 6);
  const second = await app.inject({ method: 'GET', url: `${next.pathname}${next.search}` });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json().nodes.map((item: { id: string }) => item.id), ['b', 'd']);
  assert.equal(second.headers.link, undefined);
});

test('canonicalizes combined include order, rejects duplicates, and changes ETag with Relation bytes', async () => {
  const first = await app.inject({
    method: 'GET',
    url: '/colp/v0.1/collections/collection-1/snapshot?include=relations&include=annotations&limit=20',
    headers: { accept: '*/*', 'collection-protocol-version': '0.1' },
  });
  const reordered = await app.inject({
    method: 'GET',
    url: '/colp/v0.1/collections/collection-1/snapshot?include=annotations&include=relations&limit=20',
    headers: { accept: '*/*', 'collection-protocol-version': '0.1' },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(reordered.statusCode, 200);
  assert.equal(first.headers.etag, reordered.headers.etag);
  assert.deepEqual(first.json(), reordered.json());

  const duplicate = await app.inject({
    method: 'GET',
    url: '/colp/v0.1/collections/collection-1/snapshot?include=annotations&include=relations&include=relations&limit=20',
    headers: { accept: '*/*', 'collection-protocol-version': '0.1' },
  });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.json().code, 'invalid_query');

  const payload = {
    id: 'relation-http', collectionId: 'collection-1', type: 'related' as const,
    fromNodeId: 'a', toNodeId: 'b', label: 'HTTP relation', visibility: 'public' as const,
    revision: 'relation-http-revision', createdAt: instant, updatedAt: instant,
  };
  relationRecords = [{
    id: payload.id, collectionId: payload.collectionId, fromNodeId: payload.fromNodeId,
    toNodeId: payload.toNodeId, visibility: payload.visibility, payload,
    fromVisibility: 'inherit', toVisibility: 'inherit', fromAncestorRestricted: false,
    toAncestorRestricted: false, fromAuthorized: true, toAuthorized: true, deletedAt: null,
    fromAncestorVisibility: null, toAncestorVisibility: null,
  }];
  const changed = await app.inject({
    method: 'GET',
    url: '/colp/v0.1/collections/collection-1/snapshot?include=annotations&include=relations&limit=20',
    headers: { accept: '*/*', 'collection-protocol-version': '0.1' },
  });
  assert.equal(changed.statusCode, 200);
  assert.deepEqual(changed.json().relations.map((row: { id: string }) => row.id), ['relation-http']);
  assert.notEqual(changed.headers.etag, first.headers.etag);
});

test('computes HTTP bytes and ETag after authorized Annotation projection and redaction', async () => {
  annotationRecords = [publicationAnnotation('http-annotation', {
    subjectId: 'a',
    payload: {
      ...publicationAnnotation('http-annotation').payload,
      subject: { type: 'node', id: 'a' },
      provenance: {
        kind: 'ai', provider: 'internal-http-provider', model: 'internal-http-model',
        generatedAt: instant,
      },
    },
  })];
  try {
    const included = await app.inject({
      method: 'GET',
      url: '/colp/v0.1/collections/collection-1/snapshot?include=annotations&limit=10',
    });
    assert.equal(included.statusCode, 200, included.body);
    assert.deepEqual(included.json().annotations.map((row: { id: string }) => row.id), ['http-annotation']);
    assert.deepEqual(included.json().annotations[0].creator, {
      id: 'https://known.example/profiles/creator', name: 'Public Creator',
    });
    assert.equal(included.body.includes('account-creator'), false);
    assert.equal(included.body.includes('internal-http-provider'), false);
    assert.equal(included.body.includes('internal-http-model'), false);

    const omitted = await app.inject({
      method: 'GET', url: '/colp/v0.1/collections/collection-1/snapshot?limit=10',
    });
    assert.equal(omitted.statusCode, 200);
    assert.deepEqual(omitted.json().annotations, []);
    assert.notEqual(included.headers.etag, omitted.headers.etag);
    assert.notEqual(included.rawPayload.equals(omitted.rawPayload), true);
  } finally {
    annotationRecords = [];
  }
});

test('returns COLP Problems for negotiation, query, cursor, expiry, and concealment failures', async () => {
  const cases = [
    { url: '/colp/v0.1/collections/collection-1/snapshot?unknown=x', status: 400, code: 'invalid_query' },
    { url: '/colp/v0.1/collections/collection-1/snapshot?limit=2&limit=3', status: 400, code: 'invalid_query' },
    { url: '/colp/v0.1/collections/collection-1/snapshot?pageCursor=editor.cursor', status: 400, code: 'invalid_cursor_scope' },
  ];
  for (const entry of cases) {
    const response = await app.inject({ method: 'GET', url: entry.url });
    assert.equal(response.statusCode, entry.status);
    assert.match(response.headers['content-type'] ?? '', /^application\/problem\+json/u);
    assert.equal(response.json().code, entry.code);
  }

  const repeatedInclude = await app.inject({
    method: 'GET',
    url: '/colp/v0.1/collections/collection-1/snapshot?limit=2&include=relations&include=annotations',
  });
  assert.equal(repeatedInclude.statusCode, 200);

  const unsupported = await app.inject({
    method: 'GET', url: '/colp/v0.1/collections/collection-1/snapshot',
    headers: { accept: 'application/vnd.collection-protocol.snapshot+json;version=9.9' },
  });
  assert.equal(unsupported.statusCode, 406);
  assert.equal(unsupported.json().code, 'unsupported_version');

  const negotiationCases = [
    { headers: { accept: '*/*;q=0' }, status: 406 },
    { headers: { accept: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};q=wat` }, status: 406 },
    { headers: { accept: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};q="0.5"` }, status: 406 },
    { headers: { accept: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};version="0.1` }, status: 406 },
    { headers: { accept: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};q=0.5;q=0.8` }, status: 406 },
    { headers: { accept: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};version=0.1;version=0.2` }, status: 406 },
    { headers: { accept: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};version="0.1";note="a;b"` }, status: 200 },
    { headers: { accept: `*/*;q=0, ${PUBLICATION_SNAPSHOT_MEDIA_TYPE};Q=1.000` }, status: 200 },
    { headers: { accept: 'application/*' }, status: 200 },
    { headers: { accept: 'application/json' }, status: 200 },
    { headers: { accept: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};q=0, */*;q=1` }, status: 406 },
    { headers: { accept: 'application/*;q=0, */*;q=1' }, status: 406 },
    { headers: { accept: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};version=9.9, application/*;q=1` }, status: 200 },
    { headers: { 'collection-protocol-version': '0.1' }, status: 200 },
    { headers: { 'collection-protocol-version': '9.9' }, status: 406 },
    { headers: { 'collection-protocol-version': '0.1, 0.1' }, status: 400 },
  ] as const;
  for (const entry of negotiationCases) {
    const response = await app.inject({
      method: 'GET', url: '/colp/v0.1/collections/collection-1/snapshot', headers: entry.headers,
    });
    assert.equal(response.statusCode, entry.status, JSON.stringify(entry.headers));
    if (entry.status !== 200) {
      assert.equal(response.json().code, entry.status === 400 ? 'invalid_query' : 'unsupported_version');
      assertVary(response.headers.vary, ['Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization']);
    }
  }

  const first = await app.inject({ method: 'GET', url: '/colp/v0.1/collections/collection-1/snapshot?limit=2' });
  const cursor = new URL(/<([^>]+)>/u.exec(first.headers.link ?? '')![1]!).searchParams.get('pageCursor')!;
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
  const expired = await app.inject({
    method: 'GET', url: `/colp/v0.1/collections/collection-1/snapshot?limit=2&pageCursor=${tampered}`,
  });
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.json().code, 'snapshot_expired');

  visibility = 'private';
  try {
    const concealed = await app.inject({ method: 'GET', url: '/colp/v0.1/collections/collection-1/snapshot' });
    assert.equal(concealed.statusCode, 404);
    assert.equal(concealed.json().code, 'resource_not_found');
  } finally {
    visibility = 'public';
  }
});

test('keeps route and framework Snapshot Problems GET/HEAD equivalent and varies on request inputs', async () => {
  for (const url of [
    '/colp/v0.1/collections/collection-1/snapshot?unknown=x',
    '/colp/v0.1/collections/collection-1/snapshot?limit=not-an-integer',
    '/colp/v0.1/collections/collection-1/snapshot?pageCursor=editor.cursor',
  ]) {
    const headers = {
      accept: '*/*;q=0.5',
      authorization: 'Bearer opaque',
      cookie: 'session=opaque',
      origin: 'https://client.example',
      'collection-protocol-version': '0.1',
    };
    const get = await app.inject({ method: 'GET', url, headers });
    const head = await app.inject({ method: 'HEAD', url, headers });
    assert.equal(head.statusCode, get.statusCode);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['cache-control'], get.headers['cache-control']);
    assert.equal(head.headers['content-length'], String(Buffer.byteLength(get.body, 'utf8')));
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assertVary(get.headers.vary, [
      'Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization', 'Origin',
    ]);
    assertVary(head.headers.vary, [
      'Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization', 'Origin',
    ]);
  }
});

test('uses the same member authorization and private cache partition as Metadata', async () => {
  const client = await issueTestSession({
    factory,
    subject: 'snapshot-member',
    handle: 'snapshot-member',
  });
  visibility = 'private';
  authorizedSubjectId = client.subjectId;
  try {
    const member = await app.inject({
      method: 'GET',
      url: '/colp/v0.1/collections/collection-1/snapshot',
      headers: { cookie: client.cookie },
    });
    assert.equal(member.statusCode, 200);
    assert.match(member.headers['cache-control'] ?? '', /private/u);
    assert.match(member.headers.vary ?? '', /Cookie/iu);

    const anonymous = await app.inject({
      method: 'GET', url: '/colp/v0.1/collections/collection-1/snapshot',
    });
    assert.equal(anonymous.statusCode, 404);
  } finally {
    visibility = 'public';
    authorizedSubjectId = 'owner';
  }
});

describe('FIX-L-019: Accept media range specificity outranks the application/json product alias', () => {
  const cases = [
    { accept: 'application/json;q=1, application/*;q=0', status: 406 },
    { accept: 'application/*;q=0, application/json;q=1', status: 406 },
    { accept: 'application/json;q=1, */*;q=0', status: 406 },
    { accept: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};q=0, application/json;q=1`, status: 406 },
    { accept: 'application/json;q=0', status: 406 },
    { accept: 'application/json', status: 200 },
    { accept: 'application/json;q=1, application/*;q=1', status: 200 },
    { accept: 'application/json;q=0, application/*;q=1', status: 200 },
  ] as const;
  for (const entry of cases) {
    test(`treats Accept: ${entry.accept} as ${entry.status}`, async () => {
      const response = await app.inject({
        method: 'GET', url: '/colp/v0.1/collections/collection-1/snapshot',
        headers: { accept: entry.accept },
      });
      assert.equal(response.statusCode, entry.status, entry.accept);
      if (entry.status !== 200) {
        assert.equal(response.json().code, 'unsupported_version', entry.accept);
        assertVary(response.headers.vary, ['Accept', 'Collection-Protocol-Version', 'Cookie', 'Authorization']);
      }
    });
  }
});

function locator(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32);
}

function assertVary(value: string | string[] | undefined, expected: readonly string[]): void {
  const actual = new Set((Array.isArray(value) ? value : [value ?? ''])
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean));
  for (const name of expected) assert.ok(actual.has(name.toLowerCase()), `Vary is missing ${name}: ${String(value)}`);
}
