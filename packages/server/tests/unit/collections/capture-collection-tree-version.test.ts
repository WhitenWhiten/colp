import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COLLECTION_TREE_VERSION_FIFO_LIMIT,
  COLLECTION_TREE_VERSION_MAX_NODES,
  buildCollectionTreeJson,
  captureCollectionTreeVersion,
  CollectionVersionNodeLimitError,
  compareEditorSiblingOrder,
  countCollectionTreeChangesWithIndex,
  defaultCollectionVersionLabel,
  diffCollectionTree,
  diffCollectionTreeWithIndex,
  indexLiveCollectionTree,
  type CollectionTreeLiveMember,
  type CollectionVersionRecord,
  type CollectionVersionStorePort,
} from '../../../src/modules/collections/application/capture-collection-tree-version.js';

const COL = 'col-1';
const ROOT = 'root-1';
const OWNER = 'owner-1';
const ACCOUNT = 'account-1';
const NOW = new Date('2026-08-24T08:00:00.000Z');

function member(
  id: string,
  overrides: Partial<CollectionTreeLiveMember> = {},
): CollectionTreeLiveMember {
  return {
    id,
    kind: 'bookmark',
    parentId: ROOT,
    title: id,
    url: `https://example.test/${id}`,
    positionToken: id,
    ...overrides,
  };
}

function memoryStore(seed: {
  readonly members?: CollectionTreeLiveMember[];
  readonly rows?: CollectionVersionRecord[];
}): CollectionVersionStorePort & { rows: CollectionVersionRecord[] } {
  const rows = [...(seed.rows ?? [])];
  return {
    rows,
    async lockOwnedLive() {
      return {
        collectionId: COL,
        ownerSubjectId: OWNER,
        contentRevision: 'rev-1',
        rootNodeId: ROOT,
      };
    },
    async getOwnedLive() {
      return {
        collectionId: COL,
        ownerSubjectId: OWNER,
        contentRevision: 'rev-1',
        rootNodeId: ROOT,
      };
    },
    async loadLiveMembers() {
      return seed.members ?? [];
    },
    async getByCollectionAndRevision(_accountId, collectionId, contentRevision) {
      return rows.find((row) =>
        row.collectionId === collectionId && row.contentRevision === contentRevision) ?? null;
    },
    async getById(_accountId, collectionId, versionId) {
      return rows.find((row) => row.collectionId === collectionId && row.versionId === versionId) ?? null;
    },
    async list() {
      return rows;
    },
    async insert(row) {
      rows.push(row);
    },
    async count() {
      return rows.length;
    },
    async deleteOldest(_accountId, _collectionId, excludeVersionId) {
      const eligible = rows
        .filter((row) => row.versionId !== excludeVersionId)
        .sort((left, right) => {
          const time = left.createdAt.getTime() - right.createdAt.getTime();
          return time !== 0 ? time : left.versionId < right.versionId ? -1 : 1;
        });
      const oldest = eligible[0];
      if (!oldest) return;
      const index = rows.findIndex((row) => row.versionId === oldest.versionId);
      if (index >= 0) rows.splice(index, 1);
    },
    async findLatestManualCreatedAt() {
      return null;
    },
  };
}

test('childIds follow editor positionToken then id, not loadLiveTree array order', () => {
  const folder = member('folder-1', {
    kind: 'folder', parentId: ROOT, title: 'Inbox', url: null, positionToken: 'm',
  });
  const late = member('bm-z', { parentId: 'folder-1', title: 'Z', positionToken: 'z' });
  const early = member('bm-a', { parentId: 'folder-1', title: 'A', positionToken: 'a' });
  const mid = member('bm-m', { parentId: 'folder-1', title: 'M', positionToken: 'm' });
  const loadLiveTreeOrder = [folder, late, mid, early];
  const tree = buildCollectionTreeJson(loadLiveTreeOrder);
  const captured = tree.find((node) => node.id === 'folder-1');
  assert.deepEqual(captured?.childIds, ['bm-a', 'bm-m', 'bm-z']);
  assert.notDeepEqual(captured?.childIds, ['bm-z', 'bm-m', 'bm-a']);
  assert.deepEqual(tree.map((node) => node.id), ['bm-a', 'bm-m', 'bm-z', 'folder-1']);
  assert.notDeepEqual(tree.map((node) => node.id), ['folder-1', 'bm-z', 'bm-m', 'bm-a']);
  assert.equal(compareEditorSiblingOrder(early, late) < 0, true);
});

