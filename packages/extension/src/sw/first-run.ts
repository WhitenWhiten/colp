import { reasonCode } from '../push-error-code.js';
import { recordBoundaryDiagnostics } from '../bootstrap/boundary-diagnostics.js';
import { personalTreeApi } from '../bookmark-subscriptions/personal-boundary.js';
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
import { handleAttentionDecide, handleAttentionGet, latestBootstrapRun, withAttention, attentionSummaryOf } from './first-run-attention.js';
import { persistFirstRunBrowserRoots } from './first-run-browser-roots.js';
import { resolveLibraryRootId } from './library.js';
import { hasBookmarkPermission, rootScopeKey, store, workCoordinator, sw, syncState } from './runtime.js';
import { currentSyncScope, restoredSyncScope, retireLegacyScopeForRemount } from './scope.js';
import { readRootFolders, sameDiscovered } from './roots.js';
import { rejoinNative } from './rejoin-native.js';
import { readSnapshotAuthority, advancedFirstRunStatus, handleAdvancedFirstRunConfirm, handleAdvancedFirstRunPreview } from './advanced-first-run.js';
import { syncAttentionTerminalCode } from '../sync-attention-ui.js';
import { digestJson } from '../bookmark-event-codec.js';
import type { JsonObject } from '../sync-state-store.js';
import { runBoundaryConfirmation } from './boundary-confirmation.js';
import { captureBoundaryAttempt, type BoundaryAttempt } from './boundary-attempt.js';

const PREVIEW_TTL_MS = 30 * 60 * 1000;
let lastAttentionStatusRead: { scopeKey: string; at: number } | undefined;

export async function handleFirstRunRequest(message: FirstRunRequest): Promise<FirstRunOrScopeResponse> {
  if (message.kind === 'known.firstRun.preview') return handleFirstRunPreview(message);
  if (message.kind === 'known.firstRun.later') return handleFirstRunLater();
  if (message.kind === 'known.firstRun.status') return handleFirstRunStatus(message.confirmationId);
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
      const attempt = await captureBoundaryAttempt(scope);
      const nativePresent = await hasBookmarkPermission()
        ? collectNativeIds((await createChromeBookmarkTreeAdapter(await attempt.nativeApi(personalTreeApi())).read()).roots)
        : new Set<string>();
      const result = await workCoordinator.run('bookmark', async () => {
        await attempt.assertCurrent();
        return rejoinScopeMount(syncState, scope, message.mountId, nativePresent, [...nativePresent],
          await rejoinNative(scope, attempt));
      });
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
  const attempt = await captureBoundaryAttempt(scope);
  const selected = resolvePreviewRefs(scope, message.viewId, message.selectedRefs);
  const excluded = resolvePreviewRefs(scope, message.viewId, message.excludedRefs);
  if (!selected || !excluded) return { ok: false, error: 'request_invalid' };
  const current = await readRootFolders(await attempt.nativeApi(personalTreeApi()));
  if (!sw.rootViewTokens || !sameDiscovered(current.discovered, [...sw.rootViewTokens.entries.values()])) {
    sw.rootViewTokens = undefined; return { ok: false, error: 'request_invalid' };
  }
  const tree = await createChromeBookmarkTreeAdapter(await attempt.nativeApi(personalTreeApi())).read();
  const privateNativeIds = [...new Set([...await privateNativeIdsFor(scope), ...excluded])];
  const scan = scanBoundary({ roots: tree.roots, selectedNativeIds: selected, excludedNativeIds: excluded,
    privateNativeIds, existingMounts: await syncState.listMountBindings(scope) });
  // Previewing is read-only authority: another page may hold a valid preview of
  // the same boundary. Only an admitted, committed command advances its version.
  const boundaryVersion = (await syncState.getScope(scope))?.boundaryVersion ?? '0';
  const previewId = crypto.randomUUID();
  await attempt.assertCurrent();
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
  let scope: SyncScope;
  try { scope = await currentSyncScope(); }
  catch (error) {
    if (reasonCode(error, 'defer_failed') === 'not_connected') return { ok: true, phase: 'draft', firstRun: 'deferred' };
    return { ok: false, error: 'defer_failed' };
  }
  try {
    await syncState.setFirstRun(scope, 'deferred');
    const recorded = await syncState.getScope(scope);
    if (recorded?.firstRun === 'completed' || recorded?.firstRun === 'running') {
      const run = await latestBootstrapRun(syncState, scope);
      const phase = run?.phase === 'needs_attention' ? 'needs_attention'
        : recorded.firstRun === 'completed' ? 'completed' : 'syncing';
      return withAttention(phase, recorded.firstRun, run);
    }
    return { ok: true, phase: 'draft', firstRun: 'deferred' };
  } catch { return { ok: false, error: 'defer_failed' }; }
}

