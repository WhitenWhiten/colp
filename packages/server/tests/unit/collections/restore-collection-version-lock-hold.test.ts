import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import {
  buildCollectionTreeJson,
  restoreCollectionVersion,
  type RestoreCollectionVersionPorts,
} from '../../../src/modules/collections/index.js';
import * as moveNodeModule from '../../../src/modules/collections/application/move-collection-node.js';
import { createState } from '../../support/move-collection-node-memory.js';
import {
  BM_A,
  BM_B,
  COL,
  FOLDER,
  input,
  liveMembers,
  portsFor,
  seedBaseTree,
  versionOf,
} from '../../support/restore-collection-version-harness.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function withSiblingListCounter(
  ports: RestoreCollectionVersionPorts,
  parentId: string,
): { ports: RestoreCollectionVersionPorts; lists: { count: number } } {
  const list = ports.mutations.nodes.listLiveSiblingPositions.bind(ports.mutations.nodes);
  const lists = { count: 0 };
  return {
    lists,
    ports: {
      ...ports,
      mutations: {
        ...ports.mutations,
        nodes: {
          ...ports.mutations.nodes,
          async listLiveSiblingPositions(collectionId, pid) {
            if (pid === parentId) lists.count += 1;
            return list(collectionId, pid);
          },
        },
      },
    },
  };
}

describe('restoreCollectionVersion lock-hold queries', () => {
  test('same-folder order mismatch lists siblings once plus once per moveOnce', async () => {
    const state = createState();
    seedBaseTree(state);
    const snapshot = versionOf(buildCollectionTreeJson(liveMembers(state)));
    state.nodes.get(BM_A)!.positionToken = 'z';
    state.nodes.get(BM_B)!.positionToken = 'a';
    const wrapped = withSiblingListCounter(portsFor(state, [snapshot]), FOLDER);
    const moveSpy = vi.spyOn(moveNodeModule, 'moveCollectionNode');
    const result = await restoreCollectionVersion(wrapped.ports, input());
    assert.equal(result.kind, 'succeeded');
    const folderMoves = moveSpy.mock.calls.filter((call) => call[1]?.newParentId === FOLDER).length;
    assert.ok(folderMoves >= 1);
    assert.equal(wrapped.lists.count, 1 + folderMoves);
    const siblings = await wrapped.ports.mutations.nodes.listLiveSiblingPositions(COL, FOLDER);
    assert.deepEqual(siblings.map((row) => row.id), [BM_A, BM_B]);
  });

  test('already-ordered folder lists siblings once when restore still mutates', async () => {
    const state = createState();
    seedBaseTree(state);
    const snapshot = versionOf(buildCollectionTreeJson(liveMembers(state)));
    state.nodes.get(BM_A)!.title = 'Renamed';
    const wrapped = withSiblingListCounter(portsFor(state, [snapshot]), FOLDER);
    const result = await restoreCollectionVersion(wrapped.ports, input());
    assert.equal(result.kind, 'succeeded');
    if (result.kind !== 'succeeded') return;
    assert.equal(result.receipt.noop, false);
    assert.equal(wrapped.lists.count, 1);
  });

  test('title-only restore prefetches listLiveNodes once and restores the title', async () => {
    const state = createState();
    seedBaseTree(state);
    const snapshot = versionOf(buildCollectionTreeJson(liveMembers(state)));
    state.nodes.get(BM_A)!.title = 'Renamed';
    const ports = portsFor(state, [snapshot]);
    const listLive = ports.mutations.nodes.listLiveNodes;
    assert.ok(listLive);
    let listCalls = 0;
    const result = await restoreCollectionVersion({
      ...ports,
      mutations: {
        ...ports.mutations,
        nodes: {
          ...ports.mutations.nodes,
          async listLiveNodes(collectionId) {
            listCalls += 1;
            return listLive(collectionId);
          },
        },
      },
    }, input());
    assert.equal(result.kind, 'succeeded');
    if (result.kind !== 'succeeded') return;
    assert.equal(result.receipt.noop, false);
    assert.equal(result.receipt.updatedNodeIds.includes(BM_A), true);
    assert.equal(state.nodes.get(BM_A)?.title, 'Alpha');
    assert.equal(listCalls, 1);
  });
});
