import { afterEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { restoreBackupMetadata } from '../src/local-backup/restore.js';
import { LOCAL_CLASSIFICATION_KEY, LOCAL_CLASSIFICATION_DRAFT, LOCAL_CLASSIFICATION_ENABLED } from '../src/classification-local-session.js';
import type { LocalImportPlan } from '../src/local-import/contracts.js';
vi.mock('../src/sw/capture-history.js', () => ({ backupHistoryStore: { restore: async () => undefined } }));
vi.mock('../src/sw/capture-native.js', () => ({ assertCaptureOwner: async () => undefined }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ restoreDeviceBookmarkPreferences: async () => undefined }));
afterEach(() => vi.unstubAllGlobals());
const config = { presetId: 'custom', endpoint: 'https://ai.test/', model: 'Model' };
const plan = { commandId: 'restore', restoreOwner: { accountId: null, serverOrigin: 'https://known.test', authorityGeneration: 1, collectionId: null },
  restoreSettings: true, backup: { history: [], preferences: {}, defaultFolderSourceId: null, aiConfig: config, language: 'en' } } as unknown as LocalImportPlan;

test.each([false, true])('restoring settings=%s preserves the existing key and enabled state', async restoreSettings => {
  const local = new MemoryStorageArea(), credential = { secret: 'fixture-secret', model: 'Existing model' };
  await local.set({ [LOCAL_CLASSIFICATION_KEY]: credential, [LOCAL_CLASSIFICATION_ENABLED]: true });
  vi.stubGlobal('chrome', { storage: { local, session: new MemoryStorageArea() } });
  await restoreBackupMetadata({ ...plan, restoreSettings }, []);
  expect((await local.get(LOCAL_CLASSIFICATION_KEY))[LOCAL_CLASSIFICATION_KEY]).toEqual(credential);
  expect((await local.get(LOCAL_CLASSIFICATION_ENABLED))[LOCAL_CLASSIFICATION_ENABLED]).toBe(true);
  expect((await local.get(LOCAL_CLASSIFICATION_DRAFT))[LOCAL_CLASSIFICATION_DRAFT]).toBeUndefined();
});
test('a browser without a key receives only an inactive restored configuration draft', async () => {
  const local = new MemoryStorageArea(); vi.stubGlobal('chrome', { storage: { local, session: new MemoryStorageArea() } });
  await restoreBackupMetadata(plan, []);
  expect((await local.get(LOCAL_CLASSIFICATION_KEY))[LOCAL_CLASSIFICATION_KEY]).toBeUndefined();
  expect((await local.get(LOCAL_CLASSIFICATION_DRAFT))[LOCAL_CLASSIFICATION_DRAFT]).toEqual(config);
  expect((await local.get(LOCAL_CLASSIFICATION_ENABLED))[LOCAL_CLASSIFICATION_ENABLED]).toBe(false);
});
