import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  NodeConflictError,
  resolvePlacement,
  type PlacementSibling,
} from '../../../src/modules/collections/index.js';

function siblings(...rows: readonly PlacementSibling[]): readonly PlacementSibling[] {
  return rows;
}

describe('resolvePlacement (shared production pure function)', () => {
  test('empty sibling list appends with null bounds', () => {
    const result = resolvePlacement([], undefined, undefined);
    assert.deepEqual(result, {
      beforeToken: null,
      afterToken: null,
      insertIndex: 0,
    });
  });

  test('single sibling append uses that token as lower bound', () => {
    const list = siblings({ id: 'a', positionToken: 'a0' });
    const result = resolvePlacement(list, undefined, undefined);
    assert.deepEqual(result, {
      beforeToken: 'a0',
      afterToken: null,
      insertIndex: 1,
    });
  });

  test('before-first uses null lower bound (not last sibling token)', () => {
    const list = siblings(
      { id: 'first', positionToken: 'a0' },
      { id: 'middle', positionToken: 'a1' },
      { id: 'last', positionToken: 'a2' },
    );
    const result = resolvePlacement(list, undefined, 'first');
    assert.deepEqual(result, {
      beforeToken: null,
      afterToken: 'a0',
      insertIndex: 0,
    });
  });

  test('after-last uses anchor token as lower bound and null upper bound', () => {
    const list = siblings(
      { id: 'first', positionToken: 'a0' },
      { id: 'last', positionToken: 'a1' },
    );
    const result = resolvePlacement(list, 'last', undefined);
    assert.deepEqual(result, {
      beforeToken: 'a1',
      afterToken: null,
      insertIndex: 2,
    });
  });

  test('adjacent dual anchors bracket the gap between neighbors', () => {
    const list = siblings(
      { id: 'a', positionToken: 'a0' },
      { id: 'b', positionToken: 'a1' },
      { id: 'c', positionToken: 'a2' },
    );
    const result = resolvePlacement(list, 'a', 'b');
    assert.deepEqual(result, {
      beforeToken: 'a0',
      afterToken: 'a1',
      insertIndex: 1,
    });
  });

  test('after-only inserts immediately after the anchor', () => {
    const list = siblings(
      { id: 'a', positionToken: 'a0' },
      { id: 'b', positionToken: 'a1' },
    );
    const result = resolvePlacement(list, 'a', undefined);
    assert.deepEqual(result, {
      beforeToken: 'a0',
      afterToken: 'a1',
      insertIndex: 1,
    });
  });

  test('rejects reversed dual anchors (before before after in list order)', () => {
    const list = siblings(
      { id: 'a', positionToken: 'a0' },
      { id: 'b', positionToken: 'a1' },
    );
    assert.throws(
      () => resolvePlacement(list, 'b', 'a'),
      (error: unknown) => error instanceof NodeConflictError && error.code === 'position_context_stale',
    );
  });

  test('rejects non-adjacent dual anchors', () => {
    const list = siblings(
      { id: 'a', positionToken: 'a0' },
      { id: 'b', positionToken: 'a1' },
      { id: 'c', positionToken: 'a2' },
    );
    assert.throws(
      () => resolvePlacement(list, 'a', 'c'),
      (error: unknown) => error instanceof NodeConflictError && error.code === 'position_context_stale',
    );
  });

  test('rejects same anchor for after and before', () => {
    const list = siblings({ id: 'a', positionToken: 'a0' });
    assert.throws(
      () => resolvePlacement(list, 'a', 'a'),
      (error: unknown) => error instanceof NodeConflictError && error.code === 'position_context_stale',
    );
  });

  test('rejects unknown afterId', () => {
    const list = siblings({ id: 'a', positionToken: 'a0' });
    assert.throws(
      () => resolvePlacement(list, 'missing', undefined),
      (error: unknown) => error instanceof NodeConflictError && error.code === 'position_context_stale',
    );
  });

  test('rejects unknown beforeId', () => {
    const list = siblings({ id: 'a', positionToken: 'a0' });
    assert.throws(
      () => resolvePlacement(list, undefined, 'missing'),
      (error: unknown) => error instanceof NodeConflictError && error.code === 'position_context_stale',
    );
  });
});