async function handleFirstRunStatus(confirmationId?: string): Promise<FirstRunOrScopeResponse> {
  let scope: SyncScope;
  // Options can ask before anything restored the credential after a restart;
  // answering not_connected then reopened the first-run card on a synced browser.
  try { scope = await restoredSyncScope(); } catch { return { ok: false, error: 'not_connected' }; }
  await resumePendingFirstRunConfirmation(scope);
  const status = await readFirstRunStatus(scope);
  if (!confirmationId || !status.ok || !('firstRun' in status)) return status;
  const command = await syncState.getBoundaryCommand(scope, confirmationId);
  const plan = (await syncState.listAdvancedPlans(scope))
    .find((candidate) => candidate.metadata.confirmationId === confirmationId);
  // The global run may belong to another options page. Only this persisted
  // receipt is evidence that the command being checked was admitted.
  const state = command?.kind === 'first-run' ? command.state : plan ? 'committed' : 'missing';
  return { ...status, confirmation: { confirmationId, state } };
}

async function readFirstRunStatus(scope: SyncScope): Promise<FirstRunOrScopeResponse> {
  const engine = await syncState.getEngineState(scope);
  const recorded = await syncState.getScope(scope);
  const recoveryCode = typeof recorded?.metadata?.recoveryCode === 'string' ? recorded.metadata.recoveryCode : undefined;
  const terminal = syncAttentionTerminalCode(engine?.lastError, recoveryCode);
  if (recorded?.firstRun === 'running' && engine?.recoveryFrozen && terminal) return { ok: false, error: terminal };
  const advanced = await advancedFirstRunStatus(scope);
  if (advanced) return advanced;
  const coordinator = createBootstrapCoordinator({ store: syncState, scope });
  const snapshot = await coordinator.status();
  const needsAttention = snapshot.phase === 'needs_attention' || (attentionSummaryOf(snapshot)?.pendingCount ?? 0) > 0;
  if ((needsAttention || snapshot.retryReason === 'queue_recovery_frozen' || snapshot.retryReason === 'snapshot_pending')
      && (needsAttention || snapshot.firstRun === 'running' || bootstrapRunInFlight(snapshot.phase))) {
    const key = rootScopeKey(scope);
    const due = !needsAttention || lastAttentionStatusRead?.scopeKey !== key
      || Date.now() < lastAttentionStatusRead.at || Date.now() - lastAttentionStatusRead.at >= 8000;
    if (due) {
      try { await resumeRunningBootstrap(scope); lastAttentionStatusRead = { scopeKey: key, at: Date.now() }; }
      catch (error) { return { ok: false, error: reasonCode(error, 'bootstrap_status_unavailable') }; }
    }
  }
  const next = await coordinator.status();
  if (next.firstRun === 'running' && !next.runId) return { ok: true, firstRun: 'running', phase: 'confirmed' };
  if (next.retryReason === 'bootstrap_upload_rejected') return { ok: false, error: next.retryReason };
  return withAttention(next.phase, next.firstRun as 'none' | 'deferred' | 'running' | 'completed',
    next.attention ? { attention: next.attention } as { attention: NonNullable<typeof next.attention> } : undefined);
}

export async function resumeRunningBootstrap(scope: SyncScope): Promise<boolean> {
  await resumePendingFirstRunConfirmation(scope);
  if ((await syncState.listAdvancedPlans(scope)).some((plan) => plan.state !== 'completed')) return false;
  if (await kns09Paused('coordinator')) return false;
  if ((await syncState.getEngineState(scope))?.recoveryFrozen === true) return false;
  const runs = [...await syncState.listBootstrapRuns(scope)].sort((left, right) => right.updatedAt - left.updatedAt);
  const candidates = runs.filter(row => bootstrapRunInFlight(row.phase) || row.phase === 'needs_attention'
    || (attentionSummaryOf(row)?.pendingCount ?? 0) > 0);
  if (!candidates.length) return false;
  const attempt = await captureBoundaryAttempt(scope);
  const priorOpIds = new Set(await listAllQueueOpIds(scope));
  let added = false;
  for (const run of candidates) {
    let input = await resumeConfirmInput(scope, run, attempt);
    if (run.attention?.items.some(item => item.resolutionOpIds?.length)) {
      const operations = await Promise.all(run.attention.items.flatMap(item => item.resolutionOpIds ?? []).map(id => syncState.getQueueByOpId(scope, id)));
      if (operations.some(row => row && !['terminal', 'rejected'].includes(row.status))) continue;
      input = { ...input, remoteFacts: (await readSnapshotAuthority(scope)).snapshot.remoteFacts };
    }
    await attempt.assertCurrent();
    const view = await createBootstrapCoordinator({ store: syncState, scope,
      retireLegacy: async () => { await retireLegacyScopeForRemount(); } }).advance(run.runId, input);
    if (bootstrapRunInFlight(run.phase)) {
      const command = await syncState.getBoundaryCommand(scope, run.confirmationId);
      // A later range owns the current boundary even while this bootstrap finishes.
      const expectedVersion = command?.committedBoundaryVersion ?? command?.boundaryVersion ?? run.confirmationVersion;
      await persistConfirmedPreviewRoots(scope, input.previewId
        ? await syncState.getScopePreview(scope, input.previewId) : null, attempt, expectedVersion);
    }
    added ||= view.queuedOpIds.some((opId) => !priorOpIds.has(opId));
  }
  return added;
}

