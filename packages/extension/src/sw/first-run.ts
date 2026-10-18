import { reasonCode } from '../push-error-code.js';
import { recordBoundaryDiagnostics } from '../bootstrap/boundary-diagnostics.js';
import { personalTreeApi } from '../bookmark-subscriptions/personal-boundary.js';
import { personalSyncNativeApi } from '../personal-sync-fetch.js';
import {
  bootstrapRunInFlight, createBootstrapCoordinator, previewStaleFromScan, type ConfirmInput,
} from '../bootstrap/coordinator.js';
import { localFactsFromRoots } from '../bootstrap/local-facts.js';
import type { MountFact } from '../bootstrap/matcher.js';
import { scanBoundary } from '../bookmark-boundary.js';
import { createChromeBookmarkTreeAdapter } from '../chrome-bookmark-tree.js';
import { kns09Paused, recordKns09FirstRun, recordKns09MergeAttention } from '../kns-09-release.js';
import { detachScopeMount, executeRemoteDelete, rejoinScopeMount } from '../scope-commands.js';
import { collectNativeIds } from '../scope-reconcile.js';
import type { BootstrapRunRecord, MountBindingRecord, ScopePreviewRecord, SyncScope } from '../sync-state-store.js';
import type { FirstRunOrScopeResponse, FirstRunRequest, ScopeCommandRequest } from '../types.js';
import { handleAttentionDecide, handleAttentionGet, latestBootstrapRun, withAttention } from './first-run-attention.js';
import { persistFirstRunBrowserRoots } from './first-run-browser-roots.js';
import { resolveLibraryRootId } from './library.js';
import { hasBookmarkPermission, rootScopeKey, store, workCoordinator, sw, syncState } from './runtime.js';
import { currentSyncScope, restoredSyncScope, retireLegacyScopeForRemount } from './scope.js';
import { readRootFolders, sameDiscovered } from './roots.js';
import { nativeChromeFacts } from './native-chrome.js';
import { readSnapshotAuthority, advancedFirstRunStatus, handleAdvancedFirstRunConfirm, handleAdvancedFirstRunPreview } from './advanced-first-run.js';
import { syncAttentionTerminalCode } from '../sync-attention-ui.js';

const PREVIEW_TTL_MS = 30 * 60 * 1000;

export async function handleFirstRunRequest(message: FirstRunRequest): Promise<FirstRunOrScopeResponse> {
  if (message.kind === 'known.firstRun.preview') return handleFirstRunPreview(message);
  if (message.kind === 'known.firstRun.later') return handleFirstRunLater();
  if (message.kind === 'known.firstRun.status') return handleFirstRunStatus();
  if (message.kind === 'known.firstRun.confirm') return handleFirstRunConfirm(message);
  if (message.kind === 'known.firstRun.attention.get' || message.kind === 'known.firstRun.attention.decide') {
    return handleAttentionMessage(message);
  }
  return { ok: false, error: 'not_implemented' };
}

export async function handleScopeCommand(message: ScopeCommandRequest): Promise<FirstRunOrScopeResponse> {
  try {
    const scope = await currentSyncScope();
    const recorded = await syncState.getScope(scope);
    const firstRun = recorded?.firstRun ?? 'none';
    if (await kns09Paused('ui')) return { ok: false, error: 'sync_paused' };
    if (message.kind === 'known.scope.detach') {
      await detachScopeMount(syncState, scope, message.mountId);
      return { ok: true, phase: 'draft', firstRun };
    }
    if (message.kind === 'known.scope.rejoin') {
      if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
      const nativePresent = await hasBookmarkPermission()
        ? collectNativeIds((await createChromeBookmarkTreeAdapter(await personalSyncNativeApi(scope, personalTreeApi())).read()).roots)
        : new Set<string>();
      const result = await rejoinScopeMount(syncState, scope, message.mountId, nativePresent, [...nativePresent],
        await personalSyncNativeApi(scope, nativeChromeFacts()));
      if (result.mount.status !== 'active') return { ok: false, error: 'rejoin_pending' };
      return { ok: true, phase: 'syncing', firstRun };
    }
    return executeRemoteDelete(syncState, scope, message);
  } catch (error) {
    const code = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message) ? error.message : 'request_invalid';
    return { ok: false, error: code };
  }
}

