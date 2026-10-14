import {
  FIRST_RUN_ACTION_REQUIRED, FIRST_RUN_LOCAL_ONLY, FIRST_RUN_NEEDS_ATTENTION,
  FIRST_RUN_REVIEW_CONFLICTS, FIRST_RUN_SYNCED, FIRST_RUN_SYNCING,
  FIRST_RUN_UNSYNCED, FIRST_RUN_WAIT_NETWORK,
} from './first-run-draft.js';
import { localized, t } from './i18n.js';
import type { SyncStatusKind } from './sync-status.js';
import type { CaptureAutomation } from './capture/contracts.js';

export let SAVE_SAVED_TO_BROWSER: string;
localized(() => {
  SAVE_SAVED_TO_BROWSER = t('save_savedBrowser', 'Saved to this browser');
});
export const SAVE_LAST_CACHE = 'known.save.last.v1';

export type SaveStatusPaint = 'local' | 'projected';

/** Read-only facts from run/queue/receipt/apply stores. Not a queue state machine. */
export interface SaveStatusFacts {
  readonly paint: SaveStatusPaint;
  readonly localCreateSucceeded: boolean;
  readonly inSyncRange: boolean;
  readonly firstRunIncomplete: boolean;
  readonly online: boolean;
  readonly pendingWork: boolean;
  readonly needsAttention: boolean;
  readonly hasConflict?: boolean;
  readonly hasAuthoritativeReceipt: boolean;
  readonly hasApplyEvidence: boolean;
  readonly enhancementFailed?: boolean;
}

export interface LastSaveRecord {
  readonly nativeId: string;
  readonly parentNativeId?: string;
  readonly localOnly: boolean;
  readonly collectionId?: string;
  readonly updatedAt: number;
}

export function projectSaveStatus(facts: SaveStatusFacts): SyncStatusKind {
  void facts.enhancementFailed;
  if (facts.paint === 'local' && facts.localCreateSucceeded) return 'saved-locally';
  if (!facts.inSyncRange || facts.firstRunIncomplete) {
    return facts.firstRunIncomplete ? 'setup-required' : 'local-only';
  }
  if (facts.hasConflict) return 'review-conflicts';
  if (facts.needsAttention) return 'action-required';
  if (!facts.online && facts.pendingWork) return 'waiting-network';
  if (facts.pendingWork) return 'syncing';
  const authoritative = facts.hasAuthoritativeReceipt || facts.hasApplyEvidence;
  if (authoritative) return 'synced';
  return 'syncing';
}

/**
 * The one line a save shows about its rules, wherever it was saved from (popup,
 * result panel, context menu, Save tabs). `attention`: a rule matched but could
 * not act, so the page stayed where it was saved.
 */
export function automationSaveLine(automation: CaptureAutomation | undefined): { readonly text: string; readonly attention: boolean } | null {
  if (!automation) return null;
  const name = automation.rule.name;
  switch (automation.outcome) {
    case 'placed': return { attention: false, text: t('automation_savedByRule', 'Saved to $1 by rule “$2”.', automation.folderTitle ?? '', name) };
    case 'kept': return { attention: false, text: t('automation_keptYourFolder', 'Kept the folder you chose; rule “$1” didn’t move it.', name) };
    case 'blocked': return { attention: true, text: automation.reason === 'evaluation'
      ? t('automation_ruleNotChecked', 'Rule “$1” couldn’t be checked, so the page stayed where you saved it.', name)
      : t('automation_ruleFolderUnavailable', 'Rule “$1” matched, but its folder isn’t in this browser, so the page stayed where you saved it.', name) };
    case 'conflict': return { attention: true, text: t('automation_rulesDisagree', 'Rules chose different folders for this page, so it stayed where you saved it.') };
    case 'review': return { attention: true, text: t('automation_ruleNeedsReview', 'Rule “$1” needs a review on the web, so the page stayed where you saved it.', name) };
    case 'expired': return { attention: true, text: t('automation_rulesOutOfDateSaved', 'Rules are out of date; connect to refresh. The page stayed where you saved it.') };
  }
}

/** The notice for a bookmark created outside Know-N (star button): a placement is a move, so it says so. */
export function observedSaveLine(automation: CaptureAutomation, title: string): { readonly text: string; readonly attention: boolean } | null {
  if (automation.outcome !== 'placed') return automationSaveLine(automation);
  const short = title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title;
  return { attention: false, text: t('automation_movedByRule', 'Moved “$1” to $2 by rule “$3”.', short, automation.folderTitle ?? '', automation.rule.name) };
}

export function mappingLooksAuthoritative(mapping: {
  readonly colpId: string; readonly projection: { readonly revision: string };
} | null | undefined): boolean {
  if (!mapping) return false;
  return !mapping.colpId.startsWith('pending-') && !mapping.projection.revision.startsWith('local-');
}

export function parseLastSave(value: unknown): LastSaveRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.nativeId !== 'string' || record.nativeId.length === 0) return undefined;
  if (typeof record.localOnly !== 'boolean') return undefined;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return undefined;
  if (record.parentNativeId !== undefined && typeof record.parentNativeId !== 'string') return undefined;
  if (record.collectionId !== undefined && typeof record.collectionId !== 'string') return undefined;
  return {
    nativeId: record.nativeId, localOnly: record.localOnly, updatedAt: record.updatedAt,
    ...(typeof record.parentNativeId === 'string' && record.parentNativeId ? { parentNativeId: record.parentNativeId } : {}),
    ...(typeof record.collectionId === 'string' && record.collectionId ? { collectionId: record.collectionId } : {}),
  };
}

export async function readLastSave(): Promise<LastSaveRecord | undefined> {
  try { return parseLastSave((await chrome.storage.local.get(SAVE_LAST_CACHE))[SAVE_LAST_CACHE]); }
  catch { return undefined; }
}

export async function writeLastSave(input: Omit<LastSaveRecord, 'updatedAt'>): Promise<void> {
  try {
    await chrome.storage.local.set({ [SAVE_LAST_CACHE]: { ...input, updatedAt: Date.now() } });
  } catch { /* Last-save memory is best-effort; status can still be recovered from IndexedDB. */ }
}

export {
  FIRST_RUN_ACTION_REQUIRED, FIRST_RUN_LOCAL_ONLY, FIRST_RUN_NEEDS_ATTENTION,
  FIRST_RUN_REVIEW_CONFLICTS, FIRST_RUN_SYNCED, FIRST_RUN_SYNCING,
  FIRST_RUN_UNSYNCED, FIRST_RUN_WAIT_NETWORK,
};
