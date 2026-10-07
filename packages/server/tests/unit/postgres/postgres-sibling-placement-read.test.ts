import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import {
  planBoundedPositionRebalance,
  type BoundedPositionSibling,
} from '../../../src/modules/collections/index.js';
import { isUnboundedLiveSiblingScan } from '../../../src/infrastructure/collections/postgres-sibling-placement-read.js';

describe('postgres sibling placement read helpers', () => {
  test('isUnboundedLiveSiblingScan distinguishes full scans from keyset probes', () => {
    assert.equal(
      isUnboundedLiveSiblingScan(
        'select id, position_token from nodes where parent_id = $1 and deleted_at is null order by position_token',
      ),
      true,
    );
    assert.equal(
      isUnboundedLiveSiblingScan(
        'select id, position_token from nodes where parent_id = $1 and (position_token collate "C", id) > ($2, $3) limit 1',
      ),
      false,
    );
  });

  test('neighborhood SQL is a dual LATERAL keyset probe', async () => {
    const source = await readFile(new URL(
      '../../../src/infrastructure/collections/postgres-sibling-placement-read.ts',
      import.meta.url,
    ), 'utf8');
    assert.equal([...source.matchAll(/left join lateral/giu)].length, 2);
    assert.match(source, /sibling\.parent_id = target\.parent_id/u);
    assert.doesNotMatch(source, /is not distinct from/iu);
    assert.match(source, /export async function readLiveSiblingNeighborhood/u);
    assert.match(source, /limit 1/iu);
  });
});

describe('planBoundedPositionRebalance explicit window bounds', () => {
  test('uses outside boundary tokens when the fetched window omits outer siblings', () => {
    const window: BoundedPositionSibling[] = [
      { id: 'left', positionToken: 'M' },
      { id: 'right', positionToken: 'N' },
    ];
    const plan = planBoundedPositionRebalance({
      siblings: window,
      targetId: 'target',
      insertIndex: 1,
      windowSize: 2,
      outsideLowerBoundToken: 'A',
      outsideUpperBoundToken: 'Z',
    });
    assert.equal(plan.windowStart, 0);
    assert.equal(plan.windowEnd, 2);
    const leftAssignment = plan.siblingAssignments.find((row) => row.resourceId === 'left');
    const rightAssignment = plan.siblingAssignments.find((row) => row.resourceId === 'right');
    assert.ok(leftAssignment);
    assert.ok(rightAssignment);
    assert.ok(leftAssignment.positionToken > 'A');
    assert.ok(rightAssignment.positionToken < 'Z');
    assert.ok(leftAssignment.positionToken < plan.targetPositionToken);
    assert.ok(plan.targetPositionToken < rightAssignment.positionToken);
    for (const assignment of plan.siblingAssignments) {
      assert.ok(assignment.positionToken > 'A');
      assert.ok(assignment.positionToken < 'Z');
    }  });
});
