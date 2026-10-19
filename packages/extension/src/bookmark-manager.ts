import { openBookmarkEditor, openFolderEditor, managerFolderDescriptionField } from './bookmark-manager-editor.js';
import { readNativeFolderDescriptions } from './folder-description-native.js';
import { createManagerPage } from './bookmark-manager-page.js';
import { createBookmarkManagerNavigation } from './bookmark-manager-navigation.js';
import { createViewRefresh, preserveViewPosition } from './view-refresh.js';
import { bindBookmarkManagerBatch } from './bookmark-manager-batch-ui.js';
import { bookmarkTotals, icon, iconTile, isInViewport, isNodeSynced, normalizedUrl, type NativeNode, type ManagerElements } from './bookmark-manager-dom.js';
import { createManagerAnnotations } from './bookmark-manager-annotations.js';
import { countTags, liveAnnotations, openBulkTagDialog, openTagPicker, renderTagPath, renderTreeTags, retag, taggedNodes, tagKey, toggleTag,
  type TagCount, type TagMatch } from './bookmark-manager-tags.js';
import { createManagerMenu } from './bookmark-manager-menu.js';
import { openMoveDialog } from './bookmark-manager-move.js';
import { renderManagerRow } from './bookmark-manager-rows.js';
import { renderManagerTree } from './bookmark-manager-tree.js';
import { projectManagerRoot } from './bookmark-manager-visibility.js';
import { exclusionIds } from './bookmark-subscriptions/guards.js';
import { emptyBlock } from './library-dom.js';
import { showToast } from './toast.js';
import type { BookmarkAnnotation } from './bookmark-annotation-store.js';
import type { PublicRootBoundaries, RootRequest, RootResponse } from './types.js';
import { createManagerNode } from './bookmark-manager-create.js'; import { createDropValidator, projectVisibleChildren } from './bookmark-manager-order.js';
import { folderPinState, loadPinView, loadResultPins, projectPinnedChildren, togglePin, type PinState, type PinView } from './bookmark-manager-pins.js';
import { t, tn } from './i18n.js';
/** Edge-style options manager operating directly on the native chrome.bookmarks tree.
 * Sync captures each mutation, so edits behave like changes made in the browser manager. */


type BookmarksApi = typeof chrome.bookmarks;