test('empty tree is a legal snapshot with nodeCount 0', async () => {
  const versions = memoryStore({ members: [] });
  const result = await captureCollectionTreeVersion({
    versions,
    clock: { now: () => NOW },
    ids: { nextVersionId: () => 'ver-empty' },
  }, {
    accountId: ACCOUNT,
    collection: {
      collectionId: COL, ownerSubjectId: OWNER, contentRevision: 'rev-1', rootNodeId: ROOT,
    },
    kind: 'manual',
  });
  assert.equal(result.kind, 'inserted');
  assert.equal(result.record.nodeCount, 0);
  assert.deepEqual(result.record.treeJson, []);
  assert.equal(result.record.label, defaultCollectionVersionLabel(NOW));
  assert.equal(result.record.label, 'Snapshot 2026-08-24T08:00:00Z');
});

test('more than 2000 live members rejects create capture', async () => {
  const members = Array.from({ length: COLLECTION_TREE_VERSION_MAX_NODES + 1 }, (_, index) =>
    member(`bm-${String(index).padStart(4, '0')}`, { positionToken: `p${index}` }));
  assert.throws(() => buildCollectionTreeJson(members), CollectionVersionNodeLimitError);
  const versions = memoryStore({ members });
  await assert.rejects(
    () => captureCollectionTreeVersion({
      versions,
      clock: { now: () => NOW },
      ids: { nextVersionId: () => 'ver-overflow' },
    }, {
      accountId: ACCOUNT,
      collection: {
        collectionId: COL, ownerSubjectId: OWNER, contentRevision: 'rev-1', rootNodeId: ROOT,
      },
      kind: 'manual',
    }),
    CollectionVersionNodeLimitError,
  );
  assert.equal(versions.rows.length, 0);
});

test('diffCollectionTree does not throw when live members exceed 2000', () => {
  const snapshot = buildCollectionTreeJson([
    member('bm-0000', { positionToken: 'p0000' }),
    member('bm-0001', { positionToken: 'p0001' }),
  ]);
  const live = Array.from({ length: COLLECTION_TREE_VERSION_MAX_NODES + 1 }, (_, index) =>
    member(`bm-${String(index).padStart(4, '0')}`, {
      positionToken: `p${String(index).padStart(4, '0')}`,
    }));
  const { changeCounts } = diffCollectionTree(snapshot, live);
  assert.equal(changeCounts.added, COLLECTION_TREE_VERSION_MAX_NODES - 1);
  assert.equal(changeCounts.removed, 0);
  assert.equal(changeCounts.moved, 0);
});

test('same content revision returns the existing row without inserting', async () => {
  const existing: CollectionVersionRecord = {
    versionId: 'ver-1',
    accountId: ACCOUNT,
    collectionId: COL,
    contentRevision: 'rev-1',
    kind: 'manual',
    label: 'Kept',
    etag: '"ver-1"',
    nodeCount: 0,
    treeJson: [],
    createdAt: NOW,
  };
  const versions = memoryStore({ rows: [existing], members: [member('bm-new')] });
  const result = await captureCollectionTreeVersion({
    versions,
    clock: { now: () => new Date('2026-08-24T09:00:00.000Z') },
    ids: { nextVersionId: () => 'ver-2' },
  }, {
    accountId: ACCOUNT,
    collection: {
      collectionId: COL, ownerSubjectId: OWNER, contentRevision: 'rev-1', rootNodeId: ROOT,
    },
    kind: 'manual',
    label: 'Ignored',
  });
  assert.equal(result.kind, 'existing');
  assert.equal(result.record.versionId, 'ver-1');
  assert.equal(versions.rows.length, 1);
});

test('FIFO 50 deletes the oldest row before inserting the 51st', async () => {
  const rows: CollectionVersionRecord[] = Array.from(
    { length: COLLECTION_TREE_VERSION_FIFO_LIMIT },
    (_, index) => ({
      versionId: `ver-${String(index).padStart(2, '0')}`,
      accountId: ACCOUNT,
      collectionId: COL,
      contentRevision: `rev-${index}`,
      kind: index === 0 ? 'pre_mutation' : 'manual',
      label: `v${index}`,
      etag: `"ver-${index}"`,
      nodeCount: 0,
      treeJson: [],
      createdAt: new Date(NOW.getTime() + index * 1000),
    }),
  );
  const versions = memoryStore({ rows, members: [] });
  const result = await captureCollectionTreeVersion({
    versions,
    clock: { now: () => new Date(NOW.getTime() + 60_000) },
    ids: { nextVersionId: () => 'ver-51' },
  }, {
    accountId: ACCOUNT,
    collection: {
      collectionId: COL, ownerSubjectId: OWNER, contentRevision: 'rev-new', rootNodeId: ROOT,
    },
    kind: 'manual',
  });
  assert.equal(result.kind, 'inserted');
  assert.equal(versions.rows.length, 50);
  assert.equal(versions.rows.some((row) => row.versionId === 'ver-00'), false);
  assert.equal(versions.rows.some((row) => row.versionId === 'ver-51'), true);
});

