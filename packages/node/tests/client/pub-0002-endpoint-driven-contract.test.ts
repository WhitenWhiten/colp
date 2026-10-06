import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient, PublicationQueryError } from '../../src/client/index.js';

const evidence = 'http.endpoint-driven';
const manifestUrl = 'https://manifest.example/.well-known/collection-protocol';
const conventionalTrap = 'https://trap.example/conventional/';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

async function fixture(name: string): Promise<string> {
  return readFile(resolve(fixturesRoot, name), 'utf8');
}

async function customManifest(): Promise<Record<string, any>> {
  const manifest = JSON.parse(await fixture('public-manifest.json')) as Record<string, any>;
  manifest.mounts[0].baseUrl = conventionalTrap;
  return manifest;
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ETag: '"pub-0002"', 'Content-Type': 'application/json' } });
}

describe(`PUB-0002 endpoint-driven publication client [evidence:${evidence}]`, () => {
  it.each([
    {
      name: 'directory static JSON endpoint',
      endpoint: 'https://assets.example/public/v8/catalog.json?limit=17',
      expected: 'https://assets.example/public/v8/catalog.json?limit=17&tag=design',
      responseFixture: 'collection-directory.json',
      invoke: (client: ColpClient) => client.getDirectory({ tag: 'design' }),
    },
    {
      name: 'collection custom URI template',
      endpoint: 'https://objects.example/by-id/{collectionId}/metadata.json',
      expected: 'https://objects.example/by-id/019b3ca2-8424-7cc2-9a61-4bf44c23f07a/metadata.json',
      responseFixture: 'collection-metadata.json',
      invoke: (client: ColpClient) => client.getCollection('019b3ca2-8424-7cc2-9a61-4bf44c23f07a'),
    },
    {
      name: 'snapshot custom URI template',
      endpoint: 'https://archive.example/immutable/{collectionId}.snapshot.json',
      expected: 'https://archive.example/immutable/019b3ca2-8424-7cc2-9a61-4bf44c23f07a.snapshot.json',
      responseFixture: 'collection-snapshot.json',
      invoke: (client: ColpClient) => client.getSnapshot('019b3ca2-8424-7cc2-9a61-4bf44c23f07a'),
    },
  ])('uses the declared $name instead of baseUrl conventions [evidence:http.endpoint-driven]', async (testCase) => {
    const manifest = await customManifest();
    const endpointKey = testCase.name.split(' ')[0] as 'directory' | 'collection' | 'snapshot';
    manifest.mounts[0].endpoints[endpointKey] = testCase.endpoint;
    const representationObject = JSON.parse(await fixture(testCase.responseFixture));
    if (testCase.responseFixture === 'collection-metadata.json') {
      representationObject.collection.id = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
    }
    const representation = JSON.stringify(representationObject);
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      requested.push(url.href);
      if (url.href === manifestUrl) return Response.json(manifest);
      if (url.href === testCase.expected) return jsonResponse(representation);
      throw new Error(`Guessed or otherwise undeclared request: ${url.href}`);
    });

    await testCase.invoke(new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch }));

    expect(requested).toEqual([manifestUrl, testCase.expected]);
    expect(requested.some((url) => url.startsWith(conventionalTrap))).toBe(false);
  });

  it('assembles Snapshot pages only by following the response rel=next Link [evidence:http.endpoint-driven]', async () => {
    const manifest = await customManifest();
    const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
    const declaredTemplate = 'https://archive.example/custom-exports/{collectionId}.snapshot.json?limit=2';
    const declaredFirstPage = `https://archive.example/custom-exports/${collectionId}.snapshot.json?limit=2`;
    const linkedSecondPage = 'https://pages.example/opaque/batch-seven.json?limit=2&pageCursor=page-2';
    manifest.mounts[0].endpoints.snapshot = declaredTemplate;

    const complete = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const first = structuredClone(complete);
    const second = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = complete.nodes.slice(1);
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      requested.push(url.href);
      if (url.href === manifestUrl) return Response.json(manifest);
      if (url.href === declaredFirstPage) {
        return new Response(JSON.stringify(first), {
          headers: {
            ETag: '"page-1"',
            'Content-Type': 'application/json',
            Link: `<${linkedSecondPage}>; rel="next"`,
          },
        });
      }
      if (url.href === linkedSecondPage) return jsonResponse(JSON.stringify(second));
      throw new Error(`Client guessed a Snapshot page instead of following rel=next: ${url.href}`);
    });

    const snapshot = await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getSnapshot(collectionId);

    expect(snapshot.nodes).toHaveLength(complete.nodes.length);
    expect(snapshot.annotations).toHaveLength(complete.annotations.length);
    expect(requested).toEqual([manifestUrl, declaredFirstPage, linkedSecondPage]);
    expect(requested).not.toContain(`${declaredFirstPage}&pageCursor=page-2`);
    expect(requested.some((url) => url.startsWith(conventionalTrap))).toBe(false);
  });

  it('follows a cross-Origin declared endpoint without leaking static or credential headers [evidence:http.endpoint-driven]', async () => {
    const manifest = await customManifest();
    const declared = 'https://cdn.example/static/custom-directory.json';
    manifest.mounts[0].endpoints.directory = declared;
    const directory = await fixture('collection-directory.json');
    const observed: Array<{
      url: string;
      headers: Headers;
      credentials: RequestInit['credentials'];
    }> = [];
    const credentialProvider = vi.fn(async (url: URL) =>
      url.origin === new URL(manifestUrl).origin ? { 'X-Credential': 'manifest-secret' } : undefined);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      observed.push({
        url: url.href,
        headers: new Headers(init?.headers),
        credentials: init?.credentials,
      });
      return url.href === manifestUrl ? Response.json(manifest) : jsonResponse(directory);
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      headers: { Authorization: 'Bearer static-secret', 'X-Static-Tenant': 'private-tenant' },
      credentialProvider,
    });

    await client.getDirectory();

    expect(observed.map(({ url }) => url)).toEqual([manifestUrl, declared]);
    const publicationRequest = observed[1]!;
    expect(publicationRequest.credentials).toBe('omit');
    expect(publicationRequest.headers.get('authorization')).toBeNull();
    expect(publicationRequest.headers.get('x-static-tenant')).toBeNull();
    expect(publicationRequest.headers.get('x-credential')).toBeNull();
    expect(credentialProvider).toHaveBeenLastCalledWith(new URL(declared), expect.objectContaining({ id: 'default' }));
  });

  it.each([404, 503])(
    'does not retry a declared endpoint through a guessed path after HTTP %i [evidence:http.endpoint-driven]',
    async (status) => {
      const manifest = await customManifest();
      const declared = 'https://edge.example/errors/catalog.json';
      manifest.mounts[0].endpoints.directory = declared;
      const requested: string[] = [];
      const code = status === 404 ? 'resource_not_found' : 'service_unavailable';
      const problem = JSON.stringify({
        type: `https://collectionprotocol.org/problems/${code.replaceAll('_', '-')}`,
        title: 'Declared endpoint failed',
        status,
        code,
      });
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        requested.push(url.href);
        return url.href === manifestUrl
          ? Response.json(manifest)
          : new Response(problem, { status, headers: { 'Content-Type': 'application/problem+json' } });
      });
      const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

      await expect(client.getDirectory()).rejects.toThrow(code);
      expect(requested).toEqual([manifestUrl, declared]);
      expect(requested.some((url) => url.startsWith(conventionalTrap))).toBe(false);
    },
  );

  it.each([
    {
      endpointKey: 'directory' as const,
      endpoint: 'https://assets.example/catalog.json?limit=10',
      invoke: (client: ColpClient) => client.getDirectory({ limit: 20 }),
    },
    {
      endpointKey: 'snapshot' as const,
      endpoint: 'https://assets.example/{collectionId}.snapshot.json?limit=10',
      invoke: (client: ColpClient) => client.getSnapshot('019b3ca2-8424-7cc2-9a61-4bf44c23f07a', { limit: 20 }),
    },
  ])(
    'rejects caller duplication of a fixed $endpointKey query before endpoint I/O [evidence:http.endpoint-driven]',
    async (testCase) => {
      const manifest = await customManifest();
      manifest.mounts[0].endpoints[testCase.endpointKey] = testCase.endpoint;
      const requested: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        requested.push(url.href);
        if (url.href === manifestUrl) return Response.json(manifest);
        throw new Error(`Endpoint I/O must not occur for duplicate fixed query: ${url.href}`);
      });
      const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

      let thrown: unknown;
      try {
        await testCase.invoke(client);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PublicationQueryError);
      expect(thrown).toMatchObject({
        name: 'PublicationQueryError',
        message: 'invalid_query: Publication query is invalid.',
        code: 'invalid_query',
        issues: ['Query parameter must appear once.'],
      });
      expect(requested).toEqual([manifestUrl]);
    },
  );

  it('uses endpoints only from the explicitly selected Mount [evidence:http.endpoint-driven]', async () => {
    const manifest = await customManifest();
    const unselected = structuredClone(manifest.mounts[0]);
    unselected.id = 'conventional-trap';
    unselected.endpoints.directory = 'https://unselected.example/collections';
    const selected = structuredClone(manifest.mounts[0]);
    selected.id = 'selected-static';
    selected.baseUrl = 'https://selected-base.example/conventional/';
    selected.endpoints.directory = 'https://selected-cdn.example/pub/directory-v3.json';
    manifest.mounts = [unselected, selected];
    const directory = await fixture('collection-directory.json');
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      requested.push(url.href);
      if (url.href === manifestUrl) return Response.json(manifest);
      if (url.href === selected.endpoints.directory) return jsonResponse(directory);
      throw new Error(`Request used an endpoint from the wrong Mount: ${url.href}`);
    });
    const client = new ColpClient({
      manifestUrl,
      mountId: selected.id,
      fetch: fetch as typeof globalThis.fetch,
    });

    await client.getDirectory();

    expect(requested).toEqual([manifestUrl, selected.endpoints.directory]);
    expect(requested).not.toContain(unselected.endpoints.directory);
  });
});
