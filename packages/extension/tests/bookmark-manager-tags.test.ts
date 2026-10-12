// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BookmarkAnnotation } from '../src/bookmark-annotation-store.js';
import type { NativeNode } from '../src/bookmark-manager-dom.js';
import { renderManagerRow, type RowHost } from '../src/bookmark-manager-rows.js';
import { countTags, liveAnnotations, matchesTags, openBulkTagDialog, renderTagPath, renderTreeTags, retag, toggleTag,
  TREE_TAG_LIMIT } from '../src/bookmark-manager-tags.js';

const row = (nativeId: string, tags: string[], dateAdded?: number): BookmarkAnnotation =>
  ({ nativeId, url: null, tags, note: null, updatedAt: 1, version: 1, ...(dateAdded === undefined ? {} : { dateAdded }) });

describe('manager tag model', () => {
  test('counts each tag once per bookmark, case-folded, under its most used spelling', () => {
    expect(countTags([row('1', ['Rust', 'rust']), row('2', ['Rust', 'web']), row('3', ['rust']), row('4', ['Rust'])]))
      .toEqual([{ tag: 'Rust', count: 4 }, { tag: 'web', count: 1 }]);
  });

  test('keeps only rows of bookmarks still in the tree with the same creation date', () => {
    const nodes = new Map<string, NativeNode>([
      ['1', { id: '1', title: 'a', url: 'https://a.example', dateAdded: 10 }],
      ['2', { id: '2', title: 'b', url: 'https://b.example', dateAdded: 20 }],
      ['3', { id: '3', title: 'folder' }],
    ]);
    const live = liveAnnotations([row('1', ['x'], 10), row('2', ['x'], 99), row('3', ['x']), row('4', ['x']), row('1', [], 10)], nodes);
    expect(live.map((entry) => entry.nativeId)).toEqual(['1']);
  });

  test('matches all or any chosen tags and toggles case-insensitively', () => {
    expect(matchesTags(['Rust', 'web'], ['rust', 'WEB'], 'all')).toBe(true);
    expect(matchesTags(['Rust'], ['rust', 'web'], 'all')).toBe(false);
    expect(matchesTags(['Rust'], ['rust', 'web'], 'any')).toBe(true);
    expect(toggleTag(['Rust', 'web'], 'rust')).toEqual(['web']);
    expect(toggleTag(['web'], 'Rust')).toEqual(['web', 'Rust']);
  });

  test('retags in place: removes case-insensitively, adds only what is missing, keeps spellings', () => {
    expect(retag(['Rust', 'web', 'ml'], ['RUST', 'new'], ['WEB'])).toEqual(['Rust', 'ml', 'new']);
    expect(retag(['a', 'b'], ['c'], [], 2)).toEqual(['a', 'b']);
  });
});

