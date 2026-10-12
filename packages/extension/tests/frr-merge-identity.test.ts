import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { barMount, baseConfirm, installKns03IndexedDb, root, scope, setup } from './kns-03-bootstrap-harness.js';
import type { LocalNodeFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';
import type { MappingInput, QueueOperation } from '../src/sync-state-store.js';

installKns03IndexedDb();

const remoteBar: RemoteNodeFact = {
  nodeId: 'remote-bar', parentId: root.nodeId, kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
  revision: 'r1',
};
const remoteBookmark: RemoteNodeFact = {
  nodeId: 'remote-bookmark', parentId: 'remote-bar', kind: 'bookmark', title: 'bm-1',
  url: 'https://example.com/one', revision: 'r2',
};

function queuePayloadType(row: QueueOperation): string | undefined {
  return typeof row.payload.type === 'string' ? row.payload.type : undefined;
}

function createCount(rows: readonly QueueOperation[]): number {
  return rows.filter((row) => queuePayloadType(row) === 'create_node').length;
}

test('R1: confirmed structural match must persist native identity', async () => {
  const { store, coordinator } = await setup();
  const view = await coordinator.confirm(baseConfirm({
    mounts: [barMount('remote-bar')],
    remoteFacts: [root, remoteBar, remoteBookmark],
  }));
  assert.ok(view.report?.matched.some((row) => row.nativeId === 'bm-1' && row.nodeId === 'remote-bookmark'));
  assert.equal(createCount(await store.listQueue(scope)), 0);
  const mapping = await store.getMappingByNativeId(scope, 'bm-1');
  assert.equal(mapping?.colpId, 'remote-bookmark');
  assert.equal(mapping?.parentNativeId, 'bar');
  assert.equal(mapping?.parentColpId, 'remote-bar');
  assert.equal(mapping?.rootNativeId, 'bar');
  assert.equal(mapping?.projection.revision, 'r2');
  assert.equal(mapping?.projection.content?.title, 'bm-1');
  assert.equal(mapping?.projection.content?.url, 'https://example.com/one');
});

test('R1: rematch does not duplicate a confirmed structural mapping', async () => {
  const { store, coordinator } = await setup();
  const input = baseConfirm({
    mounts: [barMount('remote-bar')],
    remoteFacts: [root, remoteBar, remoteBookmark],
  });
  await coordinator.confirm(input);
  const first = await store.getMappingByNativeId(scope, 'bm-1');
  await coordinator.confirm(input);
  const again = await store.getMappingByNativeId(scope, 'bm-1');
  assert.equal(again?.colpId, 'remote-bookmark');
  assert.equal(again?.colpId, first?.colpId);
  assert.equal((await store.listMappings(scope)).filter((row) => row.nativeId === 'bm-1').length, 1);
  assert.equal(createCount(await store.listQueue(scope)), 0);
});

test('existing mapping wins over structure and is not remapped', async () => {
  const { store, coordinator } = await setup();
  await store.putMapping(scope, liveMapping('native-map', 'bm-map', {
    title: 'Mapped', url: 'https://example.com/mapped',
  }));
  const local: LocalNodeFact = {
    nativeId: 'native-map', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
    title: 'Sidecar', url: 'https://example.com/side',
  };
  const view = await coordinator.confirm(baseConfirm({
    localFacts: [local],
    mounts: [barMount('remote-bar')],
    remoteFacts: [root, remoteBar,
      { nodeId: 'bm-map', parentId: 'remote-bar', kind: 'bookmark', title: 'Mapped',
        url: 'https://example.com/mapped', revision: 'r1' },
      { nodeId: 'bm-side', parentId: 'remote-bar', kind: 'bookmark', title: 'Sidecar',
        url: 'https://example.com/side', revision: 'r1' }],
  }));
  assert.deepEqual(view.report?.matched, [{ nativeId: 'native-map', nodeId: 'bm-map' }]);
  assert.equal((await store.getMappingByNativeId(scope, 'native-map'))?.colpId, 'bm-map');
  assert.equal(createCount(await store.listQueue(scope)), 0);
});

test('sidecar identity wins over structure and is persisted', async () => {
  const { store, coordinator } = await setup();
  const local: LocalNodeFact = {
    nativeId: 'native-map', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
    title: 'Mapped', url: 'https://example.com/mapped',
  };
  const view = await coordinator.confirm(baseConfirm({
    localFacts: [local],
    sidecars: [{ nativeId: 'native-map', colpId: 'bm-side' }],
    mounts: [barMount('remote-bar')],
    remoteFacts: [root, remoteBar,
      { nodeId: 'bm-map', parentId: 'remote-bar', kind: 'bookmark', title: 'Mapped',
        url: 'https://example.com/mapped', revision: 'r1' },
      { nodeId: 'bm-side', parentId: 'remote-bar', kind: 'bookmark', title: 'Sidecar',
        url: 'https://example.com/side', revision: 'r1' }],
  }));
  assert.deepEqual(view.report?.matched, [{ nativeId: 'native-map', nodeId: 'bm-side' }]);
  assert.equal((await store.getMappingByNativeId(scope, 'native-map'))?.colpId, 'bm-side');
  assert.equal(createCount(await store.listQueue(scope)), 0);
});

test('same-URL different parent stays a candidate and does not persist a mapping', async () => {
  const { store, coordinator } = await setup();
  const url = 'https://example.com/dup';
  const view = await coordinator.confirm(baseConfirm({
    localFacts: [{ nativeId: 'native-1', mountNativeRootId: 'bar', parentNativeId: 'folder-a',
      kind: 'bookmark', title: 'Doc', url }],
    mappings: [{ nativeId: 'folder-a', colpId: 'folder-a' }, { nativeId: 'folder-b', colpId: 'folder-b' }],
    mounts: [barMount('remote-bar')],
    remoteFacts: [root, remoteBar,
      { nodeId: 'folder-a', parentId: 'remote-bar', kind: 'folder', title: 'A', revision: 'r1' },
      { nodeId: 'folder-b', parentId: 'remote-bar', kind: 'folder', title: 'B', revision: 'r1' },
      { nodeId: 'bm-cloud', parentId: 'folder-b', kind: 'bookmark', title: 'Doc', url, revision: 'r2' }],
  }));
  assert.equal(view.report?.matched.some((row) => row.nativeId === 'native-1'), false);
  assert.ok(view.report?.candidates.some((row) => row.url === url
    && row.nodeIds.includes('native-1') && row.nodeIds.includes('bm-cloud')));
  assert.equal(view.report?.planned.some((op) => op.nativeId === 'native-1' && op.type === 'create_node'), true);
  assert.equal(await store.getMappingByNativeId(scope, 'native-1'), null);
});

test('parent-first folder match persists before the child mapping', async () => {
  const { store, coordinator } = await setup();
  const view = await coordinator.confirm(baseConfirm({
    localFacts: [
      { nativeId: 'folder-1', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'folder', title: 'Work' },
      { nativeId: 'bm-nested', mountNativeRootId: 'bar', parentNativeId: 'folder-1', kind: 'bookmark',
        title: 'Doc', url: 'https://example.test/doc' },
    ],
    mounts: [barMount('remote-bar')],
    remoteFacts: [root, remoteBar,
      { nodeId: 'work-colp', parentId: 'remote-bar', kind: 'folder', title: 'Work', revision: 'r2' },
      { nodeId: 'doc-colp', parentId: 'work-colp', kind: 'bookmark', title: 'Doc',
        url: 'https://example.test/doc', revision: 'r3' }],
  }));
  assert.ok(view.report?.matched.some((row) => row.nativeId === 'folder-1' && row.nodeId === 'work-colp'));
  assert.ok(view.report?.matched.some((row) => row.nativeId === 'bm-nested' && row.nodeId === 'doc-colp'));
  assert.equal(createCount(await store.listQueue(scope)), 0);
  const folder = await store.getMappingByNativeId(scope, 'folder-1');
  const child = await store.getMappingByNativeId(scope, 'bm-nested');
  assert.equal(folder?.colpId, 'work-colp');
  assert.equal(child?.colpId, 'doc-colp');
  assert.equal(child?.parentNativeId, 'folder-1');
  assert.equal(child?.parentColpId, 'work-colp');
});

test('structural match does not steal a live colpId', async () => {
  const { store, coordinator } = await setup();
  await store.putMapping(scope, liveMapping('other-native', 'remote-bookmark', {
    title: 'other', url: 'https://example.com/other',
  }));
  const view = await coordinator.confirm(baseConfirm({
    mappings: [],
    mounts: [barMount('remote-bar')],
    remoteFacts: [root, remoteBar, remoteBookmark],
  }));
  assert.ok(view.report?.matched.some((row) => row.nativeId === 'bm-1' && row.nodeId === 'remote-bookmark'));
  assert.equal((await store.getMappingByNativeId(scope, 'bm-1'))?.colpId, undefined);
  assert.equal((await store.getMappingByNativeId(scope, 'other-native'))?.colpId, 'remote-bookmark');
});

test('preview-only confirm does not persist a structural match', async () => {
  const { store, coordinator } = await setup();
  const view = await coordinator.confirm(baseConfirm({
    previewOnly: true,
    mounts: [barMount('remote-bar')],
    remoteFacts: [root, remoteBar, remoteBookmark],
  }));
  assert.ok(view.report?.matched.some((row) => row.nativeId === 'bm-1' && row.nodeId === 'remote-bookmark'));
  assert.equal(await store.getMappingByNativeId(scope, 'bm-1'), null);
  assert.equal((await store.listQueue(scope)).length, 0);
});

function liveMapping(nativeId: string, colpId: string, content: { title: string; url: string }): MappingInput {
  return {
    nativeId, colpId, rootNativeId: 'bar', nodeKind: 'bookmark', parentNativeId: 'bar', parentColpId: 'remote-bar',
    projection: { revision: 'r-live', digest: 'sha256:live', content },
  };
}
