import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Seed Chrome's native profile before the extension can observe create events.
 * These are pre-install bookmarks, not a live authored-save batch with anchors. */
export async function seedPreexistingBookmarks(profile: string, count: number) {
  const folder = (id: string, name: string, children: unknown[] = []) => ({
    id, name, type: 'folder', date_added: '13300000000000000', date_modified: '13300000000000000', children,
  });
  const children = Array.from({ length: count }, (_, index) => ({ id: String(index + 10),
    type: 'url', name: `KNS08 batched ${index}`, url: `https://example.test/batched/${index}`,
    date_added: '13300000000000000', date_last_used: '0' }));
  const directory = resolve(profile, 'Default'); await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'Bookmarks'), JSON.stringify({ version: 1, roots: {
    bookmark_bar: folder('1', 'Bookmarks bar', children), other: folder('2', 'Other bookmarks'),
    synced: folder('3', 'Mobile bookmarks'),
  } }));
}
