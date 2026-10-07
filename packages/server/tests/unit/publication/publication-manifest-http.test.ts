import assert from 'node:assert/strict';
import {
  createPublicationRepresentationEtag,
  PUBLICATION_MANIFEST_MEDIA_TYPE,
} from '@know-n/colp/server';
import { afterAll, afterEach, test } from 'vitest';
import Fastify from 'fastify';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { validateManifestSemantics } from '@know-n/colp/semantic';
import type {
  CollectionDirectory,
  CollectionMetadata,
  Manifest,
  Snapshot,
} from '@know-n/colp/types';
import { loadConfig } from '../../support/test-config.js';
import {
  createPublicationCursorKeyring,
  type PublicationCollectionRecord,
  type PublicationDirectoryQueryPorts,
  type PublicationDirectoryRecord,
  type PublicationMetadataQueryPorts,
  type PublicationMetadataRecord,
  type PublicationNodeRecord,
  type PublicationSnapshotQueryPorts,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { registerPublicationManifestRoutes } from '../../../src/transport/product/publication-manifest-routes.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example',
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});
const instant = '2026-07-24T00:00:00.000Z';
const collection: PublicationCollectionRecord = {
  id: 'collection-1', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Published collection',
  summary: null, visibility: 'public', publicationSlug: 'published-collection', rootNodeId: 'root-1',
  contentRevision: 'c1', policyRevision: 'p1', createdAt: instant, updatedAt: instant, deletedAt: null,
};
const root: PublicationNodeRecord = {
  id: 'root-1', collectionId: collection.id, parentId: null, kind: 'folder', isRoot: true,
  title: 'Root', url: null, description: null, tags: [], visibility: 'inherit', ancestorRestricted: false,
  position: null, resourceRevision: 'root-r1', createdAt: instant, updatedAt: instant,
};
const directoryRecord: PublicationDirectoryRecord = {
  id: collection.id, ownerSubjectId: collection.ownerSubjectId, title: collection.title, summary: null,
  kind: collection.kind, visibility: 'public', publicationSlug: collection.publicationSlug!, tags: [],
  language: null, nodeCount: 1, updatedAt: instant,
  orderingUpdatedAtMicros: String(BigInt(Date.parse(instant)) * 1000n), protectedAuthorized: false,
};
const metadataRecord: PublicationMetadataRecord = {
  ...collection, rootAvailable: true, tags: [], language: null, membershipRole: null,
};
const cursors = createPublicationCursorKeyring({
  active: { id: 'manifest-http-v1', secret: Buffer.alloc(32, 41).toString('base64') }, retained: [],
});
const queries: {
  readonly publicationDirectoryQuery: PublicationDirectoryQueryPorts;
  readonly publicationMetadataQuery: PublicationMetadataQueryPorts;
  readonly publicationSnapshotQuery: PublicationSnapshotQueryPorts;
} = {
  publicationDirectoryQuery: {
    cursors, origin: config.publication.origin,
    reads: {
      async loadPage(input) {
        const exactRequest = input.principal === 'anonymous'
          && Object.keys(input.filter).length === 0
          && input.after === undefined
          && input.limit > 0;
        return exactRequest ? [directoryRecord] : [];
      },
    },
  },
  publicationMetadataQuery: {
    origin: config.publication.origin,
    reads: {
      async load(input: { readonly collectionId?: string; readonly publicationSlug?: string }) {
        return input.collectionId === collection.id || input.publicationSlug === collection.publicationSlug
          ? metadataRecord
          : null;
      },
    },
  },
  publicationSnapshotQuery: {
    cursors, origin: config.publication.origin,
    // P4A-R06: deny-by-default exposure gate over logical blob facts; no blobs in this unit harness.
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
    accessPolicy: {
      async loadCollectionFacts(input) {
        if (input.collectionId !== collection.id || input.actorSubjectId !== 'anonymous') return null;
        return {
          collectionId: collection.id, ownerSubjectId: collection.ownerSubjectId,
          visibility: collection.visibility, policyRevision: collection.policyRevision,
          membershipRole: null, deleted: false,
        };
      },
    },
    reads: {
      async loadPage(input) {
        const available = input.collectionId === collection.id
          && (input.rootId === undefined || input.rootId === root.id);
        return {
          isolation: 'repeatable read' as const,
          comparatorVersion: 'parent-position-id-v1' as const,
          collection: available ? collection : null,
          root: available ? root : null,
          candidates: [],
        };
      },
    },
  },
};
function memoryExploreLimiter() {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  });
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
});