async function handleFirstRunPreview(message: Extract<FirstRunRequest, { readonly kind: 'known.firstRun.preview' }>):
  Promise<FirstRunOrScopeResponse> {
  if (Object.hasOwn(message, 'bootstrapMode') && message.bootstrapMode === undefined) {
    return { ok: false, error: 'request_invalid' };
  }
  if (message.bootstrapMode !== undefined) return handleAdvancedFirstRunPreview(message);
  let scope: SyncScope;
  try { scope = await currentSyncScope(); } catch { return { ok: false, error: 'not_connected' }; }
  if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
  const selected = resolvePreviewRefs(scope, message.viewId, message.selectedRefs);
  const excluded = resolvePreviewRefs(scope, message.viewId, message.excludedRefs);
  if (!selected || !excluded) return { ok: false, error: 'request_invalid' };
  const current = await readRootFolders();
  if (!sw.rootViewTokens || !sameDiscovered(current.discovered, [...sw.rootViewTokens.entries.values()])) {
    sw.rootViewTokens = undefined; return { ok: false, error: 'request_invalid' };
  }
  const tree = await createChromeBookmarkTreeAdapter(await personalSyncNativeApi(scope, personalTreeApi())).read();
  const privateNativeIds = [...new Set([...await privateNativeIdsFor(scope), ...excluded])];
  const scan = scanBoundary({ roots: tree.roots, selectedNativeIds: selected, excludedNativeIds: excluded,
    privateNativeIds });
  const boundaryVersion = await syncState.bumpBoundaryVersion(scope);
  const previewId = crypto.randomUUID();
  await syncState.putScopePreview(scope, {
    previewId, boundaryVersion, treeDigest: scan.treeDigest, bookmarkCount: scan.bookmarkCount,
    folderCount: scan.folderCount, skippedCount: scan.skippedCount, expiresAt: Date.now() + PREVIEW_TTL_MS,
    warnings: scan.warnings, boundary: { selectedNativeIds: scan.selectedNativeIds,
      excludedNativeIds: scan.excludedNativeIds, mounts: scan.mounts }, privateNativeIds,
  });
  return { ok: true, previewId, boundaryVersion, treeDigest: scan.treeDigest, bookmarkCount: scan.bookmarkCount,
    folderCount: scan.folderCount, skippedCount: scan.skippedCount, warnings: scan.warnings };
}

async function handleFirstRunLater(): Promise<FirstRunOrScopeResponse> {
  try {
    const scope = await currentSyncScope();
    const recorded = await syncState.getScope(scope);
    if (recorded?.firstRun === 'completed' || recorded?.firstRun === 'running') {
      const run = await latestBootstrapRun(syncState, scope);
      const phase = run?.phase === 'needs_attention' ? 'needs_attention'
        : recorded.firstRun === 'completed' ? 'completed' : 'syncing';
      return withAttention(phase, recorded.firstRun, run);
    }
    if (recorded) await syncState.setFirstRun(scope, 'deferred');
  } catch { /* Keep a local-only deferral when no scope exists yet. */ }
  return { ok: true, phase: 'draft', firstRun: 'deferred' };
}

async function handleFirstRunStatus(): Promise<FirstRunOrScopeResponse> {
  let scope: SyncScope;
  // Options can ask before anything restored the credential after a restart;
  // answering not_connected then reopened the first-run card on a synced browser.
  try { scope = await restoredSyncScope(); } catch { return { ok: false, error: 'not_connected' }; }
  const engine = await syncState.getEngineState(scope);
  const recorded = await syncState.getScope(scope);
  const recoveryCode = typeof recorded?.metadata?.recoveryCode === 'string' ? recorded.metadata.recoveryCode : undefined;
  const terminal = syncAttentionTerminalCode(engine?.lastError, recoveryCode);
  if (recorded?.firstRun === 'running' && engine?.recoveryFrozen && terminal) return { ok: false, error: terminal };
  const advanced = await advancedFirstRunStatus(scope);
  if (advanced) return advanced;
  const coordinator = createBootstrapCoordinator({ store: syncState, scope });
  const snapshot = await coordinator.status();
  if ((snapshot.phase === 'needs_attention' || snapshot.retryReason === 'queue_recovery_frozen' || snapshot.retryReason === 'snapshot_pending')
      && (snapshot.phase === 'needs_attention' || snapshot.firstRun === 'running' || bootstrapRunInFlight(snapshot.phase))) {
    try { await resumeRunningBootstrap(scope); } catch (error) { return { ok: false, error: reasonCode(error, 'bootstrap_status_unavailable') }; }
  }
  const next = await coordinator.status();
  if (next.retryReason === 'bootstrap_upload_rejected') return { ok: false, error: next.retryReason };
  return withAttention(next.phase, next.firstRun as 'none' | 'deferred' | 'running' | 'completed',
    next.attention ? { attention: next.attention } as { attention: NonNullable<typeof next.attention> } : undefined);
}

