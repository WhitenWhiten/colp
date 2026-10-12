import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freezeCaptureTabs, validCaptureBatchRequest } from '../src/capture/batch.js';
import { task, location } from './fixtures/capture.js';
const mocks = vi.hoisted(() => ({ start: vi.fn(), resume: vi.fn(), get: vi.fn(), scope: vi.fn(), existence: vi.fn() }));
vi.mock('../src/sw/capture.js', () => ({ startCapture: mocks.start, resumeCapture: mocks.resume, captureStore: { get: mocks.get } }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: mocks.scope, assertCaptureScope: async () => undefined,
  captureExistence: mocks.existence }));
import { handleCaptureBatch, previewCaptureBatch } from '../src/sw/capture-batch.js';
const storage = new Map<string, unknown>();
beforeEach(() => {
  vi.clearAllMocks(); storage.clear(); mocks.scope.mockResolvedValue(task.scope);
  mocks.existence.mockResolvedValue({ exact: [] }); mocks.get.mockResolvedValue(null);
  mocks.start.mockImplementation(async input => ({ ...task, captureId: input.commandId })); mocks.resume.mockImplementation(async task => task);
  vi.stubGlobal('chrome', { storage: { local: { get: async (key: string) => ({ [key]: storage.get(key) }),
    set: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value)); } } },
  permissions: { contains: async () => false }, tabs: { query: async () => [{ id: 1, title: 'Original', url: 'https://example.org/1', windowId: 1 },
    { id: 2, title: 'Second', url: 'https://example.org/2', windowId: 1 }, { id: 3, windowId: 1 }] } });
});

describe('batch capture', () => {
  it('freezes source identities and merges exact duplicates without discarding query/hash', () => {
    const tabs = [{ id: 1, url: location.url }, { id: 2, url: location.url }, { id: 3, url: location.url + '2' }, { id: 4 }];
    const items = freezeCaptureTabs(tabs, () => crypto.randomUUID());
    tabs[0]!.url = 'https://changed.org';
    expect(items).toHaveLength(3); expect(items[0]?.tabIds).toEqual([1, 2]);
    expect(items[0]?.url).toBe(location.url); expect(items[2]?.reason).toBe('unreadable');
  });
  it('permission refusal keeps a readable preview without any capture or native write', async () => {
    const batch = await previewCaptureBatch('all');
    expect(batch.tabsPermission).toBe(false); expect(batch.items[2]?.reason).toBe('unreadable');
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.resume).not.toHaveBeenCalled();
  });
  it('confirms frozen inputs and reuses item commands after partial failure', async () => {
    const batch = await previewCaptureBatch('selected');
    mocks.start.mockRejectedValueOnce(new Error('target temporarily unavailable'));
    const request = { kind: 'known.capture.batch.confirm' as const, batchId: batch.batchId,
      selectedIds: batch.items.slice(0, 2).map(item => item.itemId), saveAnotherIds: [], targetNativeId: 'folder', allowUnverifiedCloud: true, userGesture: true as const };
    expect(validCaptureBatchRequest(request)).toBe(true);
    await handleCaptureBatch(request);
    const firstCommand = mocks.start.mock.calls[0]?.[0].commandId;
    const secondCommand = mocks.start.mock.calls[1]?.[0].commandId;
    mocks.get.mockImplementation(async (_scope, id) => ({ ...task, captureId: id, save: 'local-saved' }));
    await handleCaptureBatch({ kind: 'known.capture.batch.resume', batchId: batch.batchId });
    expect(mocks.start.mock.calls[2]?.[0]).toMatchObject({ commandId: firstCommand, url: 'https://example.org/1', title: 'Original' });
    expect(mocks.start.mock.calls.filter(([input]) => input.commandId === secondCommand)).toHaveLength(1);
  });
});
