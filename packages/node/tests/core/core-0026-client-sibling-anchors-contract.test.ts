import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildCreateNodePayload,
  buildMoveNodePayload,
  ColpClient,
  createUrlHash,
} from '../../src/client/index.js';
import type {
  CreateNodeOperationPayload,
  MoveOperationPayload,
} from '../../src/types/index.js';
import { problemJsonResponse, protocolJsonResponse } from '../helpers/http-responses.js';

const evidence = '[evidence:core.client-sibling-anchors]';
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const collectionId = 'collection-anchors';
const nodeId = 'node-moving';
const idempotencyKey = 'idem-core-0026';

type JsonRecord = Record<string, unknown>;

const placements = [
  ['after a sibling', { afterId: 'node-a' }],
  ['before a sibling', { beforeId: 'node-b' }],
  ['at the beginning', { afterId: null, beforeId: 'node-first' }],
  ['at the end', { afterId: 'node-last', beforeId: null }],
  ['with explicit null boundaries', { afterId: null, beforeId: null }],
  ['at the omitted-anchor append boundary', {}],
] as const;

const invalidAnchors = [
  ['empty ID', ''],
  ['ID containing a slash', 'node/a'],
  ['non-string scalar', 7],
] as const;

const invalidAnchorCases = (['create', 'move'] as const).flatMap((operation) =>
  (['afterId', 'beforeId'] as const).flatMap((anchor) =>
    invalidAnchors.map(([label, invalid]) => [operation, anchor, label, invalid] as const),
  ),
);

async function manifest(): Promise<string> {
  return readFile(
    resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'public-manifest.json'),
    'utf8',
  );
}

function createdNode(position = 'server-position'): JsonRecord {
  return {
    id: 'node-created',
    collectionId,
    kind: 'bookmark',
    parentId: 'root-1',
    position,
    title: 'Anchored node',
    url: 'https://example.com/anchored',
    createdAt: '2026-07-17T00:00:00Z',
    updatedAt: '2026-07-17T00:00:00Z',
    revision: 'node-r-1',
  };
}

function moveResult(position = 'server-move-position'): JsonRecord {
  return {
    node: {
      ...createdNode(position),
      id: nodeId,
      parentId: 'folder-target',
      revision: 'node-r-2',
    },
    sourceParentRevision: 'children-source-r-2',
    targetParentRevision: 'children-target-r-2',
    position,
    warnings: [],
  };
}

function createPayload(anchors: JsonRecord = {}): CreateNodeOperationPayload {
  return {
    parentId: 'root-1',
    ...anchors,
    node: {
      kind: 'bookmark',
      title: 'Anchored node',
      url: 'https://example.com/anchored',
    },
  } as CreateNodeOperationPayload;
}

function movePayload(anchors: JsonRecord = {}): MoveOperationPayload {
  return {
    newParentId: 'folder-target',
    ...anchors,
    baseSourceParentRevision: 'children-source-r-1',
    baseTargetParentRevision: 'children-target-r-1',
  } as MoveOperationPayload;
}

async function harness(response: (url: URL) => Response): Promise<{
  readonly client: ColpClient;
  readonly writes: JsonRecord[];
  readonly writeHeaders: Headers[];
  readonly fetch: ReturnType<typeof vi.fn>;
}> {
  const manifestDocument = await manifest();
  const writes: JsonRecord[] = [];
  const writeHeaders: Headers[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href === manifestUrl) return protocolJsonResponse(manifestDocument);
    writes.push(JSON.parse(String(init?.body)) as JsonRecord);
    writeHeaders.push(new Headers(init?.headers));
    return response(url);
  });
  return {
    client: new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }),
    writes,
    writeHeaders,
    fetch,
  };
}

