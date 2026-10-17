import type {
  FirstRunConfirmRequest, FirstRunDurablePhase, FirstRunOrScopeResponse, FirstRunPreviewOk, FirstRunScopeState,
  PublicAttentionSummary, PublicRootNode, PublicRootView,
} from './types.js';
import { localized, listCopy, t, tn } from './i18n.js';

export const FIRST_RUN_DRAFT = 'known.firstRun.draft.v1';

export let FIRST_RUN_INTRO: string, BOOKMARK_PERMISSION_ACTION: string, FIRST_RUN_PERMISSION_ACTION: string, FIRST_RUN_PERMISSION_HINT: string, FIRST_RUN_START: string, FIRST_RUN_LATER: string, FIRST_RUN_MERGE_COPY: string, FIRST_RUN_KEEP_COPY: string, FIRST_RUN_RANGE_HEADING: string, FIRST_RUN_ENGINE_NOT_READY: string, FIRST_RUN_SYNC_PAUSED: string, FIRST_RUN_LIBRARY_REQUIRED: string, FIRST_RUN_UNSYNCED: string, FIRST_RUN_LOCAL_ONLY: string, FIRST_RUN_SYNCING: string, FIRST_RUN_SYNCED: string, FIRST_RUN_ACTION_REQUIRED: string, FIRST_RUN_REVIEW_CONFLICTS: string, FIRST_RUN_IMPORT_ISSUES: string, FIRST_RUN_NEEDS_ATTENTION: string, FIRST_RUN_VIEW_ATTENTION: string, FIRST_RUN_KEEP_BOTH: string, FIRST_RUN_CONFLICT_CENTER: string, FIRST_RUN_WAIT_NETWORK: string, FIRST_RUN_SYNC_RETRYING: string, FIRST_RUN_MANAGED_REASON: string;
localized(() => {
  FIRST_RUN_INTRO = t('firstRun_wholeTreeIntro', 'Choose folders to sync. You can select a subfolder without selecting its parent.');
  BOOKMARK_PERMISSION_ACTION = t('common_allowBookmarkAccess', 'Allow bookmark access');
  FIRST_RUN_PERMISSION_ACTION = BOOKMARK_PERMISSION_ACTION;
  FIRST_RUN_PERMISSION_HINT = t('firstRun_readWholeTree', 'Allow bookmark access, then choose which folders to sync.');
  FIRST_RUN_START = t('firstRun_startFirstSync', 'Start first sync');
  FIRST_RUN_LATER = t('common_later', 'Later');
  FIRST_RUN_MERGE_COPY = t('firstRun_mergeLibrary', 'Bookmarks on this browser and in your library are merged. Existing bookmarks are kept. Unmatched items remain as separate copies.');
  FIRST_RUN_KEEP_COPY = t('firstRun_existingBrowserBookmarksNot', 'Existing browser bookmarks are not deleted. Items that cannot be identified are kept as two copies.');
  FIRST_RUN_RANGE_HEADING = t('firstRun_syncBrowserBookmarks', "Sync this browser's bookmarks");
  FIRST_RUN_ENGINE_NOT_READY = t('firstRun_syncNotReadyYet', 'Sync is not ready yet');
  FIRST_RUN_SYNC_PAUSED = t('firstRun_syncPausedChangesAlready', 'Sync is paused. Changes already sent will still finish uploading.');
  FIRST_RUN_LIBRARY_REQUIRED = t('firstRun_connectingLibrary', 'Connecting to your bookmark library…');
  FIRST_RUN_UNSYNCED = t('sync_notSynced', 'Sync is off');
  FIRST_RUN_LOCAL_ONLY = t('sync_stayLocal', 'No Know-N sync');
  FIRST_RUN_SYNCING = t('common_syncing', 'Syncing');
  FIRST_RUN_SYNCED = t('common_synced', 'Synced');
  FIRST_RUN_ACTION_REQUIRED = t('sync_actionRequired', 'Action required');
  FIRST_RUN_REVIEW_CONFLICTS = t('sync_reviewConflicts', 'Review conflicts');
  FIRST_RUN_IMPORT_ISSUES = t('sync_importIssues', 'Import issues');
  FIRST_RUN_NEEDS_ATTENTION = FIRST_RUN_ACTION_REQUIRED;
  FIRST_RUN_VIEW_ATTENTION = t('firstRun_viewItemsNeedAttention', 'View items that need attention');
  FIRST_RUN_KEEP_BOTH = t('firstRun_keepBoth', 'Keep both');
  FIRST_RUN_CONFLICT_CENTER = t('firstRun_reviewConflictsSyncCenter', 'Review conflicts in Sync center on the web');
  FIRST_RUN_WAIT_NETWORK = t('sync_waitingNetwork', 'Waiting for network');
  FIRST_RUN_SYNC_RETRYING = t('sync_errorRetrying', 'Sync error, retrying');
  FIRST_RUN_MANAGED_REASON = t('firstRun_managedBrowserPolicyDevice', 'Managed by browser policy. This device cannot change it, so it does not sync');
});

