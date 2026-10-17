import type { FaviconClearResponse } from './types.js';
import { t } from './i18n.js';

export interface ClearIconUiPorts {
  readonly isSavableUrl: (url: string) => boolean;
  readonly setFeedback: (text: string, tone?: '' | 'ok' | 'error') => void;
}

/**
 * FO-04 clear consumer UI: the popup "Clear auto-captured icon" action for a
 * bookmark whose source allows it. The button is only visible while the
 * current tab is already bookmarked; clicking it sends `known.favicon.clear`
 * with the native bookmark id, and the worker reads policy + source and DELETEs
 * the auto-captured icon with If-Match + Known-Favicon-Policy-Revision + a
 * fresh Known-Command-Id (see src/favicon-clear.ts). Feedback is best-effort:
 * icon failures never block the popup save flow.
 */
export function bindClearIconAction(ports: ClearIconUiPorts): (tabUrl: string | undefined) => Promise<void> {
  const button = document.getElementById('clear-icon') as HTMLButtonElement | null;
  let nativeIds: readonly string[] = [];
  if (button) button.addEventListener('click', () => { void clear(); });

  return async function refreshClearHint(tabUrl: string | undefined): Promise<void> {
    nativeIds = [];
    if (button) button.hidden = true;
    try {
      if (!tabUrl || !ports.isSavableUrl(tabUrl)) return;
      if (typeof chrome.bookmarks === 'undefined') return;
      if (!await chrome.permissions.contains({ permissions: ['bookmarks'] })) return;
      const matches = await chrome.bookmarks.search({ url: tabUrl });
      nativeIds = matches.map((item) => item.id);
      if (button) button.hidden = nativeIds.length === 0;
    } catch { /* The hint is best-effort; the save path stays untouched. */ }
  };

  async function clear(): Promise<void> {
    const nativeId = nativeIds[0];
    if (!nativeId) return;
    try {
      const response = await chrome.runtime.sendMessage({ kind: 'known.favicon.clear', nativeId }) as
        FaviconClearResponse | undefined;
      if (response?.ok === true) {
        if (response.outcome === 'cleared') ports.setFeedback(t('popup_autoCapturedIconCleared', 'Auto-captured icon cleared.'), 'ok');
        else if (response.outcome === 'protected') ports.setFeedback(t('popup_bookmarkUsesManuallySet', 'This bookmark uses a manually set icon.'), '');
        else if (response.outcome === 'noop') ports.setFeedback(t('popup_noAutoCapturedIcon', 'No auto-captured icon to clear.'), '');
        else ports.setFeedback(t('popup_couldNotClearIcon', 'Could not clear the icon right now.'), 'error');
      } else {
        ports.setFeedback(response?.error === 'bookmark_unmapped'
          ? t('popup_bookmarkNotSynced', 'This bookmark doesn’t sync with your library.') : t('popup_couldNotClearIcon', 'Could not clear the icon right now.'), 'error');
      }
    } catch {
      ports.setFeedback(t('popup_couldNotClearIcon', 'Could not clear the icon right now.'), 'error');
    }
  }
}