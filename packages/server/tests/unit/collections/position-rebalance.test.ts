import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  allocatePosition,
  CollectionsError,
  PositionRebalanceEscalationError,
  planBoundedPositionRebalance,
  type BoundedPositionSibling,
} from '../../../src/modules/collections/index.js';
import {
  DEFAULT_POSITION_REBALANCE_WINDOW,
  MAX_POSITION_REBALANCE_WINDOW,
  resolvePositionRebalanceWindow,
} from '../../../src/infrastructure/collections/canonical-mutation-postgres-ports.js';

function applyPlan(
  siblings: readonly BoundedPositionSibling[],
  targetId: string,
  insertIndex: number,
  windowSize: number,
): BoundedPositionSibling[] {
  const plan = planBoundedPositionRebalance({ siblings, targetId, insertIndex, windowSize });
  const assigned = new Map(plan.siblingAssignments.map((row) => [row.resourceId, row.positionToken]));
  const next = siblings.map((row) => ({ ...row, positionToken: assigned.get(row.id) ?? row.positionToken }));
  next.splice(insertIndex, 0, { id: targetId, positionToken: plan.targetPositionToken });
  return next;
}

function assertStrictOrder(siblings: readonly BoundedPositionSibling[]): void {
  assert.equal(new Set(siblings.map((row) => row.positionToken)).size, siblings.length);
  for (let index = 1; index < siblings.length; index += 1) {
    assert.ok(siblings[index - 1]!.positionToken < siblings[index]!.positionToken);
  }
}

function insertWithProductionFallback(
  siblings: readonly BoundedPositionSibling[],
  targetId: string,
  insertIndex: number,
  windowSize: number,
): BoundedPositionSibling[] {
  const beforeToken = siblings[insertIndex - 1]?.positionToken ?? null;
  const afterToken = siblings[insertIndex]?.positionToken ?? null;
  try {
    const positionToken = allocatePosition(
      beforeToken,
      afterToken,
      siblings.map((row) => row.positionToken),
    );
    const next = [...siblings];
    next.splice(insertIndex, 0, { id: targetId, positionToken });
    return next;
  } catch (error: unknown) {
    if (!(error instanceof CollectionsError) || error.code !== 'invalid_node_anchor') throw error;
    return applyPlan(siblings, targetId, insertIndex, windowSize);
  }
}

describe('bounded position rebalance', () => {
  test('all allocated positions are valid COLP order keys', () => {
    const positions = [
      allocatePosition(null, null),
      allocatePosition('A', 'M', ['A', 'M']),
      allocatePosition('M', null, ['M']),
      ...planBoundedPositionRebalance({
        siblings: [{ id: 'a', positionToken: 'A' }, { id: 'b', positionToken: 'M' }],
        targetId: 'target', insertIndex: 1, windowSize: 2,
      }).siblingAssignments.map((entry) => entry.positionToken),
    ];
    for (const position of positions) {
      assert.match(position, /^[0-9A-Za-z_-]{1,128}$/u);
    }
  });
  test('configuration defaults, rejects invalid values and clamps the hard ceiling', () => {
    assert.equal(resolvePositionRebalanceWindow(undefined), DEFAULT_POSITION_REBALANCE_WINDOW);
    assert.equal(resolvePositionRebalanceWindow('0'), DEFAULT_POSITION_REBALANCE_WINDOW);
    assert.equal(resolvePositionRebalanceWindow('not-a-number'), DEFAULT_POSITION_REBALANCE_WINDOW);
    assert.equal(resolvePositionRebalanceWindow('8'), 8);
    assert.equal(resolvePositionRebalanceWindow('10000'), MAX_POSITION_REBALANCE_WINDOW);
  });

  test.each([
    { label: 'head', insertIndex: 0 },
    { label: 'middle', insertIndex: 5 },
    { label: 'tail', insertIndex: 10 },
  ])('allocates a deterministic $label window without touching outside siblings', ({ insertIndex }) => {
    const siblings = Array.from({ length: 10 }, (_, index) => ({
      id: `sibling-${index}`,
      positionToken: String((index + 1) * 100).padStart(4, '0'),
    }));
    const first = planBoundedPositionRebalance({ siblings, targetId: 'target', insertIndex, windowSize: 4 });
    const second = planBoundedPositionRebalance({ siblings, targetId: 'target', insertIndex, windowSize: 4 });
    assert.deepEqual(second, first);
    assert.ok(first.siblingAssignments.length <= 4);
    const changed = new Set(first.siblingAssignments.map((row) => row.resourceId));
    for (let index = 0; index < siblings.length; index += 1) {
      assert.equal(changed.has(siblings[index]!.id), index >= first.windowStart && index < first.windowEnd);
    }
    assertStrictOrder(applyPlan(siblings, 'target', insertIndex, 4));
  });

  test('repeated adversarial inserts retain strict total order within the rewrite budget', () => {
    let siblings: BoundedPositionSibling[] = [
      { id: 'left', positionToken: 'A' },
      { id: 'right', positionToken: 'z' },
    ];
    for (let index = 0; index < 64; index += 1) {
      siblings = insertWithProductionFallback(siblings, `insert-${index}`, 1, 4);
      assertStrictOrder(siblings);
    }
  });

  test('raises an explicit escalation instead of exceeding the configured window', () => {
    const siblings = [
      { id: 'lower', positionToken: '0' },
      { id: 'inside', positionToken: '0-' },
      { id: 'upper', positionToken: '0--' },
    ];
    assert.throws(
      () => planBoundedPositionRebalance({ siblings, targetId: 'target', insertIndex: 1, windowSize: 1 }),
      (error: unknown) => error instanceof PositionRebalanceEscalationError
        && error.code === 'position_context_stale'
        && error.windowSize === 1,
    );
  });

  test('preserves COLP order-key dictionary order for adversarial bounds', () => {
    const siblings = [
      { id: 's0', positionToken: '-' },
      { id: 's1', positionToken: `-${'z'.repeat(127)}` },
      { id: 's2', positionToken: '0' },
      { id: 's3', positionToken: '1' },
    ];
    const next = insertWithProductionFallback(siblings, 'target', 2, 2);
    assertStrictOrder(next);
    assert.equal(next[2]!.id, 'target');
  });
});