async function resumeConfirmInput(scope: SyncScope, run: BootstrapRunRecord, attempt: BoundaryAttempt): Promise<ConfirmInput> {
  const preview = run.previewId ? await syncState.getScopePreview(scope, run.previewId) : null;
  const bindings = await syncState.listMountBindings(scope);
  const mounts = overlayMountsFromBindings(preview ? mountsFromPreview(preview.boundary.mounts) : [], bindings);
  if (!await hasBookmarkPermission()) throw new Error('permission_required');
  // An unreadable tree is not an empty tree and cannot close an existing report.
  const tree = await createChromeBookmarkTreeAdapter(await attempt.nativeApi(personalTreeApi())).read();
  const selected = preview?.boundary.selectedNativeIds ?? bindings.filter(row => row.status === 'active').map(row => row.nativeRootId);
  const excluded = preview?.boundary.excludedNativeIds ?? [];
  const localFacts = localFactsFromRoots(tree.roots, selected, excluded, await privateNativeIdsFor(scope), bindings);
  const rootNodeId = await resolveLibraryRootId(scope.collectionId);
  await attempt.assertCurrent();
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
  const receipt = await syncState.getBoundaryCommand(scope, message.confirmationId);
  if (receipt?.state === 'committed' && receipt.kind === 'first-run'
      && receipt.requestDigest === firstRunRequestDigest(message)) return receipt.result as unknown as FirstRunOrScopeResponse;
  const attempt = await captureBoundaryAttempt(scope);
  return runBoundaryConfirmation(scope, `${message.confirmationId}:${firstRunRequestDigest(message)}`,
    () => confirmFirstRunInScope(message, scope, attempt));
}

function firstRunRequestDigest(message: Extract<FirstRunRequest, { readonly kind: 'known.firstRun.confirm' }>) {
  return digestJson({ kind: message.kind, previewId: message.previewId, libraryId: message.libraryId ?? null });
}

