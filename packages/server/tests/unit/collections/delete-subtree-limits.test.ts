import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { resolveDeleteSubtreeLimits } from '../../../src/infrastructure/collections/canonical-mutation-postgres-ports.js';

describe('recursive delete planner limits', () => {
  test('uses finite defaults when configuration is absent or invalid', () => {
    assert.deepEqual(resolveDeleteSubtreeLimits({}), { nodes: 10_000, depth: 256 });
    assert.deepEqual(resolveDeleteSubtreeLimits({
      KNOW_N_MAX_DELETE_SUBTREE_NODES: '0',
      KNOW_N_MAX_DELETE_SUBTREE_DEPTH: 'not-a-number',
    }), { nodes: 10_000, depth: 256 });
  });

  test('accepts positive integer boundaries and clamps excessive values', () => {
    assert.deepEqual(resolveDeleteSubtreeLimits({
      KNOW_N_MAX_DELETE_SUBTREE_NODES: '8',
      KNOW_N_MAX_DELETE_SUBTREE_DEPTH: '3',
    }), { nodes: 8, depth: 3 });
    assert.deepEqual(resolveDeleteSubtreeLimits({
      KNOW_N_MAX_DELETE_SUBTREE_NODES: '100001',
      KNOW_N_MAX_DELETE_SUBTREE_DEPTH: '1025',
    }), { nodes: 100_000, depth: 1_024 });
  });
});