test('FIFO while restoring excludes the target versionId', async () => {
  const rows: CollectionVersionRecord[] = Array.from(
    { length: COLLECTION_TREE_VERSION_FIFO_LIMIT },
    (_, index) => ({
      versionId: `keep-${String(index).padStart(2, '0')}`,
      accountId: ACCOUNT,
      collectionId: COL,
      contentRevision: `rev-${index}`,
      kind: 'manual',
      label: `v${index}`,
      etag: `"keep-${index}"`,
      nodeCount: 0,
      treeJson: [],
      createdAt: new Date(NOW.getTime() + index * 1000),
    }),
  );
  const versions = memoryStore({ rows, members: [] });
  await captureCollectionTreeVersion({
    versions,
    clock: { now: () => new Date(NOW.getTime() + 60_000) },
    ids: { nextVersionId: () => 'pre-restore' },
  }, {
    accountId: ACCOUNT,
    collection: {
      collectionId: COL, ownerSubjectId: OWNER, contentRevision: 'rev-now', rootNodeId: ROOT,
    },
    kind: 'pre_restore',
    restoringVersionId: 'keep-00',
  });
  assert.equal(versions.rows.some((row) => row.versionId === 'keep-00'), true);
  assert.equal(versions.rows.some((row) => row.versionId === 'keep-01'), false);
  assert.equal(versions.rows.some((row) => row.versionId === 'pre-restore'), true);
});

test('diff reports added removed moved renamed retargeted versus live', () => {
  const snapshot = buildCollectionTreeJson([
    member('folder-1', { kind: 'folder', url: null, positionToken: 'a' }),
    member('bm-keep', { parentId: 'folder-1', title: 'Keep', positionToken: 'a' }),
    member('bm-move', { parentId: 'folder-1', title: 'Move', positionToken: 'm' }),
    member('bm-gone', { parentId: 'folder-1', title: 'Gone', positionToken: 'z' }),
    member('bm-rename', { parentId: ROOT, title: 'Old', positionToken: 'b' }),
    member('bm-url', { parentId: ROOT, title: 'Url', url: 'https://old.example', positionToken: 'c' }),
  ]);
  const live = [
    member('folder-1', { kind: 'folder', url: null, positionToken: 'a' }),
    member('bm-keep', { parentId: 'folder-1', title: 'Keep', positionToken: 'a' }),
    member('bm-move', { parentId: ROOT, title: 'Move', positionToken: 'm' }),
    member('bm-rename', { parentId: ROOT, title: 'New', positionToken: 'b' }),
    member('bm-url', { parentId: ROOT, title: 'Url', url: 'https://new.example', positionToken: 'c' }),
    member('bm-new', { parentId: ROOT, title: 'Added', positionToken: 'z' }),
  ];
  const { changeCounts, changes } = diffCollectionTree(snapshot, live);
  assert.deepEqual(changeCounts, {
    added: 1, removed: 1, moved: 1, renamed: 1, retargeted: 1,
  });
  assert.equal(changes.some((change) => change.type === 'removed' && change.nodeId === 'bm-gone'), true);
  assert.equal(changes.some((change) => change.type === 'added' && change.nodeId === 'bm-new'), true);
});

test('diff reports moved when two root-direct bookmarks swap sibling order', () => {
  const snapshot = buildCollectionTreeJson([
    member('bm-a', { positionToken: 'a' }),
    member('bm-b', { positionToken: 'b' }),
  ]);
  const live = [
    member('bm-a', { positionToken: 'b' }),
    member('bm-b', { positionToken: 'a' }),
  ];
  const { changeCounts, changes } = diffCollectionTree(snapshot, live);
  assert.deepEqual(changeCounts, {
    added: 0, removed: 0, moved: 2, renamed: 0, retargeted: 0,
  });
  const moved = changes.filter((change) => change.type === 'moved');
  assert.deepEqual(moved.map((change) => change.nodeId).sort(), ['bm-a', 'bm-b']);
});

