import { expect, test } from 'vitest';
import { localFactsFromRoots } from '../src/bootstrap/local-facts.js';
import { matchLocalRemote, type LocalNodeFact, type MountFact, type RemoteNodeFact } from '../src/bootstrap/matcher.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';

const roots: NormalizedBookmarkRoot[] = [{ nativeId: 'bar', title: 'Localized browser bar', kind: 'folder', managed: false,
  rootKind: 'bookmarks_bar', children: [{ nativeId: 'parent', title: 'Work', kind: 'folder', managed: false, children: [
    { nativeId: 'child', title: 'Bookmarks bar', kind: 'folder', managed: false, children: [
      { nativeId: 'bookmark', title: 'Existing bookmark', kind: 'bookmark', managed: false,
        url: 'https://example.test/exact?tracking=1', children: [] },
    ] },
  ] }] }];
const remote: RemoteNodeFact[] = [
  { nodeId: 'root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r-root' },
  { nodeId: 'cloud-bar', parentId: 'root', kind: 'folder', title: 'Another locale', folderRole: 'bookmarks-bar', revision: 'r-bar' },
  { nodeId: 'cloud-parent', parentId: 'cloud-bar', kind: 'folder', title: 'Work', revision: 'r-parent' },
  { nodeId: 'cloud-child', parentId: 'cloud-parent', kind: 'folder', title: 'Bookmarks bar', revision: 'r-child' },
  { nodeId: 'cloud-bookmark', parentId: 'cloud-child', kind: 'bookmark', title: 'Existing bookmark',
    url: 'https://example.test/exact?tracking=1', revision: 'r-bookmark' },
];
const local = localFactsFromRoots(roots, ['child']);
const mount: MountFact = { nativeRootId: 'child', customSourceKey: 'folder:child', remoteMountNodeId: null };
const match = (overrides: Partial<Parameters<typeof matchLocalRemote>[0]> = {}) => matchLocalRemote({
  scopeKey: 'scope', confirmationId: 'reconnected', local, remote, mappings: [], mounts: [mount],
  rootNodeId: 'root', bootstrapMode: 'merge', ...overrides,
});

test.each([null, 'cloud-child'])('ordinary selected folder reuses its parent container when bound=%s', remoteMountNodeId => {
  const report = match({ mounts: [{ ...mount, remoteMountNodeId }] });
  expect([...report.matched].sort((a, b) => a.nativeId.localeCompare(b.nativeId))).toEqual([
    { nativeId: 'bar', nodeId: 'cloud-bar' }, { nativeId: 'parent', nodeId: 'cloud-parent' },
    { nativeId: 'child', nodeId: 'cloud-child' }, { nativeId: 'bookmark', nodeId: 'cloud-bookmark' },
  ].sort((a, b) => a.nativeId.localeCompare(b.nativeId)));
  expect(report.planned).toEqual([]);
  expect(report.conflicts).toEqual([]);
  expect(local.find(row => row.nativeId === 'child')?.folderRole).toBeUndefined();
});

test('same URL and title under a different proved parent remain distinct', () => {
  const report = match({ remote: remote.map(row => row.nodeId === 'cloud-bookmark' ? { ...row, parentId: 'cloud-sibling' } : row)
    .concat({ nodeId: 'cloud-sibling', parentId: 'cloud-parent', kind: 'folder', title: 'Sibling', revision: 'r-sibling' }) });
  expect(report.matched.some(row => row.nativeId === 'bookmark')).toBe(false);
  expect(report.planned).toEqual([expect.objectContaining({ nativeId: 'bookmark', type: 'create_node', parentId: 'cloud-child' })]);
  expect(report.candidates).toEqual([expect.objectContaining({ nodeIds: ['cloud-bookmark', 'bookmark'] })]);
});

test('an exact URL candidate from another real browser root never enters this selected folder', () => {
  const report = match({ remote: remote.map(row => row.nodeId === 'cloud-bookmark' ? { ...row, parentId: 'cloud-other' } : row)
    .concat({ nodeId: 'cloud-other', parentId: 'root', kind: 'folder', title: 'Other', folderRole: 'other-bookmarks', revision: 'r-other' }) });
  expect(report.matched.some(row => row.nativeId === 'bookmark')).toBe(false);
  expect(report.candidates).toEqual([]);
});

test('two indistinguishable remote siblings are never arbitrarily adopted', () => {
  const report = match({ remote: [...remote, { ...remote[3]!, nodeId: 'cloud-child-duplicate' }] });
  expect(report.matched.filter(row => ['child', 'bookmark'].includes(row.nativeId))).toEqual([]);
  expect(report.localOnly).toEqual(['child', 'bookmark']);
});

test('two indistinguishable local siblings cannot both adopt one remote identity', () => {
  const duplicated: LocalNodeFact = { ...local.find(row => row.nativeId === 'child')!, nativeId: 'child-duplicate' };
  const report = match({ local: [...local, duplicated] });
  expect(report.matched.filter(row => ['child', 'child-duplicate', 'bookmark'].includes(row.nativeId))).toEqual([]);
});

test('existing identity with a different parent stays identified and requires a parent decision', () => {
  const report = match({ mappings: [{ nativeId: 'parent', colpId: 'cloud-parent' },
    { nativeId: 'child', colpId: 'known-child' }], remote: [...remote,
    { ...remote[3]!, nodeId: 'known-child', parentId: 'cloud-other' },
    { nodeId: 'cloud-other', parentId: 'root', kind: 'folder', title: 'Other', folderRole: 'other-bookmarks', revision: 'r-other' }] });
  expect(report.matched.find(row => row.nativeId === 'child')?.nodeId).toBe('known-child');
  expect(report.matched.some(row => row.nodeId === 'cloud-child')).toBe(false);
  expect(report.conflicts).toContainEqual(expect.objectContaining({ kind: 'parent', localNativeId: 'child', remoteNodeId: 'known-child' }));
});

test('an existing identity absent from the snapshot is not replaced by a same-name new node', () => {
  const report = match({ mappings: [{ nativeId: 'child', colpId: 'known-but-absent-child' }] });
  expect(report.matched.some(row => row.nativeId === 'child')).toBe(false);
  expect(report.planned.some(row => row.nativeId === 'child')).toBe(false);
});

test('URL variants inside the selected child do not acquire the same cloud identity', () => {
  const report = match({ local: local.map(row => row.nativeId === 'bookmark' ? { ...row, url: 'https://example.test/exact' } : row) });
  expect(report.matched.some(row => row.nativeId === 'bookmark')).toBe(false);
  expect(report.candidates).toEqual([]);
  expect(report.planned).toEqual([expect.objectContaining({ nativeId: 'bookmark', type: 'create_node', parentId: 'cloud-child' })]);
});
