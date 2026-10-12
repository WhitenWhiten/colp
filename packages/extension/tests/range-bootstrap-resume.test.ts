/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: npx vitest run tests/range-bootstrap-resume.test.ts
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import { resolveIngressBoundary } from '../src/bookmark-event-ingress.js';
import { confirmAddRange, previewAddRange } from '../src/scope-commands.js';
import { applyConfirmedRange, previewRangeChange } from '../src/scope-range.js';
import { setup, scope, installKns03IndexedDb, baseConfirm, bookmark, root } from './kns-03-bootstrap-harness.js';

installKns03IndexedDb();

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const barRoot = {
  nativeId: 'bar', title: 'Bar', kind: 'folder' as const, managed: false, rootKind: 'bookmarks_bar' as const,
  children: [{ nativeId: 'bm-1', title: 'bm-1', kind: 'bookmark' as const, managed: false,
    url: 'https://example.com/one', children: [] }],
};

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

test('handleRangeConfirm starts mount-resolve for a newly selected folder after first-run completed', async () => {
  const range = await readFile(join(packageRoot, 'src/sw/range.ts'), 'utf8');
  const firstRun = await readFile(join(packageRoot, 'src/sw/first-run.ts'), 'utf8');
  assert.match(range, /confirmAddRange/);
  assert.doesNotMatch(firstRun, /if \(recorded\?\.firstRun !== 'running'\) return false/);
  const { store } = await setup();
  await store.setFirstRun(scope, 'completed');
  const { preview } = await previewRangeChange(store, scope, { roots: [barRoot], selectedNativeIds: ['bar'] });
  await applyConfirmedRange(store, scope, { preview, keepNativeIds: [], unmountNativeIds: [] });
  expect((await store.listQueue(scope)).length).toBe(0);
  const confirmed = await confirmAddRange(store, scope, {
    previewId: preview.previewId, confirmationId: 'range-confirm-prod', treeDigest: preview.treeDigest,
    localFacts: [bookmark('bm-1', 'https://example.com/one')], remoteFacts: [root], rootNodeId: root.nodeId,
  });
  expect(confirmed.ok).toBe(true);
  expect((await store.getScope(scope))?.firstRun).toBe('completed');
  const queued = await store.listQueue(scope);
  expect(queued.some((row) => row.payload.type === 'create_node'
    && (row.payload.payload as { node?: { folderRole?: string } }).node?.folderRole === 'bookmarks-bar')).toBe(true);
  const mount = (await store.listMountBindings(scope)).find((row) => row.nativeRootId === 'bar');
  expect(mount?.status).toBe('pending');
  expect(mount?.remoteMountNodeId ?? null).toBeNull();
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
