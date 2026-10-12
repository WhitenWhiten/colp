import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { BookmarkTreeError, createChromeBookmarkTreeAdapter, folderRoleForBrowserRoot,
  browserRootKindForFolderRole, customSourceKeyForFolder, isWritableMountRole } from '../src/chrome-bookmark-tree.js';
import { decideLocalPrivacy } from '../src/bookmark-privacy.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { scanBoundary } from '../src/bookmark-boundary.js';
import { localFactsFromRoots } from '../src/bootstrap/local-facts.js';
import { workspaceFolderTree } from './fixtures/workspace-folders.js';

const scope: SyncScope = Object.freeze({ environment: 'production', serverId: 'server-a',
  serverOrigin: 'https://known.example', accountId: 'account-a', browserProfileId: 'profile-a',
  collectionId: 'collection-a', replicaId: 'replica-a', generation: 1 });
const node = (id: string, title: string, children: any[] = [], extra: object = {}) =>
  ({ id, title, children, ...extra });

describe('P3-29 Chrome bookmark tree adapter', () => {
  test('reads real root identities through getTree/getChildren/getSubTree without treating names as identity', async () => {
    const bar = node('1', 'Bookmarks Bar', [node('10', 'Folder', [], { url: undefined })]);
    const other = node('2', 'Other Bookmarks'); const mobile = node('3', 'Mobile bookmarks');
    const api = fixtureApi([node('0', '', [bar, other, mobile])]);
    const adapter = createChromeBookmarkTreeAdapter(api);
    const first = await adapter.read();
    assert.deepEqual(first.roots.map((root) => root.rootKind), ['bookmarks_bar', 'other', 'mobile']);
    api.tree[0].children![0].title = 'Renamed by locale';
    const renamed = await adapter.read();
    assert.equal(renamed.roots[0]?.nativeId, first.roots[0]?.nativeId);
    await adapter.getChildren('1'); await adapter.getSubTree('1');
    assert.deepEqual(api.calls, ['getTree', 'getTree', 'getChildren:1', 'getSubTree:1']);
  });

  test('preserves Folder/Bookmark/Separator shape in empty, deep and wide trees', async () => {
    let deep = node('leaf', '', [], { type: 'separator' });
    for (let index = 0; index < 80; index += 1) deep = node(`deep-${index}`, `Depth ${index}`, [deep]);
    const wide = Array.from({ length: 300 }, (_, index) => node(`b-${index}`, `B ${index}`, [],
      { url: `https://example.test/${index}` }));
    const view = await createChromeBookmarkTreeAdapter(fixtureApi([node('0', '', [node('1', 'Bar', [deep, ...wide]),
      node('2', 'Other'), node('3', 'Mobile')])])).read();
    assert.equal(view.roots[1]?.children.length, 0);
    assert.equal(view.roots[0]?.children[0]?.kind, 'folder');
    assert.equal(view.roots[0]?.children[0]?.children[0]?.kind, 'folder');
    assert.equal(view.roots[0]?.children.at(-1)?.kind, 'bookmark');
    assert.equal(allKinds(view.roots).includes('separator'), true);
  });

  test('fails closed for duplicate IDs, cycles, malformed nodes and API failure', async () => {
    const duplicate = node('0', '', [node('1', 'Bar', [node('x', 'A'), node('x', 'B')]), node('2', 'Other')]);
    await assert.rejects(() => createChromeBookmarkTreeAdapter(fixtureApi([duplicate])).read(), /duplicate_native_id/);
    const cyclic = node('0', '', []); cyclic.children = [cyclic];
    await assert.rejects(() => createChromeBookmarkTreeAdapter(fixtureApi([cyclic])).read(), /bookmark_tree_cycle/);
    await assert.rejects(() => createChromeBookmarkTreeAdapter(fixtureApi([{ id: '', title: 1 } as never])).read(),
      BookmarkTreeError);
    await assert.rejects(() => createChromeBookmarkTreeAdapter(fixtureApi([], new Error('API unavailable'))).read(),
      /tree_unavailable/);
  });

  test('classifies revoked permission, managed policy and temporary failures as recoverable', async () => {
    const permission = fixtureApi([], new Error('The bookmarks permission is required'));
    await assert.rejects(() => createChromeBookmarkTreeAdapter(permission).read(), /permission_required/);
    const managed = node('4', 'Managed', [], { unmodifiable: 'managed' });
    const view = await createChromeBookmarkTreeAdapter(fixtureApi([node('0', '', [node('1', 'Bar'), node('2', 'Other'), managed])])).read();
    assert.equal(view.roots[2]?.managed, true);
    assert.equal(view.roots[2]?.rootKind, 'browser_root');
  });

  test('uses folderType for Mobile and never guesses it when the platform omits Mobile', async () => {
    const typed = await createChromeBookmarkTreeAdapter(fixtureApi([node('0', '', [
      node('20', 'localized', [], { folderType: 'other' }), node('10', 'localized', [], { folderType: 'bookmarks-bar' }),
      node('30', 'localized', [], { folderType: 'mobile' }), node('40', 'managed', [], { folderType: 'managed' }),
    ])])).read();
    assert.deepEqual(typed.roots.map((root) => root.rootKind), ['other', 'bookmarks_bar', 'mobile', 'browser_root']);
    const absent = await createChromeBookmarkTreeAdapter(fixtureApi([node('0', '', [node('1', 'Bar'), node('2', 'Other')])])).read();
    assert.deepEqual(absent.roots.map((root) => root.rootKind), ['bookmarks_bar', 'other']);
  });

  test('maps BrowserRootKind to COLP folderRole and never treats managed as writable', () => {
    assert.equal(folderRoleForBrowserRoot('bookmarks_bar', false), 'bookmarks-bar');
    assert.equal(folderRoleForBrowserRoot('other', false), 'other-bookmarks');
    assert.equal(folderRoleForBrowserRoot('mobile', false), 'mobile-bookmarks');
    assert.equal(folderRoleForBrowserRoot('browser_root', false), 'custom');
    assert.equal(folderRoleForBrowserRoot('bookmarks_bar', true), 'managed-bookmarks');
    assert.equal(browserRootKindForFolderRole('bookmarks-bar'), 'bookmarks_bar');
    assert.equal(browserRootKindForFolderRole('other-bookmarks'), 'other');
    assert.equal(browserRootKindForFolderRole('mobile-bookmarks'), 'mobile');
    assert.equal(isWritableMountRole('managed-bookmarks'), false);
    assert.equal(customSourceKeyForFolder('folder-9'), 'folder:folder-9');
  });

  test.each(['工作区', 'Workspaces', '作業スペース', 'Renamed container'])('excludes the %s container from sync even with stale selections', async title => {
    const raw = workspaceFolderTree(title);
    const before = structuredClone(raw);
    const { roots } = await createChromeBookmarkTreeAdapter(fixtureApi(raw)).read();
    assert.deepEqual(roots.map(root => [root.nativeId, root.rootKind]), [['1', 'bookmarks_bar'], ['2', 'other']]);
    assert.equal(roots[0]?.children.find(child => child.nativeId === 'user-workspace')?.title, title);
    const selectedNativeIds = ['1', '2', 'workspaces', 'project', 'workspace-folder'];
    const scan = scanBoundary({ roots, selectedNativeIds });
    assert.deepEqual(scan.selectedNativeIds, ['1', '2']);
    assert.equal(scan.bookmarkCount, 0);
    assert.deepEqual(scan.mounts.map(mount => mount.nativeRootId), ['1', '2']);
    assert.equal(scan.classifications.has('workspace-bookmark'), false);
    assert.deepEqual(localFactsFromRoots(roots, selectedNativeIds).map(fact => fact.nativeId), ['a', 'user-workspace', 'b']);
    assert.deepEqual(raw, before);
  });

  test('legacy root roles follow reserved ids through reordered, missing and extra browser containers', async () => {
    const { roots } = await createChromeBookmarkTreeAdapter(fixtureApi([node('0', '', [
      node('workspaces', 'Anything', [node('project', 'Project')]),
      node('3', 'Workspaces'), node('managed', 'Policy', [], { unmodifiable: 'managed' }),
      node('2', 'Workspaces'), node('unknown', 'Bookmarks bar'),
    ])])).read();
    assert.deepEqual(roots.map(root => [root.nativeId, root.rootKind]), [
      ['3', 'mobile'], ['managed', 'browser_root'], ['2', 'other'],
    ]);
  });

  test('explicit unsupported types cannot borrow reserved native ids or standard-root positions', async () => {
    const { roots } = await createChromeBookmarkTreeAdapter(fixtureApi([node('0', '', [
      node('1', 'Bookmarks bar', [], { folderType: 'workspace' }),
      node('2', 'Other bookmarks', [], { folderType: 'unknown-browser-container' }),
      node('403', 'Workspaces', [], { folderType: 'mobile' }),
    ])])).read();
    assert.deepEqual(roots.map(root => [root.nativeId, root.rootKind]), [['403', 'mobile']]);
  });
});

