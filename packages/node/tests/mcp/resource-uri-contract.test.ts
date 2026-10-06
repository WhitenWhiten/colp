import { describe, expect, it } from 'vitest';

import { createMcpResourceUriCodec } from '../../src/mcp/resource-uri.js';


type McpReadResource =
  | { readonly kind: 'collection-metadata'; readonly collectionId: string }
  | { readonly kind: 'collection-snapshot'; readonly collectionId: string }
  | { readonly kind: 'collection-node'; readonly collectionId: string; readonly nodeId: string };

interface McpResourceUriCodec {
  readonly serverUuid: string;
  readonly collectionMetadata: (collectionId: string) => string;
  readonly collectionSnapshot: (collectionId: string) => string;
  readonly collectionNode: (collectionId: string, nodeId: string) => string;
  readonly parse: (uri: string) => McpReadResource;
}

const serverUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const otherServerUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77df';

function createCodec(actualServerUuid = serverUuid): McpResourceUriCodec {
  expect(typeof createMcpResourceUriCodec, 'MCP-0001 needs a read-only Resource URI codec').toBe('function');
  return createMcpResourceUriCodec({ serverUuid: actualServerUuid });
}

describe('MCP-0001 logical Resource URI contract [evidence:mcp.resource-uri]', () => {
  it('exposes a Manifest-bound codec at the MCP public boundary', () => {
    const codec = createCodec();

    expect(codec.serverUuid).toBe(serverUuid);
    expect(typeof codec.collectionMetadata).toBe('function');
    expect(typeof codec.collectionSnapshot).toBe('function');
    expect(typeof codec.collectionNode).toBe('function');
    expect(typeof codec.parse).toBe('function');
    expect(typeof createMcpResourceUriCodec).toBe('function');
  });

  it.each([
    [
      'metadata',
      (codec: McpResourceUriCodec) => codec.collectionMetadata('collection-1'),
      { kind: 'collection-metadata', collectionId: 'collection-1' },
      `colp://${serverUuid}/collections/collection-1`,
    ],
    [
      'Snapshot',
      (codec: McpResourceUriCodec) => codec.collectionSnapshot('collection-1'),
      { kind: 'collection-snapshot', collectionId: 'collection-1' },
      `colp://${serverUuid}/collections/collection-1/snapshot`,
    ],
    [
      'Node',
      (codec: McpResourceUriCodec) => codec.collectionNode('collection-1', 'node-1'),
      { kind: 'collection-node', collectionId: 'collection-1', nodeId: 'node-1' },
      `colp://${serverUuid}/collections/collection-1/nodes/node-1`,
    ],
  ] as const)('round-trips an exact, canonical %s identity', (_name, format, identity, expectedUri) => {
    const codec = createCodec();
    const uri = format(codec);

    expect(uri).toBe(expectedUri);
    expect(codec.parse(uri)).toEqual(identity);
  });

  it('keeps metadata, Snapshot, and Node identities mutually unambiguous', () => {
    const codec = createCodec();
    const uris = [
      codec.collectionMetadata('collection-1'),
      codec.collectionSnapshot('collection-1'),
      codec.collectionNode('collection-1', 'node-1'),
    ];

    expect(new Set(uris).size).toBe(3);
    expect(uris.map((uri) => codec.parse(uri).kind)).toEqual([
      'collection-metadata',
      'collection-snapshot',
      'collection-node',
    ]);
    expect(codec.parse(uris[0]!)).not.toHaveProperty('nodeId');
    expect(codec.parse(uris[1]!)).not.toHaveProperty('nodeId');
    expect(codec.parse(uris[2]!)).toHaveProperty('nodeId', 'node-1');
  });

  it('uses the actual stable Manifest serverUuid exactly and deterministically', () => {
    const first = createCodec();
    const second = createCodec();

    expect(first.collectionSnapshot('stable-collection')).toBe(
      second.collectionSnapshot('stable-collection'),
    );
    expect(first.collectionSnapshot('stable-collection')).toBe(
      `colp://${serverUuid}/collections/stable-collection/snapshot`,
    );
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('rejects a forged UUID authority even when it is otherwise valid', () => {
    const codec = createCodec();
    const forged = `colp://${otherServerUuid}/collections/collection-1/snapshot`;

    expect(() => codec.parse(forged)).toThrow();
  });

  it.each(['', '.', '..', 'invalid/authority', 'x'.repeat(129)])(
    'rejects an invalid or ambiguous Manifest serverUuid %j',
    (authority) => {
    expect(() => createCodec(authority)).toThrow();
    },
  );

  it.each(['server-identity', 'UPPER_case.~1'])(
    'preserves a valid opaque Manifest serverUuid exactly: %j',
    (authority) => {
      const codec = createCodec(authority);

      expect(codec.collectionMetadata('collection-1')).toBe(
        `colp://${authority}/collections/collection-1`,
      );
    },
  );

  it.each([
    ['missing Manifest', undefined],
    ['missing serverUuid', {}],
    ['null serverUuid', { serverUuid: null }],
  ] as const)('rejects malformed codec input: %s', (_name, manifest) => {
    expect(() => createMcpResourceUriCodec(
      manifest as unknown as { readonly serverUuid: string },
    )).toThrow();
  });

  it('accepts a full Manifest-shaped input but derives identity only from serverUuid', () => {
    const codec = createMcpResourceUriCodec({
      serverUuid,
      title: 'Mutable display name',
      apiKey: 'must-not-leak',
    } as { readonly serverUuid: string });

    expect(codec.collectionMetadata('collection-1')).toBe(
      `colp://${serverUuid}/collections/collection-1`,
    );
    expect(JSON.stringify(codec)).not.toContain('Mutable display name');
    expect(JSON.stringify(codec)).not.toContain('must-not-leak');
  });

  it('rejects an inherited authority instead of trusting the prototype chain', () => {
    const inherited = Object.create({ serverUuid }) as { readonly serverUuid: string };

    expect(() => createMcpResourceUriCodec(inherited)).toThrow();
  });

  it('rejects surplus constructor arguments, including a forged validator registry', () => {
    const acceptEverything = { validate: () => ({ valid: true, errors: [] }) };
    const create = createMcpResourceUriCodec as (...args: unknown[]) => McpResourceUriCodec;

    expect(() => create({ serverUuid: 'invalid/authority' }, acceptEverything)).toThrow();
    expect(() => create({ serverUuid }, acceptEverything)).toThrow();
  });

  it.each([
    `colp://${serverUuid}`,
    `colp://${serverUuid}/`,
    `colp://${serverUuid}/collections`,
    `colp://${serverUuid}/collections/`,
    `colp://${serverUuid}/collections/collection-1/nodes`,
    `colp://${serverUuid}/collections/collection-1/nodes/`,
  ])('rejects a URI with a missing path or parameter: %j', (uri) => {
    expect(() => createCodec().parse(uri)).toThrow();
  });

  it.each([
    `colp://${serverUuid}/unknown/collection-1`,
    `colp://${serverUuid}/Collections/collection-1`,
    `colp://${serverUuid}/collections/collection-1/unknown`,
    `colp://${serverUuid}/collections/collection-1/snapshot/extra`,
    `colp://${serverUuid}/collections/collection-1/nodes/node-1/extra`,
    `colp://${serverUuid}/collections/collection-1/nodes/node-1/snapshot`,
    `colp://${serverUuid}/collections/collection-1/write`,
    `colp://${serverUuid}/collections/collection-1/nodes/node-1/delete`,
  ])('rejects an unknown, extra, ambiguous, or write path: %j', (uri) => {
    expect(() => createCodec().parse(uri)).toThrow();
  });

  it.each([
    `colp://${serverUuid}/collections/collection%2Fchild`,
    `colp://${serverUuid}/collections/collection-1/nodes/node%2fchild`,
    `colp://${serverUuid}/collections/%2e%2e/snapshot`,
    `colp://${serverUuid}/collections/%63ollection-1`,
    `colp://${serverUuid}/collections/collection%252Fchild`,
    `colp://${serverUuid}/collections/collection%ZZ`,
  ])('rejects encoded slash, traversal, double encoding, or non-canonical encoding: %j', (uri) => {
    expect(() => createCodec().parse(uri)).toThrow();
  });

  it.each([
    `colp://${serverUuid}/collections/collection-1?cursor=x`,
    `colp://${serverUuid}/collections/collection-1#snapshot`,
    `colp://user@${serverUuid}/collections/collection-1`,
    `colp://${serverUuid}:443/collections/collection-1`,
    `COLP://${serverUuid}/collections/collection-1`,
    `https://${serverUuid}/collections/collection-1`,
    `//${serverUuid}/collections/collection-1`,
  ])('rejects URI components that can alter or obscure logical identity: %j', (uri) => {
    expect(() => createCodec().parse(uri)).toThrow();
  });

  it.each(['A', 'x'.repeat(128), 'opaque_ID-1.~'])('round-trips opaque ID boundaries %j', (id) => {
    const codec = createCodec();

    expect(codec.parse(codec.collectionMetadata(id))).toEqual({
      kind: 'collection-metadata',
      collectionId: id,
    });
    expect(codec.parse(codec.collectionNode(id, id))).toEqual({
      kind: 'collection-node',
      collectionId: id,
      nodeId: id,
    });
  });

  it.each(['', 'x'.repeat(129), '.', '..', 'a/b', 'a?b', 'a#b', 'a%b', 'a b', '\u00e9'])
    ('rejects invalid or ambiguous opaque ID %j', (id) => {
      const codec = createCodec();

      expect(() => codec.collectionMetadata(id)).toThrow();
      expect(() => codec.collectionSnapshot(id)).toThrow();
      expect(() => codec.collectionNode('collection-1', id)).toThrow();
    });

  it('rejects missing and surplus formatter parameters instead of changing their meaning', () => {
    const codec = createCodec();

    expect(() => (codec.collectionMetadata as (...args: unknown[]) => string)()).toThrow();
    expect(() => (codec.collectionNode as (...args: unknown[]) => string)('collection-1')).toThrow();
    expect(() => (codec.collectionMetadata as (...args: unknown[]) => string)(
      'collection-1',
      'node-1',
    )).toThrow();
    expect(() => (codec.collectionNode as (...args: unknown[]) => string)(
      'collection-1',
      'node-1',
      'extra',
    )).toThrow();
    expect(() => (codec.parse as (...args: unknown[]) => McpReadResource)()).toThrow();
    expect(() => (codec.parse as (...args: unknown[]) => McpReadResource)(
      codec.collectionMetadata('collection-1'),
      'extra',
    )).toThrow();
  });

  it('has a frozen read-only surface with no write path or API', () => {
    const codec = createCodec();

    expect(Object.keys(codec).sort()).toEqual([
      'collectionMetadata',
      'collectionNode',
      'collectionSnapshot',
      'parse',
      'serverUuid',
    ]);
    expect(Object.keys(codec).join(' ')).not.toMatch(/create|update|move|delete|write|tool/iu);
  });

  it('does not put a supplied secret in a URI or parsed result', () => {
    const secret = 'api-key-secret-value';
    const codec = createCodec();
    const uri = codec.collectionSnapshot('collection-1');
    const parsed = codec.parse(uri);

    expect(uri).not.toContain(secret);
    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(Object.keys(parsed).sort()).toEqual(['collectionId', 'kind']);
    expect(() => codec.parse(`${uri}?apiKey=${secret}`)).toThrow();
  });
});
