// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { folderPinState, loadPinView, loadResultPins, pinDropAfterAllowed, pinDropAllowed, projectPinnedChildren, togglePin, type PinView } from '../src/bookmark-manager-pins.js';
import { renderManagerRow, type RowHost } from '../src/bookmark-manager-rows.js';
import type { NativeNode } from '../src/bookmark-manager-dom.js';

const node = (id: string, index: number, url?: string): NativeNode => ({ id, title: id, parentId: 'f', index, ...(url ? { url } : {}) });
// Native order: folder, pinned p1, pinned p2, others a and b.
const children = [node('sub', 0), node('p1', 1, 'https://p1.test/'), node('p2', 2, 'https://p2.test/'), node('a', 3, 'https://a.test/'), node('b', 4, 'https://b.test/')];
const byId = new Map(children.map(child => [child.id, child]));
const view = (blockers: PinView['blockers'] = []): PinView => ({ folderId: 'f', blockers, pinned: new Set(['p1', 'p2']) });
const allowed = (from: string, to: string, pins = view()) => pinDropAllowed(pins, byId.get(from), byId.get(to)!, children);
const allowedAfter = (from: string, to: string, pins = view()) => pinDropAfterAllowed(pins, byId.get(from), byId.get(to)!, children);
const state = (id: string, blockers: PinView['blockers'] = []) => folderPinState(view(blockers), byId.get(id)!);

let sendMessage: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sendMessage = vi.fn();
  vi.stubGlobal('chrome', { runtime: { sendMessage, getURL: (path: string) => `chrome-extension://test${path}` } });
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('manager pin projection', () => {
  test('where pins apply, pinned bookmarks lead the bookmarks in their own order', () => {
    const shuffled = [children[0]!, children[3]!, children[2]!, children[4]!, children[1]!];
    expect(projectPinnedChildren(shuffled, view()).map(child => child.id)).toEqual(['sub', 'p2', 'p1', 'a', 'b']);
  });

  test('paused pins keep the native order', () => {
    const shuffled = [children[0]!, children[3]!, children[1]!];
    expect(projectPinnedChildren(shuffled, view(['insert_bottom'])).map(child => child.id)).toEqual(['sub', 'a', 'p1']);
  });

  test('the worker decides eligibility; no answer reads as read only', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, folders: { f: ['folder_unorganized'] } });
    const notes = new Map([['p1', { pinned: true }]]) as never;
    await expect(loadPinView('f', children, notes)).resolves.toEqual({ folderId: 'f', blockers: ['folder_unorganized'], pinned: new Set(['p1']) });
    expect(sendMessage).toHaveBeenCalledWith({ kind: 'known.bookmarks.pin.status', folderIds: ['f'] });
    sendMessage.mockRejectedValueOnce(new Error('no worker'));
    expect((await loadPinView('f', children, notes)).blockers).toEqual(['folder_read_only']);
  });
});

describe('manager drag rules', () => {
  test('each group reorders inside itself', () => {
    expect(allowed('p2', 'p1')).toBe(true);
    expect(allowed('b', 'a')).toBe(true);
  });

  test('a pinned bookmark may land at the end of the pinned section, never among the others', () => {
    expect(allowed('p1', 'a')).toBe(true);
    expect(allowed('p1', 'b')).toBe(false);
  });

  test('an unpinned bookmark never lands among the pinned ones', () => {
    expect(allowed('a', 'p1')).toBe(false);
    expect(allowed('b', 'p2')).toBe(false);
  });

  test('without pins in force the order is free', () => {
    expect(allowed('a', 'p1', view(['folders_first_off']))).toBe(true);
    expect(pinDropAllowed(undefined, byId.get('a'), byId.get('p1')!, children)).toBe(true);
  });
});

describe('manager drag after rules', () => {
  test('each group reorders inside itself', () => {
    expect(allowedAfter('p1', 'p2')).toBe(true);
    expect(allowedAfter('a', 'b')).toBe(true);
  });

  test('a pinned bookmark may not land after an unpinned bookmark', () => {
    expect(allowedAfter('p1', 'a')).toBe(false);
    expect(allowedAfter('p2', 'b')).toBe(false);
  });

  test('an unpinned bookmark may land after the last pinned bookmark, never after earlier pinned bookmarks', () => {
    expect(allowedAfter('a', 'p2')).toBe(true);
    expect(allowedAfter('a', 'p1')).toBe(false);
  });

  test('without pins in force the order after is free', () => {
    expect(allowedAfter('a', 'p1', view(['folders_first_off']))).toBe(true);
    expect(pinDropAfterAllowed(undefined, byId.get('a'), byId.get('p1')!, children)).toBe(true);
  });
});

