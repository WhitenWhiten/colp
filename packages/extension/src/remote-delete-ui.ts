import type {
  PublicRemoteDeleteItem, RemoteDeleteItemAction, RemoteDeletePolicyName, RemoteDeleteRequest,
  RemoteDeleteResponse,
} from './types.js';
import { sharedManagerMenu } from './bookmark-manager-menu.js';
import { localized, t } from './i18n.js';
import { createIcon } from './icons.js';
import { el, iconButton } from './library-dom.js';

let HINTS: Record<RemoteDeletePolicyName, string>;
localized(() => {
  HINTS = {
  sync: t('remoteDelete_bookmarksDeletedOtherDevices', 'Bookmarks deleted on other devices are removed from this browser.'),
  confirm: t('remoteDelete_cloudDeletionsPauseInbox', 'Cloud deletions pause in the inbox so you can apply, restore, or keep the item on this device.'),
  keep_local: t('remoteDelete_cloudDeletionsDoNot', 'Cloud deletions do not remove the item from this browser. It leaves sync and will not upload as the same item again.'),
};
});

export function remoteDeletePolicyHint(policy: RemoteDeletePolicyName): string {
  return HINTS[policy];
}

export function remoteDeletePendingCopy(count: number): string {
  return t('remoteDelete_cloudDeletionsWaitingConfirmation', 'Cloud deletions waiting for confirmation: $1', count);
}

export function bindRemoteDeleteSettings(): void {
  const host = document.getElementById('remote-delete-settings');
  if (!host) return;
  const policy = requiredSelect('remote-delete-policy');
  const hint = required('remote-delete-policy-hint');
  const count = required('remote-delete-pending-count');
  const list = required('remote-delete-pending-list');
  const conflict = required('remote-delete-conflict');
  const conflictLink = required('remote-delete-conflict-link') as HTMLAnchorElement;
  const feedback = required('remote-delete-feedback');
  hint.textContent = remoteDeletePolicyHint(readPolicy(policy.value));
  let casVersion = 0;
  let items: readonly PublicRemoteDeleteItem[] = [];

  const refresh = async (force = false) => {
    if (!force && (list.contains(document.activeElement) || list.querySelector('.remote-delete-confirm-wrap'))) return;
    const response = await send({ kind: 'known.remoteDelete.pending.list' });
    // A failed read says why until a later read succeeds; an action's own message stays until the next action.
    if (!response.ok) { showFeedback(feedback, response.error); feedback.dataset.source = 'refresh'; return; }
    if (feedback.dataset.source === 'refresh') { feedback.hidden = true; delete feedback.dataset.source; }
    if (!force && (list.contains(document.activeElement) || list.querySelector('.remote-delete-confirm-wrap'))) return;
    casVersion = response.casVersion;
    items = response.pending;
    policy.value = response.policy;
    hint.textContent = remoteDeletePolicyHint(response.policy);
    count.textContent = remoteDeletePendingCopy(response.pendingCount);
    count.hidden = response.pendingCount === 0;
    renderItems(list, items, async (decisionId, action, item) => {
      const result = await send({
        kind: 'known.remoteDelete.decide', decisionId, action, expectedCasVersion: item.casVersion,
        deleteRevision: item.deleteRevision, userGesture: true,
      });
      if (!result.ok) { showFeedback(feedback, result.error); await refresh(); return; }
      feedback.hidden = true; host.tabIndex = -1; host.focus({ preventScroll: true }); await refresh(true);
    }, feedback, refresh);
    conflict.hidden = !response.conflictPending;
    conflictLink.href = response.conflictHref;
  };

  policy.addEventListener('change', () => {
    const next = readPolicy(policy.value);
    hint.textContent = remoteDeletePolicyHint(next);
    void send({
      kind: 'known.remoteDelete.policy.set', policy: next, expectedCasVersion: casVersion, userGesture: true,
    }).then((response) => {
      if (!response.ok) { showFeedback(feedback, response.error); return refresh(); }
      feedback.hidden = true; return refresh();
    });
  });
  list.addEventListener('focusout', () => { setTimeout(() => { void refresh(); }, 150); });
  void refresh();
  window.addEventListener('hashchange', () => { if (location.hash.startsWith('#sync')) void refresh(); });
  setInterval(() => { if (document.body.dataset.pane === 'sync') void refresh(); }, 8_000);
}

