import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { backupHistory, backupNativeNodes, bookmarkHtml, decodeLocalBackup, parseLocalBackup, type LocalBackup } from '../src/local-backup/codec.js';
import { createBackupHistoryStore } from '../src/local-backup/history-store.js';
import { createCaptureStore } from '../src/capture/store.js';
import { listBrowserCaptureHistory } from '../src/capture/local-history.js';
import { createLocalImportStore } from '../src/local-import/store.js';
import { createLocalImporter } from '../src/local-import/coordinator.js';
import { previewNetscapeBookmarkImport } from '../src/import-preview.js';
import { task } from './fixtures/capture.js';

function backup(): LocalBackup {
  return parseLocalBackup({ format: 'known-browser-backup', version: 1, exportedAt: 20,
    nodes: [{ sourceId: 'f', parentIndex: null, title: '<Folder & "name">', description: 'Useful tools' },
      { sourceId: 'b1', parentIndex: 0, title: 'Duplicate', url: task.url }, { sourceId: 'b2', parentIndex: 0, title: 'Duplicate', url: task.url }],
    history: [backupHistory({ ...task, captureId: 'old', nativeId: 'b1', createdAt: 10, save: 'local-saved', saveAnother: true,
      savedAt: 12, classificationAppliedAt: 15, feedbackKind: 'explicit_positive', appliedRevision: 'source-revision',
      reportIntent: { revision: 1, commandId: 'do-not-replay' } })],
    preferences: { bookmarkInsertPosition: 'top', captureMode: 'automatic' }, language: 'en', defaultFolderSourceId: 'f',
    aiConfig: { presetId: 'custom', endpoint: 'http://localhost:8080/classify', model: 'my-model' } });
}
test('portable HTML preserves hierarchy, duplicate occurrences and escaped text', () => {
  const html = bookmarkHtml(backup().nodes);
  expect(html).toContain('&lt;Folder &amp; &quot;name&quot;&gt;');
  const imported = previewNetscapeBookmarkImport(new TextEncoder().encode(html));
  expect(imported.tree[0]?.title).toBe('<Folder & "name">');
  expect(imported.tree[0]?.children.map(node => node.url)).toEqual([task.url, task.url]);
});
test('a backup uses explicit portable fields and rejects secrets, unsupported versions and invalid node ancestry', () => {
  const data = backup(), serialized = JSON.stringify(data);
  expect(decodeLocalBackup(new TextEncoder().encode(serialized))).toEqual(data);
  expect(serialized).not.toContain('do-not-replay'); expect(serialized).not.toContain('accountId');
  expect(() => parseLocalBackup({ ...data, aiConfig: { ...data.aiConfig, secret: 'private-key' } })).toThrow('backup_invalid');
  expect(() => parseLocalBackup({ ...data, version: 2 })).toThrow('backup_version_unsupported');
  expect(() => parseLocalBackup({ ...data, nodes: [{ ...data.nodes[0], parentIndex: 0 }] })).toThrow('backup_invalid');
  expect(() => parseLocalBackup({ ...data, nodes: [...data.nodes, data.nodes[0]] })).toThrow('backup_invalid');
  expect(() => parseLocalBackup({ ...data, nodes: [{ ...data.nodes[1], parentIndex: null, url: 'javascript:alert(1)' }] })).toThrow('backup_unsupported_url');
  expect(() => parseLocalBackup({ ...data, history: [{ ...data.history[0], executionId: 'old-command' }] })).toThrow('backup_invalid');
});
test('native export skips managed and subscription subtrees and preserves metadata by native identity', () => {
  const nodes = backupNativeNodes([
    { id: 'f', title: 'Folder', children: [{ id: 'b', title: 'Bookmark', url: task.url }] },
    { id: 'managed', title: 'Policy', unmodifiable: 'managed', children: [{ id: 'hidden', title: 'Hidden' }] },
    { id: 'subscription', title: 'Subscribed', children: [{ id: 'also-hidden', title: 'Read only' }] },
  ], new Map([['f', 'Description']]), new Set(['subscription']));
  expect(nodes).toEqual([{ sourceId: 'f', parentIndex: null, title: 'Folder', description: 'Description' },
    { sourceId: 'b', parentIndex: 0, title: 'Bookmark', url: task.url }]);
});
test('restored history stays outside the live command ledger, is idempotent and preserves owner isolation and pagination', async () => {
  const factory = new IDBFactory(), archive = createBackupHistoryStore(factory), live = createCaptureStore(factory);
  const guest = { ...task.scope, accountId: null, collectionId: null };
  try {
    const records = Array.from({ length: 70 }, (_, i) => ({ ...backup().history[0]!, sourceId: String(i), createdAt: i }));
    await archive.restore(guest, 'restore-command', records, new Map([['b1', 'new-bookmark']]));
    await archive.restore(guest, 'restore-command', records, new Map([['b1', 'new-bookmark']]));
    await archive.restore({ ...guest, accountId: 'other' }, 'other-command', [records[0]!], new Map());
    const own = { ...task.scope, accountId: 'current' }, result = [];
    let before: readonly [number, string] | undefined;
    for (;;) {
      const page = await listBrowserCaptureHistory(live, own, before, archive); result.push(...page);
      const last = page.at(-1); if (!last || page.length < 50) break; before = [last.createdAt, last.captureId];
    }
    expect(result).toHaveLength(70); expect(result.every(row => row.historyReadOnly && row.historyOrigin === 'backup')).toBe(true);
    expect(result[0]?.nativeId).toBe('new-bookmark');
    expect(result[0]).toMatchObject({ savedAt: 12, classificationAppliedAt: 15, feedbackKind: 'explicit_positive', historyAutomaticApplied: true });
    expect(result[0]?.reportIntent).toBeUndefined(); expect(result[0]?.automatic).toBeUndefined();
    expect(await live.listForOwner(guest)).toEqual([]);
    expect(result.some(row => row.scope.accountId === 'other')).toBe(false);
  } finally { await archive.close(); await live.close(); }
});
test('backup restore resumes metadata after a restart without recreating confirmed bookmarks', async () => {
  const factory = new IDBFactory(), store = createLocalImportStore(factory), data = backup();
  const input = { commandId: crypto.randomUUID(), digest: 'backup-digest', targetNativeId: 'bar', folderTitle: 'Restored', restoreSettings: true, restoreOwner: task.scope };
  const create = vi.fn(async () => ({ id: `new-${create.mock.calls.length}` }));
  const restoreMetadata = vi.fn().mockRejectedValueOnce(new Error('backup_restore_failed')).mockResolvedValue(undefined);
  const ports = { store, hasPermission: async () => true, assertFolder: async () => {}, create, get: async () => undefined, restoreMetadata };
  let reopened: ReturnType<typeof createLocalImportStore> | undefined;
  try {
    await store.previewBackup(data, input.digest); await store.start(input);
    const first = await createLocalImporter(ports).run(input.commandId);
    expect(first).toMatchObject({ next: 4, state: 'attention', reason: 'backup_restore_failed' });
    expect(create).toHaveBeenCalledTimes(4);
    const mapping = restoreMetadata.mock.calls[0]![1];
    expect(mapping.map((item: { sourceId?: string; nativeId: string }) => [item.sourceId, item.nativeId])).toEqual([
      [undefined, 'new-1'], ['f', 'new-2'], ['b1', 'new-3'], ['b2', 'new-4'],
    ]);
    expect(mapping[1].description).toBe('Useful tools');
    await store.close(); reopened = createLocalImportStore(factory);
    const importer = createLocalImporter({ ...ports, store: reopened });
    await importer.resume(input.commandId);
    expect(await importer.run(input.commandId)).toMatchObject({ state: 'completed', historyCount: 1 });
    expect(create).toHaveBeenCalledTimes(4); expect(await reopened.items(input.commandId)).toEqual([]);
    await reopened.start(input); expect(create).toHaveBeenCalledTimes(4);
  } finally { await store.close(); await reopened?.close(); }
});