export interface FirstRunDraftPick {
  readonly ref: string;
  readonly kind: PublicRootNode['kind'];
  readonly title: string;
  readonly depth: number;
}

export interface FirstRunDraft {
  readonly selected: readonly FirstRunDraftPick[];
  readonly excluded?: readonly FirstRunDraftPick[];
  readonly libraryId?: string;
  readonly deferred: boolean;
  readonly previewId?: string;
  readonly treeDigest?: string;
  readonly bookmarkCount?: number;
  readonly folderCount?: number;
  readonly skippedCount?: number;
}

export function parseFirstRunDraft(value: unknown): FirstRunDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.deferred !== 'boolean' || !Array.isArray(record.selected)) return undefined;
  const picks = (items: unknown): FirstRunDraftPick[] | undefined => {
  if (!Array.isArray(items)) return undefined;
  const selected: FirstRunDraftPick[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const row = item as Record<string, unknown>;
    if (row.kind !== 'bookmarks_bar' && row.kind !== 'other' && row.kind !== 'mobile' && row.kind !== 'folder') {
      return undefined;
    }
    if (typeof row.ref !== 'string' || !row.ref || row.ref.length > 128) return undefined;
    if (typeof row.title !== 'string' || typeof row.depth !== 'number' || !Number.isInteger(row.depth) || row.depth < 0) {
      return undefined;
    }
    selected.push({ ref: row.ref, kind: row.kind, title: row.title, depth: row.depth });
  }
  return selected;
  };
  const selected = picks(record.selected), excluded = record.excluded === undefined ? [] : picks(record.excluded);
  if (!selected || !excluded) return undefined;
  const libraryId = record.libraryId;
  const previewId = record.previewId;
  const treeDigest = record.treeDigest;
  if (libraryId !== undefined && (typeof libraryId !== 'string' || libraryId.length === 0)) return undefined;
  if (previewId !== undefined && (typeof previewId !== 'string' || previewId.length === 0)) return undefined;
  if (treeDigest !== undefined && (typeof treeDigest !== 'string' || treeDigest.length === 0)) return undefined;
  const bookmarkCount = optionalCount(record.bookmarkCount);
  const folderCount = optionalCount(record.folderCount);
  const skippedCount = optionalCount(record.skippedCount);
  if (bookmarkCount === false || folderCount === false || skippedCount === false) return undefined;
  return {
    selected, excluded, deferred: record.deferred,
    ...(libraryId ? { libraryId } : {}),
    ...(previewId ? { previewId } : {}),
    ...(treeDigest ? { treeDigest } : {}),
    ...(bookmarkCount !== undefined ? { bookmarkCount } : {}),
    ...(folderCount !== undefined ? { folderCount } : {}),
    ...(skippedCount !== undefined ? { skippedCount } : {}),
  };
}

function optionalCount(value: unknown): number | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return false;
  return value;
}

export async function readFirstRunDraft(): Promise<FirstRunDraft | undefined> {
  try {
    return parseFirstRunDraft((await chrome.storage.local.get(FIRST_RUN_DRAFT))[FIRST_RUN_DRAFT]);
  } catch {
    return undefined;
  }
}

export async function writeFirstRunDraft(draft: FirstRunDraft): Promise<void> {
  try { await chrome.storage.local.set({ [FIRST_RUN_DRAFT]: draft }); } catch { /* Draft is best-effort. */ }
}

export function firstRunIncomplete(firstRun: FirstRunScopeState | undefined): boolean {
  return firstRun !== 'completed' && firstRun !== 'running';
}

export function firstRunOnboardingActive(firstRun: FirstRunScopeState | undefined): boolean {
  return firstRun === undefined || firstRun === 'none' || firstRun === 'deferred' || firstRun === 'running';
}

export type FirstRunSurface = 'hide' | 'attention' | 'syncing' | 'onboarding';

export function projectFirstRunSurface(input: {
  readonly firstRun?: FirstRunScopeState;
  readonly phase?: FirstRunDurablePhase;
  readonly attention?: PublicAttentionSummary;
}): FirstRunSurface {
  if (input.phase === 'needs_attention' || (input.attention && input.attention.pendingCount > 0)) return 'attention';
  if (input.firstRun === 'completed' || input.phase === 'completed') return 'hide';
  if (input.firstRun === 'running' || input.phase === 'confirmed' || input.phase === 'scanning'
      || input.phase === 'matching' || input.phase === 'syncing') {
    return 'syncing';
  }
  return 'onboarding';
}

