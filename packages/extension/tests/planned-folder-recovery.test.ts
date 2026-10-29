import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createCaptureStore } from '../src/capture/store.js';
import { sourceDigest } from '../src/site-adapters/source-db.js';
import type { PlannedNativeCommand } from '../src/site-adapters/planned-types.js';
const f = vi.hoisted(() => ({ ledger: null as ReturnType<typeof createCaptureStore> | null, create: vi.fn() }));
vi.mock('../src/sw/capture.js', () => ({ get captureStore() { return f.ledger!; }, captureCoordinator: {}, CAPTURE_ALARM: 'capture' }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => ({}), recoverNativeCapture: vi.fn() }));
vi.mock('../src/sw/capture-target.js', () => ({ captureTarget: async () => ({ inRange: false }) }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ personalBookmarks: { create: f.create }, assertPersonalNativeAllowed: async () => {} }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true, workCoordinator: {} }));
vi.mock('../src/capture/planned.js', async original => ({ ...await original<object>(), plannedNativeFault: async () => {} }));
import { executePlannedNative, recoverPlannedNative, adoptPlannedFolder, retryPlannedFolder } from '../src/sw/planned-capture.js';
const command: PlannedNativeCommand = { commandId: 'folder-command', kind: 'folder', ownerId: 'reservation', logicalDigest: 'logical',
  connectionId: 'connection', title: 'Favorites', deviceId: 'device', parent: { kind: 'folder', nativeId: 'parent', dateAdded: 10,
    deviceId: 'device', bindingId: 'parent', proof: { kind: 'explicitAdoption', id: 'parent' } } };
test('a never-submitted folder reservation can continue after recovery', async () => {
  f.ledger = createCaptureStore(new IDBFactory());
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'parent', dateAdded: 10 }] }, alarms: { create: vi.fn() } });
  f.create.mockReset().mockResolvedValue({ id: 'new-folder', dateAdded: 20 });
  try {
    await f.ledger!.claimFolder(command.commandId, command, sourceDigest(command));
    expect((await f.ledger!.plannedCommand(command.commandId))?.state).toBe('reserved');
    expect(await recoverPlannedNative(command, sourceDigest(command))).toBeNull();
    expect(await executePlannedNative(command, sourceDigest(command), async () => {})).toMatchObject({ status: 'confirmed', native: { nativeId: 'new-folder' } });
    expect(f.create).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); await f.ledger!.close(); }
});
test('an ambiguous native folder failure is not blindly retried', async () => {
  f.ledger = createCaptureStore(new IDBFactory());
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'parent', dateAdded: 10 }] }, alarms: { create: vi.fn() } });
  f.create.mockReset().mockRejectedValueOnce(Error('Bookmarks API temporarily unavailable'))
    .mockResolvedValue({ id: 'new-folder', dateAdded: 20 });
  try {
    expect(await executePlannedNative(command, sourceDigest(command), async () => {})).toMatchObject({ status: 'unknown' });
    expect(await executePlannedNative(command, sourceDigest(command), async () => {})).toMatchObject({ status: 'unknown' });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect((await f.ledger!.plannedCommand(command.commandId))?.state).toBe('unknown');
  } finally { vi.unstubAllGlobals(); await f.ledger!.close(); }
});


test.each(['submitted', 'unknown'] as const)('explicit adoption recovers an old %s folder command and preserves evidence', async state => {
  f.ledger = createCaptureStore(new IDBFactory()); f.create.mockReset();
  vi.stubGlobal('chrome', { bookmarks: { get: async (id: string) => id === 'parent' ? [{ id, dateAdded: 10 }] : [{ id, dateAdded: 20, parentId: 'parent', title: 'Favorites' }] } });
  try {
    await f.ledger!.claimFolder(command.commandId, command, sourceDigest(command));
    await f.ledger!.updateFolder(command.commandId, 'reserved', 'submitted');
    if (state === 'unknown') await f.ledger!.updateFolder(command.commandId, 'submitted', 'unknown');
    await expect(adoptPlannedFolder(command, sourceDigest(command), 'folder', 21)).rejects.toThrow('nativeIdentityChanged');
    const native = await adoptPlannedFolder(command, sourceDigest(command), 'folder', 20);
    expect(native).toMatchObject({ nativeId: 'folder', dateAdded: 20, proof: { kind: 'explicitAdoption' } });
    await adoptPlannedFolder(command, sourceDigest(command), 'folder', 20);
    expect(await f.ledger!.plannedCommand(command.commandId)).toMatchObject({ state: 'confirmed', payload: command, recovery: { previousState: state, native } });
    expect(await recoverPlannedNative(command, sourceDigest(command))).toEqual({ status: 'confirmed', native });
    expect(f.create).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); await f.ledger!.close(); }
});

test('manual adoption cannot race a native create still running in this worker', async () => {
  f.ledger = createCaptureStore(new IDBFactory());
  let finish!: (node: { id: string; dateAdded: number }) => void;
  f.create.mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal('chrome', { bookmarks: { get: async (id: string) => id === 'parent' ? [{ id, dateAdded: 10 }] : [{ id, dateAdded: 20, parentId: 'parent', title: 'Favorites' }] }, alarms: { create: vi.fn() } });
  try {
    const running = executePlannedNative(command, sourceDigest(command), async () => {});
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
    await expect(adoptPlannedFolder(command, sourceDigest(command), 'folder', 20)).rejects.toThrow('nativeOperationInProgress');
    finish({ id: 'folder', dateAdded: 20 });
    expect(await running).toMatchObject({ status: 'confirmed' });
  } finally { vi.unstubAllGlobals(); await f.ledger!.close(); }
});


test('explicit confirmation of an absent folder permits retry while retaining the uncertain attempt', async () => {
  f.ledger = createCaptureStore(new IDBFactory()); f.create.mockReset().mockResolvedValue({ id: 'created', dateAdded: 30 });
  let children: { id: string; title: string }[] = [{ id: 'candidate', title: 'Favorites' }];
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'parent', dateAdded: 10 }], getChildren: async () => children }, alarms: { create: vi.fn() } });
  try {
    await f.ledger!.claimFolder(command.commandId, command, sourceDigest(command));
    await f.ledger!.updateFolder(command.commandId, 'reserved', 'submitted');
    await f.ledger!.updateFolder(command.commandId, 'submitted', 'unknown');
    await expect(retryPlannedFolder(command, sourceDigest(command))).rejects.toThrow('nativeFolderCandidateExists');
    expect((await f.ledger!.plannedCommand(command.commandId))?.state).toBe('unknown');
    children = [];
    await retryPlannedFolder(command, sourceDigest(command));
    await retryPlannedFolder(command, sourceDigest(command));
    expect(await f.ledger!.plannedCommand(command.commandId)).toMatchObject({ state: 'reserved', payload: command, retryDecisions: [{ previousState: 'unknown' }] });
    expect(await executePlannedNative(command, sourceDigest(command), async () => {})).toMatchObject({ status: 'confirmed', native: { nativeId: 'created' } });
    expect(f.create).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); await f.ledger!.close(); }
});
