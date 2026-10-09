/**
 * A minimal read-only COLP server: the `core + publication` profiles over node:http.
 *
 * Run from packages/node after `npm run build`:
 *
 *   node examples/publication-server.mjs              # serve on http://127.0.0.1:8080
 *   PORT=3000 node examples/publication-server.mjs
 *   node examples/publication-server.mjs --self-test  # start, read everything with ColpClient, exit
 *
 * The package does not ship a server: it validates wire documents and composes
 * each HTTP read (query decoding, ETag, cache headers, 304, HEAD, Problem
 * responses). This file supplies the parts that belong to your application:
 * routing, the data, and the response adapter for node:http.
 *
 * The data is one Collection taken from the protocol examples. Replace `store`
 * with your own storage. A real deployment also serves HTTPS, runs the
 * package's conformance probes, and publishes only the profiles that
 * `assertProfileClaims` from `@know-n/colp/conformance` returns.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { ColpClient, createLoopbackEgressPolicy } from '@know-n/colp/client';
import {
  composePublicationHttpReadFromRequest,
  createPublicationHttpReadRepresentation,
  createPublicationProblemResponse,
} from '@know-n/colp/server';

const examples = new URL('../fixtures/protocol/examples/', import.meta.url);
const snapshot = JSON.parse(await readFile(new URL('collection-snapshot.json', examples), 'utf8'));
const collection = snapshot.collection;
const lastModified = new Date(collection.updatedAt);

/** Builds every public document for a server reachable at `origin`. */
function createStore(origin) {
  const collectionUrl = `${origin}/collections/c/${collection.id}`;
  const links = {
    self: collectionUrl,
    canonical: collection.canonicalUrl,
    snapshot: `${collectionUrl}/snapshot`,
  };
  return {
    manifest: {
      protocol: 'https://know-n.com/colp/spec/0.1',
      protocolVersions: ['0.1'],
      serverId: `${origin}/`,
      serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
      title: 'Example Collections',
      mounts: [{
        id: 'default',
        baseUrl: `${origin}/collections/`,
        profiles: ['core', 'publication'],
        endpoints: {
          directory: `${origin}/collections`,
          collection: `${origin}/collections/c/{collectionId}`,
          snapshot: `${origin}/collections/c/{collectionId}/snapshot`,
        },
        features: {},
        auth: { anonymousRead: true, apiKeys: false, oauth: false },
        limits: {
          maxPageSize: 200,
          maxSnapshotNodes: 10000,
          minPollIntervalSeconds: 60,
          recommendedPollIntervalSeconds: 300,
        },
      }],
    },
    directory: {
      protocolVersion: '0.1',
      collections: [{
        id: collection.id,
        canonicalUrl: collection.canonicalUrl,
        title: collection.title,
        kind: collection.kind,
        ...pick(collection, ['summary', 'tags', 'language', 'creators']),
        nodeCount: snapshot.nodes.length,
        updatedAt: collection.updatedAt,
        visibility: 'public',
        links,
        extensions: {},
      }],
      nextCursor: null,
    },
    metadata: { collection, links },
    snapshot,
  };
}

/** Copies the optional members that are present, so absent ones stay absent. */
function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

/**
 * Serves one document through the package: it decodes and checks the query,
 * negotiates the protocol version (an unsupported `Collection-Protocol-Version`
 * or `Accept` version gets a 406 Problem), then asks `resolveRepresentation`
 * for the document and adds the ETag, cache headers, 304, HEAD, and Problem
 * responses. Methods other than GET and HEAD get a 405 Problem.
 *
 * `resolveRepresentation` receives the decoded query (`limit`, `cursor`,
 * filters). This static example has one small Collection and ignores it:
 * every read returns the whole document as a single page, so `?limit=1`
 * still yields every member with `hasMore: false`. A real host must honor
 * `decoded.limit` (bounded by the Manifest's `limits.maxPageSize`) and
 * `decoded.cursor`, and set `pageIdentity` / the `next` Link for later pages;
 * docs/PUBLICATION_QUICKSTART.md explains cursors.
 */
