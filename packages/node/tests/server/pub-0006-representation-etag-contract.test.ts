import { describe, expect, it } from 'vitest';

import {
  createPublicationRepresentationEtag,
  type PublicationRepresentationEtagInput,
} from '../../src/server/index.js';

const evidence = 'http.etag.variants';
const baseline = Object.freeze({
  representation: '{"nodes":[{"id":"node-1"}]}',
  revision: 'revision-1042',
  projectionKey: 'publication:public',
  queryContract: 'snapshotQuery',
  query: Object.freeze({
    root: 'root-node',
    depth: 2,
    include: Object.freeze(['annotations', 'attachments']),
    limit: 25,
    pageCursor: 'cursor-page-1',
  }),
  negotiatedMediaType: 'application/json',
  protocolVersion: '0.1',
  snapshotIdentity: Object.freeze({ snapshotId: 'snapshot-77', sequence: 4 }),
  pageIdentity: Object.freeze({ pageCursor: 'cursor-page-1', pageNumber: 1, key: 'node-1' }),
} satisfies PublicationRepresentationEtagInput);

function etag(change: Partial<PublicationRepresentationEtagInput> = {}): string {
  return createPublicationRepresentationEtag({ ...baseline, ...change });
}

describe(`PUB-0006 Publication representation ETags [evidence:${evidence}]`, () => {
  it(`is deterministic and emits quoted strong ETag syntax [evidence:${evidence}]`, () => {
    const first = etag();
    expect(etag()).toBe(first);
    expect(first).toMatch(/^"pub\.r1\.[A-Za-z0-9_-]{43}"$/u);
    expect(first).not.toMatch(/^W\//u);
  });

  it(`changes for a projection change with the same revision and body [evidence:${evidence}]`, () => {
    expect(etag({ projectionKey: 'publication:private' })).not.toBe(etag());
  });

  it(`changes for different principalScope with the same representation body [evidence:${evidence}]`, () => {
    const body = baseline.representation;
    const alice = etag({ representation: body, principalScope: 'principal-alice' });
    const bob = etag({ representation: body, principalScope: 'principal-bob' });
    expect(alice).not.toBe(bob);
    expect(alice).toMatch(/^"pub\.r1\.[A-Za-z0-9_-]{43}"$/u);
    expect(bob).toMatch(/^"pub\.r1\.[A-Za-z0-9_-]{43}"$/u);
    expect(alice).not.toMatch(/^W\//u);
    expect(bob).not.toMatch(/^W\//u);
  });

  it(`omitted principalScope keeps legacy same-input ETag identity [evidence:${evidence}]`, () => {
    const first = createPublicationRepresentationEtag({ ...baseline });
    const second = createPublicationRepresentationEtag({ ...baseline });
    expect(Object.hasOwn(baseline, 'principalScope')).toBe(false);
    expect(first).toBe(second);
    expect(first).toBe(etag());
    expect(first).toMatch(/^"pub\.r1\.[A-Za-z0-9_-]{43}"$/u);
    expect(first).not.toMatch(/^W\//u);
  });

  it.each([
    ['root', { root: 'other-root', depth: 2, include: ['annotations', 'attachments'], limit: 25, pageCursor: 'cursor-page-1' }],
    ['depth', { root: 'root-node', depth: 3, include: ['annotations', 'attachments'], limit: 25, pageCursor: 'cursor-page-1' }],
    ['include set', { root: 'root-node', depth: 2, include: ['relations'], limit: 25, pageCursor: 'cursor-page-1' }],
    ['limit', { root: 'root-node', depth: 2, include: ['annotations', 'attachments'], limit: 26, pageCursor: 'cursor-page-1' }],
    ['pageCursor', { root: 'root-node', depth: 2, include: ['annotations', 'attachments'], limit: 25, pageCursor: 'cursor-page-2' }],
  ] as const)(`changes when the snapshot query %s changes [evidence:${evidence}]`, (_name, query) => {
    expect(etag({ query })).not.toBe(etag());
  });

  it(`canonicalizes query object member order [evidence:${evidence}]`, () => {
    const reordered = {
      pageCursor: 'cursor-page-1',
      limit: 25,
      include: ['annotations', 'attachments'],
      depth: 2,
      root: 'root-node',
    };
    expect(etag({ query: reordered })).toBe(etag());
  });

  it.each([
    ['snapshotQuery reorder', 'snapshotQuery', { include: ['attachments', 'annotations'] }],
    ['snapshotQuery duplicate', 'snapshotQuery', { include: ['annotations', 'attachments', 'annotations'] }],
    ['nodeDetailQuery reorder', 'nodeDetailQuery', { include: ['attachments', 'annotations'] }],
    ['nodeDetailQuery duplicate', 'nodeDetailQuery', { include: ['annotations', 'attachments', 'annotations'] }],
  ] as const)(`canonicalizes the %s include set [evidence:${evidence}]`, (_name, queryContract, query) => {
    const canonical = { include: ['annotations', 'attachments'] };
    expect(etag({ queryContract, query })).toBe(etag({ queryContract, query: canonical }));
  });

  it.each([
    ['snapshotQuery', 'snapshotQuery'],
    ['nodeDetailQuery', 'nodeDetailQuery'],
  ] as const)(`distinguishes a changed %s include set [evidence:${evidence}]`, (_name, queryContract) => {
    expect(etag({ queryContract, query: { include: ['annotations'] } })).not.toBe(
      etag({ queryContract, query: { include: ['attachments'] } }),
    );
  });

  it(`does not apply include normalization outside an include query contract [evidence:${evidence}]`, () => {
    expect(() => etag({ queryContract: 'none', query: { include: ['attachments', 'annotations'] } as never }))
      .toThrow(/empty when queryContract is none/u);
  });

  it.each([
    ['selected media type', { negotiatedMediaType: 'application/vnd.collection-protocol.snapshot+json;version=0.1' }],
    ['protocol version', { protocolVersion: '0.2' }],
  ] as const)(`changes when %s changes [evidence:${evidence}]`, (_name, change) => {
    expect(etag(change)).not.toBe(etag());
  });

  it.each([
    ['Accept alternatives', 'application/json, application/cbor'],
    ['Accept weight', 'application/json;q=0.9'],
    ['type wildcard', 'application/*'],
    ['global wildcard', '*/*'],
  ])(`rejects raw %s as the selected media type [evidence:${evidence}]`, (_name, negotiatedMediaType) => {
    expect(() => etag({ negotiatedMediaType })).toThrow(/negotiatedMediaType/u);
  });

  it(`accepts a selected media type with a quoted parameter [evidence:${evidence}]`, () => {
    expect(etag({ negotiatedMediaType: 'application/json;profile="https://example.test/a,b;c"' }))
      .toMatch(/^"pub\.r1\.[A-Za-z0-9_-]{43}"$/u);
  });

  it.each([
    ['snapshotId', { snapshotIdentity: { snapshotId: 'snapshot-78', sequence: 4 } }],
    ['snapshot sequence', { snapshotIdentity: { snapshotId: 'snapshot-77', sequence: 5 } }],
    ['page cursor identity', { pageIdentity: { pageCursor: 'cursor-page-2', pageNumber: 1, key: 'node-1' } }],
    ['page number identity', { pageIdentity: { pageCursor: 'cursor-page-1', pageNumber: 2, key: 'node-1' } }],
    ['page key identity', { pageIdentity: { pageCursor: 'cursor-page-1', pageNumber: 1, key: 'node-2' } }],
  ] as const)(`changes when %s changes [evidence:${evidence}]`, (_name, change) => {
    expect(etag(change)).not.toBe(etag());
  });

  it(`gives different pages different tags at the same revision [evidence:${evidence}]`, () => {
    const firstPage = etag({ pageIdentity: { pageNumber: 1 } });
    const secondPage = etag({ pageIdentity: { pageNumber: 2 } });
    expect(firstPage).not.toBe(secondPage);
  });

  it(`changes for a concrete one-byte representation change [evidence:${evidence}]`, () => {
    const first = Uint8Array.of(0x61, 0x62, 0x63);
    const changed = Uint8Array.of(0x61, 0x62, 0x64);
    expect(etag({ representation: first })).not.toBe(etag({ representation: changed }));
  });

  it.each([
    ['ASCII', 'exact bytes'],
    ['multibyte UTF-8', 'Snowman: \u2603'],
    ['supplementary UTF-8', 'Music: \ud834\udd1e'],
    ['pretty JSON whitespace', '{\r\n\t"id": "node-1"\r\n}'],
  ])(`treats the %s string as its exact UTF-8 bytes [evidence:${evidence}]`, (_name, representation) => {
    expect(etag({ representation })).toBe(etag({ representation: Buffer.from(representation, 'utf8') }));
  });

  it(`does not expose raw principal, projection, root, or cursor material [evidence:${evidence}]`, () => {
    const principal = 'principal-alice-private';
    const projection = 'projection-private-secret';
    const root = 'root-private-secret';
    const cursor = 'cursor-private-secret';
    const secrets = [principal, projection, root, cursor];
    const tag = etag({
      projectionKey: `${principal}:${projection}`,
      query: { root, pageCursor: cursor },
      pageIdentity: { pageCursor: cursor },
    });
    const rendered = [tag, Buffer.from(tag, 'base64url').toString('utf8')].join('\n');
    for (const secret of secrets) expect(rendered).not.toContain(secret);
  });

  it(`frames adjacent fields against concatenation collisions [evidence:${evidence}]`, () => {
    const left = etag({ revision: 'a', projectionKey: 'bc' });
    const right = etag({ revision: 'ab', projectionKey: 'c' });
    expect(left).not.toBe(right);
  });

  it.each([
    ['empty revision', { revision: '' }],
    ['empty projection', { projectionKey: '' }],
    ['empty media type', { negotiatedMediaType: '' }],
    ['empty protocol version', { protocolVersion: '' }],
    ['empty snapshot id', { snapshotIdentity: { snapshotId: '', sequence: 0 } }],
    ['empty page cursor', { pageIdentity: { pageCursor: '' } }],
    ['empty page key', { pageIdentity: { key: '' } }],
    ['controlled revision', { revision: 'revision\nsecret' }],
    ['controlled projection', { projectionKey: 'projection\u007fsecret' }],
    ['controlled media type', { negotiatedMediaType: 'application/json\r\nX-Injected: yes' }],
    ['controlled protocol version', { protocolVersion: '0.1\u0000secret' }],
    ['controlled snapshot id', { snapshotIdentity: { snapshotId: 'snapshot\u001fsecret', sequence: 0 } }],
    ['controlled page cursor', { pageIdentity: { pageCursor: 'cursor\u0085secret' } }],
    ['controlled page key', { pageIdentity: { key: 'page\tsecret' } }],
    ['unpaired revision surrogate', { revision: '\ud800' }],
    ['unpaired projection surrogate', { projectionKey: '\udfff' }],
    ['unpaired media type surrogate', { negotiatedMediaType: '\ud800' }],
    ['unpaired protocol version surrogate', { protocolVersion: '\udfff' }],
    ['unpaired snapshot id surrogate', { snapshotIdentity: { snapshotId: '\ud800', sequence: 0 } }],
    ['unpaired page cursor surrogate', { pageIdentity: { pageCursor: '\udfff' } }],
    ['unpaired page key surrogate', { pageIdentity: { key: '\ud800' } }],
    ['oversized revision', { revision: 'r'.repeat(16 * 1024 + 1) }],
    ['oversized projection', { projectionKey: 'p'.repeat(16 * 1024 + 1) }],
    ['oversized media type', { negotiatedMediaType: 'm'.repeat(4 * 1024 + 1) }],
    ['oversized protocol version', { protocolVersion: 'v'.repeat(16 * 1024 + 1) }],
    ['oversized snapshot id', { snapshotIdentity: { snapshotId: 's'.repeat(16 * 1024 + 1), sequence: 0 } }],
    ['oversized page cursor', { pageIdentity: { pageCursor: 'c'.repeat(16 * 1024 + 1) } }],
    ['oversized page key', { pageIdentity: { key: 'k'.repeat(16 * 1024 + 1) } }],
  ] as const)(`rejects the %s identity boundary [evidence:${evidence}]`, (_name, change) => {
    expect(() => etag(change)).toThrow(/must/u);
  });

  it.each([
    ['negative snapshot sequence', { snapshotIdentity: { snapshotId: 'snapshot-77', sequence: -1 } }],
    ['unsafe snapshot sequence', { snapshotIdentity: { snapshotId: 'snapshot-77', sequence: Number.MAX_SAFE_INTEGER + 1 } }],
    ['fractional snapshot sequence', { snapshotIdentity: { snapshotId: 'snapshot-77', sequence: 1.5 } }],
    ['negative page number', { pageIdentity: { pageNumber: -1 } }],
    ['unsafe page number', { pageIdentity: { pageNumber: Number.MAX_SAFE_INTEGER + 1 } }],
    ['fractional page number', { pageIdentity: { pageNumber: 1.5 } }],
    ['zero query limit', { query: { limit: 0 } }],
    ['negative query limit', { query: { limit: -1 } }],
    ['unsafe query limit', { query: { limit: Number.MAX_SAFE_INTEGER + 1 } }],
    ['negative query depth', { query: { depth: -1 } }],
    ['unsafe query depth', { query: { depth: Number.MAX_SAFE_INTEGER + 1 } }],
  ] as const)(`rejects the %s integer boundary [evidence:${evidence}]`, (_name, change) => {
    expect(() => etag(change)).toThrow(/integer/u);
  });

  const cyclicQuery: Record<string, unknown> = {};
  cyclicQuery.self = cyclicQuery;
  it.each([
    ['undefined', { value: undefined }],
    ['function', { value: () => undefined }],
    ['bigint', { value: 1n }],
    ['NaN', { value: Number.NaN }],
    ['positive infinity', { value: Number.POSITIVE_INFINITY }],
    ['negative infinity', { value: Number.NEGATIVE_INFINITY }],
    ['fractional number', { value: 1.5 }],
    ['unsafe integer', { value: Number.MAX_SAFE_INTEGER + 1 }],
    ['cycle', cyclicQuery],
  ])(`rejects the non-JSON query containing %s [evidence:${evidence}]`, (_name, query) => {
    expect(() => etag({ query: query as never })).toThrow(/query|JSON|numbers/u);
  });

  it.each([
    ['null', null],
    ['plain object', {}],
    ['array', []],
    ['number', 42],
    ['boolean', true],
    ['function', () => 'bytes'],
  ])(`rejects the illegal %s representation type [evidence:${evidence}]`, (_name, representation) => {
    expect(() => etag({ representation: representation as never })).toThrow(/representation/u);
  });

  it.each([
    ['control character string', 'a\u0000b'],
    ['unpaired high surrogate string', '\ud800'],
    ['unpaired low surrogate string', '\udfff'],
  ])(`rejects the %s representation boundary [evidence:${evidence}]`, (_name, representation) => {
    expect(() => etag({ representation })).toThrow(/representation/u);
  });

  it.each([
    ['unsupported contract', 'cursorPageQuery'],
    ['empty contract', ''],
    ['non-string contract', 1],
  ])(`rejects the %s query contract [evidence:${evidence}]`, (_name, queryContract) => {
    expect(() => etag({ queryContract: queryContract as never })).toThrow(/queryContract/u);
  });

  it.each([
    ['non-string snapshot root', { root: 1 }],
    ['non-string snapshot cursor', { pageCursor: false }],
    ['non-array snapshot include', { include: 'annotations' }],
    ['non-string snapshot include member', { include: ['annotations', 1] }],
    ['non-array node detail include', { include: 'relations' }],
    ['non-string node detail include member', { include: [null] }],
  ])(`rejects the %s query shape [evidence:${evidence}]`, (_name, query) => {
    const queryContract = _name.startsWith('node') ? 'nodeDetailQuery' : 'snapshotQuery';
    expect(() => etag({ queryContract, query: query as never })).toThrow(/query/u);
  });

  it(`distinguishes an absent page identity from a concrete page [evidence:${evidence}]`, () => {
    const { pageIdentity: _pageIdentity, ...withoutPageIdentity } = baseline;
    expect(createPublicationRepresentationEtag(withoutPageIdentity)).not.toBe(etag());
  });

  it(`rejects an empty page identity [evidence:${evidence}]`, () => {
    expect(() => etag({ pageIdentity: {} })).toThrow(/identify a page/u);
  });
});
