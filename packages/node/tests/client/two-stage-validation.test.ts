import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient, type ClientCache } from '../../src/client/index.js';
import { createValidatorRegistry, validateWireDocument } from '../../src/schema/index.js';

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';

async function fixture(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as Record<string, any>;
}

function clientFor(manifest: unknown, snapshot?: unknown): ColpClient {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/.well-known/collection-protocol') return Response.json(manifest);
    if (snapshot === undefined) throw new Error(`Unexpected request for ${url.href}`);
    return Response.json(snapshot, { headers: { ETag: '"snapshot-1"' } });
  });
  return new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });
}

describe('two-stage wire validation', () => {
  it('accepts a structurally and semantically valid Snapshot [evidence:core.two-stage-validation]', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = await fixture('collection-snapshot.json');

    await expect(clientFor(manifest, snapshot).getSnapshot(collectionId)).resolves.toMatchObject({
      collection: { id: collectionId },
      complete: true,
    });
  });

  it('does not execute semantics when structural validation fails [evidence:core.two-stage-validation]', () => {
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const result = validateWireDocument(
      createValidatorRegistry(),
      'manifest',
      { protocol: 'collection-protocol' },
      semantics,
    );

    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    expect(semantics).not.toHaveBeenCalled();
  });

  it('rejects a structurally valid but semantically invalid Snapshot [evidence:core.two-stage-validation]', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = await fixture('collection-snapshot.json');
    snapshot.collection.rootNodeId = 'missing-root';

    await expect(clientFor(manifest, snapshot).getSnapshot(collectionId)).rejects.toThrow(
      'Snapshot semantic validation failed',
    );
  });

  it('reports Snapshot format failure before a simultaneous semantic failure [evidence:core.two-stage-validation]', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = await fixture('collection-snapshot.json');
    snapshot.generatedAt = 'not-an-rfc3339-date-time';
    snapshot.collection.rootNodeId = 'missing-root';

    const receive = clientFor(manifest, snapshot).getSnapshot(collectionId);

    await expect(receive).rejects.toThrow('Response does not satisfy snapshot');
    await expect(receive).rejects.not.toThrow('semantic validation failed');
  });

  it('rejects an unknown Snapshot core field structurally before semantics [evidence:schema.unknown-fields]', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = await fixture('collection-snapshot.json');
    snapshot.futureCoreField = true;
    snapshot.collection.rootNodeId = 'missing-root';

    const receive = clientFor(manifest, snapshot).getSnapshot(collectionId);

    await expect(receive).rejects.toThrow('Response does not satisfy snapshot');
    await expect(receive).rejects.not.toThrow('semantic validation failed');
  });

  it('does not cache a wire document until semantic validation succeeds [evidence:core.two-stage-validation]', async () => {
    const manifest = await fixture('public-manifest.json');
    manifest.mounts[0].endpoints.node = 'https://alice.example/n/{annotationId}';
    const cache: ClientCache = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const fetch = vi.fn(async () =>
      Response.json(manifest, { headers: { ETag: '"invalid-manifest"' } }),
    );
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      cache,
    });

    await expect(client.discover()).rejects.toThrow('Manifest semantic validation failed');
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('semantically validates every Snapshot page before following the next link [evidence:core.two-stage-validation]', async () => {
    const manifest = await fixture('public-manifest.json');
    const firstPage = await fixture('collection-snapshot.json');
    firstPage.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    firstPage.nodes[1]!.parentId = firstPage.nodes[1]!.id;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return Response.json(manifest);
      return Response.json(firstPage, {
        headers: {
          ETag: '"snapshot-page-1"',
          Link: '<https://alice.example/page?pageCursor=page-2>; rel="next"',
        },
      });
    });
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

    await expect(client.getSnapshot(collectionId)).rejects.toThrow('Snapshot semantic validation failed');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
