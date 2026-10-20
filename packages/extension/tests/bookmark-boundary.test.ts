/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { scanBoundary } from '../src/bookmark-boundary.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';

function folder(nativeId: string, title: string, children: NormalizedBookmarkRoot['children'] = [],
  extra: Partial<NormalizedBookmarkRoot> = {}): NormalizedBookmarkRoot {
  return { nativeId, title, kind: 'folder', managed: false, children, rootKind: 'browser_root', ...extra };
}

function bookmark(nativeId: string, title: string, url: string) {
  return { nativeId, title, kind: 'bookmark' as const, managed: false, url, children: [] };
}

function profileTree(): readonly NormalizedBookmarkRoot[] {
  const barKids = [
    bookmark('b1', 'Alpha', 'https://a.example/'),
    folder('research', 'Research', [bookmark('b2', 'Paper', 'https://p.example/')]),
  ];
  const otherKids = [bookmark('b3', 'Other item', 'https://o.example/')];
  return [
    folder('bar', 'Bookmarks bar', barKids, { rootKind: 'bookmarks_bar' }),
    folder('other', 'Other bookmarks', otherKids, { rootKind: 'other' }),
    folder('mobile', 'Mobile bookmarks', [], { rootKind: 'mobile' }),
    folder('managed', 'Managed', [bookmark('mb', 'Locked', 'https://m.example/')], {
      rootKind: 'browser_root', managed: true,
    }),
  ];
}

describe('scanBoundary', () => {
  test('collapses parent+child selection to one minimal ancestor and counts unselected as skipped', () => {
    const scan = scanBoundary({
      roots: profileTree(), selectedNativeIds: ['bar', 'research'], excludedNativeIds: [],
    });
    assert.deepEqual(scan.selectedNativeIds, ['bar']);
    assert.equal(scan.nestedNormalized, true);
    assert.ok(scan.warnings.some((warning) => warning.code === 'nested_normalized'));
    assert.equal(scan.bookmarkCount, 2);
    assert.equal(scan.folderCount, 2);
    assert.ok(scan.skippedCount >= 1);
    assert.equal(scan.collectionRootDirectBookmarks, 0);
    assert.equal(scan.mounts.length, 1);
    assert.equal(scan.mounts[0]?.rootRole, 'bookmarks-bar');
  });

  test('two special roots produce two writable mounts and no collection-root bookmarks', () => {
    const scan = scanBoundary({ roots: profileTree(), selectedNativeIds: ['bar', 'other'] });
    assert.equal(scan.mounts.length, 2);
    assert.deepEqual(scan.mounts.map((mount) => mount.rootRole).sort(), ['bookmarks-bar', 'other-bookmarks']);
    assert.ok(scan.mounts.every((mount) => mount.writable && !mount.materialized));
    assert.equal(scan.collectionRootDirectBookmarks, 0);
  });

  test('managed roots are skipped and never receive a writable mount', () => {
    const scan = scanBoundary({ roots: profileTree(), selectedNativeIds: ['managed', 'bar'] });
    assert.equal(scan.classifications.get('managed'), 'managed');
    assert.ok(scan.mounts.every((mount) => mount.nativeRootId !== 'managed' && mount.writable));
    assert.ok(!scan.mounts.some((mount) => mount.rootRole === undefined && mount.nativeRootId === 'managed'));
  });

  test('inherited management protects a selected child even when descendants lack their own flag', () => {
    const roots = [folder('bar', 'Bookmarks bar', [folder('managed', 'Managed ancestor', [
      folder('child', 'Selectable-looking child', [bookmark('leaf', 'Protected leaf', 'https://example.test/protected')]),
    ], { managed: true })], { rootKind: 'bookmarks_bar' })];
    const scan = scanBoundary({ roots, selectedNativeIds: ['child'] });
    assert.equal(scan.classifications.get('child'), 'managed');
    assert.equal(scan.classifications.get('leaf'), 'managed');
    assert.equal(scan.bookmarkCount, 0);
    assert.equal(scan.folderCount, 0);
    assert.deepEqual(scan.selectedNativeIds, []);
    assert.deepEqual(scan.mounts, []);
  });

  test('unsupported remote root roles materialize under other-bookmarks', () => {
    const scan = scanBoundary({
      roots: profileTree(), selectedNativeIds: ['other'], unsupportedRoles: ['mobile-bookmarks'],
    });
    assert.ok(scan.warnings.some((warning) => warning.code === 'root_role_materialized'));
    assert.ok(scan.mounts.some((mount) => mount.materialized && mount.customSourceKey === 'materialized:mobile-bookmarks'
      && mount.nativeRootId === 'other'));
  });

  test('treeDigest changes with in-memory titles/URLs without requiring those fields in mounts', () => {
    const first = scanBoundary({ roots: profileTree(), selectedNativeIds: ['bar'] });
    const renamed = profileTree().map((root) => root.nativeId === 'bar'
      ? { ...root, title: 'Renamed bar', children: root.children.map((child) => child.kind === 'bookmark'
        ? { ...child, title: 'Renamed bookmark', url: 'https://changed.example/' } : child) }
      : root);
    const second = scanBoundary({ roots: renamed, selectedNativeIds: ['bar'] });
    assert.notEqual(first.treeDigest, second.treeDigest);
    assert.match(first.treeDigest, /^sha256:[0-9a-f]+$/u);
    assert.ok(!JSON.stringify(first.mounts).includes('"title"'));
    assert.ok(!JSON.stringify(first.mounts).includes('"url"'));
  });
});
