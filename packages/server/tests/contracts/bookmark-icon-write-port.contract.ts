import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'vitest';
import type {
  BookmarkIconRow,
  BookmarkIconWritePort,
} from '../../src/modules/collections/index.js';

const COLLECTION_A = 'contract-icon-collection-a';
const COLLECTION_B = 'contract-icon-collection-b';
const NODE_A = 'contract-icon-node-a';
const NODE_B = 'contract-icon-node-b';
const NODE_C = 'contract-icon-node-c';
const CREATED_AT = new Date('2026-08-30T09:00:00.000Z');

export interface BookmarkIconWritePortContractOptions {
  readonly name: string;
  readonly createPort: () => BookmarkIconWritePort | Promise<BookmarkIconWritePort>;
  readonly reset?: () => void | Promise<void>;
}

function iconRow(
  nodeId: string,
  objectId: string,
  overrides: Partial<BookmarkIconRow> = {},
): BookmarkIconRow {
  return {
    nodeId,
    collectionId: overrides.collectionId ?? COLLECTION_A,
    objectId,
    contentType: overrides.contentType ?? 'image/png',
    byteSize: overrides.byteSize ?? 32,
    digestSha256: overrides.digestSha256 ?? Buffer.alloc(32, nodeId.charCodeAt(nodeId.length - 1)),
    createdAt: overrides.createdAt ?? CREATED_AT,
    updatedAt: overrides.updatedAt ?? CREATED_AT,
  };
}

function snapshot(row: BookmarkIconRow): BookmarkIconRow {
  return {
    ...row,
    digestSha256: Buffer.from(row.digestSha256),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/** Registers the complete collections-owned bookmark icon adapter contract. */
export function defineBookmarkIconWritePortContract(
  options: BookmarkIconWritePortContractOptions,
): void {
  describe(options.name, () => {
    beforeEach(async () => options.reset?.());

    test('upserts and reads complete rows while omitting missing ids from bulk lookup', async () => {
      const port = await options.createPort();
      const rowA = iconRow(NODE_A, '11111111-1111-4111-8111-111111111111');
      const rowB = iconRow(NODE_B, '22222222-2222-4222-8222-222222222222');
      await port.upsert(rowA);
      await port.upsert(rowB);

      assert.deepEqual(await port.findByNodeId(NODE_A), snapshot(rowA));
      assert.equal(await port.findByNodeId('contract-icon-missing'), null);
      assert.deepEqual(
        [...(await port.findObjectIdsByNodeIds([NODE_B, 'contract-icon-missing', NODE_A])).entries()].sort(),
        [[NODE_A, rowA.objectId], [NODE_B, rowB.objectId]],
      );
      assert.equal((await port.findObjectIdsByNodeIds([])).size, 0);
    });

    test('updates mutable fields while preserving the original creation time', async () => {
      const port = await options.createPort();
      const original = iconRow(NODE_A, '33333333-3333-4333-8333-333333333333');
      const updatedAt = new Date('2026-08-30T09:05:00.000Z');
      await port.upsert(original);
      const replacement = iconRow(NODE_A, '44444444-4444-4444-8444-444444444444', {
        contentType: 'image/webp',
        byteSize: 64,
        digestSha256: Buffer.alloc(32, 9),
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
        updatedAt,
      });
      await port.upsert(replacement);

      assert.deepEqual(await port.findByNodeId(NODE_A), snapshot({
        ...replacement,
        createdAt: original.createdAt,
      }));
    });

    test('snapshots mutable buffers and dates at the adapter boundary', async () => {
      const port = await options.createPort();
      const digest = Buffer.alloc(32, 5);
      const createdAt = new Date(CREATED_AT);
      const row = iconRow(NODE_A, '55555555-5555-4555-8555-555555555555', {
        digestSha256: digest,
        createdAt,
      });
      const expected = snapshot(row);
      await port.upsert(row);

      digest.fill(0);
      createdAt.setUTCFullYear(2035);

      assert.deepEqual(await port.findByNodeId(NODE_A), expected);
    });

    test('enforces one binding per object id without replacing the winner', async () => {
      const port = await options.createPort();
      const winner = iconRow(NODE_A, '66666666-6666-4666-8666-666666666666');
      await port.upsert(winner);

      await assert.rejects(() => port.upsert(iconRow(NODE_B, winner.objectId)));
      assert.deepEqual(await port.findByNodeId(NODE_A), snapshot(winner));
      assert.equal(await port.findByNodeId(NODE_B), null);
    });

    test('returns the deleted row and makes single-node deletion idempotent', async () => {
      const port = await options.createPort();
      const row = iconRow(NODE_A, '77777777-7777-4777-8777-777777777777');
      await port.upsert(row);

      assert.deepEqual(await port.deleteByNodeId(NODE_A), snapshot(row));
      assert.equal(await port.deleteByNodeId(NODE_A), null);
      assert.equal(await port.findByNodeId(NODE_A), null);
    });

    test('bulk deletion is scoped by node ids or collection id', async () => {
      const port = await options.createPort();
      const rowA = iconRow(NODE_A, '88888888-8888-4888-8888-888888888888');
      const rowB = iconRow(NODE_B, '99999999-9999-4999-8999-999999999999');
      const rowC = iconRow(NODE_C, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        collectionId: COLLECTION_B,
      });
      await port.upsert(rowA);
      await port.upsert(rowB);
      await port.upsert(rowC);

      await port.deleteByNodeIds([]);
      await port.deleteByNodeIds([NODE_A, 'contract-icon-missing']);
      assert.equal(await port.findByNodeId(NODE_A), null);
      assert.deepEqual(await port.findByNodeId(NODE_B), snapshot(rowB));

      await port.deleteByCollectionId(COLLECTION_A);
      assert.equal(await port.findByNodeId(NODE_B), null);
      assert.deepEqual(await port.findByNodeId(NODE_C), snapshot(rowC));
    });
  });
}

export const BOOKMARK_ICON_CONTRACT_FIXTURE = Object.freeze({
  collectionA: COLLECTION_A,
  collectionB: COLLECTION_B,
  nodeA: NODE_A,
  nodeB: NODE_B,
  nodeC: NODE_C,
});
