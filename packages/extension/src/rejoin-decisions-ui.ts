import { t, tn } from './i18n.js';
import { el } from './library-dom.js';
import { SYNC_ATTENTION_SHOW_EVENT } from './sync-attention-ui.js';
import type { PublicRejoinDecision, RejoinDecisionChoice, RejoinDecisionRequest,
  RejoinDecisionResponse } from './scope-rejoin-decisions.js';

interface RejoinDecisionHost {
  readonly panel: HTMLElement;
  readonly show: () => void;
  readonly onResolved?: () => void;
}
const REFRESH_MS = 8_000;
const REQUEST_TIMEOUT_MS = 10_000;

export function bindRejoinDecisions(host: RejoinDecisionHost) {
  const panel = host.panel;
  const heading = el('h2'); heading.id = 'rejoin-decisions-heading';
  const intro = el('p', undefined, 'detail');
  const head = el('div', undefined, 'set-group-head'); head.append(heading, intro);
  const list = el('div', undefined, 'set-card');
  const feedback = el('p', undefined, 'feedback'); feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true;
  const retry = el('button', undefined, 'btn btn-secondary btn-sm'); retry.type = 'button';
  panel.append(head, list, feedback, retry); panel.tabIndex = -1;
  panel.setAttribute('aria-labelledby', heading.id);
  let libraryId = '', connected = false, disposed = false, busy = false, owner = 0, readTurn = 0;
  let awaitingResult: string | undefined;
  let rows: readonly PublicRejoinDecision[] = [];
  const cancellations = new Set<() => void>();
  const isCurrent = (version: number) => !disposed && version === owner && connected && !!libraryId;
  const setFeedback = (text: string) => { feedback.textContent = text; feedback.hidden = !text; panel.hidden = !rows.length && !text; };

  function reset() {
    owner += 1; readTurn += 1; busy = false;
    for (const cancel of [...cancellations]) cancel();
    rows = []; awaitingResult = undefined; feedback.textContent = ''; feedback.hidden = true; render();
  }
  function send(message: RejoinDecisionRequest): Promise<RejoinDecisionResponse> {
    return new Promise(resolve => {
      let done = false;
      const finish = (value: unknown) => {
        if (done) return;
        done = true; clearTimeout(timer); cancellations.delete(cancel); resolve(normalize(value));
      };
      const cancel = () => finish({ ok: false, error: 'extension_unavailable' });
      const timer = setTimeout(cancel, REQUEST_TIMEOUT_MS); cancellations.add(cancel);
      Promise.resolve().then(() => chrome.runtime.sendMessage(message)).then(finish, cancel);
    });
  }
  function render() {
    heading.textContent = t('rejoin_heading', 'Review changes made while sync was paused');
    intro.textContent = t('rejoin_intro', 'Choose how these items should sync again. Each choice applies only to the items shown.');
    retry.textContent = t('common_refresh', 'Refresh'); retry.disabled = busy;
    panel.setAttribute('aria-busy', String(busy));
    list.replaceChildren(...rows.map(row => decisionCard(row, busy,
      (choice, confirmSubtree) => { void decide(row, choice, confirmSubtree); }, () => { void recover(row); })));
    list.hidden = !rows.length; panel.hidden = !rows.length && feedback.hidden;
  }
  async function refresh() {
    if (!connected || !libraryId || disposed || busy) return;
    const version = owner, turn = ++readTurn;
    const response = await send({ kind: 'known.sync.rejoinDecisions.get' });
    if (!isCurrent(version) || turn !== readTurn) return;
    if (!response.ok) { rows = []; render(); setFeedback(errorCopy(response.error)); return; }
    rows = response.decisions; render();
    if (awaitingResult && !rows.some(row => row.commandId === awaitingResult)) {
      awaitingResult = undefined;
      setFeedback(t('rejoin_noLongerWaiting', 'This decision is no longer waiting. Check sync status for any remaining steps.'));
      host.onResolved?.();
    } else if (awaitingResult && rows.some(row => row.commandId === awaitingResult && row.state === 'applying')) {
      setFeedback(t('rejoin_applyingSaved', 'Your choice is saved. Sync is finishing this change.'));
    }
  }
  async function recover(row: PublicRejoinDecision) {
    if (busy || !isCurrent(owner) || !rows.some(current => current.commandId === row.commandId
        && current.token === row.token && current.blockedReason)) return;
    if (!row.recoveryAction || row.recoveryAction === 'refresh') { await refresh(); return; }
    host.show();
    window.dispatchEvent(new CustomEvent(SYNC_ATTENTION_SHOW_EVENT, { detail: { action: row.recoveryAction } }));
  }
  async function decide(row: PublicRejoinDecision, choice: RejoinDecisionChoice, confirmSubtree = false) {
    if (busy || !connected || !libraryId || disposed || row.state !== 'pending'
      || row.blockedReason || !rows.some(current => current.commandId === row.commandId
        && current.token === row.token && current.state === 'pending' && !current.blockedReason)) return;
    if (choice === 'apply_remote_delete' && (row.kind !== 'remote_delete' || !confirmSubtree)) return;
    const request: RejoinDecisionRequest = choice === 'apply_remote_delete'
      ? { kind: 'known.sync.rejoinDecisions.resolve', commandId: row.commandId, token: row.token,
        choice, userGesture: true, affectedCount: row.affectedCount, confirmSubtree: true }
      : { kind: 'known.sync.rejoinDecisions.resolve', commandId: row.commandId, token: row.token, choice, userGesture: true };
    const version = owner; busy = true; readTurn += 1; setFeedback(''); render();
    const response = await send(request);
    if (!isCurrent(version)) return;
    busy = false;
    if (response.ok) {
      awaitingResult = undefined;
      rows = response.decisions; render();
      setFeedback(rows.some(current => current.commandId === row.commandId)
        ? t('rejoin_applyingSaved', 'Your choice is saved. Sync is finishing this change.')
        : t('rejoin_saved', 'Your choice is saved.'));
      host.onResolved?.();
      return;
    }
    // A failed or lost reply never leaves the old token actionable. GET resumes
    // accepted work and returns the latest decision; the user must click again.
    awaitingResult = ['preview_stale', 'rejoin_boundary_changed', 'decision_already_made', 'decision_not_found',
      'request_invalid', 'permission_required', 'sync_paused', 'personal_sync_paused'].includes(response.error) ? undefined : row.commandId;
    rows = []; render(); setFeedback(errorCopy(response.error));
    await refresh();
  }
  const show = async () => {
    if (disposed) return;
    host.show(); await refresh();
    if (!disposed) { panel.hidden = false; panel.focus(); }
  };
  const showListener = () => { void show(); };
  retry.addEventListener('click', () => { void refresh(); });
  window.addEventListener('known.sync.rejoinDecisions.show', showListener);
  const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
  const dispose = () => {
    disposed = true; reset(); clearInterval(timer);
    window.removeEventListener('known.sync.rejoinDecisions.show', showListener);
    window.removeEventListener('pagehide', dispose);
  };
  window.addEventListener('pagehide', dispose);
  render();
  return { refresh,
    setLibraryId(value?: string) {
      if ((value ?? '') === libraryId) return;
      libraryId = value ?? ''; reset(); if (connected && libraryId) void refresh();
    },
    onConnection(value: boolean) {
      if (connected === value) return;
      connected = value; reset(); if (connected && libraryId) void refresh();
    },
  };
}

