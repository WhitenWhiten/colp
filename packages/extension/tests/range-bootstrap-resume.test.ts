/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: npx vitest run tests/range-bootstrap-resume.test.ts
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import { matchLocalRemote } from '../src/bootstrap/matcher.js';
import { resolveIngressBoundary } from '../src/bookmark-event-ingress.js';
import { confirmAddRange, previewAddRange } from '../src/scope-commands.js';
import { setup, scope, installKns03IndexedDb, baseConfirm, bookmark, root } from './kns-03-bootstrap-harness.js';

installKns03IndexedDb();

const barRoot = {
  nativeId: 'bar', title: 'Bar', kind: 'folder' as const, managed: false, rootKind: 'bookmarks_bar' as const,
  children: [{ nativeId: 'bm-1', title: 'bm-1', kind: 'bookmark' as const, managed: false,
    url: 'https://example.com/one', children: [] }],
};

test('resuming an expanded range reports a legacy flattened mount for explicit ancestry repair', () => {
  const report = matchLocalRemote({ scopeKey: 'range', confirmationId: 'expand', rootNodeId: 'folder-root', bootstrapMode: 'merge',
    mounts: [{ nativeRootId: 'bar', remoteMountNodeId: 'remote-bar', rootRole: 'bookmarks-bar' },
      { nativeRootId: 'nested', remoteMountNodeId: 'remote-nested', customSourceKey: 'folder:nested' }],
    local: [{ nativeId: 'nested', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'folder', title: 'Nested' },
      { nativeId: 'leaf', mountNativeRootId: 'bar', parentNativeId: 'nested', kind: 'bookmark', title: 'Leaf', url: 'https://example.test/leaf' }],
    remote: [root, { nodeId: 'remote-bar', parentId: root.nodeId, kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar', revision: 'r-bar' },
      { nodeId: 'remote-nested', parentId: root.nodeId, kind: 'folder', title: 'Nested', folderRole: 'custom', revision: 'r-nested' },
      { nodeId: 'remote-leaf', parentId: 'remote-nested', kind: 'bookmark', title: 'Leaf', url: 'https://example.test/leaf', revision: 'r-leaf' }],
    mappings: [{ nativeId: 'nested', colpId: 'remote-nested' }, { nativeId: 'leaf', colpId: 'remote-leaf' }],
  });
  expect(report.conflicts).toEqual([expect.objectContaining({ kind: 'parent', localNativeId: 'nested', remoteNodeId: 'remote-nested' })]);
  expect(report.planned).toEqual([]); // no automatic remote move of an existing node
});

test('R2: range bootstrap can resume after mount receipt when onboarding was completed', async () => {
  const { store } = await setup();
  await store.setFirstRun(scope, 'completed');
  const preview = await previewAddRange(store, scope, {
    roots: [barRoot], selectedNativeIds: ['bar'],
  });
  await confirmAddRange(store, scope, { previewId: preview.previewId, confirmationId: 'range-confirm',
    treeDigest: preview.treeDigest, localFacts: [bookmark('bm-1', 'https://example.com/one')],
    remoteFacts: [root], rootNodeId: root.nodeId });
  expect((await store.getScope(scope))?.firstRun).toBe('completed');
  const [mountOp] = await store.listQueue(scope);
  expect(mountOp).toBeDefined();
  await store.completeQueueWithReceipt(scope, mountOp!.sequence, {
    opId: mountOp!.opId, operationDigest: mountOp!.digest, kind: 'terminal', receiptId: 'range-mount-receipt',
    resultDigest: 'sha256:result',
    result: { results: [{ opId: mountOp!.opId, sequence: mountOp!.sequence, status: 'applied',
      targetId: 'remote-bar', revision: 'r1' }] },
  });
  const resumed = await createBootstrapCoordinator({ store, scope }).resume(baseConfirm({ confirmationId: 'range-confirm' }));
  expect(resumed).not.toBeNull();
  expect((await store.listQueue(scope)).some(row => row.payload.type === 'create_node' && row.opId !== mountOp!.opId)).toBe(true);
  expect((await store.getScope(scope))?.firstRun).toBe('completed');
});

test('in-flight range bootstrap keeps a pending mount live for ingress after first-run completed', async () => {
  const { store } = await setup();
  await store.setFirstRun(scope, 'completed');
  const preview = await previewAddRange(store, scope, { roots: [barRoot], selectedNativeIds: ['bar'] });
  await confirmAddRange(store, scope, {
    previewId: preview.previewId, confirmationId: 'range-confirm-ingress', treeDigest: preview.treeDigest,
    localFacts: [bookmark('bm-1', 'https://example.com/one')], remoteFacts: [root], rootNodeId: root.nodeId,
  });
  expect((await store.getScope(scope))?.firstRun).toBe('completed');
  const boundary = await resolveIngressBoundary(store, scope);
  expect(boundary.selectedNative.has('bar')).toBe(true);
});
