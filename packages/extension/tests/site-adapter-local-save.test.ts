import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { localTransferKey } from '../src/site-adapters/local-identity.js';
import type { PlannedNativeCommand } from '../src/site-adapters/planned-types.js';
const fixture = vi.hoisted(() => ({ db: undefined as unknown as ReturnType<typeof createSourceDatabase>,
  scope: { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library', authorityGeneration: 1 },
  slot: { kind: 'folder' as const, source: { site: 'fixture', identityVersion: 1, sourceAccount: 'reader', sourceCollectionId: 'saved' } } }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { get db() { return fixture.db; } } }));
vi.mock('../src/site-adapters/managed-runtime.js', () => ({ sourceSlotForPlan: async () => fixture.slot }));
vi.mock('../src/site-adapters/shared-catalog-runtime.js', () => ({ cachedSharedCopy: async () => null }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => fixture.scope }));
vi.mock('../src/sw/planned-capture.js', () => ({ assertSourceRoot: async () => ({ inRange: true }) }));
vi.mock('../src/site-adapters/wake-scheduler.js', () => ({ scheduleSourceAlarm: vi.fn() }));
import { prepareLocalSourceSave, rememberLocalSourceSave } from '../src/site-adapters/local-save-runtime.js';
afterEach(() => vi.unstubAllGlobals());
test('synced destinations prepare locally and record native success without any server request', async () => {
  fixture.db = createSourceDatabase(new IDBFactory());
  const fetch = vi.fn(async () => { throw Error('offline'); }); vi.stubGlobal('fetch', fetch);
  try {
    const root = { nativeId: 'root', dateAdded: 10, deviceId: 'device', kind: 'folder' as const, bindingId: 'root', proof: { kind: 'explicitAdoption' as const, id: 'root' } };
    await fixture.db.transaction(['mounts'], 'readwrite', async tx => { tx.objectStore('mounts').put({ id: 'mount', root, destination: fixture.scope }, sourceKey('source', 'rule')); });
    const raw: PlannedNativeCommand = { commandId: 'command', kind: 'folder', ownerId: 'folder', logicalDigest: 'digest', parent: root, deviceId: 'device', connectionId: 'source', title: 'Saved' };
    const command = await prepareLocalSourceSave(raw, { mount: { id: 'mount' } } as never, {} as never);
    expect(command.managed).toBeUndefined(); expect(command.local?.owner?.accountId).toBe('owner');
    const native = { ...root, nativeId: 'new-folder', bindingId: 'command', dateAdded: 20 };
    await rememberLocalSourceSave(command, { status: 'confirmed', native });
    await rememberLocalSourceSave(command, { status: 'confirmed', native });
    expect(await fixture.db.read('meta', localTransferKey('command'))).toMatchObject({ state: 'pending', native: { nativeId: 'new-folder' }, owner: { accountId: 'owner' } });
    expect(fetch).not.toHaveBeenCalled();
    await expect(rememberLocalSourceSave(command, { status: 'confirmed', native: { ...native, dateAdded: 21 } })).rejects.toThrow('localReceiptChanged');
  } finally { await fixture.db.close(); }
});
