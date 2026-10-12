import { element } from './popup-dom.js';
import { t } from './i18n.js';

/** Opens an options route in a tab and lets the popup go. */
export function openOptionsRoute(hash: string): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${hash}`) }).then(() => { window.close(); }, () => undefined);
}

/**
 * The manual footer's two quiet actions: Bookmarks opens the library, and Save
 * tabs opens the tab-selection page for the current window (the same preview
 * the window shortcut opens). Both leave the popup; unfinished edits survive
 * in the session draft (popup-draft.ts), so reopening restores them.
 */
export function bindManualFooter(setFeedback: (text: string, tone?: '' | 'ok' | 'error') => void): void {
  element('open-bookmarks').addEventListener('click', () => { openOptionsRoute('#bookmarks'); });
  element('save-tabs').addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    void (async () => {
      try {
        const reply = await chrome.runtime.sendMessage({ kind: 'known.save.native', entry: 'window', userGesture: true }) as { ok?: boolean };
        if (!reply?.ok) throw new Error('preview_unavailable');
        window.close();
      } catch {
        setFeedback(t('popup_couldntOpenTabs', "Couldn't open the tab list. Try again."), 'error');
      }
    })();
  });
}