export async function resumeRunningBootstrap(scope: SyncScope): Promise<boolean> {
  if ((await syncState.listAdvancedPlans(scope)).some((plan) => plan.state !== 'completed')) return false;
  if (await kns09Paused('coordinator')) return false;
  if ((await syncState.getEngineState(scope))?.recoveryFrozen === true) return false;
  const runs = [...await syncState.listBootstrapRuns(scope)].sort((left, right) => right.updatedAt - left.updatedAt);
  const candidates = runs.filter(row => bootstrapRunInFlight(row.phase) || row.phase === 'needs_attention');
  if (!candidates.length) return false;
  const priorOpIds = new Set(await listAllQueueOpIds(scope));
  let added = false;
  for (const run of candidates) {
    let input = await resumeConfirmInput(scope, run);
    if (run.attention?.items.some(item => item.resolutionOpIds?.length)) {
      input = { ...input, remoteFacts: (await readSnapshotAuthority(scope)).snapshot.remoteFacts };
    }
    const view = await createBootstrapCoordinator({ store: syncState, scope,
      retireLegacy: async () => { await retireLegacyScopeForRemount(); } }).advance(run.runId, input);
    if (bootstrapRunInFlight(run.phase)) await persistConfirmedPreviewRoots(scope, input.previewId
      ? await syncState.getScopePreview(scope, input.previewId) : null);
    added ||= view.queuedOpIds.some(opId => !priorOpIds.has(opId));
  }
  return added;
}

async function resumeConfirmInput(scope: SyncScope, run: BootstrapRunRecord): Promise<ConfirmInput> {
  const preview = run.previewId ? await syncState.getScopePreview(scope, run.previewId) : null;
  const bindings = await syncState.listMountBindings(scope);
  const mounts = overlayMountsFromBindings(preview ? mountsFromPreview(preview.boundary.mounts) : [], bindings);
  if (!await hasBookmarkPermission()) throw new Error('permission_required');
  // An unreadable tree is not an empty tree and cannot close an existing report.
  const tree = await createChromeBookmarkTreeAdapter(await personalSyncNativeApi(scope, personalTreeApi())).read();
  const selected = preview?.boundary.selectedNativeIds ?? bindings.filter(row => row.status === 'active').map(row => row.nativeRootId);
  const excluded = preview?.boundary.excludedNativeIds ?? [];
  const localFacts = localFactsFromRoots(tree.roots, selected, excluded, await privateNativeIdsFor(scope));
  const rootNodeId = await resolveLibraryRootId(scope.collectionId);
  return {
    confirmationId: run.confirmationId,
    treeDigest: run.treeDigest ?? preview?.treeDigest ?? 'sha256:resume',
    confirmationVersion: run.confirmationVersion ?? preview?.boundaryVersion ?? '1',
    localFacts, mounts,
    ...(run.previewId ? { previewId: run.previewId } : {}),
    ...(run.libraryId ? { libraryId: run.libraryId } : {}),
    ...(rootNodeId ? { rootNodeId } : { rootNodeId: null }),
    bootstrapMode: run.bootstrapMode,
    ...(run.previewOnly ? { previewOnly: true } : {}),
    ...(run.destructiveConfirmed ? { destructiveConfirmed: true } : {}),
  };
}

