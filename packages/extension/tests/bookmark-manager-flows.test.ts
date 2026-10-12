// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createBookmarkManager } from '../src/bookmark-manager.js';
import type { NativeNode } from '../src/bookmark-manager-dom.js';

const bookmark = (id: string, parentId: string, index: number, title: string): NativeNode =>
  ({ id, parentId, index, title, url: `https://${id}.example/` });
const tree = (): NativeNode[] => [{ id: '0', title: '', children: [
  { id: '1', parentId: '0', index: 0, title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
    { id: 'f1', parentId: '1', index: 0, title: 'Programming', children: [
      bookmark('b1', 'f1', 0, 'Alpha guide'), bookmark('b2', 'f1', 1, 'Beta guide'), bookmark('b3', 'f1', 2, 'Gamma')] },
    // Pins are off in Reading: new bookmarks go to its bottom.
    { id: 'f2', parentId: '1', index: 1, title: 'Reading', children: [bookmark('b4', 'f2', 0, 'Delta guide')] },
  ] },
] }];
const flatten = (nodes: readonly NativeNode[]): NativeNode[] => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);

let sendMessage: ReturnType<typeof vi.fn>;
const byId = (id: string) => document.getElementById(id)!;
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('#manager-list .mgr-row')).map((row) => row.dataset.id);
const row = (id: string) => document.querySelector<HTMLElement>(`#manager-list .mgr-row[data-id="${id}"]`)!;
const shown = (id: string) => !(byId(id) as HTMLElement).hidden;

async function mount() {
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  const manager = createBookmarkManager({
    pane: byId('bookmarks-card'), gate: byId('manager-gate'), gateButton: byId('manager-grant') as HTMLButtonElement,
    reloadHint: byId('manager-reload-hint'), body: byId('manager-body'), tree: byId('manager-tree'), list: byId('manager-list'),
    path: byId('manager-path'), search: byId('manager-search') as HTMLInputElement,
    newFolder: byId('manager-new-folder') as HTMLButtonElement, newBookmark: byId('manager-new-bookmark') as HTMLButtonElement,
    feedback: byId('manager-feedback'), card: byId('manager-card'), selectToggle: byId('manager-select') as HTMLButtonElement,
    syncState: byId('manager-sync-state'),
  });
  await manager.activate();
  await vi.waitFor(() => expect(rows()).toEqual(['f1', 'f2']));
  return manager;
}

async function openFolder(title: string, expected: string[]) {
  Array.from(document.querySelectorAll<HTMLButtonElement>('#manager-tree .mgr-folder')).find((button) => button.textContent?.includes(title))!.click();
  await vi.waitFor(() => expect(rows()).toEqual(expected));
}

async function search(query: string, expected: string[]) {
  const field = byId('manager-search') as HTMLInputElement;
  field.value = query; field.dispatchEvent(new Event('input'));
  await vi.waitFor(() => expect(rows()).toEqual(expected));
}

