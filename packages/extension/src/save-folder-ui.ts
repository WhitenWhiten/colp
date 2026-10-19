import { exclusionIds, personalBookmarks } from './bookmark-subscriptions/guards.js';
import { commitSaveFolder, DEVICE_FOLDER_SCOPE, folderIsInSyncRange, readDefaultFolder,
  readOnceFolder, rememberSaveFolder, walkAncestorIds, type FolderTreeNode } from './save-folder.js';
import { resolveFolderSyncTarget, type FolderSyncTarget } from './folder-sync-target.js';
import { buildFolderRows, type FolderRow } from './folder-tree-model.js';
import { readFolderRecents } from './folder-recents.js';
import { isUnsupportedBookmarkFolder } from './bookmark-folder-policy.js';
import { createIcon } from './icons.js';
import { t } from './i18n.js';

export interface SaveFolderUiHost {
  readonly destToggle: HTMLButtonElement;
  readonly destPanel: HTMLElement;
  readonly folderCurrent: HTMLElement;
  readonly folderTree: HTMLElement;
  readonly folderNew: HTMLFormElement;
  readonly folderNewName: HTMLInputElement;
  /** Muted parent title before the folder name; shown only while editing an existing bookmark. */
  readonly folderParent?: HTMLElement;
  /** "New folder in <name>" row, and the inline input row it turns into. */
  readonly folderNewOpen?: HTMLButtonElement;
  readonly folderNewLabel?: HTMLElement;
  readonly folderCreate?: HTMLElement;
  readonly destSearch?: HTMLInputElement;
  /** Remember picks as the next save folder. The automatic result's correction opts out. */
  readonly remember?: boolean;
  /** Runs after the user picks a folder (not after adopt or a suggestion), with the label already updated. */
  readonly onPick?: (nativeId: string) => void | Promise<void>;
  readonly persistDraft: () => void;
  readonly setFeedback: (text: string, tone?: '' | 'ok' | 'error') => void;
  /** Runs after init and after every pick, so passive sync status can follow the folder. */
  readonly onChosen?: () => void;
  /* Read-only subscription folders the save guard refuses; defaults to that guard's own set. */
  readonly excludedFolderIds?: () => Promise<ReadonlySet<string>>;
}

