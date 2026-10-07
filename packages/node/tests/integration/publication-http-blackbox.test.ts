import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ColpClient,
  ColpProblemError,
  type ClientCache,
  type ClientCacheEntry,
} from '../../src/client/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  composePublicationHttpRead,
  mergePublicationCollectionMetadataLinkHeaders,
  mergePublicationSnapshotNextLinkHeaders,
} from '../../src/server/index.js';
import type {
  CollectionDirectory,
  CollectionMetadata,
  Manifest,
  Snapshot,
} from '../../src/types/index.js';

const evidence = '[evidence:http.publication-black-box]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const lastModified = new Date('2026-07-16T06:30:00Z');
const media = Object.freeze({
  manifest: 'application/vnd.collection-protocol.manifest+json;version=0.1',
  directory: 'application/vnd.collection-protocol.catalog+json;version=0.1',
  metadata: 'application/vnd.collection-protocol.collection+json;version=0.1',
  snapshot: 'application/vnd.collection-protocol.snapshot+json;version=0.1',
});

interface Exchange {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly ifNoneMatch: string | undefined;
  status?: number;
  responseHeaders?: Headers;
  responseBodyBytes?: number;
}

interface FixtureSet {
  readonly manifest: Manifest;
  readonly directory: CollectionDirectory;
  readonly metadata: CollectionMetadata;
  readonly firstPage: Snapshot;
  readonly secondPage: Snapshot;
}

interface RunningPublicationServer {
  readonly origin: string;
  readonly manifestUrl: string;
  readonly exchanges: Exchange[];
  readonly errors: unknown[];
  close(): Promise<void>;
}

async function fixture<Value>(name: string): Promise<Value> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as Value;
}

function memoryCache(): ClientCache {
  const entries = new Map<string, ClientCacheEntry>();
  return {
    get(key) {
      return entries.get(key);
    },
    set(key, value) {
      entries.set(key, value);
    },
    delete(key) {
      entries.delete(key);
    },
  };
}

function buildFixtures(origin: string, source: {
  readonly manifest: Manifest;
  readonly directory: CollectionDirectory;
  readonly snapshot: Snapshot;
}): FixtureSet {
  const manifest = structuredClone(source.manifest);
  const mount = manifest.mounts[0];
  // The loopback transport intentionally substitutes HTTP for schema-required deployment HTTPS.
  mount.baseUrl = `${origin}/collections/` as typeof mount.baseUrl;
  mount.endpoints.directory = `${origin}/collections` as NonNullable<typeof mount.endpoints.directory>;
  mount.endpoints.collection = `${origin}/collections/c/{collectionId}` as NonNullable<typeof mount.endpoints.collection>;
  mount.endpoints.snapshot = `${origin}/collections/c/{collectionId}/snapshot` as NonNullable<typeof mount.endpoints.snapshot>;

  const complete = structuredClone(source.snapshot);
  const metadata: CollectionMetadata = {
    collection: structuredClone(complete.collection),
    links: {
      self: `${origin}/collections/c/${collectionId}` as CollectionMetadata['links']['self'],
      canonical: complete.collection.canonicalUrl as CollectionMetadata['links']['canonical'],
      snapshot: `${origin}/collections/c/${collectionId}/snapshot` as CollectionMetadata['links']['snapshot'],
    },
  };
  const directory = structuredClone(source.directory);
  const collection = complete.collection;
  directory.collections = [{
    id: collection.id,
    canonicalUrl: collection.canonicalUrl as CollectionDirectory['collections'][number]['canonicalUrl'],
    title: collection.title,
    ...(collection.summary === undefined ? {} : { summary: collection.summary }),
    kind: collection.kind,
    ...(collection.tags === undefined ? {} : { tags: collection.tags }),
    ...(collection.language === undefined ? {} : { language: collection.language }),
    ...(collection.creators === undefined ? {} : { creators: collection.creators }),
    nodeCount: complete.nodes.length,
    updatedAt: collection.updatedAt,
    visibility: 'public',
    links: structuredClone(metadata.links),
    extensions: {},
  }];

  const firstPage = structuredClone(complete);
  firstPage.nodes = complete.nodes.slice(0, 1);
  firstPage.annotations = [];
  firstPage.page = { nextCursor: 'opaque-page-two', hasMore: true, sequence: 1 };
  const secondPage = structuredClone(complete);
  secondPage.nodes = complete.nodes.slice(1);
  secondPage.page = { nextCursor: null, hasMore: false, sequence: 2 };
  return { manifest, directory, metadata, firstPage, secondPage };
}

