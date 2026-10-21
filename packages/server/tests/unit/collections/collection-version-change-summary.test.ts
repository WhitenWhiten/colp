import assert from 'node:assert/strict';
import { test } from 'vitest';
import { COLLECTION_VERSION_LIST_COLUMNS } from '../../../src/infrastructure/collections/collection-tree-version-postgres.js';
import {
  buildCollectionTreeChangeSummary,
  countCollectionTreeChangesFromSummary,
  countCollectionTreeChangesWithIndex,
  indexLiveCollectionTree,
  type CollectionTreeLiveMember,
  type CollectionTreeSnapshotNode,
} from '../../../src/modules/collections/application/capture-collection-tree-version.js';

test('version list columns do not read tree_json', () => {
  const columns: readonly string[] = COLLECTION_VERSION_LIST_COLUMNS;
  assert.equal(columns.includes('tree_json'), false);
  assert.equal(columns.includes('change_summary_json'), true);
});

test('change summaries preserve the comparison fields and match full-tree counts', () => {
  const snapshot: CollectionTreeSnapshotNode[] = [
    {
      id: 'folder-1',
      kind: 'folder',
      parentId: 'root-x',
      title: '文件夹',
      url: null,
      childIds: ['bm-b', 'bm-a', 'bm-b'],
    },
    { id: 'bm-a', kind: 'bookmark', parentId: 'folder-1', title: '甲', url: 'https://example.test/书签' },
    { id: 'bm-b', kind: 'bookmark', parentId: 'folder-1', title: '乙', url: 'https://example.test/b' },
    { id: 'bm-omitted', kind: 'bookmark', parentId: 'folder-1', title: '丙', url: null },
    { id: 'loose-b', kind: 'bookmark', parentId: 'missing', title: 'B', url: 'https://example.test/loose-b' },
    { id: 'loose-a', kind: 'bookmark', parentId: 'missing', title: 'A', url: 'https://example.test/loose-a' },
  ];
  const live: CollectionTreeLiveMember[] = [
    { id: 'folder-1', kind: 'folder', parentId: 'root-x', title: '文件夹', url: null, positionToken: 'a' },
    { id: 'bm-a', kind: 'bookmark', parentId: 'folder-1', title: '甲', url: 'https://example.test/书签', positionToken: 'a' },
    { id: 'bm-b', kind: 'bookmark', parentId: 'folder-1', title: '乙', url: 'https://example.test/b', positionToken: 'b' },
    { id: 'bm-omitted', kind: 'bookmark', parentId: 'folder-1', title: '丙', url: null, positionToken: 'c' },
    { id: 'loose-a', kind: 'bookmark', parentId: 'missing', title: 'A', url: 'https://example.test/loose-a', positionToken: 'a' },
    { id: 'loose-b', kind: 'bookmark', parentId: 'missing', title: 'B', url: 'https://example.test/loose-b', positionToken: 'b' },
    { id: 'fresh', kind: 'bookmark', parentId: 'folder-1', title: '新', url: 'https://example.test/new', positionToken: 'd' },
  ];
  const summary = buildCollectionTreeChangeSummary(snapshot);
  assert.deepEqual(summary.map((node) => [node.id, node.siblingIndex]), [
    ['folder-1', 0],
    ['bm-a', 1],
    ['bm-b', 0],
    ['bm-omitted', -1],
    ['loose-b', 0],
    ['loose-a', 1],
  ]);
  assert.equal(summary.find((node) => node.id === 'bm-a')?.url, 'https://example.test/书签');
  assert.equal(summary.find((node) => node.id === 'folder-1')?.title, '文件夹');
  assertEquivalent(snapshot, live);

  assertEquivalent([
    { id: 'keep', kind: 'bookmark', parentId: 'root', title: 'Old', url: 'https://old.example' },
    { id: 'gone', kind: 'bookmark', parentId: 'root', title: 'Gone', url: 'https://gone.example' },
  ], [
    { id: 'keep', kind: 'bookmark', parentId: 'root', title: 'New', url: 'https://new.example', positionToken: 'a' },
    { id: 'fresh', kind: 'bookmark', parentId: 'root', title: 'Fresh', url: 'https://fresh.example', positionToken: 'b' },
  ]);
  const renamed = indexLiveCollectionTree([
    { id: 'keep', kind: 'bookmark', parentId: 'root', title: 'New', url: 'https://new.example', positionToken: 'a' },
    { id: 'fresh', kind: 'bookmark', parentId: 'root', title: 'Fresh', url: 'https://fresh.example', positionToken: 'b' },
  ]);
  assert.deepEqual(countCollectionTreeChangesFromSummary(buildCollectionTreeChangeSummary([
    { id: 'keep', kind: 'bookmark', parentId: 'root', title: 'Old', url: 'https://old.example' },
    { id: 'gone', kind: 'bookmark', parentId: 'root', title: 'Gone', url: 'https://gone.example' },
  ]), renamed), {
    added: 1,
    removed: 1,
    moved: 0,
    renamed: 1,
    retargeted: 1,
  });

  assertEquivalent([], [
    { id: 'only', kind: 'folder', parentId: 'root', title: 'Only', url: null, positionToken: 'a' },
  ]);
});

function assertEquivalent(
  snapshot: readonly CollectionTreeSnapshotNode[],
  live: readonly CollectionTreeLiveMember[],
): void {
  const index = indexLiveCollectionTree(live);
  const summary = buildCollectionTreeChangeSummary(snapshot);
  const roundTrip = JSON.parse(JSON.stringify(summary)) as typeof summary;
  const full = countCollectionTreeChangesWithIndex(snapshot, index);
  assert.deepEqual(countCollectionTreeChangesFromSummary(summary, index), full);
  assert.deepEqual(countCollectionTreeChangesFromSummary(roundTrip, index), full);
}
