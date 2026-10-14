import { showAutomationBadge } from './action-badge.js';
import { BADGE_DANGER } from './badge-colors.js';
import { SAVE_SAVED_TO_BROWSER } from './save-status.js';
import { localized, t } from './i18n.js';

export const SAVE_FEEDBACK_CACHE = 'known.save.feedback.v1';
export const SAVE_FEEDBACK_BADGE = '!';
export let SAVE_FEEDBACK_PERMISSION: string, SAVE_FEEDBACK_CREATE_FAILED: string, SAVE_FEEDBACK_NO_PAGE: string, SAVE_FEEDBACK_NO_FOLDER: string;
localized(() => {
  SAVE_FEEDBACK_PERMISSION = t('save_allowBookmarkAccessSave', 'Allow bookmark access to save this page.');
  SAVE_FEEDBACK_CREATE_FAILED = t('save_couldntSaveBookmarkTry', "Couldn't save the bookmark. Try again.");
  SAVE_FEEDBACK_NO_PAGE = t('save_pageCannotSaved', 'This page cannot be saved.');
  SAVE_FEEDBACK_NO_FOLDER = t('save_savedBrowserSyncFolders', 'Saved to this browser. Sync folders are not ready, so this save stays on this device only.');
});
export const SAVE_FEEDBACK_TTL_MS = 5 * 60_000;

export type SaveFeedbackCode =
  | 'permission_required' | 'create_failed' | 'no_page' | 'saved' | 'no_folder' | 'busy';
export type SaveFeedbackEntry = 'page' | 'window' | 'popup';

export interface SaveFeedback {
  readonly code: SaveFeedbackCode;
  readonly message: string;
  readonly entry: SaveFeedbackEntry;
  readonly nativeId?: string;
  readonly updatedAt: number;
}

let COPY: Record<SaveFeedbackCode, string>;
localized(() => {
  COPY = {
    permission_required: SAVE_FEEDBACK_PERMISSION,
    create_failed: SAVE_FEEDBACK_CREATE_FAILED,
    no_page: SAVE_FEEDBACK_NO_PAGE,
    saved: SAVE_SAVED_TO_BROWSER,
    no_folder: SAVE_FEEDBACK_NO_FOLDER,
    busy: SAVE_FEEDBACK_CREATE_FAILED,
  };
});

export function saveFeedbackMessage(code: SaveFeedbackCode): string {
  return COPY[code];
}

export function parseSaveFeedback(value: unknown, now = Date.now()): SaveFeedback | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || !(record.code in COPY)) return undefined;
  if (typeof record.message !== 'string' || record.message.length === 0) return undefined;
  if (record.entry !== 'page' && record.entry !== 'window' && record.entry !== 'popup') return undefined;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return undefined;
  if (now - record.updatedAt > SAVE_FEEDBACK_TTL_MS) return undefined;
  if (record.nativeId !== undefined && (typeof record.nativeId !== 'string' || record.nativeId.length === 0)) {
    return undefined;
  }
  return {
    code: record.code as SaveFeedbackCode, message: record.message, entry: record.entry,
    updatedAt: record.updatedAt,
    ...(typeof record.nativeId === 'string' ? { nativeId: record.nativeId } : {}),
  };
}

export async function readSaveFeedback(now = Date.now()): Promise<SaveFeedback | undefined> {
  try {
    return parseSaveFeedback((await chrome.storage.local.get(SAVE_FEEDBACK_CACHE))[SAVE_FEEDBACK_CACHE], now);
  } catch { return undefined; }
}

export async function writeSaveFeedback(input: Omit<SaveFeedback, 'updatedAt' | 'message'> & {
  readonly message?: string; readonly now?: number;
}): Promise<SaveFeedback> {
  const feedback: SaveFeedback = {
    code: input.code, message: input.message ?? saveFeedbackMessage(input.code), entry: input.entry,
    updatedAt: input.now ?? Date.now(),
    ...(input.nativeId ? { nativeId: input.nativeId } : {}),
  };
  try { await chrome.storage.local.set({ [SAVE_FEEDBACK_CACHE]: feedback }); } catch { /* best-effort */ }
  return feedback;
}

export async function clearSaveFeedback(): Promise<void> {
  try { await chrome.storage.local.remove(SAVE_FEEDBACK_CACHE); } catch { /* best-effort */ }
}

export function saveFeedbackIsError(code: SaveFeedbackCode): boolean {
  return code === 'permission_required' || code === 'create_failed' || code === 'no_page';
}

/** Badge + persisted copy. The badge invites the user to open the popup, which
 *  carries the grant control; options is never force-opened over their work.
 *  Without a problem the badge goes back to the automation count (action-badge.ts). */
export async function presentSaveFeedback(input: Omit<SaveFeedback, 'updatedAt' | 'message'> & {
  readonly message?: string; readonly now?: number;
}): Promise<SaveFeedback> {
  const feedback = await writeSaveFeedback(input);
  try {
    if (saveFeedbackIsError(feedback.code)) {
      await chrome.action.setBadgeText({ text: SAVE_FEEDBACK_BADGE });
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_DANGER });
      await chrome.action.setTitle({ title: feedback.message });
    } else {
      await showAutomationBadge({ title: false });
      await chrome.action.setTitle({ title: feedback.message });
    }
  } catch { /* Badge is sugar; the persisted copy still reaches popup/options. */ }
  return feedback;
}
