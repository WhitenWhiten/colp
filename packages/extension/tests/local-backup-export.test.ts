import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { MemoryStorageArea } from '../src/credential-store.js';
import { exportLocalBackup } from '../src/local-backup/export.js';
import { decodeLocalBackup } from '../src/local-backup/codec.js';
import { LOCAL_CLASSIFICATION_KEY, LOCAL_CLASSIFICATION_DRAFT } from '../src/classification-local-session.js';
import { assertCaptureOwner } from '../src/sw/capture-native.js';
import { hasBookmarkPermission } from '../src/sw/runtime.js';
import { FOLDER_DEFAULT_BINDING } from '../src/save-folder.js';
import { task } from './fixtures/capture.js';

vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: vi.fn(async () => true) }));
vi.mock('../src/sw/capture-native.js', () => ({
  currentCaptureScope: async () => ({ serverOrigin: 'https://known.test', accountId: null, collectionId: null, authorityGeneration: 1 }),
  assertCaptureOwner: vi.fn(async () => undefined),
}));
vi.mock('../src/sw/capture.js', async () => {
  const { task } = await import('./fixtures/capture.js');
  return { captureStore: { listForOwner: async () => [{ ...task, nativeId: 'b', targetNativeId: '1' }] } };
});
vi.mock('../src/sw/capture-history.js', () => ({ backupHistoryStore: { listForOwner: async () => [] } }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ readEffectiveBookmarkPreferences: async () => ({ bookmarkInsertPosition: 'top' }) }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set() }));

let local: MemoryStorageArea;
const config = { presetId: 'custom', endpoint: 'https://provider.test/classify', model: 'fixture-model' };
beforeEach(async () => {
  local = new MemoryStorageArea();
  await local.set({ [FOLDER_DEFAULT_BINDING]: { collectionId: 'device', folderNativeId: '1' } });
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('chrome', { storage: { local, session: new MemoryStorageArea() }, bookmarks: {
    getTree: async () => [{ id: '0', title: '', children: [{ id: '1', title: 'Bookmarks bar', children: [
      { id: 'b', title: task.title, url: task.url },
    ] }, { id: 'workspace', title: 'Workspaces', children: [{ id: 'hidden', title: 'Project', url: 'https://workspace.test/' }] }] }],
  } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function exportJson() {
  const result = await exportLocalBackup({ kind: 'known.localBackup.export', format: 'json' });
  const data = decodeLocalBackup(new TextEncoder().encode(result.content));
  expect(data.nodes).toEqual([{ sourceId: '1', parentIndex: null, title: 'Bookmarks bar' },
    { sourceId: 'b', parentIndex: 0, title: task.title, url: task.url }]);
  expect(data.history).toEqual([expect.objectContaining({ sourceId: task.captureId, title: task.title, url: task.url, nativeSourceId: 'b' })]);
  expect(data.preferences.bookmarkInsertPosition).toBe('top');
  expect(data.defaultFolderSourceId).toBe('1');
  return { data, content: result.content };
}

test.each([LOCAL_CLASSIFICATION_KEY, LOCAL_CLASSIFICATION_DRAFT])('exports valid portable AI settings from %s without the key', async key => {
  const stored = { ...config, version: 3, generation: 'fixture', disclosed: true, secret: 'DEDICATED-CREDENTIAL' };
  await local.set({ [key]: stored });
  const { data, content } = await exportJson();
  expect(data.aiConfig).toEqual(config);
  expect(content).not.toContain('DEDICATED-CREDENTIAL');
  expect((await local.get(key))[key]).toEqual(stored);
});

test.each([
  '?api_key=QUERY-CREDENTIAL', '?%61pi_key=QUERY-CREDENTIAL', '?token=QUERY-CREDENTIAL&api_key=SECOND-CREDENTIAL',
  '#HASH-CREDENTIAL', '?api-version=2026-10-01', '?api_key=QUERY-CREDENTIAL#HASH-CREDENTIAL',
])('omits the whole AI connection with URL suffix %s without altering saved settings', async suffix => {
  const stored = { ...config, endpoint: config.endpoint + suffix, secret: 'DEDICATED-CREDENTIAL' };
  await local.set({ [LOCAL_CLASSIFICATION_KEY]: stored });
  const { data, content } = await exportJson();
  expect(data.aiConfig).toBeNull();
  expect(content).not.toMatch(/CREDENTIAL|provider\.test/u);
  expect((await local.get(LOCAL_CLASSIFICATION_KEY))[LOCAL_CLASSIFICATION_KEY]).toEqual(stored);
});

test.each([
  { ...config, endpoint: 'broken-endpoint' }, { ...config, endpoint: 'https://user:PASS-CREDENTIAL@provider.test/' },
  { ...config, model: 42 }, { ...config, model: 'x'.repeat(257) }, { ...config, presetId: 'unknown' },
  { ...config, accountId: {} }, { ...config, gatewayId: [] }, 'corrupt', [],
])('skips malformed optional AI settings: %j', async stored => {
  await local.set({ [LOCAL_CLASSIFICATION_KEY]: stored });
  expect((await exportJson()).data.aiConfig).toBeNull();
  expect((await local.get(LOCAL_CLASSIFICATION_KEY))[LOCAL_CLASSIFICATION_KEY]).toEqual(stored);
});

test('exports core data when no AI configuration exists', async () => {
  expect((await exportJson()).data.aiConfig).toBeNull();
});

test('an optional AI storage read failure does not prevent core data export', async () => {
  const get = local.get.bind(local);
  vi.spyOn(local, 'get').mockImplementation(async keys => {
    if (keys === LOCAL_CLASSIFICATION_KEY) throw new Error('optional_storage_failure');
    return get(keys);
  });
  expect((await exportJson()).data.aiConfig).toBeNull();
});

test('permission and owner failures still block export', async () => {
  vi.mocked(hasBookmarkPermission).mockResolvedValueOnce(false);
  await expect(exportJson()).rejects.toThrow('permission_required');
  vi.mocked(assertCaptureOwner).mockRejectedValueOnce(new Error('stale_owner'));
  await expect(exportJson()).rejects.toThrow('stale_owner');
});
