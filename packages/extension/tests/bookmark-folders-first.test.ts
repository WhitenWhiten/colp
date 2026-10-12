import { expect, test, vi } from 'vitest';
import { nativeBookmarkFolders, sortNativeBookmarkFolder } from '../src/bookmark-folders-first.js';

type Node = chrome.bookmarks.BookmarkTreeNode;
const folder = (id: string, extra: Partial<Node> = {}): Node => ({ id, title: id, parentId: 'parent', ...extra });
const bookmark = (id: string): Node => folder(id, { url: `https://example.test/${id}` });

function fixture(nodes: Node[]) {
  const children = nodes.map((node, index) => ({ ...node, index }));
  const parent = folder('parent', { parentId: '1' });
  const api = {
    get: vi.fn(async (id: string | string[]) => [parent.id === id ? parent : children.find(node => node.id === id)!].filter(Boolean)),
    getChildren: vi.fn(async () => children.map(node => ({ ...node }))),
    getTree: vi.fn(async () => []),
    move: vi.fn(async (id: string, destination: { parentId?: string; index?: number }) => {
      const [node] = children.splice(children.findIndex(child => child.id === id), 1);
      children.splice(destination.index!, 0, node!);
      children.forEach((child, index) => { child.index = index; });
      return node!;
    }),
  };
  return { api, parent, children, ids: () => children.map(node => node.id) };
}
const enabled = async () => true;
const excluded = async () => false;

test('uses the minimum folder moves for every interleaving of up to seven siblings', async () => {
  for (let size = 0; size <= 7; size += 1) {
    for (let mask = 0; mask < 2 ** size; mask += 1) {
      const original = Array.from({ length: size }, (_, i) => mask & (1 << i) ? folder(`f${i}`) : bookmark(`b${i}`));
      const f = fixture(original);
      await sortNativeBookmarkFolder(f.api, 'parent', enabled, excluded);
      const firstBookmark = original.findIndex(node => node.url !== undefined);
      // Every folder behind the first bookmark must move at least once when bookmarks cannot move.
      const minimum = firstBookmark < 0 ? 0 : original.slice(firstBookmark).filter(node => node.url === undefined).length;
      expect(f.api.move).toHaveBeenCalledTimes(minimum);
      expect(f.ids()).toEqual([...original.filter(node => node.url === undefined), ...original.filter(node => node.url !== undefined)].map(node => node.id));
      expect(f.api.move.mock.calls.every(([id]) => original.find(node => node.id === id)?.url === undefined)).toBe(true);
    }
  }
});

test('groups native children stably with only necessary moves, then becomes a no-op', async () => {
  const f = fixture([bookmark('x'), folder('a'), bookmark('y'), folder('b'), bookmark('z')]);
  await sortNativeBookmarkFolder(f.api, 'parent', enabled, excluded);
  expect(f.ids()).toEqual(['a', 'b', 'x', 'y', 'z']);
  expect(f.api.move.mock.calls).toEqual([['a', { parentId: 'parent', index: 0 }], ['b', { parentId: 'parent', index: 1 }]]);
  await sortNativeBookmarkFolder(f.api, 'parent', enabled, excluded);
  expect(f.api.move).toHaveBeenCalledTimes(2);
});

test('top saves settle at the start of the bookmark group and new folders join its end', async () => {
  const f = fixture([bookmark('new'), folder('a'), folder('b'), bookmark('old'), folder('new-folder')]);
  await sortNativeBookmarkFolder(f.api, 'parent', enabled, excluded);
  expect(f.ids()).toEqual(['a', 'b', 'new-folder', 'new', 'old']);
});

test('turning off midway stops further moves without undoing completed grouping', async () => {
  const f = fixture([bookmark('x'), folder('a'), folder('b')]);
  await sortNativeBookmarkFolder(f.api, 'parent', async () => f.api.move.mock.calls.length === 0, excluded);
  expect(f.ids()).toEqual(['a', 'x', 'b']);
  await sortNativeBookmarkFolder(f.api, 'parent', async () => false, excluded);
  expect(f.ids()).toEqual(['a', 'x', 'b']);
});

test('managed nodes, separators and subscription roots anchor sortable runs', async () => {
  const f = fixture([bookmark('x'), folder('a'), folder('subscription'), bookmark('y'), folder('b'),
    folder('separator', { type: 'separator' }), bookmark('z'), folder('c'), folder('managed', { unmodifiable: 'managed' })]);
  await sortNativeBookmarkFolder(f.api, 'parent', enabled, async id => id === 'subscription');
  expect(f.ids()).toEqual(['a', 'x', 'subscription', 'b', 'y', 'separator', 'c', 'z', 'managed']);
});

test.each(['root', 'managed', 'subscription'])('does not reorder a protected %s parent', async kind => {
  const f = fixture([bookmark('x'), folder('a')]);
  if (kind === 'root') delete f.parent.parentId;
  if (kind === 'managed') f.parent.unmodifiable = 'managed';
  await sortNativeBookmarkFolder(f.api, 'parent', enabled, async () => kind === 'subscription');
  expect(f.api.move).not.toHaveBeenCalled();
});

test.each(['delete', 'drag', 'reorder'])('does not overwrite a concurrent %s', async kind => {
  const f = fixture([bookmark('x'), folder('a'), bookmark('y')]);
  f.api.get.mockImplementation(async id => {
    if (id === 'parent') return [f.parent];
    if (kind === 'delete') return [];
    if (kind === 'drag') return [folder('a', { parentId: 'elsewhere' })];
    f.children.reverse();
    return [folder('a')];
  });
  await sortNativeBookmarkFolder(f.api, 'parent', enabled, excluded);
  expect(f.api.move).not.toHaveBeenCalled();
});

test('ignores a deleted parent but propagates API failures for retry', async () => {
  const f = fixture([]);
  f.api.get.mockRejectedValueOnce(new Error("Can't find bookmark for id."));
  await expect(sortNativeBookmarkFolder(f.api, 'parent', enabled, excluded)).resolves.toBe(false);
  f.api.get.mockRejectedValueOnce(new Error('storage_failed'));
  await expect(sortNativeBookmarkFolder(f.api, 'parent', enabled, excluded)).rejects.toThrow('storage_failed');
});

test('walks nested personal folders while excluding root containers, managed and subscription trees', () => {
  const tree = [folder('0', { parentId: undefined, children: [
    folder('bar', { parentId: '0', folderType: 'bookmarks-bar', children: [bookmark('x'), folder('nested'),
      folder('subscription', { children: [folder('owned')] })] }),
    folder('2', { parentId: '0' }),
    folder('managed', { parentId: '0', folderType: 'managed', unmodifiable: 'managed', children: [folder('policy')] }),
    folder('unknown', { parentId: '0', children: [folder('unsupported')] }),
  ] })];
  expect(nativeBookmarkFolders(tree, new Set(['subscription'])).sort()).toEqual(['2', 'bar', 'nested']);
});