async function sendResponse(
  response: Response,
  outgoing: ServerResponse,
  exchange: Exchange,
): Promise<void> {
  const bytes = response.body === null ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
  exchange.status = response.status;
  exchange.responseHeaders = new Headers(response.headers);
  exchange.responseBodyBytes = bytes.byteLength;
  const headers = Object.fromEntries(response.headers.entries());
  outgoing.writeHead(response.status, headers);
  outgoing.end(bytes.byteLength === 0 ? undefined : bytes);
}

async function startPublicationServer(): Promise<RunningPublicationServer> {
  const [manifest, directory, snapshot] = await Promise.all([
    fixture<Manifest>('public-manifest.json'),
    fixture<CollectionDirectory>('collection-directory.json'),
    fixture<Snapshot>('collection-snapshot.json'),
  ]);
  const validators = createValidatorRegistry();
  const exchanges: Exchange[] = [];
  const errors: unknown[] = [];
  let fixtures: FixtureSet;
  let origin = '';

  const server: Server = createServer((incoming, outgoing) => {
    void (async () => {
      const requestUrl = new URL(incoming.url ?? '/', origin);
      const exchange: Exchange = {
        method: incoming.method ?? '',
        url: requestUrl.href,
        authorization: header(incoming, 'authorization'),
        ifNoneMatch: header(incoming, 'if-none-match'),
      };
      exchanges.push(exchange);
      const method = incoming.method === 'HEAD' ? 'HEAD' : 'GET';
      const common = {
        method,
        rawSearch: requestUrl.search,
        validators,
        ifNoneMatch: exchange.ifNoneMatch ?? null,
      } as const;
      let response: Response;

      if (requestUrl.pathname === '/.well-known/collection-protocol') {
        response = await composePublicationHttpRead({
          ...common,
          endpoint: 'manifest',
          access: 'anonymous-public',
          resolveRepresentation: () => representation(fixtures.manifest, 'manifest-r1', 'manifest', media.manifest),
        });
      } else if (requestUrl.pathname === '/collections') {
        const authorization = exchange.authorization;
        if (authorization === undefined) {
          response = await composePublicationHttpRead({
            ...common,
            endpoint: 'directory',
            access: 'anonymous-public',
            resolveRepresentation: () => ({
              ...representation(fixtures.directory, 'directory-r1', 'public-directory', media.directory),
              cacheControl: 'public, max-age=60',
            }),
          });
        } else {
          response = await composePublicationHttpRead({
            ...common,
            endpoint: 'directory',
            access: 'authorized-private',
            authorize: () => authorize(authorization),
            resolveRepresentation: (_query, context) => ({
              ...representation(fixtures.directory, 'directory-r1', `directory-${context.principal}`, media.directory),
              principalScope: context.principal,
              cacheControl: 'public, max-age=60',
            }),
          });
        }
      } else if (requestUrl.pathname === `/collections/c/${collectionId}`) {
        const authorization = exchange.authorization;
        response = authorization === undefined
          ? await composePublicationHttpRead({
              ...common,
              endpoint: 'metadata',
              access: 'anonymous-public',
              resolveRepresentation: () => ({
                ...representation(fixtures.metadata, 'r_1042', 'public-metadata', media.metadata),
                headers: mergePublicationCollectionMetadataLinkHeaders(fixtures.metadata),
                cacheControl: 'public, max-age=60',
              }),
            })
          : await composePublicationHttpRead({
              ...common,
              endpoint: 'metadata',
              access: 'authorized-private',
              authorize: () => authorize(authorization),
              resolveRepresentation: (_query, context) => ({
                ...representation(fixtures.metadata, 'r_1042', `metadata-${context.principal}`, media.metadata),
                principalScope: context.principal,
                headers: mergePublicationCollectionMetadataLinkHeaders(fixtures.metadata),
              }),
            });
      } else if (requestUrl.pathname === '/collections/c/hidden-collection') {
        response = await composePublicationHttpRead({
          ...common,
          endpoint: 'metadata',
          access: 'authorized-private',
          authorize: () => ({ allowed: false, problem: 'resource_not_found' }),
          resolveRepresentation: () => {
            throw new Error('A concealed Collection representation must never be resolved.');
          },
        });
      } else if (requestUrl.pathname === `/collections/c/${collectionId}/snapshot`) {
        const cursor = requestUrl.searchParams.get('pageCursor');
        const page = cursor === null ? fixtures.firstPage : fixtures.secondPage;
        const nextUrl = cursor === null
          ? `${origin}/collections/c/${collectionId}/snapshot?pageCursor=opaque-page-two`
          : null;
        response = await composePublicationHttpRead({
          ...common,
          endpoint: 'snapshot',
          access: 'anonymous-public',
          resolveRepresentation: () => ({
            ...representation(page, 'r_1042', 'public-snapshot', media.snapshot),
            snapshotIdentity: { snapshotId: page.snapshotId, sequence: page.page.sequence },
            pageIdentity: cursor === null ? { pageNumber: 1 } : { pageCursor: cursor, pageNumber: 2 },
            headers: mergePublicationSnapshotNextLinkHeaders(page, nextUrl),
            cacheControl: 'public, max-age=60',
          }),
        });
      } else {
        response = new Response(null, { status: 404 });
      }
      await sendResponse(response, outgoing, exchange);
    })().catch((error: unknown) => {
      errors.push(error);
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  fixtures = buildFixtures(origin, { manifest, directory, snapshot });
  return {
    origin,
    manifestUrl: `${origin}/.well-known/collection-protocol`,
    exchanges,
    errors,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error === undefined ? resolveClose() : reject(error));
      server.closeIdleConnections();
      server.closeAllConnections();
    }),
  };
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

function representation(value: unknown, revision: string, projectionKey: string, negotiatedMediaType: string) {
  return {
    value,
    revision,
    projectionKey,
    protocolVersion: '0.1',
    lastModified,
    negotiatedMediaType,
  } as const;
}

function authorize(authorization: string | undefined) {
  const principal = authorization === 'Bearer alice-token'
    ? 'alice'
    : authorization === 'Bearer bob-token'
      ? 'bob'
      : undefined;
  return principal === undefined
    ? { allowed: false as const, problem: 'resource_not_found' as const }
    : { allowed: true as const, context: { principal } };
}

function exchangeFor(
  exchanges: readonly Exchange[],
  predicate: (exchange: Exchange) => boolean,
): Exchange {
  const match = exchanges.find(predicate);
  expect(match).toBeDefined();
  return match as Exchange;
}

describe(`Publication HTTP black-box integration ${evidence}`, () => {
  it(`discovers and assembles a real two-page public Snapshot over node:http ${evidence}`, async () => {
    const server = await startPublicationServer();
    try {
      const cache = memoryCache();
      const client = new ColpClient({
        manifestUrl: server.manifestUrl,
        fetch: globalThis.fetch,
        cache,
        // The fixture server is loopback; response-link pagination needs an explicit egress opt-in.
        egressPolicy: (url) => url.origin === server.origin,
      });

      const discovered = await client.discover();
      const directory = await client.getDirectory();
      const metadata = await client.getCollection(collectionId);
      const snapshot = await client.getSnapshot(collectionId);

      expect(discovered.mounts[0]?.endpoints.directory).toBe(`${server.origin}/collections`);
      expect(directory.collections.map((collection) => collection.id)).toEqual([collectionId]);
      expect(metadata.collection.id).toBe(collectionId);
      const metadataExchange = exchangeFor(server.exchanges, (item) =>
        item.url === `${server.origin}/collections/c/${collectionId}` && item.authorization === undefined);
      expect(metadataExchange.responseHeaders?.get('link')).toBe([
        `<${server.origin}/collections/c/${collectionId}>; rel="self"; type="application/vnd.collection-protocol.collection+json"`,
        `<${metadata.collection.canonicalUrl}>; rel="canonical"; type="text/html"`,
        `<${server.origin}/collections/c/${collectionId}/snapshot>; rel="https://know-n.com/colp/rels/snapshot"; type="application/vnd.collection-protocol.snapshot+json"`,
      ].join(', '));
      expect(snapshot).toMatchObject({
        snapshotId: 'snap_public_1042',
        complete: true,
        page: { nextCursor: null, hasMore: false, sequence: 1 },
      });
      expect(snapshot.nodes).toHaveLength(2);
      expect(snapshot.annotations).toHaveLength(1);
      expect(server.exchanges.slice(0, 5).map((exchange) => exchange.url)).toEqual([
        server.manifestUrl,
        `${server.origin}/collections`,
        `${server.origin}/collections/c/${collectionId}`,
        `${server.origin}/collections/c/${collectionId}/snapshot`,
        `${server.origin}/collections/c/${collectionId}/snapshot?pageCursor=opaque-page-two`,
      ]);

      const snapshotRequests = server.exchanges.filter((exchange) => new URL(exchange.url).pathname.endsWith('/snapshot'));
      expect(snapshotRequests.map((exchange) => exchange.url)).toEqual([
        `${server.origin}/collections/c/${collectionId}/snapshot`,
        `${server.origin}/collections/c/${collectionId}/snapshot?pageCursor=opaque-page-two`,
      ]);
      expect(snapshotRequests[0]?.responseHeaders?.get('link')).toBe(
        `<${server.origin}/collections/c/${collectionId}/snapshot?pageCursor=opaque-page-two>; rel="next"`,
      );
      expect(snapshotRequests[1]?.responseHeaders?.has('link')).toBe(false);

      for (const exchange of server.exchanges.filter((item) => item.status === 200)) {
        const declared = Number(exchange.responseHeaders?.get('content-length'));
        const path = new URL(exchange.url).pathname;
        const expectedMedia = path === '/.well-known/collection-protocol'
          ? media.manifest
          : path === '/collections'
            ? media.directory
            : path.endsWith('/snapshot')
              ? media.snapshot
              : media.metadata;
        expect(exchange.responseHeaders?.get('content-type')).toBe(expectedMedia);
        expect(exchange.responseHeaders?.get('etag')).toMatch(/^"pub\.r1\.[A-Za-z0-9_-]+"$/u);
        expect(exchange.responseHeaders?.get('last-modified')).toBe(lastModified.toUTCString());
        expect(declared).toBe(exchange.responseBodyBytes);
      }
      const publicDirectory = exchangeFor(server.exchanges, (item) => item.url === `${server.origin}/collections`);
      expect(publicDirectory.responseHeaders?.get('cache-control')).toBe('public, max-age=60');
      expect(publicDirectory.responseHeaders?.get('vary')).toContain('Accept');
      expect(publicDirectory.responseHeaders?.get('vary')).not.toContain('Authorization');

      const authorizedGet = await fetch(`${server.origin}/collections/c/${collectionId}`, {
        headers: { Authorization: 'Bearer alice-token' },
      });
      expect(authorizedGet.status).toBe(200);
      const authorizedBytes = await authorizedGet.arrayBuffer();
      expect(authorizedBytes.byteLength).toBe(Number(authorizedGet.headers.get('content-length')));
      const etag = authorizedGet.headers.get('etag');
      expect(etag).toBeDefined();
      const conditional = await fetch(`${server.origin}/collections/c/${collectionId}`, {
        headers: { Authorization: 'Bearer alice-token', 'If-None-Match': `W/${etag}` },
      });
      expect(conditional.status).toBe(304);
      expect((await conditional.arrayBuffer()).byteLength).toBe(0);
      expect(conditional.headers.get('etag')).toBe(etag);

      const head = await fetch(`${server.origin}/collections/c/${collectionId}`, {
        method: 'HEAD',
        headers: { Authorization: 'Bearer alice-token' },
      });
      expect(head.status).toBe(200);
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      expect(head.headers.get('content-type')).toBe(media.metadata);
      expect(head.headers.get('content-length')).toBe(authorizedGet.headers.get('content-length'));
      expect(head.headers.get('etag')).toBe(etag);
      expect(head.headers.get('last-modified')).toBe(lastModified.toUTCString());
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it(`parses concealed Problems and isolates authorized reads by principal ${evidence}`, async () => {
    const server = await startPublicationServer();
    try {
      const anonymous = new ColpClient({ manifestUrl: server.manifestUrl, fetch: globalThis.fetch });
      const concealed = await anonymous.getCollection('hidden-collection').catch((error: unknown) => error);
      expect(concealed).toBeInstanceOf(ColpProblemError);
      expect(concealed).toMatchObject({ status: 404, code: 'resource_not_found', known: true });
      const problemExchange = exchangeFor(server.exchanges, (item) => item.status === 404);
      expect(problemExchange.responseHeaders?.get('content-type')).toBe('application/problem+json');
      expect(problemExchange.responseHeaders?.get('cache-control')).toBe('private, no-store');
      expect(problemExchange.responseBodyBytes).toBe(Number(problemExchange.responseHeaders?.get('content-length')));

      const sharedCache = memoryCache();
      const authorizedClient = (principal: 'alice' | 'bob') => new ColpClient({
        manifestUrl: server.manifestUrl,
        fetch: globalThis.fetch,
        cache: sharedCache,
        requestIdentityProvider: () => ({
          credentialProvider: () => ({ Authorization: 'Bearer ' + principal + '-token' }),
          cachePartition: principal,
        }),
      });
      const alice = authorizedClient('alice');
      const bob = authorizedClient('bob');
      await alice.getDirectory();
      await bob.getDirectory();

      const privateReads = server.exchanges.filter((item) =>
        item.url === `${server.origin}/collections` && item.authorization !== undefined);
      expect(privateReads.map((item) => item.authorization)).toEqual(['Bearer alice-token', 'Bearer bob-token']);
      expect(privateReads.map((item) => item.responseHeaders?.get('cache-control'))).toEqual([
        'private, no-store',
        'private, no-store',
      ]);
      expect(privateReads.every((item) => item.responseHeaders?.get('vary')?.includes('Authorization'))).toBe(true);
      expect(privateReads[0]?.responseHeaders?.get('etag')).not.toBe(privateReads[1]?.responseHeaders?.get('etag'));

      await alice.getDirectory();
      await bob.getDirectory();
      const repeatedPrivateReads = server.exchanges.filter((item) =>
        item.url === `${server.origin}/collections` && item.authorization !== undefined);
      // Private no-store responses cannot supply validators for later requests.
      expect(repeatedPrivateReads.map((item) => item.status)).toEqual([200, 200, 200, 200]);
      expect(repeatedPrivateReads[2]?.ifNoneMatch).toBeUndefined();
      expect(repeatedPrivateReads[3]?.ifNoneMatch).toBeUndefined();
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