export function createBookmarkManager(elements: ManagerElements) {
  const page = createManagerPage();
  const navigation = createBookmarkManagerNavigation(elements.pane);
  const annotations = createManagerAnnotations();
  const menu = createManagerMenu();
  let active = false;
  let permissionGranted = false;
  let rootId = '0';
  let currentFolderId = '';
  let expanded = new Set<string>();
  let boundaries: PublicRootBoundaries = { selected: [], privateLocal: [] };
  let nodesById = new Map<string, NativeNode>();
  let totals: ReadonlyMap<string, number> = new Map();
  let notes: ReadonlyMap<string, BookmarkAnnotation> = new Map();
  let folderDescriptions:ReadonlyMap<string,string|null>=new Map();
  let pinView: PinView | undefined;
  /** Search and tag results: each bookmark's pin, read against its own folder. */
  let resultPins: ReadonlyMap<string, PinState> = new Map();
  const pinState = (node: NativeNode): PinState | undefined => folderPinState(pinView, node) ?? resultPins.get(node.id);
  // Chosen tags replace the folder with every bookmark that carries them; choosing a folder clears them.
  let selectedTags: string[] = []; let tagMatch: TagMatch = 'all'; let tagCounts: readonly TagCount[] = [];
  let refreshGeneration = 0;
  const invalidation = createViewRefresh({ active: () => active, editing: hasPendingEditor, refresh: () => refresh(true) });
  let composer: 'folder' | 'bookmark' | undefined;
  let moveSourceId: string | undefined;
  let listenersBound = false; let foldersFirst = true; let selectMode = false;
  const dropValidator = createDropValidator(() => nodesById, () => foldersFirst, () => ({ id: currentFolderId, pinView }));
  const selected = new Set<string>();
  /** The folder, search or tags on screen. A selection belongs to it: actions never reach rows the user can't see. */
  let viewKey = '';
  const batch = bindBookmarkManagerBatch({
    selectedIds: () => selected,
    select: (id, range) => toggleSelect(id, range, true),
    nodes: () => nodesById,
    rootId: () => rootId,
    refresh: () => refresh(),
    feedback: (copy, tone) => feedback(copy, tone),
    tag: (trigger) => { void beginBulkTag(trigger); },
    selecting: () => selectMode || selected.size > 0,
    allSelected: () => allRowsSelected(),
    selectAll: () => toggleSelectAll(),
    committed: () => endSelection(),
  });

  chrome.runtime.onMessage?.addListener(message=>{if(message&&typeof message==='object'&&'kind' in message
    && (message.kind==='known.folderDescriptions.updated'||message.kind==='known.bookmarkAnnotations.updated'))invalidation.invalidate();});
  elements.gateButton.addEventListener('click', () => { void requestPermission(); });
  elements.newFolder.addEventListener('click', () => { startComposer('folder'); });
  elements.newBookmark.addEventListener('click', () => { startComposer('bookmark'); });
  // Each search reads the whole tree, so typing waits for a pause; clearing the field answers at once.
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  elements.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { void refresh(); }, elements.search.value.trim() ? 150 : 0);
  });
  elements.selectToggle.addEventListener('click', () => {
    if (selecting()) endSelection(); else { selectMode = true; syncSelectionRows(); }
  });
  // Escape leaves selection, unless a menu or the search field claims the key first.
  elements.body.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !selecting() || menu.isOpen() || event.target === elements.search) return;
    event.preventDefault(); endSelection();
  });
  // Edge-manager keyboard affordances on the focused row.
  elements.list.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') return;
    const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('.mgr-row') : null;
    const node = row?.dataset.id ? nodesById.get(row.dataset.id) : undefined;
    if (!row || !node || node.unmodifiable === 'managed' || !row.contains(document.activeElement)) return;
    if (event.key === 'Delete') { event.preventDefault(); beginDelete(node); }
    else if (event.key === 'F2') { event.preventDefault(); beginEdit(node, row); }
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      openMenuAt(rect.left + 8, rect.bottom - 4, node, row);
    }
  });
  elements.list.addEventListener('dragover', (event) => {
    if (moveSourceId && !(event.target as HTMLElement).closest('.mgr-row') && viewKey.startsWith('folder:') && dropValidator.canDropInto(moveSourceId, currentFolderId)) {
      event.preventDefault(); elements.list.dataset.drop = 'into';
    }
  });
  elements.list.addEventListener('dragleave', (event) => { if (!elements.list.contains(event.relatedTarget as Node | null)) delete elements.list.dataset.drop; });
  elements.list.addEventListener('drop', (event) => {
    if ((event.target as HTMLElement).closest('.mgr-row')) return;
    delete elements.list.dataset.drop;
    if (viewKey.startsWith('folder:') && dropValidator.canDropInto(moveSourceId ?? '', currentFolderId)) { event.preventDefault(); void dropInto(event, currentFolderId); }
  });

  async function activate(): Promise<void> {
    active = true;
    await evaluatePermission();
    if (permissionGranted) { bindNativeListeners(); await reloadBoundaries(); await batch.refreshStatus(); }
    if (!hasPendingEditor()) await refresh(); else await navigation.prepare(nodesById, true);
    invalidation.wake();
  }
  function deactivate(): void { active = false; refreshGeneration++; navigation.reset(); }

  async function evaluatePermission(): Promise<void> {
    try { permissionGranted = await chrome.permissions.contains({ permissions: ['bookmarks'] }); }
    catch { permissionGranted = false; }
    const bindingMissing = permissionGranted && !bookmarksApi();
    elements.gate.hidden = permissionGranted && !bindingMissing;
    elements.body.hidden = !permissionGranted || bindingMissing;
    elements.reloadHint.hidden = !bindingMissing;
    elements.gateButton.hidden = bindingMissing;
    // One primary action per view: while access is off, Allow bookmark access leads and the welcome's Import steps back.
    const welcomeImport = document.getElementById('welcome-import');
    welcomeImport?.classList.toggle('btn-primary', elements.gate.hidden);
    welcomeImport?.classList.toggle('btn-secondary', !elements.gate.hidden);
  }

  async function requestPermission(): Promise<boolean> {
    let granted = false;
    try { granted = await chrome.permissions.request({ permissions: ['bookmarks'] }); }
    catch { granted = false; }
    if (granted && !bookmarksApi()) { location.reload(); return true; }
    if (granted) {
      void chrome.runtime.sendMessage({ kind: 'known.roots.permissionChanged', userGesture: true,
        granted: true } satisfies RootRequest).catch(() => undefined);
    }
    await activate();
    return granted;
  }

  function bookmarksApi(): BookmarksApi | undefined {
    const holder = chrome as { bookmarks?: BookmarksApi };
    return holder.bookmarks && typeof holder.bookmarks.getTree === 'function' ? holder.bookmarks : undefined;
  }

  function bindNativeListeners(): void {
    const api = bookmarksApi();
    if (!api || listenersBound) return;
    listenersBound = true;
    const schedule = invalidation.invalidate;
    api.onCreated?.addListener?.(schedule);
    api.onRemoved?.addListener?.(schedule);
    api.onChanged?.addListener?.(schedule);
    api.onMoved?.addListener?.(schedule);
  }

  function hasPendingEditor(): boolean { return composer !== undefined || menu.isOpen() || Boolean(document.querySelector('dialog[open]')); }
  async function reloadBoundaries(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({ kind: 'known.roots.boundaries' } satisfies RootRequest) as RootResponse;
      if (response.ok && 'boundaries' in response) boundaries = response.boundaries;
    } catch { /* the sync mark stays hidden without a worker connection */ }
  }
  const hiddenFolders = (): Promise<ReadonlySet<string>> => exclusionIds().catch(() => new Set<string>());

  async function refresh(background = false): Promise<void> {
    if (!active) return;
    const version = ++refreshGeneration;
    const restore = preserveViewPosition(elements.pane);
    await evaluatePermission();
    const api = bookmarksApi();
    if (version !== refreshGeneration || !active || !permissionGranted || !api) return;
    let roots: readonly NativeNode[];
    try { roots = await api.getTree() as readonly NativeNode[]; }
    catch { feedback(t('manager_bookmarkTreeCouldNot', 'The bookmark tree could not be read. Try again.'), 'error'); return; }
    if (version !== refreshGeneration || !active) return;
    if (background && hasPendingEditor()) { invalidation.invalidate(); return; }
    const nativeRoot = roots[0];
    if (!nativeRoot) return;
    const top = projectManagerRoot(nativeRoot);
    folderDescriptions=await readNativeFolderDescriptions(roots).catch(()=>new Map<string,string|null>());
    if (version !== refreshGeneration || !active) return;
    rootId = top.id;
    nodesById = new Map();
    indexNodes(top);
    totals = bookmarkTotals(top);
    for (const id of selected) if (!nodesById.has(id)) selected.delete(id);
    const location = await navigation.prepare(nodesById, hasPendingEditor());
    if (version !== refreshGeneration || !active) return;
    if (location) { page.locate(location.nativeId); currentFolderId = location.folderId; for (const id of location.ancestors) expanded.add(id); elements.search.value = ''; selectedTags = []; }
    if (!currentFolderId || !nodesById.has(currentFolderId)) {
      currentFolderId = top.children?.[0]?.id ?? top.id;
      expanded = new Set([top.id, ...(top.children ?? []).map((child) => child.id)]);
    }
    const tagged = liveAnnotations(await annotations.all(), nodesById);
    if (version !== refreshGeneration || !active) return;
    tagCounts = countTags(tagged);
    // A tag that no bookmark carries any more drops out of the filter.
    selectedTags = selectedTags.filter((tag) => tagCounts.some((entry) => tagKey(entry.tag) === tagKey(tag)));
    renderManagerTree(elements.tree, top, { nodes: nodesById, totals, synced: boundaries.selected, currentId: selectedTags.length ? '' : currentFolderId, expanded,
      open: (id) => { currentFolderId = id; selectedTags = []; elements.search.value = ''; composer = undefined; void refresh(); },
      changed: () => { void refresh(); },
      dragOver: (event, row) => { event.preventDefault(); row.dataset.drop = 'true'; },
      drop: (event, id) => { event.preventDefault(); void dropInto(event, id); } });
    renderTreeTags(elements.tree, { counts: tagCounts, selected: selectedTags, toggle: chooseTag,
      showAll: (trigger) => openTagPicker({ counts: tagCounts, selected: () => selectedTags, toggle: chooseTag }, trigger) });
    const query = elements.search.value.trim();
    const nextView = selectedTags.length ? `tags:${selectedTags.map(tagKey).join('\n')}:${tagMatch}` : query ? `search:${query}` : `folder:${currentFolderId}`;
    if (nextView !== viewKey) { viewKey = nextView; selected.clear(); selectionAnchor = undefined; }
    if (selectedTags.length || query) pinView = undefined; else resultPins = new Map();
    if (selectedTags.length) {
      const byId = new Map(tagged.map((row) => [row.nativeId, row]));
      const pins = await loadResultPins(taggedMatches(byId, query), byId);
      if (version !== refreshGeneration || !active) return;
      resultPins = pins; renderTagged(byId, query);
    } else if (query) await renderSearch(api, query, version);
    else {
      const folder = nodesById.get(currentFolderId);
      const loaded = await annotations.load(folder?.children ?? []);
      const pins = folder && folder.id !== rootId ? await loadPinView(folder.id, folder.children ?? [], loaded) : undefined;
      if (version !== refreshGeneration || !active) return;
      notes = loaded; pinView = pins; renderFolder();
    }
    if (version === refreshGeneration) { restore(); navigation.highlight(elements.list); syncSelectionRows(); }
  }

  function indexNodes(node: NativeNode): void {
    nodesById.set(node.id, node);
    for (const child of node.children ?? []) indexNodes(child);
  }

  function chooseTag(tag: string): void { selectedTags = toggleTag(selectedTags, tag); composer = undefined; void refresh(); }

  const rowHost = {
    openFolder: (node: NativeNode) => { currentFolderId = node.id; selectedTags = []; expanded.add(node.parentId ?? ''); elements.search.value = ''; composer = undefined; void refresh(); },
    edit: (node: NativeNode, row: HTMLElement) => beginEdit(node, row),
    menu: (event: MouseEvent | undefined, node: NativeNode, row: HTMLElement, anchor?: HTMLElement) => {
      if (event) { event.preventDefault(); openMenuAt(event.clientX, event.clientY, node, row); return; }
      const rect = (anchor ?? row).getBoundingClientRect();
      openMenuAt(rect.left, rect.bottom + 4, node, anchor ?? row);
    },
    select: (id: string, range: boolean, deliberate: boolean) => toggleSelect(id, range, deliberate),
    dragSource: () => moveSourceId,
    setDragSource: (id: string | undefined) => { moveSourceId = id; },
    dropInto: (event: DragEvent, folderId: string) => { void dropInto(event, folderId); },
    dropBefore: (event: DragEvent, target: NativeNode) => { void dropAdjacent(event, target, 0); },
    dropAfter: (event: DragEvent, target: NativeNode) => { void dropAdjacent(event, target, 1); },
    filterTag: chooseTag,
    tagActive: (tag: string) => selectedTags.some((value) => tagKey(value) === tagKey(tag)),
    canDropBefore: dropValidator.canDropBefore, canDropAfter: dropValidator.canDropAfter, canDropInto: dropValidator.canDropInto,
    pin: (node: NativeNode, trigger: HTMLElement) => { void togglePin(node, pinState(node), trigger, feedback).then(() => refresh()); },
  };

  function renderFolder(): void {
    const folder = nodesById.get(currentFolderId);
    elements.list.replaceChildren();
    renderPath(folder);
    const canCompose = Boolean(folder) && folder!.unmodifiable !== 'managed' && folder!.id !== rootId;
    elements.newFolder.disabled = !canCompose;
    elements.newBookmark.disabled = !canCompose;
    if (!folder) return;
    if (composer) elements.list.append(composerRow(folder.id));
    const children = projectPinnedChildren(projectVisibleChildren(folder.children ?? [], foldersFirst), pinView);
    if (children.length === 0 && !composer) {
      elements.list.append(emptyBlock({ icon: 'folder', title: t('manager_folderEmptyTitle', 'This folder is empty'),
        hint: t('manager_folderEmptyHint', 'Add a bookmark or folder here, or drag items in from another folder.') }));
      return;
    }
    page.render(elements.list, folder.id, children, child => decorate(itemRow(child), child), () => { renderFolder(); syncSelectionRows(); });
  }

  function itemRow(node: NativeNode, location?: string): HTMLElement {
    const state = pinState(node);
    const pin = state ? { pinned: state.pinned, available: state.blockers.length === 0 } : undefined;
    return renderManagerRow(node, { ...(location ? { location } : {}), description: folderDescriptions.get(node.id), annotation: notes.get(node.id), ...(pin ? { pin } : {}) }, rowHost);
  }

  function renderPath(folder: NativeNode | undefined): void {
    elements.path.replaceChildren();
    elements.syncState.replaceChildren(); elements.syncState.hidden = true;
    if (!folder) return;
    const chain: NativeNode[] = [];
    let cursor: NativeNode | undefined = folder;
    while (cursor && cursor.id !== rootId) { chain.unshift(cursor); cursor = cursor.parentId ? nodesById.get(cursor.parentId) : undefined; }
    chain.forEach((node, position) => {
      if (position > 0) { const divider = document.createElement('span'); divider.className = 'mgr-crumb-divider';
        divider.textContent = '›'; divider.setAttribute('aria-hidden', 'true'); elements.path.append(divider); }
      const crumb = document.createElement('button');
      crumb.type = 'button'; crumb.className = 'mgr-crumb';
      crumb.textContent = node.title || t('common_untitledFolder', 'Untitled folder');
      crumb.setAttribute('aria-current', position === chain.length - 1 ? 'location' : 'false');
      crumb.addEventListener('click', () => { currentFolderId = node.id; composer = undefined; void refresh(); });
      elements.path.append(crumb);
    });
    // Sync state only means something once some folder syncs.
    if (folder.id !== rootId && boundaries.selected.length > 0) {
      const synced = isNodeSynced(folder.id, nodesById, boundaries);
      elements.syncState.append(icon('sync'), document.createTextNode(synced ? t('manager_synced', 'Synced') : t('manager_notSynced', 'Not synced')));
      elements.syncState.title = synced ? t('manager_syncedFolderSyncedKnow', 'In a synced folder · synced with your library') : t('manager_stayLocalNotSynced', 'Not in a synced folder · stays on this browser');
      elements.syncState.hidden = false;
    }
  }

  const taggedMatches = (byId: ReadonlyMap<string, BookmarkAnnotation>, query: string): NativeNode[] =>
    taggedNodes(nodesById.values(), byId, selectedTags, tagMatch, query);

  function renderTagged(byId: ReadonlyMap<string, BookmarkAnnotation>, query: string): void {
    const matched = taggedMatches(byId, query);
    notes = byId;
    elements.list.replaceChildren();
    elements.path.replaceChildren(); elements.syncState.replaceChildren();
    renderTagPath(elements.path, elements.syncState, { selected: selectedTags, match: tagMatch, total: matched.length,
      toggle: chooseTag, setMatch: (match) => { tagMatch = match; void refresh(); }, clear: () => { selectedTags = []; void refresh(); } });
    elements.syncState.hidden = false; elements.syncState.removeAttribute('title');
    if (matched.length === 0) {
      const clear = document.createElement('button');
      clear.type = 'button'; clear.className = 'btn btn-secondary btn-sm'; clear.textContent = t('manager_clearTags', 'Clear tags');
      clear.addEventListener('click', () => { selectedTags = []; elements.search.value = ''; void refresh(); });
      elements.list.append(emptyBlock({ icon: 'search', title: t('manager_noBookmarksMatchTags', 'No bookmarks match these tags.'),
        hint: selectedTags.length > 1 && tagMatch === 'all' ? t('manager_noBookmarkHasAllTags', 'No bookmark has all of them. Remove one, or match any tag.') : undefined, action: clear }));
      return;
    }
    page.render(elements.list, `tags:${selectedTags.map(tagKey).join('\n')}:${tagMatch}`, matched,
      (node) => decorate(itemRow(node, locationOf(node)), node), () => { renderTagged(byId, query); syncSelectionRows(); });
  }

  async function renderSearch(api: BookmarksApi, query: string, version: number): Promise<void> {
    let results: readonly NativeNode[] = [];
    try { results = await api.search({ query }) as readonly NativeNode[]; } catch { results = []; }
    results = results.filter(node => nodesById.has(node.id));
    // Tags and notes are searchable too, even though the browser knows nothing about them.
    const byNote = await annotations.search(query);
    const seen = new Set(results.map((node) => node.id));
    results = [...results, ...byNote.filter((id) => !seen.has(id) && nodesById.get(id)?.url !== undefined).map((id) => nodesById.get(id)!)];
    if (version !== refreshGeneration || !active || query !== elements.search.value.trim()) return;
    const shown = results.slice(0, 200).map((node) => nodesById.get(node.id) ?? node);
    const loaded = await annotations.load(shown);
    const pins = await loadResultPins(shown, loaded);
    if (version !== refreshGeneration || !active || query !== elements.search.value.trim()) return;
    notes = loaded; resultPins = pins;
    elements.list.replaceChildren();
    elements.path.replaceChildren(); elements.syncState.hidden = true;
    const heading = document.createElement('span'); heading.className = 'mgr-crumb';
    heading.textContent = t('manager_searchResults', 'Search results ($1)', results.length);
    elements.path.append(heading);
    if (results.length === 0) {
      elements.list.append(emptyBlock({ icon: 'search', title: t('manager_noBookmarksMatchSearch', 'No bookmarks match this search.'),
        hint: t('manager_searchHint', 'Search looks at titles, addresses, tags and notes.') }));
      return;
    }
    for (const node of shown) elements.list.append(decorate(itemRow(node, locationOf(node)), node));
  }

  function decorate(row: HTMLElement, node: NativeNode): HTMLElement {
    batch.decorateRow(row, node, selected.has(node.id));
    return row;
  }

  let selectionAnchor: string | undefined;
  const selecting = () => selectMode || selected.size > 0;
  function toggleSelect(id: string, range: boolean, deliberate: boolean): void {
    if (nodesById.get(id)?.unmodifiable === 'managed') return;
    if (!selecting() && !deliberate) return;
    const rows = Array.from(elements.list.querySelectorAll<HTMLElement>('.mgr-row[data-id]'));
    if (range && selectionAnchor) {
      const ids = rows.map((row) => row.dataset.id ?? '');
      const from = ids.indexOf(selectionAnchor); const to = ids.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        for (const rangeId of ids.slice(lo, hi + 1)) {
          if (nodesById.get(rangeId)?.unmodifiable !== 'managed') selected.add(rangeId);
        }
        syncSelectionRows();
        return;
      }
    }
    selectionAnchor = id;
    if (selected.has(id) && !range) selected.delete(id); else selected.add(id);
    syncSelectionRows();
  }

  // Declarations, not arrows: the batch bar asks for them while the manager is still being built.
  function selectableRows(): HTMLElement[] {
    return Array.from(elements.list.querySelectorAll<HTMLElement>('.mgr-row[data-id]'))
      .filter((row) => nodesById.get(row.dataset.id!)?.unmodifiable !== 'managed');
  }
  function allRowsSelected(): boolean {
    const rows = selectableRows();
    return rows.length > 0 && rows.every((row) => selected.has(row.dataset.id!));
  }
  /** Select all checks every row on screen; once they all are, the same button clears them. */
  function toggleSelectAll(): void {
    const every = allRowsSelected();
    for (const row of selectableRows()) { if (every) selected.delete(row.dataset.id!); else selected.add(row.dataset.id!); }
    selectMode = true; selectionAnchor = undefined;
    syncSelectionRows();
  }
  function endSelection(): void {
    selected.clear(); selectionAnchor = undefined; selectMode = false;
    syncSelectionRows();
  }

  /** Checkboxes show only while selecting; the Select button turns into Done. */
  function syncSelectionRows(): void {
    for (const row of Array.from(elements.list.querySelectorAll<HTMLElement>('.mgr-row[data-id]'))) {
      const on = selected.has(row.dataset.id ?? '');
      row.toggleAttribute('data-selected', on);
      const box = row.querySelector<HTMLInputElement>('input.mgr-select');
      if (box) box.checked = on;
    }
    const on = selecting();
    elements.card.toggleAttribute('data-selecting', on);
    elements.selectToggle.textContent = on ? t('common_done', 'Done') : t('manager_select', 'Select');
    elements.selectToggle.setAttribute('aria-pressed', String(on));
    batch.selectionChanged();
  }

  function locationOf(node: NativeNode): string {
    const parts: string[] = [];
    let cursor = node.parentId ? nodesById.get(node.parentId) : undefined;
    while (cursor && cursor.id !== rootId) { parts.unshift(cursor.title || t('common_untitledFolder', 'Untitled folder')); cursor = cursor.parentId ? nodesById.get(cursor.parentId) : undefined; }
    return parts.join(' › ');
  }

  /** New items go into the open folder: from search or tag results, that means going back to it first. */
  function startComposer(kind: 'folder' | 'bookmark'): void {
    const folder = nodesById.get(currentFolderId);
    if (!folder || folder.unmodifiable === 'managed' || folder.id === rootId) return;
    composer = kind; selectedTags = []; elements.search.value = ''; void refresh();
  }

  function composerRow(parentId: string): HTMLElement {
    const kind = composer!;
    const row = document.createElement('form');
    row.className = 'list-row mgr-row mgr-composer';
    const lead = document.createElement('span'); lead.className = 'mgr-lead'; lead.append(iconTile(kind === 'folder' ? 'folder' : 'globe'));
    const fields = document.createElement('span'); fields.className = 'list-row-main mgr-copy';
    const name = document.createElement('input');
    name.type = 'text'; name.className = 'field-quiet'; name.placeholder = kind === 'folder' ? t('common_folderName', 'Folder name') : t('common_bookmarkName', 'Bookmark name');
    name.setAttribute('aria-label', kind === 'folder' ? t('manager_newFolderName', 'New folder name') : t('manager_newBookmarkName', 'New bookmark name'));
    fields.append(name);
    const description=kind==='folder'?managerFolderDescriptionField():undefined;
    if(description)fields.append(description.label);
    let url: HTMLInputElement | undefined;
    if (kind === 'bookmark') {
      url = document.createElement('input');
      url.type = 'text'; url.className = 'field-quiet'; url.inputMode = 'url'; url.placeholder = 'https://example.com';
      url.setAttribute('aria-label', t('manager_newBookmarkUrl', 'New bookmark URL'));
      fields.append(url);
    }
    const actions = document.createElement('span'); actions.className = 'list-row-tail mgr-actions';
    const save = document.createElement('button');
    save.type = 'submit'; save.className = 'btn btn-primary btn-sm';
    save.textContent = kind === 'folder' ? t('common_createFolder', 'Create folder') : t('common_addBookmark', 'Add bookmark');
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn btn-ghost btn-sm'; cancel.textContent = t('common_cancel', 'Cancel');
    cancel.addEventListener('click', () => { composer = undefined; void refresh(); });
    actions.append(cancel, save);
    row.append(lead, fields, actions);
    row.addEventListener('submit', (event) => {
      event.preventDefault();
      const title = name.value.trim();
      if (!title) { name.focus(); return; }
      const address = url ? normalizedUrl(url.value) : undefined;
      if (url && !address) { feedback(t('manager_enterValidHttpS', 'Enter a valid http(s) address.'), 'error'); url.focus(); return; }
      void createNode(parentId, title, address, description?.input.value);
    });
    queueMicrotask(() => name.focus());
    return row;
  }

  async function createNode(parentId: string, title: string, url?: string, description?:string): Promise<void> {
    const api = bookmarksApi(); if (!api) return;
    try {
      await createManagerNode(api, parentId, title, url, description);
      composer = undefined;
      feedback(url ? t('common_bookmarkAdded', 'Bookmark added.') : t('common_folderCreated', 'Folder created.'), 'ok');
    } catch { feedback(t('manager_itemCouldNotCreated', 'The item could not be created.'), 'error'); }
    await refresh();
  }

  function beginEdit(node: NativeNode, row: HTMLElement): void {
    const api = bookmarksApi(); if (!api) return;
    const host = { api, annotations, root: () => nodesById.get(rootId), excluded: hiddenFolders, refresh, feedback };
    const trigger = row.querySelector<HTMLElement>('.mgr-action') ?? row;
    if (node.url === undefined) openFolderEditor(node, host, trigger); else openBookmarkEditor(node, host, trigger);
  }

  /** Bulk tags go through the same annotation save as the Edit dialog, one bookmark at a time. */
  async function beginBulkTag(trigger: HTMLElement): Promise<void> {
    const nodes = [...selected].map((id) => nodesById.get(id))
      .filter((node): node is NativeNode => node?.url !== undefined && node.unmodifiable !== 'managed');
    if (nodes.length === 0) { feedback(t('manager_selectBookmarksToTag', 'Select bookmarks to tag. Folders have no tags.'), 'error'); return; }
    const current = await annotations.load(nodes);
    openBulkTagDialog({ tagSets: nodes.map((node) => current.get(node.id)?.tags ?? []), vocabulary: tagCounts,
      apply: (change) => { void applyBulkTags(nodes, current, change); } }, trigger);
  }

  async function applyBulkTags(nodes: readonly NativeNode[], current: ReadonlyMap<string, BookmarkAnnotation>,
    change: { readonly add: string[]; readonly remove: string[] }): Promise<void> {
    let updated = 0, failed = 0;
    for (const node of nodes) {
      const before = current.get(node.id);
      const tags = retag(before?.tags ?? [], change.add, change.remove);
      if (tags.length === (before?.tags.length ?? 0) && tags.every((tag, index) => tag === before?.tags[index])) continue;
      const base = before ? { tags: before.tags, note: before.note } : undefined;
      if (await annotations.save(node, { tags, note: before?.note ?? null }, base)) updated++; else failed++;
    }
    if (failed) feedback(t('manager_bulkTagFailed', 'Updated tags on $1, $2 failed. Try again.', updated, failed), 'error');
    else feedback(tn('manager_bulkTagDone', updated, 'Updated tags on $1 bookmark.', 'Updated tags on $1 bookmarks.'), 'ok');
    endSelection();
    await refresh();
  }

  function beginDelete(node: NativeNode): void {
    void batch.beginWithIds('delete', [node.id]);
  }

  function openMenuAt(x: number, y: number, node: NativeNode, from: HTMLElement): void {
    const pin = pinState(node);
    const items = [
      node.url
        ? { label: t('manager_openNewTab', 'Open in new tab'), run: () => {
          void chrome.tabs.create({ url: node.url! }).catch(() => { window.open(node.url, '_blank', 'noreferrer'); });
        } }
        : { label: t('common_openFolder', 'Open folder'), run: () => rowHost.openFolder(node) },
      { label: node.url ? t('manager_editBookmark', 'Edit bookmark') : t('manager_editFolder', 'Edit folder'), run: () => beginEdit(node, from.closest<HTMLElement>('.mgr-row') ?? from) },
      ...(pin ? [{ label: pin.pinned ? t('pin_unpin', 'Unpin') : t('pin_pin', 'Pin'), run: () => rowHost.pin(node, from) }] : []),
      // Results come from anywhere; this opens the folder the row lives in, with the row picked out.
      ...(viewKey.startsWith('folder:') ? [] : [{ label: t('manager_showInFolder', 'Show in folder'), run: () => showInFolder(node) }]),
      { label: t('common_moveTo', 'Move to…'), run: () => beginMove(node, from) },
      { label: t('common_delete', 'Delete'), run: () => beginDelete(node), tone: 'danger' as const },
    ];
    menu.openAt(x, y, items, from);
  }

  function showInFolder(node: NativeNode): void {
    if (!node.parentId || !nodesById.has(node.parentId)) return;
    for (let id: string | undefined = node.parentId; id; id = nodesById.get(id)?.parentId) expanded.add(id);
    currentFolderId = node.parentId; selectedTags = []; elements.search.value = ''; composer = undefined;
    page.locate(node.id); navigation.reveal(node.id); void refresh();
  }

  function beginMove(node: NativeNode, from: HTMLElement): void {
    const top = nodesById.get(rootId); if (!top) return;
    void hiddenFolders().then((hidden) => openMoveDialog(top, [node], hidden, (parentId) => { void moveNode(node.id, parentId); }, from));
  }

  async function moveNode(id: string, parentId: string, index?: number): Promise<void> {
    const api = bookmarksApi(); if (!api) return;
    try { await api.move(id, { parentId, ...(index === undefined ? {} : { index }) }); feedback(t('common_moved', 'Moved.'), 'ok'); }
    catch { feedback(t('manager_itemCouldNotMoved', 'The item could not be moved.'), 'error'); }
    await refresh();
  }

  async function dropInto(event: DragEvent, folderId: string): Promise<void> {
    const id = event.dataTransfer?.getData('text/plain') || moveSourceId;
    moveSourceId = undefined;
    if (!id || id === folderId) return;
    if (!dropValidator.canDropInto(id, folderId)) { feedback(t('manager_folderCannotMoveInto', 'A folder cannot move into itself.'), 'error'); return; }
    await moveNode(id, folderId);
  }

  async function dropAdjacent(event: DragEvent, target: NativeNode, offset: 0 | 1): Promise<void> {
    const id = event.dataTransfer?.getData('text/plain') || moveSourceId;
    moveSourceId = undefined;
    const live = nodesById.get(target.id) ?? target;
    if (!id || id === live.id || live.parentId === undefined || live.index === undefined) return;
    if (!(offset === 0 ? dropValidator.canDropBefore(id, live) : dropValidator.canDropAfter(id, live))) return;
    await moveNode(id, live.parentId, live.index + offset);
  }

  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  function feedback(copy: string, tone: 'ok' | 'error'): void {
    elements.feedback.textContent = copy;
    elements.feedback.dataset.tone = tone;
    showToast(copy, tone);
    if (feedbackTimer) { clearTimeout(feedbackTimer); feedbackTimer = undefined; }
    if (tone === 'ok') feedbackTimer = setTimeout(() => { elements.feedback.textContent = ''; delete elements.feedback.dataset.tone; }, 4_000);
  }

  return Object.freeze({ activate, deactivate, requestPermission, reloadBoundaries: async () => { await reloadBoundaries(); invalidation.invalidate(); },
    preferencesChanged: async (next: boolean) => { foldersFirst = next; invalidation.invalidate(); } });
}
