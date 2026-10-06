import { describe, expect, it, vi } from 'vitest';
import { applySyncBrowserBatch } from '../../src/sync/browser-batch-adapter.js';

describe('Browser batches retain every affected folder', () => {
  it('rereads source and destination once and retains an emptied source folder', async () => {
    const events: string[] = [];
    const result = await applySyncBrowserBatch([
      { folderId: 'B', sourceFolderId: 'A' },
      { folderId: 'B', sourceFolderId: 'A', affectedFolderIds: ['C', 'B'] },
    ], {
      write: async () => { events.push('write'); },
      readFolder: async id => { events.push('read:' + id); return id === 'B' ? ['moved'] : []; },
    }, { grouped: true });
    expect(events).toEqual(['write', 'write', 'read:B', 'read:A', 'read:C']);
    expect(result).toEqual([
      { folderId: 'B', items: ['moved'] }, { folderId: 'A', items: [] }, { folderId: 'C', items: [] },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0]!.items)).toBe(true);
  });
  it('retains the flat result and the Sync alias for existing callers', async () => {
    const driver = { write: async () => {}, readFolder: async (id: string) => [id] };
    expect(await applySyncBrowserBatch([{ folderId: 'B' }], driver)).toEqual(['B']);
    expect(await applySyncBrowserBatch([{ folderId: 'B' }], driver, { grouped: true }))
      .toEqual([{ folderId: 'B', items: ['B'] }]);
  });
  it('does not read partial folder snapshots after a failed write', async () => {
    const readFolder = vi.fn(async () => []);
    await expect(applySyncBrowserBatch([{ folderId: 'B', sourceFolderId: 'A' }], {
      write: async () => { throw new Error('write failed'); }, readFolder,
    }, { grouped: true })).rejects.toThrow('write failed');
    expect(readFolder).not.toHaveBeenCalled();
  });
  it('rejects an invalid source before starting that change', async () => {
    const write = vi.fn(async () => {});
    await expect(applySyncBrowserBatch([{ folderId: 'B', sourceFolderId: '' }], {
      write, readFolder: async () => [],
    })).rejects.toThrow('sourceFolderId');
    expect(write).not.toHaveBeenCalled();
  });
});
