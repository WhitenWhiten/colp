import { bindLibraryMetadata } from './library-metadata-ui.js';
import { PERSONAL_SYNC_PREFIX, type PersonalSyncPolicy } from './personal-sync-policy.js';
import type { PersonalSyncCommand, PersonalSyncAction } from './personal-sync-commands.js';
import { createDialog, dialogButton } from './dialog.js';
import { button, el } from './library-dom.js';
import { t } from './i18n.js';
import { dismissToast, showToast } from './toast.js';

type Reply = { ok: boolean; error?: string; policy?: PersonalSyncPolicy; token?: string; revision?: string; queued?: number };
export function bindPersonalSyncControls(host: HTMLElement) {
  const card = el('div', undefined, 'set-card'); card.id = 'personal-sync-controls';
  const row = el('div', undefined, 'set-row'), text = el('div', undefined, 'set-row-text');
  const status = el('p', undefined, 'set-row-title'); status.id = 'personal-sync-status';
  const boundary = t('sync_personalBoundary', 'This browser’s bookmarks stay in sync with your library. Pausing or disconnecting never removes bookmarks from this browser.');
  const hint = el('p', boundary, 'set-row-hint');
  const actions = el('div', undefined, 'set-row-control personal-sync-actions');
  const toggle = button('', 'btn btn-secondary btn-sm'), disconnect = button(t('sync_personalDisconnect', 'Disconnect sync'), 'btn btn-ghost btn-sm');
  toggle.id = 'personal-sync-toggle'; disconnect.id = 'personal-sync-disconnect';
  text.append(status, hint); actions.append(toggle, disconnect); row.append(text, actions); card.append(row);
  // Status keeps urgent sync notices first, followed by this connection card.
  host.append(card);
  const metadata = bindLibraryMetadata(card);
  card.hidden = true;
  let policy: PersonalSyncPolicy | undefined, started = true, busy = false, version = 0;
  async function send(command: PersonalSyncCommand): Promise<Reply> {
    const result = await chrome.runtime.sendMessage(command) as Reply;
    if (!result?.ok) throw new Error(result?.error ?? 'personal_sync_failed');
    return result;
  }
  function paint() {
    const mode = policy?.mode;
    // The library binds automatically; first sync still starts from Folders.
    const ready = mode === 'enabled' && !started;
    status.textContent = ready ? t('sync_libraryReady', 'Ready to sync. Review your browser’s bookmarks to start the first sync.')
      : mode === 'enabled' ? t('sync_personalEnabled', 'Sync is on')
      : mode === 'paused' ? t('sync_personalPaused', 'Sync is paused')
      : mode === 'disconnected' ? t('sync_personalDisconnected', 'Sync is disconnected')
      : mode === 'target-unavailable' ? t('sync_libraryUnavailable', 'Your bookmark library is unavailable. Check the server connection. Your local bookmarks are kept.')
      : t('sync_personalConnecting', 'Connecting to your bookmark library…');
    toggle.textContent = mode === 'enabled' ? t('sync_personalPause', 'Pause sync')
      : mode === 'disconnected' ? t('sync_personalReconnect', 'Reconnect sync') : t('sync_personalResume', 'Resume sync');
    card.hidden = !policy; host.hidden = !policy;
    // Reconnection keeps the same account library.
    hint.textContent = mode === 'disconnected'
      ? t('sync_personalLibraryDisconnected', 'Reconnect to your bookmark library. Your local bookmarks are kept.')
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
    if (current === version) { policy = next; started = nextStarted; paint(); void metadata.refresh(); }
  }
  async function confirm(action: 'resume' | 'disconnect', queued: number) {
    const { dialog, body, actions } = createDialog(action === 'resume'
      ? t('sync_personalResumeReview', 'Review before resuming') : t('sync_personalDisconnect', 'Disconnect sync'));
    body.append(el('p', action === 'resume'
      ? t('sync_personalResumeHint', 'Changes made while paused, in this browser and in your library, are reconciled. After a disconnect, sync starts again with a fresh folder selection and a merge review.')
      : t('sync_personalDisconnectHint', 'Your local bookmarks and metadata are kept. $1 queued changes will be archived and will not retry. Subscriptions and sign-in are kept.', queued)));
    const cancel = dialogButton(t('common_cancel', 'Cancel')), proceed = dialogButton(action === 'resume'
      ? t('sync_personalResume', 'Resume sync') : t('sync_personalDisconnect', 'Disconnect sync'), 'primary');
    actions.append(cancel, proceed); document.body.append(dialog); dialog.showModal();
    return new Promise<boolean>(resolve => { let accepted = false;
      cancel.onclick = () => dialog.close(); proceed.onclick = () => { accepted = true; dialog.close(); };
      dialog.addEventListener('close', () => { dialog.remove(); resolve(accepted); }, { once: true });
    });
  }
  async function change(action: PersonalSyncAction) {
    if (!policy || busy) return;
    busy = true; paint();
    try {
      if (action === 'pause') await send({ kind: 'known.personalSync.change', action, revision: policy.revision, userGesture: true });
      else {
        const preview = await send({ kind: 'known.personalSync.preview', action });
        if (!await confirm(action, preview.queued ?? 0)) return;
        await send({ kind: 'known.personalSync.change', action, revision: preview.revision!, token: preview.token!, userGesture: true });
      }
      dismissToast();
    } catch {
      showToast(t('sync_personalLibraryChangeFailed', 'The change could not be completed. Check the connection and review again. Sync stays stopped until reconnect is verified.'), 'error', { announce: true });
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
