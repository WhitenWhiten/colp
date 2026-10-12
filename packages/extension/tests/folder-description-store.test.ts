import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createFolderDescriptionStore, FOLDER_DESCRIPTION_MAX_BYTES } from '../src/folder-description-store.js';
import { readNativeFolderDescriptions, validFolderDescriptionNotice } from '../src/folder-description-native.js';
import { nativeClassificationFolders } from '../src/classification-local-taxonomy.js';

let factory: IDBFactory;
const stores: ReturnType<typeof createFolderDescriptionStore>[] = [];
const folder = { id: '10', dateAdded: 100 };
const binding = (description: string | null, revision = 'r1') => ({ scopeKey: 'scope-a', colpId: 'remote-folder', revision, description });
const store = () => { const result = createFolderDescriptionStore({ indexedDB: factory }); stores.push(result); return result; };
beforeEach(() => { factory = new IDBFactory(); vi.stubGlobal('indexedDB', factory); });
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.unstubAllGlobals(); });

test('descriptions remain usable signed out and after reopening the database', async () => {
  vi.stubGlobal('chrome', {});
  const first = store(); await first.save(folder, 'Developer tools and documentation'); first.close();
  const reopened = store(); expect((await reopened.get(folder))?.description).toBe('Developer tools and documentation');
  const tree = [{ id: '0', title: '', children: [{ id: '1', title: 'Bar', children: [{ ...folder, title: '工具' }] }] }];
  const descriptions = await readNativeFolderDescriptions(tree);
  expect(nativeClassificationFolders(tree, { excluded: new Set(), descriptions })[0]!.description).toBe('Developer tools and documentation');
});

test('native identity survives renames and moves, while a reused id with a different creation date gets no old description', async () => {
  const descriptions = store(); await descriptions.save(folder, 'My original scope');
  expect((await descriptions.get({ ...folder }))?.description).toBe('My original scope');
  expect(await descriptions.get({ ...folder, dateAdded: 200 })).toBeNull();
  await descriptions.save({ ...folder, dateAdded: 200 }, 'New folder');
  expect(await descriptions.get(folder)).toBeNull();
  await descriptions.remove(['10']); expect(await descriptions.get({ ...folder, dateAdded: 200 })).toBeNull();
});

test('cloud updates populate clean metadata but cannot overwrite an offline edit or resurrect a cleared description', async () => {
  const descriptions = store();
  await descriptions.observeRemote([{ folder, binding: binding('Cloud scope') }]);
  await descriptions.save(folder, 'Offline edit');
  await descriptions.observeRemote([{ folder, binding: binding('Later cloud edit', 'r2') }]);
  expect(await descriptions.get(folder)).toMatchObject({ description: 'Offline edit', state: 'dirty', remote: binding('Cloud scope') });
  await descriptions.save(folder, null);
  await descriptions.observeRemote([{ folder, binding: binding('Old cloud text', 'r3') }]);
  expect(await descriptions.get(folder)).toMatchObject({ description: null, state: 'dirty' });
  await descriptions.observeRemote([{ folder, binding: binding(null, 'r4') }]);
  expect(await descriptions.get(folder)).toMatchObject({ description: null, state: 'synced', remote: binding(null, 'r4') });
});

test('confirmation of an earlier local save advances the baseline while preserving a newer local draft', async () => {
  const descriptions = store(); await descriptions.observeRemote([{ folder, binding: binding('Before') }]);
  const sent = await descriptions.save(folder, 'First local save');
  await descriptions.markAttempt(folder, sent, binding('Before'));
  await descriptions.save(folder, 'Second local save');
  await descriptions.observeRemote([{ folder, binding: binding('First local save', 'r2') }]);
  expect(await descriptions.get(folder)).toMatchObject({ description: 'Second local save', state: 'dirty', remote: binding('First local save', 'r2') });
});

test('independent pages serialize writes and reject stale optional version checks', async () => {
  const first = store(), second = store();
  const result = await Promise.allSettled([first.save(folder, 'First', 0), second.save(folder, 'Second', 0)]);
  expect(result.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await first.get(folder))?.version).toBe(1);
});

test('another authority cannot automatically upload a folder description retained in this browser', async () => {
  const descriptions = store(); await descriptions.observeRemote([{ folder, binding: binding('Existing description') }]);
  await descriptions.observeRemote([{ folder, binding: { ...binding(null), scopeKey: 'new-scope', colpId: 'new-folder' } }]);
  expect(await descriptions.get(folder)).toMatchObject({ description: 'Existing description', state: 'synced',
    remote: binding('Existing description') });
});

test('empty cloud text confirms a local clear without a redundant update', async () => {
  const descriptions = store(); await descriptions.observeRemote([{ folder, binding: binding('Before') }]);
  await descriptions.save(folder, null); await descriptions.observeRemote([{ folder, binding: binding('', 'r2') }]);
  expect(await descriptions.get(folder)).toMatchObject({ description: null, state: 'synced' });
});

test('an attempted edit keeps its exact event identity across retries and browser restarts', async () => {
  const first = store(); await first.observeRemote([{ folder, binding: binding('Before') }]);
  const sent = await first.save(folder, 'Local save');
  const attempt = await first.markAttempt(folder, sent, binding('Before'));
  expect(attempt?.eventId).toBeTruthy(); first.close();
  const reopened = store();
  expect(await reopened.markAttempt(folder, sent, binding('Before'))).toEqual(attempt);
  const newer = await reopened.save(folder, 'Newer save');
  expect((await reopened.markAttempt(folder, newer, binding('Before')))?.eventId).not.toBe(attempt?.eventId);
});

test('UTF-8 bounds and native-only notification shape prevent invalid values from reaching sync', async () => {
  const descriptions = store(); await descriptions.save(folder, 'Valid');
  await expect(descriptions.save(folder, '中'.repeat(FOLDER_DESCRIPTION_MAX_BYTES))).rejects.toThrow('folder_description_invalid');
  expect((await descriptions.get(folder))?.description).toBe('Valid');
  expect(validFolderDescriptionNotice({ kind: 'known.folderDescription.changed', nativeId: '10' })).toBe(true);
  expect(validFolderDescriptionNotice({ kind: 'known.folderDescription.changed', nativeId: '10', collectionId: 'other-account' })).toBe(false);
});
