import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  SNAPSHOT_MATERIALIZATION_SORT_VERSION,
  compareCollateC,
  orderSnapshotNodesParentFirst,
  snapshotMaterializationIdentity,
  type SnapshotSortKey,
} from '../../../src/modules/sync/sync-snapshot-parent-first.js';
import { SNAPSHOT_MATERIALIZATION_SORT_VERSION as extensionSortVersion } from '../../../../Known-Extension/src/snapshot-v02-pages.js';

function node(input: SnapshotSortKey): SnapshotSortKey {
  return input;
}

test('S-01 parent-first order is independent of opaque id dictionary order', () => {
  const root = node({ id: 'zzz-root', parentId: null, isRoot: true, kind: 'folder', positionToken: null });
  const folder = node({ id: 'aaa-folder', parentId: 'zzz-root', isRoot: false, kind: 'folder', positionToken: 'A' });
  const children = Array.from({ length: 101 }, (_, index) => node({
    id: `child-${index.toString().padStart(3, '0')}`, parentId: 'aaa-folder', isRoot: false,
    kind: 'bookmark', positionToken: `P${index.toString().padStart(5, '0')}`,
  }));
  const shuffled = [children[40]!, folder, children[0]!, root, ...children.slice(1, 40), ...children.slice(41)];
  const ordered = orderSnapshotNodesParentFirst(shuffled, (item) => item);
  assert.equal(ordered.ok, true);
  if (!ordered.ok) return;
  assert.equal(ordered.ordered[0]?.id, 'zzz-root');
  assert.equal(ordered.ordered[1]?.id, 'aaa-folder');
  assert.deepEqual(ordered.ordered.slice(2).map((item) => item.id), children.map((item) => item.id));
  const indexById = new Map(ordered.ordered.map((item, index) => [item.id, index]));
  for (const item of ordered.ordered) {
    if (item.parentId === null) continue;
    assert.ok(indexById.get(item.parentId)! < indexById.get(item.id)!);
  }
});

test('S-02 sibling position then id wins over folder id that sorts before the root', () => {
  const root = node({ id: 'root-z', parentId: null, isRoot: true, kind: 'folder', positionToken: null });
  const later = node({ id: 'aaa-later', parentId: 'root-z', isRoot: false, kind: 'folder', positionToken: 'B' });
  const earlier = node({ id: 'zzz-earlier', parentId: 'root-z', isRoot: false, kind: 'folder', positionToken: 'A' });
  const ordered = orderSnapshotNodesParentFirst([later, earlier, root], (item) => item);
  assert.equal(ordered.ok, true);
  if (!ordered.ok) return;
  assert.deepEqual(ordered.ordered.map((item) => item.id), ['root-z', 'zzz-earlier', 'aaa-later']);
});

test('S-02 rejects cycles, missing parents, and a bookmark used as a parent', () => {
  const root = node({ id: 'root', parentId: null, isRoot: true, kind: 'folder', positionToken: null });
  const bookmark = node({ id: 'bm', parentId: 'root', isRoot: false, kind: 'bookmark', positionToken: 'A' });
  const nested = node({ id: 'nested', parentId: 'bm', isRoot: false, kind: 'bookmark', positionToken: 'A' });
  assert.equal(orderSnapshotNodesParentFirst([root, bookmark, nested], (item) => item).ok, false);
  const cycle = node({ id: 'folder', parentId: 'folder', isRoot: false, kind: 'folder', positionToken: 'A' });
  assert.equal(orderSnapshotNodesParentFirst([root, cycle], (item) => item).ok, false);
});

test('Collate C matches PostgreSQL byte order for multibyte position tokens', () => {
  assert.ok(compareCollateC('A', 'B') < 0);
  assert.ok(compareCollateC('é', 'f') > 0);
});

test('materialization identity includes the sort-algorithm version and matches the extension constant', () => {
  assert.equal(SNAPSHOT_MATERIALIZATION_SORT_VERSION, 'parent-first-v1');
  assert.equal(SNAPSHOT_MATERIALIZATION_SORT_VERSION, extensionSortVersion);
  const withVersion = snapshotMaterializationIdentity({
    protocolVersion: '0.2', sessionId: 's', replicaId: 'r', leaseGeneration: 1,
    contentRevision: 'c', policyRevision: 'p', rootNodeId: 'root',
  });
  const without = createHash('sha256').update(JSON.stringify(
    ['sync-snapshot-v02', 's', 'r', '1', 'c', 'p', 'root'],
  )).digest('base64url').slice(0, 32);
  assert.notEqual(withVersion, without);
});
