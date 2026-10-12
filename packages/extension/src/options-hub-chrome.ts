import { t } from './i18n.js';
import { syncTone, type SyncStatus } from './sync-status.js';
import type { PublicAuthState } from './types.js';

/**
 * The sidebar identity block: who is signed in and one status line.
 *
 * The account state ("Not signed in") and the sync engine's phase ("Synced")
 * are two readings of one connection, so they share one line: the account
 * state until there is a connection for the engine phase to describe, the
 * phase after that. Signed out, the line invites signing in instead.
 *
 * One vocabulary (R13 E-18):
 * - Account state: "Signed in", "Not signed in", "Offline", "Signing in",
 *   "Renewing session", "Sign-in problem".
 * - Sync state: "Synced", "Syncing", "Review conflicts", "Action required",
 *   "Sync is off", "Waiting for network" (the FIRST_RUN_* constants).
 */
export interface HubChrome {
  /** @param status the public auth status. @param label the account's name, when one is known. */
  setAccount(status: PublicAuthState['status'], label?: string): void;
  setEnginePhase(status: SyncStatus | undefined, connected: boolean): void;
}

export interface HubChromeNodes {
  readonly name: HTMLElement;
  readonly line: HTMLElement;
  readonly dot: HTMLElement;
  readonly signIn: HTMLElement;
}

export function bindHubChrome(nodes: HubChromeNodes): HubChrome {
  let account: PublicAuthState['status'] = 'signed_out';
  const accountLine = (status: PublicAuthState['status']): string => status === 'connected' ? t('common_signedIn', 'Signed in')
    : status === 'offline' ? t('common_offline', 'Offline')
      : status === 'connecting' ? t('common_signingIn2', 'Signing in')
        : status === 'refreshing' ? t('common_renewingSession', 'Renewing session')
          : status === 'error' || status === 'policy_blocked' ? t('common_signInProblem', 'Sign-in problem') : t('options_forOptionalSync', 'for optional sync');
  /* `ok` is the dot's default green; everything not yet settled is the quiet grey. */
  function paintDot(tone: ReturnType<typeof syncTone> | undefined): void {
    if (tone === undefined || tone === 'ok') delete nodes.dot.dataset.tone;
    else nodes.dot.dataset.tone = tone === 'attention' ? 'warning' : 'off';
  }
  function setEnginePhase(status: SyncStatus | undefined, connected: boolean): void {
    const shown = connected && Boolean(status);
    nodes.line.textContent = shown ? status!.label : accountLine(account);
    paintDot(shown ? syncTone(status!.kind, 'connected') : account === 'connected' ? 'ok' : 'busy');
  }
  return {
    setAccount(status, label) {
      account = status;
      const signedOut = status === 'signed_out';
      nodes.name.textContent = signedOut ? t('sync_notSignedIn', 'Not signed in') : label || t('common_account', 'Account');
      nodes.signIn.hidden = !signedOut;
      nodes.dot.hidden = signedOut;
      nodes.line.textContent = accountLine(status);
      paintDot(status === 'connected' ? 'ok' : 'busy');
      if (status !== 'connected') setEnginePhase(undefined, false);
    },
    setEnginePhase,
  };
}

/** The engine retries a failed wake about every 30s; re-reading faster shows nothing new. */
export const SYNC_CHIP_REFRESH_MS = 30_000;

/**
 * Keeps the status line's sync phrase current. It used to be read once per
 * sign-in render, so a long-open options page kept whatever it first saw, even
 * after first sync finished or the network came back. It is re-read on return
 * to the page, on reconnect, when a watched storage key changes, and on the
 * engine's retry cadence while visible; a slower earlier read never paints over
 * a later one.
 */
export function bindSyncChipRefresh(hub: HubChrome, input: { connected(): boolean; read(): Promise<SyncStatus>;
  keys: readonly string[]; keyPrefixes?: readonly string[] }): () => Promise<void> {
  let latest = 0;
  async function refresh(): Promise<void> {
    if (!input.connected()) return;
    const turn = ++latest; const label = await input.read();
    if (turn === latest) hub.setEnginePhase(label, input.connected());
  }
  const whenVisible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
  window.addEventListener('focus', whenVisible); window.addEventListener('online', whenVisible);
  document.addEventListener('visibilitychange', whenVisible);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (input.keys.some((key) => key in changes)
      || Object.keys(changes).some(key => input.keyPrefixes?.some(prefix => key.startsWith(prefix))))) void refresh();
  });
  window.setInterval(whenVisible, SYNC_CHIP_REFRESH_MS);
  return refresh;
}
