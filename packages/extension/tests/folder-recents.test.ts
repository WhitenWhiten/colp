import { afterEach, expect, test, vi } from 'vitest';
import { FOLDER_RECENTS, FOLDER_RECENTS_LIMIT, parseFolderRecents, pushFolderRecent, readFolderRecents } from '../src/folder-recents.js';

afterEach(() => { vi.unstubAllGlobals(); });

function stubStorage(local: Record<string, unknown>): Record<string, unknown> {
  vi.stubGlobal('chrome', { storage: { local: {
    get: vi.fn(async (key: string) => (key in local ? { [key]: local[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(local, items); }),
  } } });
  return local;
}

test('malformed records read as empty; ids are deduplicated and capped', () => {
  expect(parseFolderRecents(undefined)).toEqual([]);
  expect(parseFolderRecents({ ids: 'a' })).toEqual([]);
  expect(parseFolderRecents({ ids: ['a', 'a', '', 7, 'b'] })).toEqual(['a', 'b']);
  expect(parseFolderRecents({ ids: ['1', '2', '3', '4', '5', '6', '7'] })).toHaveLength(FOLDER_RECENTS_LIMIT);
});

test('a push moves the folder to the front without duplicating it', async () => {
  const local = stubStorage({ [FOLDER_RECENTS]: { ids: ['a', 'b', 'c', 'd', 'e'] } });
  await pushFolderRecent('c');
  expect(local[FOLDER_RECENTS]).toEqual({ ids: ['c', 'a', 'b', 'd', 'e'] });
  await pushFolderRecent('z');
  expect(await readFolderRecents()).toEqual(['z', 'c', 'a', 'b', 'd']);
});

test('storage failures never throw into the save path', async () => {
  vi.stubGlobal('chrome', { storage: { local: {
    get: vi.fn(async () => { throw new Error('quota'); }),
    set: vi.fn(async () => { throw new Error('quota'); }),
  } } });
  expect(await readFolderRecents()).toEqual([]);
  await expect(pushFolderRecent('a')).resolves.toBeUndefined();
});
