import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import { matchLocalRemote, type RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { active, barMount, baseConfirm, bookmark, indexedDB, installKns03IndexedDb, recoveryNode, recoveryRoot,
  root, scope, setup } from './kns-03-bootstrap-harness.js';

installKns03IndexedDb();

const bar: RemoteNodeFact = { nodeId: 'mount-bar', parentId: root.nodeId, kind: 'folder',
  title: 'Bar', folderRole: 'bookmarks-bar', revision: 'r-bar' };

describe('advanced bootstrap execution boundary', () => {
  test.each(['merge', 'download', 'upload', 'mirror'] as const)(
    '%s preview leaves the complete durable scope unchanged and never retires authority', async (bootstrapMode) => {
      const store = createSyncStateStore({ indexedDB });
      await active(store, { legacyCanonicalRoot: 'legacy-root' });
      let retired = 0;
      const coordinator = createBootstrapCoordinator({ store, scope, retireLegacy: async () => { retired += 1; } });
      const before = await store.exportScope(scope);
      const view = await coordinator.confirm(baseConfirm({ bootstrapMode, previewOnly: true }));
      assert.equal(view.run.previewOnly, true);
      assert.deepEqual(view.queuedOpIds, []);
      assert.deepEqual(view.report?.planned, []);
      assert.deepEqual(await store.exportScope(scope), before);
      assert.equal(retired, 0);
      const started = await coordinator.confirm(baseConfirm({}));
      assert.equal(started.run.previewOnly, undefined);
      assert.equal(retired, 1);
      assert.ok((await store.listQueue(scope)).length > 0);
    },
  );

  test.each(['download', 'upload', 'mirror'] as const)(
    'unconfirmed %s cannot activate mounts or change the queue', async (bootstrapMode) => {
      const { store, coordinator } = await setup();
      const before = await store.exportScope(scope);
      const view = await coordinator.confirm(baseConfirm({ bootstrapMode }));
      assert.equal(view.report?.destructivePlan?.confirmed, false);
      assert.deepEqual(await store.exportScope(scope), before);
      await assert.rejects(coordinator.confirm(baseConfirm({ bootstrapMode, destructiveConfirmed: true })),
        /bootstrap_execution_unsupported/);
      assert.deepEqual(await store.exportScope(scope), before);
    },
  );

  test('preview reads a staged snapshot without persisting a run or snapshot cursor', async () => {
    const { store, coordinator } = await setup();
    await store.stageRecoveryPage(scope, {
      snapshotId: 'snapshot-preview', revision: 'r1', syncCursor: 'cursor-preview',
      identityDigest: 'identity-preview', rootNodeId: root.nodeId, page: 0,
      pageDigest: 'sha256:page', previousPageDigest: null, nextCursor: null, complete: true,
      nodes: [recoveryRoot(root.nodeId), recoveryNode(bar.nodeId, root.nodeId, 'Folder',
        { title: 'Bar', folderRole: 'bookmarks-bar' }, 'bookmarks-bar')],
    });
    const before = await store.exportScope(scope);
    const view = await coordinator.preview(baseConfirm({ remoteFacts: undefined }));
    assert.ok(view.report);
    assert.deepEqual(await store.exportScope(scope), before);
  });

  test('old persisted advanced runs cannot bypass the execution boundary through advance or resume', async () => {
    const { store, coordinator } = await setup();
    await store.putBootstrapRun(scope, { runId: 'legacy-advanced', confirmationId: 'conf-1', phase: 'matching',
      bootstrapMode: 'download', destructiveConfirmed: true, updatedAt: 1 });
    await store.setFirstRun(scope, 'running');
    const before = await store.exportScope(scope);
    await assert.rejects(coordinator.advance('legacy-advanced', baseConfirm({})), /bootstrap_execution_unsupported/);
    await assert.rejects(coordinator.resume(baseConfirm({})), /bootstrap_execution_unsupported/);
    assert.deepEqual(await store.exportScope(scope), before);
  });

  test('local removal is a report item, never a server operation, even when IDs collide', () => {
    const report = matchLocalRemote({ scopeKey: 'scope', confirmationId: 'confirm', bootstrapMode: 'download',
      destructiveConfirmed: true, local: [bookmark('remote-id', 'https://example.test'),
        { nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: null, kind: 'folder', title: 'Bar' }],
      remote: [root, bar, { nodeId: 'remote-id', parentId: root.nodeId, kind: 'bookmark',
        title: 'Unrelated remote bookmark', url: 'https://other.example.test', revision: 'r-other' }],
      mounts: [barMount(bar.nodeId)], mappings: [], rootNodeId: root.nodeId });
    assert.deepEqual(report.planned, []);
    assert.deepEqual(report.destructivePlan?.deletes,
      [{ targetId: 'remote-id', nativeId: 'remote-id', side: 'local' }]);
  });

  test('upload deletion preview excludes mount roots and every unselected remote subtree', () => {
    const remote: RemoteNodeFact[] = [root, bar,
      { ...bar, nodeId: 'custom', folderRole: 'custom' },
      { ...bar, nodeId: 'other', folderRole: 'other-bookmarks' },
      { ...bar, nodeId: 'selected-leaf', parentId: bar.nodeId, folderRole: undefined },
      { ...bar, nodeId: 'unselected-leaf', parentId: 'other', folderRole: undefined },
      { ...bar, nodeId: 'custom-leaf', parentId: 'custom', folderRole: undefined }];
    const report = matchLocalRemote({ scopeKey: 'scope', confirmationId: 'confirm', bootstrapMode: 'upload',
      local: [], remote, mounts: [barMount(bar.nodeId), { nativeRootId: 'native-custom',
        remoteMountNodeId: 'custom', customSourceKey: 'custom-key' }], mappings: [], rootNodeId: root.nodeId });
    assert.deepEqual(report.planned, []);
    assert.deepEqual(report.destructivePlan?.deletes.map((item) => item.targetId), ['selected-leaf', 'custom-leaf']);
  });
});
