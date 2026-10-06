import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isProxy } from 'node:util/types';

import { describe, expect, it } from 'vitest';

import { cloneAndFreezeJsonData } from '../../src/schema/index.js';
import {
  planPublicationSnapshotDelivery,
  type PublicationCollectionClassification,
  type PublicationSnapshotDeliveryInput,
} from '../../src/server/index.js';
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

function captureError(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected Snapshot delivery planning to fail.');
}

describe(`PUB-0035 Snapshot delivery graph DAG, cycle, and cause ${evidence}`, () => {
  it(`accepts a snapshot DAG where two nodes share Object.freeze([]) tags ${evidence}`, () => {
    const value = fixture();
    // SnapshotNode forbids an `annotations` member; tags is the schema-legal array slot.
    const annotations = Object.freeze([]);
    (value.nodes[0] as { tags: readonly string[] }).tags = annotations;
    (value.nodes[1] as { tags: readonly string[] }).tags = annotations;
    expect(value.nodes[0]?.tags).toBe(annotations);
    expect(value.nodes[1]?.tags).toBe(annotations);

    expect(() => cloneAndFreezeJsonData(value)).not.toThrow();
    const plan = planPublicationSnapshotDelivery(input(value));
    expect(plan).toMatchObject({ delivery: 'single-page' });
    if (plan.delivery === 'preserve-page') throw new Error('Expected a measured delivery plan.');

    const distinct = fixture();
    (distinct.nodes[0] as { tags: readonly string[] }).tags = [];
    (distinct.nodes[1] as { tags: readonly string[] }).tags = [];
    const tree = planPublicationSnapshotDelivery(input(distinct));
    if (tree.delivery === 'preserve-page') throw new Error('Expected a measured delivery plan.');
    expect(plan.metrics).toEqual(tree.metrics);
    expect(plan.metrics.utf8Bytes).toBe(utf8Bytes(value));
    expect(plan.metrics.objectCount).toBeGreaterThan(objectCount(value));
  });

  it(`rejects a self-referential snapshot cycle and preserves the inner TypeError as cause ${evidence}`, () => {
    const cyclic = fixture() as Snapshot & { cycle?: unknown };
    cyclic.cycle = cyclic;
    expect(() => cloneAndFreezeJsonData(cyclic)).toThrow(/cyclic references are not JSON data/u);
    const error = captureError(() => planPublicationSnapshotDelivery(input(cyclic)));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe('Publication Snapshot delivery input is invalid.');
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it(`counts shared Snapshot subtrees per visit so hardMaxObjects is not under-counted ${evidence}`, () => {
    const value = fixture();
    const annotations = Object.freeze([]);
    (value.nodes[0] as { tags: readonly string[] }).tags = annotations;
    (value.nodes[1] as { tags: readonly string[] }).tags = annotations;
    const uniqueObjects = objectCount(value);
    const error = captureError(() => planPublicationSnapshotDelivery(input(value, 'static'), {
      limits: { hardMaxObjects: uniqueObjects },
    }));
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe('Publication Snapshot delivery input limit exceeded.');
    expect(error.cause).toBeInstanceOf(Error);

    const plan = planPublicationSnapshotDelivery(input(value, 'static'), {
      limits: { hardMaxObjects: uniqueObjects + 1 },
    });
    expect(plan).toMatchObject({
      delivery: 'single-page',
      metrics: { objectCount: uniqueObjects + 1 },
    });
  });

  it(`rejects Proxy accessor cycle symbol and sparse graphs with stable non-reflective errors ${evidence}`, () => {
    const secret = 'snapshot-secret-0035';
    const accessor = fixture();
    Object.defineProperty(accessor.collection, 'title', { enumerable: true, get: () => secret });
    const cycle = fixture() as Snapshot & { cycle?: unknown };
    cycle.cycle = cycle;
    const symbol = fixture();
    (symbol.collection as unknown as Record<PropertyKey, unknown>)[Symbol(secret)] = true;
    const sparse = fixture();
    sparse.warnings = Array(2);
    const proxy = new Proxy(fixture(), { ownKeys: () => { throw new Error(secret); } });

    for (const value of [accessor, cycle, symbol, sparse, proxy]) {
      const error = captureError(() => planPublicationSnapshotDelivery(input(value)));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toBe('Publication Snapshot delivery input is invalid.');
      expect(error.message).not.toContain(secret);
      expect(error.cause).toBeInstanceOf(TypeError);
      expect(String(error.cause)).not.toContain(secret);
    }
    expect(isProxy(proxy)).toBe(true);
  });

  it(`preserves the inner TypeError as cause for illegal prototypes and classifications ${evidence}`, () => {
    const inheritedInput = Object.assign(Object.create({ hidden: true }), input(fixture()));
    const prototypeError = captureError(
      () => planPublicationSnapshotDelivery(inheritedInput as PublicationSnapshotDeliveryInput),
    );
    expect(prototypeError).toBeInstanceOf(TypeError);
    expect(prototypeError.message).toBe('Publication Snapshot delivery input is invalid.');
    expect(prototypeError.cause).toBeInstanceOf(TypeError);

    const inheritedSnapshot = Object.assign(Object.create({ hidden: true }), fixture());
    const snapshotPrototypeError = captureError(() => planPublicationSnapshotDelivery(input(inheritedSnapshot)));
    expect(snapshotPrototypeError).toBeInstanceOf(TypeError);
    expect(snapshotPrototypeError.cause).toBeInstanceOf(TypeError);

    const classificationError = captureError(
      () => planPublicationSnapshotDelivery(input(fixture(), 'secret' as PublicationCollectionClassification)),
    );
    expect(classificationError).toBeInstanceOf(TypeError);
    expect(classificationError.message).toBe('Publication Snapshot delivery input is invalid.');
    expect(classificationError.cause).toBeInstanceOf(TypeError);
    expect(String(classificationError.cause)).not.toMatch(/secret/iu);
  });

  it(`treats empty limits as omitted production defaults for the same snapshot ${evidence}`, () => {
    for (const classification of ['static', 'dynamic'] as const) {
      const snapshot = fixture();
      const omitted = planPublicationSnapshotDelivery(input(snapshot, classification));
      const emptyLimits = planPublicationSnapshotDelivery(input(snapshot, classification), { limits: {} });
      expect(emptyLimits.delivery).toBe(omitted.delivery);
      expect(emptyLimits).toEqual(omitted);
    }
  });
});
