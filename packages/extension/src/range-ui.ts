import type { PublicRangePreview, PublicRangeResume, PublicRootView, RootRequest, RootResponse } from './types.js';
import { syncRootRefs, excludedFolderRefs, replaceFolderSelection } from './folder-coverage.js';
import { listCopy, t, tn } from './i18n.js';
import { createRangeConfirmationSession, validRangePreview, validRangeResume } from './range-confirmation-session.js';

export function bindRangeAdjustment(host: {
  readonly saveRoots: HTMLButtonElement;
  readonly rootTree: HTMLElement;
  readonly rootFeedback: HTMLElement;
  getView(): PublicRootView | undefined;
  setView(view: PublicRootView): void;
  reloadBoundaries(): void;
  onConfirmed(): void;
  isConnected(): boolean;
  renderFailure(code: string): void;
}): { save(): Promise<void>; setLibraryId(id: string | undefined): void; onConnection(connected: boolean): void;
  onRootResponse(response: RootResponse): void } {
  const panel = required('range-preview');
  const totals = required('range-preview-totals');
  const warnings = required('range-preview-warnings');
  const addList = required('range-add-list');
  const shiftList = required('range-shift-list');
  const removeList = required('range-remove-list');
  const remoteLabel = required('range-remote-delete-label');
  const remoteDelete = required('range-remote-delete') as HTMLInputElement;
  const error = required('range-error');
  const cancel = required('range-cancel') as HTMLButtonElement;
  const confirm = required('range-confirm') as HTMLButtonElement;
  const reviewDecisions = document.createElement('button');
  reviewDecisions.id = 'range-review-decisions'; reviewDecisions.type = 'button';
  reviewDecisions.className = 'btn btn-secondary btn-sm'; reviewDecisions.hidden = true;
  reviewDecisions.textContent = t('sync_reviewFolderDecisions', 'Review folder decisions');
  confirm.parentElement!.append(reviewDecisions);
  const folderCard = required('folder-card');
  const treeActions = Array.from(folderCard.querySelectorAll<HTMLButtonElement>('.card-bar button'));
  const disabledActions = new Map<HTMLButtonElement, boolean>();
  let preview: PublicRangePreview | undefined;
  let loading = false, disposed = false, libraryId: string | undefined;
  let ownerVersion = 0, retryPoll = 0, retryStartedAt = 0;
  const confirmLabel = confirm.textContent;
  const submission = createRangeConfirmationSession({ send: rootRequest, pending: showPending, result: finishConfirmation });
  window.addEventListener('pagehide', () => { disposed = true; resetOwner(); }, { once: true });
  reviewDecisions.addEventListener('click', () => {
    window.dispatchEvent(new Event('known.sync.rejoinDecisions.show'));
  });

  cancel.addEventListener('click', () => { if (!submission.pending) { hidePreview(); host.rootFeedback.textContent = ''; } });
  confirm.addEventListener('click', () => { void confirmPreview(); });
  shiftList.addEventListener('change', updateTrashAvailability);

  return { save,
    setLibraryId(id) {
      if (disposed || libraryId === id) return;
      resetOwner(); libraryId = id;
      if (host.isConnected()) void submission.restore(id);
    },
    onConnection(connected) {
      if (disposed) return;
      if (connected) { void submission.restore(libraryId); return; }
      resetOwner();
    },
    onRootResponse(response) {
      if (disposed) return;
      if (submission.pending) { setReviewing(true); return; }
      if (response.ok && 'view' in response && response.resume
          && validRangeResume(response.resume) && response.resume.libraryId === libraryId) {
        preview = response.resume.preview; renderPreview(preview); void submission.submit(response.resume);
      }
    },
  };

  async function save(): Promise<void> {
    const view = host.getView();
    if (disposed || !host.isConnected() || !view || loading || preview || submission.pending) return;
    const version = ownerVersion;
    loading = true;
    setReviewing(true);
    host.saveRoots.disabled = true; host.rootFeedback.textContent = t('sync_savingFolderSettings', 'Saving folder settings.');
    error.hidden = true;
    const selectedRefs = syncRootRefs(host.rootTree);
    const privateRefs = excludedFolderRefs(host.rootTree);
    const response = await rootRequest({
      kind: 'known.roots.preview', viewId: view.viewId, selectedRefs, privateRefs,
    });
    if (disposed || version !== ownerVersion) return;
    loading = false;
    if (!response.ok) { hidePreview(); host.renderFailure(response.error); return; }
    if (!('preview' in response) || !validRangePreview(response.preview)) { hidePreview(); host.renderFailure('request_invalid'); return; }
    if (host.getView()?.viewId !== view.viewId) {
      hidePreview(); host.rootFeedback.textContent = confirmFailureCopy('preview_stale'); return;
    }
    preview = response.preview;
    host.rootFeedback.textContent = '';
    renderPreview(response.preview);
    host.saveRoots.disabled = !host.isConnected();
  }

  async function confirmPreview(): Promise<void> {
    if (disposed || !host.isConnected()) return;
    if (submission.pending) { retryStartedAt = Date.now(); await submission.retry(); return; }
    if (!preview || confirm.disabled) return;
    const shiftActions = Array.from(shiftList.querySelectorAll<HTMLSelectElement>('select[data-ref]'))
      .map((select) => ({ ref: select.dataset.ref!, action: select.value === 'keep' ? 'keep' as const : 'unmount' as const }));
    const unmountedShiftRefs = shiftActions.filter((row) => row.action === 'unmount').map((row) => row.ref);
    const remoteDeleteRefs = remoteDelete.checked
      ? preview.removals.map((row) => row.ref).concat(unmountedShiftRefs) : undefined;
    await submission.submit({ libraryId: libraryId ?? '', preview, request: {
      kind: 'known.roots.confirm', previewId: preview.previewId, confirmationId: crypto.randomUUID(),
      treeDigest: preview.treeDigest,
      ...(shiftActions.length ? { shiftActions } : {}),
      ...(remoteDeleteRefs && remoteDeleteRefs.length ? { remoteDeleteRefs } : {}),
    } });
  }

  async function finishConfirmation(resume: PublicRangeResume, response: RootResponse): Promise<void> {
    clearRetryPoll();
    const confirmationId = resume.request.confirmationId;
    confirm.disabled = false; cancel.disabled = false; confirm.removeAttribute('aria-busy');
    shiftList.toggleAttribute('inert', false); remoteDelete.disabled = false;
    confirm.textContent = confirmLabel;
    if (!response.ok) {
      const message = confirmFailureCopy(response.error);
      error.hidden = false;
      error.textContent = message;
      host.rootFeedback.textContent = message;
      if (response.error === 'preview_stale') { await refreshStalePreview(message); return; }
      if (response.error === 'duplicate_confirm' || response.error === 'permission_required') hidePreview();
      host.saveRoots.disabled = !host.isConnected();
      return;
    }
    if (!('view' in response) || response.confirmation?.confirmationId !== confirmationId
        || response.confirmation.state !== 'committed') {
      host.rootFeedback.textContent = confirmFailureCopy('request_invalid'); host.renderFailure('request_invalid'); return;
    }
    hidePreview();
    host.setView(response.view);
    host.rootFeedback.textContent = response.view.status === 'ready' || response.view.status === 'nested_normalized'
      ? t('sync_folderSettingsSaved', 'Folder settings saved')
      : t('sync_folderSettingsSavedTreeUnavailable', 'Folder settings saved. The folder list could not refresh; try refreshing it again.');
    host.reloadBoundaries();
    host.onConfirmed();
    host.saveRoots.disabled = !host.isConnected();
  }

  async function refreshStalePreview(message: string): Promise<void> {
    const version = ownerVersion;
    const selected = new Set(syncRootRefs(host.rootTree)), excluded = new Set(excludedFolderRefs(host.rootTree));
    hidePreview();
    const response = await rootRequest({ kind: 'known.roots.get' });
    if (disposed || ownerVersion !== version) return;
    if (!response.ok || !('view' in response)) { host.renderFailure(response.ok ? 'request_invalid' : response.error); return; }
    host.setView(response.view);
    if (response.resume && validRangeResume(response.resume) && response.resume.libraryId === libraryId) {
      preview = response.resume.preview; renderPreview(preview); void submission.submit(response.resume); return;
    }
    const present = new Set(response.view.roots.map(row => row.ref));
    replaceFolderSelection(host.rootTree, new Set([...selected].filter(ref => present.has(ref))),
      new Set([...excluded].filter(ref => present.has(ref))));
    await save();
    if (ownerVersion === version && !submission.pending) host.rootFeedback.textContent = message;
  }

  function showPending(response?: RootResponse): void {
    const resume = submission.resume;
    if (resume && !preview) { preview = resume.preview; renderPreview(preview); }
    setReviewing(true); panel.hidden = false; cancel.disabled = true;
    shiftList.toggleAttribute('inert', true); remoteDelete.disabled = true;
    confirm.disabled = submission.inFlight || response === undefined;
    if (submission.inFlight || response === undefined) confirm.setAttribute('aria-busy', 'true');
    else confirm.removeAttribute('aria-busy');
    confirm.textContent = submission.inFlight || response === undefined ? t('common_saving', 'Saving…')
      : t('sync_resumeFolderChange', 'Resume this change');
    const failed = response && !response.ok ? response.confirmation?.error : undefined;
    reviewDecisions.hidden = failed !== 'rejoin_pending';
    const message = failed ? pendingFailureCopy(failed)
      : t('sync_confirmingFolderChange', 'Confirming folder changes. You can reopen this page to check the result.');
    error.hidden = !failed; error.textContent = failed ? message : '';
    host.rootFeedback.textContent = message;
    if (failed) { clearRetryPoll(); return; }
    if (retryPoll) return;
    retryStartedAt = Date.now();
    retryPoll = window.setInterval(() => {
      if (!submission.pending) { clearRetryPoll(); return; }
      if (Date.now() - retryStartedAt >= 90_000) {
        clearRetryPoll(); confirm.disabled = false; confirm.textContent = t('sync_resumeFolderChange', 'Resume this change');
        host.rootFeedback.textContent = t('sync_folderChangeUnknown', 'The result is not available yet. Resume this change to check or retry the same request.');
        return;
      }
      if (host.isConnected() && !submission.inFlight) void submission.retry();
    }, 2_000);
  }

  function clearRetryPoll(): void { window.clearInterval(retryPoll); retryPoll = 0; }

  function resetOwner(): void {
    ownerVersion += 1; loading = false; submission.reset(); clearRetryPoll(); hidePreview();
    confirm.disabled = false; confirm.removeAttribute('aria-busy'); confirm.textContent = confirmLabel;
    cancel.disabled = false; shiftList.toggleAttribute('inert', false); remoteDelete.disabled = false;
    error.hidden = true; error.textContent = ''; host.rootFeedback.textContent = '';
  }

  function renderPreview(value: PublicRangePreview): void {
    panel.hidden = false;
    setReviewing(true);
    const total = t('sync_willSyncIn', 'Will sync $1 in $2.', tn('common_bookmarks', value.bookmarkCount, '$1 bookmark', '$1 bookmarks'), tn('common_folders', value.folderCount, '$1 folder', '$1 folders'));
    const added = value.addedCount || value.addedBookmarkCount ? t('sync_rangeAddedItems', '$1 and $2 will start syncing',
      tn('common_folders', value.addedCount, '$1 folder', '$1 folders'),
      tn('common_bookmarks', value.addedBookmarkCount, '$1 bookmark', '$1 bookmarks')) : '';
    const changes = [added, value.removedCount ? t('sync_rangeRemoved', '$1 no longer synced', value.removedCount) : '', value.shiftCount ? t('sync_rangeMoved', '$1 moved', value.shiftCount) : ''].filter(Boolean);
    totals.textContent = changes.length ? t('sync_rangeTotalsChanges', '$1 $2.', total, listCopy(changes)) : total;
    warnings.textContent = value.warnings.some((row) => row.code === 'nested_normalized')
      ? t('sync_someSelectedFoldersWere', 'Some folders you picked are inside other picked folders. Only the outer folders are listed.') : '';
    addList.replaceChildren();
    addList.hidden = value.additions.length === 0;
    for (const row of value.additions) {
      const item = document.createElement('li');
      const copy = document.createElement('span');
      copy.textContent = t('sync_rangeAddedFolder', '$1: $2 directly in this folder.', row.path || row.title || t('sync_folder', 'Folder'),
        tn('common_bookmarks', row.bookmarkCount, '$1 bookmark', '$1 bookmarks'));
      item.append(copy);
      addList.append(item);
    }
    paintRows(shiftList, value.shifts, true);
    paintRows(removeList, value.removals, false);
    remoteDelete.checked = false;
    updateTrashAvailability();
    confirm.disabled = false;
  }

  function updateTrashAvailability(): void {
    const canTrash = (preview?.removals.length ?? 0) > 0
      || Array.from(shiftList.querySelectorAll<HTMLSelectElement>('select[data-ref]')).some(select => select.value === 'unmount');
    remoteLabel.hidden = !canTrash;
    if (!canTrash) remoteDelete.checked = false;
  }

  function paintRows(list: HTMLElement, rows: PublicRangePreview['shifts'], shift: boolean): void {
    list.replaceChildren();
    list.hidden = rows.length === 0;
    for (const row of rows) {
      const item = document.createElement('li');
      const copy = document.createElement('span');
      copy.textContent = shift
        ? t('sync_rangeShifted', '$1 moved out of your synced folders ($2).', row.title || t('sync_folder', 'Folder'), tn('common_items', row.affectedCount, '$1 item', '$1 items'))
        : t('sync_rangeStops', '$1 will stop syncing ($2). Bookmarks stay in this browser and in your library.', row.title || t('sync_folder', 'Folder'), tn('common_items', row.affectedCount, '$1 item', '$1 items'));
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
    reviewDecisions.hidden = true;
    setReviewing(false);
    remoteDelete.checked = false;
    host.saveRoots.disabled = !host.isConnected();
  }

  /** While the change list is open it owns the actions: the tree goes quiet and its Cancel / Review footer steps aside. */
  function setReviewing(on: boolean): void {
    if (on) folderCard.dataset.reviewing = ''; else delete folderCard.dataset.reviewing;
    host.rootTree.toggleAttribute('inert', on);
    for (const action of treeActions) {
      if (on) {
        if (!disabledActions.has(action)) disabledActions.set(action, action.disabled);
        action.disabled = true;
      } else if (disabledActions.has(action)) {
        action.disabled = disabledActions.get(action)!;
        disabledActions.delete(action);
      }
    }
  }
}

function pendingFailureCopy(code: string): string {
  if (code === 'rejoin_pending') return t('sync_folderChangeNeedsReview',
    'Folder changes are waiting for review. Resolve the sync attention items, then resume this change.');
  if (code === 'permission_required' || code === 'sync_paused') return confirmFailureCopy(code);
  return t('sync_folderChangeIncomplete',
    'This folder change is incomplete. Resume it to finish the remaining steps; completed steps are kept.');
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
  catch { return { ok: false, error: message.kind === 'known.roots.confirm' ? 'confirmation_pending' : 'request_invalid' }; }
}

function required(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error('options_markup_invalid');
  return value;
}