export function bindSaveFolderPicker(host: SaveFolderUiHost): {
  /* `scopeKey` keys the remembered folders: the bound library, else the device scope. */
  init(scopeKey: string, mountNativeIds: readonly string[], privateNativeIds?: readonly string[]): Promise<void>;
  chosenFolderId(): string;
  /** `anyFolder` (local suggestions) accepts any personal folder; server suggestions must stay in the synced range. */
  chooseSuggestedFolder(nativeId: string, anyFolder?: boolean): Promise<boolean>;
  isOutOfRange(): Promise<boolean>;
  syncTarget(): Promise<FolderSyncTarget>;
  /** Shows an existing bookmark's folder without remembering it as a pick. */
  adopt(nativeId: string): Promise<void>;
  /** True once the user picked a folder in this popup; an adopted folder never overrides that. */
  userPicked(): boolean;
  /**
   * True when the chosen folder is the user's own choice for this save: picked in
   * this popup, or picked earlier in this browser session and not yet saved to.
   * Remembered, default and suggested folders are not explicit.
   */
  explicit(): boolean;
  commit(collectionId: string | undefined): Promise<void>;
  /** Shows the folder's parent title before its name (editing an existing bookmark). */
  setParentVisible(visible: boolean): void;
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
} {
  let folderRootHint = '';
  let chosenId = '';
  let mounts = new Set<string>();
  let privateNative = new Set<string>();
  let collectionId: string | undefined;
  let picked = false;
  /** The unsaved pick from an earlier opening of the popup, restored as the current folder. */
  let restoredPick = '';
  let suggested = false, selectionVersion = 0;
  let parentVisible = false;
  let currentTitle = '';

  host.destToggle.addEventListener('click', () => { void togglePicker(); });
  host.destPanel.ownerDocument.addEventListener('pointerdown', (event) => {
    if (host.destPanel.hidden) return;
    const target = event.target as Node;
    if (host.destPanel.contains(target) || host.destToggle.contains(target)) return;
    closePicker();
  }, { capture: true });
  host.folderNew.addEventListener('submit', (event) => { event.preventDefault(); void createFolder(); });
  host.folderNewOpen?.addEventListener('click', () => { setCreating(true); });
  paintNewLabel();
  /* Listbox keyboard model: arrows/Home/End roam the tree rows, Escape closes
     the picker from anywhere inside it (including the new-folder input) and
     returns focus to the toggle, per the ARIA disclosure/listbox pattern. */
  host.destPanel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      // The inline new-folder input steps back to its row first; the next Escape closes the picker.
      if (host.folderCreate && !host.folderCreate.hidden) { setCreating(false); host.folderNewOpen?.focus(); return; }
      closePicker();
      host.destToggle.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    if (event.target === host.destSearch && (event.key === 'ArrowDown' || event.key === 'Home')) {
      const first = host.folderTree.querySelector<HTMLButtonElement>('[data-folder-id]:not([hidden])');
      if (first) { event.preventDefault(); first.focus(); }
      return;
    }
    if (!host.folderTree.contains(event.target as Node)) return;
    const options = Array.from(host.folderTree.querySelectorAll<HTMLButtonElement>('[data-folder-id]:not([hidden])'));
    if (options.length === 0) return;
    event.preventDefault();
    const focused = options.findIndex((item) => item === document.activeElement);
    const selected = options.findIndex((item) => item.getAttribute('aria-selected') === 'true');
    const from = focused >= 0 ? focused : Math.max(0, selected);
    const nextIndex = event.key === 'ArrowDown' ? Math.min(options.length - 1, from + 1)
      : event.key === 'ArrowUp' ? Math.max(0, from - 1)
        : event.key === 'Home' ? 0
          : options.length - 1;
    options[nextIndex]?.focus();
  });

  return {
    async init(scopeKey, mountNativeIds, privateNativeIds = []) {
      const at = ++selectionVersion;
      const keepSelection = collectionId === scopeKey && (picked || suggested);
      collectionId = scopeKey;
      mounts = new Set(mountNativeIds);
      privateNative = new Set(privateNativeIds);
      if (keepSelection) { host.onChosen?.(); return; }
      const wasOpen = !host.destPanel.hidden;
      if (!wasOpen) {
        host.destPanel.hidden = true;
        host.destToggle.setAttribute('aria-expanded', 'false');
      }
      host.folderCurrent.textContent = '';
      folderRootHint = '';
      chosenId = '';
      picked = suggested = false; restoredPick = '';
      try {
        if (typeof chrome.bookmarks === 'undefined') return;
        try {
          if (!await chrome.permissions.contains({ permissions: ['bookmarks'] })) return;
          /* The device scope has no sync mounts: a remembered folder is valid
             anywhere. A destination is always chosen by the user. */
          const once = await readOnceFolder(scopeKey);
          const fallback = await readDefaultFolder();
          let target = '';
          // Recent folders remain shortcuts; they cannot override the explicit default.
          for (const id of [once?.folderNativeId, fallback?.folderNativeId]) {
            if (!id) continue;
            const [node] = await chrome.bookmarks.get(id).catch(() => []);
            if (at !== selectionVersion) return;
            if (node?.parentId && node.url === undefined && !node.unmodifiable && !await isUnsupportedBookmarkFolder(id)) {
              if (at !== selectionVersion) return;
              target = id; if (id === once?.folderNativeId) restoredPick = id; break;
            }
          }
          if (at !== selectionVersion) return;
          chosenId = target;
          folderRootHint = chosenId;
          if (!chosenId) { await openPicker(); return; }
          if ((await chrome.bookmarks.get(chosenId)).length === 0) return;
          await updateLabel();
        } catch { /* A failed folder lookup leaves the destination unset. */ }
      } finally {
        if (wasOpen) await renderTree();
        host.onChosen?.();
      }
    },
    chosenFolderId: () => chosenId,
    async chooseSuggestedFolder(nativeId, anyFolder = false) {
      const collection = collectionId;
      const node = (await chrome.bookmarks.get(nativeId).catch(() => []))[0];
      if (!node || node.url !== undefined || node.unmodifiable || await isUnsupportedBookmarkFolder(nativeId) || collection !== collectionId) return false;
      if (anyFolder ? (await (host.excludedFolderIds ?? (() => exclusionIds(true)))()).has(nativeId)
        : !folderIsInSyncRange(nativeId, await walkAncestorIds(nativeId, chromeParent), mounts, privateNative)) return false;
      await pickFolder(nativeId, true, false); return true;
    },
    async isOutOfRange() {
      if (!chosenId || mounts.size === 0) return mounts.size === 0;
      const ancestors = await walkAncestorIds(chosenId, chromeParent);
      return !folderIsInSyncRange(chosenId, ancestors, mounts, privateNative);
    },
    async adopt(nativeId) {
      selectionVersion++;
      chosenId = nativeId;
      // Back to no folder (a rule's folder is withdrawn): the pill asks for one again.
      if (nativeId) await updateLabel();
      else { host.folderCurrent.textContent = ''; currentTitle = ''; paintParent(''); paintNewLabel(); }
      host.onChosen?.();
    },
    userPicked: () => picked,
    explicit: () => picked || (restoredPick !== '' && chosenId === restoredPick),
    setParentVisible(visible) { parentVisible = visible; if (chosenId) void updateLabel(); else paintParent(''); },
    open: openPicker,
    close: closePicker,
    isOpen: () => !host.destPanel.hidden,
    syncTarget: () => resolveFolderSyncTarget({ folderId: chosenId, mounts, privateNative, getParent: chromeParent,
      ...(collectionId && collectionId !== DEVICE_FOLDER_SCOPE ? { boundCollectionId: collectionId } : {}) }),
    async commit(id) {
      if (!id || !chosenId) return;
      await commitSaveFolder({ folderNativeId: chosenId });
    },
  };

  async function chromeParent(id: string): Promise<string | undefined> {
    const nodes = await chrome.bookmarks.get(id).catch(() => []);
    return nodes[0]?.parentId;
  }

  async function updateLabel(): Promise<void> {
    let title = t('sync_folder', 'Folder');
    let parent = '';
    try {
      const [node] = await chrome.bookmarks.get(chosenId);
      title = node?.title || title;
      if (parentVisible && node?.parentId) {
        const [above] = await chrome.bookmarks.get(node.parentId).catch(() => []);
        parent = above?.title ?? '';
      }
    } catch { /* The generic label stands. */ }
    host.folderCurrent.textContent = title;
    currentTitle = title;
    paintParent(parent);
    paintNewLabel();
  }

  function paintParent(parent: string): void {
    if (!host.folderParent) return;
    host.folderParent.textContent = parent ? `${parent} ›` : '';
    host.folderParent.hidden = !parent;
  }

  /** "New folder in <folder>": the row names where the folder will be created. */
  function paintNewLabel(): void {
    if (!host.folderNewLabel) return;
    host.folderNewLabel.textContent = currentTitle
      ? t('popup_newFolderIn', 'New folder in $1', currentTitle) : t('popup_newFolder', 'New folder');
  }

  /** The "New folder" row and its input row swap places. */
  function setCreating(creating: boolean): void {
    if (!host.folderCreate || !host.folderNewOpen) return;
    host.folderCreate.hidden = !creating;
    host.folderNewOpen.hidden = creating;
    if (creating) host.folderNewName.focus();
  }

  function closePicker(): void {
    host.destPanel.hidden = true;
    host.destToggle.setAttribute('aria-expanded', 'false');
  }

  async function togglePicker(): Promise<void> {
    if (!host.destPanel.hidden) { closePicker(); return; }
    await openPicker();
  }

  async function openPicker(): Promise<void> {
    await renderTree();
    host.destPanel.hidden = false;
    host.destToggle.setAttribute('aria-expanded', 'true');
    setCreating(host.folderNewName.value !== '');
    host.destSearch?.focus({ preventScroll: true });
    host.destPanel.scrollIntoView?.({ block: 'nearest' });
  }

  /* One listbox in the browser's own folder order. Recently used folders
     lead in their own group, so the common pick is one click, as in the
     native dialog; the filter hides that group while it searches. */
  async function renderTree(): Promise<void> {
    host.folderTree.replaceChildren();
    let tree: chrome.bookmarks.BookmarkTreeNode[] = [];
    try { tree = await chrome.bookmarks.getTree(); } catch { return; }
    const excluded = await (host.excludedFolderIds ?? (() => exclusionIds(true)))()
      .catch(() => new Set<string>()); // The save guard still refuses a read-only folder.
    const rows = buildFolderRows(tree as FolderTreeNode[], { mounts, excluded });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const recent = (await readFolderRecents()).flatMap((id) => byId.get(id) ?? []);
    if (recent.length > 0) {
      host.folderTree.append(
        group('recent', t('popup_recentFolders', 'Recent'), recent.map((row) => ({ ...row, depth: 0 }))),
        group('all', t('popup_allFolders', 'All folders'), rows),
      );
    } else {
      host.folderTree.append(...rows.map(option));
    }
    // Roving tabindex: the first row of the chosen folder is the one tab stop; arrows roam.
    const options = Array.from(host.folderTree.querySelectorAll<HTMLButtonElement>('[data-folder-id]'));
    const stop = options.find((item) => item.dataset.folderId === chosenId) ?? options[0];
    if (stop) stop.tabIndex = 0;
  }

  function group(name: string, label: string, rows: readonly FolderRow[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'group');
    wrap.dataset.folderGroup = name;
    const heading = document.createElement('p');
    heading.className = 'folder-group folder-group-label';
    heading.id = `folder-group-${name}`;
    heading.textContent = label;
    wrap.setAttribute('aria-labelledby', heading.id);
    wrap.append(heading, ...rows.map(option));
    return wrap;
  }

  function option(folder: FolderRow): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'folder-opt';
    row.setAttribute('role', 'option');
    row.dataset.folderId = folder.id;
    if (folder.synced) row.dataset.synced = '';
    row.style.setProperty('--depth', String(folder.depth));
    const label = document.createElement('span');
    label.className = 'option-label';
    label.textContent = folder.title;
    row.title = folder.title;
    row.append(createIcon('folder', 14), label);
    row.setAttribute('aria-selected', folder.id === chosenId ? 'true' : 'false');
    row.tabIndex = -1;
    row.addEventListener('click', () => { void pickFolder(folder.id); });
    return row;
  }

  /* A pick always applies at once, whatever the sync range — like the
     native dialog. Whether it syncs is passive status (host.onChosen), never
     a question: a question here left the old folder chosen while it waited,
     so Enter saved somewhere the user had just clicked away from. */
  async function pickFolder(id: string, close = true, userPick = true): Promise<void> {
    selectionVersion++;
    const changed = id !== chosenId;
    chosenId = id;
    if (userPick) picked = true;
    suggested = !userPick;
    if (userPick && collectionId && host.remember !== false) await rememberSaveFolder({ collectionId, folderNativeId: id });
    await updateLabel();
    host.onChosen?.();
    if (userPick && changed && host.onPick) void Promise.resolve(host.onPick(id)).catch(() => undefined);
    if (close) {
      host.destPanel.hidden = true;
      host.destToggle.setAttribute('aria-expanded', 'false');
      host.destToggle.focus();
      return;
    }
    await renderTree();
  }

  async function createFolder(): Promise<void> {
    const title = host.folderNewName.value.trim();
    if (!title) { host.folderNewName.focus(); return; }
    try {
      const created = await personalBookmarks.create({ parentId: chosenId || folderRootHint, title });
      host.folderNewName.value = '';
      host.persistDraft();
      setCreating(false);
      await pickFolder(created.id, false);
      host.folderNewOpen?.focus();
    } catch {
      host.setFeedback(t('popup_couldntCreateFolderTry', "Couldn't create the folder. Try again."), 'error');
    }
  }
}
