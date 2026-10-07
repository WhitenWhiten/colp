import assert from 'node:assert/strict';
import { test } from 'vitest';
import { syncPullTupleIsBehindHistoryFloor } from '../../../src/infrastructure/sync/postgres/sync-pull-postgres.js';

const floor = { commitOrdinal: '10', streamKind: 'operation' as const, stableId: 'operation-10' };

test('Pull below the archived history floor requires recovery', () => {
  assert.equal(syncPullTupleIsBehindHistoryFloor(
    { commitOrdinal: '9', streamKind: 'conflict', stableId: 'conflict-9' }, floor,
  ), true);
});

test('Pull at the history floor continues from hot/archive payload readers', () => {
  assert.equal(syncPullTupleIsBehindHistoryFloor({ ...floor }, floor), false);
  assert.equal(syncPullTupleIsBehindHistoryFloor(
    { commitOrdinal: '11', streamKind: 'operation', stableId: 'operation-11' }, floor,
  ), false);
});