async function handleFirstRunConfirm(message: Extract<FirstRunRequest, { readonly kind: 'known.firstRun.confirm' }>):
  Promise<FirstRunOrScopeResponse> {
  if (Object.hasOwn(message, 'advancedConfirmation') && message.advancedConfirmation === undefined) {
    return { ok: false, error: 'request_invalid' };
  }
  if (Object.hasOwn(message, 'bootstrapMode') && message.bootstrapMode === undefined) {
    return { ok: false, error: 'request_invalid' };
  }
  if (message.advancedConfirmation !== undefined) return handleAdvancedFirstRunConfirm(message);
  if (message.bootstrapMode !== undefined) return { ok: false, error: 'request_invalid' };
  let scope: SyncScope;
  try { scope = await currentSyncScope(); } catch { return { ok: false, error: 'not_connected' }; }
  const libraryId = 'libraryId' in message ? message.libraryId : undefined;
  if (libraryId !== undefined && libraryId !== scope.collectionId) {
    return { ok: false, error: 'bootstrap_confirmation_stale' };
  }
  if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
  if (await kns09Paused('coordinator')) {
    recordKns09FirstRun('paused', scope, message.confirmationId);
    return { ok: false, error: 'sync_paused' };
  }
  const preview = await syncState.getScopePreview(scope, message.previewId);
  if (!preview || preview.expiresAt <= Date.now()) {
    recordKns09FirstRun('failed', scope, message.confirmationId);
    return { ok: false, error: 'request_invalid' };
  }
  // Read-only digest rescan: BookmarkTreeApi.getTree only. No create/update/move/remove.
  const tree = await createChromeBookmarkTreeAdapter(await personalSyncNativeApi(scope, personalTreeApi())).read();
  const scan = scanBoundary({ roots: tree.roots, selectedNativeIds: [...preview.boundary.selectedNativeIds],
    excludedNativeIds: [...preview.boundary.excludedNativeIds],
    privateNativeIds: [...new Set([...await privateNativeIdsFor(scope), ...(preview.privateNativeIds ?? [])])] });
  if (scan.treeDigest !== preview.treeDigest) {
    recordKns09FirstRun('failed', scope, message.confirmationId);
    return previewStaleFromScan(scan);
  }
  await recordBoundaryDiagnostics(syncState, scope, scan, tree.roots, message.previewId);
  recordKns09FirstRun('started', scope, message.confirmationId);
  const rootNodeId = libraryId ? await resolveLibraryRootId(libraryId) : undefined;
  const coordinator = createBootstrapCoordinator({
    store: syncState, scope,
    retireLegacy: async () => { await retireLegacyScopeForRemount(); },
  });
  const view = await coordinator.confirm({
    confirmationId: message.confirmationId, previewId: message.previewId, treeDigest: preview.treeDigest,
    confirmationVersion: preview.boundaryVersion, localFacts: localFactsFromRoots(tree.roots,
      preview.boundary.selectedNativeIds, preview.boundary.excludedNativeIds, await privateNativeIdsFor(scope)),
    mounts: mountsFromPreview(preview.boundary.mounts),
    ...(libraryId ? { libraryId } : {}),
    ...(rootNodeId ? { rootNodeId } : { rootNodeId: null }),
  });
  await persistConfirmedPreviewRoots(scope, preview);
  const recorded = await syncState.getScope(scope);
  if (view.report) recordKns09MergeAttention(scope, view.report.candidates.length, view.report.conflicts.length);
  recordKns09FirstRun(view.run.phase === 'completed' ? 'completed'
    : view.run.phase === 'needs_attention' ? 'attention' : 'started', scope, message.confirmationId);
  return withAttention(view.run.phase, recorded?.firstRun ?? 'running', view.run);
}

async function handleAttentionMessage(message: Extract<FirstRunRequest,
  { readonly kind: 'known.firstRun.attention.get' | 'known.firstRun.attention.decide' }>):
  Promise<FirstRunOrScopeResponse> {
  let scope: SyncScope;
  try { scope = await currentSyncScope(); } catch { return { ok: false, error: 'not_connected' }; }
  const firstRun = ((await syncState.getScope(scope))?.firstRun ?? 'none') as
    'none' | 'deferred' | 'running' | 'completed';
  if (message.kind === 'known.firstRun.attention.get') {
    try { await resumeRunningBootstrap(scope); } catch (error) { return { ok: false, error: reasonCode(error, 'bootstrap_status_unavailable') }; }
    return handleAttentionGet(syncState, scope, message.reportId, message.cursor, firstRun);
  }
  if (message.decision === 'keep_local') {
    try { return await workCoordinator.run('engine', async context => {
      const assertCurrent = async () => {
        await store.fence.assertWritable(context.generation);
        if (rootScopeKey(await currentSyncScope()) !== rootScopeKey(scope)) throw new Error('stale_ref');
      };
      const run = (await syncState.listBootstrapRuns(scope)).find(row => row.runId === message.reportId);
      if (!run) return { ok: false, error: 'bootstrap_confirmation_stale' };
      const authority = await readSnapshotAuthority(scope);
      const input = { ...await resumeConfirmInput(scope, run), remoteFacts: authority.snapshot.remoteFacts };
      return handleAttentionDecide(syncState, scope, message.reportId, message.itemId, firstRun,
        { decision: 'keep_local', evidenceDigest: message.evidenceDigest, input, assertCurrent });
    });
    } catch (error) { return { ok: false, error: reasonCode(error, 'merge_resolution_failed') }; }
  }
  return handleAttentionDecide(syncState, scope, message.reportId, message.itemId, firstRun);
}

