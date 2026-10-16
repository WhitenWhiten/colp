import { folderCountCopy, folderMetaCopy } from './first-run-ui.js';
import type { bindFirstRunOnboarding } from './first-run-ui.js';
import { checkedRootRefs, outermostSelectedRefs, paintCoverage, recordFolderChoice, ROOTS_REPAINT } from './folder-coverage.js';
import { createIcon } from './icons.js';
import { t, tn } from './i18n.js';
import { el, emptyBlock } from './library-dom.js';
import type { PublicRootView, RootRequest, RootResponse } from './types.js';

export interface FoldersHost {
  readonly isConnected: () => boolean;
  /** Late-bound: the first-run controller is created after this pane and needs its tree. */
  readonly firstRun: () => Pick<ReturnType<typeof bindFirstRunOnboarding>, 'isRangeActive' | 'onRootsRendered'>;
}

/**
 * Sync › Folders: the checkable bookmark-folder tree. A folder is checked to
 * sync, and the folders inside it read checked with it (folder-coverage.ts);
 * a parent shows a dash when only some of what is inside it is checked.
 * Saving goes through the range preview (range-ui.ts) or, on the first run,
 * the first-sync confirm (first-run-ui.ts); both read this tree's inputs.
 */
export function bindFolders(host: FoldersHost) {
  const card = required('folder-card');
  const tree = required('root-tree');
  const alert = required('root-alert');
  const alertCopy = required('root-alert-copy');
  const retry = required('root-retry') as HTMLButtonElement;
  const feedback = required('root-feedback');
  const count = required('folder-count');
  const refresh = required('refresh-roots') as HTMLButtonElement;
  const save = required('save-roots') as HTMLButtonElement;
  const cancel = required('cancel-roots') as HTMLButtonElement;
  const grant = required('request-bookmark-permission') as HTMLButtonElement;
  const revoke = required('remove-bookmark-permission') as HTMLButtonElement;
  const selectAll = required('tree-select-level') as HTMLButtonElement;
  const invert = required('tree-invert') as HTMLButtonElement;
  const collapsed = new Set<string>();
  let view: PublicRootView | undefined;
  let preselect: string | undefined;

  refresh.addEventListener('click', () => { void load(); });
  retry.addEventListener('click', () => { void load(); });
  selectAll.addEventListener('click', () => { toggleVisible(true); });
  invert.addEventListener('click', () => { toggleVisible('invert'); });
  cancel.addEventListener('click', () => { if (view) { render(view); feedback.textContent = ''; } });
  tree.addEventListener('change', paint);
  tree.addEventListener(ROOTS_REPAINT, paint);

  async function load(): Promise<void> {
    refresh.disabled = true; feedback.textContent = '';
    if (!view && host.isConnected()) showEmpty(t('options_loadingBookmarkFolders', 'Loading bookmark folders…'), 'empty');
    const preselectFolderId = preselect; preselect = undefined;
    const response = await rootRequest({ kind: 'known.roots.get',
      ...(preselectFolderId !== undefined ? { preselectFolderId } : {}) });
    refresh.disabled = !host.isConnected();
    if (!response.ok || !('view' in response)) {
      renderFailure(response.ok ? 'request_invalid' : response.error);
      return;
    }
    render(response.view); save.disabled = !host.isConnected()
      || response.view.status === 'permission_required' || response.view.status === 'tree_unavailable';
  }

  function render(next: PublicRootView): void {
    view = next; tree.replaceChildren(); paintAlert(next.status);
    setPermissionControls(next.status === 'permission_required' ? 'required' : 'granted');
    const canEdit = next.status !== 'permission_required' && next.status !== 'tree_unavailable';
    selectAll.disabled = !canEdit || next.roots.length === 0;
    invert.disabled = !canEdit || next.roots.length === 0;
    if (next.roots.length === 0) {
      // A missing permission or an unreadable tree is said once, in the alert; the empty list says nothing more.
      showEmpty(next.status === 'ready' ? t('options_noBookmarkFoldersAvailable', 'No bookmark folders are available.') : '',
        next.status === 'permission_required' || next.status === 'tree_unavailable' ? 'blocked' : 'empty');
      paint(); return;
    }
    card.removeAttribute('data-roots');
    const counts = descendantCounts(next.roots);
    for (const [index, root] of next.roots.entries()) {
      const row = el('div', undefined, 'check-row root-row'); row.style.setProperty('--depth', String(root.depth));
      row.dataset.ref = root.ref; row.dataset.depth = String(root.depth);
      const toggle = el('button', undefined, 'tree-toggle'); toggle.type = 'button';
      if ((counts[index] ?? 0) === 0) { toggle.disabled = true; toggle.tabIndex = -1; toggle.setAttribute('aria-hidden', 'true'); }
      else {
        toggle.dataset.ref = root.ref; toggle.append(createIcon('chevron-down', 12));
        toggle.addEventListener('click', () => {
          if (collapsed.has(root.ref)) collapsed.delete(root.ref); else collapsed.add(root.ref);
          paintCollapsed();
        });
      }
      const selection = checkbox('root-select', root.ref, root.selected, root.managed, root.title);
      selection.input.addEventListener('change', () => recordFolderChoice(selection.input));
      const label = el('span', root.title, 'folder-name');
      const meta = el('span', undefined, 'folder-meta');
      /* Only the managed reason informs; a kind line echoed the name or said "Folder". */
      meta.textContent = folderMetaCopy(root); meta.hidden = !root.managed && root.exclusionReason !== 'managed';
      const tail = root.managed ? el('span', t('common_managed', 'Managed'), 'badge') : el('span', folderCountCopy(root), 'folder-count');
      selection.wrapper.append(createIcon('folder', 16), label, meta, tail);
      const privacy = checkbox('root-private', root.ref, root.privateLocal, false, t('sync_keepFolderOnBrowser', 'Keep $1 on this browser', root.title));
      privacy.wrapper.hidden = true;

      row.append(toggle, selection.wrapper, privacy.wrapper); tree.append(row);
      /* R13 D-21: the deep-linked folder arrives checked — draw the eye to it. */
      if (root.preselected === true) {
        selection.input.focus(); row.scrollIntoView({ block: 'nearest' });
        feedback.textContent = t('sync_folderHighlighted', '$1 is highlighted. Check it to include it in sync, then review your changes.', root.title);
      }
    }
    paintCollapsed(); paint();
    host.firstRun().onRootsRendered(next, host.isConnected(), document.body.dataset.library === 'ready');
  }

  function renderFailure(code: string): void {
    alert.hidden = true; retry.hidden = true; tree.replaceChildren();
    if (code === 'not_connected') {
      showEmpty(document.body.dataset.library === 'unsupported'
        ? t('auth_syncUnsupported', 'This server does not support bookmark sync yet.') : host.isConnected()
        ? t('sync_libraryConnecting', 'Your bookmark library is connecting. Refresh to try again.')
        : t('sync_signInLibrary', 'Sign in to sync this browser with your bookmark library.'), 'empty');
    } else {
      card.dataset.roots = 'blocked'; alert.hidden = false; alert.dataset.tone = 'danger'; retry.hidden = false; grant.hidden = true;
      alertCopy.textContent = t('options_folderSettingsCouldNot', 'Folder settings could not be loaded. Try again.');
    }
    feedback.textContent = ''; count.textContent = '';
    save.disabled = !host.isConnected();
  }

  function showEmpty(title: string, mode: 'empty' | 'blocked'): void {
    card.dataset.roots = mode;
    tree.replaceChildren(...(title ? [emptyBlock({ icon: 'folder', title })] : []));
  }

  function paintAlert(status: PublicRootView['status']): void {
    const copy = statusCopy(status);
    alert.hidden = copy === undefined; retry.hidden = status !== 'tree_unavailable';
    if (copy === undefined) return;
    alertCopy.textContent = copy;
    alert.dataset.tone = 'warning';
  }

  function setPermissionControls(state: 'disconnected' | 'required' | 'granted'): void {
    const required = state === 'required'; const granted = state === 'granted';
    grant.hidden = !required; grant.disabled = !required;
    revoke.hidden = !granted; revoke.disabled = !granted;
    refresh.disabled = !host.isConnected() || !granted; save.hidden = required; cancel.hidden = required;
    save.disabled = !host.isConnected() || !granted || !view || view.status === 'tree_unavailable';
  }

  /** Coverage, dashes on parents, the "3 of 6 folders" line and whether there is anything to cancel. */
  function paint(): void {
    paintCoverage(tree);
    const rows = Array.from(tree.querySelectorAll<HTMLElement>('.root-row'));
    const inputs = rows.map((row) => row.querySelector<HTMLInputElement>('.root-select input'));
    const depths = rows.map((row) => Number(row.dataset.depth));
    for (const [index, input] of inputs.entries()) {
      if (!input) continue;
      let inside = false;
      for (let next = index + 1; next < rows.length && depths[next]! > depths[index]!; next += 1) {
        if (inputs[next]?.checked) { inside = true; break; }
      }
      input.indeterminate = input.checked && !inside && index + 1 < rows.length && depths[index + 1]! > depths[index]!;
      if (input.checked && inside) {
        let allChecked = true;
        for (let next = index + 1; next < rows.length && depths[next]! > depths[index]!; next++) if (!inputs[next]?.checked) allChecked = false;
        input.indeterminate = !allChecked;
      }
    }
    for (const [index, input] of inputs.entries()) if (input) {
      rows[index]!.dataset.partiallySynced = String(input.indeterminate);
      if (input.indeterminate) input.checked = false;
    }
    const checked = rows.filter((row, index) => row.dataset.localOnly !== 'true' && inputs[index]?.dataset.managed === undefined).length;
    count.textContent = rows.length === 0 ? '' : tn('sync_foldersChecked', rows.length, '$2 of $1 folder', '$2 of $1 folders', checked);
    cancel.disabled = !dirty();
  }

  function dirty(): boolean {
    if (!view) return false;
    const selected = new Set(checkedRootRefs(tree)), excluded = new Set(checkedRootRefs(tree, 'private'));
    const loaded = outermostSelectedRefs(view.roots);
    return view.roots.some((root) => selected.has(root.ref) !== loaded.has(root.ref) || excluded.has(root.ref) !== root.privateLocal);
  }

  function paintCollapsed(): void {
    if (!view) return;
    const rows = Array.from(tree.querySelectorAll<HTMLElement>('.root-row'));
    for (const [index, row] of rows.entries()) {
      row.classList.toggle('is-collapsed-child', isCollapsedChild(view.roots, index, collapsed));
      const toggle = row.querySelector<HTMLButtonElement>('.tree-toggle[data-ref]');
      if (!toggle) continue;
      const title = view.roots[index]!.title, shut = collapsed.has(toggle.dataset.ref!);
      toggle.setAttribute('aria-expanded', shut ? 'false' : 'true');
      toggle.setAttribute('aria-label', shut ? t('options_expand', 'Expand $1', title) : t('options_collapse', 'Collapse $1', title));
    }
  }

  function toggleVisible(mode: true | 'invert'): void {
    for (const input of Array.from(tree.querySelectorAll<HTMLInputElement>('.root-select input:not([data-managed])'))) {
      input.checked = mode === 'invert' ? !input.checked : true;
      recordFolderChoice(input);
    }
    // A script-set box fires no event; the first-run preview and the dashes listen for one.
    tree.dispatchEvent(new Event('change', { bubbles: true }));
  }

  return {
    load, render, renderFailure,
    view: () => view,
    setPreselect(folderId: string | undefined) { preselect = folderId; },
    /** Sign-in changed: signed out clears the tree, signed in loads it once. */
    onConnection(connected: boolean): void {
      refresh.disabled = !connected; save.disabled = !connected || !view;
      if (connected && !view) void load();
      if (connected) return;
      view = undefined; tree.replaceChildren(); alert.hidden = true; count.textContent = '';
      showEmpty(t('sync_signInLibrary', 'Sign in to sync this browser with your bookmark library.'), 'empty');
      setPermissionControls('disconnected'); selectAll.disabled = true; invert.disabled = true;
    },
  };
}

