import { authErrorCopy } from './auth-error-copy.js';
import { t } from './i18n.js';

/**
 * W2B-P1-1 / W2B-P1-2: a sign-in that was working and was ended for the person (it ran past its lifetime, the server stopped
 * accepting it, or the sign-in configuration changed) keeps this browser's replica, its queue and its bookmarks. The extension
 * says so where the person looks, on the Account page, the Sync tab and the sidebar, and not only in a toast that is gone in
 * seconds. Signing out on purpose and a browser that was never signed in carry no reason, and read as they always did.
 */
const SIGN_IN_ENDED = new Set(['session_expired', 'authentication_required', 'credential_revoked', 'binding_mismatch']);

/** Whether this code says the sign-in is over (and only signing in again continues), not that something is retrying. */
export function signInHasEnded(code: string | undefined): boolean {
  return code !== undefined && SIGN_IN_ENDED.has(code);
}

/**
 * The reason a working sign-in ended, or `undefined`. The worker reports it as `signed_out` with the stored reason; the
 * first read after the sign-in configuration changes answers `error` with `binding_mismatch` and clears the credential
 * in the same breath, so that one counts too.
 */
export function endedSignInReason(state: { readonly status: string; readonly errorCode?: string }): string | undefined {
  const reported = state.status === 'signed_out' || (state.status === 'error' && state.errorCode === 'binding_mismatch');
  return reported && signInHasEnded(state.errorCode) ? state.errorCode : undefined;
}

/** Why, in the words the sign-in toast uses (an expired session is told apart from a revoked one), and that nothing here was lost. */
export function endedSignInCopy(reason: string): string {
  return `${authErrorCopy(reason)} ${t('options_signedOutKept', 'Sync is paused. Your bookmarks and any changes that have not synced yet are kept here.')}`;
}

/** The sidebar's line after its "Sign in" link: "Sign in" + "again to resume sync". */
export function endedSignInLine(): string {
  return t('options_againToResumeSync', 'again to resume sync');
}

export interface SignedOutNodes {
  /** The Account page's lede above the sign-in form. */
  readonly lede: HTMLElement;
  /** The Sync tab's "Connect this browser" card. */
  readonly connect: HTMLElement;
}

/**
 * Paints, or restores, the two places that talk to a signed-out person. The restored words are the page's own, so a browser
 * that was never signed in reads exactly as it always did.
 */
export function paintSignedOut(nodes: SignedOutNodes, reason: string | undefined): void {
  const title = nodes.connect.querySelector<HTMLElement>('.empty-title');
  const hint = nodes.connect.querySelector<HTMLElement>('.empty-hint');
  if (reason) {
    nodes.lede.textContent = endedSignInCopy(reason);
    if (title) title.textContent = t('options_signInAgain', 'Sign in again');
    if (hint) hint.textContent = endedSignInCopy(reason);
    return;
  }
  nodes.lede.textContent = t('shell_accountSignedOutLede', 'Saving, organizing and backups work without an account. Sign in to sync your library on every device.');
  if (title) title.textContent = t('options_connectThisBrowser', 'Connect this browser');
  if (hint) hint.textContent = t('options_collectionsSyncedFoldersConfirmations2', 'Sign in to sync and import into your library. Saving, organizing and HTML import work without an account.');
}