describe('manager pin button', () => {
  const host = (pin = vi.fn()): RowHost => ({ openFolder: vi.fn(), edit: vi.fn(), menu: vi.fn(), select: vi.fn(), dragSource: () => undefined,
    setDragSource: vi.fn(), dropInto: vi.fn(), dropBefore: vi.fn(), pin });

  test('a pin stays in view; the offer to pin waits on hover', () => {
    const pinned = renderManagerRow(byId.get('p1')!, { pin: { pinned: true, available: true } }, host());
    const button = pinned.querySelector<HTMLButtonElement>('.mgr-actions > .mgr-pin');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.getAttribute('aria-label')).toBe('Unpin p1');
    const other = renderManagerRow(byId.get('a')!, { pin: { pinned: false, available: true } }, host());
    expect(other.querySelector('.row-actions-hover > .mgr-pin')?.getAttribute('aria-pressed')).toBe('false');
    expect(other.querySelector('.mgr-pin')?.hasAttribute('aria-disabled')).toBe(false);
  });

  test('where pins are off, the offer reads disabled and a kept pin reads paused', () => {
    const other = renderManagerRow(byId.get('a')!, { pin: { pinned: false, available: false } }, host());
    expect(other.querySelector('.mgr-pin')?.getAttribute('aria-disabled')).toBe('true');
    const paused = renderManagerRow(byId.get('p1')!, { pin: { pinned: true, available: false } }, host());
    expect(paused.querySelector<HTMLElement>('.mgr-pin')?.dataset.paused).toBe('true');
  });

  test('search rows and hosts without pins show no pin button', () => {
    expect(renderManagerRow(byId.get('a')!, {}, host()).querySelector('.mgr-pin')).toBeNull();
  });
});

describe('manager pin toggle', () => {
  test('pinning where pins are off opens the conditions instead of asking the worker', async () => {
    await togglePin(byId.get('a')!, state('a', ['insert_bottom', 'folder_unorganized']), null, vi.fn());
    expect(sendMessage).not.toHaveBeenCalled();
    const states = Array.from(document.querySelectorAll('.mgr-pin-condition-list > li')).map(item => (item as HTMLElement).dataset.met);
    expect(states).toEqual(['false', 'true', 'false']);
    expect(document.querySelector('dialog .btn-primary')?.textContent).toBe('Open Saving settings');
  });

  test('a read-only folder explains itself without settings to change', async () => {
    await togglePin(byId.get('a')!, state('a', ['folder_read_only']), null, vi.fn());
    expect(document.querySelector('.mgr-pin-condition-list')).toBeNull();
    expect(document.querySelector('dialog .btn-primary')).toBeNull();
  });

  test('unpinning is always asked of the worker, even where pins are paused', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, blockers: ['insert_bottom'] });
    const feedback = vi.fn();
    await togglePin(byId.get('p1')!, state('p1', ['insert_bottom']), null, feedback);
    expect(sendMessage).toHaveBeenCalledWith({ kind: 'known.bookmarks.pin.set', userGesture: true, nativeId: 'p1', pinned: false });
    expect(feedback).toHaveBeenCalledWith('Unpinned.', 'ok');
  });

  test('a pin the worker refuses shows its conditions', async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'not_available', blockers: ['folders_first_off'] });
    await togglePin(byId.get('a')!, state('a'), null, vi.fn());
    expect(document.querySelectorAll('.mgr-pin-condition-list > li[data-met="false"]')).toHaveLength(1);
  });
});

describe('pins on search and tag results', () => {
  const result = (id: string, parentId: string, extra: Partial<NativeNode> = {}): NativeNode =>
    ({ id, title: id, parentId, url: `https://${id}.test/`, ...extra });

  test('each bookmark reads its own folder, and many folders are asked in batches the worker accepts', async () => {
    const nodes = Array.from({ length: 70 }, (_, index) => result(`r${index}`, `folder${index}`));
    sendMessage.mockImplementation(async ({ folderIds }: { folderIds: string[] }) => ({ ok: true,
      folders: Object.fromEntries(folderIds.map(id => [id, id === 'folder3' ? ['insert_bottom'] : []])) }));
    const pins = await loadResultPins(nodes, new Map([['r1', { pinned: true }]]) as never);
    expect(sendMessage.mock.calls.map(([message]) => message.folderIds.length)).toEqual([64, 6]);
    expect(pins.get('r1')).toEqual({ pinned: true, blockers: [] });
    expect(pins.get('r3')).toEqual({ pinned: false, blockers: ['insert_bottom'] });
  });

  test('folders, managed bookmarks and an unreachable worker never offer a pin that would work', async () => {
    sendMessage.mockRejectedValue(new Error('no worker'));
    const pins = await loadResultPins([result('a', 'f'), result('m', 'f', { unmodifiable: 'managed' }), { id: 'sub', title: 'sub', parentId: 'f' }], new Map());
    expect([...pins.keys()]).toEqual(['a']);
    expect(pins.get('a')?.blockers).toEqual(['folder_read_only']);
  });

  test('a folder view answers only for its own children', () => {
    expect(folderPinState(view(), byId.get('p1')!)).toEqual({ pinned: true, blockers: [] });
    expect(folderPinState(view(), byId.get('sub')!)).toBeUndefined();
    expect(folderPinState(view(), { id: 'x', title: 'x', parentId: 'elsewhere', url: 'https://x.test/' })).toBeUndefined();
  });
});
