import { createDialog, dialogButton } from './dialog.js';
import type { ExtensionResponse } from './types.js';
import { t } from './i18n.js';

/**
 * The options page's sign-out confirmation: a modal dialog (src/dialog.ts) that
 * the auth action opens, and whose confirm button performs the logout.
 * Extracted from `options.ts`, which is under a shrinking-only source-size cap
 * (new code is split by responsibility, caps are never raised).
 */
export interface LogoutConfirmPorts {
  readonly busy: (text: string) => void;
  readonly render: (response: ExtensionResponse) => void;
  readonly requestLogout: () => Promise<ExtensionResponse>;
}

let ports: LogoutConfirmPorts | undefined;

/** Opens the confirmation modal (the caller already verified the user gesture). */
export function openLogoutConfirm(): void {
  if (!ports) return;
  const { dialog, body, actions } = createDialog(t('options_signOutKnowN', 'Sign out of Know-N?'));
  dialog.id = 'logout-dialog';
  const stay = dialogButton(t('options_staySignedIn', 'Stay signed in')), confirm = dialogButton(t('common_signOut', 'Sign out'), 'danger');
  stay.id = 'logout-cancel'; confirm.id = 'logout-confirm';
  const paragraph = document.createElement('p'); paragraph.textContent = t('options_bookmarksStayBrowserSync', 'Bookmarks, tags, notes and rules made in this browser stay. Sync and your account’s rules stop when you sign out.');
  const disclosure = document.createElement('p');
  disclosure.textContent = t('options_logoutLifecycle', 'Queued sync changes will be archived. Reconnecting after sign-in requires your review. Managed subscription copies will be removed; personal copies you made are kept. Device save history stays on this browser.');
  // The extension and the website share one session in this browser (src/auth-controller.ts).
  const shared = document.createElement('p');
  shared.textContent = t('options_logoutSharedSession', 'This browser shares one Know-N session with the website: signing out here also signs you out of Know-N on the web, and signing in there signs this extension in again.');
  body.append(paragraph, shared, disclosure); actions.append(stay, confirm);
  stay.addEventListener('click', () => { dialog.close(); });
  confirm.addEventListener('click', () => {
    dialog.close();
    const live = ports!;
    void (async () => {
      live.busy(t('auth_signingOut', 'Signing out…'));
      live.render(await live.requestLogout());
    })();
  });
  dialog.addEventListener('close', () => { dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
  stay.focus();
}

export function bindLogoutConfirm(next: LogoutConfirmPorts): void {
  ports = next;
}