let pendingUndoTimer: ReturnType<typeof setTimeout> | undefined;
let pendingUndoCommit: (() => Promise<void>) | undefined;

async function flushPendingUndo(): Promise<void> {
  if (pendingUndoTimer) {
    clearTimeout(pendingUndoTimer);
    pendingUndoTimer = undefined;
  }
  if (pendingUndoCommit) {
    const commit = pendingUndoCommit;
    pendingUndoCommit = undefined;
    await commit();
  }
}

function renderItems(list: HTMLElement, items: readonly PublicRemoteDeleteItem[],
  onDecide: (decisionId: string, action: RemoteDeleteItemAction, item: PublicRemoteDeleteItem) => Promise<void>,
  feedback: HTMLElement,
  refresh: () => Promise<void>): void {
  list.replaceChildren();
  for (const item of items) {
    const row = el('li', undefined, 'set-row remote-delete-pending-item'); row.dataset.syncItem = item.decisionId;
    const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon(item.kind === 'bookmark' ? 'bookmark' : 'folder', 16));
    const text = el('div', undefined, 'set-row-text');
    text.append(el('p', item.title, 'set-row-title'), el('p', t('sync_deletedElsewhereKind', '$1 deleted on another device', kindLabel(item.kind)), 'set-row-hint'));
    const actions = el('div', undefined, 'set-row-control');
    const apply = el('button', t('sync_deleteHere', 'Delete here'), 'btn btn-secondary btn-sm'); apply.type = 'button';
    const restore = el('button', t('common_restore', 'Restore'), 'btn btn-ghost btn-sm'); restore.type = 'button';
    apply.setAttribute('aria-label', t('common_applyDelete', 'Apply delete'));
    apply.addEventListener('click', () => {
      showApplyConfirmation(row, item, async () => {
        await flushPendingUndo();
        row.remove();
        showApplyUndo(feedback, item, async () => {
          if (pendingUndoTimer) {
            clearTimeout(pendingUndoTimer);
            pendingUndoTimer = undefined;
          }
          pendingUndoCommit = undefined;
          feedback.hidden = true;
          await refresh();
        });
        pendingUndoCommit = async () => {
          await onDecide(item.decisionId, 'apply', item);
        };
        pendingUndoTimer = setTimeout(() => {
          void flushPendingUndo();
        }, 5_000);
      });
    });
    restore.addEventListener('click', () => { void flushPendingUndo().then(() => onDecide(item.decisionId, 'restore', item)); });
    const more = iconButton('more-horizontal', t('common_moreActions', 'More actions'));
    more.addEventListener('click', () => {
      const rect = more.getBoundingClientRect();
      sharedManagerMenu().openAt(rect.right - 176, rect.bottom + 4, [{
        label: t('sync_stayLocal', 'No Know-N sync'),
        run: () => { void flushPendingUndo().then(() => onDecide(item.decisionId, 'keep_local', item)); },
      }], more);
    });
    actions.append(apply, restore, more);
    row.append(tile, text, actions); list.append(row);
  }
}

function showApplyConfirmation(row: HTMLElement, item: PublicRemoteDeleteItem, onConfirm: () => Promise<void>): void {
  const actions = row.querySelector('.set-row-control');
  if (!actions) return;
  const originalNodes = Array.from(actions.childNodes);
  actions.replaceChildren();

  const confirmWrap = el('div', undefined, 'remote-delete-confirm-wrap');
  const note = el('span', item.kind === 'folder' ? t('remoteDelete_deleteFolderConfirm', 'Delete this folder from this browser?')
    : item.kind === 'separator' ? t('remoteDelete_deleteSeparatorConfirm', 'Delete this separator from this browser?')
      : t('remoteDelete_deleteBookmarkConfirm', 'Delete this bookmark from this browser?'), 'mgr-confirm-copy');
  const yes = el('button', t('common_delete', 'Delete'), 'btn btn-danger btn-sm'); yes.type = 'button';
  yes.addEventListener('click', () => { void onConfirm(); });
  const no = el('button', t('common_keep', 'Keep'), 'btn btn-ghost btn-sm'); no.type = 'button';
  no.addEventListener('click', () => { actions.replaceChildren(...originalNodes); });

  confirmWrap.append(note, yes, no);
  actions.append(confirmWrap);
  no.focus();
}

