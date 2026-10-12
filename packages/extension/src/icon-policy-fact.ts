import type { IconPolicyDto } from './favicon-helper-client.js';
import { t } from './i18n.js';

/** Display copy for the account's icon policy. */
export type IconPolicyFactText = string;

export function iconPolicyFactText(policy: IconPolicyDto): IconPolicyFactText {
  if (policy.newDefault === 'capture') return t('icons_autoCaptureSave', 'Auto-capture on save');
  if (policy.newDefault === 'online') return t('icons_providerIconsOnly', 'Provider icons only');
  return t('icons_disabledServerPolicy', 'Disabled by server policy');
}

/** Whether a fetched policy value is structurally capturable (FO-04 client mirror). */
export function isCapturablePolicyFact(policy: unknown): policy is IconPolicyDto {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) return false;
  const value = policy as { readonly newDefault?: unknown };
  return value.newDefault === 'capture' || value.newDefault === 'online' || value.newDefault === 'none';
}

/**
 * FO-04 icon-policy hint for the settings page: reflects the same server
 * policy the helper drain enforces (capture/online/none). Offline/pending
 * shows the conservative-delay state — automatic icons resume once the
 * policy is reachable again.
 */
export function createIconPolicyFact(element: HTMLElement): { readonly refresh: (connected: boolean) => void } {
  return Object.freeze({
    refresh(connected: boolean) {
      if (!connected) {
        element.textContent = t('icons_notConnected', 'Not connected');
        return;
      }
      element.textContent = t('icons_checking', 'Checking');
      void chrome.runtime.sendMessage({ kind: 'known.favicon.policy' }).then((response) => {
        const value = response as { readonly ok?: boolean; readonly policy?: unknown; readonly error?: string };
        const row = element.closest('.set-row');
        if (value?.ok === false && value.error === 'unsupported') {
          if (row instanceof HTMLElement) row.hidden = true;
          return;
        }
        if (row instanceof HTMLElement) row.hidden = false;
        if (value?.ok && isCapturablePolicyFact(value.policy)) {
          element.textContent = iconPolicyFactText(value.policy);
        } else {
          element.textContent = t('icons_unavailableOffline', 'Unavailable (offline)');
        }
      }, () => { element.textContent = t('icons_unavailableOffline', 'Unavailable (offline)'); });
    },
  });
}