import type { PopupNote } from './popup-note.js';
import { t } from './i18n.js';

/**
 * What the popup says about syncing, only when it matters. `no-library` and
 * `choose-library`: connected with nothing bound to sync into. `local`: the
 * chosen folder sits outside the synced range. `synced` and `none` say nothing:
 * a save that syncs needs no sentence.
 */
export type DestSyncNote =
  | { readonly kind: 'none' | 'no-library' | 'choose-library' | 'synced' }
  | {
    readonly kind: 'local'; readonly folderId: string;
    /** Lands the save first: opening a tab closes the popup, which would drop an unsaved bookmark. */
    readonly requestSave: () => Promise<boolean>;
  };

/**
 * Writes the passive sync fact into the popup's note line. It never gates or
 * interrupts a save; it carries at most one quiet link to the settings that
 * change what syncs.
 */
export function paintDestSync(note: PopupNote, state: DestSyncNote): void {
  if (state.kind === 'none' || state.kind === 'synced') { note.set('dest', undefined); return; }
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'btn-retry';
  if (state.kind === 'local') {
    link.textContent = t('popup_syncThisFolder', 'Sync this folder…');
    link.addEventListener('click', () => {
      void (async () => {
        if (!await state.requestSave()) return;
        void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#sync/folders?native=${encodeURIComponent(state.folderId)}`) });
      })();
    });
  } else {
    link.textContent = state.kind === 'no-library'
      ? t('popup_setUpSync', 'Set up sync')
      : t('popup_chooseWhatSyncs', 'Choose what syncs');
    link.addEventListener('click', () => {
      void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#sync/collections') });
    });
  }
  const line = document.createElement('span');
  const lead = state.kind === 'local' ? t('popup_folderNotSynced', "This folder isn't synced to Know-N") : t('popup_onlyOnDevice', 'No Know-N sync');
  line.append(`${lead} · `, link);
  note.set('dest', line);
}
