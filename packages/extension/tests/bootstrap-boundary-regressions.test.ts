import { advancedLocalFacts } from '../src/bootstrap/advanced-local-facts.js';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { scanBoundary } from '../src/bookmark-boundary.js';
import { localFactsFromRoots } from '../src/bootstrap/local-facts.js';
import { recordBoundaryDiagnostics } from '../src/bootstrap/boundary-diagnostics.js';
import { createBootstrapCoordinator, type ConfirmInput } from '../src/bootstrap/coordinator.js';
import type { NormalizedBookmarkNode, NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import { bar, scope, setup } from './sync-recovery-hardening-fixture.js';

const bookmark = (nativeId: string, url: string): NormalizedBookmarkNode =>
  ({ nativeId, title: nativeId, kind: 'bookmark', managed: false, url, children: [] });
const roots: NormalizedBookmarkRoot[] = [{ nativeId: '1', title: 'Bookmarks bar', kind: 'folder', managed: false,
  rootKind: 'bookmarks_bar', children: [{ nativeId: '2', title: 'Private', kind: 'folder', managed: false,
    children: [bookmark('3', 'https://example.com/private')] }, bookmark('4', 'https://example.com/public')] }];
const base: ConfirmInput = { confirmationId: 'confirm', treeDigest: 'sha256:tree', confirmationVersion: '1',
  localFacts: localFactsFromRoots(roots, ['1']), mounts: [{ nativeRootId: '1', rootRole: 'bookmarks-bar', remoteMountNodeId: 'bar' }],
  rootNodeId: 'root', remoteFacts: [
    { nodeId: 'root', parentId: null, kind: 'folder', title: 'Root', folderRole: 'root', revision: 'r1' },
    { nodeId: 'bar', parentId: 'root', kind: 'folder', title: 'Bookmarks bar', folderRole: 'bookmarks-bar', revision: 'r1' },
    { nodeId: 'private-folder', parentId: 'bar', kind: 'folder', title: 'Private', revision: 'r1' },
  ] };
async function seedPrivate(store: Awaited<ReturnType<typeof setup>>) {
  await store.putMapping(scope, bar);
  await store.putMapping(scope, { nativeId: '2', colpId: 'private-folder', rootNativeId: '1', nodeKind: 'folder',
    parentNativeId: '1', parentColpId: 'bar', projection: { revision: 'r1', digest: 'private', content: { title: 'Private' } } });
  await store.configureBrowserRoots(scope, { discovered: [{ nativeId: '1', ancestorNativeIds: [] },
      { nativeId: '2', ancestorNativeIds: ['1'] }], selectedNativeIds: ['1'], privateNativeIds: ['2'], status: 'ready' });
  assert.deepEqual((await store.getScope(scope))?.privateRoots, ['private-folder']);
}

describe('bootstrap privacy and representability match its preview', () => {
  test('never enqueues private descendants, including legacy facts supplied by a resumed run', async () => {
    const store = await setup(); await seedPrivate(store);
    const scan = scanBoundary({ roots, selectedNativeIds: ['1'], privateNativeIds: ['2'] });
    assert.equal(scan.bookmarkCount, 1);
    assert.deepEqual(localFactsFromRoots(roots, ['1'], [], ['2']).map(row => row.nativeId), ['4']);
    const coordinator = createBootstrapCoordinator({ store, scope, randomUUID: () => 'run' });
    const paused = await coordinator.confirm({ ...base, pauseAfter: 'matching' });
    await coordinator.advance(paused.run.runId, base);
    const queue = await store.listQueue(scope);
    assert.deepEqual(queue.map(row => row.opId), ['b3.confirm.create.4']);
    store.close();
  });

  test('reaches a nested selected mount through unselected ancestors', () => {
    const scan = scanBoundary({ roots, selectedNativeIds: ['2'] });
    assert.equal(scan.bookmarkCount, 1);
    assert.deepEqual(localFactsFromRoots(roots, ['2']).map(row => row.nativeId), ['2', '3']);
    const excluded = scanBoundary({ roots, selectedNativeIds: ['2'], privateNativeIds: ['2'] });
    assert.equal(excluded.mounts.length, 0);
  });

  test('preserves explicit preview exclusions when resuming stale durable facts', async () => {
    const store = await setup(); await store.putMapping(scope, bar);
    await store.putScopePreview(scope, { previewId: 'preview', boundaryVersion: '1', treeDigest: 'sha256:tree',
      bookmarkCount: 1, folderCount: 1, skippedCount: 2, expiresAt: Date.now() + 60_000, warnings: [],
      boundary: { selectedNativeIds: ['1'], excludedNativeIds: ['2'], mounts: [] } });
    await createBootstrapCoordinator({ store, scope }).confirm({ ...base, previewId: 'preview' });
    assert.deepEqual((await store.listQueue(scope)).map(row => row.opId), ['b3.confirm.create.4']);
    store.close();
  });

  test.each([['bookmarklet', 'javascript:void(0)'], ['long URL', 'https://example.com/' + 'x'.repeat(4100)]])(
    'isolates an unsupported %s and continues valid bookmarks', async (_name, url) => {
      const store = await setup(); await store.putMapping(scope, bar);
      const localFacts = [{ nativeId: 'bad', parentNativeId: '1', mountNativeRootId: '1', kind: 'bookmark' as const,
        title: 'Unsupported', url }, { nativeId: 'good', parentNativeId: '1', mountNativeRootId: '1', kind: 'bookmark' as const,
        title: 'Supported', url: 'https://example.com/good' }];
      const coordinator = createBootstrapCoordinator({ store, scope });
      const view = await coordinator.confirm({ ...base, localFacts });
      assert.equal(view.run.phase, 'syncing');
      assert.deepEqual((await store.listQueue(scope)).map(row => row.opId), ['b3.confirm.create.good']);
      await coordinator.advance(view.run.runId, { ...base, localFacts });
      assert.equal((await store.listIngressDiagnostics(scope)).find(row => row.code === 'invalid_url')?.count, 1);
      store.close();
    });

  test('re-matching clears obsolete review items after recovery', async () => {
    const store = await setup(); await store.putMapping(scope, bar);
    const coordinator = createBootstrapCoordinator({ store, scope, randomUUID: () => 'run' });
    const paused = await coordinator.confirm({ ...base, localFacts: [], pauseAfter: 'matching' });
    await store.putBootstrapRun(scope, { ...paused.run, phase: 'syncing', attention: {
      reportId: 'run', version: 1, candidateCount: 1, conflictCount: 0, localOnlyCount: 0,
      remoteOnlyCount: 0, matchedCount: 0, createdAt: Date.now(),
      items: [{ itemId: 'old-review', kind: 'duplicate_candidate', locationCount: 2, decision: 'open' }],
    } });
    const recovered = await coordinator.advance('run', { ...base, localFacts: [] });
    assert.equal(recovered.run.phase, 'completed');
    assert.equal((await coordinator.status()).attention, undefined);
    store.close();
  });

  test('preview and progress omit unsupported content and explain omissions once across retries', async () => {
    const store = await setup();
    const tree: NormalizedBookmarkRoot[] = [{ ...roots[0]!, children: [bookmark('bad', 'javascript:void(0)'),
      bookmark('good', 'https://example.com/good')] }];
    const scan = scanBoundary({ roots: tree, selectedNativeIds: ['1'] });
    assert.equal(scan.bookmarkCount, 1);
    assert.equal(scan.classifications.get('bad'), 'unsupported');
    assert.ok(scan.warnings.some(row => row.code === 'invalid_url'));
    assert.deepEqual(localFactsFromRoots(tree, ['1']).map(row => row.nativeId), ['good']);
    assert.equal(advancedLocalFacts(tree, scan).find(row => row.nativeId === 'bad')?.privateLocal, true,
      'destructive modes retain unsupported items as protected facts');
    await recordBoundaryDiagnostics(store, scope, scan, tree, 'preview');
    await recordBoundaryDiagnostics(store, scope, scan, tree, 'preview');
    assert.equal((await store.listIngressDiagnostics(scope))[0]?.count, 1);
    store.close();
  });
});