function checkbox(className: string, ref: string, checked: boolean, disabled: boolean, accessibleName: string) {
  const wrapper = el('label', undefined, className);
  const input = el('input'); input.type = 'checkbox'; input.checked = checked; input.disabled = disabled;
  if (disabled) input.dataset.managed = '';
  input.dataset.ref = ref; input.setAttribute('aria-label', accessibleName); wrapper.append(input);
  return { wrapper, input };
}

/** The problem a folder view reports, or nothing when it is simply ready. */
function statusCopy(status: PublicRootView['status']): string | undefined {
  if (status === 'permission_required') return t('options_bookmarkPermissionRequiredAllow', 'Bookmark permission is required. Allow access to load bookmark folders.');
  if (status === 'tree_unavailable') return t('options_bookmarkFoldersTemporarilyUnavailable', 'Bookmark folders are temporarily unavailable. Try again.');
  if (status === 'root_missing') return t('options_selectedFolderMissingReview', 'A selected folder is missing. Review the list and choose a replacement.');
  if (status === 'corrupt') return t('options_folderMappingNeedsAttention', 'Folder mapping needs attention. Review and save the folder settings again.');
  return undefined;
}

function descendantCounts(roots: PublicRootView['roots']): number[] {
  return roots.map((root, index) => {
    let total = 0;
    for (let next = index + 1; next < roots.length && roots[next]!.depth > root.depth; next += 1) total += 1;
    return total;
  });
}

function isCollapsedChild(roots: PublicRootView['roots'], index: number, collapsed: ReadonlySet<string>): boolean {
  const depth = roots[index]!.depth;
  for (let prev = index - 1; prev >= 0; prev -= 1) {
    if (roots[prev]!.depth < depth && collapsed.has(roots[prev]!.ref)) return true;
  }
  return false;
}

async function rootRequest(message: RootRequest): Promise<RootResponse> {
  try { return await chrome.runtime.sendMessage(message) as RootResponse; }
  catch { return { ok: false, error: 'request_invalid' }; }
}

function required(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error('options_markup_invalid');
  return value;
}