function decisionCard(row: PublicRejoinDecision, busy: boolean,
  decide: (choice: RejoinDecisionChoice, confirmSubtree?: boolean) => void, recover: () => void): HTMLElement {
  const card = el('section', undefined, 'set-row'); card.dataset.rejoinDecision = row.commandId;
  const text = el('div', undefined, 'set-row-text');
  text.append(el('h3', row.title || t('rejoin_untitled', 'Bookmark changes'), 'set-row-title'));
  const detail = row.kind === 'local_delete'
    ? tn('rejoin_localDelete', row.affectedCount,
      'This item was removed from this browser while sync was paused. Its current cloud copy contains $1 item. Restore it here, or delete it from your library and other synced browsers.',
      'This item was removed from this browser while sync was paused. Its current cloud copy contains $1 items. Restore them here, or delete them from your library and other synced browsers.')
    : row.kind === 'remote_delete'
      ? tn('rejoin_remoteDelete', row.affectedCount,
        'This item was deleted from the library while sync was paused, and this browser has local changes. Its current browser copy contains $1 item. Keep it here, or apply the cloud deletion to this browser.',
        'This item was deleted from the library while sync was paused, and this browser has local changes. Its current browser copy contains $1 items. Keep them here, or apply the cloud deletion to this browser.')
      : t('rejoin_orderChanged', 'The browser and library have different bookmark orders. Choose the order to keep.');
  text.append(el('p', detail, 'set-row-hint'));
  if (row.kind === 'order') {
    for (const [label, values] of [[t('rejoin_browserOrder', 'Browser order'), row.localOrder],
      [t('rejoin_libraryOrder', 'Library order'), row.remoteOrder]] as const) {
      const details = el('details'); details.append(el('summary', label));
      const order = el('ol');
      for (const title of values ?? []) order.append(el('li', title || t('rejoin_untitled', 'Bookmark changes')));
      details.append(order); text.append(details);
    }
  }
  const actions = el('div', undefined, 'set-row-control');
  if (row.state === 'applying') actions.append(el('p', t('rejoin_applying', 'Finishing your saved choice…'), 'detail'));
  else if (row.blockedReason) {
    text.append(el('p', blockedCopy(row.blockedReason), 'set-row-hint'));
    const button = el('button', row.recoveryAction === 'retry_sync' ? t('sync_retrySync', 'Retry sync')
      : row.recoveryAction === 'reset_sync' ? t('sync_resetSyncDevice', 'Reset sync on this device')
        : t('common_refresh', 'Refresh'), 'btn btn-secondary btn-sm');
    button.type = 'button'; button.dataset.rejoinRecovery = row.recoveryAction ?? 'refresh'; button.disabled = busy;
    button.addEventListener('click', recover); actions.append(button);
  } else for (const choice of row.kind === 'local_delete' ? ['keep_remote', 'delete_remote'] as const
    : row.kind === 'remote_delete' ? ['keep_local', 'apply_remote_delete'] as const
      : ['keep_local_order', 'keep_remote_order'] as const) {
    const destructive = choice === 'delete_remote' || choice === 'apply_remote_delete';
    const button = el('button', choiceLabel(choice), destructive ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm');
    button.type = 'button'; button.dataset.rejoinAction = choice; button.disabled = busy;
    if (choice === 'apply_remote_delete') {
      const label = el('label', undefined, 'detail');
      const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.dataset.rejoinDeleteConfirm = '';
      checkbox.disabled = busy; button.disabled = true;
      label.append(checkbox, tn('rejoin_confirmBrowserDeletion', row.affectedCount,
        'I understand this removes $1 item from this browser.', 'I understand this removes $1 items from this browser.'));
      checkbox.addEventListener('change', () => { button.disabled = busy || !checkbox.checked; });
      button.addEventListener('click', () => { if (checkbox.checked) decide(choice, true); });
      actions.append(label);
    } else button.addEventListener('click', () => decide(choice));
    actions.append(button);
  }
  card.append(text, actions); return card;
}
function choiceLabel(choice: RejoinDecisionChoice): string {
  if (choice === 'keep_local') return t('rejoin_keepBrowser', 'Keep browser copy');
  if (choice === 'apply_remote_delete') return t('rejoin_applyCloudDeletion', 'Apply cloud deletion');
  if (choice === 'keep_remote') return t('rejoin_keepCloud', 'Keep cloud copy');
  if (choice === 'delete_remote') return t('rejoin_deleteLibrary', 'Delete from library');
  if (choice === 'keep_local_order') return t('rejoin_useBrowserOrder', 'Use browser order');
  return t('rejoin_useLibraryOrder', 'Use library order');
}
function blockedCopy(reason: NonNullable<PublicRejoinDecision['blockedReason']>): string {
  if (reason === 'unknown_upload') return t('rejoin_unknownUpload',
    'The result of an earlier upload is not confirmed. Check sync status before choosing what to keep. Your browser copy is preserved.');
  if (reason === 'pending_upload') return t('rejoin_pendingUpload',
    'Local changes are still waiting to sync. Check sync status before choosing what to keep. Your browser copy is preserved.');
  if (reason === 'upload_boundary_changed') return t('rejoin_changedBoundary',
    'The sync range changed while local changes were pending. Review sync recovery before choosing what to keep. Your browser copy is preserved.');
  return t('rejoin_nativeUnavailable', 'The current browser copy could not be verified safely. Check bookmark access, then refresh these decisions.');
}
function errorCopy(code: string): string {
  if (['preview_stale', 'rejoin_boundary_changed', 'decision_already_made', 'decision_not_found'].includes(code)) {
    return t('rejoin_changed', 'This decision changed. Review the latest items and choose again.');
  }
  if (code === 'permission_required') return t('rejoin_permission', 'Allow bookmark access, then refresh these decisions.');
  if (code === 'sync_paused' || code === 'personal_sync_paused') return t('rejoin_paused', 'Resume bookmark sync to review these decisions.');
  return t('rejoin_unavailable', 'The result could not be confirmed yet. Refresh to check your saved choice before trying again.');
}
function normalize(value: unknown): RejoinDecisionResponse {
  const invalid = { ok: false, error: 'extension_unavailable' } as const;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid;
  const response = value as Partial<RejoinDecisionResponse>;
  if (response.ok === false && typeof response.error === 'string') return { ok: false, error: response.error };
  if (response.ok !== true || !Array.isArray(response.decisions) || response.decisions.length > 20_000
    || !response.decisions.every(validDecision)) return invalid;
  return { ok: true, decisions: response.decisions };
}
function validDecision(value: unknown): value is PublicRejoinDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const prefix = row.kind === 'remote_delete' ? 'rejoin-remote-delete:'
    : row.kind === 'local_delete' ? 'rejoin-delete:' : row.kind === 'order' ? 'rejoin-order:' : undefined;
  return prefix !== undefined && typeof row.commandId === 'string' && row.commandId.startsWith(prefix) && row.commandId.length <= 1_024
    && typeof row.token === 'string' && /^sha256:[0-9a-f]{64}$/.test(row.token)
    && ['pending', 'applying'].includes(String(row.state))
    && (row.blockedReason === undefined || ['pending_upload', 'unknown_upload', 'upload_boundary_changed', 'native_unavailable'].includes(String(row.blockedReason)))
    && (row.recoveryAction === undefined || ['retry_sync', 'reset_sync', 'refresh'].includes(String(row.recoveryAction)))
    && typeof row.title === 'string' && row.title.length <= 16_384 && Number.isSafeInteger(row.affectedCount)
    && Number(row.affectedCount) >= 0 && [row.localOrder, row.remoteOrder].every(order => order === undefined
      || Array.isArray(order) && order.length <= 20_000 && order.every(title => typeof title === 'string' && title.length <= 16_384));
}
