import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test, vi } from 'vitest';
import {
  COLLECTION_TREE_VERSION_FIFO_LIMIT,
  COLLECTION_TREE_VERSION_MAX_NODES,
  CollectionVersionRestoreReceiptConflictError,
  NodeConflictError,
  RestoreCollectionVersionInnerCommandError,
  buildCollectionTreeJson,
  restoreCollectionVersion,
  strongEntityTag,
  type CollectionVersionRecord,
} from '../../../src/modules/collections/index.js';
import { collectionTreeJsonFromLiveMembers } from '../../../src/modules/collections/application/capture-collection-tree-version.js';
import * as createNodeModule from '../../../src/modules/collections/application/create-collection-node.js';
import * as updateNodeModule from '../../../src/modules/collections/application/update-collection-node.js';
import * as moveNodeModule from '../../../src/modules/collections/application/move-collection-node.js';
import * as deleteNodeModule from '../../../src/modules/collections/application/delete-collection-node.js';
import {
  createState,
  seedCollection,
  seedNode,
  type MutableNode,
} from '../../support/move-collection-node-memory.js';
import {
  ACCOUNT,
  BM_A,
  BM_B,
  COL,
  EXTRA,
  FOLDER,
  NOW,
  REV,
  ROOT,
  SEPARATOR,
  VERSION,
  input,
  liveMembers,
  portsFor,
  seedBaseTree,
  versionOf,
} from '../../support/restore-collection-version-harness.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('restoreCollectionVersion', () => {
  test('calls update/move/delete in-process and never createCollectionNode', async () => {
    const createSpy = vi.spyOn(createNodeModule, 'createCollectionNode');
    const updateSpy = vi.spyOn(updateNodeModule, 'updateCollectionNode');
    const moveSpy = vi.spyOn(moveNodeModule, 'moveCollectionNode');
    const deleteSpy = vi.spyOn(deleteNodeModule, 'deleteCollectionNode');
    const state = createState();
    seedBaseTree(state);
    const snapshot = versionOf(buildCollectionTreeJson(liveMembers(state)));
    state.nodes.get(BM_A)!.title = 'Renamed';
    state.nodes.get(BM_A)!.parentId = ROOT;
    state.nodes.get(BM_A)!.description = 'Keep desc';
    state.nodes.get(BM_A)!.tags = ['keep'];
    state.nodes.get(BM_A)!.visibility = 'private';
    seedNode(state, {
      id: EXTRA, parentId: ROOT, kind: 'folder', title: 'Extra', positionToken: 'z', collectionId: COL,
    });
    const ports = portsFor(state, [snapshot]);
    const command = input();
    const result = await restoreCollectionVersion(ports, command);
    assert.ok(ports.store.lockOwnedLiveCalls >= 1);
    assert.equal(ports.store.getOwnedLiveCalls, 0);
    assert.equal(result.kind, 'succeeded');
    if (result.kind !== 'succeeded') return;
    assert.equal(result.receipt.noop, false);
    assert.equal(result.receipt.updatedNodeIds.includes(BM_A), true);
    assert.equal(result.receipt.movedNodeIds.includes(BM_A), true);
    assert.equal(result.receipt.deletedNodeIds.includes(EXTRA), true);
    const stored = await ports.restoreReceipts.getByCommandId(ACCOUNT, command.commandId);
    assert.ok(stored);
    assert.equal(stored.commandId, command.commandId);
    assert.equal(stored.versionId, VERSION);
    assert.equal(stored.collectionId, COL);
    assert.equal(stored.accountId, ACCOUNT);
    assert.ok(stored.innerCommands.updateCommandIds.length >= 1);
    assert.ok(stored.innerCommands.moveCommandIds.length >= 1);
    assert.ok(stored.innerCommands.deleteCommandIds.length >= 1);
    assert.equal(stored.result.noop, false);
    assert.equal(stored.result.updatedNodeIds.includes(BM_A), true);
    assert.equal(stored.result.movedNodeIds.includes(BM_A), true);
    assert.equal(stored.result.deletedNodeIds.includes(EXTRA), true);
    assert.equal(state.nodes.get(BM_A)?.parentId, FOLDER);
    assert.equal(state.nodes.get(BM_A)?.title, 'Alpha');
    assert.equal(state.nodes.get(BM_A)?.description, 'Keep desc');
    assert.deepEqual(state.nodes.get(BM_A)?.tags, ['keep']);
    assert.equal(state.nodes.get(BM_A)?.visibility, 'private');
    assert.equal(createSpy.mock.calls.length, 0);
    assert.ok(updateSpy.mock.calls.length >= 1);
    assert.ok(moveSpy.mock.calls.length >= 1);
    assert.ok(deleteSpy.mock.calls.length >= 1);
  });

  test('missing snapshot node is 409 revision_conflict with no pre_restore and unchanged tree', async () => {
    const deleteSpy = vi.spyOn(deleteNodeModule, 'deleteCollectionNode');
    const state = createState();
    seedBaseTree(state);
    const snapshot = versionOf(buildCollectionTreeJson(liveMembers(state)));
    state.nodes.delete(BM_B);
    const ports = portsFor(state, [snapshot]);
    await assert.rejects(
      () => restoreCollectionVersion(ports, input()),
      (error: unknown) => error instanceof NodeConflictError && error.code === 'revision_conflict',
    );
    assert.equal(ports.store.rows.length, 1);
    assert.equal(ports.store.rows.some((row) => row.kind === 'pre_restore'), false);
    assert.equal(state.nodes.get(BM_A)?.parentId, FOLDER);
    assert.equal(deleteSpy.mock.calls.length, 0);
  });

  test('equivalent live tree is 200 noop and still follows the pre_restore rule', async () => {
    const state = createState();
    seedBaseTree(state);
    const snapshot = versionOf(buildCollectionTreeJson(liveMembers(state)));
    const alreadyCaptured = portsFor(state, [snapshot]);
    const noop = await restoreCollectionVersion(alreadyCaptured, input());
    assert.equal(noop.kind, 'succeeded');
    if (noop.kind !== 'succeeded') return;
    assert.equal(noop.receipt.noop, true);
    assert.deepEqual(noop.receipt.updatedNodeIds, []);
    assert.deepEqual(noop.receipt.movedNodeIds, []);
    assert.deepEqual(noop.receipt.deletedNodeIds, []);
    assert.equal(noop.receipt.preRestoreVersionId, null);
    state.collections.get(COL)!.contentRevision = 'rev-after-desc';
    const needsPre = portsFor(state, [snapshot]);
    const written = await restoreCollectionVersion(needsPre, {
      ...input(),
      ifMatch: strongEntityTag('rev-after-desc'),
    });
    assert.equal(written.kind, 'succeeded');
    if (written.kind !== 'succeeded') return;
    assert.equal(written.receipt.noop, true);
    assert.ok(written.receipt.preRestoreVersionId);
    assert.equal(needsPre.store.rows.some((row) => row.kind === 'pre_restore'), true);
  });

  test('more than 2000 live members skips pre_restore and still restores an equivalent snapshot', async () => {
    const state = createState();
    seedCollection(state, { collectionId: COL, rootId: ROOT, contentRevision: REV });
    for (let index = 0; index < COLLECTION_TREE_VERSION_MAX_NODES + 1; index += 1) {
      const id = `bm-${String(index).padStart(4, '0')}`;
      seedNode(state, {
        id,
        parentId: ROOT,
        kind: 'bookmark',
        title: id,
        url: `https://example.test/${id}`,
        positionToken: String(index).padStart(4, '0'),
        collectionId: COL,
      });
    }
    const snapshot = versionOf(collectionTreeJsonFromLiveMembers(liveMembers(state)), {
      contentRevision: 'rev-old',
    });
    const ports = portsFor(state, [snapshot]);
    const result = await restoreCollectionVersion(ports, input());
    assert.equal(result.kind, 'succeeded');
    if (result.kind !== 'succeeded') return;
    assert.equal(result.receipt.noop, true);
    assert.equal(result.receipt.preRestoreVersionId, null);
    assert.equal(ports.store.rows.length, 1);
    assert.equal(ports.store.rows[0]?.kind, 'manual');
    assert.equal(ports.store.rows.some((row) => row.kind === 'pre_restore'), false);
  });

  test('separator is retained and omitted from deletedNodeIds', async () => {
    const deleteSpy = vi.spyOn(deleteNodeModule, 'deleteCollectionNode');
    const state = createState();
    seedBaseTree(state);
    const snapshot = versionOf(buildCollectionTreeJson(liveMembers(state)));
    seedNode(state, {
      id: EXTRA, parentId: ROOT, kind: 'folder', title: 'Gone', positionToken: 'z', collectionId: COL,
    });
    const createdAt = new Date(state.now);
    state.nodes.set(SEPARATOR, {
      id: SEPARATOR,
      collectionId: COL,
      parentId: ROOT,
      kind: 'separator' as MutableNode['kind'],
      isRoot: false,
      title: '---',
      url: null,
      description: null,
      tags: [],
      visibility: 'inherit',
      positionToken: 's',
      resourceRevision: 'sep-res',
      childrenRevision: 'sep-ch',
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    });
    const ports = portsFor(state, [snapshot]);
    const result = await restoreCollectionVersion(ports, input());
    assert.equal(result.kind, 'succeeded');
    if (result.kind !== 'succeeded') return;
    assert.equal(result.receipt.deletedNodeIds.includes(SEPARATOR), false);
    assert.equal(result.receipt.deletedNodeIds.includes(EXTRA), true);
    assert.equal(state.nodes.get(SEPARATOR)?.deletedAt, null);
    assert.equal(deleteSpy.mock.calls.some((call) => call[1]?.nodeId === SEPARATOR), false);
  });

  test('same-folder sibling order matches snapshot childIds', async () => {
    const state = createState();
    seedBaseTree(state);
    const snapshot = versionOf(buildCollectionTreeJson(liveMembers(state)));
    const folder = snapshot.treeJson.find((node) => node.id === FOLDER);
    assert.deepEqual(folder && 'childIds' in folder ? folder.childIds : [], [BM_A, BM_B]);
    state.nodes.get(BM_A)!.positionToken = 'z';
    state.nodes.get(BM_B)!.positionToken = 'a';
    const ports = portsFor(state, [snapshot]);
    const result = await restoreCollectionVersion(ports, input());
    assert.equal(result.kind, 'succeeded');
    if (result.kind !== 'succeeded') return;
    const siblings = await ports.mutations.nodes.listLiveSiblingPositions(COL, FOLDER);
    assert.deepEqual(siblings.map((row) => row.id), [BM_A, BM_B]);
  });

  test('top-level sibling order matches snapshot after restore', async () => {
    const topA = 'bm-root-a';
    const topB = 'bm-root-b';
    const moveSpy = vi.spyOn(moveNodeModule, 'moveCollectionNode');
    const state = createState();
    seedCollection(state, { collectionId: COL, rootId: ROOT, contentRevision: REV });
    seedNode(state, {
      id: topA, parentId: ROOT, kind: 'bookmark', title: 'RootA',
      url: 'https://example.test/ra', positionToken: 'a', collectionId: COL, resourceRevision: 'ra-res',
    });
    seedNode(state, {
      id: topB, parentId: ROOT, kind: 'bookmark', title: 'RootB',
      url: 'https://example.test/rb', positionToken: 'm', collectionId: COL, resourceRevision: 'rb-res',
    });
    const snapshot = versionOf(buildCollectionTreeJson(liveMembers(state)));
    state.nodes.get(topA)!.positionToken = 'z';
    state.nodes.get(topB)!.positionToken = 'a';
    const ports = portsFor(state, [snapshot]);
    const result = await restoreCollectionVersion(ports, input());
    assert.equal(result.kind, 'succeeded');
    if (result.kind !== 'succeeded') return;
    assert.equal(result.receipt.noop, false);
    assert.ok(moveSpy.mock.calls.length >= 1);
    const siblings = await ports.mutations.nodes.listLiveSiblingPositions(COL, ROOT);
    assert.deepEqual(siblings.map((row) => row.id), [topA, topB]);
  });

  test('FIFO pre_restore does not evict the restoring versionId', async () => {
    const state = createState();
    seedBaseTree(state);
    state.collections.get(COL)!.contentRevision = 'rev-current';
    const snapshot = versionOf(buildCollectionTreeJson(liveMembers(state)), {
      contentRevision: 'rev-old',
    });
    const rows: CollectionVersionRecord[] = [snapshot];
    for (let index = 1; index < COLLECTION_TREE_VERSION_FIFO_LIMIT; index += 1) {
      rows.push(versionOf([], {
        versionId: `ver-old-${String(index).padStart(2, '0')}`,
        contentRevision: `rev-fill-${index}`,
        createdAt: new Date(NOW.getTime() + index * 1000),
      }));
    }
    const ports = portsFor(state, rows);
    const result = await restoreCollectionVersion(ports, {
      ...input(),
      ifMatch: strongEntityTag('rev-current'),
    });
    assert.equal(result.kind, 'succeeded');
    assert.equal(ports.store.rows.some((row) => row.versionId === VERSION), true);
    assert.equal(ports.store.rows.length, COLLECTION_TREE_VERSION_FIFO_LIMIT);
    assert.equal(ports.store.rows.some((row) => row.versionId === 'ver-old-01'), false);
  });

  test('two moves into the same folder do not throw position_context_stale', async () => {
    const state = createState();
    seedBaseTree(state);
    const snapshot = versionOf(buildCollectionTreeJson(liveMembers(state)));
    state.nodes.get(BM_A)!.parentId = ROOT;
    state.nodes.get(BM_B)!.parentId = ROOT;
    const ports = portsFor(state, [snapshot]);
    const result = await restoreCollectionVersion(ports, input());
    assert.equal(result.kind, 'succeeded');
    if (result.kind !== 'succeeded') return;
    assert.equal(state.nodes.get(BM_A)?.parentId, FOLDER);
    assert.equal(state.nodes.get(BM_B)?.parentId, FOLDER);
    assert.equal(state.nodes.get(BM_A)?.deletedAt, null);
    assert.equal(result.receipt.movedNodeIds.includes(BM_A), true);
    assert.equal(result.receipt.movedNodeIds.includes(BM_B), true);
  });

  test('empty snapshot soft-deletes live folder/bookmark and keeps root', async () => {
    const state = createState();
    seedBaseTree(state);
    const nested = `${EXTRA}-child`;
    seedNode(state, {
      id: EXTRA, parentId: ROOT, kind: 'folder', title: 'Extra', positionToken: 'z', collectionId: COL,
    });
    seedNode(state, {
      id: nested, parentId: EXTRA, kind: 'folder', title: 'Nested', positionToken: 'a', collectionId: COL,
    });
    const deleteSpy = vi.spyOn(deleteNodeModule, 'deleteCollectionNode');
    const ports = portsFor(state, [versionOf([])]);
    const result = await restoreCollectionVersion(ports, input());
    assert.equal(result.kind, 'succeeded');
    if (result.kind !== 'succeeded') return;
    assert.ok(state.nodes.get(BM_A)?.deletedAt);
    assert.ok(state.nodes.get(BM_B)?.deletedAt);
    assert.ok(state.nodes.get(FOLDER)?.deletedAt);
    assert.ok(state.nodes.get(nested)?.deletedAt);
    assert.ok(state.nodes.get(EXTRA)?.deletedAt);
    assert.equal(state.nodes.get(ROOT)?.deletedAt, null);
    assert.equal(result.receipt.deletedNodeIds.includes(ROOT), false);
    const deleted = deleteSpy.mock.calls.map((call) => call[1]?.nodeId);
    const nestedAt = deleted.indexOf(nested);
    const extraAt = deleted.indexOf(EXTRA);
    assert.ok(nestedAt >= 0 && extraAt > nestedAt);
  });

  test('same commandId restoring a different versionId rejects instead of reporting reused', async () => {
    const state = createState();
    seedBaseTree(state);
    const treeJson = buildCollectionTreeJson(liveMembers(state));
    const versionA = versionOf(treeJson);
    const versionB = versionOf(treeJson, { versionId: 'ver-restore-2' });
    const ports = portsFor(state, [versionA, versionB]);
    const commandId = randomUUID();
    const first = await restoreCollectionVersion(ports, { ...input(), commandId, versionId: VERSION });
    assert.equal(first.kind, 'succeeded');
    // The persisted receipt proves work for VERSION only. Replaying the same
    // command id against another target must fail closed rather than answer
    // 200/'reused' for a restore that never ran.
    await assert.rejects(
      () => restoreCollectionVersion(ports, { ...input(), commandId, versionId: 'ver-restore-2' }),
      (error: unknown) => error instanceof CollectionVersionRestoreReceiptConflictError,
    );
    const stored = await ports.restoreReceipts.getByCommandId(ACCOUNT, commandId);
    assert.equal(stored?.versionId, VERSION);
  });

  test('a restore receipt bound to the same collection and version still reports reused', async () => {
    const state = createState();
    seedBaseTree(state);
    const ports = portsFor(state, [versionOf(buildCollectionTreeJson(liveMembers(state)))]);
    const commandId = randomUUID();
    const command = { ...input(), commandId, versionId: VERSION };
    const first = await restoreCollectionVersion(ports, command);
    assert.equal(first.kind, 'succeeded');
    // The outer product receipt owns the fingerprint; dropping it models the
    // trimmed/failed-outer-receipt path that re-reads the restore receipt.
    const second = await restoreCollectionVersion({
      ...ports,
      receipts: {
        ...ports.receipts,
        async lookup() { return { kind: 'absent' as const }; },
      },
    }, command);
    assert.equal(second.kind, 'reused');
  });

  test('persist unique conflict surfaces reused without leaking a 500', async () => {
    const state = createState();
    seedBaseTree(state);
    const ports = portsFor(state, [versionOf(buildCollectionTreeJson(liveMembers(state)))]);
    await assert.rejects(
      () => restoreCollectionVersion({
        ...ports,
        restoreReceipts: {
          async getByCommandId() { return null; },
          async persist() { throw new CollectionVersionRestoreReceiptConflictError(); },
        },
      }, input()),
      (error: unknown) =>
        error instanceof RestoreCollectionVersionInnerCommandError
        && error.outcome.kind === 'reused',
    );
  });
});