afterAll(() => cursors.destroy());

test('discovers and navigates the exact mounted Directory, Metadata, and Snapshot endpoints', async () => {
  const app = buildApiApp({ config, ...queries, exploreDirectoryRateLimiter: memoryExploreLimiter() });
  apps.push(app);
  const first = await app.inject({
    method: 'GET',
    url: '/.well-known/collection-protocol',
    headers: {
      accept: PUBLICATION_MANIFEST_MEDIA_TYPE,
      'collection-protocol-version': '0.1',
      origin: 'https://known.example',
    },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['content-type'], PUBLICATION_MANIFEST_MEDIA_TYPE);
  assert.equal(first.headers['cache-control'], 'public, max-age=300');
  assert.equal(first.headers.link, '</.well-known/collection-protocol>; rel="collection-protocol"');
  assert.match(first.headers.etag ?? '', /^"[^"]+"$/u);
  // T-PUB-003: retain the first 200 representation (body, ETag, Content-Length,
  // representation headers) as the reference for stale-validator regressions.
  assert.equal(first.headers['content-length'], String(first.rawPayload.length));
  assertVary(first.headers.vary, ['Accept', 'Collection-Protocol-Version', 'Origin']);
  assert.doesNotMatch(first.headers.vary ?? '', /Cookie|Authorization/iu);
  assert.equal(first.headers.etag, createPublicationRepresentationEtag({
    representation: first.rawPayload,
    revision: 'manifest',
    projectionKey: 'manifest-discovery-unclaimed',
    queryContract: 'none',
    query: {},
    negotiatedMediaType: PUBLICATION_MANIFEST_MEDIA_TYPE,
    protocolVersion: '0.1',
  }));
  const changedBytes = Buffer.from(first.rawPayload);
  changedBytes[changedBytes.length - 2] ^= 1;
  assert.notEqual(createPublicationRepresentationEtag({
    representation: changedBytes,
    revision: 'manifest', projectionKey: 'manifest-discovery-unclaimed',
    queryContract: 'none', query: {}, negotiatedMediaType: PUBLICATION_MANIFEST_MEDIA_TYPE,
    protocolVersion: '0.1',
  }), first.headers.etag);

  const manifest = first.json<Manifest>();
  assert.equal(createValidatorRegistry().validate('manifest', manifest).valid, true);
  assert.deepEqual(validateManifestSemantics(manifest), { valid: true, issues: [] });
  const mount = manifest.mounts[0]!;
  assert.equal(mount.baseUrl, 'https://known.example/colp/v0.1/');
  assert.deepEqual(mount.profiles, ['core']);
  assert.deepEqual(mount.endpoints, config.publication.endpoints);
  const directory = await injectAbsolute(app, mount.endpoints.directory!,
    'application/vnd.collection-protocol.catalog+json;version=0.1');
  assert.equal(directory.statusCode, 200);
  assert.match(directory.headers['content-type'] ?? '', /^application\/vnd\.collection-protocol\.catalog\+json;version=0\.1/u);
  const directoryDocument = directory.json<CollectionDirectory>();
  assert.equal(createValidatorRegistry().validate('collectionDirectory', directoryDocument).valid, true);
  const directoryCollection = directoryDocument.collections[0]!;
  assert.equal(directoryCollection.id, collection.id);

  const expectedMetadata = mount.endpoints.collection!.replace('{collectionId}', collection.id);
  assert.equal(directoryCollection.links.self, expectedMetadata);
  const metadata = await injectAbsolute(app, directoryCollection.links.self,
    'application/vnd.collection-protocol.collection+json;version=0.1');
  assert.equal(metadata.statusCode, 200);
  assert.match(metadata.headers['content-type'] ?? '', /^application\/vnd\.collection-protocol\.collection\+json;version=0\.1/u);
  const metadataDocument = metadata.json<CollectionMetadata>();
  assert.equal(createValidatorRegistry().validate('collectionMetadata', metadataDocument).valid, true);
  assert.equal(metadataDocument.collection.id, collection.id);

  const expectedSnapshot = mount.endpoints.snapshot!.replace('{collectionId}', collection.id);
  assert.equal(metadataDocument.links.snapshot, expectedSnapshot);
  assert.equal(directoryCollection.links.snapshot, expectedSnapshot);
  const snapshot = await injectAbsolute(app, metadataDocument.links.snapshot,
    'application/vnd.collection-protocol.snapshot+json;version=0.1');
  assert.equal(snapshot.statusCode, 200);
  assert.match(snapshot.headers['content-type'] ?? '', /^application\/vnd\.collection-protocol\.snapshot\+json;version=0\.1/u);
  const snapshotDocument = snapshot.json<Snapshot>();
  assert.equal(createValidatorRegistry().validate('snapshot', snapshotDocument).valid, true);
  assert.deepEqual(snapshotDocument.nodes.map((node) => node.id), [root.id]);

  const head = await app.inject({
    method: 'HEAD', url: '/.well-known/collection-protocol',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assertRepresentationHeaders(head.headers, first.headers);

  const cached = await app.inject({
    method: 'GET', url: '/.well-known/collection-protocol',
    headers: { 'if-none-match': `W/${first.headers.etag}`, origin: 'https://known.example' },
  });
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.body, '');
  for (const name of ['cache-control', 'content-type', 'etag', 'link', 'vary'] as const) {
    assert.equal(cached.headers[name], first.headers[name]);
  }

  // T-PUB-003: the presence of If-None-Match must not imply 304. A syntactically
  // valid strong ETag (or a list of validators) that does not match the current
  // representation serves the full 200 representation with the current ETag.
  for (const ifNoneMatch of ['"stale-manifest-v0"', '"stale-a", W/"stale-b", "stale-c"'] as const) {
    const stale = await app.inject({
      method: 'GET', url: '/.well-known/collection-protocol',
      headers: { 'if-none-match': ifNoneMatch, origin: 'https://known.example' },
    });
    assert.equal(stale.statusCode, 200, ifNoneMatch);
    assert.equal(stale.body, first.body, ifNoneMatch);
    assert.equal(stale.headers.etag, first.headers.etag, ifNoneMatch);
    assert.equal(stale.headers['content-length'], first.headers['content-length'], ifNoneMatch);
    assert.equal(stale.headers['content-length'], String(stale.rawPayload.length), ifNoneMatch);
    assertRepresentationHeaders(stale.headers, first.headers);

    const staleHead = await app.inject({
      method: 'HEAD', url: '/.well-known/collection-protocol',
      headers: { 'if-none-match': ifNoneMatch, origin: 'https://known.example' },
    });
    assert.equal(staleHead.statusCode, 200, ifNoneMatch);
    assert.equal(staleHead.body, '', ifNoneMatch);
    assertRepresentationHeaders(staleHead.headers, first.headers);
  }

  // Positive control: the current strong ETag (like the weak form above) still
  // short-circuits to 304 for the same representation.
  const current = await app.inject({
    method: 'GET', url: '/.well-known/collection-protocol',
    headers: { 'if-none-match': first.headers.etag, origin: 'https://known.example' },
  });
  assert.equal(current.statusCode, 304);
  assert.equal(current.body, '');
});

test('does not mount discovery until every declared endpoint is mounted', async () => {
  const app = buildApiApp({
    config,
    publicationDirectoryQuery: queries.publicationDirectoryQuery,
    publicationMetadataQuery: queries.publicationMetadataQuery,
    exploreDirectoryRateLimiter: memoryExploreLimiter(),
  });
  apps.push(app);
  const response = await app.inject({ method: 'GET', url: '/.well-known/collection-protocol' });
  assert.equal(response.statusCode, 404);
});

test('strictly negotiates Manifest media and protocol versions with complete Vary', async () => {
  const app = buildApiApp({ config, ...queries, exploreDirectoryRateLimiter: memoryExploreLimiter() });
  apps.push(app);
  for (const [accept, status] of [
    [PUBLICATION_MANIFEST_MEDIA_TYPE, 200],
    ['application/json', 200],
    ['application/*;q=0, */*;q=1', 406],
    ['application/vnd.collection-protocol.manifest+json;q="1"', 406],
    ['application/vnd.collection-protocol.manifest+json;q=0.1234', 406],
    ['application/vnd.collection-protocol.manifest+json;version=9.9, */*;q=0.5', 200],
    ['application/vnd.collection-protocol.manifest+json;version="0.1"', 200],
    ['application/vnd.collection-protocol.manifest+json;q=1;q=0', 406],
    ['application/vnd.collection-protocol.manifest+json,', 406],
    ['application/vnd.collection-protocol.manifest+json;note="unterminated', 406],
  ] as const) {
    const response = await app.inject({
      method: 'GET', url: '/.well-known/collection-protocol', headers: { accept },
    });
    assert.equal(response.statusCode, status, accept);
    assertVary(response.headers.vary, ['Accept', 'Collection-Protocol-Version']);
  }
  const unsupported = await app.inject({
    method: 'GET', url: '/.well-known/collection-protocol',
    headers: {
      accept: PUBLICATION_MANIFEST_MEDIA_TYPE,
      'collection-protocol-version': '9.9',
      origin: 'https://known.example',
      cookie: 'known_session=ignored',
      authorization: 'Bearer ignored',
    },
  });
  assert.equal(unsupported.statusCode, 406);
  assert.equal(unsupported.json().code, 'unsupported_version');
  assertVary(unsupported.headers.vary, ['Accept', 'Collection-Protocol-Version', 'Origin']);
  assert.doesNotMatch(unsupported.headers.vary ?? '', /Cookie|Authorization/iu);
  assert.equal(unsupported.headers['access-control-allow-origin'], 'https://known.example');

  const headProblem = await app.inject({
    method: 'HEAD', url: '/.well-known/collection-protocol',
    headers: { 'collection-protocol-version': '9.9' },
  });
  assert.equal(headProblem.statusCode, 406);
  assert.equal(headProblem.body, '');
  assert.equal(headProblem.headers['content-length'], unsupported.headers['content-length']);
  assertVary(headProblem.headers.vary, ['Accept', 'Collection-Protocol-Version']);

  const queried = await app.inject({
    method: 'GET', url: '/.well-known/collection-protocol?redirect=https://other.example',
  });
  assert.equal(queried.statusCode, 400);
  assert.equal(queried.json().code, 'invalid_query');
  assertVary(queried.headers.vary, ['Accept', 'Collection-Protocol-Version']);
});

test('serves the production COLP 0.2 Manifest representation when effect pages are deployed', async () => {
  const app = Fastify({ logger: false });
  apps.push(app as ReturnType<typeof buildApiApp>);
  const effectTemplate = 'https://known.example/colp/v0.1/sync/effects/{effectId}/pages/{pageNumber}';
  registerPublicationManifestRoutes(app, {
    ...config.publication,
    endpoints: { ...config.publication.endpoints,
      syncSessions: 'https://known.example/colp/v0.1/sync/sessions',
      syncPull: 'https://known.example/colp/v0.1/sync/pull',
      syncEffectPages: effectTemplate },
  });

  const v02 = await app.inject({ method: 'GET', url: '/.well-known/collection-protocol',
    headers: { accept: 'application/vnd.collection-protocol.manifest+json;version=0.2',
      'collection-protocol-version': '0.2' } });
  assert.equal(v02.statusCode, 200);
  assert.equal(v02.headers['content-type'],
    'application/vnd.collection-protocol.manifest+json;version=0.2');
  assert.equal(createValidatorRegistry().validate('manifestV02', v02.json()).valid, true);
  assert.equal(v02.json().syncEffectPages, effectTemplate);
  assert.equal('syncEffectPages' in v02.json().mounts[0].endpoints, false);

  const defaultRepresentation = await app.inject({ method: 'GET',
    url: '/.well-known/collection-protocol' });
  assert.equal(defaultRepresentation.statusCode, 200);
  assert.equal(defaultRepresentation.headers['content-type'], PUBLICATION_MANIFEST_MEDIA_TYPE);
  assert.notEqual(defaultRepresentation.headers.etag, v02.headers.etag);

  // T-PUB-003: validators are representation-scoped; the 0.1 ETag must not
  // short-circuit the 0.2 representation, and vice versa.
  const v02WithV01Validator = await app.inject({
    method: 'GET', url: '/.well-known/collection-protocol',
    headers: {
      accept: 'application/vnd.collection-protocol.manifest+json;version=0.2',
      'collection-protocol-version': '0.2',
      'if-none-match': defaultRepresentation.headers.etag,
    },
  });
  assert.equal(v02WithV01Validator.statusCode, 200);
  assert.equal(v02WithV01Validator.body, v02.body);
  assert.equal(v02WithV01Validator.headers.etag, v02.headers.etag);
  assert.equal(v02WithV01Validator.headers['content-length'], v02.headers['content-length']);

  const v01WithV02Validator = await app.inject({
    method: 'GET', url: '/.well-known/collection-protocol',
    headers: {
      accept: PUBLICATION_MANIFEST_MEDIA_TYPE,
      'collection-protocol-version': '0.1',
      'if-none-match': v02.headers.etag,
    },
  });
  assert.equal(v01WithV02Validator.statusCode, 200);
  assert.equal(v01WithV02Validator.body, defaultRepresentation.body);
  assert.equal(v01WithV02Validator.headers.etag, defaultRepresentation.headers.etag);
  assert.equal(v01WithV02Validator.headers['content-length'], defaultRepresentation.headers['content-length']);
});

test('returns stable COLP 405 Problems and Allow for every unsupported discovery method', async () => {
  const app = buildApiApp({ config, ...queries, exploreDirectoryRateLimiter: memoryExploreLimiter() });
  apps.push(app);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await app.inject({ method, url: '/.well-known/collection-protocol' });
    assert.equal(response.statusCode, 405, method);
    assert.equal(response.json().code, 'method_not_allowed');
    assert.equal(response.headers.allow, 'GET, HEAD');
    assert.match(response.headers['content-type'] ?? '', /^application\/problem\+json/u);
    assertVary(response.headers.vary, ['Accept', 'Collection-Protocol-Version']);
  }
  for (const url of [
    '/colp/v0.1/directory',
    '/colp/v0.1/collections/collection-1',
    '/colp/v0.1/collections/collection-1/snapshot',
  ]) {
    const response = await app.inject({ method: 'POST', url });
    assert.equal(response.statusCode, 405, url);
    assert.equal(response.json().code, 'method_not_allowed');
    assert.equal(response.headers.allow, 'GET, HEAD');
  }
  const missing = await app.inject({ method: 'GET', url: '/colp/v0.1/not-a-route' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, 'resource_not_found');
});

async function injectAbsolute(
  app: ReturnType<typeof buildApiApp>,
  absoluteUrl: string,
  accept: string,
) {
  const target = new URL(absoluteUrl);
  assert.equal(target.origin, config.publication.origin);
  return app.inject({
    method: 'GET', url: `${target.pathname}${target.search}`,
    headers: { accept, 'collection-protocol-version': '0.1' },
  });
}

function assertRepresentationHeaders(
  actual: Readonly<Record<string, string | string[] | undefined>>,
  expected: Readonly<Record<string, string | string[] | undefined>>,
): void {
  for (const name of ['cache-control', 'content-length', 'content-type', 'etag', 'link', 'vary'] as const) {
    assert.equal(actual[name], expected[name], name);
  }
}

function assertVary(value: string | undefined, expected: readonly string[]): void {
  const fields = new Set((value ?? '').split(',').map((field) => field.trim().toLowerCase()));
  for (const name of expected) assert.equal(fields.has(name.toLowerCase()), true, `Vary ${name}`);
}
