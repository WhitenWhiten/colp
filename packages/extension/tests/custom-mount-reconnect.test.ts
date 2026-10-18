import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { matchLocalRemote, type LocalNodeFact, type RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { baseConfirm, customMount, installKns03IndexedDb, root, scope, setup } from './kns-03-bootstrap-harness.js';
import { createPullApplier } from '../src/pull-applier.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns03IndexedDb();

const folder: LocalNodeFact = { nativeId: 'local-ai', mountNativeRootId: 'local-ai',
  parentNativeId: null, kind: 'folder', title: 'AI' };
const nested: LocalNodeFact = { nativeId: 'local-nested', mountNativeRootId: folder.nativeId,
  parentNativeId: folder.nativeId, kind: 'folder', title: 'Tools' };
const child: LocalNodeFact = { nativeId: 'local-child', mountNativeRootId: folder.nativeId,
  parentNativeId: nested.nativeId, kind: 'bookmark', title: 'Doc', url: 'https://example.test/doc' };
const remoteFolder: RemoteNodeFact = { nodeId: 'remote-ai', parentId: root.nodeId, kind: 'folder',
  title: 'AI', folderRole: 'custom', revision: 'r1' };
const remoteNested: RemoteNodeFact = { nodeId: 'remote-nested', parentId: remoteFolder.nodeId,
  kind: 'folder', title: nested.title, revision: 'r2' };
const remoteChild: RemoteNodeFact = { nodeId: 'remote-child', parentId: remoteNested.nodeId,
  kind: 'bookmark', title: child.title, url: child.url, revision: 'r3' };
const input = () => baseConfirm({ mounts: [customMount(folder.nativeId, 'folder:1342')],
  localFacts: [child, nested, folder], remoteFacts: [root, remoteFolder, remoteNested, remoteChild] });
const match = (extra: Partial<Parameters<typeof matchLocalRemote>[0]> = {}) => {
  const facts = input();
  return matchLocalRemote({ scopeKey: 'reconnect', confirmationId: facts.confirmationId,
    local: facts.localFacts, remote: facts.remoteFacts!, mappings: [], mounts: facts.mounts,
    rootNodeId: root.nodeId, bootstrapMode: 'merge', ...extra });
};

test('a fresh replica reuses a unique custom root and its nested bookmarks in parent order', async () => {
  const { store, coordinator } = await setup();
  const view = await coordinator.confirm(input());
  assert.deepEqual(view.report?.matched, [
    { nativeId: folder.nativeId, nodeId: remoteFolder.nodeId },
    { nativeId: nested.nativeId, nodeId: remoteNested.nodeId },
    { nativeId: child.nativeId, nodeId: remoteChild.nodeId },
  ]);
  assert.deepEqual(await store.listQueue(scope), []);
  assert.equal(view.run.phase, 'completed');
  const mount = (await store.listMountBindings(scope))[0]!;
  assert.equal(mount.status, 'active');
  assert.equal(mount.remoteMountNodeId, remoteFolder.nodeId);
  assert.equal((await store.getMappingByNativeId(scope, child.nativeId))?.parentColpId, remoteNested.nodeId);
  await coordinator.confirm(input());
  assert.deepEqual(await store.listQueue(scope), []);
});

test('preview proposes custom-root reuse without persisting mappings or bindings', async () => {
  const { store, coordinator } = await setup();
  const view = await coordinator.confirm({ ...input(), previewOnly: true });
  assert.equal(view.report?.matched.length, 3);
  assert.deepEqual(await store.listMappings(scope), []);
  assert.deepEqual(await store.listMountBindings(scope), []);
});

test('independently selected custom roots pair one-to-one by title', () => {
  const ero = { ...folder, nativeId: 'local-ero', mountNativeRootId: 'local-ero', title: 'Ero' };
  const report = match({ local: [folder, ero], remote: [root, remoteFolder,
    { ...remoteFolder, nodeId: 'remote-ero', title: 'Ero' }],
  mounts: [...input().mounts, customMount(ero.nativeId, 'folder:545')] });
  assert.equal(report.matched.length, 2);
  assert.deepEqual(report.planned, []);
});

test('an existing root binding survives rename and wins over a same-title candidate', () => {
  const report = match({ mounts: [customMount(folder.nativeId, 'folder:1342', remoteFolder.nodeId)],
    remote: [root, { ...remoteFolder, title: 'Cloud title' }, remoteNested, remoteChild,
      { ...remoteFolder, nodeId: 'unrelated-ai' }] });
  assert.equal(report.matched.find(row => row.nativeId === folder.nativeId)?.nodeId, remoteFolder.nodeId);
  assert.equal(report.matched.length, 3);
  assert.deepEqual(report.planned, []);
});

test('a persisted identity wins over a conflicting mount hint and structural candidate', () => {
  const report = match({ mappings: [{ nativeId: folder.nativeId, colpId: remoteFolder.nodeId }],
    mounts: [customMount(folder.nativeId, 'folder:1342', 'unrelated-ai')],
    remote: [root, { ...remoteFolder, title: 'Cloud title' }, { ...remoteFolder, nodeId: 'unrelated-ai' }] });
  assert.deepEqual(report.matched, [{ nativeId: folder.nativeId, nodeId: remoteFolder.nodeId }]);
});

test('ambiguous remote custom roots are never selected arbitrarily', () => {
  const report = match({ remote: [root, remoteFolder, { ...remoteFolder, nodeId: 'other-ai' }] });
  assert.equal(report.matched.some(row => row.nativeId === folder.nativeId), false);
});

test('same-title local custom roots are kept distinct', () => {
  const other = { ...folder, nativeId: 'other-local', mountNativeRootId: 'other-local' };
  const report = match({ local: [folder, other], remote: [root, remoteFolder],
    mounts: [...input().mounts, customMount(other.nativeId, 'folder:other')] });
  assert.deepEqual(report.matched, []);
  assert.equal(report.planned.filter(op => op.reason === 'mount-resolve').length, 2);
});

test('adding a folder does not flag pre-existing cloud-only duplicates as needing a decision', () => {
  const report = match({ remote: [root, remoteFolder, remoteNested, remoteChild,
    { ...remoteFolder, nodeId: 'existing-mount', title: 'Existing' },
    { ...remoteNested, nodeId: 'existing-subfolder', parentId: 'existing-mount' },
    { ...remoteChild, nodeId: 'existing-a', parentId: 'existing-mount', url: 'https://example.test/existing' },
    { ...remoteChild, nodeId: 'existing-b', parentId: 'existing-subfolder', url: 'https://example.test/existing' },
  ] });
  assert.deepEqual(report.candidates, []);
  assert.deepEqual(report.planned, []);
});

for (const extra of [{ parentId: 'another-root' }, { folderRole: 'bookmarks-bar' },
  { folderRole: undefined }, { managed: true }, { privateLocal: true }]) {
  test(`custom-root merge does not adopt an ineligible candidate: ${JSON.stringify(extra)}`, () => {
    assert.deepEqual(match({ remote: [root, { ...remoteFolder, ...extra }] }).matched, []);
  });
}

for (const prefix of ['unmounted:', 'recovery:']) {
  test(`deleting an old duplicate subtree leaves current native bookmarks intact (${prefix})`, async () => {
    const { store, coordinator } = await setup();
    await coordinator.confirm(input());
    const api = honestChrome();
    api.seed({ id: folder.nativeId, title: folder.title, parentId: folder.parentNativeId, index: 0 });
    api.seed({ id: nested.nativeId, title: nested.title, parentId: folder.nativeId, index: 0 });
    api.seed({ id: child.nativeId, title: child.title, url: child.url, parentId: nested.nativeId, index: 0 });
    const before = structuredClone(api.all());
    for (const [colpId, parentColpId, kind] of [
      ['root-colp', null, 'folder'], ['old-ai', 'root-colp', 'folder'],
      ['old-nested', 'old-ai', 'folder'], ['old-child', 'old-nested', 'bookmark'],
    ] as const) {
      await store.putMapping(scope, { nativeId: `${prefix}${colpId}`, colpId,
        rootNativeId: `${prefix}old-ai`, nodeKind: kind, ...(parentColpId ? { parentColpId } : {}),
        projection: { revision: 'revision-old', digest: `sha256:${colpId}`,
          content: { title: colpId, ...(colpId === 'old-ai' ? { folderRole: 'custom' } : {}) } } });
    }
    const applier = createPullApplier({ store, scope, api,
      session: { acceptedProtocolVersion: '0.2', sessionId: 'cleanup-session', collectionId: scope.collectionId,
        conversionPolicy: { separator: 'preserve_remote' } },
      effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
      effectPageAuthority: 'https://known.example' });
    await applier.stage(pullFixtures.page({ events: [pullFixtures.subtreeEvent({ sequence: 1,
      collectionId: scope.collectionId, targetId: 'old-ai', members: ['old-ai', 'old-nested', 'old-child'], paged: false })],
    nextCursor: 'cleanup-cursor', collectionRevision: 'cleanup-revision' }));
    await applier.resume();
    assert.deepEqual(api.all(), before);
    assert.equal(api.calls.length, 0);
    assert.equal((await store.getMappingByNativeId(scope, child.nativeId))?.colpId, remoteChild.nodeId);
    assert.equal((await store.listMountBindings(scope))[0]?.remoteMountNodeId, remoteFolder.nodeId);
    assert.equal((await store.exportScope(scope)).pullPages[0]?.state, 'page_complete');
  });
}
