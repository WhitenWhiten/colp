import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = '[evidence:schema.deletion-receipt]';
const validators = createValidatorRegistry();

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'node',
    targetId: 'node-1',
    collectionId: 'collection-1',
    scope: 'single',
    deletedAt: '2026-07-19T07:08:09.123Z',
    deleteRevision: 'revision-delete-1',
    operationId: 'operation-delete-1',
    affectedCount: 1,
    purgeAfter: '2026-08-18T07:08:09.123Z',
    ...overrides,
  };
}

function expectInvalid(candidate: unknown): void {
  expect(validators.validate('deletionReceipt', candidate).valid).toBe(false);
}

describe(`PUBLISH-0005 Publisher Deletion Receipts ${evidence}`, () => {
  it(`accepts canonical Collection and Node deletion receipts ${evidence}`, () => {
    const collectionReceipt = receipt({
      resourceType: 'collection',
      targetId: 'collection-1',
      scope: 'single',
      deletedBy: 'user:alice@example.com',
    });
    const nodeReceipt = receipt({
      resourceType: 'node',
      targetId: 'folder-1',
      scope: 'subtree',
      affectedCount: 37,
    });

    expect(validators.validate('deletionReceipt', collectionReceipt)).toEqual({
      valid: true,
      errors: [],
    });
    expect(validators.validate('deletionReceipt', nodeReceipt)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it(`is valid without a Sync cursor and never requires one ${evidence}`, () => {
    const value = receipt();

    expect(value).not.toHaveProperty('deleteCursor');
    expect(value).not.toHaveProperty('cursor');
    expect(validators.validate('deletionReceipt', value)).toEqual({ valid: true, errors: [] });
  });

  it.each(['deleteCursor', 'cursor', 'syncCursor'])(
    `fails closed when a forged %s is injected ${evidence}`,
    (field) => {
      const result = validators.validate('deletionReceipt', {
        ...receipt(),
        [field]: 'fabricated-sync-position',
      });

      expect(result.valid).toBe(false);
      if (result.valid) throw new Error('Expected the forged cursor to be rejected.');
      expect(result.errors).toContainEqual(expect.objectContaining({
        keyword: 'additionalProperties',
        params: { additionalProperty: field },
      }));
    },
  );

  it(`enforces affectedCount, deletion-watermark, and identity boundaries ${evidence}`, () => {
    const decimalLikeIdentity = '000900719925474099312345678901234567890';
    const boundary = receipt({
      targetId: `node-${decimalLikeIdentity}`,
      collectionId: `collection-${decimalLikeIdentity}`,
      deleteRevision: `revision-${decimalLikeIdentity}`,
      operationId: `operation-${decimalLikeIdentity}`,
      affectedCount: 1,
    });

    expect(validators.validate('deletionReceipt', boundary)).toEqual({ valid: true, errors: [] });
    expect(boundary).toMatchObject({
      targetId: `node-${decimalLikeIdentity}`,
      collectionId: `collection-${decimalLikeIdentity}`,
      deleteRevision: `revision-${decimalLikeIdentity}`,
      operationId: `operation-${decimalLikeIdentity}`,
      affectedCount: 1,
    });

    const maximumOpaqueId = 'a'.repeat(128);
    expect(validators.validate('deletionReceipt', receipt({
      targetId: maximumOpaqueId,
      collectionId: maximumOpaqueId,
      deleteRevision: maximumOpaqueId,
      operationId: maximumOpaqueId,
    }))).toEqual({ valid: true, errors: [] });

    for (const affectedCount of [0, -1, 1.5, '1', null]) {
      expectInvalid(receipt({ affectedCount }));
    }
    for (const [field, value] of [
      ['targetId', ''],
      ['collectionId', 'collection/1'],
      ['deleteRevision', 'revision with spaces'],
      ['deleteRevision', 'r'.repeat(129)],
      ['operationId', 'operation#1'],
    ] as const) {
      expectInvalid(receipt({ [field]: value }));
    }
  });

  it(`fails closed on missing required, malformed, and unknown receipt fields ${evidence}`, () => {
    const missingRevision = receipt();
    delete missingRevision.deleteRevision;

    for (const candidate of [
      missingRevision,
      receipt({ resourceType: 'event' }),
      receipt({ scope: 'children' }),
      receipt({ deletedAt: '2026-02-31T07:08:09Z' }),
      receipt({ purgeAfter: 'not-a-date' }),
      receipt({ futureCoreField: true }),
      receipt({ deletedBy: false }),
      null,
      [],
    ]) {
      expectInvalid(candidate);
    }
  });

  it(`keeps the legacy Sync Tombstone cursor requirement distinct ${evidence}`, () => {
    const publisherReceipt = receipt();
    const syncTombstone = { ...publisherReceipt, deleteCursor: 'sync-delete-42' };

    expect(validators.validate('syncTombstone', publisherReceipt).valid).toBe(false);
    expect(validators.validate('syncTombstone', syncTombstone)).toEqual({
      valid: true,
      errors: [],
    });
    expect(validators.validate('deletionReceipt', syncTombstone).valid).toBe(false);
  });
});