function overlayMountsFromBindings(previewMounts: readonly MountFact[],
  bindings: readonly MountBindingRecord[]): MountFact[] {
  const source = previewMounts.length > 0 ? previewMounts : mountsFromBindings(bindings);
  const byNative = new Map(bindings.map((row) => [row.nativeRootId, row]));
  return source.map((mount) => {
    const row = byNative.get(mount.nativeRootId);
    return { ...mount, remoteMountNodeId: row?.remoteMountNodeId ?? mount.remoteMountNodeId };
  });
}

function mountsFromPreview(mounts: ScopePreviewRecord['boundary']['mounts']): MountFact[] {
  return mounts.filter((mount) => mount.writable).map((mount) => ({
    nativeRootId: mount.nativeRootId, remoteMountNodeId: null,
    ...(mount.rootRole ? { rootRole: mount.rootRole } : {}),
    ...(mount.customSourceKey ? { customSourceKey: mount.customSourceKey } : {}),
  }));
}

function mountsFromBindings(rows: readonly MountBindingRecord[]): MountFact[] {
  return rows.map((mount) => ({
    nativeRootId: mount.nativeRootId, remoteMountNodeId: mount.remoteMountNodeId,
    ...(mount.rootRole ? { rootRole: mount.rootRole } : {}),
    ...(mount.customSourceKey ? { customSourceKey: mount.customSourceKey } : {}),
  }));
}

function resolvePreviewRefs(scope: SyncScope, viewId: string, refs: readonly string[]) {
  if (!Array.isArray(refs) || refs.length > 128 || refs.some((ref) => typeof ref !== 'string')) return null;
  if (!sw.rootViewTokens || sw.rootViewTokens.viewId !== viewId || sw.rootViewTokens.scopeKey !== rootScopeKey(scope)) {
    return null;
  }
  const resolved = refs.map((ref) => sw.rootViewTokens!.entries.get(ref)?.nativeId);
  return resolved.some((value) => !value) ? null : resolved as string[];
}

async function listAllQueueOpIds(scope: SyncScope): Promise<string[]> {
  const opIds: string[] = [];
  let after = 0;
  for (;;) {
    const page = await syncState.listQueue(scope, undefined, after, 1_000);
    for (const row of page) opIds.push(row.opId);
    if (page.length < 1_000) return opIds;
    after = page[page.length - 1]!.sequence;
  }
}

async function persistConfirmedPreviewRoots(scope: SyncScope, preview: ScopePreviewRecord | null): Promise<void> {
  const selectedNativeIds = preview
    ? [...preview.boundary.selectedNativeIds]
    : (await syncState.listMountBindings(scope))
      .filter((mount) => mount.status !== 'detached').map((mount) => mount.nativeRootId);
  if (selectedNativeIds.length === 0) return;
  const selected = new Set(selectedNativeIds);
  const unresolved = (await syncState.listMountBindings(scope)).some((mount) => selected.has(mount.nativeRootId)
    && !mount.remoteMountNodeId && mount.status !== 'detached');
  // UUID selectedRoots before mount-resolve would be treated as remote ids on resume.
  if (unresolved && (await syncState.getScope(scope))?.firstRun !== 'completed') return;
  const { discovered } = await readRootFolders();
  await persistFirstRunBrowserRoots(syncState, scope, {
    discovered, selectedNativeIds, privateNativeIds: preview?.privateNativeIds ?? await privateNativeIdsFor(scope),
  });
}

async function privateNativeIdsFor(scope: SyncScope): Promise<string[]> {
  const recorded = await syncState.getScope(scope);
  const mappings = await syncState.listMappings(scope);
  const byColp = new Map(mappings.map((mapping) => [mapping.colpId, mapping.nativeId]));
  return (recorded?.privateRoots ?? []).map((id) => byColp.get(id)).filter((id): id is string => Boolean(id));
}