export function shouldDefaultPreselect(input: {
  readonly managed: boolean; readonly depth: number;
  readonly bookmarkCount: number; readonly folderCount: number;
  readonly firstRun: FirstRunScopeState | undefined; readonly hasCommittedSelection: boolean;
}): boolean {
  if (input.managed || input.hasCommittedSelection || !firstRunIncomplete(input.firstRun)) return false;
  return input.depth === 0;
}

export function specialRootLabel(kind: PublicRootNode['kind']): string {
  if (kind === 'bookmarks_bar') return t('sync_bookmarksBar', 'Bookmarks bar');
  if (kind === 'other') return t('sync_otherBookmarks', 'Other bookmarks');
  if (kind === 'mobile') return t('sync_mobileBookmarks', 'Mobile bookmarks');
  return t('sync_folder', 'Folder');
}

export function folderCountCopy(root: Pick<PublicRootNode, 'bookmarkCount' | 'folderCount' | 'managed'>): string {
  if (root.managed) return FIRST_RUN_MANAGED_REASON;
  const bookmarks = tn('common_bookmarks', root.bookmarkCount, '$1 bookmark', '$1 bookmarks');
  return root.folderCount === 0 ? bookmarks : `${bookmarks} · ${tn('common_folders', root.folderCount, '$1 folder', '$1 folders')}`;
}

export function folderMetaCopy(root: Pick<PublicRootNode, 'managed' | 'kind' | 'exclusionReason'>): string {
  if (root.managed || root.exclusionReason === 'managed') return FIRST_RUN_MANAGED_REASON;
  return specialRootLabel(root.kind);
}

export function firstRunTotalsCopy(bookmarkCount: number, folderCount: number): string {
  return t('firstRun_willSyncTotals', 'Will sync: $1, $2', tn('common_bookmarks', bookmarkCount, '$1 bookmark', '$1 bookmarks'), tn('common_folders', folderCount, '$1 folder', '$1 folders'));
}

export function draftPicksFromView(view: PublicRootView, selectedRefs: ReadonlySet<string>): FirstRunDraftPick[] {
  return view.roots.filter((root) => selectedRefs.has(root.ref))
    .map((root) => ({ ref: root.ref, kind: root.kind, title: root.title, depth: root.depth }));
}

export function restoreDraftSelection(view: PublicRootView, draft: FirstRunDraft | undefined): Set<string> {
  const selected = new Set<string>();
  if (!draft) {
    for (const root of view.roots) {
      if (root.selected) selected.add(root.ref);
    }
    return selected;
  }
  const unused = draft.selected.map((pick) => ({ ...pick }));
  for (const root of view.roots) {
    const index = unused.findIndex((pick) => pick.ref === root.ref);
    if (index >= 0) {
      selected.add(root.ref);
      unused.splice(index, 1);
    }
  }
  return selected;
}

export function collectPreviewSelection(view: PublicRootView, checkedRefs: ReadonlySet<string>, excluded: ReadonlySet<string> = new Set()): {
  readonly selectedRefs: readonly string[]; readonly excludedRefs: readonly string[];
} {
  const selectedRefs = view.roots.filter((root) => checkedRefs.has(root.ref) && !root.managed).map((root) => root.ref);
  return { selectedRefs, excludedRefs: view.roots.filter(root => excluded.has(root.ref) && !root.managed).map(root => root.ref) };
}

export function buildFirstRunConfirm(input: {
  readonly previewId: string; readonly libraryId: string; readonly confirmationId: string;
}): FirstRunConfirmRequest {
  return {
    kind: 'known.firstRun.confirm', previewId: input.previewId, confirmationId: input.confirmationId,
    libraryId: input.libraryId,
  };
}

