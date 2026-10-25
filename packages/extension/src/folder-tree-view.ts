import { createIcon } from './icons.js';
import { t } from './i18n.js';

/** One folder in tree order (parents before children). */
export interface FolderTreeRow {
  readonly id: string;
  readonly title: string;
  /** 0 for a top-level folder; a child is one deeper than its parent. */
  readonly depth: number;
  /** Ancestor titles and the folder's own, outermost first. */
  readonly path: readonly string[];
  /** Listed (its subfolders may be choices) but not a choice itself. */
  readonly disabled?: boolean;
  /** Short reason after a disabled name, such as "Current location". */
  readonly note?: string;
  /** At or under a live sync mount: a data attribute for styling, never a label. */
  readonly synced?: boolean;
}

export interface FolderTreeView {
  /** New rows (tree order) and Recent ids, newest first. Open branches survive while their folders do. */
  setRows(rows: readonly FolderTreeRow[], recentIds?: readonly string[]): void;
  setSelected(id: string): void;
  /** Back to the opening view: no search, the chosen folder's branch open. */
  reset(): void;
  /** Focuses the chosen folder's row, else the first row; false when there is no row. */
  focusRow(): boolean;
  /** Scrolls the chosen folder's first row into the list's view; call once the list is shown. */
  reveal(): void;
}

/** Rows a branch opens to before a long tree stays folded at its first level. */
const OPEN_BUDGET = 12;

/**
 * The folder tree every picker shares (popup, options pickers, Move to): the
 * folders in the browser's order with each branch folding under a chevron,
 * a Recent group whose rows name their parents and open onto their own
 * subfolders, and a search that lists matches flat with their paths.
 *
 * A short tree opens fully; a long one opens its top level and the chosen
 * folder's branch, so the first screen is the shape of the tree rather than
 * all of it. A row picks its folder; the chevron, ArrowRight and ArrowLeft
 * open and fold. Only shown rows are in the DOM.
 */
