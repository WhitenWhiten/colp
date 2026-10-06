import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ColpClient } from '../../src/client/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  createPublicationSnapshotPageResponse,
  createPublicationSnapshotPageSeries,
  createPublicationSnapshotSinglePageResponse,
  decodePublicationQuery,
  planPublicationSnapshotDelivery,
  publicationSnapshotDeliveryLimits,
  PublicationSnapshotAdapterContractError,
  type PublicationCollectionClassification,
  type PublicationSnapshotDeliveryInput,
  type PublicationSnapshotSinglePagePlan,
} from '../../src/server/index.js';
import { validatePublicationSnapshotReplacementSemantics } from '../../src/semantic/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = '[evidence:http.snapshot.single-page-preference]';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'collection-snapshot.json',
);
const validators = createValidatorRegistry();
const fullInclude = Object.freeze(['annotations', 'attachments', 'relations'] as const);

function fixture(): Snapshot {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Snapshot;
}

function input(
  snapshot: unknown = fixture(),
  classification: PublicationCollectionClassification = 'dynamic',
  query: unknown = {},
): PublicationSnapshotDeliveryInput {
  return { classification, query, snapshot };
}

function single(
  snapshot: unknown = fixture(),
  classification: PublicationCollectionClassification = 'dynamic',
  query: unknown = {},
): PublicationSnapshotSinglePagePlan {
  const result = planPublicationSnapshotDelivery(input(snapshot, classification, query));
  expect(result.delivery).toBe('single-page');
  return result as PublicationSnapshotSinglePagePlan;
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function objectCount(value: unknown): number {
  const pending = [value];
  const seen = new WeakSet<object>();
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);
    count += 1;
    for (const key of Reflect.ownKeys(current)) {
      if (Array.isArray(current) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && 'value' in descriptor) pending.push(descriptor.value);
    }
  }
  return count;
}

function snapshotAtUtf8Bytes(target: number): Snapshot {
  const value = fixture();
  value.warnings = [{ code: 'padding', message: '' }];
  const padding = target - utf8Bytes(value);
  if (padding < 0) throw new RangeError('Target is smaller than the canonical fixture.');
  value.warnings[0]!.message = 'x'.repeat(padding);
  expect(utf8Bytes(value)).toBe(target);
  return value;
}

function snapshotAtObjectCount(target: number): Snapshot {
  const value = fixture();
  const additions = target - objectCount(value);
  if (additions < 0) throw new RangeError('Target is smaller than the canonical fixture.');
  value.warnings = Array.from({ length: additions }, () => ({ code: 'w', message: '' }));
  expect(objectCount(value)).toBe(target);
  return value;
}

function captureError(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected Snapshot delivery planning to fail.');
}

