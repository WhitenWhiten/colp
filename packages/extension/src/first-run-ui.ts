import { paintPreviewTotals } from './first-run-preview-copy.js';
import {
  FIRST_RUN_ENGINE_NOT_READY,
  FIRST_RUN_INTRO, FIRST_RUN_KEEP_COPY, FIRST_RUN_LATER, FIRST_RUN_LIBRARY_REQUIRED, FIRST_RUN_MERGE_COPY,
  FIRST_RUN_NEEDS_ATTENTION, FIRST_RUN_PERMISSION_ACTION, FIRST_RUN_PERMISSION_HINT, FIRST_RUN_RANGE_HEADING,
  FIRST_RUN_START, FIRST_RUN_SYNCING, FIRST_RUN_UNSYNCED, FIRST_RUN_VIEW_ATTENTION,
  applyPreviewToDraft, attentionStatusCopy, buildFirstRunConfirm, canStartFirstSync, collectPreviewSelection,
  confirmFailureCopy, draftPicksFromView, firstRunOnboardingActive, folderCountCopy,
  folderMetaCopy, onlyManagedRoots, popupFirstRunStatus, projectFirstRunSurface, readFirstRunDraft,
  restoreDraftSelection, writeFirstRunDraft, type FirstRunDraft,
} from './first-run-draft.js';
import { renderAttentionItems, renderAttentionNavigation, setAttentionConflictLink } from './first-run-attention-ui.js';
import {
  advancedConfirmLabel, advancedConfirmationReady, advancedConfirmationRequest, advancedDeleteLabel,
  advancedModeHint, advancedPreviewRequest, advancedPreviewSummary, type AdvancedUiMode, selectionFingerprint,
  PREVIEW_ONLY_GUIDANCE, PREVIEW_ONLY_SWITCH_LABEL,
} from './advanced-first-run-ui.js';
import { syncRootRefs, excludedFolderRefs, replaceFolderSelection, ROOTS_REPAINT } from './folder-coverage.js';
import { createFirstRunPreviewSession } from './first-run-preview-session.js';
import { observeFirstRunResponse, type FirstRunObservation } from './first-run-observation.js';
import { rejectedWorkCopy, syncAttentionTerminalCode, terminalFreezeReasonCopy } from './sync-attention-ui.js';
import type {
  FirstRunOrScopeResponse, FirstRunRequest, PublicRootView,
} from './types.js'; import { t } from './i18n.js';

export {
  FIRST_RUN_INTRO, FIRST_RUN_PERMISSION_ACTION, folderCountCopy, folderMetaCopy,
  popupFirstRunStatus,
};

const COLLECTION_BINDING = 'known.sync.collection.v1';
const PREVIEW_WAIT_MS = 180;
const STATUS_POLL_MS = 1_000;
const STATUS_POLL_MAX_MS = 90_000;

interface FirstRunUiHost {
  readonly rootTree: HTMLElement;
  readonly saveRoots: HTMLButtonElement;
  readonly requestPermission: HTMLButtonElement;
  readonly folderHeading: HTMLElement;
  readonly folderIntro: HTMLElement;
  readonly serverLabel?: () => string;
  readonly showPane: (pane: 'account' | 'folders') => void;
  readonly onSyncStatusChanged?: () => void;
}

