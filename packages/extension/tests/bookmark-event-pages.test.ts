import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { findProcessedBookmarkEvent, findProcessedMoveEvent } from '../src/bookmark-event-pages.js';

type Row = { ordinal: number; opId: string | null; kind: string };

/** Operation index: one opId, ordinals strictly after `afterOrdinal`, oldest first. */
function operationIndex(rows: readonly Row[], pageSize: number) {
  const calls: Array<{ opId: string; afterOrdinal: number }> = [];
  const logStarts: number[] = [];
  const store = {
    async listBookmarkEvents(_scope: unknown, afterOrdinal = 0, limit = pageSize) {
      logStarts.push(afterOrdinal);
      return rows.filter((row) => row.ordinal > afterOrdinal).slice(0, limit);
    },
    async listBookmarkEventsByOperation(_scope: unknown, opId: string, afterOrdinal = 0, limit = pageSize) {
      calls.push({ opId, afterOrdinal });
      assert.equal(limit, pageSize);
      return rows.filter((row) => row.opId === opId && row.ordinal > afterOrdinal).slice(0, limit);
    },
  };
  return {
    calls,
    logStarts,
    read: (opId: string, afterOrdinal: number, limit: number) =>
      store.listBookmarkEventsByOperation('scope', opId, afterOrdinal, limit),
  };
}

describe('findProcessedMoveEvent pagination', () => {
  test('returns the earliest event of the requested kind for that op id', async () => {
    const helper = operationIndex([
      { ordinal: 1, opId: 'shared', kind: 'move' },
      { ordinal: 2, opId: 'shared', kind: 'create' },
      { ordinal: 3, opId: 'shared', kind: 'create' },
    ], 100);
    const found = await findProcessedBookmarkEvent(helper.read, 'shared', 'create', 100);
    assert.equal(found?.ordinal, 2);
    assert.deepEqual(helper.logStarts, []);
    assert.deepEqual(helper.calls, [{ opId: 'shared', afterOrdinal: 0 }]);
  });

  test('pages forward inside one op id until the matching kind', async () => {
    const rows = [
      ...Array.from({ length: 100 }, (_, index) => ({
        ordinal: index + 1, opId: 'move-1', kind: 'create',
      })),
      { ordinal: 101, opId: 'move-1', kind: 'move' },
    ];
    const helper = operationIndex(rows, 100);
    const found = await findProcessedMoveEvent(helper.read, 'move-1', 100, 8);
    assert.equal(found?.ordinal, 101);
    assert.deepEqual(helper.calls, [
      { opId: 'move-1', afterOrdinal: 0 },
      { opId: 'move-1', afterOrdinal: 100 },
    ]);
    assert.deepEqual(helper.logStarts, []);
  });

  test('returns null when that op id has no matching event', async () => {
    const helper = operationIndex([{ ordinal: 1, opId: 'other', kind: 'move' }], 100);
    assert.equal(await findProcessedMoveEvent(helper.read, 'missing', 100, 8), null);
    assert.deepEqual(helper.calls, [{ opId: 'missing', afterOrdinal: 0 }]);
    assert.deepEqual(helper.logStarts, []);
  });

  test('stops after the caller page budget inside that op id', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      ordinal: index + 1, opId: 'same', kind: 'create',
    }));
    const helper = operationIndex(rows, 100);
    assert.equal(await findProcessedMoveEvent(helper.read, 'same', 100, 3), null);
    assert.deepEqual(helper.calls, [
      { opId: 'same', afterOrdinal: 0 },
      { opId: 'same', afterOrdinal: 100 },
      { opId: 'same', afterOrdinal: 200 },
    ]);
    assert.deepEqual(helper.logStarts, []);
  });

  test('finds the target op id without reading the event log from ordinal 0', async () => {
    const rows = [
      ...Array.from({ length: 250 }, (_, index) => ({
        ordinal: index + 1, opId: `other-${index}`, kind: 'create',
      })),
      { ordinal: 251, opId: 'target', kind: 'create' },
      { ordinal: 252, opId: 'target', kind: 'move' },
      { ordinal: 400, opId: 'target', kind: 'move' },
    ];
    const helper = operationIndex(rows, 100);
    const found = await findProcessedMoveEvent(helper.read, 'target');
    assert.equal(found?.ordinal, 252);
    assert.deepEqual(helper.logStarts, []);
    assert.deepEqual(helper.calls, [{ opId: 'target', afterOrdinal: 0 }]);
  });

  test('keeps paging inside the op id past sixty-four pages', async () => {
    const rows = [
      ...Array.from({ length: 80 }, (_, index) => ({
        ordinal: index + 1, opId: `pad-${index}`, kind: 'create',
      })),
      ...Array.from({ length: 70 }, (_, index) => ({
        ordinal: 100 + index, opId: 'move-deep', kind: 'create',
      })),
      { ordinal: 170, opId: 'move-deep', kind: 'move' },
    ];
    const helper = operationIndex(rows, 1);
    const found = await findProcessedMoveEvent(helper.read, 'move-deep', 1);
    assert.equal(found?.ordinal, 170);
    assert.equal(helper.calls.length, 71);
    assert.ok(helper.calls.every((call) => call.opId === 'move-deep'));
    assert.deepEqual(helper.logStarts, []);
  });
});
