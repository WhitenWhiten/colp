import { isSavableUrl, setHidden } from './popup-dom.js';
import type { PopupNote } from './popup-note.js';
import type { SyncStatus, SyncStatusKind } from './sync-status.js';
import { localized, t } from './i18n.js';

/**
 * The popup's save-lane feedback surface: the transient feedback line, the
 * save-target status (with its native-wait deep link) and the savability gate
 * that decides whether the save lane opens at all. Both lines are sources of
 * the popup's single note (popup-note.ts). Extracted from `popup.ts`, which is
 * under a shrinking-only source-size cap (new code is split by responsibility,
 * caps are never raised).
 */
export let UNSAVABLE_FEEDBACK: string;
localized(() => {
  UNSAVABLE_FEEDBACK = t('popup_browserPageCannotBookmarked', 'This browser page cannot be bookmarked.');
});

/**
 * Sync states that are either calm or already said elsewhere: the status line
 * names where a save went, and the avatar's dot marks what needs the user. The
 * note keeps only what is specific and actionable ("Action required",
 * "Review conflicts").
 */
const QUIET_KINDS: ReadonlySet<SyncStatusKind> = new Set(['paused', 'synced', 'syncing', 'setup-required', 'waiting-network', 'saved-locally', 'local-only']);

export interface PopupFeedbackPorts {
  readonly save: HTMLButtonElement;
  /** The Folder / Tags / Note rows, hidden when the page cannot be bookmarked. */
  readonly fields: HTMLElement;
  readonly note: PopupNote;
  readonly openNativeWait: HTMLButtonElement;
  /** Live tab URL; the popup re-reads it whenever savability is re-evaluated. */
  readonly currentTabUrl: () => string;
  /** True while a parked native wait is known to be actionable. */
  readonly nativeWaitPending: () => boolean;
}

export function createPopupFeedbackUi(ports: PopupFeedbackPorts) {
  function setFeedback(text: string, tone: '' | 'ok' | 'error' = ''): void {
    ports.note.set('feedback', text, tone === 'error' ? 'error' : '');
  }

  /** needsAttention (or a listed wait) is when the native-wait deep link is actionable. */
  function reflectNativeWaitLink(needed: boolean): void {
    setHidden(ports.openNativeWait, !needed && !ports.nativeWaitPending());
  }

  function paintStatus(status: SyncStatus): void {
    if (QUIET_KINDS.has(status.kind)) {
      ports.note.set('status', undefined);
      reflectNativeWaitLink(false);
      return;
    }
    ports.note.set('status', status.label, status.tone === 'attention' ? 'error' : '');
    reflectNativeWaitLink(status.kind === 'action-required');
  }

  function reflectSavable(): boolean {
    const savable = Boolean(ports.currentTabUrl()) && isSavableUrl(ports.currentTabUrl());
    /* Nothing is wrong and nothing can be done here: the button takes the
       popup's quiet disabled look (popup.css) instead of the dark primary
       slab that still reads as live, and the sentence is a fact, not an error. */
    document.body.toggleAttribute('data-unsavable', !savable);
    if (!savable) {
      ports.save.disabled = true;
      ports.fields.hidden = true;
      setFeedback(UNSAVABLE_FEEDBACK);
    }
    return savable;
  }

  return { setFeedback, paintStatus, reflectNativeWaitLink, reflectSavable };
}
