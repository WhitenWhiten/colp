import { annotationMatchesBookmark, type BookmarkAnnotation } from './bookmark-annotation-store.js';
import type { NativeNode } from './bookmark-manager-dom.js';
import { createDialog, dialogButton } from './dialog.js';
import { createIcon } from './icons.js';
import { t, tn } from './i18n.js';
import { el, searchCompact, selectOf, selectPill } from './library-dom.js';
import { ANNOTATION_LIMITS } from './popup-annotations.js';
import { createTagInput } from './popup-tags.js';

/* Tags as a second way through the bookmarks: the tree lists them under the
   folders, choosing one shows every bookmark that carries it (from any
   folder), and the path bar holds the chosen tags. Tags compare
   case-insensitively, like the annotation store. */

export type TagMatch = 'all' | 'any';
export interface TagCount { readonly tag: string; readonly count: number }

/** Tags listed in the tree before "All tags" takes over. */
export const TREE_TAG_LIMIT = 12;

export const tagKey = (tag: string): string => tag.toLowerCase();

/** Annotation rows that still belong to a bookmark in this tree (a reused native id is not the same bookmark). */
export function liveAnnotations(rows: readonly BookmarkAnnotation[], nodes: ReadonlyMap<string, NativeNode>): BookmarkAnnotation[] {
  return rows.filter((row) => {
    const node = nodes.get(row.nativeId);
    return node?.url !== undefined && row.tags.length > 0
      && annotationMatchesBookmark(row, { id: node.id, ...(node.dateAdded === undefined ? {} : { dateAdded: node.dateAdded }) });
  });
}

