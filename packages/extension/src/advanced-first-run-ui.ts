import type {
  AdvancedFirstRunConfirmation, FirstRunPreviewOk, FirstRunPreviewRequest, FirstRunConfirmRequest,
} from './types.js';
import { localized, listCopy, t, tn } from './i18n.js';

export type AdvancedUiMode = 'merge' | 'upload' | 'download' | 'preview-only';
export type AdvancedDestructiveMode = Exclude<AdvancedUiMode, 'merge' | 'preview-only'>;

export let ADVANCED_MODE_LABELS: Readonly<Record<AdvancedUiMode, string>>;
localized(() => {
  ADVANCED_MODE_LABELS = Object.freeze({
  merge: t('firstRun_autoMergeKeepBoth', 'Auto-merge, keep both sides (recommended)'),
  upload: t('firstRun_deviceWins', 'This device wins'),
  download: t('firstRun_knowNWins', 'Know-N wins'),
  'preview-only': t('firstRun_previewOnlyDoNot', 'Preview only, do not run'),
});
});

export let ADVANCED_MODE_HINTS: Readonly<Record<AdvancedUiMode, string>>;
localized(() => {
  ADVANCED_MODE_HINTS = Object.freeze({
  merge: t('firstRun_itemsBothSidesKept', 'Items on both sides are kept. Unmatched items are kept as two copies.'),
  upload: t('firstRun_syncedFoldersItemsExist', "In the synced folders, items that exist only in your library are listed. After you confirm, they move to your library's trash."),
  download: t('firstRun_syncedFoldersItemsExist2', 'In the synced folders, items that exist only in this browser are listed. After you confirm, they are removed from this browser.'),
  'preview-only': t('firstRun_buildsMatchDeletionLists', 'Builds the match and deletion lists only. No run is created and nothing is applied.'),
});
});

export let PREVIEW_ONLY_GUIDANCE: string, PREVIEW_ONLY_SWITCH_LABEL: string;
localized(() => {
  PREVIEW_ONLY_GUIDANCE = t('firstRun_previewFinishedSwitchAuto', 'Preview finished. Switch to auto-merge to start sync.');
  PREVIEW_ONLY_SWITCH_LABEL = t('firstRun_switchAutoMergeSync', 'Switch to auto-merge and sync');
});

export function advancedModeLabel(mode: AdvancedUiMode): string {
  return ADVANCED_MODE_LABELS[mode];
}

export function advancedModeHint(mode: AdvancedUiMode): string {
  return ADVANCED_MODE_HINTS[mode];
}

export function advancedPreviewRequest(input: {
  readonly viewId: string; readonly selectedRefs: readonly string[]; readonly excludedRefs: readonly string[];
  readonly mode: AdvancedUiMode;
}): FirstRunPreviewRequest {
  return { kind: 'known.firstRun.preview', viewId: input.viewId, selectedRefs: input.selectedRefs,
    excludedRefs: input.excludedRefs, bootstrapMode: input.mode === 'preview-only' ? 'merge' : input.mode };
}

export function advancedConfirmationRequest(input: {
  readonly previewId: string; readonly confirmationId: string; readonly libraryId: string;
  readonly confirmation: AdvancedFirstRunConfirmation;
}): FirstRunConfirmRequest {
  const { scopeFingerprint, treeDigest, mode, remoteSnapshotId, remoteRevision, remoteCursor,
    destructivePlanDigest, confirmationProof } = input.confirmation;
  return { kind: 'known.firstRun.confirm', previewId: input.previewId, confirmationId: input.confirmationId,
    libraryId: input.libraryId, bootstrapMode: input.confirmation.mode,
    advancedConfirmation: { scopeFingerprint, treeDigest, mode, remoteSnapshotId, remoteRevision, remoteCursor,
      destructivePlanDigest, confirmationProof } };
}

export function isAdvancedDestructiveMode(mode: AdvancedUiMode): mode is AdvancedDestructiveMode {
  return mode === 'upload' || mode === 'download';
}

export function advancedConfirmationReady(mode: AdvancedUiMode, preview: FirstRunPreviewOk | undefined): boolean {
  return isAdvancedDestructiveMode(mode) && preview?.advanced !== undefined
    && preview.advanced.mode === mode;
}

export function advancedDeleteLabel(item: {
  readonly side: 'local' | 'remote'; readonly title?: string; readonly kind?: string;
}): string {
  const side = item.side === 'local' ? t('firstRun_sideBrowser', 'Browser') : 'Know-N';
  const kind = item.kind === 'folder' ? t('sync_folderLower', 'folder') : item.kind === 'bookmark' ? t('firstRun_kindBookmark', 'bookmark') : t('firstRun_kindItem', 'item');
  return `${side} · ${kind} · ${item.title?.trim() || t('firstRun_untitledItem', 'Untitled item')}`;
}

export function advancedConfirmLabel(deleteCount: number): string {
  return deleteCount > 0 ? t('firstRun_confirmListRun', 'Confirm the list and run') : t('firstRun_confirmRun', 'Confirm and run');
}

export function advancedPreviewSummary(report: {
  readonly matched: number; readonly localOnly: number; readonly remoteOnly: number;
  readonly candidates: number; readonly conflicts: number;
}): string {
  return t('firstRun_advancedSummary', '$1.', listCopy([tn('firstRun_matchedItems', report.matched, '$1 matched item', '$1 matched items'),
    tn('firstRun_localOnlyItems', report.localOnly, '$1 item only on this device', '$1 items only on this device'),
    tn('firstRun_remoteOnlyItems', report.remoteOnly, '$1 item only in your library', '$1 items only in your library'),
    tn('firstRun_duplicateCandidates', report.candidates, '$1 duplicate candidate', '$1 duplicate candidates'),
    tn('firstRun_conflicts', report.conflicts, '$1 conflict', '$1 conflicts')]));
}

export function advancedPreviewHasNativeId(value: unknown): boolean {
  try { return JSON.stringify(value).includes('nativeId'); } catch { return true; }
}

export function selectionFingerprint(input: {
  readonly viewId: string; readonly selectedRefs: readonly string[]; readonly excludedRefs: readonly string[];
  readonly libraryId: string | undefined; readonly mode: AdvancedUiMode;
}): string {
  return JSON.stringify({ viewId: input.viewId, selectedRefs: [...input.selectedRefs].sort(),
    excludedRefs: [...input.excludedRefs].sort(), libraryId: input.libraryId ?? null, mode: input.mode });
}
