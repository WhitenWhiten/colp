import { localized, t, tn } from './i18n.js';
import type { NativeNode } from './bookmark-manager-dom.js';
import { moveTargets } from './bookmark-manager-move.js';
import { exclusionIds } from './bookmark-subscriptions/guards.js';
import type { BatchBlockReason } from './bookmark-batch-plan.js';
import { BOOKMARK_UNDO_WINDOW_MS } from './bookmark-undo.js';
import { createDialog, dialogButton } from './dialog.js';
import { createFolderListbox } from './library-folder-picker.js';
import { createIcon } from './icons.js';
import type {
  BatchKind, BatchRequest, BatchResponse, PublicBatchPreview, PublicBatchStatus,
} from './types.js';

interface BatchDialog { readonly dialog: HTMLDialogElement; readonly body: HTMLDivElement; readonly confirm: HTMLButtonElement }

export function bindBookmarkManagerBatch(host: {
  readonly selectedIds: () => Set<string>;
  readonly select: (id: string, range: boolean) => void;
  readonly nodes: () => ReadonlyMap<string, NativeNode>;
  readonly rootId: () => string;
  readonly refresh: () => Promise<void>;
  readonly feedback: (copy: string, tone: 'ok' | 'error') => void;
  /** Opens bulk tagging for the selected bookmarks. */
  readonly tag?: (trigger: HTMLElement) => void;
  /** Select mode is on, with or without anything checked yet. */
  readonly selecting?: () => boolean;
  /** Every selectable row on screen is checked. */
  readonly allSelected?: () => boolean;
  /** Checks every row on screen, or clears them once all are checked. */
  readonly selectAll?: () => void;
  /** A batch went through: the selection it acted on is spent. */
  readonly committed?: () => void;
}) {
  const move = button('manager-batch-move');
  const rename = button('manager-batch-rename');
  const tag = button('manager-batch-tag');
  const remove = button('manager-batch-delete');
  const undo = button('manager-batch-undo');
  const all = button('manager-select-all');
  const undoDeadline = document.getElementById('manager-batch-undo-deadline');
  /** The open confirmation dialog, if any. */
  let ui: BatchDialog | undefined;
  let preview: PublicBatchPreview | undefined;
  let pending: { operation: BatchKind; commandId: string; nativeIds: readonly string[];
    targetParentId?: string; titles?: Record<string, string> } | undefined;
  let lastStatus: PublicBatchStatus | undefined;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  let committing = false;

  move?.addEventListener('click', () => { void begin('move'); });
  rename?.addEventListener('click', () => { void begin('rename'); });
  tag?.addEventListener('click', () => { host.tag?.(tag); });
  remove?.addEventListener('click', () => { void begin('delete'); });
  undo?.addEventListener('click', () => { void runUndo(); });
  all?.addEventListener('click', () => { host.selectAll?.(); });
  window.addEventListener('pagehide', () => clearTimeout(undoTimer), { once: true });
  selectionChanged();

  function decorateRow(row: HTMLElement, node: NativeNode, on: boolean): void {
    if (node.unmodifiable === 'managed') return;
    const box = document.createElement('input');
    box.type = 'checkbox'; box.className = 'mgr-select';
    box.setAttribute('aria-label', t('capture_select', 'Select $1', node.title || 'item'));
    box.checked = on;
    row.toggleAttribute('data-selected', on);
    box.addEventListener('click', (event) => {
      event.stopPropagation();
      host.select(node.id, event.shiftKey);
    });
    (row.querySelector('.mgr-lead') ?? row).prepend(box);
  }

  function selectionChanged(): void {
    const count = host.selectedIds().size;
    const disabled = count === 0, selecting = host.selecting?.() ?? !disabled;
    /* Batch actions only exist once something is selected; until then they
       were three dead buttons, one of them red. */
    for (const control of [move, rename, tag, remove]) if (control) { control.disabled = disabled; control.hidden = disabled; }
    // While selecting, the bar says what to do next even before the first tick.
    const counter = document.getElementById('manager-selection-count');
    if (counter) {
      counter.hidden = !selecting;
      counter.textContent = disabled ? t('manager_selectHint', 'Check items to move, rename, tag or delete them.') : t('manager_selectedCount', '$1 selected', count);
    }
    if (all) {
      all.hidden = !selecting || !host.selectAll;
      all.textContent = host.allSelected?.() ? t('manager_clearSelection', 'Clear selection') : t('manager_selectAll', 'Select all');
    }
  }

  async function beginWithIds(operation: BatchKind, nativeIds: string[]): Promise<void> {
    if (nativeIds.length === 0) { host.feedback(t('manager_selectItemsFirst', 'Select items first.'), 'error'); return; }
    const commandId = crypto.randomUUID();
    const titles = operation === 'rename' ? Object.fromEntries(nativeIds.map((id) => {
      const node = host.nodes().get(id); return [id, node?.title || t('common_untitled', 'Untitled')];
    })) : undefined;
    pending = { operation, commandId, nativeIds, titles };
    if (operation === 'move') { await showMovePicker(nativeIds); return; }
    await loadPreview();
  }

  async function begin(operation: BatchKind): Promise<void> {
    await beginWithIds(operation, [...host.selectedIds()]);
  }

  async function loadPreview(): Promise<void> {
    if (!pending) return;
    const response = await send({
      kind: 'known.batch.preview', operation: pending.operation, nativeIds: pending.nativeIds,
      ...(pending.targetParentId ? { targetParentId: pending.targetParentId } : {}),
      ...(pending.titles ? { titles: pending.titles } : {}),
    });
    if (!response.ok || !('preview' in response)) {
      host.feedback(errorCopy(response.ok ? 'request_invalid' : response.error), 'error'); return;
    }
    preview = response.preview;
    if (preview.items.length === 0) { host.feedback(t('manager_selectItemsFirst', 'Select items first.'), 'error'); return; }
    if (!preview.requiresSecondConfirm && pending.operation !== 'rename') {
      await commit(false); return;
    }
    showDialog(preview, pending.titles);
  }

  function openDialog(title: string, confirmLabel: string, tone: 'primary' | 'danger'): BatchDialog {
    ui?.dialog.close();
    const { dialog, body, actions } = createDialog(title, 'mgr-batch');
    dialog.id = 'manager-batch-dialog'; body.id = 'manager-batch-body';
    const cancel = dialogButton(t('common_cancel', 'Cancel')); cancel.id = 'manager-batch-cancel';
    const confirm = dialogButton(confirmLabel, tone); confirm.id = 'manager-batch-confirm';
    cancel.addEventListener('click', () => { dialog.close(); });
    confirm.addEventListener('click', () => { void commit(true); });
    actions.append(cancel, confirm);
    const mine = { dialog, body, confirm };
    dialog.addEventListener('close', () => { dialog.remove(); if (ui === mine) ui = undefined; });
    document.body.append(dialog); ui = mine;
    return mine;
  }

  function notice(tone: 'warning' | 'info', copy: string): HTMLElement {
    const box = document.createElement('div'); box.className = 'inline-alert'; if (tone === 'warning') box.dataset.tone = 'warning';
    const text = document.createElement('p'); text.textContent = copy;
    box.append(createIcon(tone === 'warning' ? 'alert' : 'info', 16), text);
    return box;
  }

  function showDialog(next: PublicBatchPreview, titles?: Record<string, string>): void {
    const count = next.items.length;
    const title = next.operation === 'delete'
      ? (count === 1 ? t('manager_deleteSelectedItem', 'Delete selected item') : t('manager_deleteSelectedItems', 'Delete selected items'))
      : next.operation === 'rename' ? t('manager_renameSelectedItems', 'Rename selected items')
        : next.crossBoundary ? t('manager_moveOutSyncedFolders', 'Move out of synced folders') : t('manager_moveSelectedItems', 'Move selected items');
    const confirmLabel = next.operation === 'delete'
      ? (count === 1 ? t('manager_deleteItem', 'Delete item') : t('manager_deleteItems', 'Delete $1 items', count))
      : next.operation === 'rename' ? t('common_rename', 'Rename') : count === 1 ? t('manager_moveItem', 'Move item') : t('manager_moveItems', 'Move $1 items', count);
    const { dialog, body } = openDialog(title, confirmLabel, next.operation === 'delete' ? 'danger' : 'primary');
    if (next.crossBoundary) body.append(notice('warning', t('manager_moveTakesItemsInto', 'This move takes items into or out of your synced folders.')));
    if (next.operation === 'delete') {
      const warn = document.createElement('p');
      warn.className = 'mgr-batch-warning';
      warn.textContent = tn('manager_deleteItemsConfirm', count, 'Delete $1 item from this browser? You can restore it with Undo.', 'Delete $1 items from this browser? You can restore them with Undo.');
      const deadline = document.createElement('p'); deadline.className = 'mgr-batch-hint';
      deadline.textContent = t('manager_undoWindowHint', 'Undo is available for $1 minutes after deletion. Download a backup first if you may need these items later.', BOOKMARK_UNDO_WINDOW_MS / 60_000);
      body.append(warn, deadline);
    }
    const list = document.createElement('div'); list.className = 'mgr-batch-items';
    for (const item of next.items) {
      const row = document.createElement('label');
      row.className = 'mgr-batch-item';
      const name = document.createElement('span');
      name.textContent = item.blocked
        ? `${item.title} — ${BLOCK_REASON_COPY[item.blocked as BatchBlockReason] ?? item.blocked}`
        : item.title;
      row.append(name);
      if (next.operation === 'rename' && titles && !item.blocked) {
        const field = document.createElement('input');
        field.type = 'text'; field.className = 'field-quiet'; field.value = titles[item.nativeId] ?? item.title;
        field.setAttribute('aria-label', t('manager_newTitleFor', 'New title for $1', item.title));
        field.addEventListener('input', () => { if (pending?.titles) pending.titles[item.nativeId] = field.value; });
        row.append(field);
      }
      list.append(row);
    }
    body.append(list);
    dialog.showModal();
    (body.querySelector<HTMLInputElement>('input') ?? dialog.querySelector<HTMLButtonElement>('#manager-batch-cancel'))?.focus();
  }

  async function commit(secondConfirm: boolean): Promise<void> {
    if (!pending || !preview || committing) return;
    committing = true; if (ui) ui.confirm.disabled = true;
    try {
      const command = { ...pending, ...(pending.titles ? { titles: { ...pending.titles } } : {}) };
      if (command.operation === 'rename') {
        const refreshed = await send({ kind: 'known.batch.preview', operation: 'rename', nativeIds: command.nativeIds, titles: command.titles });
        if (!refreshed.ok || !('preview' in refreshed)) {
          host.feedback(errorCopy(refreshed.ok ? 'request_invalid' : refreshed.error), 'error'); return;
        }
        // Bind the edited titles while retaining the original tree/mapping/boundary precondition.
        if (!preview.basisDigest || preview.basisDigest !== refreshed.preview.basisDigest) {
          ui?.dialog.close(); host.feedback(errorCopy('stale_revision'), 'error'); return;
        }
        preview = refreshed.preview;
      }
      const response = await send({
        kind: 'known.batch.confirm', commandId: command.commandId, operation: command.operation,
        nativeIds: command.nativeIds, previewDigest: preview.digest, userGesture: true,
        ...(secondConfirm ? { secondConfirm: true } : {}),
        ...(command.targetParentId ? { targetParentId: command.targetParentId } : {}),
        ...(command.titles ? { titles: command.titles } : {}),
      });
      ui?.dialog.close();
      if (!response.ok || !('status' in response)) {
        host.feedback(errorCopy(response.ok ? 'request_invalid' : response.error), 'error'); return;
      }
      lastStatus = response.status;
      host.feedback(statusCopy(response.status, false), response.status.failed || response.status.changed ? 'error' : 'ok');
      armUndo(response.status);
      host.committed?.();
      await host.refresh();
    } catch { host.feedback(errorCopy('request_invalid'), 'error'); }
    finally { committing = false; if (ui) ui.confirm.disabled = false; }
  }

  async function runUndo(): Promise<void> {
    if (!lastStatus) return;
    const response = await send({
      kind: 'known.batch.undo', planId: lastStatus.planId, commandId: lastStatus.commandId, userGesture: true,
    });
    if (!response.ok || !('status' in response)) {
      host.feedback(errorCopy(response.ok ? 'request_invalid' : response.error), 'error'); return;
    }
    lastStatus = response.status;
    // The undo failure tone follows the copy: an undo that restored nothing is
    // not a success, whatever `changed` says.
    host.feedback(statusCopy(response.status, true),
      response.status.failed || response.status.changed ? 'error' : 'ok');
    if (undo) undo.hidden = true;
    if (undoDeadline) undoDeadline.hidden = true;
    clearTimeout(undoTimer);
    await host.refresh();
  }

  function armUndo(status: PublicBatchStatus): void {
    if (!undo) return;
    const show = (status.state === 'completed' || status.state === 'partial') && status.applied > 0
      && (status.undoExpiresAt === undefined || status.undoExpiresAt > Date.now());
    undo.hidden = !show;
    if (undoDeadline) undoDeadline.hidden = !show || status.undoExpiresAt === undefined;
    if (undoTimer) clearTimeout(undoTimer);
    if (!show || status.undoExpiresAt === undefined) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((status.undoExpiresAt! - Date.now()) / 1000));
      if (undoDeadline) undoDeadline.textContent = remaining > 0 ? t('manager_undoRemaining', 'Undo available for $1:$2', Math.floor(remaining / 60), String(remaining % 60).padStart(2, '0'))
        : t('manager_undoWindowHasEnded', 'The undo window has ended.');
      if (!remaining) { undo.hidden = true; return; }
      undoTimer = setTimeout(tick, Math.min(1000, status.undoExpiresAt! - Date.now()));
    };
    tick();
  }

  async function showMovePicker(selectedIds: readonly string[]): Promise<void> {
    const top = host.nodes().get(host.rootId());
    if (!top) return;
    const moving = selectedIds.map((id) => host.nodes().get(id)).filter((node): node is NativeNode => node !== undefined);
    const hidden = await exclusionIds().catch(() => new Set<string>());
    ui?.dialog.close();
    const title = t('manager_moveSelectedItems', 'Move selected items');
    const { dialog, body, actions } = createDialog(title, 'mgr-batch mgr-move');
    dialog.id = 'manager-batch-dialog';
    const box = createFolderListbox({ choices: moveTargets(top, moving, hidden), label: title,
      onPick(choice) {
        if (!pending) return;
        pending.targetParentId = choice.id;
        dialog.close();
        void loadPreview();
      } });
    const cancel = dialogButton(t('common_cancel', 'Cancel')); cancel.id = 'manager-batch-cancel';
    cancel.addEventListener('click', () => { dialog.close(); });
    body.append(box.element); actions.append(cancel);
    dialog.addEventListener('close', () => { dialog.remove(); });
    document.body.append(dialog); dialog.showModal(); box.focus();
  }

  async function refreshStatus(): Promise<void> {
    try {
      const response = await send({ kind: 'known.batch.status' });
      if (!response.ok || !('status' in response)) return;
      lastStatus = response.status; armUndo(response.status);
    } catch { /* A fresh profile has no batch to restore. */ }
  }

  return { decorateRow, selectionChanged, beginWithIds, refreshStatus };
}

