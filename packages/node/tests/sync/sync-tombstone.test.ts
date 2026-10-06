import { describe, expect, it } from 'vitest';

import * as publisherApi from '../../src/publisher/index.js';
import * as publicSyncApi from '../../src/sync/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import * as syncApi from '../../src/sync/index.js';
import { createSyncTombstone as typedCreateSyncTombstone } from '../../src/sync/tombstone.js';
import type { SyncTombstone } from '../../src/types/generated.js';

const evidence = '[evidence:schema.sync-tombstone]';
const validators = createValidatorRegistry();
const createSyncTombstone = typedCreateSyncTombstone as (
  receipt: unknown,
  deleteCursor: unknown,
) => SyncTombstone;

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'node',
    targetId: 'node-1',
    collectionId: 'collection-1',
    scope: 'single',
    deletedAt: '2026-07-18T02:03:04.567Z',
    deletedBy: 'user:alice@example.com',
    deleteRevision: 'revision-delete-1',
    operationId: 'operation-delete-1',
    affectedCount: 1,
    purgeAfter: '2026-08-17T02:03:04.567Z',
    ...overrides,
  };
}

function tombstone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...receipt(), deleteCursor: '00000000000000000042', ...overrides };
}

function expectInvalid(candidate: unknown): void {
  expect(validators.validate('syncTombstone', candidate).valid).toBe(false);
}