export function bindFirstRunOnboarding(host: FirstRunUiHost): {
  isRangeActive(): boolean;
  onRootsRendered(view: PublicRootView, connected: boolean, hasLibrary: boolean): void;
  setLibraryId(id: string | undefined): void;
  onSignedIn(connected: boolean, hasLibrary: boolean): void;
  onPermissionResult(granted: boolean): void;
} {
  const confirm = required('first-run-confirm');
  const totals = required('first-run-totals');
  const mergeCopy = required('first-run-merge-copy');
  const keepCopy = document.getElementById('first-run-keep-copy');
  const error = required('first-run-error');
  const attentionHost = required('first-run-attention');
  const viewAttention = required('first-run-view-attention') as HTMLButtonElement;
  const attentionList = required('first-run-attention-list');
  const conflictLink = required('first-run-conflict-link');
  const later = required('first-run-later') as HTMLButtonElement;
  const start = required('first-run-start') as HTMLButtonElement;
  const permissionHint = required('first-run-permission-hint');
  const empty = required('first-run-empty');
  const advancedPanel = required('first-run-advanced') as HTMLDetailsElement;
  const advancedModeSelect = required('first-run-advanced-mode') as HTMLSelectElement;
  const advancedHint = required('first-run-advanced-hint');
  const advancedPreviewButton = required('first-run-advanced-preview') as HTMLButtonElement;
  const deleteList = required('first-run-delete-list') as HTMLUListElement;
  const advancedConfirm = required('first-run-advanced-confirm') as HTMLButtonElement;
  /* One alert line: hidden when empty, amber for a problem, neutral for a progress note. */
  const say = (message?: string, tone: 'info' | 'warning' = 'warning'): void => {
    error.hidden = message === undefined; error.textContent = message ?? '';
    const box = error.parentElement;
    if (box?.classList.contains('inline-alert')) { if (tone === 'info') delete box.dataset.tone; else box.dataset.tone = 'warning'; }
  };
  mergeCopy.textContent = FIRST_RUN_MERGE_COPY;
  if (keepCopy) keepCopy.textContent = FIRST_RUN_KEEP_COPY;
  later.textContent = FIRST_RUN_LATER;
  start.textContent = FIRST_RUN_START;
  viewAttention.textContent = FIRST_RUN_VIEW_ATTENTION;
  permissionHint.textContent = FIRST_RUN_PERMISSION_HINT;
  host.requestPermission.textContent = FIRST_RUN_PERMISSION_ACTION;
  host.requestPermission.setAttribute('aria-label', t('common_allowBookmarkAccess', 'Allow bookmark access'));
  advancedModeSelect.value = readAdvancedMode(advancedModeSelect.value);
  advancedHint.textContent = advancedModeHint(readAdvancedMode(advancedModeSelect.value));

  const rangeHeading = host.folderHeading.textContent;
  const rangeIntro = host.folderIntro.textContent;
  let rangeActive = false;
  let observation: FirstRunObservation = { firstRun: 'none' };
  let view: PublicRootView | undefined;
  const previewSession = createFirstRunPreviewSession();
  let libraryId: string | undefined;
  let previewTimer = 0;
  let paintedViewId: string | undefined;
  let statusPoll = 0;
  let statusPollStartedAt = 0;
  let attentionCursor: string | undefined;
  let attentionRequest = 0;
  let attentionOpen = false;
  let attentionFailed = false;
  let advancedMode: AdvancedUiMode = readAdvancedMode(advancedModeSelect.value);

  later.addEventListener('click', () => { void deferFirstRun(); });
  start.addEventListener('click', () => { void startFirstRun(); });
  viewAttention.addEventListener('click', () => { void openAttention(); });
  advancedModeSelect.addEventListener('change', () => {
    window.clearTimeout(previewTimer);
    advancedMode = readAdvancedMode(advancedModeSelect.value);
    invalidateAdvancedPreview();
    say();
    updateAdvancedControls();
    if (advancedMode === 'merge') void refreshPreview();
  });
  advancedPreviewButton.addEventListener('click', () => { void refreshPreview(true); });
  advancedConfirm.addEventListener('click', () => { void confirmAdvancedMode(); });
  host.rootTree.addEventListener('change', () => {
    if (!rangeActive || !view) return;
    invalidateAdvancedPreview();
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => { void refreshPreview(); }, PREVIEW_WAIT_MS);
  });
  window.addEventListener('pagehide', clearStatusPoll, { once: true });
  void hydrate().catch(() => { say(t('firstRun_initializationFailed', 'Sync setup could not load. Reload this page to try again. Your bookmarks and draft are kept.')); });

  return {
    isRangeActive: () => rangeActive,
    onRootsRendered(next, _connected, hasLibrary) {
      view = next;
      invalidateAdvancedPreview();
      if (!hasLibrary) libraryId = undefined;
      if (!rangeActive) {
        confirm.hidden = projectFirstRunSurface(observation) !== 'attention';
        advancedPanel.hidden = true;
        host.saveRoots.hidden = next.status === 'permission_required';
        document.body.dataset.firstRun = '';
        return;
      }
      renderOnboardingView(next);
    },
    setLibraryId(id) { if (libraryId !== id) { libraryId = id; invalidateAdvancedPreview(); } },
    onSignedIn(connected, hasLibrary) {
      if (!connected) { confirm.hidden = true; return; }
      void hydrate().then(() => {
        if (!firstRunOnboardingActive(observation.firstRun)) return;
        host.showPane('folders');
      }).catch(() => { say(t('firstRun_initializationFailed', 'Sync setup could not load. Reload this page to try again. Your bookmarks and draft are kept.')); });
    },
    onPermissionResult(granted) {
      if (!rangeActive) return;
      if (!granted) {
        say(t('firstRun_permissionNotGrantedCan2', 'Permission was not granted. You can try again later. Your draft is saved.'));
        return;
      }
      say();
      void refreshPreview();
    },

  };

  async function hydrate(): Promise<void> {
    libraryId = await boundLibraryId();
    const status = await firstRunMessage({ kind: 'known.firstRun.status' });
    applyStatusResponse(status, { pollIfSyncing: true, fallbackOnboarding: true });

  }

  function renderOnboardingView(next: PublicRootView): void {
    applyRangeChrome(next);
    const firstPaint = paintedViewId !== next.viewId;
    paintedViewId = next.viewId;
    if (firstPaint) {
      void readFirstRunDraft().then(draft => {
        if (!rangeActive || view?.viewId !== next.viewId || !firstRunOnboardingActive(observation.firstRun)) return;
        if (draft && (!draft.libraryId || draft.libraryId === libraryId)) {
          applyFolderSelection(host.rootTree, restoreDraftSelection(next, draft),
            restoreDraftSelection(next, { ...draft, selected: draft.excluded ?? [] }));
        }
        return refreshPreview();
      }).catch(() => { say(t('firstRun_initializationFailed', 'Sync setup could not load. Reload this page to try again. Your bookmarks and draft are kept.')); });
    } else void refreshPreview();
  }

  function applyRangeChrome(next: PublicRootView): void {
    host.folderHeading.textContent = host.serverLabel
      ? t('firstRun_syncBrowserWithServer', "Sync this browser's bookmarks with $1", host.serverLabel())
      : FIRST_RUN_RANGE_HEADING;
    host.folderIntro.textContent = FIRST_RUN_INTRO;
    host.saveRoots.hidden = true;
    permissionHint.hidden = next.status !== 'permission_required';
    confirm.hidden = next.status === 'permission_required' || next.status === 'tree_unavailable';
    advancedPanel.hidden = confirm.hidden;
    advancedHint.textContent = advancedModeHint(advancedMode);
    updateAdvancedControls();
    applyOnboardingDataset();
    if (observation.firstRun === 'running') start.disabled = true;
    if (onlyManagedRoots(next)) {
      empty.hidden = false; empty.textContent = t('firstRun_theseFoldersCannotEdited', 'These folders cannot be edited and are excluded by default.');
    } else if (next.roots.length === 0 && next.status === 'ready') {
      empty.hidden = false; empty.textContent = t('firstRun_noBookmarkFoldersAvailable', 'No bookmark folders are available to sync.');
    } else empty.hidden = true;
  }

  async function refreshPreview(advancedRequest = false): Promise<void> {
    if (!rangeActive || !view || view.status === 'permission_required' || observation.firstRun === 'running') return;
    if (!advancedRequest && advancedMode !== 'merge') return;
    say();
    const selected = new Set(syncRootRefs(host.rootTree));
    const selection = collectPreviewSelection(view, selected, new Set(excludedFolderRefs(host.rootTree)));
    const requestFingerprint = selectionFingerprint({ viewId: view.viewId,
      selectedRefs: selection.selectedRefs, excludedRefs: selection.excludedRefs, libraryId, mode: advancedMode });
    const ticket = previewSession.read(requestFingerprint); if (!ticket) return;
    start.disabled = true; updateAdvancedControls();
    const request: FirstRunRequest = advancedRequest ? advancedPreviewRequest({ viewId: view.viewId,
      selectedRefs: selection.selectedRefs, excludedRefs: selection.excludedRefs, mode: advancedMode })
      : { kind: 'known.firstRun.preview', viewId: view.viewId,
        selectedRefs: selection.selectedRefs, excludedRefs: selection.excludedRefs };
    const response = await firstRunMessage(request);
    if (!previewSession.current(ticket, currentSelectionFingerprint())) return;
    if (!response.ok || !('previewId' in response)) {
      totals.textContent = selection.selectedRefs.length === 0
        ? t('firstRun_selectBookmarkFoldersSync', 'Select the bookmark folders to sync.') : t('firstRun_couldNotReadFolder', 'Could not read folder counts. Refresh and try again.');
      start.disabled = true;
      previewSession.invalidate();
      say(!response.ok ? confirmFailureCopy(response) : FIRST_RUN_ENGINE_NOT_READY);
      renderAdvancedPreview();
      return;
    }
    if (!advancedRequest) {
      const prior = await readFirstRunDraft();
      if (!previewSession.current(ticket, currentSelectionFingerprint())) return;
      const draft: FirstRunDraft = { selected: draftPicksFromView(view, selected), excluded: draftPicksFromView(view, new Set(excludedFolderRefs(host.rootTree))), deferred: prior?.deferred === true,
        ...(libraryId ? { libraryId } : {}) };
      await writeFirstRunDraft(applyPreviewToDraft(draft, response));
    }
    if (!previewSession.accept(ticket, response, currentSelectionFingerprint())) return;
    confirm.dataset.treeDigest = response.treeDigest;
    paintPreviewTotals(totals, response, () => previewSession.preview?.previewId, say);
    start.disabled = advancedMode !== 'merge' || !canStartFirstSync({
      libraryId, preview: response, view, selectedCount: host.rootTree.querySelectorAll('.root-select input:checked').length,
    });
    renderAdvancedPreview();
  }

  function applyStatusResponse(response: FirstRunOrScopeResponse, options: {
    readonly pollIfSyncing: boolean; readonly fallbackOnboarding?: boolean;
  }): void {
    if (!response.ok) {
      const terminal = syncAttentionTerminalCode(response.error, undefined);
      if (terminal || response.error === 'bootstrap_upload_rejected') {
        clearStatusPoll();
        showHandshakeCopy(terminal ? terminalFreezeReasonCopy(terminal) : rejectedWorkCopy(), 'warning');
        return;
      }
      // An unavailable status is not evidence that setup has never completed.
      if (options.fallbackOnboarding) startStatusPoll();
      return;
    }
    const previous = observation;
    observation = observeFirstRunResponse(response, observation);
    if (observation.firstRun !== previous.firstRun || observation.phase !== previous.phase) {
      host.onSyncStatusChanged?.();
    }
    const surface = projectFirstRunSurface(observation);
    if (surface === 'attention') {
      startStatusPoll();
      if (attentionOpen && JSON.stringify(previous.attention) !== JSON.stringify(observation.attention)) void openAttention();
      if (!attentionFailed) showHandshakeCopy(observation.attention ? attentionStatusCopy(observation.attention) : FIRST_RUN_NEEDS_ATTENTION, 'warning');
      attentionHost.hidden = false;
      const conflictHref = response.ok && 'conflictHref' in response && typeof response.conflictHref === 'string'
        ? response.conflictHref
        : undefined;
      setAttentionConflictLink(conflictLink, conflictHref);
      return;
    }
    attentionHost.hidden = true;
    attentionOpen = false; attentionRequest++; attentionList.replaceChildren();
    if (surface === 'hide') {
      clearStatusPoll();
      hideOnboardingChrome();
      return;
    }
    if (surface === 'syncing') {
      showHandshakeCopy(FIRST_RUN_SYNCING, 'info');
      if (options.pollIfSyncing) startStatusPoll();
      return;
    }
    if (options.fallbackOnboarding) {
      clearStatusPoll();
      const wasActive = rangeActive;
      rangeActive = firstRunOnboardingActive(observation.firstRun);
      applyOnboardingDataset();
      if (rangeActive && !wasActive && view) renderOnboardingView(view);
    }
  }

  async function openAttention(cursor?: string): Promise<void> {
    attentionCursor = cursor; attentionOpen = true; attentionFailed = false;
    const ticket = ++attentionRequest;
    try {
      if (!observation.attention) throw new Error('report_expired');
      const reportId = observation.attention.reportId;
      const response = await firstRunMessage({ kind: 'known.firstRun.attention.get', reportId,
        ...(cursor ? { cursor } : {}) });
      if (ticket !== attentionRequest) return;
      if (!response.ok || !('items' in response) || !response.items) {
        if (!response.ok && response.error !== 'extension_unavailable') {
          applyStatusResponse(await firstRunMessage({ kind: 'known.firstRun.status' }), { pollIfSyncing: true });
        }
        throw new Error(response.ok ? 'report_expired' : response.error);
      }
      if (observation.attention?.reportId !== reportId) return;
      renderAttentionItems(attentionList, response.items, (itemId, decision, evidence) => { void decideAttention(itemId, decision, evidence); });
      renderAttentionNavigation(attentionList, cursor, response.nextCursor, page => { void openAttention(page); });
      setAttentionConflictLink(conflictLink, response.conflictHref);
      if ('attention' in response && response.attention) {
        observation = observeFirstRunResponse(response, observation);
        say(attentionStatusCopy(response.attention));
      }
    } catch (failure) {
      if (ticket !== attentionRequest) return;
      attentionFailed = true;
      say(t('firstRun_attentionRequestFailed', 'Could not load the review list ($1). Click View items needing attention to try again, or reload this page.',
        failure instanceof Error ? failure.message : 'extension_unavailable'));
    }
  }

  async function decideAttention(itemId: string, decision: 'keep_both' | 'keep_local' = 'keep_both', evidenceDigest?: string): Promise<void> {
    if (!observation.attention) { await openAttention(); return; }
    const response = await firstRunMessage({ kind: 'known.firstRun.attention.decide', reportId: observation.attention.reportId, itemId, decision, ...(evidenceDigest ? { evidenceDigest } : {}),
    });
    if (!response.ok) { say(confirmFailureCopy(response)); return; }
    if ('attention' in response && response.attention) observation = observeFirstRunResponse(response, observation);
    await openAttention(attentionCursor);
  }

  function applyOnboardingDataset(): void {
    document.body.dataset.firstRun = !rangeActive ? '' : observation.firstRun === 'running' ? 'syncing' : 'draft';
  }

  function showHandshakeCopy(copy: string, tone: 'info' | 'warning'): void {
    rangeActive = firstRunOnboardingActive(observation.firstRun);
    confirm.hidden = false;
    start.disabled = true;
    say(copy, tone);
    updateAdvancedControls();
    applyOnboardingDataset();
  }

  function hideOnboardingChrome(): void {
    rangeActive = false; confirm.hidden = true; advancedPanel.hidden = true; attentionHost.hidden = true;
    document.body.dataset.firstRun = '';
    host.folderHeading.textContent = rangeHeading;
    host.folderIntro.textContent = rangeIntro;
    host.saveRoots.hidden = view?.status === 'permission_required';
  }

  function clearStatusPoll(): void {
    if (statusPoll === 0) return;
    window.clearInterval(statusPoll);
    statusPoll = 0;
  }

  function startStatusPoll(): void {
    if (statusPoll !== 0) return;
    statusPollStartedAt = Date.now();
    statusPoll = window.setInterval(() => { void pollFirstRunStatus(); }, STATUS_POLL_MS);
  }

  async function pollFirstRunStatus(): Promise<void> {
    if (projectFirstRunSurface(observation) !== 'attention' && Date.now() - statusPollStartedAt >= STATUS_POLL_MAX_MS) {
      clearStatusPoll();
      say('', 'info');
      error.replaceChildren();
      const msg = document.createElement('span');
      msg.textContent = t('firstRun_syncStillRunningBackground', 'Sync is still running in the background. Please refresh or check again.');
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn btn-ghost btn-sm';
      retryBtn.textContent = t('firstRun_checkStatus', 'Check status');
      retryBtn.addEventListener('click', () => {
        statusPollStartedAt = Date.now();
        startStatusPoll();
        void pollFirstRunStatus();
      });
      error.append(msg, ' ', retryBtn);
      return;
    }
    const response = await firstRunMessage({ kind: 'known.firstRun.status' });
    applyStatusResponse(response, { pollIfSyncing: false, fallbackOnboarding: true });
  }

  async function deferFirstRun(): Promise<void> {
    clearStatusPoll();
    const preview = previewSession.preview;
    const selected = new Set(syncRootRefs(host.rootTree));
    const draft: FirstRunDraft = {
      selected: view ? draftPicksFromView(view, selected) : [],
      excluded: view ? draftPicksFromView(view, new Set(excludedFolderRefs(host.rootTree))) : [], deferred: true,
      ...(libraryId ? { libraryId } : {}),
      ...(preview ? {
        previewId: preview.previewId, treeDigest: preview.treeDigest,
        bookmarkCount: preview.bookmarkCount, folderCount: preview.folderCount, skippedCount: preview.skippedCount,
      } : {}),
    };
    await writeFirstRunDraft(draft);
    invalidateAdvancedPreview();
    const response = await firstRunMessage({ kind: 'known.firstRun.later' });
    observation = observeFirstRunResponse(response, { firstRun: 'deferred' });
    say(FIRST_RUN_UNSYNCED, 'info');
  }

  function invalidateAdvancedPreview(): void {
    previewSession.invalidate();
    start.disabled = true;
    advancedConfirm.hidden = true;
    advancedConfirm.disabled = true;
    deleteList.replaceChildren();
    deleteList.hidden = true;
    advancedHint.textContent = advancedModeHint(advancedMode);
  }

  function currentSelectionFingerprint(): string {
    if (!view) return '';
    const selected = new Set(syncRootRefs(host.rootTree));
    const selection = collectPreviewSelection(view, selected, new Set(excludedFolderRefs(host.rootTree)));
    return selectionFingerprint({ viewId: view.viewId, selectedRefs: selection.selectedRefs,
      excludedRefs: selection.excludedRefs, libraryId, mode: advancedMode });
  }

  function renderAdvancedPreview(): void {
    const preview = previewSession.preview;
    advancedHint.textContent = advancedModeHint(advancedMode);
    deleteList.replaceChildren();
    const report = preview && 'report' in preview ? preview.report : undefined;
    if (advancedMode === 'preview-only' && report) {
      advancedHint.textContent = `${advancedModeHint(advancedMode)} ${advancedPreviewSummary(report)}`;
      const switchRow = document.createElement('li');
      switchRow.className = 'first-run-preview-switch-wrap';
      const switchCopy = document.createElement('span');
      switchCopy.textContent = PREVIEW_ONLY_GUIDANCE;
      const switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'btn btn-secondary btn-sm';
      switchBtn.id = 'first-run-switch-merge';
      switchBtn.textContent = PREVIEW_ONLY_SWITCH_LABEL;
      switchBtn.addEventListener('click', () => {
        advancedMode = 'merge';
        advancedModeSelect.value = 'merge';
        invalidateAdvancedPreview();
        say();
        updateAdvancedControls();
        void refreshPreview();
      });
      switchRow.append(switchCopy, switchBtn);
      deleteList.append(switchRow);
      deleteList.hidden = false;
    }
    const plan = preview?.advanced;
    if (plan && plan.mode === advancedMode) {
      for (const item of plan.deletes) {
        const row = document.createElement('li');
        row.textContent = advancedDeleteLabel(item);
        deleteList.append(row);
      }
      deleteList.hidden = plan.deletes.length === 0;
    } else if (!(advancedMode === 'preview-only' && report)) deleteList.hidden = true;
    advancedConfirm.hidden = !advancedConfirmationReady(advancedMode, preview);
    advancedConfirm.disabled = advancedConfirm.hidden || previewSession.phase === 'confirming' || observation.firstRun === 'running';
    if (!advancedConfirm.hidden) {
      advancedConfirm.textContent = advancedConfirmLabel(plan?.deletes.length ?? 0);
    }
    updateAdvancedControls();
  }

  function updateAdvancedControls(): void {
    const preview = previewSession.preview, running = observation.firstRun === 'running' || previewSession.phase === 'confirming';
    later.disabled = running;
    advancedModeSelect.disabled = running;
    advancedPreviewButton.disabled = running || previewSession.phase === 'reading' || !view || view.status !== 'ready';
    advancedConfirm.disabled = running || advancedConfirm.hidden
      || !advancedConfirmationReady(advancedMode, preview);
    if (running) start.disabled = true;
  }

  async function confirmAdvancedMode(): Promise<void> {
    const preview = previewSession.preview;
    if (!libraryId || !preview || !advancedConfirmationReady(advancedMode, preview)
        || !preview.advanced || observation.firstRun === 'running') return;
    const reviewed = previewSession.confirm(currentSelectionFingerprint()); if (!reviewed) return;
    updateAdvancedControls(); say();
    const response = await firstRunMessage(advancedConfirmationRequest({ previewId: reviewed.preview.previewId,
      confirmationId: reviewed.commandId, libraryId, confirmation: preview.advanced }));
    if (!previewSession.finish(reviewed.commandId)) return;
    if (response.ok) {
      applyStatusResponse(response, { pollIfSyncing: true });
      if (projectFirstRunSurface(observation) !== 'onboarding') {
        return;
      }
    }
    if (!response.ok && response.error === 'preview_stale') {
      invalidateAdvancedPreview();
      await refreshPreview(true);
      // The new list replaces the old one; the line saying why stays on screen.
      say(confirmFailureCopy({ ok: false, error: 'bootstrap_confirmation_stale' }));
    } else {
      say(!response.ok ? confirmFailureCopy(response) : FIRST_RUN_ENGINE_NOT_READY);
    }
    updateAdvancedControls();
  }

  async function startFirstRun(): Promise<void> {
    if (advancedMode !== 'merge') {
      advancedPanel.open = true;
      say(t('firstRun_modeNeedsReviewConfirm', 'This mode needs you to review and confirm the change list first.'));
      return;
    }
    if (previewSession.preview?.report && !previewSession.preview.advanced) {
      await refreshPreview();
      if (previewSession.preview?.report) return;
    }
    const preview = previewSession.preview;
    if (!preview || !libraryId) {
      say(libraryId ? t('firstRun_confirmWhichBookmarkFolders', 'Confirm which bookmark folders to sync first.') : FIRST_RUN_LIBRARY_REQUIRED);
      return;
    }
    const reviewed = previewSession.confirm(currentSelectionFingerprint()); if (!reviewed) return;
    start.disabled = true;
    say();
    const response = await firstRunMessage(buildFirstRunConfirm({
      previewId: reviewed.preview.previewId, libraryId, confirmationId: reviewed.commandId,
    }));
    if (!previewSession.finish(reviewed.commandId)) return;
    if (response.ok) {
      applyStatusResponse(response, { pollIfSyncing: true });
      if (projectFirstRunSurface(observation) !== 'onboarding') {
        return;
      }
    }
    say(!response.ok ? confirmFailureCopy(response) : FIRST_RUN_ENGINE_NOT_READY);
    if (!response.ok && response.error === 'preview_stale') {
      previewSession.invalidate();
      await refreshPreview();
    }
    start.disabled = false;
  }


}

async function firstRunMessage(message: FirstRunRequest): Promise<FirstRunOrScopeResponse> {
  try {
    const value: unknown = await chrome.runtime.sendMessage(message);
    return value && typeof value === 'object' && 'ok' in value ? value as FirstRunOrScopeResponse : { ok: false, error: 'extension_unavailable' };
  }
  catch { return { ok: false, error: 'extension_unavailable' }; }
}

async function boundLibraryId(): Promise<string | undefined> {
  try {
    const value = (await chrome.storage.local.get(COLLECTION_BINDING))[COLLECTION_BINDING];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch { return undefined; }
}

function required(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error('options_markup_invalid');
  return value;
}

/** The draft's own picks; folder coverage then ticks what they carry, and the pane repaints its count. */
function applyFolderSelection(tree: HTMLElement, selected: ReadonlySet<string>, excluded: ReadonlySet<string>): void {
  replaceFolderSelection(tree, selected, excluded);
  tree.dispatchEvent(new Event(ROOTS_REPAINT));
}

function readAdvancedMode(value: string): AdvancedUiMode {
  return value === 'upload' || value === 'download' || value === 'preview-only' ? value : 'merge';
}