describe('manager tag views', () => {
  beforeEach(() => { vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test${path}` } }); });
  afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

  test('the tree lists the top tags, keeps a chosen tag outside them, and offers All tags', () => {
    const counts = Array.from({ length: TREE_TAG_LIMIT + 3 }, (_, index) => ({ tag: `t${index}`, count: 20 - index }));
    const tree = document.createElement('div');
    const toggle = vi.fn(), showAll = vi.fn();
    renderTreeTags(tree, { counts, selected: ['t14'], toggle, showAll });
    const tags = Array.from(tree.querySelectorAll<HTMLButtonElement>('button.mgr-tag'));
    expect(tags.map((button) => button.dataset.tag)).toEqual([...counts.slice(0, TREE_TAG_LIMIT).map(({ tag }) => tag), 't14']);
    expect(tags.at(-1)?.getAttribute('aria-pressed')).toBe('true');
    expect(tags[0]?.querySelector('em')?.textContent).toBe('20');
    tags[1]!.click();
    expect(toggle).toHaveBeenCalledWith('t1');
    const more = tree.querySelector<HTMLButtonElement>('.mgr-tags-more')!;
    expect(more.textContent).toBe(`All tags (${TREE_TAG_LIMIT + 3})…`);
    more.click();
    expect(showAll).toHaveBeenCalledWith(more);
  });

  test('no tags, no Tags block', () => {
    const tree = document.createElement('div');
    renderTreeTags(tree, { counts: [], selected: [], toggle: vi.fn(), showAll: vi.fn() });
    expect(tree.childElementCount).toBe(0);
  });

  test('the path bar holds removable tokens, and Match appears once two tags are chosen', () => {
    const path = document.createElement('div'), tools = document.createElement('span');
    const toggle = vi.fn(), setMatch = vi.fn(), clear = vi.fn();
    renderTagPath(path, tools, { selected: ['design'], match: 'all', total: 3, toggle, setMatch, clear });
    expect(path.textContent).toBe('All bookmarks›#design');
    expect(tools.querySelector('select')).toBeNull();
    expect(tools.textContent).toContain('3 bookmarks');
    path.querySelector<HTMLButtonElement>('[aria-label="Remove tag filter design"]')!.click();
    expect(toggle).toHaveBeenCalledWith('design');

    path.replaceChildren(); tools.replaceChildren();
    renderTagPath(path, tools, { selected: ['design', 'rust'], match: 'all', total: 1, toggle, setMatch, clear });
    const select = tools.querySelector('select')!;
    select.value = 'any'; select.dispatchEvent(new Event('change'));
    expect(setMatch).toHaveBeenCalledWith('any');
    Array.from(tools.querySelectorAll('button')).find((button) => button.textContent === 'Clear')!.click();
    expect(clear).toHaveBeenCalled();
  });

  test('row tags become filter buttons when the host filters by tag', () => {
    const filterTag = vi.fn();
    const host: RowHost = { openFolder: vi.fn(), edit: vi.fn(), menu: vi.fn(), select: vi.fn(), dragSource: () => undefined,
      setDragSource: vi.fn(), dropInto: vi.fn(), dropBefore: vi.fn(), filterTag, tagActive: (tag) => tag === 'ai' };
    const element = renderManagerRow({ id: '5', title: 'Agents', url: 'https://example.com/a' },
      { annotation: { ...row('5', ['mcp', 'ai']), url: 'https://example.com/a' } }, host);
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('.mini-tags button.mini-tag'));
    expect(buttons.map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([['mcp', 'false'], ['ai', 'true']]);
    buttons[0]!.click();
    expect(filterTag).toHaveBeenCalledWith('mcp');
    expect(host.select).not.toHaveBeenCalled();
  });

  test('bulk tagging shows shared tags checked, partial ones mixed, and applies adds and removals', () => {
    const apply = vi.fn();
    openBulkTagDialog({ tagSets: [['design', 'rust'], ['design']], vocabulary: [], apply });
    const dialog = document.querySelector('dialog.mgr-bulk-tag')!;
    expect(dialog.querySelector('h3')?.textContent).toBe('Tag 2 bookmarks');
    const rows = Array.from(dialog.querySelectorAll<HTMLLabelElement>('.check-row'));
    const box = (name: string) => rows.find((row) => row.textContent?.includes(`#${name}`))!.querySelector('input')!;
    expect([box('design').checked, box('design').indeterminate]).toEqual([true, false]);
    expect([box('rust').checked, box('rust').indeterminate]).toEqual([false, true]);
    expect(rows.map((row) => row.querySelector('.meta')?.textContent)).toEqual(['All', '1 of 2']);

    box('design').click();
    box('rust').click();
    const input = dialog.querySelector<HTMLInputElement>('.tag-input input')!;
    input.value = 'reading';
    Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === 'Apply')!.click();
    expect(apply).toHaveBeenCalledWith({ add: ['reading', 'rust'], remove: ['design'] });
    expect(document.querySelector('dialog.mgr-bulk-tag')).toBeNull();
  });
});