function showApplyUndo(feedback: HTMLElement, item: PublicRemoteDeleteItem, onUndo: () => Promise<void>): void {
  feedback.hidden = false; setTone(feedback, 'info');
  feedback.replaceChildren();
  const text = document.createElement('span');
  text.textContent = `${t('remoteDelete_deletedFromBrowser', 'Deleted $1 from this browser.', item.title)} `;
  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'btn btn-ghost btn-sm';
  undoBtn.textContent = t('common_undo', 'Undo');
  undoBtn.addEventListener('click', () => {
    void onUndo();
  });
  feedback.append(text, undoBtn);
}

function kindLabel(kind: PublicRemoteDeleteItem['kind']): string {
  return kind === 'folder' ? t('sync_folder', 'Folder') : kind === 'separator' ? t('common_separator', 'Separator') : t('common_bookmark', 'Bookmark');
}

function readPolicy(value: string): RemoteDeletePolicyName {
  return value === 'confirm' || value === 'keep_local' ? value : 'sync';
}

function showFeedback(node: HTMLElement, error: string): void {
  /* `not_connected` used to fall through to the bare "Could not complete
     this action.", so a signed-out first run opened Sync onto an error it
     could do nothing about. Every state the reader can act on is named. */
  node.hidden = false; setTone(node, 'warning'); delete node.dataset.source;
  node.textContent = error === 'remote_delete_revision_stale' || error === 'remote_delete_decision_stale'
    ? t('remoteDelete_itemChangedReviewConfirmation', 'This item changed. Review the confirmation list again.')
    : error === 'permission_required' ? t('remoteDelete_bookmarkPermissionRequiredHandle', 'Bookmark permission is required to handle this deletion.')
      : error === 'remote_delete_generation_fenced' ? t('nativeWait_syncIdentityUpdatedReopen', 'Sync identity was updated. Reopen settings.')
        : error === 'sync_paused' ? t('sync_syncPaused', 'Sync is paused.')
          // The Sync page shows its sign-in card while signed out, so here this means no collection syncs yet.
          : error === 'not_connected' ? t('remoteDelete_startSyncChangeHowCloud', 'Start syncing a collection to change how cloud deletions are applied here.')
            : error === 'extension_unavailable' ? t('remoteDelete_extensionBackgroundTemporarilyUnavailable', 'The extension background is temporarily unavailable. Try again in a moment.')
              : t('remoteDelete_couldntCompleteTryAgain', "Couldn't complete this. Try again.");
}

async function send(message: RemoteDeleteRequest): Promise<RemoteDeleteResponse> {
  try {
    const pending = chrome.runtime.sendMessage(message) as Promise<RemoteDeleteResponse>;
    const timeout = new Promise<RemoteDeleteResponse>((resolve) => {
      setTimeout(() => resolve({ ok: false, error: 'extension_unavailable' }), 8_000);
    });
    return await Promise.race([pending, timeout]);
  } catch { return { ok: false, error: 'extension_unavailable' }; }
}

function required(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing:${id}`);
  return node;
}
function requiredSelect(id: string): HTMLSelectElement {
  return required(id) as HTMLSelectElement;
}

/** The alert that holds a feedback line is neutral for a note and amber for a problem. */
function setTone(node: HTMLElement, tone: 'info' | 'warning'): void {
  const box = node.parentElement;
  if (!box?.classList.contains('inline-alert')) return;
  if (tone === 'info') delete box.dataset.tone; else box.dataset.tone = 'warning';
}
