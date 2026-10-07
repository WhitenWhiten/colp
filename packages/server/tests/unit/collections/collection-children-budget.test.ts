/**
 * FO-05 children page byte-budget selection unit tests (pure).
 * Covers the 65536 UTF-8 byte budget: byte-limited short pages still emit a
 * nextCursor for the first unconsumed eligible item, items are never cut or
 * truncated, the item limit is binding, same-millisecond ties resume by
 * ascending id (cursor after carries the boundary node id), and a single item
 * that cannot fit fails closed instead of silently dropping it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  COLLECTION_CHILDREN_MAX_BYTES,
  createCollectionChildrenCursorSigner,
  selectItemsWithinBudget,
  type BrowseNode,
  type CollectionChildrenCursorPayload,
} from '../../../src/modules/collections/index.js';

const KEY = Buffer.alloc(32, 7).toString('base64url');
const signer = createCollectionChildrenCursorSigner(KEY);

function node(id: string, overrides: Partial<BrowseNode> = {}): BrowseNode {
  return {
    id,
    parentId: 'root-fo05-0001',
    kind: 'bookmark',
    title: `Bookmark ${id}`,
    url: 'https://example.test/a',
    description: null,
    position: `P${id}`,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:01.000Z',
    iconUrl: null,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    collectionId: 'coll-fo05-0001',
    parentId: 'root-fo05-0001',
    rootId: 'root-fo05-0001',
    contentRevision: 'coll-content-1',
    sort: 'created_asc' as const,
    itemsLimit: 50,
    viewer: 'anon',
    collectionIdForCursor: 'coll-fo05-0001',
    parentIdForCursor: '',
    issuedAt: '2026-09-14T00:00:00.000Z',
    expiresAt: '2026-09-14T00:15:00.000Z',
    ...overrides,
  };
}

function cursorPayloadOf(token: string | null, contextValue: ReturnType<typeof context>): CollectionChildrenCursorPayload | null {
  if (token === null) return null;
  // Verify strictly inside the 900s window (at expiry the codec reports 409).
  return signer.verify(token, new Date(Date.parse(contextValue.issuedAt) + 1000));
}

function serializedBytes(items: readonly BrowseNode[], nextCursor: string | null, contextValue: ReturnType<typeof context>): number {
  return Buffer.byteLength(JSON.stringify({
    collectionId: contextValue.collectionId,
    parentId: contextValue.parentId,
    rootId: contextValue.rootId,
    contentRevision: contextValue.contentRevision,
    sort: contextValue.sort,
    items,
    nextCursor,
  }), 'utf8');
}

describe('selectItemsWithinBudget (65536 byte budget)', () => {
  test('fills to the item limit when the byte budget allows', () => {
    const candidates = Array.from({ length: 5 }, (_, i) => node(`n${i}`));
    const selection = selectItemsWithinBudget(candidates, 5, context(), signer);
    assert.equal(selection.items.length, 5);
    assert.equal(selection.nextCursor, null);
    assert.ok(serializedBytes(selection.items, selection.nextCursor, context()) <= COLLECTION_CHILDREN_MAX_BYTES);
  });

  test('a hasMore probe (limit+1 rows) yields a nextCursor after the last selected item', () => {
    const candidates = Array.from({ length: 6 }, (_, i) => node(`n${i}`));
    const selection = selectItemsWithinBudget(candidates, 5, context(), signer);
    assert.equal(selection.items.length, 5);
    const cursor = cursorPayloadOf(selection.nextCursor, context());
    assert.ok(cursor !== null);
    assert.equal(cursor.after.nodeId, 'n4');
    assert.equal(cursor.limit, 50);
    assert.equal(cursor.sort, 'created_asc');
    assert.equal(cursor.contentRevision, 'coll-content-1');
    assert.equal(cursor.viewer, 'anon');
  });

  test('byte-limited short page keeps the nextCursor for the first unconsumed eligible item', () => {
    // Maximal write-capped items (description ~16384 bytes) still overflow the
    // 65536 byte budget before the 50-item limit, so the page must stop at a
    // byte boundary and hand over the first unconsumed item via nextCursor.
    const candidates = Array.from({ length: 6 }, (_, i) => node(`fat${i}`, {
      description: 'D'.repeat(16_000),
    }));
    const contextValue = context();
    const selection = selectItemsWithinBudget(candidates, 50, contextValue, signer);
    const pageBytes = serializedBytes(selection.items, selection.nextCursor, contextValue);
    assert.ok(pageBytes <= COLLECTION_CHILDREN_MAX_BYTES, `page ${pageBytes} bytes`);
    assert.ok(selection.items.length >= 1 && selection.items.length < candidates.length,
      'the byte budget must produce a short page');
    const cursor = cursorPayloadOf(selection.nextCursor, contextValue);
    assert.ok(cursor !== null, 'a byte-limited short page must return nextCursor');
    // The cursor points at the LAST SELECTED item; the first unconsumed
    // eligible item is the very next candidate.
    assert.equal(cursor.after.nodeId, selection.items[selection.items.length - 1]?.id);
    assert.deepEqual(selection.items.map((item) => item.id),
      candidates.slice(0, selection.items.length).map((item) => item.id),
      'items must be consumed strictly in order with none skipped');
    // The exact selection it made is a byte-limited SHORT page: the next
    // eligible item together with its own continuation cursor no longer fits —
    // this proves the page is byte-limited, never a truncation or a skip.
    const next = candidates[selection.items.length]!;
    const nextCursor = signer.sign({
      v: 1,
      purpose: 'product-collection-children-v1' as const,
      viewer: 'anon',
      collectionId: 'coll-fo05-0001',
      parentId: '',
      sort: 'created_asc' as const,
      limit: 50,
      contentRevision: 'coll-content-1',
      after: { nodeId: next.id, positionKey: next.position, createdAt: next.createdAt },
      issuedAt: contextValue.issuedAt,
      expiresAt: contextValue.expiresAt,
    });
    assert.ok(
      serializedBytes([...selection.items, next], nextCursor, contextValue) > COLLECTION_CHILDREN_MAX_BYTES,
      'the next eligible item with its cursor must exceed the byte budget',
    );
  });

  test('never cuts an item: a single over-budget item fails closed instead of dropping it', () => {
    const monster = node('monster', { description: 'M'.repeat(200_000) });
    assert.throws(
      () => selectItemsWithinBudget([monster], 1, context(), signer),
      /exceeds the response byte budget/,
    );
  });

  test('same-millisecond ties resume by ascending id through the cursor after', () => {
    // A(ts=T, id=a2) and B(ts=T, id=a9) tie on createdAt; the ascending-id
    // order is A then B. limit=1 must page A first and resume at id>a2.
    const ties = [
      node('a2', { createdAt: '2026-09-14T00:00:00.000Z' }),
      node('a9', { createdAt: '2026-09-14T00:00:00.000Z' }),
    ];
    const selection = selectItemsWithinBudget(ties, 1, context(), signer);
    assert.deepEqual(selection.items.map((item) => item.id), ['a2']);
    const cursor = cursorPayloadOf(selection.nextCursor, context());
    assert.ok(cursor !== null);
    assert.equal(cursor.after.nodeId, 'a2');
    assert.equal(cursor.after.createdAt, '2026-09-14T00:00:00.000Z');
  });

  test('limit is binding even when many small items would fit', () => {
    const candidates = Array.from({ length: 100 }, (_, i) => node(`tiny${i}`));
    const selection = selectItemsWithinBudget(candidates, 12, context(), signer);
    assert.equal(selection.items.length, 12);
    const cursor = cursorPayloadOf(selection.nextCursor, context());
    assert.ok(cursor !== null);
    assert.equal(cursor.after.nodeId, 'tiny11');
  });
});