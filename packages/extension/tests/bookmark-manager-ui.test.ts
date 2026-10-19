// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { createManagerAnnotations } from '../src/bookmark-manager-annotations.js';
import { renderManagerRow, resolveRowDropMode, type RowHost } from '../src/bookmark-manager-rows.js';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

describe('options bookmark manager UI contract', () => {
  test('manager offers Edge-style management affordances', async () => {
    const source = await read('../src/bookmark-manager.ts');
    const rows = await read('../src/bookmark-manager-rows.ts');
    const menu = await read('../src/bookmark-manager-menu.ts');
    const tree = await read('../src/bookmark-manager-tree.ts');
    // Right-click management menu with the same verbs as the hover actions.
    assert.match(rows, /addEventListener\('contextmenu'/);
    assert.match(source, /'Open in new tab'/);
    assert.match(source, /'Edit bookmark'/);
    assert.match(source, /'Move to…'/);
    assert.match(source, /'Delete'/);
    // Keyboard: Delete removes, F2 edits, Escape closes the menu, the menu key opens it.
    assert.match(source, /event\.key === 'Delete'/);
    assert.match(source, /event\.key === 'F2'/);
    assert.match(source, /event\.key === 'ContextMenu'/);
    assert.match(menu, /event\.key === 'Escape'/);
    // Managed (policy) nodes never get management affordances.
    assert.match(source, /unmodifiable === 'managed'/);
    assert.match(rows, /unmodifiable === 'managed'/);
    // The collection section is pinned above the plain browser tree.
    assert.match(tree, /'Your library'/);
    assert.match(source, /'Not in a synced folder · stays on this browser'/);
    assert.match(source, /projectVisibleChildren\(folder\.children \?\? \[\], foldersFirst\)/u);
    const start = source.indexOf('async function renderSearch');
    const search = source.slice(start, source.indexOf('\n  function ', start + 10));
    assert.doesNotMatch(search, /projectVisibleChildren/u);
    // Real page favicons come from the read-only /_favicon/ resource.
    const dom = await read('../src/bookmark-manager-dom.ts');
    assert.match(dom, /_favicon/);
    for (const file of [source, rows, menu, tree, dom]) assert.doesNotMatch(file, /innerHTML|insertAdjacentHTML|document\.write/);
  });

  test('manager styles cover the menu, focus ring, rows with tags and the library kickers', async () => {
    const css = await read('../options.css');
    assert.match(css, /\.mgr-menu \{/);
    assert.match(css, /\.mgr-menu-item\[data-tone="danger"\]/);
    assert.match(css, /\.mgr-row:focus-visible/);
    assert.match(css, /\.mgr-tree-kicker/);
    assert.match(css, /\.row-actions-hover/);
  });

  test('critical MV3 evidence exercises real bookmark CRUD and keyboard affordances', async () => {
    const e2e = await read('../e2e/mv3-bookmark-manager.spec.ts');
    for (const marker of ['chrome.bookmarks', 'New folder', 'New bookmark', 'Move', 'F2', 'Delete']) {
      assert.match(e2e, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
    }
    const pkg = await read('../package.json');
    assert.match(pkg, /evidence:critical-mv3:inner[^\n]+mv3-bookmark-manager\.spec\.ts/u);
  });

  test('native refreshes preserve a pending composer, open menu and open dialog', async () => {
    const source = await read('../src/bookmark-manager.ts');
    assert.match(source, /editing: hasPendingEditor/u);
    assert.match(source, /background && hasPendingEditor\(\)/u);
    assert.match(source, /composer !== undefined/u);
    assert.match(source, /menu\.isOpen\(\)/u);
    assert.match(source, /querySelector\('dialog\[open\]'\)/u);

    const e2e = await read('../e2e/mv3-bookmark-manager.spec.ts');
    assert.match(e2e, /Concurrent manager event/u);
  });

  test('single delete routes through batch pipeline for confirmation and undo safety net (UX-15)', async () => {
    const source = await read('../src/bookmark-manager.ts');
    assert.match(source, /batch\.beginWithIds\('delete',\s*\[node\.id\]\)/);
  });
});

const noHost: RowHost = {
  openFolder: vi.fn(), edit: vi.fn(), menu: vi.fn(), select: vi.fn(), dragSource: () => undefined, setDragSource: vi.fn(), dropInto: vi.fn(), dropBefore: vi.fn(),
};
const annotation = (tags: string[], note: string | null) => ({ nativeId: '5', url: 'https://example.com/a', tags, note, updatedAt: 1, version: 1 });

describe('bookmark rows show tags and notes without an account', () => {
  beforeEach(() => { vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test${path}` } }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  test('a tagged, annotated bookmark shows its tags and the first line of its note', () => {
    const row = renderManagerRow({ id: '5', title: 'Agents', url: 'https://example.com/a' }, { annotation: annotation(['mcp', 'ai'], 'Compare first\nsecond line') }, noHost);
    expect(Array.from(row.querySelectorAll('.mini-tags .mini-tag')).map((tag) => tag.textContent)).toEqual(['mcp', 'ai']);
    const note = row.querySelector<HTMLElement>('.list-row-note');
    expect(note?.textContent).toBe('Compare first');
    expect(note?.title).toBe('Compare first\nsecond line');
  });

  test('a bookmark without annotations has neither tags nor a note line', () => {
    const row = renderManagerRow({ id: '5', title: 'Agents', url: 'https://example.com/a' }, {}, noHost);
    expect(row.querySelector('.mini-tags')).toBeNull();
    expect(row.querySelector('.list-row-note')).toBeNull();
    expect(row.querySelector('.mgr-meta')?.textContent).toContain('example.com');
  });

  test('hover actions offer edit and more, and managed rows offer none', () => {
    const row = renderManagerRow({ id: '5', title: 'Agents', url: 'https://example.com/a' }, {}, noHost);
    expect(Array.from(row.querySelectorAll('.row-actions-hover button')).map((b) => b.getAttribute('aria-label'))).toEqual(['Edit bookmark Agents', 'More actions Agents']);
    const managed = renderManagerRow({ id: '6', title: 'Managed', url: 'https://example.com/m', unmodifiable: 'managed' }, {}, noHost);
    expect(managed.querySelector('.row-actions-hover')).toBeNull();
  });
});

describe('manager annotations are searchable and local', () => {
  beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  test('saved tags and notes load for rows and are found by search', async () => {
    const annotations = createManagerAnnotations(createBookmarkAnnotationStore);
    const node = { id: '5', title: 'Agents', url: 'https://example.com/a', dateAdded: 10 };
    expect(await annotations.save(node, { tags: ['research'], note: 'Compare with the Oct release' })).toBe(true);
    const loaded = await annotations.load([node, { id: '9', title: 'Folder' }]);
    expect(loaded.get('5')?.tags).toEqual(['research']);
    expect(await annotations.search('research')).toContain('5');
    expect(await annotations.search('Oct release')).toContain('5');
    expect(await annotations.search('unrelated')).toEqual([]);
    annotations.close();
  });

  test('a failing store only means no tags: load and search never throw', async () => {
    const broken = () => { throw new Error('idb unavailable'); };
    const annotations = createManagerAnnotations(broken as never);
    const node = { id: '5', title: 'Agents', url: 'https://example.com/a' };
    expect((await annotations.load([node])).size).toBe(0);
    expect(await annotations.search('x')).toEqual([]);
    expect(await annotations.save(node, { tags: ['a'], note: null })).toBe(false);
  });
});

describe('bookmark manager row drag and drop UX', () => {
  const folder = { id: 'f1', title: 'Work' };
  const bookmark = { id: 'b1', title: 'Article', url: 'https://example.com/art' };

  test('resolveRowDropMode handles folder zones with intuitive thresholds', () => {
    const host: RowHost = {
      ...noHost,
      canDropBefore: () => true,
      canDropAfter: () => true,
      canDropInto: () => true,
    };
    // Top 25%: before
    expect(resolveRowDropMode(folder, 'f2', 0.1, host)).toBe('before');
    expect(resolveRowDropMode(folder, 'f2', 0.24, host)).toBe('before');
    // Middle 50%: into
    expect(resolveRowDropMode(folder, 'f2', 0.25, host)).toBe('into');
    expect(resolveRowDropMode(folder, 'f2', 0.5, host)).toBe('into');
    expect(resolveRowDropMode(folder, 'f2', 0.75, host)).toBe('into');
    // Bottom 25%: after
    expect(resolveRowDropMode(folder, 'f2', 0.76, host)).toBe('after');
    expect(resolveRowDropMode(folder, 'f2', 0.95, host)).toBe('after');
  });

  test('resolveRowDropMode gives entire folder row as into when reorder is forbidden', () => {
    const host: RowHost = {
      ...noHost,
      canDropBefore: () => false,
      canDropAfter: () => false,
      canDropInto: () => true,
    };
    expect(resolveRowDropMode(folder, 'b1', 0.05, host)).toBe('into');
    expect(resolveRowDropMode(folder, 'b1', 0.5, host)).toBe('into');
    expect(resolveRowDropMode(folder, 'b1', 0.95, host)).toBe('into');
  });

  test('resolveRowDropMode allows before/after when into is forbidden', () => {
    const host: RowHost = {
      ...noHost,
      canDropBefore: () => true,
      canDropAfter: () => true,
      canDropInto: () => false,
    };
    expect(resolveRowDropMode(folder, 'f2', 0.2, host)).toBe('before');
    expect(resolveRowDropMode(folder, 'f2', 0.8, host)).toBe('after');
  });

  test('resolveRowDropMode splits bookmark into before (top) and after (bottom)', () => {
    const host: RowHost = {
      ...noHost,
      canDropBefore: () => true,
      canDropAfter: () => true,
    };
    expect(resolveRowDropMode(bookmark, 'b2', 0.3, host)).toBe('before');
    expect(resolveRowDropMode(bookmark, 'b2', 0.7, host)).toBe('after');
  });

  test('renderManagerRow updates dataset.drop on dragover and routes to dropBefore/dropAfter/dropInto on drop', () => {
    const dropBefore = vi.fn();
    const dropAfter = vi.fn();
    const dropInto = vi.fn();
    let dragSourceId: string | undefined = 'f2';
    const host: RowHost = {
      ...noHost,
      dragSource: () => dragSourceId,
      canDropBefore: () => true,
      canDropAfter: () => true,
      canDropInto: () => true,
      dropBefore,
      dropAfter,
      dropInto,
    };

    const row = renderManagerRow(folder, {}, host);
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 40, height: 40, width: 200, left: 0, right: 200, x: 0, y: 0, toJSON: () => ({}),
    });

    // Hover near top (y=4 / 40 = 0.1) -> 'before'
    const topEvent = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 4 });
    row.dispatchEvent(topEvent);
    expect(row.dataset.drop).toBe('before');

    // Drop triggers dropBefore
    const dropBeforeEvent = new Event('drop', { bubbles: true, cancelable: true });
    row.dispatchEvent(dropBeforeEvent);
    expect(dropBefore).toHaveBeenCalledWith(expect.anything(), folder);
    expect(row.dataset.drop).toBeUndefined();

    // Hover near middle (y=20 / 40 = 0.5) -> 'into'
    const middleEvent = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 20 });
    row.dispatchEvent(middleEvent);
    expect(row.dataset.drop).toBe('into');

    // Drop triggers dropInto
    const dropIntoEvent = new Event('drop', { bubbles: true, cancelable: true });
    row.dispatchEvent(dropIntoEvent);
    expect(dropInto).toHaveBeenCalledWith(expect.anything(), folder.id);
    expect(row.dataset.drop).toBeUndefined();

    // Hover near bottom (y=36 / 40 = 0.9) -> 'after'
    const bottomEvent = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 36 });
    row.dispatchEvent(bottomEvent);
    expect(row.dataset.drop).toBe('after');

    // Drop triggers dropAfter
    const dropAfterEvent = new Event('drop', { bubbles: true, cancelable: true });
    row.dispatchEvent(dropAfterEvent);
    expect(dropAfter).toHaveBeenCalledWith(expect.anything(), folder);
    expect(row.dataset.drop).toBeUndefined();
  });
});