function menuFor(id: string): HTMLButtonElement[] {
  row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.mgr-menu-item'));
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  sendMessage = vi.fn(async (message: { kind: string; folderIds?: string[] }) => {
    if (message.kind === 'known.bookmarks.pin.status') {
      return { ok: true, folders: Object.fromEntries(message.folderIds!.map((id) => [id, id === 'f2' ? ['insert_bottom'] : []])) };
    }
    if (message.kind === 'known.roots.boundaries') return { ok: true, boundaries: { selected: [], privateLocal: [] } };
    if (message.kind === 'known.batch.preview') {
      const ids = (message as unknown as { nativeIds: string[] }).nativeIds;
      return { ok: true, preview: { operation: 'delete', digest: 'sha256:p', requiresSecondConfirm: false, crossBoundary: false,
        items: ids.map((nativeId) => ({ nativeId, title: nativeId })) } };
    }
    if (message.kind === 'known.batch.confirm') {
      return { ok: true, status: { planId: 'p', commandId: 'c', operation: 'delete', state: 'completed', reused: false,
        applied: 3, failed: 0, changed: 0, undone: 0, items: [], undoExpiresAt: Date.now() + 60_000 } };
    }
    return { ok: false, error: 'request_invalid' };
  });
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage, onMessage: event(), getURL: (path: string) => `chrome-extension://test${path}` },
    permissions: { contains: vi.fn(async () => true) },
    bookmarks: {
      getTree: vi.fn(async () => tree()),
      search: vi.fn(async ({ query }: { query: string }) => flatten(tree()).filter((node) => node.url && node.title.toLowerCase().includes(query.toLowerCase()))),
      move: vi.fn(async (id: string, destination: { parentId?: string; index?: number }) => ({ id, ...destination })),
      onCreated: event(), onRemoved: event(), onChanged: event(), onMoved: event(),
    },
  });
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('search results', () => {
  test('offer pins, each read against its own folder', async () => {
    await mount();
    await search('guide', ['b1', 'b2', 'b4']);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ kind: 'known.bookmarks.pin.status', folderIds: ['f1', 'f2'] }));
    expect(row('b1').querySelector('.mgr-pin')?.getAttribute('aria-label')).toBe('Pin Alpha guide');
    expect(row('b1').querySelector('.mgr-pin')?.hasAttribute('aria-disabled')).toBe(false);
    // Reading does not take pins; the button still explains why instead of vanishing.
    expect(row('b4').querySelector('.mgr-pin')?.getAttribute('aria-disabled')).toBe('true');
    expect(menuFor('b1').map((item) => item.textContent)).toContain('Pin');
  });

  test('Show in folder opens the folder a result lives in and picks the row out', async () => {
    await mount();
    await search('delta', ['b4']);
    const show = menuFor('b4').find((item) => item.textContent === 'Show in folder');
    expect(show).toBeDefined();
    show!.click();
    await vi.waitFor(() => expect(byId('manager-path').textContent).toBe('Bookmarks bar›Reading'));
    expect(rows()).toEqual(['b4']);
    expect((byId('manager-search') as HTMLInputElement).value).toBe('');
    expect(row('b4').dataset.captureLocated).toBe('true');
  });

  test('a folder view offers no Show in folder', async () => {
    await mount();
    await openFolder('Programming', ['b1', 'b2', 'b3']);
    expect(menuFor('b1').map((item) => item.textContent)).not.toContain('Show in folder');
  });
});

describe('folder view', () => {
  test('a folder row counts what it holds the way the tree does: everything inside, however deep', async () => {
    await mount();
    expect(row('f1').querySelector('.mgr-meta')?.textContent).toBe('3 bookmarks');
    const tree = Array.from(document.querySelectorAll<HTMLElement>('#manager-tree .mgr-folder')).find((node) => node.textContent?.includes('Programming'));
    expect(tree?.querySelector('em')?.textContent).toBe('3');
  });

  test('New bookmark from search results goes back to the open folder and starts there', async () => {
    await mount();
    await openFolder('Reading', ['b4']);
    await search('guide', ['b1', 'b2', 'b4']);
    byId('manager-new-bookmark').click();
    await vi.waitFor(() => expect(document.querySelector('#manager-list .mgr-composer')).not.toBeNull());
    expect((byId('manager-search') as HTMLInputElement).value).toBe('');
    expect(byId('manager-path').textContent).toBe('Bookmarks bar›Reading');
  });
});

