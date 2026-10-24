import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase, sourceKey, SOURCE_STORES } from '../src/site-adapters/source-db.js';
import { cursorPage } from '../src/sync-state/idb.js';
import { exportSourceDiagnostic, diagnosticSummary } from '../src/site-adapters/repair.js';
import { adapterBrowserSupport } from '../src/site-adapters/browser-support.js';
import { assertSourceRebound, assertRestoredItemAvailable, createSourceRebinder, exportPortableSources, parsePortableSources, restorePortableSources, type PortableSources } from '../src/site-adapters/portable.js';
import type { SourceMount, LayoutNativeNode } from '../src/site-adapters/layout.js';
import type { SourceAuthority } from '../src/site-adapters/ledger-types.js';
import { parseLocalBackup } from '../src/local-backup/codec.js';

test('unknown future source schema exports read only, including unknown commands; no reset or partial encoding', async () => {
  const factory = new IDBFactory();
  const db = await new Promise<IDBDatabase>(resolve => { const r = factory.open('future', 8);
    r.onupgradeneeded = () => { r.result.createObjectStore('futureStore').put({ commandId: 'keep', state: 'unknown' }, 'original'); };
    r.onsuccess = () => resolve(r.result); }); db.close();
  const normal = createSourceDatabase(factory, 'future'); await expect(normal.open()).rejects.toThrow('schemaIncompatible');
  const exported = await exportSourceDiagnostic(factory, 'future');
  expect(exported.schemaVersion).toBe(8); expect(exported.stores[0]?.records).toEqual([{ key: 'original', value: { commandId: 'keep', state: 'unknown' } }]);
  expect(diagnosticSummary(exported)).toMatchObject({ supportedSchema: false, attention: [{ key: 'original', state: 'unknown' }] });
  expect(await exportSourceDiagnostic(factory, 'future')).toEqual(exported);
  const opened = await new Promise<IDBDatabase>(resolve => { const r = factory.open('future'); r.onsuccess = () => resolve(r.result); });
  await new Promise<void>(resolve => { const tx = opened.transaction('futureStore', 'readwrite'); tx.objectStore('futureStore').put(new Map([['x', 1]]), 'unsupported'); tx.oncomplete = () => resolve(); }); opened.close();
  await expect(exportSourceDiagnostic(factory, 'future')).rejects.toThrow('diagnosticEncodingUnsupported');
});
test('diagnostic of missing database never initializes an old schema and browser range is explicit', async () => {
  const factory = new IDBFactory(); expect((await exportSourceDiagnostic(factory, 'missing')).schemaVersion).toBe(0);
  expect(await factory.databases()).toEqual([]);
  for (const major of [121, 133, 134, 135, 138, 148]) expect(adapterBrowserSupport(`Chrome/${major}.0.0.0`).supported).toBe(false);
  expect(adapterBrowserSupport('Chrome/149.0.7827.0').supported).toBe(true);
  expect(adapterBrowserSupport('Chrome/154.0.0.0').supported).toBe(true);
  expect(adapterBrowserSupport('Firefox/160.0').supported).toBe(false);
});
test('diagnostics preserve undefined and date values with unambiguous path metadata', async () => {
  const factory = new IDBFactory(), db = createSourceDatabase(factory, 'values');
  await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put({ state: 'blocked', reason: undefined, at: new Date(1), nested: [undefined, null] }, 'special'); });
  await db.close();
  const diagnostic = await exportSourceDiagnostic(factory, 'values'), row = diagnostic.stores.find(s => s.name === 'meta')!.records[0]!;
  expect(row.value).toEqual({ state: 'blocked', reason: null, at: new Date(1).toISOString(), nested: [null, null] });
  expect(row.specialValues).toEqual([{ path: ['value', 'reason'], type: 'undefined' }, { path: ['value', 'at'], type: 'date' }, { path: ['value', 'nested', 0], type: 'undefined' }]);
  expect(diagnosticSummary(diagnostic).attention[0]?.state).toBe('blocked');
});
const portable = (): PortableSources => ({ version: 1, connections: [{ ref: 'foreign-connection', accountId: '7', identityVersion: 1, copies: 'sourceAndSemantic',
  mounts: [{ ref: 'foreign-mount', rootSourceId: 'oldRoot', aiDestination: 'excluded', folders: [{ collectionId: '101', nativeSourceId: 'oldFolder', state: 'confirmed' }] }],
  associations: [{ itemId: 'video:av:1', collectionId: '101', mountRef: 'foreign-mount', purpose: 'sourceArchive', nativeSourceId: 'oldBookmark', state: 'active' }] }] });
