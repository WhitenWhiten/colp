import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { materializeIndependentSubtree } from '../src/pull-range-materialize.js';
import { materializeUnmountedRejoinMembers } from '../src/scope-rejoin-materialize.js';
import { projectVirtualSnapshotChildren } from '../src/recovery-projection-executor.js';
import { PullChromeUrlRejected } from '../src/pull-projection.js';
import { repairUnmountedRangeMappings } from '../src/unmounted-range-repair.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { fakeChrome } from './recovery-projection-chrome-fixture.js';
import { indexedDB, installKns05IndexedDb, nativeOrUndefined, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

type CreateInput = { parentId?: string; index?: number; title?: string; url?: string };

function captureCreates(api: { create(input: CreateInput): Promise<{ readonly id: string }> }): CreateInput[] {
  const inputs: CreateInput[] = [];
  const create = api.create.bind(api);
  api.create = async (input) => { inputs.push(input); return create(input); };
  return inputs;
}

function urlsOf(inputs: readonly CreateInput[]): string {
  return JSON.stringify(inputs.map((input) => input.url));
}

test('independent materialize does not pass file urls to chrome create; https, folders and empty urls still do', async () => {
  const fixture = await setup();
  const inputs = captureCreates(fixture.api);
  fixture.api.seed({ id: 'dest-root', parentId: 'native-root', index: 2, title: 'Moved' });
  const parent: MappingInput = {
    nativeId: 'native-root', colpId: 'root-colp', rootNativeId: 'native-root', nodeKind: 'folder',
    projection: { revision: 'r-parent', digest: 'd-parent', content: { title: 'Root' } },
  };
  const moved: MappingInput = {
    nativeId: 'src-moved', colpId: 'moved', rootNativeId: 'native-root', nodeKind: 'folder', parentColpId: 'root-colp',
    projection: { revision: 'r-moved', digest: 'd-moved', content: { title: 'Moved' } },
  };
  const child = (nativeId: string, colpId: string, nodeKind: MappingInput['nodeKind'], content: MappingInput['projection']['content']): MappingInput => ({
    nativeId, colpId, rootNativeId: 'native-root', nodeKind, parentColpId: 'moved',
    projection: { revision: `r-${colpId}`, digest: `d-${colpId}`, content },
  });
  const event = {
    kind: 'operation',
    effect: {
      kind: 'node_moved', effectDigest: 'sha256:moved',
      node: { id: 'moved', kind: 'folder', title: 'Moved', revision: 'r-moved' },
      parentRevisions: [{ parentId: 'root-colp', childrenRevision: 'children-1' }],
    },
  } as unknown as Parameters<typeof materializeIndependentSubtree>[0]['event'];
  try {
    await assert.rejects(() => materializeIndependentSubtree({
      store: fixture.store, scope, api: fixture.api, event, eventId: 'evt-range', mapping: moved, parent,
      plan: { commandId: 'range-1', action: 'materialize_independent', sourceBoundaryVersion: '1', destBoundaryVersion: '1' },
      subtree: [
        moved,
        child('src-folder', 'folder', 'folder', { title: 'Folder' }),
        child('src-kept', 'kept', 'bookmark', { title: 'Kept', url: 'https://example.test/kept' }),
        child('src-empty', 'empty', 'bookmark', { title: 'Empty', url: '' }),
        child('src-sep', 'sep', 'separator', {}),
        child('src-file', 'file', 'bookmark', { title: 'Secret', url: 'file:///tmp/secret' }),
      ],
      now: 1, cursor: 'cursor-range', recoverCreated: async () => ({ result: 'applied_with_evidence', nativeId: 'dest-root' }),
      parentRevisionMapping: async () => parent, pause: {},
    }), (error: unknown) => error instanceof PullChromeUrlRejected && error.code === 'unsupported_url_scheme');
    assert.equal(urlsOf(inputs).includes('file:'), false);
    assert.equal(inputs.some((input) => input.url === 'https://example.test/kept'), true);
    assert.equal(inputs.find((input) => input.title === 'Folder')?.url, undefined);
    assert.equal(inputs.find((input) => input.title === 'Empty')?.url, '');
    assert.equal(inputs.some((input) => input.title === 'Secret'), false);
    assert.equal(fixture.api.all().some((node) => String(node.url).startsWith('file:')), false);
  } finally { fixture.store.close(); }
});

test('unmounted range repair and rejoin do not pass chrome or file urls to chrome create', async () => {
  const fixture = await setup();
  const inputs = captureCreates(fixture.api);
  await fixture.store.putMountBinding(scope, {
    mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: true, status: 'active', rootRole: 'bookmarks-bar',
  });
  const virtual = (colpId: string, nodeKind: MappingInput['nodeKind'], content: MappingInput['projection']['content']): MappingInput => ({
    nativeId: `unmounted:${colpId}`, colpId, rootNativeId: 'native-root', nodeKind,
    parentNativeId: 'native-root', parentColpId: 'root-colp',
    projection: { revision: `r-${colpId}`, digest: `d-${colpId}`, content },
  });
  try {
    await fixture.store.putMapping(scope, virtual('folder', 'folder', { title: 'Folder' }));
    await fixture.store.putMapping(scope, virtual('kept', 'bookmark', { title: 'Kept', url: 'https://example.test/kept' }));
    await fixture.store.putMapping(scope, virtual('empty', 'bookmark', { title: 'Empty', url: '' }));
    await fixture.store.putMapping(scope, virtual('sep', 'separator', { title: 'Sep' }));
    await fixture.store.putMapping(scope, virtual('file', 'bookmark', { title: 'Secret', url: 'file:///tmp/secret' }));
    await fixture.store.putMapping(scope, virtual('chrome', 'bookmark', { title: 'Settings', url: 'chrome://settings' }));
    const repair = await repairUnmountedRangeMappings(fixture.store, scope, fixture.api);
    assert.equal(repair.filled, 4);
    assert.equal(repair.attention, 2);
    assert.equal(urlsOf(inputs).includes('file:'), false);
    assert.equal(urlsOf(inputs).includes('chrome:'), false);
    assert.equal(inputs.some((input) => input.url === 'https://example.test/kept'), true);
    assert.equal(inputs.find((input) => input.title === 'Folder')?.url, undefined);
    assert.equal(inputs.find((input) => input.title === 'Empty')?.url, '');
    assert.equal((await fixture.store.getMappingByColpId(scope, 'file'))?.nativeId, 'unmounted:file');
    assert.equal((await fixture.store.getMappingByColpId(scope, 'chrome'))?.nativeId, 'unmounted:chrome');
    assert.equal((await fixture.store.getMappingByColpId(scope, 'sep'))?.nativeId, 'sidecar:sep');
    assert.equal(String((await fixture.store.getMappingByColpId(scope, 'kept'))?.nativeId).startsWith('unmounted:'), false);
    await fixture.store.deleteMapping(scope, 'unmounted:file');
    await fixture.store.deleteMapping(scope, 'unmounted:chrome');

    const rejoinInputs: CreateInput[] = [];
    const mount = await fixture.store.getMountBinding(scope, 'mount-bar');
    assert.ok(mount);
    await fixture.store.putMapping(scope, virtual('re-folder', 'folder', { title: 'ReFolder' }));
    await fixture.store.putMapping(scope, virtual('re-kept', 'bookmark', { title: 'ReKept', url: 'https://example.test/rejoined' }));
    await fixture.store.putMapping(scope, virtual('re-empty', 'bookmark', { title: 'ReEmpty', url: '' }));
    await fixture.store.putMapping(scope, virtual('re-file', 'bookmark', { title: 'ReSecret', url: 'file:///tmp/rejoin' }));
    await fixture.store.putMapping(scope, virtual('re-chrome', 'bookmark', { title: 'ReSettings', url: 'chrome://extensions' }));
    const rejoined = await materializeUnmountedRejoinMembers({
      store: fixture.store, scope, mount, getNative: (id) => nativeOrUndefined(fixture.api, id),
      getChildren: (id) => fixture.api.getChildren(id),
      createNative: async (input) => { rejoinInputs.push(input); return fixture.api.create(input); },
    }, await fixture.store.listMappings(scope));
    assert.equal(rejoined.applied, 3);
    assert.equal(rejoined.unknown, 2);
    assert.equal(urlsOf(rejoinInputs).includes('file:'), false);
    assert.equal(urlsOf(rejoinInputs).includes('chrome:'), false);
    assert.equal(rejoinInputs.some((input) => input.url === 'https://example.test/rejoined'), true);
    assert.equal(rejoinInputs.find((input) => input.title === 'ReFolder')?.url, undefined);
    assert.equal(rejoinInputs.find((input) => input.title === 'ReEmpty')?.url, '');
    assert.equal((await fixture.store.getMappingByColpId(scope, 're-file'))?.nativeId, 'unmounted:re-file');
    assert.equal((await fixture.store.getMappingByColpId(scope, 're-chrome'))?.nativeId, 'unmounted:re-chrome');
  } finally { fixture.store.close(); }
});

test('snapshot create does not pass file or chrome urls to chrome create and continues with https', async () => {
  const store = createSyncStateStore({ indexedDB });
  const snapshotScope: SyncScope = {
    environment: 'development', serverId: 'server-recovery', serverOrigin: 'https://known.example',
    accountId: 'account-recovery', browserProfileId: 'profile-recovery', collectionId: 'collection-recovery',
    replicaId: 'replica-recovery', generation: 1,
  };
  await store.registerScope({
    ...snapshotScope, lifecycle: 'active',
    lease: { leaseId: 'lease-recovery', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [], rootStatus: 'ready',
  });
  const chrome = fakeChrome([{ id: '1', title: 'Bookmarks bar' }]);
  const inputs = captureCreates(chrome.api);
  const row = (nativeId: string, colpId: string, nodeKind: MappingInput['nodeKind'], parentColpId: string | undefined,
    content: MappingInput['projection']['content'], rootRole?: MappingInput['rootRole']): MappingInput => ({
    nativeId, colpId, rootNativeId: nativeId === '1' ? '1' : 'recovery:root', nodeKind,
    ...(parentColpId ? { parentColpId } : {}), ...(rootRole ? { rootRole } : {}),
    projection: { revision: `r-${colpId}`, digest: `d-${colpId}`, content },
  });
  const bound: MappingInput[] = [
    row('recovery:root', 'root', 'folder', undefined, { title: '', folderRole: 'root' }),
    row('1', 'mount-bar', 'folder', 'root', { title: 'Bar', folderRole: 'bookmarks-bar' }, 'bookmarks-bar'),
    row('recovery:folder', 'folder', 'folder', 'mount-bar', { title: 'Folder' }),
    row('recovery:kept', 'kept', 'bookmark', 'mount-bar', { title: 'Kept', url: 'https://example.test/kept' }),
    row('recovery:empty', 'empty', 'bookmark', 'mount-bar', { title: 'Empty', url: '' }),
    row('recovery:sep', 'sep', 'separator', 'mount-bar', { title: 'Sep' }),
    row('recovery:file', 'file', 'bookmark', 'mount-bar', { title: 'Secret', url: 'file:///tmp/secret' }),
    row('recovery:chrome', 'chrome', 'bookmark', 'mount-bar', { title: 'Settings', url: 'chrome://settings' }),
  ];
  try {
    const projected = await projectVirtualSnapshotChildren({ scope: snapshotScope, store, api: chrome.api, bound });
    assert.equal(urlsOf(inputs).includes('file:'), false);
    assert.equal(urlsOf(inputs).includes('chrome:'), false);
    assert.equal(inputs.some((input) => input.url === 'https://example.test/kept'), true);
    assert.equal(inputs.find((input) => input.title === 'Folder')?.url, undefined);
    assert.equal(inputs.find((input) => input.title === 'Empty')?.url, undefined);
    assert.equal(inputs.some((input) => input.title === 'Sep'), false);
    assert.equal(projected.find((mapping) => mapping.colpId === 'file')?.nativeId, 'recovery:file');
    assert.equal(projected.find((mapping) => mapping.colpId === 'chrome')?.nativeId, 'recovery:chrome');
    assert.equal([...chrome.nodes.values()].some((node) => String(node.url).startsWith('file:') || String(node.url).startsWith('chrome:')), false);
    assert.deepEqual((await store.listLocalIssues(snapshotScope)).map((issue) => [issue.nativeId, issue.code]).sort(), [
      ['recovery:chrome', 'unsupported_url_scheme'],
      ['recovery:file', 'unsupported_url_scheme'],
    ]);
    const created = inputs.length;
    await projectVirtualSnapshotChildren({ scope: snapshotScope, store, api: chrome.api, bound: projected });
    assert.equal(inputs.length, created);
    assert.equal(urlsOf(inputs).includes('file:'), false);
    assert.equal(urlsOf(inputs).includes('chrome:'), false);
  } finally { store.close(); }
});