describe('selection', () => {
  test('the bar sits under the rows, says what to do, and Select all checks every row on screen', async () => {
    await mount();
    await openFolder('Programming', ['b1', 'b2', 'b3']);
    expect(byId('manager-list').nextElementSibling).toBe(byId('manager-selection-bar'));
    byId('manager-select').click();
    expect(shown('manager-selection-count')).toBe(true);
    expect(byId('manager-selection-count').textContent).toBe('Check items to move, rename, tag or delete them.');
    expect(shown('manager-batch-delete')).toBe(false);
    expect(byId('manager-select-all').textContent).toBe('Select all');

    byId('manager-select-all').click();
    expect(byId('manager-selection-count').textContent).toBe('3 selected');
    expect(shown('manager-batch-move') && shown('manager-batch-delete')).toBe(true);
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('#manager-list .mgr-select')).every((box) => box.checked)).toBe(true);
    expect(byId('manager-select-all').textContent).toBe('Clear selection');
    byId('manager-select-all').click();
    expect(byId('manager-selection-count').textContent).toBe('Check items to move, rename, tag or delete them.');
  });

  test('belongs to the view: opening another folder or searching drops it', async () => {
    await mount();
    await openFolder('Programming', ['b1', 'b2', 'b3']);
    byId('manager-select').click(); byId('manager-select-all').click();
    expect(byId('manager-selection-count').textContent).toBe('3 selected');
    await openFolder('Reading', ['b4']);
    // Still selecting, but nothing out of sight is selected: Delete can't reach rows the user can't see.
    expect(byId('manager-selection-count').textContent).toBe('Check items to move, rename, tag or delete them.');
    expect(shown('manager-batch-delete')).toBe(false);
    byId('manager-select-all').click();
    expect(byId('manager-selection-count').textContent).toBe('1 selected');
    await search('guide', ['b1', 'b2', 'b4']);
    expect(shown('manager-batch-delete')).toBe(false);
  });

  test('a batch that went through ends the selection it acted on', async () => {
    await mount();
    await openFolder('Programming', ['b1', 'b2', 'b3']);
    byId('manager-select').click(); byId('manager-select-all').click();
    byId('manager-batch-delete').click();
    await vi.waitFor(() => expect(shown('manager-batch-undo')).toBe(true));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.batch.confirm', nativeIds: ['b1', 'b2', 'b3'] }));
    expect(byId('manager-card').hasAttribute('data-selecting')).toBe(false);
    expect(shown('manager-selection-count')).toBe(false);
  });

  test('Escape leaves selection', async () => {
    await mount();
    await openFolder('Programming', ['b1', 'b2', 'b3']);
    byId('manager-select').click(); byId('manager-select-all').click();
    row('b1').querySelector<HTMLInputElement>('.mgr-select')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(byId('manager-card').hasAttribute('data-selecting')).toBe(false);
    expect(byId('manager-select').textContent).toBe('Select');
    expect(shown('manager-selection-count')).toBe(false);
  });
});

describe('drag and drop folder and bookmark reordering in mounted manager', () => {
  test('dragging folder over another folder allows before, after and into', async () => {
    await mount();
    const move = vi.mocked(chrome.bookmarks.move);
    move.mockClear();

    // Start dragging f2
    row('f2').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));

    const targetRow = row('f1');
    vi.spyOn(targetRow, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 40, height: 40, width: 200, left: 0, right: 200, x: 0, y: 0, toJSON: () => ({}),
    });

    // Dragover near top (ratio = 4/40 = 0.1) -> 'before'
    const topOver = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 4 });
    targetRow.dispatchEvent(topOver);
    expect(topOver.defaultPrevented).toBe(true);
    expect(targetRow.dataset.drop).toBe('before');

    // Drop on 'before' moves f2 before f1 (f1.index = 0, so target index = 0)
    targetRow.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    expect(move).toHaveBeenCalledWith('f2', { parentId: '1', index: 0 });
    expect(targetRow.dataset.drop).toBeUndefined();

    // Start dragging f2 again
    row('f2').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));

    // Dragover near bottom (ratio = 36/40 = 0.9) -> 'after'
    const bottomOver = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 36 });
    targetRow.dispatchEvent(bottomOver);
    expect(bottomOver.defaultPrevented).toBe(true);
    expect(targetRow.dataset.drop).toBe('after');

    // Drop on 'after' moves f2 after f1 (f1.index = 0, so target index = 0 + 1 = 1)
    targetRow.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    expect(move).toHaveBeenCalledWith('f2', { parentId: '1', index: 1 });
    expect(targetRow.dataset.drop).toBeUndefined();
  });
});
