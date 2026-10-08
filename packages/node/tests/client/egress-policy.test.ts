import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  ColpWireValidationError,
  type ClientEgressPolicyContext,
} from '../../src/client/index.js';

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const fixtureCollectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';

async function fixture(name: string): Promise<string> {
  return readFile(resolve(fixturesRoot, name), 'utf8');
}

describe('ColpClient per-hop egress policy', () => {
  it('authorizes Manifest and selected Mount endpoint requests with operation context', async () => {
    const manifest = await fixture('public-manifest.json');
    const directory = await fixture('collection-directory.json');
    const calls: Array<{ url: string; context: ClientEgressPolicyContext }> = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return new Response(url.pathname === '/collections' ? directory : manifest, {
        headers: { 'Content-Type': 'application/json', ETag: '"egress-test"' },
      });
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      egressPolicy(url, context) {
        calls.push({ url: url.href, context });
        return true;
      },
    });

    await client.getDirectory();

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: manifestUrl,
      context: { purpose: 'manifest', method: 'GET', redirectCount: 0, previousUrl: null },
    });
    expect(calls[1]).toMatchObject({
      url: 'https://alice.example/collections',
      context: { purpose: 'publication-read', method: 'GET', redirectCount: 0, mountId: 'default' },
    });
  });

  it('runs on every redirect hop with the previous URL before credentials and fetch', async () => {
    const manifest = await fixture('public-manifest.json');
    const events: string[] = [];
    const contexts: ClientEgressPolicyContext[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      events.push(`fetch:${url.pathname}`);
      return url.pathname === '/start'
        ? new Response(null, { status: 307, headers: { Location: '/final' } })
        : Response.json(JSON.parse(manifest));
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/start',
      fetch: fetch as typeof globalThis.fetch,
      egressPolicy(url, context) {
        events.push(`policy:${url.pathname}`);
        contexts.push(context);
        return true;
      },
      credentialProvider(url) {
        events.push(`credentials:${url.pathname}`);
        return { Authorization: 'Bearer test' };
      },
    });

    await client.discover();

    expect(events).toEqual([
      'policy:/start',
      'credentials:/start',
      'fetch:/start',
      'policy:/final',
      'credentials:/final',
      'fetch:/final',
    ]);
    expect(contexts[1]).toMatchObject({ redirectCount: 1 });
    expect(contexts[1]?.previousUrl?.href).toBe('https://alice.example/start');
  });

  it('authorizes publisher writes with POST and the selected Mount', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const created = snapshot.nodes[1];
    const policy = vi.fn(async () => true);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? Response.json(JSON.parse(manifest))
        : Response.json(created, {
            status: 201,
            headers: { ETag: '"created"', Location: `${url.href}/${created.id}` },
          });
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      egressPolicy: policy,
    });

    await client.createNode(
      fixtureCollectionId,
      {
        parentId: snapshot.collection.rootNodeId,
        node: { kind: 'bookmark', title: 'Created', url: 'https://example.test/created' },
      },
      { idempotencyKey: 'create-node-egress-test' },
    );

    expect(policy).toHaveBeenLastCalledWith(
      expect.objectContaining({ pathname: `/collections/c/${fixtureCollectionId}/nodes` }),
      expect.objectContaining({ purpose: 'publisher-write', method: 'POST', mountId: 'default' }),
    );
  });

  it('authorizes every Snapshot pagination Link request', async () => {
    const manifest = await fixture('public-manifest.json');
    const complete = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const first = structuredClone(complete);
    const second = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = complete.nodes.slice(1);
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };
    const urls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return Response.json(JSON.parse(manifest));
      if (url.searchParams.get('pageCursor') === 'page-2') {
        return Response.json(second, { headers: { ETag: '"page-2"' } });
      }
      return Response.json(first, {
        headers: {
          ETag: '"page-1"',
          Link: `<https://alice.example/collections/c/${fixtureCollectionId}/snapshot?pageCursor=page-2>; rel="next"`,
        },
      });
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      egressPolicy(url) { urls.push(url.href); return true; },
    });

    await client.getSnapshot(fixtureCollectionId);
    expect(urls.filter((url) => url.includes('/snapshot'))).toEqual([
      `https://alice.example/collections/c/${fixtureCollectionId}/snapshot`,
      `https://alice.example/collections/c/${fixtureCollectionId}/snapshot?pageCursor=page-2`,
    ]);
  });

  it('re-authorizes a cross-Origin publication redirect without changing its purpose', async () => {
    const manifest = await fixture('public-manifest.json');
    const directory = await fixture('collection-directory.json');
    const calls: Array<{ url: string; context: ClientEgressPolicyContext }> = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return Response.json(JSON.parse(manifest));
      if (url.origin === 'https://alice.example') {
        return new Response(null, { status: 302, headers: { Location: 'https://cdn.example/directory' } });
      }
      return new Response(directory, { headers: { ETag: '"directory"', 'Content-Type': 'application/json' } });
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      egressPolicy(url, context) { calls.push({ url: url.href, context }); return true; },
    });

    await client.getDirectory();
    expect(calls.at(-1)).toMatchObject({
      url: 'https://cdn.example/directory',
      context: {
        purpose: 'publication-read',
        method: 'GET',
        redirectCount: 1,
        previousUrl: expect.objectContaining({ href: 'https://alice.example/collections' }),
      },
    });
  });

  it.each([false, undefined, 'yes'])('fails closed for a policy result of %j before credentials or fetch', async (result) => {
    const credentials = vi.fn(() => ({ Authorization: 'Bearer test' }));
    const fetch = vi.fn();
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      credentialProvider: credentials,
      egressPolicy: (() => result) as never,
    });

    await expect(client.discover()).rejects.toThrow('Egress policy denied');
    expect(credentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('applies configured I-JSON limits to network responses [evidence:core.ijson-bounds]', async () => {
    const manifest = await fixture('public-manifest.json');
    const client = new ColpClient({
      manifestUrl,
      fetch: vi.fn(async () => Response.json(JSON.parse(manifest))) as typeof globalThis.fetch,
      jsonLimits: { maxMembers: 2 },
    });

    const failure = await client.discover().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ColpWireValidationError);
    expect(failure).toMatchObject({ stage: 'parse', details: { code: 'max_members', limit: 2 } });
  });
});