describe('position rebalance negative branches (T9)', () => {
  const siblings = [
    { id: 'a', positionToken: 'A' },
    { id: 'b', positionToken: 'M' },
    { id: 'c', positionToken: 'Z' },
  ];

  function assertCollectionsError(
    run: () => unknown,
    code: 'invalid_node_input' | 'invalid_node_anchor',
    message: RegExp,
  ): void {
    assert.throws(run, (error: unknown) => {
      if (!(error instanceof CollectionsError)) return false;
      if (error.code !== code) return false;
      return message.test(error.message);
    });
  }

  test.each([
    ['windowSize zero', 0],
    ['windowSize negative', -1],
  ] as const)('rejects %s', (_label, windowSize) => {
    assertCollectionsError(
      () => planBoundedPositionRebalance({
        siblings, targetId: 'target', insertIndex: 1, windowSize,
      }),
      'invalid_node_input',
      /positive integer/i,
    );
  });

  test.each([
    ['insertIndex -1', -1],
    ['insertIndex length+1', siblings.length + 1],
  ] as const)('rejects %s', (_label, insertIndex) => {
    assertCollectionsError(
      () => planBoundedPositionRebalance({
        siblings, targetId: 'target', insertIndex, windowSize: 2,
      }),
      'invalid_node_anchor',
      /insertion index is outside the sibling set/i,
    );
  });

  test('rejects duplicate sibling tokens', () => {
    assertCollectionsError(
      () => planBoundedPositionRebalance({
        siblings: [
          { id: 'a', positionToken: 'A' },
          { id: 'b', positionToken: 'A' },
        ],
        targetId: 'target',
        insertIndex: 1,
        windowSize: 2,
      }),
      'invalid_node_anchor',
      /strictly increasing/i,
    );
  });

  test('rejects decreasing sibling tokens', () => {
    assertCollectionsError(
      () => planBoundedPositionRebalance({
        siblings: [
          { id: 'a', positionToken: 'Z' },
          { id: 'b', positionToken: 'A' },
        ],
        targetId: 'target',
        insertIndex: 1,
        windowSize: 2,
      }),
      'invalid_node_anchor',
      /strictly increasing/i,
    );
  });

  test('rejects illegal sibling token characters', () => {
    assertCollectionsError(
      () => planBoundedPositionRebalance({
        siblings: [{ id: 'a', positionToken: 'bad token' }],
        targetId: 'target',
        insertIndex: 0,
        windowSize: 1,
      }),
      'invalid_node_input',
      /COLP order key/i,
    );
  });

  test('allocatePosition rejects before>=after bounds', () => {
    assertCollectionsError(
      () => allocatePosition('M', 'A', ['A', 'M']),
      'invalid_node_anchor',
      /strictly less than upper bound/i,
    );
  });
});
