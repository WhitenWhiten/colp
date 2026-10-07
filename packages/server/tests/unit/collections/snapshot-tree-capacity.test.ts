import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  SNAPSHOT_TREE_CAPACITY,
  SnapshotTreeCapacityError,
  admitSnapshotTreeGrowth,
  estimateSnapshotNodeBytes,
} from '../../../src/modules/collections/domain/snapshot-tree-capacity.js';
import { SNAPSHOT_V02_SUPPORT } from '../../../../Known-Extension/src/snapshot-v02-pages.js';

test('S-04 typed Snapshot tree capacity matches the T-01 frozen support surface', () => {
  assert.equal(SNAPSHOT_TREE_CAPACITY.maxNodes, 10_000);
  assert.equal(SNAPSHOT_TREE_CAPACITY.maxAggregateBytes, 2 * 1024 * 1024);
  assert.equal(SNAPSHOT_TREE_CAPACITY.maxNodes, SNAPSHOT_V02_SUPPORT.maxNodes);
  assert.equal(SNAPSHOT_TREE_CAPACITY.maxAggregateBytes, SNAPSHOT_V02_SUPPORT.maxAggregateBytes);
});

test('S-04 admission refuses before a 10_001st node or aggregate-byte overflow', () => {
  admitSnapshotTreeGrowth({
    liveNodeCount: 10_000, extraNodes: 0, liveEstimatedBytes: 100, extraBytes: 10,
  });
  assert.throws(() => admitSnapshotTreeGrowth({
    liveNodeCount: 10_000, extraNodes: 1, liveEstimatedBytes: 100, extraBytes: 10,
  }), (error: unknown) => error instanceof SnapshotTreeCapacityError && error.code === 'payload_too_large');
  assert.throws(() => admitSnapshotTreeGrowth({
    liveNodeCount: 3_000, extraNodes: 1,
    liveEstimatedBytes: SNAPSHOT_TREE_CAPACITY.maxAggregateBytes, extraBytes: 1,
  }), SnapshotTreeCapacityError);
});

test('S-04 long Unicode titles count as UTF-8 bytes', () => {
  const ascii = estimateSnapshotNodeBytes({
    id: 'n', title: 'a', url: 'https://example.test/', description: null, tags: [],
  });
  const unicode = estimateSnapshotNodeBytes({
    id: 'n', title: '书签', url: 'https://example.test/书签', description: null, tags: [],
  });
  assert.ok(unicode > ascii);
});
