import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PublicationSnapshotState } from '../../src/client/index.js';
import { assembleSnapshotPages } from '../../src/semantic/index.js';
import {
  createPublicationSnapshotCursor,
  createPublicationSnapshotCursorHmacKey,
  createPublicationSnapshotPageSeries,
  releasePublicationSnapshotPage,
  verifyPublicationSnapshotCursor,
  type PublicationSnapshotPageScope,
} from '../../src/server/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = '[evidence:http.snapshot.page-consistency]';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'collection-snapshot.json',
);
const principal = 'principal:publication:alice';

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}

function fixture(): Snapshot {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Snapshot;
}

function pages(count: 2): readonly [Readonly<Snapshot>, Readonly<Snapshot>];
function pages(count?: 3): readonly [Readonly<Snapshot>, Readonly<Snapshot>, Readonly<Snapshot>];
function pages(count: 2 | 3): readonly Readonly<Snapshot>[];
function pages(count: 2 | 3 = 3): readonly Readonly<Snapshot>[] {
  const source = fixture();
  const result = Array.from({ length: count }, () => structuredClone(source));
  for (const [index, page] of result.entries()) {
    page.nodes = index === 0
      ? source.nodes.slice(0, 1)
      : index === 1
        ? source.nodes.slice(1)
        : [];
    page.annotations = index === count - 1 ? source.annotations : [];
    page.attachments = index === count - 1 ? source.attachments : [];
    page.relations = index === count - 1 ? source.relations : [];
    page.tombstones = index === count - 1 ? source.tombstones : [];
    page.page = {
      sequence: index + 1,
      hasMore: index < count - 1,
      nextCursor: index < count - 1 ? `cursor-${index + 2}` : null,
    };
  }
  return result.map((page) => deepFreeze(page));
}

function scope(
  query: Record<string, unknown> = {
    include: ['annotations', 'attachments', 'relations'],
    limit: 25,
  },
  selectedPrincipal = principal,
): PublicationSnapshotPageScope {
  return deepFreeze({ principal: selectedPrincipal, query }) as PublicationSnapshotPageScope;
}

function continuationScope(cursor: string, overrides: Record<string, unknown> = {}): PublicationSnapshotPageScope {
  return scope({
    include: ['annotations', 'attachments', 'relations'],
    limit: 25,
    pageCursor: cursor,
    ...overrides,
  });
}

function frozenPage(page: Readonly<Snapshot>, mutate: (value: Snapshot) => void): Readonly<Snapshot> {
  const value = structuredClone(page) as Snapshot;
  mutate(value);
  return deepFreeze(value);
}

function captureError(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected Snapshot page consistency enforcement to fail.');
}

