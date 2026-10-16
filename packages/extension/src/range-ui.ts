import type { PublicRangePreview, PublicRootView, RootRequest, RootResponse } from './types.js';
import { syncRootRefs, excludedFolderRefs } from './folder-coverage.js';
import { listCopy, t, tn } from './i18n.js';

export function bindRangeAdjustment(host: {
  readonly saveRoots: HTMLButtonElement;
  readonly rootTree: HTMLElement;
  readonly rootFeedback: HTMLElement;
  getView(): PublicRootView | undefined;
  setView(view: PublicRootView): void;
  reloadBoundaries(): void;
  isConnected(): boolean;
  renderFailure(code: string): void;
}): { save(): Promise<void> } {
  const panel = required('range-preview');
  const totals = required('range-preview-totals');
  const warnings = required('range-preview-warnings');
  const shiftList = required('range-shift-list');
  const removeList = required('range-remove-list');
  const remoteLabel = required('range-remote-delete-label');
  const remoteDelete = required('range-remote-delete') as HTMLInputElement;
  const error = required('range-error');
  const cancel = required('range-cancel') as HTMLButtonElement;
  const confirm = required('range-confirm') as HTMLButtonElement;
  const folderCard = required('folder-card');
  let preview: PublicRangePreview | undefined;

  cancel.addEventListener('click', () => { hidePreview(); host.rootFeedback.textContent = ''; });
  confirm.addEventListener('click', () => { void confirmPreview(); });

  return { save };

  async function save(): Promise<void> {
    const view = host.getView();
    if (!view) return;
    host.saveRoots.disabled = true; host.rootFeedback.textContent = t('sync_savingFolderSettings', 'Saving folder settings.');
    error.hidden = true;
    const selectedRefs = excludedFolderRefs(host.rootTree); const privateRefs = syncRootRefs(host.rootTree);
    const response = await rootRequest({
      kind: 'known.roots.preview', viewId: view.viewId, selectedRefs, privateRefs,
    });
    if (!response.ok) { host.renderFailure(response.error); hidePreview(); return; }
    if (!('preview' in response)) { host.renderFailure('request_invalid'); hidePreview(); return; }
    preview = response.preview;
    host.rootFeedback.textContent = '';
    renderPreview(response.preview);
    host.saveRoots.disabled = !host.isConnected();
  }

  async function confirmPreview(): Promise<void> {
    if (!preview) return;
    confirm.disabled = true; error.hidden = true;
    const shiftActions = Array.from(shiftList.querySelectorAll<HTMLSelectElement>('select[data-ref]'))
      .map((select) => ({ ref: select.dataset.ref!, action: select.value === 'keep' ? 'keep' as const : 'unmount' as const }));
    const unmountedShiftRefs = shiftActions.filter((row) => row.action === 'unmount').map((row) => row.ref);
    const remoteDeleteRefs = remoteDelete.checked
      ? preview.removals.map((row) => row.ref).concat(unmountedShiftRefs) : undefined;
    const response = await rootRequest({
      kind: 'known.roots.confirm', previewId: preview.previewId, confirmationId: crypto.randomUUID(),
      treeDigest: preview.treeDigest,
      ...(shiftActions.length ? { shiftActions } : {}),
      ...(remoteDeleteRefs && remoteDeleteRefs.length ? { remoteDeleteRefs } : {}),
    });
    confirm.disabled = false;
    if (!response.ok) {
      const message = confirmFailureCopy(response.error);
      error.hidden = false;
      error.textContent = message;
      host.rootFeedback.textContent = message;
      if (response.error === 'preview_stale' || response.error === 'duplicate_confirm'
        || response.error === 'permission_required') hidePreview();
      host.saveRoots.disabled = !host.isConnected();
      return;
    }
    if (!('view' in response)) { host.renderFailure('request_invalid'); return; }
    hidePreview();
    host.setView(response.view);
    host.rootFeedback.textContent = t('sync_folderSettingsSaved', 'Folder settings saved');
    host.reloadBoundaries();
    host.saveRoots.disabled = !host.isConnected();
  }

  function renderPreview(value: PublicRangePreview): void {
    panel.hidden = false;
    setReviewing(true);
    const total = t('sync_willSyncIn', 'Will sync $1 in $2.', tn('common_bookmarks', value.bookmarkCount, '$1 bookmark', '$1 bookmarks'), tn('common_folders', value.folderCount, '$1 folder', '$1 folders'));
    const changes = [value.addedCount ? t('sync_rangeAdded', '$1 added', value.addedCount) : '', value.removedCount ? t('sync_rangeRemoved', '$1 no longer synced', value.removedCount) : '', value.shiftCount ? t('sync_rangeMoved', '$1 moved', value.shiftCount) : ''].filter(Boolean);
    totals.textContent = changes.length ? t('sync_rangeTotalsChanges', '$1 $2.', total, listCopy(changes)) : total;
    warnings.textContent = value.warnings.some((row) => row.code === 'nested_normalized')
      ? t('sync_someSelectedFoldersWere', 'Some folders you picked are inside other picked folders. Only the outer folders are listed.') : '';
    paintRows(shiftList, value.shifts, true);
    paintRows(removeList, value.removals, false);
    const canTrash = value.removals.length + value.shifts.length > 0;
    remoteLabel.hidden = !canTrash;
    remoteDelete.checked = false;
    confirm.disabled = false;
  }

  function paintRows(list: HTMLElement, rows: PublicRangePreview['shifts'], shift: boolean): void {
    list.replaceChildren();
    list.hidden = rows.length === 0;
    for (const row of rows) {
      const item = document.createElement('li');
      const copy = document.createElement('span');
      copy.textContent = shift
        ? t('sync_rangeShifted', '$1 moved out of your synced folders ($2).', row.title || t('sync_folder', 'Folder'), tn('common_items', row.affectedCount, '$1 item', '$1 items'))
        : t('sync_rangeStops', '$1 will stop syncing ($2). Bookmarks stay in this browser and in Know-N.', row.title || t('sync_folder', 'Folder'), tn('common_items', row.affectedCount, '$1 item', '$1 items'));
      item.append(copy);
      if (shift) {
        const select = document.createElement('select');
        select.className = 'select-quiet';
        select.dataset.ref = row.ref;
        select.setAttribute('aria-label', t('sync_keepSyncingNamed', 'Keep syncing $1 at the new location', row.title || t('sync_folderLower', 'folder')));
        const keep = document.createElement('option'); keep.value = 'keep'; keep.textContent = t('sync_keepSyncingNewLocation', 'Keep syncing at the new location');
        const unmount = document.createElement('option'); unmount.value = 'unmount'; unmount.textContent = t('sync_stopSyncing', 'Stop syncing');
        select.append(keep, unmount);
        item.append(select);
      }
      list.append(item);
    }
  }

  function hidePreview(): void {
    preview = undefined;
    panel.hidden = true;
    setReviewing(false);
    remoteDelete.checked = false;
  }

  /** While the change list is open it owns the actions: the tree goes quiet and its Cancel / Review footer steps aside. */
  function setReviewing(on: boolean): void {
    if (on) folderCard.dataset.reviewing = ''; else delete folderCard.dataset.reviewing;
    host.rootTree.toggleAttribute('inert', on);
  }
}

function confirmFailureCopy(code: string): string {
  if (code === 'preview_stale') return t('sync_folderTreeChangedRefresh', 'Folder tree changed. Refresh and preview again.');
  if (code === 'duplicate_confirm') return t('sync_previewAlreadyConfirmed', 'This preview was already confirmed.');
  if (code === 'permission_required') return t('sync_bookmarkAccessRequiredChange', 'Bookmark access is required to change folders.');
  if (code === 'sync_paused') return t('sync_syncPaused', 'Sync is paused.');
  return t('sync_folderSettingsCouldNot', 'Folder settings could not be confirmed. Try again.');
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
