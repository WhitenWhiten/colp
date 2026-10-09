import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ColpClient } from '../../src/client/index.js';
import type { Snapshot } from '../../src/types/index.js';

const fixtures = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const publicOrigin = 'https://alice.example';
const manifestPath = '/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const fixture = (name: string) => readFile(resolve(fixtures, name), 'utf8');

async function clientFor(callerOrigin: string, endpointOrigin: string, allowedOrigins: readonly string[] = []) {
  const manifest = (await fixture('public-manifest.json')).replaceAll(publicOrigin, endpointOrigin);
  const directory = await fixture('collection-directory.json');
  const manifestUrl = callerOrigin + manifestPath;
  const credentials = vi.fn((_url: URL) => ({ Authorization: 'Bearer fixture-only' }));
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return new Response(url.href === manifestUrl ? manifest : directory, {
      headers: { 'Content-Type': 'application/json', ETag: '"security-fixture"' },
    });
  });
  const client = new ColpClient({
    manifestUrl,
    fetch: fetch as typeof globalThis.fetch,
    credentialProvider: credentials,
    ...(allowedOrigins.length > 0 ? {
      egressPolicy: (url: URL) => allowedOrigins.includes(url.origin),
    } : {}),
  });
  return { client, fetch, credentials, manifestUrl };
}

describe('Manifest-selected initial endpoint security', () => {
  it.each([
    'https://127.0.0.1', 'https://localhost', 'https://10.0.0.1',
    'https://192.168.1.10', 'https://169.254.169.254', 'https://[::1]',
  ])('blocks initial reads and writes to %s before credentials or fetch', async endpointOrigin => {
    for (const operation of ['read', 'write'] as const) {
      const { client, fetch, credentials, manifestUrl } = await clientFor(publicOrigin, endpointOrigin);
      const snapshot = JSON.parse(await fixture('collection-snapshot.json')) as Snapshot;
      const result = operation === 'read'
        ? client.getDirectory()
        : client.createNode(collectionId, {
          parentId: snapshot.collection.rootNodeId,
          node: { kind: 'bookmark', title: 'test', url: 'https://example.test/bookmark' },
        }, { idempotencyKey: 'private-endpoint-regression' });
      await expect(result).rejects.toThrow(/literal private or local host/);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(credentials.mock.calls.map(([url]) => url.href)).toEqual([manifestUrl]);
    }
  });

  it('retains same-origin local development only when that origin was selected by the caller', async () => {
    const { client, fetch } = await clientFor('https://127.0.0.1:7443', 'https://127.0.0.1:7443', ['https://127.0.0.1:7443']);
    await expect(client.getDirectory()).resolves.toMatchObject({ collections: expect.any(Array) });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not let a local Manifest grant authority to another local port', async () => {
    const { client, fetch } = await clientFor('https://127.0.0.1:7443', 'https://127.0.0.1:7444', ['https://127.0.0.1:7443']);
    await expect(client.getDirectory()).rejects.toThrow(/literal private or local host/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit caller policy for a vetted private endpoint', async () => {
    const { client, fetch } = await clientFor(publicOrigin, 'https://10.0.0.1', [publicOrigin, 'https://10.0.0.1']);
    await expect(client.getDirectory()).resolves.toMatchObject({ collections: expect.any(Array) });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects a public cross-origin publisher endpoint before sending body or obtaining credentials', async () => {
    const manifest = JSON.parse(await fixture('public-manifest.json'));
    manifest.mounts[0].endpoints.nodes = manifest.mounts[0].endpoints.nodes.replace(publicOrigin, 'https://attacker.example');
    const fetch = vi.fn(async () => Response.json(manifest));
    const credentials = vi.fn(() => ({ Authorization: 'Bearer fixture-only' }));
    const client = new ColpClient({ manifestUrl: publicOrigin + manifestPath,
      fetch, credentialProvider: credentials });
    const snapshot = JSON.parse(await fixture('collection-snapshot.json')) as Snapshot;
    await expect(client.createNode(collectionId, {
      parentId: snapshot.collection.rootNodeId,
      node: { kind: 'bookmark', title: 'Private draft', url: 'https://example.test/private' },
    }, { idempotencyKey: 'cross-origin-write' })).rejects.toThrow(/Mount origin/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(credentials).toHaveBeenCalledTimes(1);
  });

});
