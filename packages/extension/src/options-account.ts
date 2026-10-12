import { avatarLetter, fillAvatar, shortLabel } from './account-label.js';
import { createIcon } from './icons.js';
import { creditSummary, type GeneratedCreditOverview } from './credits-ledger.js';
import { t } from './i18n.js';
import type { PublicAuthState } from './types.js';

/**
 * Everything the options page shows about the signed-in account: the sidebar
 * identity, the Account page's identity card, its credits summary and sync row,
 * and the one alert that appears when the connection needs the reader.
 */
export interface AccountAlert { readonly title: string; readonly detail: string; readonly action: string; readonly actionKind: string }

export function createAccountView() {
  const node = (id: string): HTMLElement => document.getElementById(id) ?? document.createElement('span');
  const sideAvatar = node('side-avatar'), identityAvatar = node('identity-avatar'), identityName = node('identity-name'), identityEmail = node('identity-email');
  const manage = node('manage-account') as HTMLAnchorElement, alert = node('account-alert');
  const status = node('status'), detail = node('detail'), action = node('primary-action') as HTMLButtonElement;
  const creditsTitle = node('credits-summary-title'), creditsHint = node('credits-summary-hint'), syncHint = node('account-sync-hint');
  let collection = '', syncStatus = '', creditsRequest = 0;

  function paintIdentity(state: PublicAuthState): void {
    const label = state.accountLabel, signedIn = state.status !== 'signed_out' || Boolean(label);
    if (!signedIn) {
      sideAvatar.replaceChildren(createIcon('person', 14));
      return;
    }
    const origin = state.status === 'connected' ? state.serverOrigin : undefined;
    fillAvatar(sideAvatar, avatarLetter(label), state.avatarUrl, origin);
    fillAvatar(identityAvatar, avatarLetter(label), state.avatarUrl, origin);
    const email = label?.includes('@') ? label : '';
    identityName.textContent = label ? shortLabel(label) : t('common_account', 'Account');
    identityEmail.textContent = email; identityEmail.hidden = email === '';
    if (state.serverOrigin) { manage.href = `${state.serverOrigin.replace(/\/$/u, '')}/settings`; }
  }

  /** The alert only speaks when the connection needs attention; a healthy session says nothing. */
  function paintAlert(view: AccountAlert, show: boolean, busy: boolean): void {
    alert.hidden = !show;
    status.textContent = view.title; detail.textContent = view.detail;
    action.textContent = view.action; action.dataset.action = view.actionKind;
    action.hidden = !show; action.disabled = busy;
    if (busy) action.setAttribute('aria-busy', 'true'); else action.removeAttribute('aria-busy');
  }

  function paintSync(): void {
    const parts = [collection ? t('shell_savingInto', 'Saving into $1', collection) : t('shell_syncNotSetUp', 'Not set up yet'), syncStatus].filter(Boolean);
    syncHint.textContent = parts.join(' · ');
  }

  return {
    paintIdentity, paintAlert,
    setCollection(title: string) { collection = title; paintSync(); },
    setSyncStatus(label: string) { syncStatus = label; paintSync(); },
    /** Reads the balance once per call; a stale answer never paints over a newer one. */
    async loadCredits(load: () => Promise<GeneratedCreditOverview | 'unsupported'>): Promise<void> {
      const turn = ++creditsRequest;
      try {
        const overview = await load();
        if (turn !== creditsRequest) return;
        const section = creditsTitle.closest('section');
        if (overview === 'unsupported') { if (section) section.hidden = true; return; }
        if (section) section.hidden = false;
        const summary = creditSummary(overview.balance);
        creditsTitle.textContent = summary.title; creditsHint.textContent = summary.hint; creditsHint.hidden = summary.hint === '';
      } catch {
        if (turn !== creditsRequest) return;
        creditsTitle.textContent = t('credits_balanceUnavailable', 'Balance unavailable'); creditsHint.hidden = true;
      }
    },
  };
}
