import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient, type ClientCache, type ClientCacheEntry } from '../../src/client/index.js';
import { evaluatePublicationConditionalGet } from '../../src/server/index.js';

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';

async function fixture(name: string): Promise<string> {
  return readFile(resolve(fixturesRoot, name), 'utf8');
}

function memoryCache(): ClientCache {
  const values = new Map<string, ClientCacheEntry>();
  return {
    get: (key) => values.get(key),
    set: (key, value) => { values.set(key, value); },
    delete: (key) => { values.delete(key); },
  };
}

function jsonResponse(body: string, etag?: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (etag !== undefined) headers.set('ETag', etag);
  return new Response(body, { ...init, headers });
}

describe('PUB-0022 If-None-Match client cache contract [evidence:http.conditional]', () => {
  it('interoperates end-to-end with the server conditional evaluator', async () => {
    const [manifest, directory] = await Promise.all([fixture('public-manifest.json'), fixture('collection-directory.json')]);
    // Comma is legal etagc inside the quoted opaque-tag and must not be
    // mistaken for an If-None-Match list separator.
    const directoryEtag = '"directory,v1"';
    const validators: Array<string | null> = [];
    let directoryCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return jsonResponse(manifest, '"manifest-v1"');

      directoryCalls += 1;
      const ifNoneMatch = new Headers(init?.headers).get('If-None-Match');
      validators.push(ifNoneMatch);
      if (directoryCalls === 1) return jsonResponse(directory, directoryEtag);

      const decision = evaluatePublicationConditionalGet({ etag: directoryEtag, ifNoneMatch });
      expect(decision.status).toBe(304);
      return new Response(null, { status: decision.status, headers: { ETag: directoryEtag } });
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      cache: memoryCache(),
    });

    const first = await client.getDirectory();
    const second = await client.getDirectory();

    expect(validators).toEqual([null, directoryEtag]);
    expect(validators[1]).not.toMatch(/^W\//u);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('sends the exact cached ETag, accepts matching 304, and detaches the value', async () => {
    const [manifest, directory] = await Promise.all([fixture('public-manifest.json'), fixture('collection-directory.json')]);
    const cache = memoryCache();
    let directoryCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return jsonResponse(manifest, '"manifest-v1"');
      directoryCalls += 1;
      if (directoryCalls === 1) return jsonResponse(directory, '"directory-v1"');
      expect(new Headers(init?.headers).get('If-None-Match')).toBe('"directory-v1"');
      return new Response(null, { status: 304, headers: { ETag: '"directory-v1"' } });
    });
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch, cache });

    const first = await client.getDirectory();
    first.collections[0]!.title = 'caller mutation';
    const second = await client.getDirectory();

    expect(second.collections[0]!.title).not.toBe('caller mutation');
    expect(second).not.toBe(first);
    expect(directoryCalls).toBe(2);
  });

  it('fails closed for 304 without cache and for a mismatched validator without reflecting the tag', async () => {
    const [manifest, directory] = await Promise.all([fixture('public-manifest.json'), fixture('collection-directory.json')]);
    const noCacheFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? jsonResponse(manifest, '"manifest-v1"')
        : new Response(null, { status: 304, headers: { ETag: '"orphan-v1"' } });
    });
    await expect(new ColpClient({ manifestUrl, fetch: noCacheFetch as typeof globalThis.fetch }).getDirectory())
      .rejects.toThrow('did not carry the cached If-None-Match');

    let calls = 0;
    const mismatchFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return jsonResponse(manifest, '"manifest-v1"');
      calls += 1;
      if (calls === 1) return jsonResponse(directory, '"directory-v1"');
      expect(new Headers(init?.headers).get('If-None-Match')).toBe('"directory-v1"');
      return new Response(null, { status: 304, headers: { ETag: '"attacker-secret"' } });
    });
    const client = new ColpClient({ manifestUrl, fetch: mismatchFetch as typeof globalThis.fetch, cache: memoryCache() });
    await client.getDirectory();
    const error = await client.getDirectory().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain('does not match the cached representation');
    expect((error as Error).message).not.toContain('attacker-secret');
  });

  it('does not create a validator from a response without ETag', async () => {
    const [manifest, directory] = await Promise.all([fixture('public-manifest.json'), fixture('collection-directory.json')]);
    const requests: Array<string | null> = [];
    let directoryCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return jsonResponse(manifest, '"manifest-v1"');
      requests.push(new Headers(init?.headers).get('If-None-Match'));
      directoryCalls += 1;
      return directoryCalls === 1
        ? jsonResponse(directory, '"directory-v1"')
        : jsonResponse(directory, undefined);
    });
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch, cache: memoryCache() });
    await client.getDirectory();
    await expect(client.getDirectory()).rejects.toThrow('required ETag');
    expect(requests).toEqual([null, '"directory-v1"']);
  });

  it('partitions cache by query and keeps credentials and static headers origin-scoped across redirects', async () => {
    const [manifest, directory] = await Promise.all([fixture('public-manifest.json'), fixture('collection-directory.json')]);
    const requests: Array<{ url: string; headers: Headers; credentials: RequestInit['credentials'] }> = [];
    const policy = vi.fn(() => true);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({ url: url.href, headers: new Headers(init?.headers), credentials: init?.credentials ?? 'same-origin' });
      if (url.pathname === '/.well-known/collection-protocol') return jsonResponse(manifest, '"manifest-v1"');
      if (url.origin === 'https://alice.example') return new Response(null, { status: 302, headers: { Location: 'https://cdn.example/catalog' } });
      return jsonResponse(directory, '"cdn-v1"');
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      cache: memoryCache(),
      headers: { 'X-Static': 'allowed-only-at-trusted-origin' },
      credentialProvider: () => ({ Authorization: 'Bearer principal' }),
      egressPolicy: policy,
    });
    await client.getDirectory({ tag: 'one' });

    const publication = requests.filter((request) => !request.url.includes('.well-known'));
    expect(publication[0]!.headers.get('X-Static')).toBe('allowed-only-at-trusted-origin');
    expect(publication[0]!.headers.get('Authorization')).toBe('Bearer principal');
    expect(publication[1]!.headers.get('X-Static')).toBeNull();
    expect(publication[1]!.headers.get('Authorization')).toBe('Bearer principal');
    expect(publication[1]!.credentials).toBe('omit');
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({ origin: 'https://cdn.example' }), expect.objectContaining({ redirectCount: 1 }));
  });

  it('uses distinct cache validators for distinct query variants', async () => {
    const [manifest, directory] = await Promise.all([fixture('public-manifest.json'), fixture('collection-directory.json')]);
    const seen: Array<{ query: string; validator: string | null }> = [];
    const etags = new Map<string, string>();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return jsonResponse(manifest, '"manifest-v1"');
      const query = url.search;
      const validator = new Headers(init?.headers).get('If-None-Match');
      seen.push({ query, validator });
      const etag = etags.get(query) ?? `"${query === '?tag=one' ? 'one' : 'two'}"`;
      if (!etags.has(query)) { etags.set(query, etag); return jsonResponse(directory, etag); }
      expect(validator).toBe(etag);
      return new Response(null, { status: 304, headers: { ETag: etag } });
    });
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch, cache: memoryCache() });
    await client.getDirectory({ tag: 'one' });
    await client.getDirectory({ tag: 'two' });
    await client.getDirectory({ tag: 'one' });
    expect(seen.map((entry) => entry.validator)).toEqual([null, null, '"one"']);
  });
});