async function restored() {
  const db = createSourceDatabase(new IDBFactory(), crypto.randomUUID());
  const authority: SourceAuthority = { enabled: true, accountId: '7', connectionId: 'new-connection', installationGeneration: 3, sourceSessionGeneration: 4, negativeReadback: false };
  const mount: SourceMount = { id: 'new-mount', connectionId: 'new-connection', rootRuleId: 'new-rule', revision: 1, aiDestination: 'excluded', state: 'active',
    root: { bindingId: 'new-proof', nativeId: 'newRoot', deviceId: 'new-device', dateAdded: 11, kind: 'folder', proof: { kind: 'explicitAdoption', id: 'new-root-adoption' } } };
  const nodes = new Map<string, LayoutNativeNode>([['newRoot', { id: 'newRoot', title: 'Root', parentId: '1', dateAdded: 11 }],
    ['newFolder', { id: 'newFolder', title: 'B', parentId: 'newRoot', dateAdded: 12 }], ['newBookmark', { id: 'newBookmark', title: 'Video', parentId: 'newFolder', dateAdded: 13, url: 'https://www.bilibili.com/video/av1' }]]);
  await db.transaction(['authorities', 'mounts', 'connections'], 'readwrite', async tx => { tx.objectStore('authorities').put(authority, 'bundled.bilibili'); tx.objectStore('connections').put({ id: 'new-connection', accountId: '7', siteKey: 'bilibili', identityVersion: 1 }, sourceKey('bilibili', '7')); tx.objectStore('mounts').put(mount, sourceKey(mount.connectionId, mount.rootRuleId)); });
  const mapping = new Map([['oldRoot', 'newRoot'], ['oldFolder', 'newFolder'], ['oldBookmark', 'newBookmark']]);
  await restorePortableSources(db, 'restore', portable(), mapping);
  const rebinder = createSourceRebinder(db, { authority: async () => authority, mount: async () => mount, lookup: async id => nodes.get(id) ?? null, deviceId: async () => 'new-device' });
  return { db, authority, mount, mapping, nodes, rebinder };
}
test('foreign backup remains inert and idempotent; matching account/root preview adopts only new native proof with zero writes', async () => {
  const f = await restored(); try {
    await restorePortableSources(f.db, 'restore', portable(), f.mapping);
    const repeated = await exportPortableSources(f.db, new Set(['newRoot', 'newFolder', 'newBookmark']));
    expect(repeated?.connections[0]?.mounts[0]?.rootSourceId).toBe('newRoot');
    expect(repeated?.connections.flatMap(c => c.associations)[0]?.nativeSourceId).toBe('newBookmark');
    await expect(assertSourceRebound(f.db, 'new-connection')).rejects.toThrow('sourceRestoreRebindRequired');
    expect((await exportSourceDiagnosticFromDb(f.db)).stores.find(s => s.name === 'outbox')?.records).toEqual([]);
    const p = await f.rebinder.preview('restore', 'foreign-connection', 'foreign-mount'); expect(p.review).toEqual([]);
    expect(await f.rebinder.approve('restore', 'foreign-connection', 'foreign-mount', p.digest)).toEqual({ adopted: 1, nativeWrites: 0 });
    await assertSourceRebound(f.db, 'new-connection');
    const diagnostic = await exportSourceDiagnosticFromDb(f.db), rep = diagnostic.stores.find(s => s.name === 'representations')?.records[0]?.value;
    expect(rep).toMatchObject({ connectionId: 'new-connection', mountId: 'new-mount', native: { nativeId: 'newBookmark', deviceId: 'new-device', dateAdded: 13, proof: { kind: 'explicitAdoption' } } });
    expect(JSON.stringify(rep)).not.toContain('foreign');
    await f.db.transaction(['connections'], 'readwrite', async tx => { tx.objectStore('connections').put({ id: 'new-connection', accountId: '7', siteKey: 'bilibili', identityVersion: 1 }, sourceKey('bilibili', '7')); });
    const exported = await exportPortableSources(f.db, new Set(['newRoot', 'newFolder', 'newBookmark']));
    expect(exported?.connections).toHaveLength(1);
    expect(exported?.connections[0]?.associations[0]?.nativeSourceId).toBe('newBookmark');
    expect(JSON.stringify(exported)).not.toMatch(/deviceId|dateAdded|explicitAdoption|commandId/);
  } finally { await f.db.close(); }
});
async function exportSourceDiagnosticFromDb(db: ReturnType<typeof createSourceDatabase>) {
  return { stores: await Promise.all(SOURCE_STORES.map(async name => ({ name, records: (await db.transaction([name], 'readonly', tx => cursorPage<unknown>(tx.objectStore(name), null, 100))).map(value => ({ value })) }))) };
}
test('account, native date, root, semantic/suppression and stale preview require review rather than guessed adoption', async () => {
  const f = await restored(); try {
    const p = await f.rebinder.preview('restore', 'foreign-connection', 'foreign-mount');
    f.nodes.get('newBookmark')!.parentId = 'manual';
    await expect(f.rebinder.approve('restore', 'foreign-connection', 'foreign-mount', p.digest)).rejects.toThrow('sourceRestorePreviewStale');
    const changed = await f.rebinder.preview('restore', 'foreign-connection', 'foreign-mount'); expect(changed.review.length).toBe(1);
    await expect(f.rebinder.approve('restore', 'foreign-connection', 'foreign-mount', changed.digest)).rejects.toThrow('sourceRestoreManualReviewRequired');
    f.authority.accountId = '8'; await expect(f.rebinder.preview('restore', 'foreign-connection', 'foreign-mount')).rejects.toThrow('sourceRestoreAccountOrRootRequired');
    f.authority.accountId = '7'; f.mount.root.dateAdded = null; await expect(f.rebinder.preview('restore', 'foreign-connection', 'foreign-mount')).rejects.toThrow('bindingNeedsRebind');
    await expect(assertSourceRebound(f.db, 'new-connection')).rejects.toThrow('sourceRestoreRebindRequired');
  } finally { await f.db.close(); }
});
test('portable schema rejects credentials, outbox and unknown identity and is retained by strict bookmark backup codec', async () => {
  const p = portable();
  expect(() => parsePortableSources({ ...p, outbox: [] })).toThrow('sourceBackupInvalid');
  expect(() => parsePortableSources({ ...p, connections: [{ ...p.connections[0], identityVersion: 2 }] })).toThrow('sourceBackupInvalid');
  const backup = parseLocalBackup({ format: 'known-browser-backup', version: 1, exportedAt: 1, nodes: [], history: [], preferences: {}, language: 'en', defaultFolderSourceId: null, aiConfig: null, siteAdapters: p });
  expect(backup.siteAdapters).toEqual(p);
  const f = await restored(); try {
    await f.db.transaction(['connections', 'representations', 'mounts', 'folderReservations'], 'readwrite', async tx => {
      tx.objectStore('connections').put({ id: 'source', siteKey: 'bilibili', accountId: '7', identityVersion: 1 }, 'key');
      tx.objectStore('mounts').clear();
    });
    const exported = await exportPortableSources(f.db, new Set());
    expect(exported?.connections[0]?.accountId).toBe('7');
    for (const forbidden of ['deviceId', 'sourceGeneration', 'outbox', 'capability', 'lease']) expect(JSON.stringify(exported)).not.toContain(forbidden);
  } finally { await f.db.close(); }
});
test('explicitly retaining unresolved restored scope blocks its items and collections without blocking independent work', async () => {
  const f = await restored(); try {
    const p = await f.rebinder.reviewBlocked('restore', 'foreign-connection');
    await expect(f.rebinder.retainBlocked('restore', 'foreign-connection', 'wrong')).rejects.toThrow('sourceRestorePreviewStale');
    expect(await f.rebinder.retainBlocked('restore', 'foreign-connection', p.digest)).toEqual({ state: 'blocked', nativeWrites: 0 });
    await assertSourceRebound(f.db, 'new-connection');
    await expect(assertRestoredItemAvailable(f.db, 'new-connection', 'video:av:1')).rejects.toThrow('sourceRestoredCopyNeedsReview');
    await expect(assertRestoredItemAvailable(f.db, 'new-connection', 'video:av:2', '101')).rejects.toThrow('sourceRestoredCopyNeedsReview');
    await assertRestoredItemAvailable(f.db, 'new-connection', 'video:av:2', '102');
    await assertRestoredItemAvailable(f.db, 'other-connection', 'video:av:1', '101');
  } finally { await f.db.close(); }
});
