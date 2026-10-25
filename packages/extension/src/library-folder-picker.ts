import { createIcon } from './icons.js';
import { t } from './i18n.js';
import { el } from './library-dom.js';
import { supportedBookmarkTree } from './bookmark-folder-policy.js';
import { createFolderTreeView } from './folder-tree-view.js';

/** A folder someone may choose: where it sits in the tree and whether choosing it is allowed. */
export interface FolderChoice {
  readonly id: string;
  readonly title: string;
  readonly depth: number;
  readonly path: readonly string[];
  readonly disabled?: boolean;
  /** Short reason shown after a disabled name, such as "Current location". */
  readonly note?: string;
}
export interface FolderSourceNode {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly unmodifiable?: string;
  readonly folderType?: string;
  readonly children?: readonly FolderSourceNode[];
}

/**
 * Flattens a native tree into the folders that can receive items. The synthetic
 * root is skipped, managed folders are listed but disabled, and `exclude` drops
 * a folder together with everything under it (read-only subscription folders,
 * a moved folder's own subtree).
 */
export function folderChoices(roots: readonly FolderSourceNode[], options: {
  readonly exclude?: ReadonlySet<string>;
  readonly disabled?: ReadonlyMap<string, string>;
} = {}): FolderChoice[] {
  const out: FolderChoice[] = [];
  const visit = (nodes: readonly FolderSourceNode[], depth: number, ancestors: readonly string[], managed = false) => {
    for (const node of nodes) {
      if (node.url !== undefined || options.exclude?.has(node.id)) continue;
      const title = node.title || t('common_untitledFolder', 'Untitled folder');
      const path = [...ancestors, title];
      const note = options.disabled?.get(node.id);
      const managedHere = managed || node.unmodifiable !== undefined;
      const blocked = managedHere || note !== undefined;
      out.push({ id: node.id, title, depth, path, ...(blocked ? { disabled: true } : {}), ...(note ? { note } : {}) });
      visit(node.children ?? [], depth + 1, path, managedHere);
    }
  };
  for (const top of supportedBookmarkTree(roots)) visit(top.children ?? [], 0, []);
  return out;
}

export interface FolderListbox {
  /** Search field plus the folder tree, in the kit's `.folder-panel` card. */
  readonly element: HTMLElement;
  setChoices(choices: readonly FolderChoice[]): void;
  setSelected(id: string): void;
  focus(): void;
  reset(): void;
}

/** The searchable folder tree used inline by the pill and, always open, by the move dialogs. */
export function createFolderListbox(input: {
  readonly choices: readonly FolderChoice[];
  readonly selected?: string;
  readonly label: string;
  readonly onPick: (choice: FolderChoice) => void;
  readonly onEscape?: () => void;
}): FolderListbox {
  let choices = [...input.choices];
  const panel = el('div', undefined, 'folder-panel');
  const search = el('label', undefined, 'folder-search');
  const filter = el('input'); filter.type = 'search'; filter.autocomplete = 'off';
  filter.placeholder = t('common_findFolder', 'Find folder'); filter.setAttribute('aria-label', t('common_findFolder', 'Find folder'));
  search.append(createIcon('search', 14), filter);
  const list = el('div', undefined, 'folder-list');
  panel.append(search, list);
  const tree = createFolderTreeView({ list, label: input.label, search: filter, onPick(id) {
    const choice = choices.find((folder) => folder.id === id);
    if (choice && !choice.disabled) input.onPick(choice);
  } });
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && input.onEscape) { event.preventDefault(); event.stopPropagation(); input.onEscape(); }
  });
  tree.setSelected(input.selected ?? '');
  tree.setRows(choices);
  return {
    element: panel,
    setChoices(next) { choices = [...next]; tree.setRows(choices); },
    setSelected(id) { tree.setSelected(id); },
    focus() { if (!tree.focusRow()) filter.focus(); },
    reset() { tree.reset(); },
  };
}

export interface FolderPicker {
  readonly element: HTMLElement;
  readonly pill: HTMLButtonElement;
  value(): string;
  setValue(id: string): void;
  setChoices(choices: readonly FolderChoice[]): void;
  open(): void;
  close(): void;
}

/**
 * The popup's folder grammar for the options pages: a pill that names the
 * folder and opens an inline panel (filter, tree). The panel pushes content
 * down instead of overlaying it, so it works inside dialogs.
 */
export function createFolderPicker(input: {
  readonly choices: readonly FolderChoice[];
  readonly value?: string;
  readonly label: string;
  readonly onChange?: (choice: FolderChoice) => void;
  /** Start with no folder ("Choose destination") instead of the first one, so the choice is the user's. */
  readonly startEmpty?: boolean;
}): FolderPicker {
  let choices = [...input.choices], selected = input.value ?? '';
  const id = `folder-picker-${crypto.randomUUID()}`;
  const root = el('div', undefined, 'folder-picker');
  const pill = el('button', undefined, 'folder-pill');
  pill.type = 'button'; pill.setAttribute('aria-haspopup', 'tree'); pill.setAttribute('aria-expanded', 'false'); pill.setAttribute('aria-controls', id);
  const listbox = createFolderListbox({ choices, selected, label: input.label,
    onPick(choice) { api.setValue(choice.id); api.close(); pill.focus(); input.onChange?.(choice); },
    onEscape() { api.close(); pill.focus(); } });
  const panel = listbox.element; panel.id = id; panel.hidden = true;
  root.append(pill, panel);

  const find = (value: string) => choices.find((choice) => choice.id === value);
  function paintPill(): void {
    const choice = find(selected);
    pill.replaceChildren(createIcon('folder', 15));
    const parents = choice?.path.slice(0, -1) ?? [];
    if (parents.length) pill.append(el('span', `${parents.join(' › ')} ›`, 'folder-pill-parent'));
    pill.append(el('span', choice?.title ?? t('common_chooseDestination', 'Choose destination'), 'folder-pill-name'));
    const chevron = createIcon('chevron-down', 12); chevron.classList.add('chev'); pill.append(chevron);
    pill.setAttribute('aria-label', `${input.label}: ${choice ? choice.path.join(' › ') : t('common_chooseDestination', 'Choose destination')}`);
    pill.title = choice ? choice.path.join(' › ') : '';
    pill.dataset.value = selected;
  }
  pill.addEventListener('click', () => { if (panel.hidden) api.open(); else api.close(); });
  const api: FolderPicker = {
    element: root, pill,
    value: () => selected,
    setValue(value) { selected = value; listbox.setSelected(value); paintPill(); },
    setChoices(next) {
      choices = [...next];
      // An empty start stays empty, and a folder that is not (or no longer) offered is no choice at all.
      if (!find(selected)) selected = input.startEmpty ? '' : choices.find((choice) => !choice.disabled)?.id ?? '';
      listbox.setChoices(choices); listbox.setSelected(selected); paintPill();
    },
    open() { panel.hidden = false; pill.setAttribute('aria-expanded', 'true'); listbox.reset(); listbox.setSelected(selected); listbox.focus(); },
    close() { panel.hidden = true; pill.setAttribute('aria-expanded', 'false'); },
  };
  // An empty start keeps its value until setChoices brings the folders it can be checked against.
  if (!find(selected) && !input.startEmpty) selected = choices.find((choice) => !choice.disabled)?.id ?? '';
  listbox.setSelected(selected); paintPill();
  return api;
}
