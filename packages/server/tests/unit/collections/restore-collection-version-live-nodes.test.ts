import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createRestoreLiveNodeLookup } from '../../../src/modules/collections/application/restore-collection-version-live-nodes.js';
import type { LockedNodeRow } from '../../../src/modules/collections/index.js';

const COL = 'col-live-nodes';
const ROOT = 'root-1';
const PARENT = 'folder-1';
const NODE = 'bm-1';
const SIBLING = 'bm-2';
const NOW = new Date('2026-08-24T08:00:00.000Z');

function locked(
  overrides: Partial<LockedNodeRow> & Pick<LockedNodeRow, 'id' | 'parentId' | 'kind'>,
): LockedNodeRow {
  return {
    collectionId: COL,
    isRoot: false,
    title: overrides.id,
    url: overrides.kind === 'bookmark' ? `https://example.test/${overrides.id}` : null,
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: 'a',
    resourceRevision: `res-${overrides.id}`,
    childrenRevision: `ch-${overrides.id}`,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

const LIVE_ROWS: readonly LockedNodeRow[] = [
  locked({ id: ROOT, parentId: null, kind: 'folder', isRoot: true }),
  locked({ id: PARENT, parentId: ROOT, kind: 'folder' }),
  locked({ id: NODE, parentId: PARENT, kind: 'bookmark' }),
  locked({ id: SIBLING, parentId: PARENT, kind: 'bookmark' }),
];

describe('createRestoreLiveNodeLookup', () => {
  test('with listLiveNodes, get does not call getNode until a sibling is invalidated', async () => {
    let getNodeCalls = 0;
    let listCalls = 0;
    const lookup = await createRestoreLiveNodeLookup({
      async getNode(_collectionId, nodeId) {
        getNodeCalls += 1;
        return LIVE_ROWS.find((row) => row.id === nodeId) ?? null;
      },
      async listLiveNodes() {
        listCalls += 1;
        return LIVE_ROWS;
      },
    }, COL);
    assert.equal(listCalls, 1);
    assert.equal((await lookup.get(COL, NODE))?.id, NODE);
    assert.equal((await lookup.get(COL, SIBLING))?.id, SIBLING);
    assert.equal((await lookup.get(COL, PARENT))?.id, PARENT);
    assert.equal(getNodeCalls, 0);
    lookup.invalidateTouched([NODE], [PARENT]);
    assert.equal((await lookup.get(COL, SIBLING))?.id, SIBLING);
    assert.equal(getNodeCalls, 1);
  });

  test('without listLiveNodes every get calls getNode', async () => {
    let getNodeCalls = 0;
    const lookup = await createRestoreLiveNodeLookup({
      async getNode(_collectionId, nodeId) {
        getNodeCalls += 1;
        return LIVE_ROWS.find((row) => row.id === nodeId) ?? null;
      },
    }, COL);
    await lookup.get(COL, NODE);
    await lookup.get(COL, NODE);
    assert.equal(getNodeCalls, 2);
  });
});
