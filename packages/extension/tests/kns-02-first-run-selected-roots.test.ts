/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: npx vitest run tests/kns-02-first-run-selected-roots.test.ts
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import { diffLiveRange, discoveredFromRoots, previewRangeChange } from '../src/scope-range.js';
import { persistFirstRunBrowserRoots } from '../src/sw/first-run-browser-roots.js';
import {
  barMount, baseConfirm, bookmark, installKns03IndexedDb, otherMount, root, scope, setup,
} from './kns-03-bootstrap-harness.js';

installKns03IndexedDb();

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('KNS-02 first-run selectedRoots authority', () => {
  test('confirm bar+other writes selectedRoots that map back; range preview is not a removal', async () => {
    const { store, coordinator } = await setup();
    await coordinator.confirm(baseConfirm({
      localFacts: [
        bookmark('bm-1', 'https://example.com/one'),
        { nativeId: 'bm-2', mountNativeRootId: 'other', parentNativeId: 'other', kind: 'bookmark',
          title: 'Two', url: 'https://example.com/two' },
      ],
      remoteFacts: [root,
        { nodeId: 'remote-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar',
          folderRole: 'bookmarks-bar', revision: 'r-bar' },
        { nodeId: 'remote-other', parentId: 'folder-root', kind: 'folder', title: 'Other',
          folderRole: 'other-bookmarks', revision: 'r-other' },
      ],
      mounts: [barMount('remote-bar'), otherMount('remote-other')],
    }));
    await store.setFirstRun(scope, 'completed');
    await persistFirstRunBrowserRoots(store, scope, {
      discovered: [
        { nativeId: 'bar', ancestorNativeIds: [] },
        { nativeId: 'other', ancestorNativeIds: [] },
      ],
      selectedNativeIds: ['bar', 'other'],
      privateNativeIds: [],
    });
    const recorded = await store.getScope(scope);
    assert.ok(recorded && recorded.selectedRoots.length > 0);
    const byColp = new Map((await store.listMappings(scope)).map((row) => [row.colpId, row.nativeId]));
    const committed = recorded.selectedRoots.map((id) => byColp.get(id)).filter((id): id is string => Boolean(id));
    assert.deepEqual([...committed].sort(), ['bar', 'other']);
    assert.deepEqual([...recorded.selectedRoots].sort(), ['remote-bar', 'remote-other']);
    const roots = tree();
    const { diff } = await previewRangeChange(store, scope, { roots, selectedNativeIds: committed });
    assert.equal(diff.removedNativeIds.includes('bar'), false);
    assert.equal(diff.removedNativeIds.includes('other'), false);
    const emptied = diffLiveRange({
      liveMounts: await store.listMountBindings(scope), mappings: await store.listMappings(scope),
      selectedNativeIds: [], discovered: discoveredFromRoots(roots),
    });
    assert.ok(emptied.removedNativeIds.includes('bar'));
    assert.ok(emptied.removedNativeIds.includes('other'));
  });

  test('local UUIDs still map selectedRoots back when mount-resolve has no remote id yet', async () => {
    const { store } = await setup();
    await persistFirstRunBrowserRoots(store, scope, {
      discovered: [
        { nativeId: 'bar', ancestorNativeIds: [] },
        { nativeId: 'other', ancestorNativeIds: [] },
      ],
      selectedNativeIds: ['bar', 'other'],
    });
    const recorded = await store.getScope(scope);
    const byColp = new Map((await store.listMappings(scope)).map((row) => [row.colpId, row.nativeId]));
    assert.deepEqual([...(recorded?.selectedRoots ?? []).map((id) => byColp.get(id))].sort(), ['bar', 'other']);
  });

  test('first-run confirm schedules configureBrowserRoots after coordinator.confirm', async () => {
    const source = await readFile(join(packageRoot, 'src/sw/first-run.ts'), 'utf8');
    const helper = await readFile(join(packageRoot, 'src/sw/first-run-browser-roots.ts'), 'utf8');
    const confirm = source.slice(source.indexOf('async function handleFirstRunConfirm'),
      source.indexOf('async function handleAttentionMessage'));
    assert.match(confirm, /await coordinator\.confirm\(/);
    assert.match(confirm, /await persistConfirmedPreviewRoots\(scope, preview\)/);
    assert.match(source, /persistFirstRunBrowserRoots/);
    assert.match(helper, /configureBrowserRoots/);
    assert.match(helper, /bindMountMapping/);
    assert.doesNotMatch(confirm, /bookmarks\.(create|update|move|remove)/);
  });
});

function tree(): readonly NormalizedBookmarkRoot[] {
  return [
    { nativeId: 'bar', title: 'Bar', kind: 'folder', managed: false, rootKind: 'bookmarks_bar', children: [
      { nativeId: 'bm-1', title: 'One', kind: 'bookmark', managed: false, url: 'https://example.com/one', children: [] },
    ] },
    { nativeId: 'other', title: 'Other', kind: 'folder', managed: false, rootKind: 'other', children: [
      { nativeId: 'bm-2', title: 'Two', kind: 'bookmark', managed: false, url: 'https://example.com/two', children: [] },
    ] },
  ];
}