export function confirmFailureCopy(response: FirstRunOrScopeResponse): string {
  if (response.ok) return '';
  if (response.error === 'not_implemented') return FIRST_RUN_ENGINE_NOT_READY;
  if (response.error === 'preview_stale') return t('firstRun_bookmarkFoldersChangedReview', 'Bookmark folders changed. Review the change list again before confirming.');
  if (response.error === 'permission_required') return t('firstRun_permissionNotGrantedCan', 'Permission was not granted. You can try again later.');
  if (response.error === 'not_connected') return t('firstRun_connectLibraryFirst', 'Connect to your bookmark library before starting sync.');
  if (response.error === 'sync_paused') return FIRST_RUN_SYNC_PAUSED;
  if (response.error === 'bootstrap_confirmation_required') return t('firstRun_reviewConfirmChangeList', 'Review and confirm the change list first.');
  if (response.error === 'bootstrap_confirmation_stale') {
    return t('firstRun_changeListOutDate', 'The change list is out of date. Review it again before confirming.');
  }
  if (response.error === 'bootstrap_snapshot_required') return t('firstRun_knowNVersionNot', 'The Know-N version is not available yet. Refresh the change list and try again.');
  return t('firstRun_couldNotStartSync', 'Could not start sync. Try again in a moment.');
}

export function popupFirstRunStatus(input: {
  readonly connected: boolean; readonly firstRun: FirstRunScopeState | undefined;
  readonly deferredDraft: boolean;
  readonly phase?: FirstRunDurablePhase;
  readonly attention?: PublicAttentionSummary;
  readonly engine?: { readonly phase: string; readonly hasPendingWork: boolean; readonly conflictPending?: boolean;
    readonly errorCode?: string };
}): import('./sync-status.js').SyncStatusKind {
  if (!input.connected) return 'signed-out';
  if (projectFirstRunSurface(input) === 'attention') {
    return input.attention && input.attention.conflictCount > 0 ? 'review-conflicts' : 'action-required';
  }
  if (input.firstRun === 'running') return 'syncing';
  const incomplete = firstRunIncomplete(input.firstRun) || input.deferredDraft;
  if (incomplete) return 'setup-required';
  const engine = input.engine;
  if (!engine) return 'syncing';
  if (engine.conflictPending) return 'review-conflicts';
  // The engine parks every retried failure in its offline phase; only a
  // transport failure is a network wait, the rest is a server or local error.
  if (engine.phase === 'offline') {
    return engine.errorCode === undefined || engine.errorCode === 'network_unavailable'
      ? 'waiting-network' : 'retrying';
  }
  if (engine.phase === 'recovery' || engine.phase === 'bootstrap' || engine.hasPendingWork) return 'syncing';
  return 'synced';
}

export function attentionStatusCopy(summary: PublicAttentionSummary): string {
  const prefix = summary.conflictCount > 0 ? FIRST_RUN_REVIEW_CONFLICTS : FIRST_RUN_ACTION_REQUIRED;
  const countParts = [summary.candidateCount ? tn('firstRun_duplicates', summary.candidateCount, '$1 duplicate', '$1 duplicates') : '', summary.conflictCount ? tn('firstRun_conflicts', summary.conflictCount, '$1 conflict', '$1 conflicts') : ''].filter(Boolean);
  const waiting = tn('firstRun_itemsWaiting', summary.pendingCount, '$1 item waiting', '$1 items waiting');
  return countParts.length ? t('firstRun_attentionStatusDetail', '$1: $2 ($3).', prefix, waiting, listCopy(countParts)) : t('firstRun_attentionStatus', '$1: $2.', prefix, waiting);
}

export function attentionItemCopy(item: { readonly kind: 'duplicate_candidate' | 'conflict';
  readonly locationCount: number; readonly decision: 'open' | 'keep_both' }): string {
  const label = item.kind === 'duplicate_candidate' ? t('firstRun_duplicateCandidate', 'Duplicate candidate') : t('firstRun_contentConflict', 'Content conflict');
  return `${label} · ${item.decision === 'keep_both' ? t('firstRun_bothKept', 'both kept') : tn('firstRun_places', item.locationCount, '$1 place', '$1 places')}`;
}

export function applyPreviewToDraft(draft: FirstRunDraft, preview: FirstRunPreviewOk): FirstRunDraft {
  return {
    ...draft, previewId: preview.previewId, treeDigest: preview.treeDigest,
    bookmarkCount: preview.bookmarkCount, folderCount: preview.folderCount, skippedCount: preview.skippedCount,
  };
}

export function emptyPreviewRoots(view: PublicRootView): boolean {
  return view.roots.length === 0;
}

export function onlyManagedRoots(view: PublicRootView): boolean {
  return view.roots.length > 0 && view.roots.every((root) => root.managed || root.exclusionReason === 'managed');
}

export function canStartFirstSync(input: {
  readonly libraryId: string | undefined; readonly preview: FirstRunPreviewOk | undefined;
  readonly view: PublicRootView | undefined; readonly selectedCount: number;
}): boolean {
  if (!input.libraryId || !input.preview || !input.view) return false;
  if (emptyPreviewRoots(input.view) || onlyManagedRoots(input.view)) return false;
  return input.selectedCount > 0;
}