test('diff reports moved when two same-folder bookmarks swap sibling order', () => {
  const folder = member('folder-1', { kind: 'folder', url: null, positionToken: 'a' });
  const snapshot = buildCollectionTreeJson([
    folder,
    member('bm-a', { parentId: 'folder-1', positionToken: 'a' }),
    member('bm-b', { parentId: 'folder-1', positionToken: 'b' }),
  ]);
  const live = [
    folder,
    member('bm-a', { parentId: 'folder-1', positionToken: 'b' }),
    member('bm-b', { parentId: 'folder-1', positionToken: 'a' }),
  ];
  const { changeCounts, changes } = diffCollectionTree(snapshot, live);
  assert.deepEqual(changeCounts, {
    added: 0, removed: 0, moved: 2, renamed: 0, retargeted: 0,
  });
  const moved = changes.filter((change) => change.type === 'moved');
  assert.deepEqual(moved.map((change) => change.nodeId).sort(), ['bm-a', 'bm-b']);
});

function assertIndexedDiffMatches(
  snapshot: ReturnType<typeof buildCollectionTreeJson>,
  live: CollectionTreeLiveMember[],
): void {
  const direct = diffCollectionTree(snapshot, live);
  const indexed = diffCollectionTreeWithIndex(snapshot, indexLiveCollectionTree(live));
  assert.deepEqual(indexed.changeCounts, direct.changeCounts);
  assert.deepEqual(indexed.changes, direct.changes);
}

test('diffCollectionTreeWithIndex matches diffCollectionTree for mixed edits, root-order swap, and >2000 live', () => {
  const mixedSnapshot = buildCollectionTreeJson([
    member('folder-1', { kind: 'folder', url: null, positionToken: 'a' }),
    member('bm-keep', { parentId: 'folder-1', title: 'Keep', positionToken: 'a' }),
    member('bm-move', { parentId: 'folder-1', title: 'Move', positionToken: 'm' }),
    member('bm-gone', { parentId: 'folder-1', title: 'Gone', positionToken: 'z' }),
    member('bm-rename', { parentId: ROOT, title: 'Old', positionToken: 'b' }),
    member('bm-url', { parentId: ROOT, title: 'Url', url: 'https://old.example', positionToken: 'c' }),
  ]);
  const mixedLive = [
    member('folder-1', { kind: 'folder', url: null, positionToken: 'a' }),
    member('bm-keep', { parentId: 'folder-1', title: 'Keep', positionToken: 'a' }),
    member('bm-move', { parentId: ROOT, title: 'Move', positionToken: 'm' }),
    member('bm-rename', { parentId: ROOT, title: 'New', positionToken: 'b' }),
    member('bm-url', { parentId: ROOT, title: 'Url', url: 'https://new.example', positionToken: 'c' }),
    member('bm-new', { parentId: ROOT, title: 'Added', positionToken: 'z' }),
  ];
  assertIndexedDiffMatches(mixedSnapshot, mixedLive);

  const rootSnapshot = buildCollectionTreeJson([
    member('bm-a', { positionToken: 'a' }),
    member('bm-b', { positionToken: 'b' }),
  ]);
  const rootLive = [
    member('bm-a', { positionToken: 'b' }),
    member('bm-b', { positionToken: 'a' }),
  ];
  assertIndexedDiffMatches(rootSnapshot, rootLive);

  const overflowSnapshot = buildCollectionTreeJson([
    member('bm-0000', { positionToken: 'p0000' }),
    member('bm-0001', { positionToken: 'p0001' }),
  ]);
  const overflowLive = Array.from({ length: COLLECTION_TREE_VERSION_MAX_NODES + 1 }, (_, index) =>
    member(`bm-${String(index).padStart(4, '0')}`, {
      positionToken: `p${String(index).padStart(4, '0')}`,
    }));
  assertIndexedDiffMatches(overflowSnapshot, overflowLive);
});

test('max-size root diff visits snapshot rows linearly', () => {
  const live = Array.from({ length: COLLECTION_TREE_VERSION_MAX_NODES }, (_, index) =>
    member(`bm-${String(index).padStart(4, '0')}`, {
      positionToken: `p${String(index).padStart(4, '0')}`,
    }));
  const snapshot = buildCollectionTreeJson(live);
  let indexedReads = 0;
  const tracked = new Proxy(snapshot, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/u.test(property)) indexedReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  assert.deepEqual(countCollectionTreeChangesWithIndex(tracked, indexLiveCollectionTree(live)), {
    added: 0, removed: 0, moved: 0, renamed: 0, retargeted: 0,
  });
  assert.ok(indexedReads < snapshot.length * 8,
    `expected linear snapshot access, observed ${indexedReads} indexed reads for ${snapshot.length} nodes`);
});