function read(request, endpoint, value, options = {}) {
  return composePublicationHttpReadFromRequest(request, {
    endpoint,
    access: 'anonymous-public',
    // `decoded` is the accepted query; see the note above on paging.
    resolveRepresentation: (_decoded) => createPublicationHttpReadRepresentation(endpoint, value, {
      lastModified,
      cacheControl: 'public, max-age=60',
      ...options,
    }),
  });
}

/** Routes one request to the composed Publication read for its endpoint. */
async function handle(request, store) {
  const collectionPath = `/collections/c/${collection.id}`;
  switch (new URL(request.url).pathname) {
    case '/.well-known/collection-protocol':
      // The Manifest and the Directory have no revision of their own, so the host names one.
      return read(request, 'manifest', store.manifest, { revision: 'manifest-r1', cacheControl: 'public, max-age=300' });
    case '/collections':
      return read(request, 'directory', store.directory, { revision: 'directory-r1' });
    case collectionPath:
      return read(request, 'metadata', store.metadata);
    case `${collectionPath}/snapshot`:
      return read(request, 'snapshot', store.snapshot);
    default:
      // Errors are RFC 9457 Problem Details with a registered code (PUB-0008).
      return createPublicationProblemResponse({ code: 'resource_not_found' });
  }
}

/** Starts the server and resolves once it is listening. */
export async function startPublicationServer({ port = 0, host = '127.0.0.1' } = {}) {
  let store;
  let origin;
  const server = createServer((incoming, outgoing) => {
    const request = new Request(new URL(incoming.url ?? '/', origin), {
      method: incoming.method,
      headers: Object.entries(incoming.headers).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]]),
    });
    handle(request, store)
      .then(async (response) => {
        // Forward the status, headers, and exact body bytes; the ETag covers these bytes.
        const body = response.body === null ? undefined : Buffer.from(await response.arrayBuffer());
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(body);
      })
      .catch((error) => {
        console.error(error);
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end();
      });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  origin = `http://${host}:${server.address().port}`;
  store = createStore(origin);
  return {
    origin,
    manifestUrl: `${origin}/.well-known/collection-protocol`,
    collectionId: collection.id,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/** Reads the whole Collection back through the Manifest, as any COLP client would. */
async function selfTest() {
  const server = await startPublicationServer();
  try {
    const client = new ColpClient({
      manifestUrl: server.manifestUrl,
      // Without a policy, ColpClient follows a loopback Manifest only on the first
      // hop; this also allows redirects and next-page links to this server, and
      // nothing else.
      egressPolicy: createLoopbackEgressPolicy([server.origin]),
    });
    const manifest = await client.discover();
    const directory = await client.getDirectory();
    const metadata = await client.getCollection(server.collectionId);
    const result = await client.getSnapshot(server.collectionId);
    console.log(`Manifest:  ${manifest.title} (${manifest.mounts[0].profiles.join(', ')})`);
    console.log(`Directory: ${directory.collections.length} collection(s)`);
    console.log(`Metadata:  ${metadata.collection.title}`);
    console.log(`Snapshot:  ${result.nodes.length} node(s), ${result.annotations.length} annotation(s)`);
  } finally {
    await server.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--self-test')) {
    await selfTest();
  } else {
    const server = await startPublicationServer({ port: Number(process.env.PORT ?? 8080) });
    console.log(`COLP publication server on ${server.origin}`);
    console.log(`  curl -i ${server.manifestUrl}`);
    console.log(`  curl -i ${server.origin}/collections`);
    console.log(`  curl -i ${server.origin}/collections/c/${server.collectionId}/snapshot`);
    process.once('SIGINT', () => void server.close().then(() => process.exit(0)));
  }
}