/**
 * `undoAttempted` is a parameter and not inferred from the status, because
 * `state === 'partial' && failed > 0` describes a partially applied batch just
 * as well as a failed undo. Inferring it made a partial *apply* report
 * "The undo did not restore N items." for an undo the user never ran.
 */
export function statusCopy(status: PublicBatchStatus, undoAttempted: boolean): string {
  // "A batch was applied" must never outrank "part of it could not be undone":
  // an undo that fails leaves `applied > 0` and `operation === 'delete'`, which
  // used to report the plain "Deleted." success copy for a restore that never
  // happened.
  const undoFailed = undoAttempted && status.state === 'partial' && status.failed > 0;
  if (status.state === 'undone') return status.changed ? t('manager_undoRestoredMatchingItems', 'Undo restored matching items. Some had changed.') : t('common_undone', 'Undone.');
  if (undoFailed) {
    return status.undone > 0
      ? t('manager_undoRestoredCouldNot', 'Undo restored $1, could not restore $2.', status.undone, status.failed)
      : tn('manager_undoNotRestored', status.failed, 'The undo did not restore $1 item.', 'The undo did not restore $1 items.');
  }
  if (status.failed && status.applied) return t('manager_updatedFailed', 'Updated $1, failed $2.', status.applied, status.failed);
  if (status.changed && status.applied) return t('manager_updatedChangedConcurrently', 'Updated $1. $2 changed concurrently.', status.applied, status.changed);
  if (status.failed && !status.applied) return t('manager_batchCouldNotApplied', 'The batch could not be applied.');
  if (status.operation === 'delete') return t('common_deleted', 'Deleted.');
  if (status.operation === 'rename') return t('common_renamed', 'Renamed.');
  return t('common_moved', 'Moved.');
}