export function createFolderTreeView(input: {
  /** The tree element; it gets role="tree" and the rows. */
  readonly list: HTMLElement;
  readonly label: string;
  readonly onPick: (id: string) => void;
  /** Filters the tree while it has text; ArrowDown leaves it for the rows and Enter takes the first match. */
  readonly search?: HTMLInputElement;
}): FolderTreeView {
  const { list } = input;
  let rows: FolderTreeRow[] = [], recentIds: string[] = [], selected = '', query = '';
  let byId = new Map<string, number>();
  /** Per row: its parent's index (-1 at the top), the index after its subtree, and its direct subfolder count. */
  let parents: number[] = [], ends: number[] = [], childCounts: number[] = [];
  let expanded = new Set<string>();
  /** Open rows inside the Recent group, keyed `<recent id>/<folder id>`. */
  let recentOpen = new Set<string>();
  let seeded = false;
  list.setAttribute('role', 'tree');
  list.setAttribute('aria-label', input.label);

  const hasChildren = (index: number) => childCounts[index]! > 0;
  function load(next: readonly FolderTreeRow[]): void {
    rows = [...next];
    byId = new Map(rows.map((folder, at) => [folder.id, at]));
    parents = []; ends = []; childCounts = rows.map(() => 0);
    const stack: number[] = [];
    rows.forEach((folder, at) => {
      while (stack.length > 0 && rows[stack.at(-1)!]!.depth >= folder.depth) ends[stack.pop()!] = at;
      parents[at] = stack.at(-1) ?? -1;
      if (parents[at]! >= 0) childCounts[parents[at]!]! += 1;
      stack.push(at);
    });
    for (const at of stack) ends[at] = rows.length;
  }

  /* Level by level, the way a reader scans: the top level always opens; the
     next level opens only while everything shown still fits the budget. */
  function seedExpanded(): void {
    expanded = new Set();
    let shown = rows.filter((row) => row.depth === 0).length;
    for (let depth = 0; ; depth += 1) {
      const level = rows.flatMap((row, at) => (row.depth === depth && hasChildren(at) ? [at] : []));
      if (level.length === 0) break;
      const adds = level.reduce((sum, at) => sum + childCounts[at]!, 0);
      if (depth > 0 && shown + adds > OPEN_BUDGET) break;
      for (const at of level) expanded.add(rows[at]!.id);
      shown += adds;
    }
    openBranchOf(selected);
  }
  function openBranchOf(id: string): void {
    for (let at = parents[byId.get(id) ?? -1] ?? -1; at >= 0; at = parents[at]!) expanded.add(rows[at]!.id);
  }

  function row(index: number, key: string, depth: number, options: { trail?: boolean; open?: boolean } = {}): HTMLButtonElement {
    const folder = rows[index]!;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'folder-opt';
    item.setAttribute('role', 'treeitem');
    item.dataset.folderId = folder.id;
    item.dataset.key = key;
    if (folder.synced) item.dataset.synced = '';
    item.setAttribute('aria-level', String(depth + 1));
    item.setAttribute('aria-selected', String(folder.id === selected));
    if (folder.disabled) item.setAttribute('aria-disabled', 'true');
    item.style.setProperty('--depth', String(depth));
    item.title = folder.path.join(' › ');
    item.tabIndex = -1;
    const twisty = document.createElement('span');
    twisty.className = 'folder-twisty';
    twisty.setAttribute('aria-hidden', 'true');
    if (options.open !== undefined) {
      item.setAttribute('aria-expanded', String(options.open));
      twisty.append(createIcon('chevron-right', 12));
    }
    const label = document.createElement('span');
    label.className = 'folder-opt-label';
    const name = document.createElement('span');
    name.className = 'folder-opt-name';
    name.textContent = folder.title;
    label.append(name);
    const parents = folder.path.slice(0, -1);
    if (options.trail && parents.length > 0) {
      const trail = document.createElement('span');
      trail.className = 'folder-opt-trail';
      trail.textContent = parents.join(' › ');
      label.append(trail);
    }
    item.append(twisty, createIcon('folder', 14), label);
    if (folder.note) {
      const note = document.createElement('span');
      note.className = 'folder-opt-note';
      note.textContent = folder.note;
      item.append(note);
    }
    return item;
  }

  function group(name: string, heading: string, items: readonly HTMLElement[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'group');
    wrap.dataset.folderGroup = name;
    const caption = document.createElement('p');
    caption.className = 'folder-group';
    caption.id = `${list.id || 'folder-tree'}-group-${name}`;
    caption.textContent = heading;
    wrap.setAttribute('aria-labelledby', caption.id);
    wrap.append(caption, ...items);
    return wrap;
  }

  function treeRows(): HTMLButtonElement[] {
    const out: HTMLButtonElement[] = [];
    for (let index = 0; index < rows.length;) {
      const open = expanded.has(rows[index]!.id);
      out.push(row(index, `all:${rows[index]!.id}`, rows[index]!.depth, hasChildren(index) ? { open } : {}));
      index = open ? index + 1 : ends[index]!;
    }
    return out;
  }

  /* A recent folder with subfolders opens onto them in place, so a pick one
     level under a recent folder never needs the whole tree. */
  function recentRows(): HTMLButtonElement[] {
    const out: HTMLButtonElement[] = [];
    for (const id of recentIds) {
      const top = byId.get(id);
      if (top === undefined) continue;
      const base = rows[top]!.depth;
      const visit = (index: number, isTop: boolean) => {
        const key = `${id}/${rows[index]!.id}`;
        const open = recentOpen.has(key);
        out.push(row(index, `recent:${key}`, rows[index]!.depth - base, {
          ...(isTop ? { trail: true } : {}), ...(hasChildren(index) ? { open } : {}) }));
        if (!open) return;
        for (let child = index + 1; child < ends[index]!; child = ends[child]!) visit(child, false);
      };
      visit(top, true);
    }
    return out;
  }

  function paint(): void {
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
    const scroll = list.scrollTop;
    list.replaceChildren();
    const needle = query.trim().toLocaleLowerCase();
    if (needle) {
      const matches = rows.flatMap((folder, index) => (folder.title.toLocaleLowerCase().includes(needle) ? [index] : []));
      if (matches.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'folder-empty';
        empty.textContent = t('common_noFolderMatches', 'No folders match.');
        list.append(empty);
      } else list.append(...matches.map((index) => row(index, `match:${rows[index]!.id}`, 0, { trail: true })));
    } else {
      const recent = recentRows();
      list.append(...(recent.length > 0
        ? [group('recent', t('popup_recentFolders', 'Recent'), recent), group('all', t('popup_allFolders', 'All folders'), treeRows())]
        : treeRows()));
      list.scrollTop = scroll;
    }
    const items = options();
    const stop = items.find((item) => item.dataset.folderId === selected) ?? items[0];
    if (stop) stop.tabIndex = 0;
    if (focused) items.find((item) => item.dataset.key === focused)?.focus({ preventScroll: true });
  }

  const options = () => Array.from(list.querySelectorAll<HTMLButtonElement>('[data-folder-id]:not([hidden])'));

  function toggle(item: HTMLElement, open?: boolean): void {
    const key = item.dataset.key ?? '';
    const id = item.dataset.folderId ?? '';
    if (!item.hasAttribute('aria-expanded')) return;
    const next = open ?? item.getAttribute('aria-expanded') !== 'true';
    if (key.startsWith('recent:')) {
      const ref = key.slice('recent:'.length);
      if (next) recentOpen.add(ref); else recentOpen.delete(ref);
    } else if (next) expanded.add(id); else expanded.delete(id);
    paint();
  }

  list.addEventListener('click', (event) => {
    const item = (event.target as Element).closest<HTMLButtonElement>('[data-folder-id]');
    if (!item || !list.contains(item)) return;
    const onTwisty = (event.target as Element).closest('.folder-twisty') !== null;
    // A row that is not a choice still opens; its subfolders may be.
    if (onTwisty || item.getAttribute('aria-disabled') === 'true') { item.focus({ preventScroll: true }); toggle(item); return; }
    input.onPick(item.dataset.folderId ?? '');
  });

  list.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const items = options();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || items.length === 0) return;
    const current = items[at]!;
    const move = (index: number) => { event.preventDefault(); items[Math.max(0, Math.min(items.length - 1, index))]?.focus(); };
    switch (event.key) {
      case 'ArrowDown': move(at + 1); return;
      case 'ArrowUp':
        if (at === 0 && input.search) { event.preventDefault(); input.search.focus(); return; }
        move(at - 1); return;
      case 'Home': move(0); return;
      case 'End': move(items.length - 1); return;
      case 'ArrowRight':
        event.preventDefault();
        if (current.getAttribute('aria-expanded') === 'false') toggle(current, true);
        else if (current.getAttribute('aria-expanded') === 'true') items[at + 1]?.focus();
        return;
      case 'ArrowLeft': {
        event.preventDefault();
        if (current.getAttribute('aria-expanded') === 'true') { toggle(current, false); return; }
        const level = Number(current.getAttribute('aria-level'));
        for (let index = at - 1; index >= 0; index -= 1) {
          if (Number(items[index]!.getAttribute('aria-level')) < level) { items[index]!.focus(); return; }
        }
        return;
      }
      default:
        // Typing on a row goes to the search, as in a native list.
        if (input.search && event.key.length === 1 && event.key !== ' ') {
          event.preventDefault();
          input.search.focus();
          input.search.value += event.key;
          input.search.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
  });

  input.search?.addEventListener('input', () => { query = input.search!.value; paint(); });
  input.search?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || (event.key === 'Home' && !input.search!.value)) {
      const first = options()[0];
      if (first) { event.preventDefault(); first.focus(); }
    } else if (event.key === 'Enter') {
      // The panel can sit inside a form; Enter here never submits it.
      event.preventDefault();
      const first = query.trim() ? options().find((item) => item.getAttribute('aria-disabled') !== 'true') : undefined;
      if (first) input.onPick(first.dataset.folderId ?? '');
    }
  });

  return {
    setRows(next, recent = []) {
      load(next);
      recentIds = recent.filter((id) => byId.has(id) && !rows[byId.get(id)!]!.disabled);
      if (!seeded) { seeded = rows.length > 0; seedExpanded(); } else {
        expanded = new Set([...expanded].filter((id) => byId.has(id)));
        openBranchOf(selected);
      }
      recentOpen = new Set([...recentOpen].filter((key) => key.split('/').every((id) => byId.has(id))));
      paint();
    },
    setSelected(id) {
      selected = id;
      if (seeded) openBranchOf(id);
      paint();
    },
    reset() {
      query = '';
      if (input.search) input.search.value = '';
      openBranchOf(selected);
      paint();
    },
    focusRow() {
      const items = options();
      const target = items.find((item) => item.dataset.folderId === selected) ?? items[0];
      target?.focus();
      return target !== undefined;
    },
    reveal() {
      // The first row of the chosen folder; in Recent it is already at the top.
      const chosen = options().find((item) => item.dataset.folderId === selected);
      if (!chosen) return;
      const box = list.getBoundingClientRect(), at = chosen.getBoundingClientRect();
      if (at.top < box.top || at.bottom > box.bottom) list.scrollTop += at.top - box.top - (box.height - at.height) / 2;
    },
  };
}
