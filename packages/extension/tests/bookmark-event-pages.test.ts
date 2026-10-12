import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { findProcessedBookmarkEvent, findProcessedMoveEvent } from '../src/bookmark-event-pages.js';

function pages(rows: Array<{ ordinal: number; opId: string | null; kind: string }>, pageSize: number) {
  const calls: number[] = [];
  return {
    calls,
    read: async (afterOrdinal: number, limit: number) => {
      calls.push(afterOrdinal);
      assert.equal(limit, pageSize);
      return rows.filter((row) => row.ordinal > afterOrdinal).slice(0, limit);
    },
  };
}

describe('findProcessedMoveEvent pagination', () => {
  test('finds create history without confusing a move with the same op id', async () => {
    const helper = pages([
      { ordinal: 1, opId: 'shared', kind: 'move' },
      { ordinal: 2, opId: 'shared', kind: 'create' },
    ], 100);
    const found = await findProcessedBookmarkEvent(helper.read, 'shared', 'create', 100);
    assert.equal(found?.ordinal, 2);
  });

  test('finds the move on the second page', async () => {
    const rows = [
      ...Array.from({ length: 100 }, (_, index) => ({
        ordinal: index + 1, opId: `other-${index}`, kind: 'create',
      })),
      { ordinal: 101, opId: 'move-1', kind: 'move' },
    ];
    const helper = pages(rows, 100);
    const found = await findProcessedMoveEvent(helper.read, 'move-1', 100, 8);
    assert.equal(found?.ordinal, 101);
    assert.deepEqual(helper.calls, [0, 100]);
  });

  test('stops at a short tail page when the target is missing', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      ordinal: index + 1, opId: `row-${index}`, kind: 'create',
    }));
    const helper = pages(rows, 100);
    assert.equal(await findProcessedMoveEvent(helper.read, 'missing', 100, 8), null);
    assert.deepEqual(helper.calls, [0]);
  });

  test('bounds requests when the caller supplies a page budget', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      ordinal: index + 1, opId: `row-${index}`, kind: 'create',
    }));
    const helper = pages(rows, 100);
    assert.equal(await findProcessedMoveEvent(helper.read, 'never', 100, 3), null);
    assert.equal(helper.calls.length, 3);
    assert.deepEqual(helper.calls, [0, 100, 200]);
  });

  test('keeps scanning past sixty-four pages until the short tail', async () => {
    const rows = [
      ...Array.from({ length: 70 }, (_, index) => ({
        ordinal: index + 1, opId: `pad-${index}`, kind: 'create',
      })),
      { ordinal: 71, opId: 'move-deep', kind: 'move' },
    ];
    const helper = pages(rows, 1);
    const found = await findProcessedMoveEvent(helper.read, 'move-deep', 1);
    assert.equal(found?.ordinal, 71);
    assert.equal(helper.calls.length, 71);
  });
});