const privateLiteralRedirectDenied = {
  name: 'TypeError',
  message: 'Egress policy denied publication-read request URL: literal private or local host.',
} as const;

function requestedHrefs(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([input]) => (
    new URL(input instanceof Request ? input.url : String(input)).href
  ));
}

function directoryRedirectFetch(
  manifest: string,
  directory: string,
  location: string,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe('manual');
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/.well-known/collection-protocol') {
      return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.origin === 'https://alice.example') {
      return new Response(null, { status: 302, headers: { Location: location } });
    }
    return new Response(directory, { headers: { ETag: '"directory"', 'Content-Type': 'application/json' } });
  });
}

describe('ColpClient default literal-host egress on GET redirects', () => {
  const legalLocation = 'https://cdn.example/directory';

  it('rejects a DNS answer in a private range before credentials or fetch', async () => {
    const resolveHost = vi.fn(async () => ['10.0.0.7']);
    const credentials = vi.fn(() => ({ Authorization: 'Bearer test' }));
    const fetch = vi.fn();
    const client = new ColpClient({
      manifestUrl: 'https://public.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      pinnedFetch: vi.fn(async () => new Response('{}')),
      resolveHost,
      credentialProvider: credentials,
    });

    await expect(client.discover()).rejects.toMatchObject({
      name: 'TypeError',
      message: 'Egress policy denied manifest request URL: DNS resolved to a private or local address.',
    });
    expect(resolveHost).toHaveBeenCalledWith('public.example', expect.any(AbortSignal));
    expect(credentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks DNS answers again before a redirect target is fetched', async () => {
    const manifest = await fixture('public-manifest.json');
    const directory = await fixture('collection-directory.json');
    const fetch = directoryRedirectFetch(manifest, directory, 'https://cdn.example/directory');
    const resolveHost = vi.fn(async (hostname: string) => (
      hostname === 'cdn.example' ? ['192.168.1.5'] : ['93.184.216.34']
    ));
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      pinnedFetch: async (url, init) => (fetch as unknown as typeof globalThis.fetch)(url, init),
      resolveHost,
    });

    await expect(client.getDirectory()).rejects.toMatchObject({
      name: 'TypeError',
      message: 'Egress policy denied publication-read request URL: DNS resolved to a private or local address.',
    });
    expect(requestedHrefs(fetch)).toEqual([
      manifestUrl,
      'https://alice.example/collections',
    ]);
    expect(resolveHost.mock.calls.map(([hostname]) => hostname)).toEqual([
      'alice.example',
      'alice.example',
      'cdn.example',
    ]);
  });

  it('follows a public https Location when egressPolicy is omitted', async () => {
    const manifest = await fixture('public-manifest.json');
    const directory = await fixture('collection-directory.json');
    const fetch = directoryRedirectFetch(manifest, directory, legalLocation);
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.getDirectory()).resolves.toMatchObject({
      collections: expect.any(Array),
    });
    expect(requestedHrefs(fetch)).toEqual([
      manifestUrl,
      'https://alice.example/collections',
      legalLocation,
    ]);
  });

  it.each([
    'https://10.0.0.1/directory',
    'https://169.254.169.254/directory',
    'https://127.0.0.1/directory',
  ] as const)('refuses an omitted-policy GET redirect Location %s', async (location) => {
    const manifest = await fixture('public-manifest.json');
    const directory = await fixture('collection-directory.json');
    const fetch = directoryRedirectFetch(manifest, directory, location);
    const credentials = vi.fn((_url: URL) => ({ Authorization: 'Bearer test' }));
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      credentialProvider: credentials,
    });

    const failure = await client.getDirectory().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject(privateLiteralRedirectDenied);
    expect(requestedHrefs(fetch)).toEqual([
      manifestUrl,
      'https://alice.example/collections',
    ]);
    expect(credentials.mock.calls.map(([url]) => url.href)).not.toContain(location);
  });

  it('lets an explicit egressPolicy that returns true permit a private literal Location', async () => {
    const manifest = await fixture('public-manifest.json');
    const directory = await fixture('collection-directory.json');
    const location = 'https://10.0.0.1/directory';
    const fetch = directoryRedirectFetch(manifest, directory, location);
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      egressPolicy: () => true,
    });

    await expect(client.getDirectory()).resolves.toMatchObject({
      collections: expect.any(Array),
    });
    expect(requestedHrefs(fetch)).toEqual([
      manifestUrl,
      'https://alice.example/collections',
      location,
    ]);
  });

  it('still refuses write redirects outside the trusted Mount Origin', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') {
        return Response.json(JSON.parse(manifest));
      }
      return new Response(null, {
        status: 307,
        headers: { Location: 'https://cdn.example/stolen-write' },
      });
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    });

    const failure = await client.createNode(
      fixtureCollectionId,
      {
        parentId: snapshot.collection.rootNodeId,
        node: { kind: 'bookmark', title: 'Created', url: 'https://example.test/created' },
      },
      { idempotencyKey: 'create-node-write-redirect' },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({
      name: 'TypeError',
      message: 'Refusing to redirect a write request outside the trusted Mount Origin.',
    });
    expect(requestedHrefs(fetch).some((href) => href.includes('cdn.example'))).toBe(false);
  });
});
