import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  SNAPSHOT_V02_SUPPORT,
  accumulateSnapshotV02Pages,
  type SnapshotV02Page,
} from '../src/snapshot-v02-pages.js';

function page(overrides: Partial<SnapshotV02Page> & Pick<SnapshotV02Page, 'pageSequence' | 'nodes' | 'parentRevisions'>): SnapshotV02Page {
  return {
    snapshotId: 'snap-1', revision: 'rev-1', collectionId: 'collection-a', syncCursor: 'cut-1',
    hasMore: false, nextCursor: null, materializationVersion: 'parent-first-v1',
    ...overrides,
  };
}

describe('C-04 complete Snapshot is one frozen tree', () => {
  test('merges parentRevisions by parentId and rejects a per-parent conflict, not array inequality', () => {
    const first = page({
      pageSequence: 1, hasMore: true, nextCursor: 'p2',
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [{ id: 'root', parentId: null, kind: 'root' }],
    });
    const second = page({
      pageSequence: 2,
      parentRevisions: [{ parentId: 'folder-a', childrenRevision: 'children-a' }],
      nodes: [{ id: 'folder-a', parentId: 'root', kind: 'folder' }, { id: 'bm-1', parentId: 'folder-a', kind: 'bookmark' }],
    });
    const merged = accumulateSnapshotV02Pages([first, second]);
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    assert.equal(merged.complete, true);
    assert.equal(merged.parentRevisions.get('root'), 'children-root');
    assert.equal(merged.parentRevisions.get('folder-a'), 'children-a');

    const conflict = accumulateSnapshotV02Pages([first, page({
      pageSequence: 2,
      parentRevisions: [
        { parentId: 'root', childrenRevision: 'other-root' },
        { parentId: 'folder-a', childrenRevision: 'children-a' },
      ],
      nodes: [{ id: 'folder-a', parentId: 'root', kind: 'folder' }],
    })]);
    assert.equal(conflict.ok, false);
    if (conflict.ok) return;
    assert.equal(conflict.code, 'parent_revision_conflict');
  });

  test('rejects identity drift, missing childrenRevision, and in-flight page mutation', () => {
    const first = page({
      pageSequence: 1, hasMore: true, nextCursor: 'p2',
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [{ id: 'root', parentId: null, kind: 'root' }],
    });
    const identity = accumulateSnapshotV02Pages([first, page({
      pageSequence: 2, snapshotId: 'snap-other',
      parentRevisions: [{ parentId: 'folder-a', childrenRevision: 'children-a' }],
      nodes: [{ id: 'folder-a', parentId: 'root', kind: 'folder' }],
    })]);
    assert.equal(identity.ok, false);
    if (!identity.ok) assert.equal(identity.code, 'identity_conflict');

    const missing = accumulateSnapshotV02Pages([page({
      pageSequence: 1, parentRevisions: [],
      nodes: [{ id: 'root', parentId: null, kind: 'root' }],
    })]);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'missing_children_revision');

    const mutated = accumulateSnapshotV02Pages([first, first]);
    assert.equal(mutated.ok, false);
    if (!mutated.ok) assert.equal(mutated.code, 'page_mutation');
  });

  test('runs ring/orphan/uniqueness only on the complete frozen tree', () => {
    const prefix = accumulateSnapshotV02Pages([page({
      pageSequence: 1, hasMore: true, nextCursor: 'p2',
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [{ id: 'root', parentId: null, kind: 'root' }],
    })]);
    assert.equal(prefix.ok, true);
    if (prefix.ok) {
      assert.equal(prefix.complete, false);
      assert.equal(prefix.graphChecked, false);
    }

    const cycle = accumulateSnapshotV02Pages([page({
      pageSequence: 1,
      parentRevisions: [
        { parentId: 'root', childrenRevision: 'children-root' },
        { parentId: 'folder-a', childrenRevision: 'children-a' },
      ],
      nodes: [
        { id: 'root', parentId: null, kind: 'root' },
        { id: 'folder-a', parentId: 'folder-a', kind: 'folder' },
      ],
    })]);
    assert.equal(cycle.ok, false);
    if (!cycle.ok) assert.equal(cycle.code, 'graph_invalid');
  });

  test('freezes the supported Snapshot capacity and does not claim 0.1 assembleSnapshotPages', async () => {
    assert.equal(SNAPSHOT_V02_SUPPORT.commonBookmarkCount, 3_000);
    assert.equal(SNAPSHOT_V02_SUPPORT.maxNodes, 10_000);
    assert.equal(SNAPSHOT_V02_SUPPORT.maxAggregateBytes, 2 * 1024 * 1024);
    const source = await import('../src/snapshot-v02-pages.js');
    assert.equal('assembleSnapshotPages' in source, false);
  });

  test('S-01 incremental parent-prefix rejects a folder that appears after its children', () => {
    const dangling = accumulateSnapshotV02Pages([page({
      pageSequence: 1, hasMore: true, nextCursor: 'p2',
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [
        { id: 'root', parentId: null, kind: 'root' },
        { id: 'child', parentId: 'aaa-folder', kind: 'bookmark' },
      ],
    })]);
    assert.equal(dangling.ok, false);
    if (!dangling.ok) assert.equal(dangling.code, 'graph_invalid');
  });
});
