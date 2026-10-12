import { bindOverflowMenu, element, paintAccountLabel } from './popup-dom.js';
import { NATIVE_WAIT_OPTIONS_PATH } from './native-wait-ui.js';
import { signedInSyncStatus } from './sync-label.js';
import { bindPopupSyncProgress } from './sync-progress-dom.js';
import { projectSyncStatus, syncTone, type SyncStatus, type SyncStatusKind } from './sync-status.js';
import type { PublicAuthState } from './types.js';

/**
 * Whether the avatar wears a dot, and which. It appears only when sync needs
 * the user: `danger` for what only they can fix (action required, conflicts),
 * the default warning dot for sync that is stuck (retrying, no network).
 * Ordinary syncing, a calm account and every signed-out state show none.
 */
export function attentionFor(kind: SyncStatusKind, auth: PublicAuthState['status']): 'danger' | 'warning' | undefined {
  const tone = syncTone(kind, auth);
  if (tone === 'attention') return 'danger';
  return tone === 'busy' && auth === 'connected' && (kind === 'retrying' || kind === 'waiting-network') ? 'warning' : undefined;
}

export function paintAttention(host: HTMLElement, attention: 'danger' | 'warning' | undefined): void {
  if (attention === undefined) { host.removeAttribute('data-attention'); return; }
  host.setAttribute('data-attention', attention === 'danger' ? 'danger' : '');
}

/**
 * The shell's header, shared by every popup state: the wordmark, the account
 * avatar (signed in only; it opens Account), the gear (opens Options) and the
 * overflow menu, which exists only while one of its two actions is actionable.
 */
export function bindPopupHeader() {
  const account = element('account-label');
  const accountButton = element('open-account') as HTMLButtonElement;
  const popupMore = element('popup-more') as HTMLDetailsElement;
  const openNativeWait = element('open-native-wait') as HTMLButtonElement;
  const clearIcon = element('clear-icon') as HTMLButtonElement;
  let syncStatus: SyncStatus = projectSyncStatus('syncing');
  let readVersion = 0;
  let connected = false;
  // The first-sync strip under the header follows the same account state.
  const syncProgress = bindPopupSyncProgress({ connected: () => connected });

  element('open-options').addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
  accountButton.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#account`) });
  });
  // S1 / B0-1: needsAttention can mean a native wait, so the popup deep-links straight
  // to that card. A new tab (not openOptionsPage) is what carries the hash fragment.
  openNativeWait.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(NATIVE_WAIT_OPTIONS_PATH) });
  });
  /* The overflow menu only earns its slot when one of its two conditional
     actions is actionable; the write is guarded so this observer cannot re-trigger itself. */
  new MutationObserver(() => {
    const next = openNativeWait.hidden && clearIcon.hidden;
    if (popupMore.hidden !== next) popupMore.hidden = next;
  }).observe(popupMore, { attributes: true, subtree: true, attributeFilter: ['hidden'] });
  bindOverflowMenu(popupMore);

  function paint(state: PublicAuthState): void {
    const version = ++readVersion;
    if (connected !== (state.status === 'connected')) {
      connected = state.status === 'connected';
      void syncProgress.refresh();
    }
    syncStatus = projectSyncStatus('syncing');
    paintAccountLabel(account, state);
    accountButton.title = state.accountLabel ?? '';
    paintAttention(account, undefined);
    if (state.status !== 'connected') return;
    void signedInSyncStatus().then((status) => {
      if (version !== readVersion) return;
      syncStatus = status;
      paintAttention(account, attentionFor(status.kind, state.status));
    }).catch(() => undefined);
  }

  return { paint, syncStatus: () => syncStatus };
}
