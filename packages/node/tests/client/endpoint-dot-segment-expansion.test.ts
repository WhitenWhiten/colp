import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ColpClient } from '../../src/client/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import { expandPublicationEndpointTemplate } from '../../src/semantic/index.js';
import type { Manifest, Snapshot } from '../../src/types/index.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(
  new URL(`../../fixtures/protocol/examples/${name}`, import.meta.url), 'utf8')) as T;
const manifest = fixture<Manifest>('public-manifest.json');
const snapshot = fixture<Snapshot>('collection-snapshot.json');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const validators = createValidatorRegistry();
const AUTHORIZATION = 'Bearer dot-segment-regression';
const dotSegmentError = /path segment/u;

const movePayload = { newParentId: 'root', baseSourceParentRevision: 'r1', baseTargetParentRevision: 'r1' };
const moveOptions = { idempotencyKey: 'dot-segment-move', ifMatch: '"r1"' };
const createPayload = { parentId: 'root',
  node: { kind: 'bookmark' as const, title: 'Created', url: 'https://example.test/' } };

describe('opaque IDs remain valid wire IDs', () => {
  it.each(['.', '..'])('the opaque ID grammar still accepts %j', (id) => {
    expect(validators.validate('opaqueId', id).valid).toBe(true);
  });
});

describe('publication endpoint expansion never lets URL normalization drop a variable segment', () => {
  const collection = 'https://alice.example/collections/c/{collectionId}';
  const snapshotTemplate = 'https://alice.example/collections/c/{collectionId}/snapshot';

  it.each([
    ['collection', collection, '.'],
    ['collection', collection, '..'],
    ['snapshot', snapshotTemplate, '.'],
    ['snapshot', snapshotTemplate, '..'],
    ['collection', 'https://alice.example/collections/c/.{collectionId}', '.'],
    ['collection', 'https://alice.example/collections/c/%2e{collectionId}', '.'],
    ['collection', 'https://alice.example/collections/c/{collectionId}%2E', '.'],
  ] as const)('rejects %s template %s with ID %j before building a URL', (endpoint, template, id) => {
    expect(() => expandPublicationEndpointTemplate(endpoint, template, { collectionId: id }, validators))
      .toThrow(TypeError);
    expect(() => expandPublicationEndpointTemplate(endpoint, template, { collectionId: id }, validators))
      .toThrow(dotSegmentError);
  });

  it.each([
    [collection, 'a.b', 'https://alice.example/collections/c/a.b'],
    [collection, '...', 'https://alice.example/collections/c/...'],
    [collection, '.x', 'https://alice.example/collections/c/.x'],
    [collection, 'x..', 'https://alice.example/collections/c/x..'],
    ['https://alice.example/collections/c/~{collectionId}', '..', 'https://alice.example/collections/c/~..'],
    ['https://alice.example/collections/c/~{collectionId}', '.', 'https://alice.example/collections/c/~.'],
    ['https://alice.example/collections/c/{collectionId}.json', '.', 'https://alice.example/collections/c/..json'],
    ['https://alice.example/collections/c/{collectionId}.json', '..', 'https://alice.example/collections/c/...json'],
    ['https://alice.example/collections/c?id={collectionId}', '..', 'https://alice.example/collections/c?id=..'],
    ['https://alice.example/collections/c?id={collectionId}', '.', 'https://alice.example/collections/c?id=.'],
  ] as const)('keeps %s with ID %j addressable as %s', (template, id, expected) => {
    expect(expandPublicationEndpointTemplate('collection', template, { collectionId: id }, validators).href)
      .toBe(expected);
  });

  it('judges only variable output, not literal template text', () => {
    expect(expandPublicationEndpointTemplate('collection',
      'https://alice.example/collections/../c/{collectionId}', { collectionId: 'x' }, validators).href)
      .toBe('https://alice.example/c/x');
  });
});

interface SentRequest { readonly url: string; readonly method: string | undefined; readonly authorization: string | null }

function recordingClient(manifestDocument: Manifest = manifest, respond?: (url: string) => Response) {
  const sent: SentRequest[] = [];
  const client = new ColpClient({
    manifestUrl,
    headers: { authorization: AUTHORIZATION },
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === manifestUrl) return Response.json(manifestDocument);
      sent.push({ url, method: init?.method, authorization: new Headers(init?.headers).get('authorization') });
      return respond?.(url) ?? new Response('unexpected dispatch', { status: 500 });
    },
  });
  return { client, sent };
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(() => undefined, (error: unknown) => error);
}

function expectDotSegmentRejection(error: unknown): void {
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toMatch(dotSegmentError);
}

describe('ColpClient refuses dot-segment IDs before dispatch or credential attachment', () => {
  it.each(['.', '..'])('getCollection(%j) sends nothing beyond discovery', async (id) => {
    const { client, sent } = recordingClient();
    const errors = [await rejection(client.getCollection(id)), await rejection(client.getSnapshot(id))];
    // Checked first so a regression shows exactly which URL was requested instead.
    expect(sent).toEqual([]);
    errors.forEach(expectDotSegmentRejection);
  });

  it.each(['.', '..'])('moveNode with nodeId %j is not retargeted to another resource', async (id) => {
    const { client, sent } = recordingClient();
    const error = await rejection(client.moveNode('target', id, movePayload, moveOptions));
    expect(sent).toEqual([]);
    expectDotSegmentRejection(error);
  });

  it.each(['.', '..'])('collection-scoped writes with collectionId %j send nothing', async (id) => {
    const { client, sent } = recordingClient();
    const errors = [
      await rejection(client.moveNode(id, 'node', movePayload, moveOptions)),
      await rejection(client.createNode(id, createPayload, { idempotencyKey: 'dot-segment-create' })),
    ];
    expect(sent).toEqual([]);
    errors.forEach(expectDotSegmentRejection);
  });

  it.each([
    ['sentinel-bound', 'https://alice.example/collections/c/{collectionId}/nodes/~{nodeId}/move',
      'https://alice.example/collections/c/target/nodes/~../move'],
    ['query-bound', 'https://alice.example/collections/c/{collectionId}/move?node={nodeId}',
      'https://alice.example/collections/c/target/move?node=..'],
  ])('still writes a dot ID through a %s publisher template to the exact resource', async (_layout, template, expectedUrl) => {
    const layoutManifest = structuredClone(manifest);
    (layoutManifest.mounts[0]!.endpoints as Record<string, string>).nodeMove = template;
    const moved = { ...snapshot.nodes[1]!, id: '..', collectionId: 'target', parentId: 'root' };
    const result = { node: moved, position: moved.position,
      sourceParentRevision: 'r2', targetParentRevision: 'r3', warnings: [] };
    const { client, sent } = recordingClient(layoutManifest,
      () => Response.json(result, { headers: { ETag: '"r2"' } }));
    await expect(client.moveNode('target', '..', movePayload, moveOptions)).resolves.toEqual(result);
    expect(sent).toEqual([{ url: expectedUrl, method: 'POST', authorization: AUTHORIZATION }]);
  });
});
