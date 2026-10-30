import type { BookmarkAnnotation } from './bookmark-annotation-store.js';
import { domainOf, faviconTile, icon, iconTile, type IconName, type NativeNode } from './bookmark-manager-dom.js';
import { t, tn } from './i18n.js';

export interface RowHost {
  openFolder(node: NativeNode): void;
  edit(node: NativeNode, row: HTMLElement): void;
  menu(event: MouseEvent | undefined, node: NativeNode, row: HTMLElement, anchor?: HTMLElement): void;
  /** `deliberate` is a modifier click: it may start a selection, a plain click only extends one. */
  select(id: string, range: boolean, deliberate: boolean): void;
  dragSource(): string | undefined;
  setDragSource(id: string | undefined): void;
  dropInto(event: DragEvent, folderId: string): void;
  dropBefore(event: DragEvent, target: NativeNode): void;
  dropAfter?(event: DragEvent, target: NativeNode): void;
  /** False when the dragged row may not land before `target`. */
  canDropBefore?(source: string, target: NativeNode): boolean;
  canDropAfter?(source: string, target: NativeNode): boolean;
  canDropInto?(source: string, folderId: string): boolean;
  pin?(node: NativeNode, trigger: HTMLElement): void;
  /** When set, each row tag is a button that filters the list by it. */
  filterTag?(tag: string): void;
  tagActive?(tag: string): boolean;
}
export interface RowFacts {
  /** Folder path shown after the domain in search results. */
  readonly location?: string;
  /** What a folder is for, if its owner wrote it down. */
  readonly description?: string | null;
  readonly annotation?: BookmarkAnnotation;
  /** Shown in a folder: whether the bookmark is pinned and whether this folder applies pins. */
  readonly pin?: { readonly pinned: boolean; readonly available: boolean };
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function rowAction(name: string, glyph: IconName, title: string, run: (event: MouseEvent) => void): HTMLButtonElement {
  const button = element('button', 'btn btn-ghost btn-sm mgr-action');
  button.type = 'button'; button.setAttribute('aria-label', `${name} ${title}`); button.title = name;
  button.append(icon(glyph));
  button.addEventListener('click', run);
  return button;
}

function pinAction(node: NativeNode, state: NonNullable<RowFacts['pin']>, host: RowHost): HTMLButtonElement {
  const name = state.pinned ? t('pin_unpin', 'Unpin') : t('pin_pin', 'Pin');
  const button = rowAction(name, 'pin', node.title, (event) => host.pin!(node, event.currentTarget as HTMLElement));
  button.classList.add('mgr-pin');
  button.setAttribute('aria-pressed', String(state.pinned));
  if (!state.pinned && !state.available) button.setAttribute('aria-disabled', 'true');
  if (state.pinned && !state.available) { button.dataset.paused = 'true'; button.title = t('pin_pausedHere', 'Pinned. Pins are off in this folder; click to unpin.'); }
  return button;
}

/** What a folder holds, counted as the tree and Sync › Folders count it: everything inside it, however deep. */
function folderContentsCopy(node: NativeNode): string {
  let bookmarks = 0, folders = 0;
  const visit = (children: readonly NativeNode[] | undefined): void => {
    for (const child of children ?? []) { if (child.url !== undefined) bookmarks += 1; else { folders += 1; visit(child.children); } }
  };
  visit(node.children);
  const copy = tn('common_bookmarks', bookmarks, '$1 bookmark', '$1 bookmarks');
  return folders ? `${copy} · ${tn('common_folders', folders, '$1 folder', '$1 folders')}` : copy;
}

export type RowDropMode = 'before' | 'into' | 'after';

export function resolveRowDropMode(
  node: NativeNode,
  sourceId: string,
  ratio: number,
  host: RowHost,
): RowDropMode | undefined {
  if (sourceId === node.id) return undefined;
  const isFolder = node.url === undefined;
  const canBefore = host.canDropBefore ? host.canDropBefore(sourceId, node) : !isFolder;
  const canAfter = host.canDropAfter ? host.canDropAfter(sourceId, node) : false;
  const canInto = isFolder && (host.canDropInto ? host.canDropInto(sourceId, node.id) : true);

  if (isFolder) {
    if (!canInto) {
      if (canBefore && canAfter) return ratio < 0.5 ? 'before' : 'after';
      if (canBefore && ratio < 0.5) return 'before';
      if (canAfter && ratio >= 0.5) return 'after';
      return undefined;
    }
    if (!canBefore && !canAfter) return 'into';
    if (ratio < 0.25 && canBefore) return 'before';
    if (ratio > 0.75 && canAfter) return 'after';
    return 'into';
  }

  if (canBefore && canAfter) return ratio < 0.5 ? 'before' : 'after';
  if (canBefore && ratio < 0.5) return 'before';
  if (canAfter && ratio >= 0.5) return 'after';
  return undefined;
}

/** One list row: site icon, title, domain · #tags, an optional one-line note, and hover actions. */
export function renderManagerRow(node: NativeNode, facts: RowFacts, host: RowHost): HTMLElement {
  const row = element('div', 'list-row mgr-row');
  row.dataset.id = node.id;
  // Focusable by script, not a tab stop of its own: F2, Delete and the menu key act on the row whose title or buttons hold focus.
  row.tabIndex = -1;
  const managed = node.unmodifiable === 'managed';
  const isFolder = node.url === undefined;
  if (!managed) {
    row.addEventListener('contextmenu', (event) => { host.menu(event, node, row); });
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      host.setDragSource(node.id);
      event.dataTransfer?.setData('text/plain', node.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { host.setDragSource(undefined); });
  }
  row.addEventListener('dragover', (event) => {
    const source = host.dragSource();
    if (!source || source === node.id) return;
    const rect = row.getBoundingClientRect();
    const height = rect.height > 0 ? rect.height : 40;
    const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / height));
    const mode = resolveRowDropMode(node, source, ratio, host);
    if (!mode) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    row.dataset.drop = mode;
  });
  row.addEventListener('dragleave', (event) => {
    if (!row.contains(event.relatedTarget as Node | null)) delete row.dataset.drop;
  });
  row.addEventListener('drop', (event) => {
    event.preventDefault();
    const mode = row.dataset.drop as RowDropMode | undefined;
    delete row.dataset.drop;
    if (mode === 'into') host.dropInto(event, node.id);
    else if (mode === 'after') (host.dropAfter ?? host.dropBefore)(event, node);
    else if (mode === 'before') host.dropBefore(event, node);
  });

  const lead = element('span', 'mgr-lead');
  lead.append(isFolder ? iconTile('folder') : faviconTile(node.url!, node.id));
  const copy = element('span', 'list-row-main mgr-copy');
  const meta = element('span', 'list-row-meta mgr-meta');
  const title = node.title;
  if (isFolder) {
    const open = element('button', 'list-row-title mgr-name', title || t('common_untitledFolder', 'Untitled folder'));
    open.type = 'button';
    open.addEventListener('click', () => { host.openFolder(node); });
    meta.append(element('span', 'grow', managed ? t('manager_managedReadOnly', 'Managed, read only') : folderContentsCopy(node)));
    copy.append(open, meta);
    if (facts.description) {
      const description = element('span', 'list-row-note mgr-folder-description', facts.description);
      description.title = facts.description;
      copy.append(description);
    }
  } else {
    const open = element('a', 'list-row-title mgr-name', title || node.url || t('common_untitledBookmark', 'Untitled bookmark'));
    open.href = node.url ?? '#'; open.target = '_blank'; open.rel = 'noreferrer';
    copy.append(open, meta);
    meta.append(element('span', 'grow', domainOf(node.url!)));
    if (facts.location) meta.append(element('span', 'sep'), element('span', 'grow', facts.location));
    const tags = facts.annotation?.tags ?? [];
    if (tags.length) {
      meta.append(element('span', 'sep'));
      const list = element('span', 'mini-tags');
      for (const tag of tags) {
        if (!host.filterTag) { list.append(element('span', 'mini-tag', tag)); continue; }
        const chip = element('button', 'mini-tag', tag);
        chip.type = 'button';
        chip.setAttribute('aria-pressed', String(host.tagActive?.(tag) ?? false));
        chip.setAttribute('aria-label', t('manager_filterByTag', 'Filter by tag $1', tag));
        chip.addEventListener('click', () => { host.filterTag!(tag); });
        list.append(chip);
      }
      meta.append(list);
    }
    if (facts.annotation?.note) {
      const note = element('span', 'list-row-note mgr-note', facts.annotation.note.split('\n')[0]);
      note.title = facts.annotation.note;
      copy.append(note);
    }
  }
  const actions = element('span', 'list-row-tail mgr-actions');
  if (!managed) {
    const hover = element('span', 'row-actions-hover');
    const pin = facts.pin && host.pin ? pinAction(node, facts.pin, host) : undefined;
    // A pin stays in view; the offer to pin shows on hover with the other actions.
    if (pin && facts.pin!.pinned) actions.append(pin); else if (pin) hover.append(pin);
    hover.append(
      rowAction(isFolder ? t('manager_editFolder', 'Edit folder') : t('manager_editBookmark', 'Edit bookmark'), 'pencil', title, () => host.edit(node, row)),
      rowAction(t('common_moreActions', 'More actions'), 'more-horizontal', title, (event) => host.menu(undefined, node, row, event.currentTarget as HTMLElement)),
    );
    actions.append(hover);
  }
  row.append(lead, copy, actions);
  row.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button, a, input, textarea')) return;
    host.select(node.id, event.shiftKey, event.shiftKey || event.metaKey || event.ctrlKey);
  });
  return row;
}
