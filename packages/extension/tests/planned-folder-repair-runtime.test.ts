import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceDigest, sourceKey } from '../src/site-adapters/source-db.js';
import type { PlannedNativeCommand } from '../src/site-adapters/planned-types.js';
const f = vi.hoisted(() => ({ db: null as ReturnType<typeof createSourceDatabase> | null, adopt: vi.fn(async () => {}), wake: vi.fn(async () => {}) }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { get db() { return f.db!; } }, SITE_RECOVERY_ALARM: 'site' }));
vi.mock('../src/site-adapters/portable.js', () => ({ createSourceRebinder: () => ({}) }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/sw/capture.js', () => ({ captureStore: {} }));
vi.mock('../src/sw/planned-capture.js', () => ({ adoptPlannedFolder: f.adopt }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => ({ serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' }) }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ assertPersonalNativeAllowed: async () => {} }));
vi.mock('../src/site-adapters/planned-runtime.js', () => ({ wakePlannedSaves: f.wake }));
vi.mock('../src/site-adapters/local-source-problems.js', () => ({ retrySourceObservations: vi.fn() }));
vi.mock('../src/site-adapters/wake-scheduler.js', () => ({ scheduleSourceAlarm: vi.fn() }));
const command: PlannedNativeCommand = { commandId: 'command', kind: 'folder', ownerId: 'reservation', logicalDigest: 'logical', connectionId: 'connection',
  title: 'Favorites', deviceId: 'device', parent: { nativeId: 'parent', bindingId: 'parent', dateAdded: 10, deviceId: 'device', kind: 'folder', proof: { kind: 'explicitAdoption', id: 'parent' } } };
test('management adoption wakes all active shared consumers and keeps the original command', async () => {
  f.db = createSourceDatabase(new IDBFactory()); vi.resetModules(); f.adopt.mockClear(); f.wake.mockClear();
  const { handleRepairRequest } = await import('../src/site-adapters/repair-runtime.js');
  try {
    await f.db.transaction(['authorities', 'outbox', 'folderConsumers', 'work'], 'readwrite', async tx => {
      tx.objectStore('authorities').put({ enabled: true, connectionId: 'connection' }, 'bundled.bilibili');
      tx.objectStore('outbox').put({ command, digest: sourceDigest(command), state: 'unknown' }, command.commandId);
      for (const [id, active] of [['one', true], ['two', true], ['cancelled', false]] as const)
        tx.objectStore('folderConsumers').put({ planId: id, active }, sourceKey('reservation', id, 'folder'));
      tx.objectStore('work').put({ id: 'one', dueAt: Number.MAX_SAFE_INTEGER, attempts: 3 }, 'one');
    });
    await expect(handleRepairRequest({ kind: 'known.siteAdapters.repair.adoptFolder', commandId: 'command', nativeId: 'chosen', dateAdded: 20 })).resolves.toEqual({ ok: true });
    expect(f.adopt).toHaveBeenCalledWith(command, sourceDigest(command), 'chosen', 20);
    expect(await f.db.read('work', 'one')).toMatchObject({ id: 'one', attempts: 3, connectionId: 'connection' });
    expect(await f.db.read('work', 'two')).toMatchObject({ id: 'two', connectionId: 'connection' });
    expect(await f.db.read('work', 'cancelled')).toBeUndefined(); expect(f.wake).toHaveBeenCalledOnce();
    expect(await f.db.read('outbox', 'command')).toMatchObject({ command, state: 'unknown' });
    const other = { ...command, commandId: 'other', ownerId: 'other-reservation' };
    await f.db.transaction(['outbox'], 'readwrite', async tx => { tx.objectStore('outbox').put({ command: other, digest: sourceDigest(other), state: 'unknown' }, other.commandId); });
    await expect(handleRepairRequest({ kind: 'known.siteAdapters.repair.adoptFolder', commandId: 'other', nativeId: 'chosen', dateAdded: 20 })).rejects.toThrow('nativeIdentityChanged');
    expect(f.adopt).toHaveBeenCalledOnce();
  } finally { await f.db.close(); }
});

test('status on a future schema answers from the raw diagnostic without reading through the ledger', async () => {
  const name = 'known-site-adapters';
  await new Promise<void>((resolve, reject) => { const r = indexedDB.open(name, 99);
    r.onupgradeneeded = () => { r.result.createObjectStore('future').put({ state: 'unknown', commandId: 'original-unknown-command' }, 'retained'); };
    r.onsuccess = () => { r.result.close(); resolve(); }; r.onerror = () => reject(r.error); });
  const refuse = async () => { throw new Error('schemaIncompatible'); };
  f.db = { read: refuse, transaction: refuse } as unknown as ReturnType<typeof createSourceDatabase>; vi.resetModules();
  const { handleRepairRequest } = await import('../src/site-adapters/repair-runtime.js');
  try {
    await expect(handleRepairRequest({ kind: 'known.siteAdapters.repair.status' })).resolves.toMatchObject({
      ok: true, schemaVersion: 99, supportedSchema: false, folderRecovery: [], restored: [], attention: [{ key: 'retained', state: 'unknown' }] });
  } finally { await new Promise<void>(resolve => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = () => resolve(); }); }
});