describe(`PUB-0033 paginated Snapshot page consistency ${evidence}`, () => {
  it.each([2, 3] as const)(
    `releases a valid %s-page sequence with one snapshotId revision mode Principal and decoded query scope ${evidence}`,
    (pageCount) => {
      const sequence = pages(pageCount);
      const started = createPublicationSnapshotPageSeries(sequence[0], scope());
      const released = [started.page];

      for (let index = 1; index < sequence.length; index += 1) {
        released.push(releasePublicationSnapshotPage(
          started.series,
          sequence[index],
          continuationScope(`cursor-${index + 1}`),
        ));
      }

      expect(released.map((page) => page.page.sequence)).toEqual(
        Array.from({ length: pageCount }, (_unused, index) => index + 1),
      );
      expect(new Set(released.map((page) => page.snapshotId))).toEqual(new Set([sequence[0]!.snapshotId]));
      expect(new Set(released.map((page) => page.revision))).toEqual(new Set([sequence[0]!.revision]));
      expect(new Set(released.map((page) => page.mode))).toEqual(new Set(['publication']));
    },
  );

  it.each([
    ['snapshotId', (page: Snapshot) => { page.snapshotId = 'snapshot-other'; }],
    ['revision', (page: Snapshot) => { page.revision = 'revision-other'; }],
    ['mode', (page: Snapshot) => { page.mode = 'sync'; }],
  ] as const)(`rejects an independent %s mismatch on a later page ${evidence}`, (_name, mutate) => {
    const [first, second] = pages(2);
    const started = createPublicationSnapshotPageSeries(first, scope());
    expect(() => releasePublicationSnapshotPage(
      started.series,
      frozenPage(second, mutate),
      continuationScope('cursor-2'),
    )).toThrow(TypeError);
  });

  it.each([
    ['Principal', scope(undefined, 'principal:publication:bob')],
    ['root', continuationScope('cursor-2', { root: 'other-root' })],
    ['depth', continuationScope('cursor-2', { depth: 3 })],
    ['include set', scope({ include: ['annotations', 'relations'], limit: 25, pageCursor: 'cursor-2' })],
    ['limit/page size', continuationScope('cursor-2', { limit: 26 })],
  ] as const)(`rejects an independent %s scope mismatch ${evidence}`, (_name, laterScope) => {
    const [first, second] = pages(2);
    const started = createPublicationSnapshotPageSeries(first, scope());
    expect(() => releasePublicationSnapshotPage(started.series, second, laterScope)).toThrow(TypeError);
  });

  it(`treats reordered include values as the same decoded set ${evidence}`, () => {
    const [first, second] = pages(2);
    const started = createPublicationSnapshotPageSeries(first, scope());
    expect(releasePublicationSnapshotPage(
      started.series,
      second,
      scope({ include: ['relations', 'annotations', 'attachments'], limit: 25, pageCursor: 'different-opaque-cursor' }),
    ).page.sequence).toBe(2);
  });

  it(`rejects duplicate include values as a non-canonical decoded query ${evidence}`, () => {
    expect(() => createPublicationSnapshotPageSeries(pages(2)[0], scope({
      include: ['annotations', 'attachments', 'annotations', 'relations'],
      limit: 25,
    }))).toThrow(TypeError);
  });

  it(`excludes only validated pageCursor from logical query identity ${evidence}`, () => {
    const [first, second, third] = pages(3);
    const started = createPublicationSnapshotPageSeries(first, scope());
    expect(releasePublicationSnapshotPage(
      started.series,
      second,
      continuationScope('cursor-from-link-at-cdn-a'),
    ).page.sequence).toBe(2);
    expect(releasePublicationSnapshotPage(
      started.series,
      third,
      continuationScope('cursor-from-link-at-cdn-b'),
    ).page.sequence).toBe(3);
  });

  it(`keeps a cross-Origin page URL irrelevant to the logical scope ${evidence}`, () => {
    const [first, second] = pages(2);
    const started = createPublicationSnapshotPageSeries(first, scope());
    const releaseFromTransport = (_pageUrl: URL) => releasePublicationSnapshotPage(
      started.series,
      second,
      continuationScope('cursor-2'),
    );

    expect(releaseFromTransport(new URL('https://cdn.other.example/snapshots/page-2')).page.sequence).toBe(2);
  });

  it(`separates Principal and query cache variants even for identical page bytes ${evidence}`, () => {
    const [first, second] = pages(2);
    const aliceScope = scope();
    const bobScope = scope(undefined, 'principal:publication:bob');
    const croppedScope = scope({ root: first.collection.rootNodeId, depth: 1, limit: 25 });
    const alice = createPublicationSnapshotPageSeries(first, aliceScope);
    const bob = createPublicationSnapshotPageSeries(first, bobScope);
    const cropped = createPublicationSnapshotPageSeries(first, croppedScope);

    expect(() => releasePublicationSnapshotPage(alice.series, second, bobScope)).toThrow(TypeError);
    expect(() => releasePublicationSnapshotPage(bob.series, second, aliceScope)).toThrow(TypeError);
    expect(() => releasePublicationSnapshotPage(cropped.series, second, aliceScope)).toThrow(TypeError);
    expect(releasePublicationSnapshotPage(alice.series, second, continuationScope('cursor-2')).page.sequence).toBe(2);
    expect(releasePublicationSnapshotPage(
      bob.series,
      second,
      scope({ include: ['annotations', 'attachments', 'relations'], limit: 25, pageCursor: 'cursor-2' }, 'principal:publication:bob'),
    ).page.sequence).toBe(2);
  });

  it(`throws without returning partial output and permits a later valid matching release ${evidence}`, () => {
    const [first, second] = pages(2);
    const started = createPublicationSnapshotPageSeries(first, scope());
    let output: Readonly<Snapshot> | undefined;
    try {
      output = releasePublicationSnapshotPage(
        started.series,
        frozenPage(second, (page) => { page.revision = 'wrong-revision'; }),
        continuationScope('cursor-2'),
      );
    } catch {
      // The contract is a fail-closed exception boundary.
    }

    expect(output).toBeUndefined();
    expect(releasePublicationSnapshotPage(
      started.series,
      second,
      continuationScope('cursor-2'),
    )).toEqual(second);
  });

  it(`returns separately cloned deeply frozen pages detached from accepted sources ${evidence}`, () => {
    const [first, second] = pages(2);
    const started = createPublicationSnapshotPageSeries(first, scope());
    const released = releasePublicationSnapshotPage(started.series, second, continuationScope('cursor-2'));

    expect(started.page).toEqual(first);
    expect(started.page).not.toBe(first);
    expect(started.page.collection).not.toBe(first.collection);
    expect(released).toEqual(second);
    expect(released).not.toBe(second);
    expect(released.collection).not.toBe(second.collection);
    expect(Object.isFrozen(started.page)).toBe(true);
    expect(Object.isFrozen(started.page.collection)).toBe(true);
    expect(Object.isFrozen(released)).toBe(true);
    expect(Object.isFrozen(released.nodes)).toBe(true);
    expect(Reflect.set(first.collection, 'title', 'caller mutation')).toBe(false);
    expect(Reflect.set(released.collection, 'title', 'consumer mutation')).toBe(false);
    expect(started.page.collection.title).toBe(first.collection.title);
    expect(released.collection.title).toBe(second.collection.title);
  });

  it.each([
    ['null', null],
    ['an array', deepFreeze([])],
    ['a missing page object', deepFreeze({ protocolVersion: '0.1', mode: 'publication' })],
  ])(`rejects %s as the first Snapshot before issuing a series ${evidence}`, (_name, value) => {
    expect(() => createPublicationSnapshotPageSeries(value, scope())).toThrow(TypeError);
  });

  it(`accepts ordinary mutable canonical values and snapshots them before retaining or releasing ${evidence}`, () => {
    const [frozenFirst, frozenSecond] = pages(2);
    const first = structuredClone(frozenFirst) as Snapshot;
    const second = structuredClone(frozenSecond) as Snapshot;
    const mutableScope = {
      principal,
      query: { include: ['annotations', 'attachments', 'relations'], limit: 25 },
    };
    const started = createPublicationSnapshotPageSeries(first, mutableScope);

    first.collection.title = 'mutated after start';
    mutableScope.principal = 'principal:publication:bob';
    mutableScope.query.limit = 99;
    const released = releasePublicationSnapshotPage(started.series, second, {
      principal,
      query: { include: ['relations', 'annotations', 'attachments'], limit: 25, pageCursor: 'cursor-2' },
    });
    second.collection.title = 'mutated after release';

    expect(started.page.collection.title).toBe(frozenFirst.collection.title);
    expect(released.collection.title).toBe(frozenSecond.collection.title);
    expect(Object.isFrozen(started.page.collection)).toBe(true);
    expect(Object.isFrozen(released.collection)).toBe(true);
  });

  it.each([
    ['a non-object', 'not-a-snapshot'],
    ['a missing page', (page: Snapshot) => { delete (page as unknown as Record<string, unknown>).page; }],
    ['a zero sequence', (page: Snapshot) => { page.page.sequence = 0; }],
    ['a non-boolean hasMore', (page: Snapshot) => { page.page.hasMore = 'yes' as never; }],
  ] as const)(`rejects %s as a later Snapshot ${evidence}`, (_name, mutation) => {
    const [first, second] = pages(2);
    const started = createPublicationSnapshotPageSeries(first, scope());
    const candidate = typeof mutation === 'string' ? mutation : frozenPage(second, mutation);
    expect(() => releasePublicationSnapshotPage(
      started.series,
      candidate,
      continuationScope('cursor-2'),
    )).toThrow(TypeError);
  });

  it.each(['first', 'later'] as const)(`rejects non-publication mode on the %s page ${evidence}`, (position) => {
    const [first, second] = pages(2);
    if (position === 'first') {
      expect(() => createPublicationSnapshotPageSeries(
        frozenPage(first, (page) => { page.mode = 'sync'; }),
        scope(),
      )).toThrow(TypeError);
      return;
    }
    const started = createPublicationSnapshotPageSeries(first, scope());
    expect(() => releasePublicationSnapshotPage(
      started.series,
      frozenPage(second, (page) => { page.mode = 'sync'; }),
      continuationScope('cursor-2'),
    )).toThrow(TypeError);
  });

  it.each([
    ['empty', ''],
    ['control character', 'principal\u0000secret'],
    ['unpaired surrogate', 'principal\ud800secret'],
  ])(`rejects an %s Principal ${evidence}`, (_name, value) => {
    expect(() => createPublicationSnapshotPageSeries(pages(2)[0], scope(undefined, value))).toThrow(TypeError);
  });

  it(`rejects an oversized Principal with a stable non-reflective limit error ${evidence}`, () => {
    const error = captureError(() => createPublicationSnapshotPageSeries(
      pages(2)[0],
      scope(undefined, `principal-secret-${'p'.repeat(4_097)}`),
    ));
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe('Publication Snapshot page-series input limit exceeded.');
    expect(error.message).not.toContain('principal-secret');
  });

  it(`accepts the exact 4096-byte Principal boundary ${evidence}`, () => {
    expect(createPublicationSnapshotPageSeries(pages(2)[0], scope(undefined, 'p'.repeat(4_096))).page)
      .toBeDefined();
  });

  it.each([
    ['URLSearchParams', new URLSearchParams('limit=25&limit=26')],
    ['raw query string', 'limit=25&limit=26'],
    ['query array', ['limit=25', 'limit=26']],
  ])(`rejects %s because the contract accepts decoded query data only ${evidence}`, (_name, query) => {
    const malformed = deepFreeze({ principal, query }) as unknown as PublicationSnapshotPageScope;
    expect(() => createPublicationSnapshotPageSeries(pages(2)[0], malformed)).toThrow(TypeError);
  });

  it.each([
    ['an unknown raw-query property', deepFreeze({ limit: 25, rawQuery: 'limit=25&limit=26' })],
    ['an unsupported key', deepFreeze({ limit: 25, origin: 'https://attacker.example/' })],
    ['an empty root', deepFreeze({ root: '', limit: 25 })],
    ['a negative depth', deepFreeze({ depth: -1, limit: 25 })],
    ['a fractional limit', deepFreeze({ limit: 1.5 })],
    ['a zero limit', deepFreeze({ limit: 0 })],
    ['an unsupported include', deepFreeze({ include: ['nodes'], limit: 25 })],
    ['duplicate include entries', deepFreeze({ include: Array.from({ length: 9 }, () => 'annotations'), limit: 25 })],
    ['an oversized canonical query', deepFreeze({ root: `root-${'x'.repeat(16_385)}`, limit: 25 })],
  ])(`rejects decoded query with %s ${evidence}`, (_name, query) => {
    expect(() => createPublicationSnapshotPageSeries(
      pages(2)[0],
      deepFreeze({ principal, query }) as PublicationSnapshotPageScope,
    )).toThrow(TypeError);
  });

  it(`rejects pageCursor on the canonical first-page scope ${evidence}`, () => {
    expect(() => createPublicationSnapshotPageSeries(
      pages(2)[0],
      continuationScope('cursor-must-not-start-a-series'),
    )).toThrow(TypeError);
  });

  it(`rejects malformed continuation pageCursor even though its value is not logical identity ${evidence}`, () => {
    const [first, second] = pages(2);
    const started = createPublicationSnapshotPageSeries(first, scope());
    expect(() => releasePublicationSnapshotPage(
      started.series,
      second,
      continuationScope('cursor\u0000secret'),
    )).toThrow(TypeError);
  });

  it(`requires one decoded pageCursor on every continuation scope ${evidence}`, () => {
    const [first, second] = pages(2);
    const started = createPublicationSnapshotPageSeries(first, scope());
    expect(() => releasePublicationSnapshotPage(started.series, second, scope())).toThrow(TypeError);
  });

  it(`rejects accessors Proxies cycles symbols sparse arrays and mutable composites ${evidence}`, () => {
    const secret = 'scope-secret-319';
    const accessor = { limit: 25 };
    Object.defineProperty(accessor, 'root', { enumerable: true, get: () => secret });
    Object.freeze(accessor);
    const proxy = new Proxy(Object.freeze({ limit: 25 }), {
      ownKeys: () => { throw new Error(secret); },
    });
    const cycle: Record<string, unknown> = { limit: 25 };
    cycle.self = cycle;
    Object.freeze(cycle);
    const symbol = Object.freeze({ limit: 25, [Symbol(secret)]: true });
    const sparse = Array(2) as string[];
    sparse[0] = 'annotations';
    Object.freeze(sparse);

    for (const query of [accessor, proxy, cycle, symbol, { include: sparse, limit: 25 }]) {
      const error = captureError(() => createPublicationSnapshotPageSeries(
        pages(2)[0],
        Object.freeze({ principal, query }) as PublicationSnapshotPageScope,
      ));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toContain(secret);
    }
  });

  it(`rejects hostile Snapshot graphs with stable non-reflective errors ${evidence}`, () => {
    const secret = 'snapshot-secret-824';
    const [valid] = pages(2);
    const accessor = structuredClone(valid) as Snapshot;
    Object.defineProperty(accessor.collection, 'title', { enumerable: true, get: () => secret });
    deepFreeze(accessor);
    const symbol = structuredClone(valid) as Snapshot;
    (symbol.collection as unknown as Record<PropertyKey, unknown>)[Symbol(secret)] = true;
    deepFreeze(symbol);
    const cycle = structuredClone(valid) as Snapshot & { cycle?: unknown };
    cycle.cycle = cycle;
    Object.freeze(cycle);
    const proxy = new Proxy(valid, { ownKeys: () => { throw new Error(secret); } });

    for (const candidate of [accessor, symbol, cycle, proxy]) {
      const error = captureError(() => createPublicationSnapshotPageSeries(candidate, scope()));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toContain(secret);
      expect(error).not.toHaveProperty('cause');
    }
  });

  it(`uses one stable non-reflective mismatch error across secret identity values ${evidence}`, () => {
    const [first, second] = pages(2);
    const started = createPublicationSnapshotPageSeries(first, scope());
    const errors = ['snapshot-secret-one', 'snapshot-secret-two'].map((snapshotId) => captureError(() =>
      releasePublicationSnapshotPage(
        started.series,
        frozenPage(second, (page) => { page.snapshotId = snapshotId; }),
        continuationScope('cursor-2'),
      )));

    expect(errors[0]?.constructor).toBe(errors[1]?.constructor);
    expect(errors[0]?.message).toBe(errors[1]?.message);
    expect(errors[0]?.message).not.toMatch(/snapshot-secret|principal:publication/iu);
  });

  it(`preserves PUB-0004 cursor binding while adding a page-output guard ${evidence}`, () => {
    const key = createPublicationSnapshotCursorHmacKey(new Uint8Array(32).fill(0x33));
    const cursorScope = deepFreeze({
      collectionId: 'collection-cursor-bound',
      resourceId: 'publication/mount-a',
      revision: 'revision-cursor-bound',
      principal,
      root: 'root-node',
      depth: 2,
      include: ['annotations'] as const,
      pageSize: 25,
      nextPosition: 'position-25',
    });
    const token = createPublicationSnapshotCursor(cursorScope, key);

    expect(verifyPublicationSnapshotCursor(token, {
      collectionId: cursorScope.collectionId,
      resourceId: cursorScope.resourceId,
      revision: cursorScope.revision,
      principal: 'principal:publication:bob',
      root: cursorScope.root,
      depth: cursorScope.depth,
      include: cursorScope.include,
      pageSize: cursorScope.pageSize,
    }, key)).toEqual({ valid: false, code: 'invalid_cursor_scope' });
  });

  it(`preserves PUB-0005 atomic replacement by never treating a released partial page as state ${evidence}`, () => {
    const oldSnapshot = deepFreeze(fixture()) as Snapshot;
    const [first, second] = pages(2);
    const started = createPublicationSnapshotPageSeries(first, scope());
    const releasedSecond = releasePublicationSnapshotPage(started.series, second, continuationScope('cursor-2'));
    const state = new PublicationSnapshotState();
    state.replace(oldSnapshot);

    expect(() => state.replace(started.page as Snapshot)).toThrow(TypeError);
    expect(state.current).toEqual(oldSnapshot);

    const assembly = assembleSnapshotPages([started.page as Snapshot, releasedSecond as Snapshot]);
    expect(assembly.valid).toBe(true);
    if (assembly.valid) expect(state.replace(assembly.snapshot)).toEqual(assembly.snapshot);
  });
});
