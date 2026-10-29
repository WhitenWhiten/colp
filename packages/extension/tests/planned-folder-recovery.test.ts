import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createCaptureStore } from '../src/capture/store.js';
import { sourceDigest } from '../src/site-adapters/source-db.js';
import type { PlannedNativeCommand } from '../src/site-adapters/planned-types.js';
const f = vi.hoisted(() => ({ ledger: undefined as unknown as ReturnType<typeof createCaptureStore>, create: vi.fn() }));
vi.mock('../src/sw/capture.js', () => ({ get captureStore() { return f.ledger; }, captureCoordinator: {}, CAPTURE_ALARM: 'capture' }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => ({}), recoverNativeCapture: vi.fn() }));
vi.mock('../src/sw/capture-target.js', () => ({ captureTarget: async () => ({ inRange: false }) }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ personalBookmarks: { create: f.create } }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true, workCoordinator: {} }));
vi.mock('../src/capture/planned.js', async original => ({ ...await original<object>(), plannedNativeFault: async () => {} }));
import { executePlannedNative, recoverPlannedNative } from '../src/sw/planned-capture.js';
const command: PlannedNativeCommand = { commandId: 'folder-command', kind: 'folder', ownerId: 'reservation', logicalDigest: 'logical',
  connectionId: 'connection', title: 'Favorites', deviceId: 'device', parent: { kind: 'folder', nativeId: 'parent', dateAdded: 10,
    deviceId: 'device', bindingId: 'parent', proof: { kind: 'explicitAdoption', id: 'parent' } } };
test('a never-submitted folder reservation can continue after recovery', async () => {
  f.ledger = createCaptureStore(new IDBFactory());
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'parent', dateAdded: 10 }] }, alarms: { create: vi.fn() } });
  f.create.mockReset().mockResolvedValue({ id: 'new-folder', dateAdded: 20 });
  try {
    await f.ledger.claimFolder(command.commandId, command, sourceDigest(command));
    expect((await f.ledger.plannedCommand(command.commandId))?.state).toBe('reserved');
    expect(await recoverPlannedNative(command, sourceDigest(command))).toBeNull();
    expect(await executePlannedNative(command, sourceDigest(command), async () => {})).toMatchObject({ status: 'confirmed', native: { nativeId: 'new-folder' } });
    expect(f.create).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); await f.ledger.close(); }
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
    expect((await f.ledger.plannedCommand(command.commandId))?.state).toBe('unknown');
  } finally { vi.unstubAllGlobals(); await f.ledger.close(); }
});
