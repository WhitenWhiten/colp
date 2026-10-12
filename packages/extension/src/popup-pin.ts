import { requestPin } from './bookmark-pin-messages.js';
import type { PinBlocker } from './bookmark-pin-order.js';
import { t } from './i18n.js';

/**
 * The popup's pin toggle, next to the folder. A new save goes in unpinned
 * unless it is pressed; pressing it is offered only where the chosen folder
 * takes pins, and anywhere else it explains what is missing in a quiet line
 * under the folder. Editing a saved bookmark shows its pin and changes it on Done.
 */
/** What a saved bookmark's editors (edit mode, the automatic result) use: show its pin, then send a change on Done. */
export type SavedPinToggle = Pick<ReturnType<typeof bindPopupPin>, 'adopt' | 'change'>;

export function bindPopupPin(elements: { readonly button: HTMLButtonElement; readonly hint: HTMLElement }, folderId: () => string) {
  const { button, hint } = elements;
  let wanted = false, saved: boolean | undefined, blockers: readonly PinBlocker[] = [], version = 0;

  function paint(): void {
    button.setAttribute('aria-pressed', String(wanted));
    const label = wanted ? t('pin_unpin', 'Unpin') : t('pin_pin', 'Pin');
    button.setAttribute('aria-label', label); button.title = wanted && blockers.length ? t('pin_pausedHere', 'Pinned. Pins are off in this folder; click to unpin.') : label;
    button.toggleAttribute('data-paused', wanted && blockers.length > 0);
    if (!wanted && blockers.length) button.setAttribute('aria-disabled', 'true'); else button.removeAttribute('aria-disabled');
    if (!blockers.length) hint.hidden = true;
  }

  function explain(): void {
    hint.replaceChildren();
    if (blockers.includes('folder_read_only')) {
      hint.textContent = t('pin_readOnly', 'This folder is read only, so its bookmarks cannot be pinned.');
    } else {
      const missing = [
        blockers.includes('insert_bottom') ? t('pin_conditionTop', 'New bookmarks go to the top of the folder') : '',
        blockers.includes('folders_first_off') ? t('pin_conditionFoldersFirst', 'Show folders before bookmarks is on') : '',
        blockers.includes('folder_unorganized') ? t('pin_conditionOrganized', 'This folder is organized, with its folders above its bookmarks') : '',
      ].filter(Boolean);
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'btn-retry'; open.textContent = t('pin_openSettings', 'Open Saving settings');
      open.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#saving') }); });
      hint.append(t('pin_popupNeeds', 'Pinning is off in this folder. It needs: $1.', missing.join(' · ')), ' ', open);
    }
    hint.hidden = false;
  }

  button.addEventListener('click', () => {
    if (!wanted && blockers.length) { explain(); return; }
    wanted = !wanted; paint();
  });

  return Object.freeze({
    /** Re-reads whether the chosen folder takes pins. A requested pin that can no longer apply is dropped. */
    async refresh(): Promise<void> {
      const current = ++version, folder = folderId();
      if (!folder) { button.hidden = true; return; }
      const response = await requestPin({ kind: 'known.bookmarks.pin.status', folderIds: [folder] });
      if (current !== version) return;
      // No permission or no worker: the save path reports that; the toggle just steps aside.
      button.hidden = !(response.ok && 'folders' in response);
      blockers = response.ok && 'folders' in response ? response.folders[folder] ?? ['folder_read_only'] : [];
      // A pin not yet applied cannot go into a folder that does not take pins; a saved pin stays (paused).
      if (blockers.length && wanted && !saved) wanted = false;
      paint();
      if (!hint.hidden && blockers.length) explain();
    },
    /** For a new save: true when the bookmark should go in pinned. */
    pinned: () => wanted && !blockers.length,
    /** Shows a saved bookmark's pin (edit mode), or clears it again. */
    adopt(pinned: boolean | undefined): void { saved = pinned; wanted = pinned === true; paint(); },
    /** Edit mode: the pin to send on Done, or undefined when it did not change. */
    change(): boolean | undefined { return saved !== undefined && wanted !== saved ? wanted : undefined; },
  });
}