let BLOCK_REASON_COPY: Record<BatchBlockReason, string>;
localized(() => {
  BLOCK_REASON_COPY = {
  empty_batch: t('common_nothingSelected', 'nothing selected'),
  protected_root: t('manager_topLevelFolder', 'a top-level folder'),
  managed: t('manager_managedBrowser', 'managed by the browser'),
  remote_delete_pending: t('manager_waitingDeletionDecision', 'waiting on a deletion decision'),
  missing: t('manager_noLongerExists', 'no longer exists'),
  cross_boundary: t('manager_leavesSyncedFolders', 'leaves your synced folders'),
  rename_title_required: t('manager_needsAName', 'needs a name'),
  move_target_required: t('manager_chooseWhereMove', 'choose where to move it'),
  move_into_self: t('manager_cantMoveIntoItself', "can't move into itself"),
  stale_revision: t('manager_changedSincePreview', 'changed since the preview'),
  target_missing: t('manager_destinationNoLongerExists', 'the destination no longer exists'),
  target_managed: t('manager_destinationManagedBrowser', 'the destination is managed by the browser'),
};
});

function errorCopy(code: string): string {
  if (code === 'empty_batch') return t('manager_selectItemsFirst', 'Select items first.');
  if (code === 'protected_root') return t('manager_topLevelFoldersCant', "Top-level folders can't be changed in a batch.");
  if (code === 'stale_revision') return t('manager_treeChangedPreviewAgain', 'The tree changed. Preview again.');
  if (code === 'confirm_required') return t('manager_confirmDeleteMove', 'Confirm this delete or move.');
  if (code === 'cross_boundary') return t('manager_moveTakesItemsInto', 'This move takes items into or out of your synced folders.');
  if (code === 'remote_delete_pending') return t('manager_itemWaitingDecideAbout', 'An item is waiting for you to decide about a deletion.');
  if (code === 'sync_paused') return t('sync_syncPaused', 'Sync is paused.');
  if (code === 'undo_expired') return t('manager_undoWindowHasEnded', 'The undo window has ended.');
  if (code === 'batch_command_conflict') return t('manager_actionAlreadySubmittedDifferent', 'This action was already submitted with different details. Preview again, then retry.');
  return t('manager_batchCouldNotCompleted', 'The batch could not be completed.');
}

function button(id: string): HTMLButtonElement | null {
  const node = document.getElementById(id);
  return node instanceof HTMLButtonElement ? node : null;
}

async function send(message: BatchRequest): Promise<BatchResponse> {
  return chrome.runtime.sendMessage(message) as Promise<BatchResponse>;
}