/** Every tag, most used first, under the spelling most bookmarks use. */
export function countTags(rows: readonly { readonly tags: readonly string[] }[]): TagCount[] {
  const counts = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const tag of row.tags) {
      const key = tagKey(tag);
      if (!tag.trim() || seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { count: 0, spellings: new Map<string, number>() };
      entry.count++; entry.spellings.set(tag, (entry.spellings.get(tag) ?? 0) + 1); counts.set(key, entry);
    }
  }
  return [...counts.values()].map(({ count, spellings }) => ({
    tag: [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0], count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function matchesTags(tags: readonly string[], selected: readonly string[], match: TagMatch): boolean {
  if (selected.length === 0) return true;
  const own = new Set(tags.map(tagKey));
  return match === 'any' ? selected.some((tag) => own.has(tagKey(tag))) : selected.every((tag) => own.has(tagKey(tag)));
}

/** Every bookmark carrying the chosen tags, in tree order, narrowed by the search text (title, address, tags, note). */
export function taggedNodes(nodes: Iterable<NativeNode>, annotations: ReadonlyMap<string, BookmarkAnnotation>,
  selected: readonly string[], match: TagMatch, query: string): NativeNode[] {
  const needle = query.toLowerCase();
  const matched: NativeNode[] = [];
  for (const node of nodes) {
    const row = annotations.get(node.id);
    if (!row || !matchesTags(row.tags, selected, match)) continue;
    if (needle && !(node.title.toLowerCase().includes(needle) || (node.url ?? '').toLowerCase().includes(needle)
      || row.tags.some((tag) => tag.toLowerCase().includes(needle)) || (row.note?.toLowerCase().includes(needle) ?? false))) continue;
    matched.push(node);
  }
  return matched;
}

/**
 * A bookmark's tags after a bulk change: `remove` drops tags case-insensitively,
 * then each `add` tag is appended unless the bookmark already has it in some
 * spelling. Untouched tags keep their place and spelling.
 */
export function retag(tags: readonly string[], add: readonly string[], remove: readonly string[],
  limit: number = ANNOTATION_LIMITS.tags): string[] {
  const drop = new Set(remove.map(tagKey));
  const next = tags.filter((tag) => !drop.has(tagKey(tag)));
  for (const tag of add) {
    if (next.length >= limit) break;
    if (!next.some((value) => tagKey(value) === tagKey(tag))) next.push(tag);
  }
  return next;
}

export function toggleTag(selected: readonly string[], tag: string): string[] {
  const key = tagKey(tag);
  return selected.some((value) => tagKey(value) === key) ? selected.filter((value) => tagKey(value) !== key) : [...selected, tag];
}

export interface TagTreeHost {
  readonly counts: readonly TagCount[];
  readonly selected: readonly string[];
  toggle(tag: string): void;
  showAll(trigger: HTMLElement): void;
}

function tagRow(content: HTMLButtonElement): HTMLElement {
  const row = el('div', undefined, 'mgr-tree-row');
  // A hidden twisty keeps tags on the folders' icon column.
  const spacer = el('button', undefined, 'mgr-toggle');
  spacer.type = 'button'; spacer.disabled = true; spacer.tabIndex = -1; spacer.setAttribute('aria-hidden', 'true');
  row.append(spacer, content);
  return row;
}

/** The Tags block under the folder tree: the most used tags, plus any chosen ones outside them. */
export function renderTreeTags(into: HTMLElement, host: TagTreeHost): void {
  if (host.counts.length === 0) return;
  const chosen = new Set(host.selected.map(tagKey));
  const top = host.counts.slice(0, TREE_TAG_LIMIT);
  const shown = [...top, ...host.counts.slice(TREE_TAG_LIMIT).filter(({ tag }) => chosen.has(tagKey(tag)))];
  into.append(el('p', t('common_tags', 'Tags'), 'mgr-tree-kicker'));
  for (const { tag, count } of shown) {
    const name = el('button', undefined, 'mgr-folder mgr-tag');
    name.type = 'button'; name.dataset.tag = tag;
    name.setAttribute('aria-pressed', String(chosen.has(tagKey(tag))));
    const hash = el('span', '#', 'mgr-tag-hash'); hash.setAttribute('aria-hidden', 'true');
    name.append(hash, el('span', tag), el('em', String(count)));
    name.title = tn('manager_tagCount', count, '$1 bookmark tagged $2', '$1 bookmarks tagged $2', tag);
    name.addEventListener('click', () => { host.toggle(tag); });
    into.append(tagRow(name));
  }
  if (host.counts.length > TREE_TAG_LIMIT) {
    const more = el('button', undefined, 'mgr-folder mgr-tags-more');
    more.type = 'button';
    more.append(el('span', t('manager_allTags', 'All tags ($1)…', host.counts.length)));
    more.addEventListener('click', () => { host.showAll(more); });
    into.append(tagRow(more));
  }
}

export interface TagPathHost {
  readonly selected: readonly string[];
  readonly match: TagMatch;
  readonly total: number;
  toggle(tag: string): void;
  setMatch(match: TagMatch): void;
  clear(): void;
}

/** The path bar while tags filter the list: All bookmarks › #tag × …, then the count, Match and Clear. */
export function renderTagPath(path: HTMLElement, tools: HTMLElement, host: TagPathHost): void {
  const root = el('span', t('manager_allBookmarks', 'All bookmarks'), 'mgr-crumb');
  root.setAttribute('aria-current', 'location');
  const divider = el('span', '›', 'mgr-crumb-divider'); divider.setAttribute('aria-hidden', 'true');
  path.append(root, divider);
  for (const tag of host.selected) {
    const token = el('span', undefined, 'mgr-tag-token');
    const remove = el('button', undefined, 'mgr-tag-token-remove');
    remove.type = 'button'; remove.setAttribute('aria-label', t('manager_removeTagFilter', 'Remove tag filter $1', tag));
    remove.append(createIcon('cross', 10));
    remove.addEventListener('click', () => { host.toggle(tag); });
    token.append(el('span', `#${tag}`), remove);
    path.append(token);
  }
  tools.append(el('span', tn('common_bookmarks', host.total, '$1 bookmark', '$1 bookmarks'), 'mgr-tag-total'));
  if (host.selected.length > 1) {
    const select = selectOf([['all', t('manager_allTagsMatch', 'All tags')], ['any', t('manager_anyTag', 'Any tag')]], host.match);
    select.addEventListener('change', () => { host.setMatch(select.value === 'any' ? 'any' : 'all'); });
    tools.append(selectPill(t('manager_match', 'Match'), select));
  }
  const clear = el('button', t('common_clear', 'Clear'), 'btn btn-ghost btn-sm');
  clear.type = 'button';
  clear.addEventListener('click', () => { host.clear(); });
  tools.append(clear);
}

/** Every tag with a find field; checking one filters the list right away. */
export function openTagPicker(host: { readonly counts: readonly TagCount[]; selected(): readonly string[]; toggle(tag: string): void },
  trigger?: HTMLElement | null): void {
  const { dialog, body, actions } = createDialog(t('common_tags', 'Tags'), 'mgr-tag-picker');
  const search = searchCompact(t('manager_findTag', 'Find a tag'), t('manager_findTagPlaceholder', 'Find a tag…'));
  const list = el('ul', undefined, 'mgr-tag-picker-list');
  list.setAttribute('aria-label', t('common_tags', 'Tags'));
  const paint = () => {
    const needle = search.input.value.trim().toLowerCase();
    const chosen = new Set(host.selected().map(tagKey));
    const shown = needle ? host.counts.filter(({ tag }) => tag.toLowerCase().includes(needle)) : host.counts;
    list.replaceChildren(...shown.map(({ tag, count }) => {
      const item = el('li'), label = el('label', undefined, 'mgr-tag-picker-row'), box = el('input');
      box.type = 'checkbox'; box.checked = chosen.has(tagKey(tag));
      box.addEventListener('change', () => { host.toggle(tag); paint(); });
      label.append(box, el('span', `#${tag}`, 'mgr-tag-picker-name'), el('span', String(count), 'mgr-tag-picker-count'));
      item.append(label);
      return item;
    }));
    if (shown.length === 0) list.append(el('li', t('manager_noTagsMatch', 'No tags match.'), 'mgr-tag-picker-empty'));
  };
  search.input.addEventListener('input', paint);
  search.field.classList.add('mgr-tag-picker-search');
  paint();
  const done = dialogButton(t('common_done', 'Done'), 'primary');
  done.addEventListener('click', () => dialog.close());
  body.append(search.field, list); actions.append(done);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); search.input.focus();
}

type TagState = 'on' | 'off' | 'mixed';

/**
 * Bulk tagging for the selection. Each tag already on a selected bookmark is a
 * checkbox: checked when every bookmark has it, mixed when some do. Checking
 * adds it to all, clearing removes it from all, and a mixed tag can go back to
 * mixed to stay as it is. Tags typed in the field below are added to all.
 */
export function openBulkTagDialog(host: {
  readonly tagSets: readonly (readonly string[])[];
  readonly vocabulary: readonly TagCount[];
  apply(change: { readonly add: string[]; readonly remove: string[] }): void;
}, trigger?: HTMLElement | null): void {
  const total = host.tagSets.length;
  const { dialog, body, actions } = createDialog(tn('manager_tagBookmarks', total, 'Tag $1 bookmark', 'Tag $1 bookmarks'), 'mgr-bulk-tag');
  const present = countTags(host.tagSets.map((tags) => ({ tags })));
  const rows = present.map(({ tag, count }) => {
    const start: TagState = count === total ? 'on' : 'mixed';
    let state: TagState = start;
    const row = el('label', undefined, 'check-row'), box = el('input');
    box.type = 'checkbox';
    const paint = () => { box.checked = state === 'on'; box.indeterminate = state === 'mixed'; };
    box.addEventListener('change', () => {
      const order: TagState[] = start === 'mixed' ? ['mixed', 'on', 'off'] : ['on', 'off'];
      state = order[(order.indexOf(state) + 1) % order.length]!;
      paint();
    });
    paint();
    row.append(box, el('span', `#${tag}`, 'grow'),
      el('span', count === total ? t('manager_tagOnAll', 'All') : t('manager_tagOnSome', '$1 of $2', count, total), 'meta'));
    return { tag, start, state: () => state, row };
  });
  if (rows.length) {
    const list = el('div', undefined, 'mgr-bulk-tag-list');
    list.setAttribute('role', 'group'); list.setAttribute('aria-label', t('manager_tagsOnSelection', 'Tags on the selected bookmarks'));
    list.append(...rows.map(({ row }) => row));
    body.append(list);
  }
  const group = el('div', undefined, 'form-field');
  const label = el('label', t('manager_addTags', 'Add tags'), 'form-label');
  const field = el('div', undefined, 'field-quiet tag-input');
  const input = el('input'); input.id = `bulk-tags-${crypto.randomUUID()}`; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
  input.placeholder = t('popup_addTags', 'Add tags…'); label.htmlFor = input.id;
  const suggest = el('div', undefined, 'tag-suggest'); suggest.setAttribute('role', 'group');
  suggest.setAttribute('aria-label', t('popup_suggestedTags', 'Suggested tags')); suggest.hidden = true;
  field.append(input); group.append(label, field, suggest); body.append(group);
  const added = createTagInput({ field, input, suggest, onChange: () => undefined });
  added.setExisting(host.vocabulary);

  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const apply = dialogButton(t('common_apply', 'Apply'), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  apply.addEventListener('click', () => {
    added.commitPending();
    const add = [...added.tags()], remove: string[] = [];
    for (const row of rows) {
      if (row.state() === 'off') remove.push(row.tag);
      else if (row.state() === 'on' && row.start === 'mixed') add.push(row.tag);
    }
    dialog.close();
    host.apply({ add, remove });
  });
  actions.append(cancel, apply);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal();
  (rows[0]?.row.querySelector('input') ?? input).focus();
}
