import type { PopupNote } from './popup-note.js';
import { t } from './i18n.js';

/**
 * What the popup says about syncing, only when it matters. `sync-off`: connected before the first sync. `local`: the
 * chosen folder sits outside the synced range. `synced` and `none` say nothing:
 * a save that syncs needs no sentence.
 */
export type DestSyncNote =
  | { readonly kind: 'none' | 'sync-off' | 'synced' }
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
    link.textContent = t('popup_turnOnSync', 'Turn on sync');
    link.addEventListener('click', () => {
      void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#sync/folders') });
    });
  }
  const line = document.createElement('span');
  const lead = state.kind === 'local' ? t('popup_folderNotSynced', "This folder isn't synced to Know-N") : t('popup_syncOff', 'Sync is off');
  line.append(`${lead} · `, link);
  note.set('dest', line);
}
