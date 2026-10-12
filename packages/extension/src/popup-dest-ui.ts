import { setHidden } from './popup-dom.js';
import { urlSummary } from './popup-shell.js';
import { t } from './i18n.js';

/**
 * Collapsed-summary ↔ expanded-editor rows: the domain line shows a host/path
 * summary until clicked (then a quiet URL input takes its place), and the
 * folder pill opens an inline panel with a substring filter. The pill names
 * the folder alone — the synced library is derived from it, never picked here.
 */
export interface DestUiHost {
  readonly destToggle: HTMLButtonElement;
  readonly destPanel: HTMLElement;
  readonly destSearch: HTMLInputElement;
}

export function bindDestUi(host: DestUiHost): void {
  const emptyNote = document.createElement('p');
  emptyNote.className = 'folder-dest-empty';
  emptyNote.dataset.destEmpty = '';
  emptyNote.textContent = t('popup_noFoldersMatch', 'No folders match.');
  emptyNote.hidden = true;
  const list = host.destPanel.querySelector('[role="listbox"]');
  if (list) list.after(emptyNote); else host.destPanel.append(emptyNote);
  /* Substring filter over the folder rows. A search reads the full tree
     once, so the Recent group (and every group caption) steps aside. */
  host.destSearch.addEventListener('input', () => {
    const query = host.destSearch.value.trim().toLowerCase();
    const folders = Array.from(host.destPanel.querySelectorAll<HTMLButtonElement>('[data-folder-id]'));
    for (const option of folders) {
      const label = (option.title || option.textContent || '').toLowerCase();
      const recent = option.closest('[data-folder-group="recent"]') !== null;
      option.hidden = query !== '' && (recent || !label.includes(query));
    }
    for (const note of Array.from(host.destPanel.querySelectorAll<HTMLElement>('.folder-group-label, [data-folder-group="recent"]'))) {
      note.hidden = query !== '';
    }
    emptyNote.hidden = query === '' || folders.some((option) => !option.hidden);
    const tabStop = folders.find((option) => option.tabIndex === 0);
    if (tabStop?.hidden) {
      tabStop.tabIndex = -1;
      const firstVisible = folders.find((option) => !option.hidden);
      if (firstVisible) firstVisible.tabIndex = 0;
    }
  });
  host.destToggle.addEventListener('click', () => {
    host.destSearch.value = '';
    host.destSearch.dispatchEvent(new Event('input'));
  });
}

/** Returns the painter that mirrors the current URL into the summary button. */
export function bindUrlDisplay(
  display: HTMLButtonElement, input: HTMLInputElement, rawUrl: () => string,
): () => void {
  display.addEventListener('click', () => {
    setHidden(display, true);
    setHidden(input, false);
    input.focus();
    input.select();
  });
  return function paintUrlDisplay(): void {
    const raw = rawUrl();
    display.textContent = urlSummary(raw);
    display.title = raw;
  };
}
