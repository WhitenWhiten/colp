import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  SNAPSHOT_MATERIALIZATION_EXTENSION,
  snapshotProjectionContent,
  snapshotV02PagesFromStaging,
  toSnapshotV02Page,
} from '../src/snapshot-v02-consume.js';
import {
  SNAPSHOT_V02_SUPPORT,
  accumulateSnapshotV02Pages,
  createSnapshotV02Accumulator,
  snapshotV02PageWireBytes,
  type SnapshotV02Page,
} from '../src/snapshot-v02-pages.js';
import type { DurableSyncSnapshot } from '../src/durable-sync-engine-types.js';

function page(overrides: Partial<SnapshotV02Page> & Pick<SnapshotV02Page, 'pageSequence' | 'nodes' | 'parentRevisions'>): SnapshotV02Page {
  return {
    snapshotId: 'snap-1', revision: 'rev-1', collectionId: 'collection-a', syncCursor: 'cut-1',
    hasMore: false, nextCursor: null, materializationVersion: 'parent-first-v1',
    ...overrides,
  };
}

describe('C-04 complete Snapshot is one frozen tree', () => {
  test('accepts a valid paged tree beyond 10,000 nodes and 2 MiB of retained content', () => {
    const accumulator = createSnapshotV02Accumulator();
    const pages = [page({ pageSequence: 1, hasMore: true, nextCursor: 'page-2',
      parentRevisions: [{ parentId: 'root', childrenRevision: 'r-root' }],
      nodes: [{ id: 'root', kind: 'root', parentId: null }] })];
    assert.equal(accumulator.add(pages[0]!).ok, true);
    for (let batch = 0; batch < 40; batch++) {
      const last = batch === 39;
      const current = page({ pageSequence: batch + 2, hasMore: !last,
        nextCursor: last ? null : `page-${batch + 3}`, parentRevisions: [],
        nodes: Array.from({ length: 300 }, (_, index) => ({ id: `bookmark-${batch}-${index}`,
          parentId: 'root', kind: 'bookmark', content: { title: 'Bookmark', description: 'x'.repeat(300) } })) });
      pages.push(current);
      const result = accumulator.add(current);
      assert.equal(result.ok, true, `page ${batch + 2} must be accepted`);
      if (last && result.ok) { assert.equal(result.complete, true); assert.equal(result.graphChecked, true); }
    }
    assert.equal(accumulator.nodes, 12_001);
    assert.ok(accumulator.bytes > 2 * 1024 * 1024);
    const resumed = accumulateSnapshotV02Pages(snapshotV02PagesFromStaging({ collectionId: 'collection-a',
      header: { snapshotId: 'snap-1', revision: 'rev-1', syncCursor: 'cut-1', lastPage: 40,
        nextCursor: null, complete: true, materializationVersion: 'parent-first-v1' },
      nodes: pages.flatMap(page => page.nodes.map(node => ({ page: page.pageSequence - 1,
        colpId: node.id, parentId: node.parentId, kind: node.kind === 'root' ? 'Folder' as const : 'Bookmark' as const,
        mapping: { projection: { content: node.content,
          childrenRevision: page.parentRevisions.find(parent => parent.parentId === node.id)?.childrenRevision } } }))),
    }));
    assert.equal(resumed.ok, true);
    if (resumed.ok) { assert.equal(resumed.complete, true); assert.equal(resumed.graphChecked, true); }
  });
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

  test('freezes per-page Snapshot budgets and does not claim 0.1 assembleSnapshotPages', async () => {
    assert.equal(SNAPSHOT_V02_SUPPORT.commonBookmarkCount, 3_000);
    assert.equal(SNAPSHOT_V02_SUPPORT.maxPageNodes, 500);
    assert.equal(SNAPSHOT_V02_SUPPORT.maxPageBytes, 2 * 1024 * 1024);
    const source = await import('../src/snapshot-v02-pages.js');
    assert.equal('assembleSnapshotPages' in source, false);
  });

  test('enforces node and byte budgets without counting a duplicate page twice', () => {
    const accumulator = createSnapshotV02Accumulator();
    const root = page({
      pageSequence: 1, hasMore: true, nextCursor: 'p2',
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [{ id: 'root', parentId: null, kind: 'root' }],
    });
    assert.equal(accumulator.add(root).ok, true);
    const duplicate = accumulator.add(root);
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.code, 'page_mutation');
    assert.equal(accumulator.nodes, 1);
    assert.equal(accumulator.bytes, snapshotV02PageWireBytes(root));
    const tooMany = accumulateSnapshotV02Pages([page({
      pageSequence: 1,
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [
        { id: 'root', parentId: null, kind: 'root' },
        ...Array.from({ length: SNAPSHOT_V02_SUPPORT.maxPageNodes }, (_, index) => ({
          id: `bookmark-${index}`, parentId: 'root', kind: 'bookmark' as const,
        })),
      ],
    })]);
    assert.equal(tooMany.ok, false);
    if (!tooMany.ok) assert.equal(tooMany.code, 'budget_exceeded');
    const huge = accumulateSnapshotV02Pages([page({
      pageSequence: 1,
      parentRevisions: [{ parentId: 'x'.repeat(SNAPSHOT_V02_SUPPORT.maxPageBytes), childrenRevision: 'children' }],
      nodes: [{ id: 'x'.repeat(SNAPSHOT_V02_SUPPORT.maxPageBytes), parentId: null, kind: 'root' }],
    })]);
    assert.equal(huge.ok, false);
    if (!huge.ok) assert.equal(huge.code, 'budget_exceeded');

    const titled = page({
      pageSequence: 1,
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [{ id: 'root', parentId: null, kind: 'root', title: 'Hello' }],
    });
    const untitled = page({
      pageSequence: 1,
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [{ id: 'root', parentId: null, kind: 'root' }],
    });
    assert.ok(snapshotV02PageWireBytes(titled) > snapshotV02PageWireBytes(untitled));
    const linked = page({
      pageSequence: 1,
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [{ id: 'root', parentId: null, kind: 'root', url: 'https://example.test/item' }],
    });
    assert.ok(snapshotV02PageWireBytes(linked) > snapshotV02PageWireBytes(untitled));

    const hugeTitle = accumulateSnapshotV02Pages([page({
      pageSequence: 1,
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [{ id: 'root', parentId: null, kind: 'root', title: 't'.repeat(SNAPSHOT_V02_SUPPORT.maxPageBytes) }],
    })]);
    assert.equal(hugeTitle.ok, false);
    if (!hugeTitle.ok) assert.equal(hugeTitle.code, 'budget_exceeded');
    const hugeUrl = accumulateSnapshotV02Pages([page({
      pageSequence: 1,
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [{ id: 'root', parentId: null, kind: 'root', url: `https://example.test/${'u'.repeat(SNAPSHOT_V02_SUPPORT.maxPageBytes)}` }],
    })]);
    assert.equal(hugeUrl.ok, false);
    if (!hugeUrl.ok) assert.equal(hugeUrl.code, 'budget_exceeded');
    const hugeCursor = accumulateSnapshotV02Pages([page({
      pageSequence: 1, syncCursor: 'c'.repeat(SNAPSHOT_V02_SUPPORT.maxPageBytes),
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [{ id: 'root', parentId: null, kind: 'root' }],
    })]);
    assert.equal(hugeCursor.ok, false);
    if (!hugeCursor.ok) assert.equal(hugeCursor.code, 'budget_exceeded');

    const kept = createSnapshotV02Accumulator();
    assert.equal(kept.add(root).ok, true);
    const overflow = kept.add(page({
      pageSequence: 2,
      parentRevisions: [{ parentId: 'folder-a', childrenRevision: 'children-a' }],
      nodes: [{ id: 'folder-a', parentId: 'root', kind: 'folder', title: 't'.repeat(SNAPSHOT_V02_SUPPORT.maxPageBytes) }],
    }));
    assert.equal(overflow.ok, false);
    if (!overflow.ok) assert.equal(overflow.code, 'budget_exceeded');
    assert.equal(kept.nodes, 1);
    assert.equal(kept.bytes, snapshotV02PageWireBytes(root));
  });

  test('a rejected final graph leaves accepted pages and published parent revisions unchanged', () => {
    const accumulator = createSnapshotV02Accumulator();
    const root = page({
      pageSequence: 1, hasMore: true, nextCursor: 'p2',
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [{ id: 'root', parentId: null, kind: 'root' }],
    });
    const accepted = accumulator.add(root);
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    const rejected = accumulator.add(page({
      pageSequence: 2,
      parentRevisions: [{ parentId: 'folder-a', childrenRevision: 'children-a' }],
      nodes: [{ id: 'folder-a', parentId: 'folder-a', kind: 'folder' }],
    }));
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, 'graph_invalid');
    assert.equal(accumulator.nodes, 1);
    assert.equal(accumulator.bytes, snapshotV02PageWireBytes(root));
    assert.equal(accepted.parentRevisions.has('folder-a'), false);
    const repaired = accumulator.add(page({
      pageSequence: 2,
      parentRevisions: [{ parentId: 'folder-a', childrenRevision: 'children-a' }],
      nodes: [{ id: 'folder-a', parentId: 'root', kind: 'folder' }],
    }));
    assert.equal(repaired.ok, true);
    if (!repaired.ok) return;
    assert.equal(repaired.parentRevisions.get('folder-a'), 'children-a');
    assert.equal(accepted.parentRevisions.has('folder-a'), false);
    assert.equal(accumulator.nodes, 2);
  });

  test('live snapshot content and staged projection content share one byte budget', () => {
    const title = 't'.repeat(SNAPSHOT_V02_SUPPORT.maxPageBytes);
    const source = {
      id: 'root', collectionId: 'collection-a', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', revision: 'rev-node', kind: 'root' as const, parentId: null,
      position: null, folderRole: 'root' as const, title,
    };
    const live = toSnapshotV02Page({
      snapshotId: 'snap-1', revision: 'rev-1',
      collection: { id: 'collection-a', extensions: { [SNAPSHOT_MATERIALIZATION_EXTENSION]: { sortAlgorithm: 'parent-first-v1' } } },
      syncCursor: 'cut-1', page: { sequence: 1, hasMore: false, nextCursor: null },
      parentRevisions: [{ parentId: 'root', childrenRevision: 'children-root' }],
      nodes: [source],
    } as unknown as DurableSyncSnapshot);
    assert.equal(live.nodes[0]?.content?.title, title);
    const fromLive = accumulateSnapshotV02Pages([live]);
    assert.equal(fromLive.ok, false);
    if (!fromLive.ok) assert.equal(fromLive.code, 'budget_exceeded');

    const content = snapshotProjectionContent(source as DurableSyncSnapshot['nodes'][number]);
    const staged = snapshotV02PagesFromStaging({
      collectionId: 'collection-a',
      header: {
        snapshotId: 'snap-1', revision: 'rev-1', syncCursor: 'cut-1', lastPage: 0,
        nextCursor: null, complete: true, materializationVersion: 'parent-first-v1',
      },
      nodes: [{
        page: 0, colpId: 'root', parentId: null, kind: 'Folder', snapshotChildrenRevision: 'children-root',
        mapping: { projection: { childrenRevision: 'children-root', content } },
      }],
    });
    const fromStaging = accumulateSnapshotV02Pages(staged);
    assert.equal(fromStaging.ok, false);
    if (!fromStaging.ok) assert.equal(fromStaging.code, 'budget_exceeded');
    assert.equal(snapshotV02PageWireBytes(live), snapshotV02PageWireBytes(staged[0]!));
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
