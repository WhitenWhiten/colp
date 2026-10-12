import { localized, t } from './i18n.js';
export let ICON_POLICY_DISABLED_COPY: string, ICON_POLICY_UNREACHABLE_COPY: string;
localized(() => {
  ICON_POLICY_DISABLED_COPY = t('icons_automaticIconsOffNew', 'Automatic icons are off for new bookmarks.');
  ICON_POLICY_UNREACHABLE_COPY = t('icons_iconWillAddedWhen', 'The icon will be added when you are back online.');
});

/**
 * FO-04 popup icon feedback after a save. The helper upload runs in the
 * background, so the popup states the policy outcome it can observe now: a
 * server policy that disables automatic icons, or an unreachable policy
 * (offline) which defers the icon conservatively. Never blocks the saved
 * outcome.
 */
export function presentIconPolicyFeedback(
  setFeedback: (text: string, tone: '' | 'ok' | 'error') => void,
): void {
  void chrome.runtime.sendMessage({ kind: 'known.favicon.policy' }).then((response) => {
    const value = response as { readonly ok?: boolean; readonly policy?: { readonly newDefault?: string } };
    if (value?.ok && value.policy?.newDefault === 'none') {
      setFeedback(ICON_POLICY_DISABLED_COPY, '');
      return;
    }
    if (!value?.ok) setFeedback(ICON_POLICY_UNREACHABLE_COPY, '');
  }, () => {
    // Icon feedback must never disturb the save result.
  });
}