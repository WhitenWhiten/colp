import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { previewNetscapeBookmarkImport } from '../src/import-preview.js';
import { createLocalImportStore, type LocalImportStore } from '../src/local-import/store.js';
import { createLocalImporter, type LocalImportPorts } from '../src/local-import/coordinator.js';
import { validLocalImportRequest } from '../src/local-import/contracts.js';

const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3>Recipes</H3><DL><DT><A HREF="https://example.org/pasta">Pasta</A><DT><A HREF="https://example.org/pasta">Pasta</A></DL><HR></DL>';
const conversion = () => previewNetscapeBookmarkImport(new TextEncoder().encode(html));
const stores: LocalImportStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
function harness() {
  const factory = new IDBFactory();
  const store = createLocalImportStore(factory); stores.push(store);
  const nodes = new Map<string, { id: string; title: string; parentId?: string; url?: string }>([['bar', { id: 'bar', title: 'Bookmarks bar', parentId: '0' }]]);
  let permitted = true;
  const ports: LocalImportPorts = { store,
    hasPermission: async () => permitted,
    assertFolder: async id => { if (!nodes.has(id) || nodes.get(id)?.url) throw new Error('capture_target_unavailable'); },
    create: vi.fn(async input => { const node = { ...input, id: `native-${nodes.size}` }; nodes.set(node.id, node); return node; }),
    get: async id => nodes.get(id),
  };
  return { factory, store, nodes, ports, importer: createLocalImporter(ports), permission: (value: boolean) => { permitted = value; } };
}
async function start(store: LocalImportStore) {
  const input = { commandId: crypto.randomUUID(), digest: conversion().digest, targetNativeId: 'bar', folderTitle: 'Imported' };
  await store.preview(conversion()); await store.start(input); return input;
}

test('imports the folder hierarchy and duplicate occurrences in source order, without account or network', async () => {
  const f = harness(), input = await start(f.store);
  expect(await f.importer.run(input.commandId)).toMatchObject({ state: 'completed', next: 4, total: 4, rootNativeId: 'native-1' });
  expect([...f.nodes.values()].slice(1)).toEqual([
    { id: 'native-1', parentId: 'bar', title: 'Imported' },
    { id: 'native-2', parentId: 'native-1', title: 'Recipes' },
    { id: 'native-3', parentId: 'native-2', title: 'Pasta', url: 'https://example.org/pasta' },
    { id: 'native-4', parentId: 'native-2', title: 'Pasta', url: 'https://example.org/pasta' },
  ]);
  await f.store.start(input); await f.importer.run(input.commandId);
  expect(f.ports.create).toHaveBeenCalledTimes(4);
  expect(await f.store.item(input.commandId, 0)).toBeUndefined();
});
test('resumes after a worker restart from the confirmed prefix without recreating it', async () => {
  const f = harness(), input = await start(f.store);
  expect(await f.importer.run(input.commandId, 2)).toMatchObject({ state: 'running', next: 2 });
  await f.store.close();
  const reopened = createLocalImportStore(f.factory); stores.push(reopened);
  expect(await createLocalImporter({ ...f.ports, store: reopened }).run(input.commandId)).toMatchObject({ state: 'completed', next: 4 });
  expect(f.ports.create).toHaveBeenCalledTimes(4);
});
test('does not repeat a create with a lost receipt, and requires a verified identity before continuing', async () => {
  const f = harness(), input = await start(f.store);
  vi.spyOn(f.store, 'confirm').mockRejectedValueOnce(new Error('worker interrupted after native create'));
  expect(await f.importer.run(input.commandId)).toMatchObject({ state: 'attention', reason: 'native_result_unknown', next: 0 });
  const restarted = createLocalImporter(f.ports);
  await restarted.resume(input.commandId); await restarted.run(input.commandId);
  expect(f.ports.create).toHaveBeenCalledTimes(1);
  expect(await restarted.status(input.commandId)).toMatchObject({ pending: { parentNativeId: 'bar', title: 'Imported' } });
  await expect(restarted.resolve(input.commandId, 'bar')).rejects.toThrow('identity_mismatch');
  await restarted.resolve(input.commandId, 'native-1'); await restarted.run(input.commandId);
  expect(f.ports.create).toHaveBeenCalledTimes(4);
  expect(await restarted.status()).toMatchObject({ state: 'completed' });
});
test('permission revocation pauses before creating, and regrant resumes the same intent', async () => {
  const f = harness(), input = await start(f.store); f.permission(false);
  expect(await f.importer.run(input.commandId)).toMatchObject({ state: 'attention', reason: 'permission_required', next: 0 });
  expect(f.ports.create).not.toHaveBeenCalled();
  f.permission(true); await f.importer.resume(input.commandId); await f.importer.run(input.commandId);
  expect(f.ports.create).toHaveBeenCalledTimes(4);
});
test('a deleted or read-only parent stops before native mutation', async () => {
  const f = harness(), input = await start(f.store);
  f.ports.assertFolder = async () => { throw new Error('readonly_write_blocked'); };
  expect(await f.importer.run(input.commandId)).toMatchObject({ state: 'attention', reason: 'readonly_write_blocked' });
  expect(f.ports.create).not.toHaveBeenCalled();
});
test('only one unfinished import is admitted; cancellation preserves created nodes and releases its journal', async () => {
  const f = harness(), input = await start(f.store);
  const another = { ...input, commandId: crypto.randomUUID() }; await f.store.preview(conversion());
  await expect(f.store.start(another)).rejects.toThrow('import_in_progress');
  const partial = await f.importer.run(input.commandId, 2);
  await f.store.state(partial, 'cancelled', null); await f.importer.resume(input.commandId); await f.importer.run(input.commandId);
  expect(f.ports.create).toHaveBeenCalledTimes(2);
  expect(f.nodes.has('native-2')).toBe(true);
  expect(await f.store.item(input.commandId, 0)).toBeUndefined();
  expect(await f.store.start(another)).toMatchObject({ state: 'running', next: 0 });
});
test('rejects expired previews and changed payloads using a previously admitted command', async () => {
  const f = harness(), input = await start(f.store);
  await expect(f.store.start({ ...input, folderTitle: 'Changed' })).rejects.toThrow('command_id_reused');
  await f.importer.run(input.commandId);
  await expect(f.store.start({ ...input, commandId: crypto.randomUUID() })).rejects.toThrow('preview_expired');
});
test('local import messages reject extra authority fields, invalid identities and oversized input', () => {
  const input = { kind: 'known.localImport.commit', commandId: crypto.randomUUID(), digest: conversion().digest,
    targetNativeId: 'bar', folderTitle: 'Imported', userGesture: true };
  expect(validLocalImportRequest(input)).toBe(true);
  expect(validLocalImportRequest({ ...input, accountId: 'other' })).toBe(false);
  expect(validLocalImportRequest({ ...input, commandId: 'invalid' })).toBe(false);
  expect(validLocalImportRequest({ ...input, folderTitle: ' ' })).toBe(false);
  expect(validLocalImportRequest({ kind: 'known.localImport.preview', base64: 'a'.repeat(6 * 1024 * 1024) })).toBe(false);
});