describe(`PUB-0035 single-page complete Snapshot preference ${evidence}`, () => {
  it.each(['static', 'dynamic'] as const)(
    `returns a one-page complete Snapshot for an explicitly %s small Collection ${evidence}`,
    (classification) => {
      const plan = planPublicationSnapshotDelivery(input(fixture(), classification));
      expect(plan).toMatchObject({
        delivery: 'single-page',
        snapshot: {
          complete: true,
          page: { sequence: 1, hasMore: false, nextCursor: null },
        },
      });
    },
  );

  it(`uses actual canonical UTF-8 bytes at the exact small boundary and paginates the next byte ${evidence}`, () => {
    const boundary = snapshotAtUtf8Bytes(publicationSnapshotDeliveryLimits.smallMaxUtf8Bytes);
    const nextByte = snapshotAtUtf8Bytes(publicationSnapshotDeliveryLimits.smallMaxUtf8Bytes + 1);
    const accepted = planPublicationSnapshotDelivery(input(boundary));
    const paginated = planPublicationSnapshotDelivery(input(nextByte));
    expect(accepted).toMatchObject({ delivery: 'single-page', metrics: { utf8Bytes: publicationSnapshotDeliveryLimits.smallMaxUtf8Bytes } });
    expect(paginated).toMatchObject({ delivery: 'paginate', metrics: { utf8Bytes: publicationSnapshotDeliveryLimits.smallMaxUtf8Bytes + 1 } });
  });

  it(`uses actual graph objects at the exact small boundary and paginates the next object ${evidence}`, () => {
    const boundary = snapshotAtObjectCount(publicationSnapshotDeliveryLimits.smallMaxObjects);
    const nextObject = snapshotAtObjectCount(publicationSnapshotDeliveryLimits.smallMaxObjects + 1);
    const accepted = planPublicationSnapshotDelivery(input(boundary));
    const paginated = planPublicationSnapshotDelivery(input(nextObject));
    expect(accepted).toMatchObject({ delivery: 'single-page', metrics: { objectCount: publicationSnapshotDeliveryLimits.smallMaxObjects } });
    expect(paginated).toMatchObject({ delivery: 'paginate', metrics: { objectCount: publicationSnapshotDeliveryLimits.smallMaxObjects + 1 } });
  });

  it(`measures the accepted representation instead of trusting caller estimates ${evidence}`, () => {
    const value = fixture();
    const expected = { utf8Bytes: utf8Bytes(value), objectCount: objectCount(value) };
    const plan = planPublicationSnapshotDelivery(input(value));
    if (plan.delivery === 'preserve-page') throw new Error('Expected a measured delivery plan.');
    expect(plan.metrics).toEqual(expected);
    expect(() => planPublicationSnapshotDelivery({
      ...input(value),
      estimatedUtf8Bytes: 1,
      estimatedObjectCount: 1,
    } as unknown as PublicationSnapshotDeliveryInput)).toThrow(TypeError);
  });

  it(`measures escaped controls multibyte keys and astral text as serialized UTF-8 ${evidence}`, () => {
    const value = fixture();
    value.collection.title = 'quote:" control:\u0001 astral:\u{1f680}';
    value.collection.extensions = { 'https://extensions.example/utf8': { '\u952e': '\u503c\u{1f680}' } };
    const plan = single(value);
    expect(plan.metrics.utf8Bytes).toBe(utf8Bytes(value));
  });

  it.each([
    ['no query options', {}],
    ['the full authoritative include set', { include: fullInclude }],
    ['a page-size limit', { limit: 25 }],
  ] as const)(`treats %s as a complete logical query ${evidence}`, (_name, query) => {
    expect(planPublicationSnapshotDelivery(input(fixture(), 'dynamic', query)).delivery).toBe('single-page');
  });

  it.each([
    ['annotations, attachments, relations', ['annotations', 'attachments', 'relations']],
    ['relations, annotations, attachments', ['relations', 'annotations', 'attachments']],
    ['attachments, relations, annotations', ['attachments', 'relations', 'annotations']],
  ] as const)(`recognizes the full authoritative include set independent of order: %s ${evidence}`, (_name, include) => {
    const plan = planPublicationSnapshotDelivery(input(fixture(), 'dynamic', { include, limit: 25 }));
    expect(plan).toMatchObject({
      delivery: 'single-page',
      snapshot: { complete: true },
    });
  });

  it(`accepts the canonical full include set produced by the real raw-query decoder ${evidence}`, () => {
    const decoded = decodePublicationQuery(
      'snapshot',
      '?include=annotations&include=attachments&include=relations',
      validators,
    );
    expect(decoded.valid).toBe(true);
    if (!decoded.valid) return;
    expect(planPublicationSnapshotDelivery(input(fixture(), 'dynamic', decoded.value)).delivery).toBe('single-page');
  });

  it.each([
    ['root crop', { root: fixture().collection.rootNodeId }],
    ['depth crop', { depth: 1 }],
    ['annotations-only include', { include: ['annotations'] }],
    ['two-of-three include', { include: ['annotations', 'relations'] }],
  ] as const)(`never upgrades %s to an authoritative complete Snapshot ${evidence}`, (_name, query) => {
    const value = fixture();
    value.complete = false;
    const plan = planPublicationSnapshotDelivery(input(value, 'static', query));
    expect(plan).toMatchObject({
      delivery: 'preserve-page',
      reason: 'cropped-query',
      logicalScope: 'cropped',
      snapshot: { complete: false, page: { sequence: 1, hasMore: false } },
    });

    value.complete = true;
    const error = captureError(() => planPublicationSnapshotDelivery(input(value, 'static', query)));
    expect(error).toBeInstanceOf(PublicationSnapshotAdapterContractError);
    expect(error).toMatchObject({ code: 'publication_snapshot_adapter_noncompliance' });
  });

  it.each([
    ['unfiltered and incomplete', {}, (value: Snapshot) => { value.complete = false; }],
    ['limit-only and incomplete', { limit: 25 }, (value: Snapshot) => { value.complete = false; }],
    ['unfiltered and already continued', {}, (value: Snapshot) => { value.page = { sequence: 2, hasMore: false, nextCursor: null }; }],
    ['limit-only and already continued', { limit: 25 }, (value: Snapshot) => { value.page = { sequence: 2, hasMore: false, nextCursor: null }; }],
    ['limit-only and already nonterminal', { limit: 25 }, (value: Snapshot) => { value.page = { sequence: 1, hasMore: true, nextCursor: 'cursor-2' }; }],
  ] as const)(`rejects an initial complete-scope adapter representation that is %s ${evidence}`, (_name, query, mutate) => {
    for (const classification of ['static', 'dynamic'] as const) {
      const value = fixture();
      mutate(value);
      const error = captureError(() => planPublicationSnapshotDelivery(input(value, classification, query)));
      expect(error).toBeInstanceOf(PublicationSnapshotAdapterContractError);
      expect(error).toMatchObject({
        code: 'publication_snapshot_adapter_noncompliance',
        message: 'Publication Snapshot adapter did not supply a complete terminal representation.',
      });
      expect(error).not.toHaveProperty('snapshot');
      expect(error).not.toHaveProperty('cause');
    }
  });

  it(`allows an explicitly cropped query to preserve its canonical page without claiming completeness ${evidence}`, () => {
    const value = fixture();
    value.complete = false;
    value.page = { sequence: 2, hasMore: true, nextCursor: 'cursor-3' };
    const plan = planPublicationSnapshotDelivery(input(value, 'static', { depth: 1 }));
    expect(plan).toMatchObject({
      delivery: 'preserve-page',
      reason: 'cropped-query',
      logicalScope: 'cropped',
      snapshot: { complete: false, page: { sequence: 2, hasMore: true, nextCursor: 'cursor-3' } },
    });
  });

  it.each([
    ['pageCursor only', { pageCursor: 'cursor-2' }],
    ['limit and pageCursor', { limit: 1, pageCursor: 'cursor-2' }],
    ['full include set and pageCursor', {
      include: ['relations', 'annotations', 'attachments'],
      pageCursor: 'cursor-2',
    }],
  ] as const)(`preserves a complete logical continuation selected by %s without downgrading complete ${evidence}`, (_name, query) => {
    const value = fixture();
    value.nodes = value.nodes.slice(1);
    value.page = { sequence: 2, hasMore: false, nextCursor: null };
    const plan = planPublicationSnapshotDelivery(input(value, 'dynamic', query));
    expect(plan).toMatchObject({
      delivery: 'preserve-page',
      reason: 'continuation-page',
      logicalScope: 'complete',
      snapshot: { complete: true, page: { sequence: 2, hasMore: false, nextCursor: null } },
    });
  });

  it.each([
    ['root', { root: fixture().collection.rootNodeId, limit: 1, pageCursor: 'cursor-2' }],
    ['depth', { depth: 1, limit: 1, pageCursor: 'cursor-2' }],
    ['partial include', { include: ['annotations'], limit: 1, pageCursor: 'cursor-2' }],
  ] as const)(`preserves a %s continuation only when it remains incomplete ${evidence}`, (_name, query) => {
    const value = fixture();
    value.complete = false;
    value.nodes = value.nodes.slice(1);
    value.page = { sequence: 2, hasMore: false, nextCursor: null };
    const plan = planPublicationSnapshotDelivery(input(value, 'dynamic', query));
    expect(plan).toMatchObject({
      delivery: 'preserve-page',
      reason: 'continuation-page',
      logicalScope: 'cropped',
      snapshot: { complete: false, page: { sequence: 2 } },
    });

    value.complete = true;
    const error = captureError(() => planPublicationSnapshotDelivery(input(value, 'dynamic', query)));
    expect(error).toBeInstanceOf(PublicationSnapshotAdapterContractError);
    expect(error).toMatchObject({ code: 'publication_snapshot_adapter_noncompliance' });
  });

  it(`rejects a complete logical continuation that falsely claims incomplete ${evidence}`, () => {
    const value = fixture();
    value.complete = false;
    value.nodes = value.nodes.slice(1);
    value.page = { sequence: 2, hasMore: false, nextCursor: null };
    const error = captureError(() => planPublicationSnapshotDelivery(input(value, 'dynamic', {
      include: ['relations', 'annotations', 'attachments'],
      limit: 1,
      pageCursor: 'cursor-2',
    })));
    expect(error).toBeInstanceOf(PublicationSnapshotAdapterContractError);
    expect(error).toMatchObject({
      code: 'publication_snapshot_adapter_noncompliance',
      message: 'Publication Snapshot adapter did not supply a complete terminal representation.',
    });
  });

  it.each([
    '?include=annotations&include=annotations',
    '?root=a&root=b',
    '?unknown=secret',
    '?include=annotations,attachments',
    '?depth=00',
    '?include=%FF',
  ])(`rejects malformed raw query %s at the real decoding boundary ${evidence}`, (rawSearch) => {
    const decoded = decodePublicationQuery('snapshot', rawSearch, validators);
    expect(decoded).toMatchObject({ valid: false, status: 400, code: 'invalid_query' });
  });

  it.each([
    ['raw string', '?include=annotations'],
    ['URLSearchParams', new URLSearchParams('include=annotations')],
    ['unknown decoded key', { credential: 'secret' }],
    ['duplicate decoded include', { include: ['annotations', 'annotations'] }],
  ])(`rejects %s because planning accepts only a canonical decoded query ${evidence}`, (_name, query) => {
    const error = captureError(() => planPublicationSnapshotDelivery(input(fixture(), 'dynamic', query)));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).not.toContain('secret');
  });

  it(`returns a terminal complete plan with no continuation material ${evidence}`, () => {
    const plan = single();
    expect(plan.snapshot.complete).toBe(true);
    expect(plan.snapshot.page).toEqual({ sequence: 1, hasMore: false, nextCursor: null });
    expect(JSON.stringify(plan)).not.toMatch(/pageCursor|nextUrl|rel=.?next/iu);
  });

  it(`serves a limit-paginated complete plan through real server responses that ColpClient assembles ${evidence}`, async () => {
    const source = fixture();
    const initialQuery = Object.freeze({ limit: 1 });
    const planned = planPublicationSnapshotDelivery(input(source, 'dynamic', initialQuery), {
      limits: { smallMaxObjects: 1 },
    });
    expect(planned).toMatchObject({
      delivery: 'paginate',
      reason: 'dynamic-over-small-limit',
      snapshot: { complete: true, page: { sequence: 1, hasMore: false } },
    });
    if (planned.delivery !== 'paginate') throw new Error('Expected the server adapter to paginate.');

    const first = structuredClone(planned.snapshot) as Snapshot;
    const second = structuredClone(planned.snapshot) as Snapshot;
    first.nodes = source.nodes.slice(0, 1);
    first.annotations = [];
    first.attachments = [];
    first.relations = [];
    first.tombstones = [];
    first.page = { sequence: 1, hasMore: true, nextCursor: 'cursor-2' };
    second.nodes = source.nodes.slice(1);
    second.page = { sequence: 2, hasMore: false, nextCursor: null };

    const started = createPublicationSnapshotPageSeries(first, {
      principal: 'anonymous',
      query: initialQuery,
    });
    const continuationQuery = Object.freeze({ limit: 1, pageCursor: 'cursor-2' });
    const continuation = planPublicationSnapshotDelivery(input(second, 'dynamic', continuationQuery));
    expect(continuation).toMatchObject({
      delivery: 'preserve-page',
      reason: 'continuation-page',
      logicalScope: 'complete',
      snapshot: { complete: true, page: { sequence: 2 } },
    });

    const manifest = JSON.parse(readFileSync(resolve(
      import.meta.dirname,
      '..',
      '..',
      'fixtures',
      'protocol',
      'examples',
      'public-manifest.json',
    ), 'utf8')) as unknown;
    const requested: string[] = [];
    const fetch = async (request: string | URL | Request): Promise<Response> => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      requested.push(url.href);
      if (url.pathname === '/.well-known/collection-protocol') return Response.json(manifest);
      if (url.searchParams.get('pageCursor') === null) {
        return createPublicationSnapshotPageResponse(started.page, {
          method: 'GET',
          headers: { ETag: '"snapshot-page-1"' },
          nextUrl: `https://alice.example/collections/c/${source.collection.id}/snapshot?limit=1&pageCursor=cursor-2`,
        });
      }
      expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '1', pageCursor: 'cursor-2' });
      return createPublicationSnapshotPageResponse(continuation.snapshot, {
        method: 'GET',
        headers: { ETag: '"snapshot-page-2"' },
        nextUrl: null,
      });
    };
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });

    const assembled = await client.getSnapshot(source.collection.id, { limit: 1 });
    expect(assembled).toMatchObject({
      snapshotId: source.snapshotId,
      complete: true,
      page: { sequence: 1, hasMore: false, nextCursor: null },
    });
    expect(assembled.nodes.map((node) => node.id)).toEqual(source.nodes.map((node) => node.id));
    expect(requested).toEqual([
      'https://alice.example/.well-known/collection-protocol',
      `https://alice.example/collections/c/${source.collection.id}/snapshot?limit=1`,
      `https://alice.example/collections/c/${source.collection.id}/snapshot?limit=1&pageCursor=cursor-2`,
    ]);
  });

  it(`chooses pagination for a dynamic authoritative representation over either small limit ${evidence}`, () => {
    const byBytes = planPublicationSnapshotDelivery(input(snapshotAtUtf8Bytes(publicationSnapshotDeliveryLimits.smallMaxUtf8Bytes + 1)));
    const byObjects = planPublicationSnapshotDelivery(input(snapshotAtObjectCount(publicationSnapshotDeliveryLimits.smallMaxObjects + 1)));
    expect(byBytes.delivery).toBe('paginate');
    expect(byObjects.delivery).toBe('paginate');
  });

  it(`keeps an explicitly static representation single-page above the small limits ${evidence}`, () => {
    expect(planPublicationSnapshotDelivery(input(
      snapshotAtUtf8Bytes(publicationSnapshotDeliveryLimits.smallMaxUtf8Bytes + 1),
      'static',
    )).delivery).toBe('single-page');
    expect(planPublicationSnapshotDelivery(input(
      snapshotAtObjectCount(publicationSnapshotDeliveryLimits.smallMaxObjects + 1),
      'static',
    )).delivery).toBe('single-page');
  });

  it(`uses an injected hard byte ceiling so static delivery accepts the exact limit and fails closed on +1 ${evidence}`, () => {
    // Keep production hardMaxUtf8Bytes large; inject a small ceiling instead of materializing 64MiB+.
    const hardMaxUtf8Bytes = utf8Bytes(fixture()) + 64;
    const limits = Object.freeze({ hardMaxUtf8Bytes });
    const atLimit = snapshotAtUtf8Bytes(hardMaxUtf8Bytes);
    const overLimit = snapshotAtUtf8Bytes(hardMaxUtf8Bytes + 1);
    expect(planPublicationSnapshotDelivery(input(atLimit, 'static'), { limits })).toMatchObject({
      delivery: 'single-page',
      metrics: { utf8Bytes: hardMaxUtf8Bytes },
    });
    const error = captureError(() => planPublicationSnapshotDelivery(input(overLimit, 'static'), { limits }));
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe('Static Publication Snapshot exceeds the safe single-page delivery limit.');
  });

  it(`uses an injected hard object ceiling so static delivery accepts the exact limit and fails closed on +1 ${evidence}`, () => {
    // Keep production hardMaxObjects at 1e6; inject a small ceiling instead of Array.from(1e6).
    const hardMaxObjects = objectCount(fixture()) + 3;
    const limits = Object.freeze({ hardMaxObjects });
    const atLimit = snapshotAtObjectCount(hardMaxObjects);
    const overLimit = snapshotAtObjectCount(hardMaxObjects + 1);
    expect(planPublicationSnapshotDelivery(input(atLimit, 'static'), { limits })).toMatchObject({
      delivery: 'single-page',
      metrics: { objectCount: hardMaxObjects },
    });
    const error = captureError(() => planPublicationSnapshotDelivery(input(overLimit, 'static'), { limits }));
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe('Publication Snapshot delivery input limit exceeded.');
  });

  it(`keeps production hard ceilings published at the large fail-closed defaults ${evidence}`, () => {
    expect(publicationSnapshotDeliveryLimits.hardMaxObjects).toBe(1_000_000);
    expect(publicationSnapshotDeliveryLimits.hardMaxUtf8Bytes).toBe(64 * 1_024 * 1_024);
  });

  it(`accepts ordinary mutable input but returns detached recursively frozen plans ${evidence}`, () => {
    const value = fixture();
    const query = { include: ['relations', 'attachments', 'annotations'] };
    const plan = planPublicationSnapshotDelivery(input(value, 'dynamic', query));
    value.collection.title = 'caller mutation';
    query.include[0] = 'caller mutation';
    expect(plan.snapshot.collection.title).not.toBe('caller mutation');
    expect(plan.snapshot).not.toBe(value);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.snapshot)).toBe(true);
    expect(Object.isFrozen(plan.snapshot.collection)).toBe(true);
    expect(Object.isFrozen(plan.snapshot.nodes)).toBe(true);
    expect(Reflect.set(plan.snapshot.collection, 'title', 'consumer mutation')).toBe(false);
  });

  it(`uses one stable non-reflective error for invalid classification query and body values ${evidence}`, () => {
    const errors = [
      () => planPublicationSnapshotDelivery(input(fixture(), 'secret' as PublicationCollectionClassification)),
      () => planPublicationSnapshotDelivery(input(fixture(), 'dynamic', { root: 'secret\u0000root' })),
      () => planPublicationSnapshotDelivery(input({ secret: 'body-secret' })),
    ].map((work) => captureError(work));
    expect(new Set(errors.map((error) => error.constructor))).toHaveProperty('size', 1);
    expect(new Set(errors.map((error) => error.message))).toEqual(new Set(['Publication Snapshot delivery input is invalid.']));
    expect(errors.map((error) => error.message).join(' ')).not.toMatch(/secret/iu);
  });

  it.each(['GET', 'HEAD'] as const)(`creates terminal %s responses without rel=next and preserves cache metadata ${evidence}`, async (method) => {
    const response = createPublicationSnapshotSinglePageResponse(single(), {
      method,
      headers: {
        Link: '<https://schema.example/snapshot>; rel=describedby',
        'Cache-Control': 'private, no-store',
        Vary: 'Origin, Authorization',
        Origin: 'https://app.example',
        ETag: '"principal-variant-a"',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Link')).toBe('<https://schema.example/snapshot>; rel=describedby');
    expect(response.headers.get('Link')).not.toMatch(/rel="?next/iu);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Origin, Authorization');
    expect(response.headers.get('Origin')).toBe('https://app.example');
    expect(response.headers.get('ETag')).toBe('"principal-variant-a"');
    if (method === 'HEAD') expect(await response.text()).toBe('');
    else expect(await response.json()).toMatchObject({ complete: true, page: { sequence: 1, hasMore: false } });
  });

  it(`rejects forged copied mutated and wrong-kind plans at the response authority boundary ${evidence}`, () => {
    const issued = single();
    const copied = { ...issued };
    const proxied = new Proxy(issued, {});
    const mutatedCopy = structuredClone(issued) as PublicationSnapshotSinglePagePlan;
    (mutatedCopy.snapshot as Snapshot).collection.title = 'mutated copy';
    const cropped = fixture();
    cropped.complete = false;
    const preserve = planPublicationSnapshotDelivery(input(cropped, 'static', { depth: 1 }));
    const paginate = planPublicationSnapshotDelivery(input(
      snapshotAtUtf8Bytes(publicationSnapshotDeliveryLimits.smallMaxUtf8Bytes + 1),
    ));
    const forged = {
      delivery: 'single-page',
      classification: 'static',
      snapshot: fixture(),
      metrics: { utf8Bytes: 1, objectCount: 1 },
    } as unknown as PublicationSnapshotSinglePagePlan;

    for (const plan of [forged, copied, proxied, mutatedCopy, preserve, paginate]) {
      expect(() => createPublicationSnapshotSinglePageResponse(
        plan as PublicationSnapshotSinglePagePlan,
        { method: 'GET' },
      )).toThrow(new TypeError('Publication Snapshot delivery input is invalid.'));
    }

    expect(createPublicationSnapshotSinglePageResponse(issued, { method: 'HEAD' }).status).toBe(200);
  });

  it.each([400, 401, 403, 404, 409, 500, 503])(
    `does not leak a stale next Link on error status %s and preserves response policy headers ${evidence}`,
    (status) => {
      const response = createPublicationSnapshotSinglePageResponse(single(), {
        method: 'HEAD',
        status,
        headers: {
          Link: '<https://cdn.example/page-2?pageCursor=secret>; rel="next", <https://schema.example>; rel=describedby',
          'Cache-Control': 'private, no-store',
          Vary: 'Authorization',
        },
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('Link')).toBe('<https://schema.example>; rel=describedby');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.get('Vary')).toBe('Authorization');
      expect(response.body).toBeNull();
    },
  );

  it(`keeps Principal and cache variants detached while preserving caller-selected validators ${evidence}`, () => {
    const plan = single();
    const alice = createPublicationSnapshotSinglePageResponse(plan, {
      method: 'GET', headers: { Vary: 'Authorization', ETag: '"alice"' },
    });
    const bob = createPublicationSnapshotSinglePageResponse(plan, {
      method: 'GET', headers: { Vary: 'Authorization', ETag: '"bob"' },
    });
    alice.headers.set('ETag', '"mutated"');
    expect(bob.headers.get('ETag')).toBe('"bob"');
    expect(bob.headers.get('Vary')).toBe('Authorization');
  });

  it(`does not use a cross-Origin endpoint or Content-Location to influence the representation decision ${evidence}`, () => {
    const first = planPublicationSnapshotDelivery(input(fixture()));
    const second = planPublicationSnapshotDelivery(input(fixture()));
    const response = createPublicationSnapshotSinglePageResponse(second as PublicationSnapshotSinglePagePlan, {
      method: 'GET',
      headers: { 'Content-Location': 'https://cdn.other.example/snapshots/current.json' },
    });
    expect(second).toEqual(first);
    expect(response.headers.get('Content-Location')).toBe('https://cdn.other.example/snapshots/current.json');
    expect(response.headers.get('Link')).toBeNull();
  });

  it(`excludes Principal and endpoint hints from the delivery-policy trust boundary ${evidence}`, () => {
    for (const extra of [
      { principal: 'principal:publication:alice' },
      { endpoint: 'https://attacker.example/snapshot' },
    ]) {
      const error = captureError(() => planPublicationSnapshotDelivery({
        ...input(fixture()),
        ...extra,
      } as unknown as PublicationSnapshotDeliveryInput));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toBe('Publication Snapshot delivery input is invalid.');
      expect(error.message).not.toMatch(/alice|attacker/iu);
    }
  });

  it(`preserves PUB-0005 replacement PUB-0033 page scope and PUB-0034 terminal Link contracts ${evidence}`, () => {
    const plan = single();
    expect(validatePublicationSnapshotReplacementSemantics(plan.snapshot).valid).toBe(true);
    expect(createPublicationSnapshotPageSeries(plan.snapshot, {
      principal: 'principal:publication:alice',
      query: {},
    }).page).toEqual(plan.snapshot);
    expect(createPublicationSnapshotPageResponse(plan.snapshot, {
      method: 'GET',
      nextUrl: null,
    }).headers.get('Link')).toBeNull();
    expect(() => createPublicationSnapshotPageResponse(plan.snapshot, {
      method: 'GET',
      nextUrl: 'https://cdn.example/page-2?pageCursor=cursor-2',
    })).toThrow(TypeError);
  });
});
