import { PERSONAL_SYNC_PREFIX, type PersonalSyncPolicy } from './personal-sync-policy.js';
import type { PersonalSyncCommand, PersonalSyncAction } from './personal-sync-commands.js';
import { createDialog, dialogButton } from './dialog.js';
import { button, el } from './library-dom.js';
import { t } from './i18n.js';

type Reply = { ok: boolean; error?: string; policy?: PersonalSyncPolicy; token?: string; revision?: string; queued?: number };
export function bindPersonalSyncControls(host: HTMLElement) {
  const card = el('div', undefined, 'set-card'); card.id = 'personal-sync-controls';
  const row = el('div', undefined, 'set-row'), text = el('div', undefined, 'set-row-text');
  const status = el('p', undefined, 'set-row-title'); status.id = 'personal-sync-status';
  const boundary = t('sync_personalBoundary', 'Personal sync is separate from sign-in, subscriptions, browser sync and your AI provider. Local bookmarks remain available.');
  const hint = el('p', boundary, 'set-row-hint');
  const actions = el('div', undefined, 'row-actions');
  const toggle = button('', 'btn btn-secondary btn-sm'), disconnect = button(t('sync_personalDisconnect', 'Disconnect personal sync'), 'btn btn-ghost btn-sm');
  toggle.id = 'personal-sync-toggle'; disconnect.id = 'personal-sync-disconnect';
  const feedback = el('p', undefined, 'feedback'); feedback.id = 'personal-sync-feedback'; feedback.setAttribute('role', 'status');
  text.append(status, hint); actions.append(toggle, disconnect); row.append(text, actions); card.append(row, feedback);
  // The connection's state heads the Collection tab; with no account or collection there is nothing to control.
  const head = host.querySelector('.set-group-head');
  if (head) head.after(card); else host.prepend(card);
  card.hidden = true;
  let policy: PersonalSyncPolicy | undefined, started = true, busy = false, version = 0;
  async function send(command: PersonalSyncCommand): Promise<Reply> {
    const result = await chrome.runtime.sendMessage(command) as Reply;
    if (!result?.ok) throw new Error(result?.error ?? 'personal_sync_failed');
    return result;
  }
  function paint() {
    const mode = policy?.mode;
    // A chosen collection is enabled at once, but nothing syncs until the first sync starts from Folders
    // (choosing a collection continues there, and the page links to it).
    const ready = mode === 'enabled' && !started;
    status.textContent = ready ? t('sync_personalReady', 'Ready to sync. Choose folders to start the first sync.')
      : mode === 'enabled' ? t('sync_personalEnabled', 'Personal sync is enabled')
      : mode === 'paused' ? t('sync_personalPaused', 'Personal sync is paused')
      : mode === 'disconnected' ? t('sync_personalDisconnected', 'Personal sync is disconnected')
      : mode === 'target-unavailable' ? t('sync_personalUnavailable', 'The selected collection is unavailable. Disconnect, then choose another collection. Your local bookmarks are kept.')
      : t('sync_personalChoose', 'Choose a collection to connect personal sync');
    toggle.textContent = mode === 'enabled' ? t('sync_personalPause', 'Pause personal sync')
      : mode === 'disconnected' ? t('sync_personalReconnect', 'Reconnect personal sync') : t('sync_personalResume', 'Resume personal sync');
    card.hidden = !policy;
    // Two ways back after a disconnect: reconnect the same collection here, or choose one in the list below.
    hint.textContent = mode === 'disconnected'
      ? t('sync_personalDisconnectedHint', 'Reconnect to continue with the same collection, or choose a collection below. Your local bookmarks are kept.')
      : boundary;
    toggle.disabled = busy || !policy || mode === 'target-unavailable';
    disconnect.hidden = mode === 'disconnected';
    disconnect.disabled = busy || !policy;
  }
  async function refresh() {
    const current = ++version;
    let next: PersonalSyncPolicy | undefined, nextStarted = true;
    try {
      next = (await send({ kind: 'known.personalSync.status' })).policy;
      const firstRun = await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }).catch(() => undefined) as { ok?: boolean; firstRun?: string } | undefined;
      nextStarted = !firstRun?.ok || (firstRun.firstRun !== 'none' && firstRun.firstRun !== 'deferred');
    } catch { next = undefined; }
    if (current === version) { policy = next; started = nextStarted; paint(); }
  }
  async function confirm(action: 'resume' | 'disconnect', queued: number) {
    const { dialog, body, actions } = createDialog(action === 'resume'
      ? t('sync_personalResumeReview', 'Review personal sync') : t('sync_personalDisconnect', 'Disconnect personal sync'));
    body.append(el('p', action === 'resume'
      ? t('sync_personalResumeHint', 'Changes made while paused on this device and in Know-N will be reconciled. A disconnected connection starts with a fresh folder selection and merge review.')
      : t('sync_personalDisconnectHint', 'Your local bookmarks and metadata are kept. $1 queued changes will be archived and will not retry. Subscriptions and sign-in are kept.', queued)));
    const cancel = dialogButton(t('common_cancel', 'Cancel')), proceed = dialogButton(action === 'resume'
      ? t('sync_personalResume', 'Resume personal sync') : t('sync_personalDisconnect', 'Disconnect personal sync'), 'primary');
    actions.append(cancel, proceed); document.body.append(dialog); dialog.showModal();
    return new Promise<boolean>(resolve => { let accepted = false;
      cancel.onclick = () => dialog.close(); proceed.onclick = () => { accepted = true; dialog.close(); };
      dialog.addEventListener('close', () => { dialog.remove(); resolve(accepted); }, { once: true });
    });
  }
  async function change(action: PersonalSyncAction) {
    if (!policy || busy) return;
    busy = true; paint(); feedback.textContent = '';
    try {
      if (action === 'pause') await send({ kind: 'known.personalSync.change', action, revision: policy.revision, userGesture: true });
      else {
        const preview = await send({ kind: 'known.personalSync.preview', action });
        if (!await confirm(action, preview.queued ?? 0)) return;
        await send({ kind: 'known.personalSync.change', action, revision: preview.revision!, token: preview.token!, userGesture: true });
      }
    } catch {
      feedback.textContent = t('sync_personalChangeFailed', 'The change could not be completed. Refresh the collection list and review again. Sync remains stopped if reconnect could not be verified.');
    } finally { busy = false; await refresh(); }
  }
  toggle.onclick = () => { void change(policy?.mode === 'enabled' ? 'pause' : 'resume'); };
  disconnect.onclick = () => { void change('disconnect'); };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(key => key.startsWith(PERSONAL_SYNC_PREFIX)
      || key === 'known.sync.collection.v1' || key.startsWith('known.auth.'))) void refresh();
  });
  return { refresh };
}