describe(`SYNC-0008 Sync Tombstones ${evidence}`, () => {
  it(`converts a canonical Publisher Deletion Receipt by adding the supplied deleteCursor ${evidence}`, () => {
    expect(createSyncTombstone(receipt(), 'cursor-delete-42')).toEqual({
      ...receipt(),
      deleteCursor: 'cursor-delete-42',
    });
  });

  it(`preserves an optional deletedBy exactly and does not fabricate it when absent ${evidence}`, () => {
    const withActor = createSyncTombstone(receipt({ deletedBy: 'service:sync-worker' }), 'cursor-1');
    const withoutActorReceipt = receipt();
    delete withoutActorReceipt.deletedBy;
    const withoutActor = createSyncTombstone(withoutActorReceipt, 'cursor-2');

    expect(withActor.deletedBy).toBe('service:sync-worker');
    expect(withoutActor).not.toHaveProperty('deletedBy');
  });

  it(`produces values accepted by the canonical Sync Tombstone validator ${evidence}`, () => {
    const value = createSyncTombstone(receipt(), 'cursor-schema-1');

    expect(validators.validate('syncTombstone', value)).toEqual({ valid: true, errors: [] });
  });

  it(`keeps Publisher receipts cursor-free and rejects a cursor injected into that schema ${evidence}`, () => {
    const value = receipt();

    expect(validators.validate('deletionReceipt', value)).toEqual({ valid: true, errors: [] });
    expect(validators.validate('deletionReceipt', { ...value, deleteCursor: 'cursor-1' }).valid)
      .toBe(false);
  });

  it(`rejects a missing deleteCursor instead of fabricating one ${evidence}`, () => {
    expectInvalid(receipt());
    expect(() => createSyncTombstone(receipt(), undefined as unknown as string)).toThrow();
  });

  it(`rejects empty and non-canonical deleteCursor values ${evidence}`, () => {
    for (const cursor of ['', 'cursor with spaces', 'cursor/slash', 'x'.repeat(129), 42, null]) {
      expectInvalid(tombstone({ deleteCursor: cursor }));
      expect(() => createSyncTombstone(receipt(), cursor as string)).toThrow();
    }
  });

  it(`preserves long decimal-looking opaque IDs as strings without numeric coercion ${evidence}`, () => {
    const cursor = '000900719925474099312345678901234567890';
    const value = createSyncTombstone(receipt({
      targetId: '000000000000000000000000000000000000007',
      deleteRevision: '0009007199254740993',
      operationId: '0009007199254740994',
    }), cursor);

    expect(value).toMatchObject({
      targetId: '000000000000000000000000000000000000007',
      deleteRevision: '0009007199254740993',
      operationId: '0009007199254740994',
      deleteCursor: cursor,
    });
  });

  it(`does not mutate the source receipt on success ${evidence}`, () => {
    const source = receipt();
    const before = structuredClone(source);

    createSyncTombstone(source, 'cursor-immutable-1');

    expect(source).toEqual(before);
    expect(source).not.toHaveProperty('deleteCursor');
  });

  it(`returns a detached, deeply frozen canonical value ${evidence}`, () => {
    const source = receipt();
    const value = createSyncTombstone(source, 'cursor-frozen-1');

    expect(value).not.toBe(source);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(value, 'targetId', 'node-replaced')).toBe(false);
    expect(value.targetId).toBe('node-1');
    expect(source.targetId).toBe('node-1');
  });

  it(`accepts every canonical deletable resourceType ${evidence}`, () => {
    for (const resourceType of ['collection', 'node', 'annotation', 'attachment', 'relation'] as const) {
      const value = createSyncTombstone(receipt({
        resourceType,
        ...(resourceType === 'collection' ? { targetId: 'collection-1' } : {}),
      }), `cursor-${resourceType}`);
      expect(value.resourceType).toBe(resourceType);
      expect(validators.validate('syncTombstone', value)).toEqual({ valid: true, errors: [] });
    }
  });

  it(`accepts both single-resource and subtree deletion scopes ${evidence}`, () => {
    expect(createSyncTombstone(receipt({ scope: 'single', affectedCount: 1 }), 'cursor-single'))
      .toMatchObject({ scope: 'single', affectedCount: 1 });
    expect(createSyncTombstone(receipt({ scope: 'subtree', affectedCount: 37 }), 'cursor-subtree'))
      .toMatchObject({ scope: 'subtree', affectedCount: 37 });
  });

  it(`does not add cross-field restrictions absent from the canonical schemas ${evidence}`, () => {
    for (const overrides of [
      { resourceType: 'collection', targetId: 'collection-target', collectionId: 'collection-owner' },
      { resourceType: 'annotation', scope: 'subtree', affectedCount: 2 },
      { scope: 'single', affectedCount: 2 },
    ]) {
      const source = receipt(overrides);
      expect(validators.validate('deletionReceipt', source)).toEqual({ valid: true, errors: [] });
      const value = createSyncTombstone(source, 'cursor-schema-boundary');
      expect(validators.validate('syncTombstone', value)).toEqual({ valid: true, errors: [] });
    }
  });

  it(`enforces the affectedCount positive safe-integer boundary ${evidence}`, () => {
    expect(validators.validate('syncTombstone', tombstone({ affectedCount: 1 })))
      .toEqual({ valid: true, errors: [] });
    for (const affectedCount of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
      expectInvalid(tombstone({ affectedCount }));
      expect(() => createSyncTombstone(receipt({ affectedCount }), 'cursor-count')).toThrow();
    }

    // Upper safe-integer bound: MAX_SAFE_INTEGER is a valid positive count at the
    // createSyncTombstone runtime boundary (member-set materialization is out of scope).
    const maxSafe = createSyncTombstone(
      receipt({ scope: 'subtree', affectedCount: Number.MAX_SAFE_INTEGER }),
      'cursor-count-max-safe',
    );
    expect(maxSafe.affectedCount).toBe(Number.MAX_SAFE_INTEGER);

    // One past the IEEE-safe integer range must be rejected by createSyncTombstone
    // specifically (JSON Schema may still accept the number as type:integer).
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    expect(() => createSyncTombstone(
      receipt({ affectedCount: unsafeInteger }),
      'cursor-count-unsafe',
    )).toThrow(/positive safe integer/u);
  });

  it(`accepts representable RFC 3339 timestamps with offsets and fractional seconds ${evidence}`, () => {
    const value = createSyncTombstone(receipt({
      deletedAt: '2026-07-18T10:03:04.123456+08:00',
      purgeAfter: '2026-08-17T01:33:04.9-00:30',
    }), 'cursor-date');

    expect(value.deletedAt).toBe('2026-07-18T10:03:04.123456+08:00');
    expect(value.purgeAfter).toBe('2026-08-17T01:33:04.9-00:30');
    expect(validators.validate('syncTombstone', value).valid).toBe(true);
  });

  it(`rejects schema-invalid timestamps ${evidence}`, () => {
    for (const [field, value] of [
      ['deletedAt', '2026-02-31T02:03:04Z'],
      ['deletedAt', '2024-06-30T23:58:60Z'],
      ['purgeAfter', '2026-08-17 02:03:04Z'],
      ['purgeAfter', 'not-a-date'],
    ] as const) {
      expectInvalid(tombstone({ [field]: value }));
      expect(() => createSyncTombstone(receipt({ [field]: value }), 'cursor-date')).toThrow();
    }
  });

  it(`rejects every missing required receipt field ${evidence}`, () => {
    for (const field of [
      'resourceType', 'targetId', 'collectionId', 'scope', 'deletedAt', 'deleteRevision',
      'operationId', 'affectedCount', 'purgeAfter',
    ]) {
      const candidate = receipt();
      delete candidate[field];
      expect(() => createSyncTombstone(candidate, 'cursor-required')).toThrow();
    }
  });

  it(`rejects unknown receipt and Tombstone fields ${evidence}`, () => {
    expect(() => createSyncTombstone(receipt({ futureCoreField: true }), 'cursor-unknown'))
      .toThrow();
    expectInvalid(tombstone({ futureCoreField: true }));
  });

  it(`rejects wrong primitive types for canonical fields ${evidence}`, () => {
    for (const [field, value] of [
      ['targetId', 7],
      ['collectionId', null],
      ['deletedAt', new Date('2026-07-18T02:03:04Z')],
      ['deletedBy', false],
      ['deleteRevision', {}],
      ['operationId', []],
      ['purgeAfter', 1_789_000_000],
    ] as const) {
      expectInvalid(tombstone({ [field]: value }));
      expect(() => createSyncTombstone(receipt({ [field]: value }), 'cursor-type')).toThrow();
    }
  });

  it(`rejects invalid enums and malformed opaque IDs ${evidence}`, () => {
    for (const overrides of [
      { resourceType: 'event' },
      { scope: 'children' },
      { targetId: '' },
      { collectionId: 'collection/1' },
      { deleteRevision: 'revision 1' },
      { operationId: 'operation#1' },
    ]) {
      expectInvalid(tombstone(overrides));
      expect(() => createSyncTombstone(receipt(overrides), 'cursor-enum')).toThrow();
    }
  });

  it(`rejects arrays and non-object inputs at both API boundaries ${evidence}`, () => {
    for (const candidate of [null, undefined, true, 1, 'receipt', [], [receipt()]]) {
      expectInvalid(candidate);
      expect(() => createSyncTombstone(candidate, 'cursor-object'))
        .toThrow();
    }
  });

  it(`rejects class instances and inherited data while accepting an exact null-prototype receipt ${evidence}`, () => {
    class ReceiptRecord {
      public resourceType = 'node';
      public targetId = 'node-1';
    }
    const inherited = Object.assign(Object.create(receipt()), { affectedCount: 1 });
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, receipt());

    expect(() => createSyncTombstone(new ReceiptRecord() as unknown as Record<string, unknown>, 'cursor-class'))
      .toThrow();
    expect(() => createSyncTombstone(inherited as Record<string, unknown>, 'cursor-inherited'))
      .toThrow();
    expect(createSyncTombstone(nullPrototype, 'cursor-null-prototype'))
      .toEqual(tombstone({ deleteCursor: 'cursor-null-prototype' }));
  });

  it(`rejects accessors without executing them ${evidence}`, () => {
    let calls = 0;
    const source = receipt();
    Object.defineProperty(source, 'targetId', {
      enumerable: true,
      get() {
        calls += 1;
        return 'node-accessor';
      },
    });

    expect(() => createSyncTombstone(source, 'cursor-accessor')).toThrow();
    expect(calls).toBe(0);
  });

  it(`rejects non-enumerable and Symbol-keyed fields ${evidence}`, () => {
    const hidden = receipt();
    Object.defineProperty(hidden, 'internalCursor', { enumerable: false, value: 'cursor-hidden' });
    const hiddenRequired = receipt();
    Object.defineProperty(hiddenRequired, 'operationId', {
      enumerable: false,
      value: 'operation-delete-1',
    });
    const symbol = receipt();
    Object.defineProperty(symbol, Symbol('internal'), { enumerable: true, value: 'secret' });

    expect(() => createSyncTombstone(hidden, 'cursor-hidden')).toThrow();
    expect(() => createSyncTombstone(hiddenRequired, 'cursor-hidden-required')).toThrow();
    expect(() => createSyncTombstone(symbol, 'cursor-symbol')).toThrow();
  });

  it(`rejects own prototype-pollution keys without changing global prototypes ${evidence}`, () => {
    for (const key of ['__proto__', 'constructor', 'prototype'] as const) {
      const source = receipt();
      Object.defineProperty(source, key, { enumerable: true, value: { polluted: true } });
      expect(() => createSyncTombstone(source, 'cursor-pollution')).toThrow();
    }

    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it(`exports one Sync-only implementation without adding Publisher CRUD ${evidence}`, () => {
    expect(syncApi.createSyncTombstone).toBe(createSyncTombstone);
    expect(publicSyncApi.createSyncTombstone).toBe(createSyncTombstone);
    expect(publisherApi).not.toHaveProperty('createSyncTombstone');
    expect(publisherApi).not.toHaveProperty('deleteCursor');
    expect(Object.keys(publisherApi).filter((name) => /tombstone/i.test(name))).toEqual([]);
  });
});
