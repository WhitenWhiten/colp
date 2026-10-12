import { expect, test, vi } from 'vitest';
import { isOrganizedFolder, pinBlockers, planPinAppend, planPinnedMoves, sortPinnedBookmarks, unpinnedTopIndex } from '../src/bookmark-pin-order.js';

type Node = chrome.bookmarks.BookmarkTreeNode;
const folder = (id: string, extra: Partial<Node> = {}): Node => ({ id, title: id, parentId: 'parent', ...extra });
const bookmark = (id: string, extra: Partial<Node> = {}): Node => folder(id, { url: `https://example.test/${id}`, ...extra });
const none = new Set<string>();

function fixture(nodes: Node[]) {
  const children = nodes.map((node, index) => ({ ...node, index }));
  const api = {
    get: vi.fn(async (id: string | string[]) => children.filter(node => node.id === id).map(node => ({ ...node }))),
    getChildren: vi.fn(async () => children.map(node => ({ ...node }))),
    move: vi.fn(async (id: string, destination: { parentId?: string; index?: number }) => {
      const [node] = children.splice(children.findIndex(child => child.id === id), 1);
      children.splice(destination.index!, 0, node!);
      children.forEach((child, index) => { child.index = index; });
      return node!;
    }),
  };
  return { api, ids: () => children.map(node => node.id) };
}

test('organized means no folder after a bookmark and no fixed item among bookmarks', () => {
  expect(isOrganizedFolder([folder('a'), bookmark('x'), bookmark('y')], none)).toBe(true);
  expect(isOrganizedFolder([], none)).toBe(true);
  expect(isOrganizedFolder([bookmark('x'), folder('a')], none)).toBe(false);
  expect(isOrganizedFolder([folder('a'), bookmark('x', { unmodifiable: 'managed' })], none)).toBe(false);
  expect(isOrganizedFolder([folder('a'), bookmark('x'), bookmark('s')], new Set(['s']))).toBe(false);
  expect(isOrganizedFolder([folder('a', { unmodifiable: 'managed' }), bookmark('x')], none)).toBe(true);
});

test('names every unmet condition, and read-only folders alone', () => {
  const top = { bookmarkInsertPosition: 'top' as const, foldersFirst: true };
  const parent = folder('parent', { parentId: '1' });
  expect(pinBlockers({ preferences: top, folder: parent, children: [folder('a'), bookmark('x')], excluded: none })).toEqual([]);
  expect(pinBlockers({ preferences: { bookmarkInsertPosition: 'bottom', foldersFirst: false }, folder: parent,
    children: [bookmark('x'), folder('a')], excluded: none })).toEqual(['insert_bottom', 'folders_first_off', 'folder_unorganized']);
  expect(pinBlockers({ preferences: top, folder: folder('0', { parentId: undefined }), children: [], excluded: none })).toEqual(['folder_read_only']);
  expect(pinBlockers({ preferences: top, folder: parent, children: [], excluded: new Set(['parent']) })).toEqual(['folder_read_only']);
});

test('the unpinned section starts after folders and leading pins', () => {
  const children = [folder('a'), bookmark('p1'), bookmark('p2'), bookmark('u1')];
  expect(unpinnedTopIndex(children, new Set(['p1', 'p2']))).toBe(3);
  expect(unpinnedTopIndex(children, none)).toBe(1);
  expect(unpinnedTopIndex([folder('a')], none)).toBe(1);
});

test('plans stable upward moves for every pinned/unpinned interleaving', () => {
  for (let size = 0; size <= 7; size += 1) {
    for (let mask = 0; mask < 2 ** size; mask += 1) {
      const nodes = [folder('f'), ...Array.from({ length: size }, (_, i) => bookmark(`b${i}`))];
      const pinned = new Set(Array.from({ length: size }, (_, i) => `b${i}`).filter((_, i) => mask & (1 << i)));
      const order = nodes.map(node => node.id);
      for (const move of planPinnedMoves(nodes, pinned)) {
        const from = order.indexOf(move.id);
        expect(move.index).toBeLessThan(from);
        order.splice(from, 1); order.splice(move.index, 0, move.id);
      }
      const ids = nodes.slice(1).map(node => node.id);
      expect(order).toEqual(['f', ...ids.filter(id => pinned.has(id)), ...ids.filter(id => !pinned.has(id))]);
    }
  }
});

test('sorts live children, then becomes a no-op', async () => {
  const f = fixture([folder('a'), bookmark('u1'), bookmark('p1'), bookmark('u2'), bookmark('p2')]);
  const pinned = new Set(['p1', 'p2']);
  expect(await sortPinnedBookmarks(f.api, 'parent', pinned, async () => true)).toBe(true);
  expect(f.ids()).toEqual(['a', 'p1', 'p2', 'u1', 'u2']);
  expect(f.api.move).toHaveBeenCalledTimes(2);
  expect(await sortPinnedBookmarks(f.api, 'parent', pinned, async () => true)).toBe(true);
  expect(f.api.move).toHaveBeenCalledTimes(2);
});

test('stops without moving when disabled or when the bookmark left the folder', async () => {
  const f = fixture([bookmark('u1'), bookmark('p1')]);
  expect(await sortPinnedBookmarks(f.api, 'parent', new Set(['p1']), async () => false)).toBe(false);
  f.api.get.mockResolvedValueOnce([{ ...bookmark('p1'), parentId: 'elsewhere', index: 0 }]);
  expect(await sortPinnedBookmarks(f.api, 'parent', new Set(['p1']), async () => true)).toBe(false);
  expect(f.api.move).not.toHaveBeenCalled();
});

test('a newly pinned bookmark ends the pinned section, even in an unsorted folder', async () => {
  const f = fixture([folder('a'), bookmark('x'), bookmark('p1'), bookmark('u1'), bookmark('p2')]);
  const pinned = new Set(['p1', 'p2', 'x']);
  expect(await sortPinnedBookmarks(f.api, 'parent', pinned, async () => true, () => undefined, 'x')).toBe(true);
  expect(f.ids()).toEqual(['a', 'p1', 'p2', 'x', 'u1']);
  expect(planPinAppend([folder('a'), bookmark('p1'), bookmark('x')], pinned, 'x')).toEqual([]);
});

test('has enough passes to raise the pins and then move the new one to their end', async () => {
  const f = fixture([bookmark('x'), bookmark('u'), bookmark('p1'), bookmark('p2'), bookmark('p3'), bookmark('p4')]);
  const pinned = new Set(['x', 'p1', 'p2', 'p3', 'p4']);
  expect(await sortPinnedBookmarks(f.api, 'parent', pinned, async () => true, () => undefined, 'x')).toBe(true);
  expect(f.ids()).toEqual(['p1', 'p2', 'p3', 'p4', 'x', 'u']);
  expect(f.api.move).toHaveBeenCalledTimes(8);
});
