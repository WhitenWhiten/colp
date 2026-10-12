import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { projectVisibleChildren } from '../src/bookmark-manager-order.js';

test('folders-first is a stable display projection and never mutates native order', () => {
  const native = [
    { id: 'folder-a' },
    { id: 'bookmark-x', url: 'https://x.example/' },
    { id: 'folder-b' },
    { id: 'bookmark-y', url: 'https://y.example/' },
  ] as const;
  assert.deepEqual(projectVisibleChildren(native, true).map(({ id }) => id),
    ['folder-a', 'folder-b', 'bookmark-x', 'bookmark-y']);
  assert.deepEqual(projectVisibleChildren(native, false).map(({ id }) => id),
    ['folder-a', 'bookmark-x', 'folder-b', 'bookmark-y']);
  assert.deepEqual(native.map(({ id }) => id),
    ['folder-a', 'bookmark-x', 'folder-b', 'bookmark-y']);
});

test('manager applies placement only to new bookmarks and reads live children', async () => {
  const source = await readFile(new URL('../src/bookmark-manager.ts', import.meta.url), 'utf8');
  const create = await readFile(new URL('../src/bookmark-manager-create.ts', import.meta.url), 'utf8');
  assert.match(create, /readEffectiveBookmarkPreferences/u);
  assert.match(create, /savePagesThroughNativeIngress/u);
  assert.match(create, /if \(!url\)/u);
  assert.match(create, /api\.create\(\{ parentId, title \}\)/u);

  assert.match(source, /createManagerNode/u);
});

test('canDropIntoNode prevents self and descendants, allows valid folders', async () => {
  const { canDropIntoNode } = await import('../src/bookmark-manager-order.js');
  const child = { id: 'c1', title: 'child', parentId: 'f1' };
  const parent = { id: 'f1', title: 'parent', children: [child] };
  const sibling = { id: 'f2', title: 'sibling' };
  const bookmark = { id: 'b1', title: 'bm', url: 'https://b.com' };
  const managed = { id: 'm1', title: 'managed', unmodifiable: 'managed' };

  assert.equal(canDropIntoNode(parent, parent), false);
  assert.equal(canDropIntoNode(parent, child), false);
  assert.equal(canDropIntoNode(parent, bookmark), false);
  assert.equal(canDropIntoNode(parent, managed), false);
  assert.equal(canDropIntoNode(parent, sibling), true);
  assert.equal(canDropIntoNode(child, sibling), true);
  assert.equal(canDropIntoNode(bookmark, parent), true);
  assert.equal(canDropIntoNode(bookmark, sibling), true);
});

test('foldersFirst=true drag rules for folders and bookmarks', async () => {
  const { canDropBeforeNode, canDropAfterNode } = await import('../src/bookmark-manager-order.js');
  const f1 = { id: 'f1', title: 'Folder 1' };
  const f2 = { id: 'f2', title: 'Folder 2' };
  const b1 = { id: 'b1', title: 'Bookmark 1', url: 'https://1.com' };
  const b2 = { id: 'b2', title: 'Bookmark 2', url: 'https://2.com' };
  const visible = [f1, f2, b1, b2];
  const opts = { foldersFirst: true, visibleChildren: visible };

  // Folders reordering
  assert.equal(canDropBeforeNode(f2, f1, opts), true);
  assert.equal(canDropAfterNode(f1, f2, opts), true);
  assert.equal(canDropBeforeNode(f1, f2, opts), true);
  assert.equal(canDropAfterNode(f2, f1, opts), true);

  // Folder relative to bookmarks:
  // Folder can drop before the first bookmark (lands at boundary between folders and bookmarks)
  assert.equal(canDropBeforeNode(f1, b1, opts), true);
  // Folder CANNOT drop before subsequent bookmarks
  assert.equal(canDropBeforeNode(f1, b2, opts), false);
  // Folder CANNOT drop after any bookmark
  assert.equal(canDropAfterNode(f1, b1, opts), false);
  assert.equal(canDropAfterNode(f1, b2, opts), false);

  // Bookmarks relative to folders:
  // Bookmark CANNOT drop before any folder
  assert.equal(canDropBeforeNode(b1, f1, opts), false);
  assert.equal(canDropBeforeNode(b1, f2, opts), false);
  // Bookmark CANNOT drop after intermediate folder
  assert.equal(canDropAfterNode(b1, f1, opts), false);
  // Bookmark CAN drop after the last folder (top of bookmarks section)
  assert.equal(canDropAfterNode(b1, f2, opts), true);

  // Bookmarks reordering among bookmarks
  assert.equal(canDropBeforeNode(b2, b1, opts), true);
  assert.equal(canDropAfterNode(b1, b2, opts), true);
});

test('foldersFirst=false allows free interleaving of folders and bookmarks', async () => {
  const { canDropBeforeNode, canDropAfterNode } = await import('../src/bookmark-manager-order.js');
  const f1 = { id: 'f1', title: 'Folder 1' };
  const b1 = { id: 'b1', title: 'Bookmark 1', url: 'https://1.com' };
  const visible = [f1, b1];
  const opts = { foldersFirst: false, visibleChildren: visible };

  assert.equal(canDropBeforeNode(f1, b1, opts), true);
  assert.equal(canDropAfterNode(f1, b1, opts), true);
  assert.equal(canDropBeforeNode(b1, f1, opts), true);
  assert.equal(canDropAfterNode(b1, f1, opts), true);
});

test('createDropValidator reads dynamic nodesById via getter and validates reordering', async () => {
  const { createDropValidator } = await import('../src/bookmark-manager-order.js');
  let nodesById = new Map<string, any>();
  const validator = createDropValidator(() => nodesById, () => true, () => ({ id: 'f_parent' }));

  // Initially empty map - cannot drop
  assert.equal(validator.canDropBefore('f2', { id: 'f1', parentId: 'f_parent' } as any), false);

  // After refresh, nodesById is repopulated
  const f1 = { id: 'f1', parentId: 'f_parent', title: 'Folder 1' };
  const f2 = { id: 'f2', parentId: 'f_parent', title: 'Folder 2' };
  const parent = { id: 'f_parent', title: 'Parent', children: [f1, f2] };
  nodesById = new Map<string, any>([['f_parent', parent], ['f1', f1], ['f2', f2]]);

  // With populated map, dynamic getter reads fresh map
  assert.equal(validator.canDropBefore('f2', f1 as any), true);
  assert.equal(validator.canDropAfter('f1', f2 as any), true);
  assert.equal(validator.canDropInto('f1', 'f2'), true);
});