describe('P3-29 atomic root authority and privacy', () => {
  let indexedDB: IDBFactory;
  beforeEach(() => { indexedDB = new IDBFactory(); });

  test('normalizes overlapping roots and never silently selects children when a parent is removed', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    const first = await store.configureBrowserRoots(scope, {
      discovered: [{ nativeId: 'p', ancestorNativeIds: [] }, { nativeId: 'c', ancestorNativeIds: ['p'] }],
      selectedNativeIds: ['p', 'c'], privateNativeIds: [], status: 'ready',
    });
    assert.equal(first.selectedRoots.length, 1);
    const second = await store.configureBrowserRoots(scope, {
      discovered: [{ nativeId: 'p', ancestorNativeIds: [] }, { nativeId: 'c', ancestorNativeIds: ['p'] }],
      selectedNativeIds: [], privateNativeIds: [], status: 'ready',
    });
    assert.deepEqual(second.selectedRoots, []);
  });

  test('keeps rename identity, marks deletion/native-ID replacement missing and never guesses a rebind', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    const configured = await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'native-a', ancestorNativeIds: [] }],
      selectedNativeIds: ['native-a'], privateNativeIds: [], status: 'ready' });
    const renamed = await store.reconcileBrowserRoots(scope, [{ nativeId: 'native-a', ancestorNativeIds: [] }]);
    assert.deepEqual(renamed.selectedRoots, configured.selectedRoots);
    const missing = await store.reconcileBrowserRoots(scope, [{ nativeId: 'native-b', ancestorNativeIds: [] }]);
    assert.equal(missing.rootStatus, 'root_missing');
    assert.deepEqual(missing.selectedRoots, configured.selectedRoots);
    assert.equal((await store.listMappings(scope)).some((item) => item.nativeId === 'native-b'), false);
  });

  test('preserves selection, private boundaries and mappings across revoke and recovers only the same native identity', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    const configured = await store.configureBrowserRoots(scope, { discovered: [
      { nativeId: 'selected-native', ancestorNativeIds: [] },
      { nativeId: 'private-native', ancestorNativeIds: ['selected-native'] },
    ], selectedNativeIds: ['selected-native'], privateNativeIds: ['private-native'], status: 'ready' });
    const mappings = await store.listMappings(scope);
    const revoked = await store.setBrowserRootStatus(scope, 'permission_required');
    assert.deepEqual(revoked.selectedRoots, configured.selectedRoots);
    assert.deepEqual(revoked.privateRoots, configured.privateRoots);
    assert.deepEqual(await store.listMappings(scope), mappings);
    const recovered = await store.reconcileBrowserRoots(scope, [
      { nativeId: 'selected-native', ancestorNativeIds: [] },
      { nativeId: 'private-native', ancestorNativeIds: ['selected-native'] },
    ]);
    assert.equal(recovered.rootStatus, 'ready');
    assert.deepEqual(recovered.selectedRoots, configured.selectedRoots);
    assert.deepEqual(recovered.privateRoots, configured.privateRoots);
    await store.setBrowserRootStatus(scope, 'permission_required');
    const missing = await store.reconcileBrowserRoots(scope, [
      { nativeId: 'replacement-native', ancestorNativeIds: [] },
    ]);
    assert.equal(missing.rootStatus, 'root_missing');
    assert.deepEqual(missing.selectedRoots, configured.selectedRoots);
    assert.deepEqual(missing.privateRoots, configured.privateRoots);
    assert.equal((await store.listMappings(scope)).some((mapping) => mapping.nativeId === 'replacement-native'), false);
  });

  test('renormalizes explicit boundaries when a tree move makes one selected root contain another', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    const configured = await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'a', ancestorNativeIds: [] },
      { nativeId: 'b', ancestorNativeIds: [] }], selectedNativeIds: ['a', 'b'], privateNativeIds: [], status: 'ready' });
    assert.equal(configured.selectedRoots.length, 2);
    const moved = await store.reconcileBrowserRoots(scope, [{ nativeId: 'a', ancestorNativeIds: [] },
      { nativeId: 'b', ancestorNativeIds: ['a'] }]);
    assert.equal(moved.rootStatus, 'nested_normalized');
    assert.equal(moved.selectedRoots.length, 1);
  });

  test('atomically writes selection, private rules and cryptographic bidirectional mappings per complete scope', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    const configured = await store.configureBrowserRoots(scope, { discovered: [
      { nativeId: 'same-native', ancestorNativeIds: [] }, { nativeId: 'private-child', ancestorNativeIds: ['same-native'] }],
      selectedNativeIds: ['same-native'], privateNativeIds: ['private-child'], status: 'ready' });
    const mapping = await store.getMappingByNativeId(scope, 'same-native');
    assert.match(mapping!.colpId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
    assert.equal((await store.getMappingByColpId(scope, mapping!.colpId))?.nativeId, 'same-native');
    assert.equal(configured.privateRoots.length, 1);
    const isolated = { ...scope, browserProfileId: 'profile-b', replicaId: 'replica-b' };
    await active(store, isolated);
    await store.configureBrowserRoots(isolated, { discovered: [{ nativeId: 'same-native', ancestorNativeIds: [] }],
      selectedNativeIds: ['same-native'], privateNativeIds: [], status: 'ready' });
    assert.notEqual((await store.getMappingByNativeId(isolated, 'same-native'))?.colpId, mapping!.colpId);
  });

  test('aborts mapping and boundary replacement together at the transaction fault point', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    const initial = await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'parent', ancestorNativeIds: [] },
      { nativeId: 'child', ancestorNativeIds: ['parent'] }], selectedNativeIds: ['parent'], privateNativeIds: [], status: 'ready' });
    await assert.rejects(() => store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'parent', ancestorNativeIds: [] },
      { nativeId: 'child', ancestorNativeIds: ['parent'] }], selectedNativeIds: ['child'], privateNativeIds: [], status: 'ready' },
    { fault: 'after_mapping' }), /fault_injected/);
    assert.deepEqual((await store.getScope(scope))?.selectedRoots, initial.selectedRoots);
    assert.equal(await store.getMappingByNativeId(scope, 'child'), null);
  });

  test('private wins and unknown/missing/corrupt inputs fail closed before operation construction', () => {
    assert.deepEqual(decideLocalPrivacy({ rootStatus: 'ready', mapped: true, selected: true, privateLocal: false }),
      { allowOperationCandidate: true, reason: 'selected' });
    assert.deepEqual(decideLocalPrivacy({ rootStatus: 'ready', mapped: true, selected: true, privateLocal: false,
      managed: true }), { allowOperationCandidate: false, reason: 'managed' });
    for (const input of [
      { rootStatus: 'ready', mapped: true, selected: true, privateLocal: true },
      { rootStatus: 'ready', mapped: true, selected: false, privateLocal: false },
      { rootStatus: 'root_missing', mapped: true, selected: true, privateLocal: false },
      { rootStatus: 'corrupt', mapped: false, selected: true, privateLocal: false },
      null, undefined,
    ]) assert.equal(decideLocalPrivacy(input as never).allowOperationCandidate, false);
  });
});

function fixtureApi(tree: any[], failure?: Error) {
  const calls: string[] = [];
  return { tree, calls,
    async getTree() { calls.push('getTree'); if (failure) throw failure; return tree; },
    async getChildren(id: string) { calls.push(`getChildren:${id}`); return find(tree, id)?.children ?? []; },
    async getSubTree(id: string) { calls.push(`getSubTree:${id}`); const value = find(tree, id); return value ? [value] : []; },
  };
}
function find(nodes: any[], id: string): any { for (const value of nodes) { if (value.id === id) return value;
  const child = find(value.children ?? [], id); if (child) return child; } return undefined; }
function allKinds(nodes: readonly { kind: string; children: readonly any[] }[]): string[] {
  return nodes.flatMap((value) => [value.kind, ...allKinds(value.children)]);
}
async function active(store: ReturnType<typeof createSyncStateStore>, value = scope) {
  await store.registerScope({ ...value, lifecycle: 'active', lease: { leaseId: `lease-${value.replicaId}`, expiresAt: 10_000 },
    checkpoint: null, selectedRoots: [] });
}