describe(`CORE-0026 client sibling-anchor writes ${evidence}`, () => {
  it.each([
    ['generic JSON', 'application/json'],
    ['registered Node vendor JSON', 'application/vnd.collection-protocol.node+json;version=0.1'],
  ])('accepts %s for a Publisher create result', async (_name, contentType) => {
    const { client } = await harness(() => protocolJsonResponse(createdNode(), {
      status: 201,
      headers: {
        'Content-Type': contentType,
        ETag: '"node-r-1"',
        Location: '/nodes/node-created',
      },
    }));

    await expect(client.createNode(collectionId, createPayload(), { idempotencyKey }))
      .resolves.toMatchObject({ id: 'node-created', revision: 'node-r-1' });
  });

  it('rejects an invalid Publisher success media type and cancels its unread body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(createdNode())));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { client } = await harness(() => new Response(body, {
      status: 201,
      headers: {
        'Content-Type': 'text/plain',
        ETag: '"node-r-1"',
        Location: '/nodes/node-created',
      },
    }));

    await expect(client.createNode(collectionId, createPayload(), { idempotencyKey }))
      .rejects.toMatchObject({ stage: 'parse', definition: 'node' });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it.each(placements)('submits create placement %s without inventing Position', async (_label, anchors) => {
    const { client, writes, writeHeaders } = await harness((url) => {
      expect(url.pathname).toBe(`/collections/c/${collectionId}/nodes`);
      return Response.json(createdNode(), {
        status: 201,
        headers: { ETag: '"node-r-1"', Location: `/nodes/node-created` },
      });
    });

    const result = await client.createNode(collectionId, createPayload(anchors), { idempotencyKey });

    expect(writes).toEqual([createPayload(anchors)]);
    expect(writes[0]).not.toHaveProperty('position');
    expect((writes[0]?.node as JsonRecord)).not.toHaveProperty('position');
    expect(writeHeaders[0]?.get('idempotency-key')).toBe(idempotencyKey);
    expect(writeHeaders[0]?.get('content-type')).toBe('application/json');
    expect(result).toMatchObject({ position: 'server-position' });
  });

  it.each(placements)('submits move placement %s without inventing Position', async (_label, anchors) => {
    const { client, writes, writeHeaders } = await harness((url) => {
      expect(url.pathname).toBe(`/collections/c/${collectionId}/nodes/${nodeId}/move`);
      return Response.json(moveResult(), {
        status: 200,
        headers: { ETag: '"node-r-2"' },
      });
    });

    const result = await client.moveNode(collectionId, nodeId, movePayload(anchors), {
      idempotencyKey,
      ifMatch: '"node-r-1"',
    });

    expect(writes).toEqual([movePayload(anchors)]);
    expect(writes[0]).not.toHaveProperty('position');
    expect(writeHeaders[0]?.get('idempotency-key')).toBe(idempotencyKey);
    expect(writeHeaders[0]?.get('if-match')).toBe('"node-r-1"');
    expect(result).toMatchObject({ position: 'server-move-position' });
  });

  it('rejects a mismatched create URL hash before discovery or write I/O', async () => {
    const fetch = vi.fn();
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });
    const payload = createPayload();
    (payload.node as unknown as Record<string, unknown>).urlHash = createUrlHash(
      'https://example.com/different',
    );

    await expect(client.createNode(collectionId, payload, { idempotencyKey }))
      .rejects.toThrow('semantic validation failed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['create', 'move'] as const)('rejects a mismatched URL hash in the %s response', async (operation) => {
    const responseNode = createdNode() as Record<string, any>;
    responseNode.urlHash = createUrlHash('https://example.com/different');
    const { client } = await harness(() => Response.json(
      operation === 'create'
        ? responseNode
        : { ...moveResult(), node: { ...responseNode, id: nodeId } },
      {
        status: operation === 'create' ? 201 : 200,
        headers: operation === 'create'
          ? { ETag: '"node-r-1"', Location: '/nodes/node-created' }
          : { ETag: '"node-r-2"' },
      },
    ));

    const pending = operation === 'create'
      ? client.createNode(collectionId, createPayload(), { idempotencyKey })
      : client.moveNode(collectionId, nodeId, movePayload(), {
          idempotencyKey,
          ifMatch: '"node-r-1"',
        });
    await expect(pending).rejects.toThrow('semantic validation failed');
  });

  it.each(invalidAnchorCases)(
    'rejects %s %s with %s before write I/O',
    async (operation, anchor, _label, invalid) => {
      const { client, writes } = await harness(() => {
        throw new Error('invalid anchor reached the write transport');
      });
      const request = operation === 'create'
        ? createPayload({ [anchor]: invalid })
        : movePayload({ [anchor]: invalid });

      const pending = operation === 'create'
        ? client.createNode(collectionId, request as CreateNodeOperationPayload, { idempotencyKey })
        : client.moveNode(collectionId, nodeId, request as MoveOperationPayload, {
            idempotencyKey,
            ifMatch: '"node-r-1"',
          });

      await expect(pending).rejects.toBeInstanceOf(TypeError);
      expect(writes).toEqual([]);
    },
  );

  it.each(['create', 'move'] as const)(
    'leaves conflicting %s sibling context to the authoritative server',
    async (operation) => {
      const problem = {
        type: 'https://know-n.com/colp/problems/position-context-stale',
        title: 'Sibling position context is stale',
        status: 409,
        code: 'position_context_stale',
      };
      const { client, writes } = await harness(() => problemJsonResponse(problem, { status: 409 }));
      const anchors = { afterId: 'node-a', beforeId: 'node-z' };

      const pending = operation === 'create'
        ? client.createNode(collectionId, createPayload(anchors), { idempotencyKey })
        : client.moveNode(collectionId, nodeId, movePayload(anchors), {
            idempotencyKey,
            ifMatch: '"node-r-1"',
          });

      await expect(pending).rejects.toMatchObject({
        problem: expect.objectContaining({ code: 'position_context_stale' }),
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject(anchors);
    },
  );

  it.each(
    (['create', 'move'] as const).flatMap((operation) =>
      ([301, 302, 303] as const).map((status) => [operation, status] as const),
    ),
  )('does not replay a %s write after unsafe HTTP %i redirect', async (operation, status) => {
    const { client, writes, fetch } = await harness(() => new Response(null, {
      status,
      headers: { Location: '/unsafe-write-target' },
    }));

    const pending = operation === 'create'
      ? client.createNode(collectionId, createPayload({ afterId: 'node-a' }), { idempotencyKey })
      : client.moveNode(collectionId, nodeId, movePayload({ beforeId: 'node-b' }), {
          idempotencyKey,
          ifMatch: '"node-r-1"',
        });

    await expect(pending).rejects.toThrow(
      `non-method-preserving HTTP ${status} redirect`,
    );
    expect(writes).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(
    (['create', 'move'] as const).flatMap((operation) =>
      ([307, 308] as const).map((status) => [operation, status] as const),
    ),
  )('replays a %s write after safe same-origin HTTP %i redirect', async (operation, status) => {
    const redirectTarget = '/safe-write-target';
    const { client, writes, writeHeaders } = await harness((url) => url.pathname === redirectTarget
      ? Response.json(operation === 'create' ? createdNode() : moveResult(), {
          status: operation === 'create' ? 201 : 200,
          headers: operation === 'create'
            ? { ETag: '"node-r-1"', Location: '/nodes/node-created' }
            : { ETag: '"node-r-2"' },
        })
      : new Response(null, { status, headers: { Location: redirectTarget } }));
    const payload = operation === 'create'
      ? createPayload({ afterId: 'node-a' })
      : movePayload({ beforeId: 'node-b' });

    if (operation === 'create') {
      await client.createNode(collectionId, payload as CreateNodeOperationPayload, { idempotencyKey });
    } else {
      await client.moveNode(collectionId, nodeId, payload as MoveOperationPayload, {
        idempotencyKey,
        ifMatch: '"node-r-1"',
      });
    }

    expect(writes).toEqual([payload, payload]);
    expect(writeHeaders).toHaveLength(2);
    expect(writeHeaders[1]?.get('idempotency-key')).toBe(idempotencyKey);
    expect(writeHeaders[1]?.get('content-type')).toBe('application/json');
    expect(writeHeaders[1]?.get('if-match')).toBe(operation === 'move' ? '"node-r-1"' : null);
  });

  it.each(['create', 'move'] as const)('rejects equal %s anchors before discovery', async (operation) => {
    const fetch = vi.fn();
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });
    const anchors = { afterId: 'node-same', beforeId: 'node-same' };
    const pending = operation === 'create'
      ? client.createNode(collectionId, createPayload(anchors), { idempotencyKey })
      : client.moveNode(collectionId, nodeId, movePayload(anchors), {
          idempotencyKey,
          ifMatch: '"node-r-1"',
        });

    await expect(pending).rejects.toThrow('cannot identify the same Node');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['create', 'move'] as const)('rejects an unexpected %s payload property', async (operation) => {
    const fetch = vi.fn();
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });
    const request = {
      ...(operation === 'create' ? createPayload() : movePayload()),
      unexpected: true,
    };
    const pending = operation === 'create'
      ? client.createNode(collectionId, request as CreateNodeOperationPayload, { idempotencyKey })
      : client.moveNode(collectionId, nodeId, request as MoveOperationPayload, {
          idempotencyKey,
          ifMatch: '"node-r-1"',
        });

    await expect(pending).rejects.toBeInstanceOf(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('detaches and deeply freezes create payloads without changing omitted anchors', () => {
    const source = createPayload();
    const built = buildCreateNodePayload(source);
    (source.node as { title: string }).title = 'Mutated later';

    expect(built).not.toBe(source);
    expect(built.node).not.toBe(source.node);
    expect(built.node.title).toBe('Anchored node');
    expect(built).not.toHaveProperty('afterId');
    expect(built).not.toHaveProperty('beforeId');
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.node)).toBe(true);
  });

  it('detaches and freezes move payloads while preserving explicit null anchors', () => {
    const source = movePayload({ afterId: null, beforeId: null });
    const built = buildMoveNodePayload(source);

    expect(built).not.toBe(source);
    expect(built).toMatchObject({ afterId: null, beforeId: null });
    expect(Object.isFrozen(built)).toBe(true);
  });

  it('rejects non-JSON members instead of silently dropping them', () => {
    const source = { ...createPayload(), ignoredByStringify: undefined };
    expect(() => buildCreateNodePayload(source as unknown as CreateNodeOperationPayload))
      .toThrow(/strict JSON data/u);
  });

  it('does not execute toJSON hooks or accessors while cloning placement payloads', () => {
    const toJson = vi.fn(() => createPayload());
    const withHook = Object.assign(createPayload(), { toJSON: toJson });
    expect(() => buildCreateNodePayload(withHook as unknown as CreateNodeOperationPayload))
      .toThrow(/strict JSON data/u);
    expect(toJson).not.toHaveBeenCalled();

    const getter = vi.fn(() => 'forged title');
    const withAccessor = createPayload() as unknown as JsonRecord;
    Object.defineProperty(withAccessor.node, 'title', { enumerable: true, get: getter });
    expect(() => buildCreateNodePayload(withAccessor as unknown as CreateNodeOperationPayload))
      .toThrow(/strict JSON data/u);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects cyclic placement payloads before schema validation', () => {
    const source = createPayload() as unknown as JsonRecord;
    source.cycle = source;
    expect(() => buildCreateNodePayload(source as unknown as CreateNodeOperationPayload))
      .toThrow(/cyclic references/u);
  });

  it.each([
    ['create request envelope', 'create', (request: JsonRecord) => ({ ...request, position: 'client-position' })],
    ['create node DTO', 'create', (request: JsonRecord) => ({
      ...request,
      node: { ...(request.node as JsonRecord), position: 'client-position' },
    })],
    ['move request envelope', 'move', (request: JsonRecord) => ({ ...request, position: 'client-position' })],
  ] as const)('rejects client-supplied Position in the %s', async (_label, operation, addPosition) => {
    const { client, writes } = await harness(() => {
      throw new Error('client-supplied Position reached the write transport');
    });
    const request = addPosition(
      (operation === 'create' ? createPayload() : movePayload()) as unknown as JsonRecord,
    );

    const pending = operation === 'create'
      ? client.createNode(collectionId, request as unknown as CreateNodeOperationPayload, { idempotencyKey })
      : client.moveNode(collectionId, nodeId, request as unknown as MoveOperationPayload, {
          idempotencyKey,
          ifMatch: '"node-r-1"',
        });

    await expect(pending).rejects.toBeInstanceOf(TypeError);
    expect(writes).toEqual([]);
  });
});