async function confirmFirstRunInScope(message: Extract<FirstRunRequest, { readonly kind: 'known.firstRun.confirm' }>,
  scope: SyncScope, attempt: BoundaryAttempt): Promise<FirstRunOrScopeResponse> {
  const libraryId = 'libraryId' in message ? message.libraryId : undefined;
  if (libraryId !== undefined && libraryId !== scope.collectionId) {
    return { ok: false, error: 'bootstrap_confirmation_stale' };
  }
  let command = await syncState.getBoundaryCommand(scope, message.confirmationId);
  if (command && (command.kind !== 'first-run' || command.requestDigest !== firstRunRequestDigest(message))) {
    return { ok: false, error: 'confirmation_conflict' };
  }
  if (command?.state === 'committed') return command.result as unknown as FirstRunOrScopeResponse;
  if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
  if (await kns09Paused('coordinator')) {
    recordKns09FirstRun('paused', scope, message.confirmationId);
    return { ok: false, error: 'sync_paused' };
  }
  const preview = await syncState.getScopePreview(scope, message.previewId);
  const recordedBefore = await syncState.getScope(scope);
  if (!preview || !command && (preview.expiresAt <= Date.now() || preview.kind === 'range'
      || preview.boundaryVersion !== (recordedBefore?.boundaryVersion ?? '0')
      || recordedBefore?.firstRun === 'completed' || recordedBefore?.firstRun === 'running')) {
    recordKns09FirstRun('failed', scope, message.confirmationId);
    return { ok: false, error: 'preview_stale' };
  }
  if (!command && preview.consumedAt !== undefined) return { ok: false, error: 'duplicate_confirm' };
  try {
    // Read-only digest rescan: BookmarkTreeApi.getTree only. No create/update/move/remove.
    const tree = await createChromeBookmarkTreeAdapter(await attempt.nativeApi(personalTreeApi())).read();
    const scan = scanBoundary({ roots: tree.roots, selectedNativeIds: [...preview.boundary.selectedNativeIds],
      excludedNativeIds: [...preview.boundary.excludedNativeIds],
      privateNativeIds: [...new Set([...await privateNativeIdsFor(scope), ...(preview.privateNativeIds ?? [])])],
      existingMounts: await syncState.listMountBindings(scope) });
    if (!command && scan.treeDigest !== preview.treeDigest) {
      recordKns09FirstRun('failed', scope, message.confirmationId);
      return previewStaleFromScan(scan);
    }
    await attempt.assertCurrent();
    await recordBoundaryDiagnostics(syncState, scope, scan, tree.roots, message.previewId);
    recordKns09FirstRun('started', scope, message.confirmationId);
    const rootNodeId = command ? command.payload.rootNodeId : libraryId ? await resolveLibraryRootId(libraryId) : undefined;
    await attempt.assertCurrent();
    command ??= await syncState.admitBoundaryCommand(scope, {
      kind: 'first-run', commandId: message.confirmationId, previewId: preview.previewId,
      requestDigest: firstRunRequestDigest(message), boundaryVersion: preview.boundaryVersion,
      treeDigest: preview.treeDigest, payload: { libraryId: libraryId ?? null, rootNodeId: rootNodeId ?? null },
    });
    if (command.state === 'committed') return command.result as unknown as FirstRunOrScopeResponse;
    const coordinator = createBootstrapCoordinator({
      store: syncState, scope,
      retireLegacy: async () => { await retireLegacyScopeForRemount(); },
    });
    await attempt.assertCurrent();
    const view = await coordinator.confirm({
      confirmationId: message.confirmationId, previewId: message.previewId, treeDigest: preview.treeDigest,
      confirmationVersion: preview.boundaryVersion, localFacts: localFactsFromRoots(tree.roots,
        preview.boundary.selectedNativeIds, preview.boundary.excludedNativeIds, await privateNativeIdsFor(scope),
        await syncState.listMountBindings(scope)),
      mounts: mountsFromPreview(preview.boundary.mounts),
      ...(libraryId ? { libraryId } : {}),
      rootNodeId: typeof command.payload.rootNodeId === 'string' ? command.payload.rootNodeId : null,
    });
    await persistConfirmedPreviewRoots(scope, preview, attempt, command.boundaryVersion);
    const recorded = await syncState.getScope(scope);
    if (view.report) recordKns09MergeAttention(scope, view.report.candidates.length, view.report.conflicts.length);
    recordKns09FirstRun(view.run.phase === 'completed' ? 'completed'
      : view.run.phase === 'needs_attention' ? 'attention' : 'started', scope, message.confirmationId);
    const result = withAttention(view.run.phase, recorded?.firstRun ?? 'running', view.run);
    await attempt.assertCurrent();
    await syncState.advanceBoundaryCommand(scope, command.commandId, { result: result as unknown as JsonObject });
    return result;
  } catch (error) {
    const code = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)
      ? error.message : 'confirmation_failed';
    if (command) {
      await syncState.advanceBoundaryCommand(scope, command.commandId, { error: code }).catch(() => undefined);
      return { ok: false, error: 'confirmation_pending' };
    }
    return { ok: false, error: code };
  }
}

async function resumePendingFirstRunConfirmation(scope: SyncScope): Promise<void> {
  const command = (await syncState.listPendingBoundaryCommands(scope)).find(row => row.kind === 'first-run');
  if (!command) return;
  if (typeof command.payload.libraryId !== 'string') throw new Error('confirmation_conflict');
  await handleFirstRunConfirm({ kind: 'known.firstRun.confirm', previewId: command.previewId,
    confirmationId: command.commandId, libraryId: command.payload.libraryId });
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
      const attempt = await captureBoundaryAttempt(scope);
      const authority = await readSnapshotAuthority(scope);
      const input = { ...await resumeConfirmInput(scope, run, attempt), remoteFacts: authority.snapshot.remoteFacts };
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

async function persistConfirmedPreviewRoots(scope: SyncScope, preview: ScopePreviewRecord | null,
  attempt: BoundaryAttempt, expectedBoundaryVersion?: string): Promise<void> {
  if (expectedBoundaryVersion !== undefined
      && (await syncState.getScope(scope))?.boundaryVersion !== expectedBoundaryVersion) return;
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
  const { discovered } = await readRootFolders(await attempt.nativeApi(personalTreeApi()));
  await attempt.assertCurrent();
  await persistFirstRunBrowserRoots(syncState, scope, {
    discovered, selectedNativeIds, privateNativeIds: preview?.privateNativeIds ?? await privateNativeIdsFor(scope),
    ...(expectedBoundaryVersion === undefined ? {} : { expectedBoundaryVersion }),
  });
}

async function privateNativeIdsFor(scope: SyncScope): Promise<string[]> {
  const recorded = await syncState.getScope(scope);
  const mappings = await syncState.listMappings(scope);
  const byColp = new Map(mappings.map((mapping) => [mapping.colpId, mapping.nativeId]));
  return (recorded?.privateRoots ?? []).map((id) => byColp.get(id)).filter((id): id is string => Boolean(id));
}
