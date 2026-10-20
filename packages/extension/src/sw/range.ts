import { personalTreeApi } from '../bookmark-subscriptions/personal-boundary.js';
import { scanBoundary, countFolderContents } from '../bookmark-boundary.js';
import { createChromeBookmarkTreeAdapter } from '../chrome-bookmark-tree.js';
import { kns09Paused } from '../kns-09-release.js';
import {
  discoveredFromRoots, previewRangeChange, previewRejection, rangeTreeDigest, rangeRemoteDeletesMatch,
} from '../scope-range.js';
import type { BoundaryCommandRecord, JsonObject, ScopePreviewRecord, SyncScope } from '../sync-state-store.js';
import type {
  PublicRangeChangeRow, PublicRangePreview, PublicRangeShiftAction, RootRequest, RootResponse,
} from '../types.js';
import { recoverBookmarkEvents } from './bookmarks.js';
import { scheduleSyncEngineWake } from './engine.js';
import { hasBookmarkPermission, rootScopeKey, sw, syncState } from './runtime.js';
import { currentSyncScope } from './scope.js';
import { readRootFolders, sameDiscovered } from './roots.js';
import { rangePreviewChanges, type RangePreviewChanges } from '../range-preview-changes.js';
import { captureBoundaryAttempt, type BoundaryAttempt } from './boundary-attempt.js';
import { digestJson } from '../bookmark-event-codec.js';
import { runBoundaryConfirmation } from './boundary-confirmation.js';
import { executeRangeCommand, type PreparedRangeCommand } from './range-command.js';
import { freezeRangeDeletions } from './range-remote-commands.js';

type PreviewRequest = Extract<RootRequest, { readonly kind: 'known.roots.preview' }>;
type ConfirmRequest = Extract<RootRequest, { readonly kind: 'known.roots.confirm' }>;

export async function handleRangePreview(message: PreviewRequest): Promise<RootResponse> {
  let scope: SyncScope;
  try { scope = await currentSyncScope(); } catch { return { ok: false, error: 'not_connected' }; }
  if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
  if (await kns09Paused('ui')) return { ok: false, error: 'sync_paused' };
  if ((await syncState.listPendingBoundaryCommands(scope)).length) return { ok: false, error: 'sync_busy' };
  const attempt = await captureBoundaryAttempt(scope);
  const selected = resolveRefs(scope, message.viewId, message.selectedRefs);
  const privateLocal = resolveRefs(scope, message.viewId, message.privateRefs);
  if (!selected || !privateLocal) return { ok: false, error: 'request_invalid' };
  const current = await readRootFolders(await attempt.nativeApi(personalTreeApi()));
  if (!sw.rootViewTokens || !sameDiscovered(current.discovered, [...sw.rootViewTokens.entries.values()])) {
    sw.rootViewTokens = undefined; return { ok: false, error: 'request_invalid' };
  }
  const tree = await createChromeBookmarkTreeAdapter(await attempt.nativeApi(personalTreeApi())).read();
  let previewResult: Awaited<ReturnType<typeof previewRangeChange>>;
  try {
    previewResult = await previewRangeChange(syncState, scope, {
      roots: tree.roots, selectedNativeIds: selected, privateNativeIds: privateLocal,
      discovered: discoveredFromRoots(tree.roots), assertCurrent: attempt.assertCurrent,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'sync_busy') return { ok: false, error: 'sync_busy' };
    if (code === 'remote_subtree_unknown' || code === 'mount_not_bound' || code === 'mount_not_found') {
      return { ok: false, error: 'request_invalid' };
    }
    throw error;
  }
  const { preview, scan, diff, changes } = previewResult;
  return { ok: true, preview: publicPreview(preview, scan.warnings, diff, tree.roots, changes) };
}

export type RangeConfirmResult = { readonly ok: true } | Extract<RootResponse, { readonly ok: false }>;
const confirmations = new Map<string, Promise<RangeConfirmResult>>();

export async function handleRangeConfirm(message: ConfirmRequest): Promise<RangeConfirmResult> {
  let scope: SyncScope;
  try { scope = await currentSyncScope(); } catch { return { ok: false, error: 'not_connected' }; }
  const receipt = await syncState.getBoundaryCommand(scope, message.confirmationId);
  if (receipt?.state === 'committed' && receipt.kind === 'range'
      && receipt.requestDigest === rangeRequestDigest(message)) return receipt.result as unknown as RangeConfirmResult;
  const attempt = await captureBoundaryAttempt(scope);
  return runBoundaryConfirmation(scope, `range:${message.confirmationId}:${rangeRequestDigest(message)}`, async () => {
    const key = rootScopeKey(scope);
    const prior = confirmations.get(key) ?? Promise.resolve({ ok: true } as const);
    const pending = prior.catch(() => undefined).then(async (): Promise<RangeConfirmResult> => {
      try { if (rootScopeKey(await currentSyncScope()) !== key) return { ok: false, error: 'not_connected' }; }
      catch { return { ok: false, error: 'not_connected' }; }
      return confirmRange(message, scope, attempt);
    });
    confirmations.set(key, pending);
    try { return await pending; }
    finally { if (confirmations.get(key) === pending) confirmations.delete(key); }
  });
}

function rangeRequestDigest(message: ConfirmRequest): string {
  return digestJson({ kind: message.kind, previewId: message.previewId, treeDigest: message.treeDigest,
    shiftActions: message.shiftActions ?? [], remoteDeleteRefs: message.remoteDeleteRefs ?? [] } as unknown as JsonObject);
}

async function confirmRange(message: ConfirmRequest, scope: SyncScope, attempt: BoundaryAttempt): Promise<RangeConfirmResult> {
  let command = await syncState.getBoundaryCommand(scope, message.confirmationId);
  if (command && (command.kind !== 'range' || command.requestDigest !== rangeRequestDigest(message))) {
    return { ok: false, error: 'confirmation_conflict' };
  }
  if (command?.state === 'committed') return command.result as unknown as RangeConfirmResult;
  if (!await hasBookmarkPermission()) return command ? pendingRangeFailure(command, 'permission_required')
    : { ok: false, error: 'permission_required' };
  if (await kns09Paused('coordinator')) return command ? pendingRangeFailure(command, 'sync_paused')
    : { ok: false, error: 'sync_paused' };
  if (command) return finishRangeCommand(scope, command, attempt);
  if ((await syncState.listPendingBoundaryCommands(scope)).length) return { ok: false, error: 'sync_busy' };
  const recorded = await syncState.getScope(scope);
  if (recorded?.firstRun !== 'completed') return { ok: false, error: 'request_invalid' };
  const preview = await syncState.getScopePreview(scope, message.previewId);
  const rejected = previewRejection(preview, {
    now: Date.now(), liveBoundaryVersion: recorded.boundaryVersion ?? '0', treeDigest: message.treeDigest,
  });
  if (rejected === 'duplicate_confirm') return { ok: false, error: 'duplicate_confirm' };
  if (rejected === 'preview_stale') return { ok: false, error: 'preview_stale' };
  if (!preview || rejected || preview.kind !== 'range') return { ok: false, error: 'request_invalid' };
  const tree = await createChromeBookmarkTreeAdapter(await attempt.nativeApi(personalTreeApi())).read();
  const scan = scanBoundary({
    roots: tree.roots, selectedNativeIds: [...preview.boundary.selectedNativeIds],
    excludedNativeIds: [...preview.boundary.excludedNativeIds],
    privateNativeIds: preview.privateNativeIds ?? [],
    existingMounts: await syncState.listMountBindings(scope),
  });
  if (rangeTreeDigest(tree.roots, scan) !== preview.treeDigest) return { ok: false, error: 'preview_stale' };
  const keepNativeIds = resolveActionNativeIds(message.shiftActions, 'keep', preview.shiftNativeIds ?? []);
  const unmountNativeIds = resolveActionNativeIds(message.shiftActions, 'unmount', preview.shiftNativeIds ?? []);
  const remoteDeleteNativeIds = resolveRemoteDeleteNativeIds(message.remoteDeleteRefs, preview, unmountNativeIds ?? []);
  if (!keepNativeIds || !unmountNativeIds || !remoteDeleteNativeIds) return { ok: false, error: 'request_invalid' };
  const stopped = new Set(unmountNativeIds);
  const selectedNativeIds = unique([...scan.selectedNativeIds.filter(id => !stopped.has(id)), ...keepNativeIds]);
  const discoveredTree = discoveredFromRoots(tree.roots);
  const privateNativeIds = unique([...(preview.privateNativeIds ?? []), ...unmountNativeIds.filter(id =>
    (discoveredTree.get(id) ?? []).some(ancestor => selectedNativeIds.includes(ancestor)))]);
  try {
    if (!await rangeRemoteDeletesMatch(syncState, scope, preview, remoteDeleteNativeIds)) return { ok: false, error: 'preview_stale' };
  } catch { return { ok: false, error: 'preview_stale' }; }
  const mounts = await syncState.listMountBindings(scope);
  const added = (preview.addedNativeIds ?? []).filter(id => !stopped.has(id)
    && !(discoveredTree.get(id) ?? []).some(ancestor => stopped.has(ancestor)));
  const rejoinNativeIds = added.filter(id => mounts.find(row => row.nativeRootId === id)?.status === 'detached');
  const mappings = await syncState.listMappings(scope);
  const previousPrivateRoots = recorded.privateRoots ?? [];
  const previousPrivateNativeIds = mappings.filter(row => previousPrivateRoots.includes(row.colpId)).map(row => row.nativeId);
  const previousScan = scanBoundary({ roots: tree.roots, privateNativeIds: previousPrivateNativeIds,
    selectedNativeIds: mounts.filter(row => row.status !== 'detached' && !row.pendingShift).map(row => row.nativeRootId),
    existingMounts: mounts });
  const uiPreview = publicPreview(preview, preview.warnings, { addedNativeIds: preview.addedNativeIds ?? [],
    removedNativeIds: preview.removedNativeIds ?? [], shiftNativeIds: preview.shiftNativeIds ?? [] }, tree.roots, rangePreviewChanges(tree.roots, previousScan, scan));
  const payload: PreparedRangeCommand = { request: message, libraryId: scope.collectionId,
    // Counts and opaque refs are enough to reopen an already confirmed change.
    // Do not persist excluded folders' titles in the command journal.
    preview: { ...uiPreview, additions: uiPreview.additions.map(row => ({ ...row, title: '', path: '' })), shifts: uiPreview.shifts.map(row => ({ ...row, title: '' })),
      removals: uiPreview.removals.map(row => ({ ...row, title: '' })) },
    selectedNativeIds, privateNativeIds, keepNativeIds, unmountNativeIds,
    previousPrivateRoots, previousPrivateNativeIds, rejoinNativeIds, bootstrapNeeded: added.some(id => !rejoinNativeIds.includes(id)),
    deletions: await freezeRangeDeletions(scope, preview, remoteDeleteNativeIds), ...(await collectionRootNodeId(scope)),
  };
  try {
    await attempt.assertCurrent();
    command = await syncState.admitBoundaryCommand(scope, { kind: 'range', commandId: message.confirmationId,
      previewId: preview.previewId, requestDigest: rangeRequestDigest(message), boundaryVersion: preview.boundaryVersion,
      treeDigest: preview.treeDigest, payload: payload as unknown as JsonObject });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { ok: false, error: code === 'sync_busy' || code === 'preview_stale' || code === 'duplicate_confirm'
      || code === 'confirmation_conflict' ? code : 'root_update_failed' };
  }
  return finishRangeCommand(scope, command, attempt);
}

async function finishRangeCommand(scope: SyncScope, command: BoundaryCommandRecord, attempt: BoundaryAttempt): Promise<RangeConfirmResult> {
  try {
    const preview = await syncState.getScopePreview(scope, command.previewId);
    if (!preview || preview.consumedBy !== command.commandId) throw new Error('preview_stale');
    await executeRangeCommand(scope, command, preview, attempt);
  } catch (error) {
    const latest = await syncState.getBoundaryCommand(scope, command.commandId);
    if (latest?.state === 'committed') return latest.result as unknown as RangeConfirmResult;
    const code = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)
      ? error.message : 'root_update_failed';
    await syncState.advanceBoundaryCommand(scope, command.commandId, { error: code }).catch(() => undefined);
    return pendingRangeFailure(command, code);
  }
  // Admission and completion are already durable. A missed wake is recovered
  // by the normal startup/periodic engine, and must never turn a commit into an error.
  try { await recoverBookmarkEvents(); } catch { /* Keep the committed result. */ }
  scheduleSyncEngineWake('manual');
  return { ok: true };
}

function pendingRangeFailure(command: BoundaryCommandRecord, error: string): RangeConfirmResult {
  return { ok: false, error: 'confirmation_pending', confirmation: {
    confirmationId: command.commandId, state: 'failed', error } };
}

export async function resumePendingRangeConfirmation(scope: SyncScope): Promise<void> {
  const command = (await syncState.listPendingBoundaryCommands(scope)).find(row => row.kind === 'range');
  if (!command) return;
  const payload = command.payload as unknown as PreparedRangeCommand;
  if (payload.request?.confirmationId !== command.commandId || payload.libraryId !== scope.collectionId) return;
  await handleRangeConfirm(payload.request);
}

export async function pendingRangeDescription(scope: SyncScope) {
  const command = (await syncState.listPendingBoundaryCommands(scope)).find(row => row.kind === 'range');
  if (!command) return {};
  const payload = command.payload as unknown as PreparedRangeCommand;
  return { confirmation: { confirmationId: command.commandId, state: command.state,
    ...(command.error ? { error: command.error } : {}) },
  resume: { libraryId: scope.collectionId, request: payload.request, preview: payload.preview } };
}

function publicPreview(preview: ScopePreviewRecord, warnings: readonly { readonly code: string }[],
  diff: { readonly addedNativeIds: readonly string[]; readonly removedNativeIds: readonly string[];
    readonly shiftNativeIds: readonly string[] },
  roots: readonly { readonly nativeId: string; readonly title: string; readonly kind: string;
    readonly children: readonly unknown[] }[], changes: RangePreviewChanges): PublicRangePreview {
  const byNative = indexFolders(roots);
  const counts = new Map((preview.remoteDeleteEvidence ?? []).map((row) => [row.nativeRootId, row.affectedCount]));
  const row = (nativeId: string): PublicRangeChangeRow | undefined => {
    const ref = refForNative(nativeId);
    if (!ref) return undefined;
    const node = byNative.get(nativeId);
    const counted = node ? countFolderContents(node) : { bookmarkCount: 0, folderCount: 0 };
    return {
      ref, title: node?.title ?? '',
      bookmarkCount: counted.bookmarkCount, folderCount: counted.folderCount,
      affectedCount: counts.get(nativeId) ?? 0,
    };
  };
  return {
    previewId: preview.previewId, boundaryVersion: preview.boundaryVersion, treeDigest: preview.treeDigest,
    bookmarkCount: preview.bookmarkCount, folderCount: preview.folderCount, skippedCount: preview.skippedCount,
    addedCount: changes.addedFolders.length, addedBookmarkCount: changes.addedBookmarkCount,
    additions: changes.addedFolders.flatMap(folder => {
      const ref = refForNative(folder.nativeId);
      return ref ? [{ ref, title: folder.title, path: folder.path, bookmarkCount: folder.bookmarkCount }] : [];
    }), removedCount: diff.removedNativeIds.length,
    shiftCount: diff.shiftNativeIds.length, expiresAt: preview.expiresAt, warnings,
    shifts: diff.shiftNativeIds.map(row).filter((item): item is PublicRangeChangeRow => Boolean(item)),
    removals: diff.removedNativeIds.map(row).filter((item): item is PublicRangeChangeRow => Boolean(item)),
  };
}

function indexFolders(nodes: readonly { readonly nativeId: string; readonly title: string; readonly kind: string;
  readonly children: readonly unknown[] }[]): Map<string, { title: string; kind: string;
    children: readonly { kind: string; children: readonly unknown[] }[] }> {
  const out = new Map<string, { title: string; kind: string;
    children: readonly { kind: string; children: readonly unknown[] }[] }>();
  const visit = (node: { readonly nativeId: string; readonly title: string; readonly kind: string;
    readonly children: readonly unknown[] }) => {
    out.set(node.nativeId, node as never);
    for (const child of node.children) visit(child as never);
  };
  for (const node of nodes) visit(node);
  return out;
}

function refForNative(nativeId: string): string | undefined {
  if (!sw.rootViewTokens) return undefined;
  for (const [ref, entry] of sw.rootViewTokens.entries) {
    if (entry.nativeId === nativeId) return ref;
  }
  return undefined;
}

function nativeForRef(ref: string): string | undefined {
  return sw.rootViewTokens?.entries.get(ref)?.nativeId;
}

function resolveRefs(scope: SyncScope, viewId: string, refs: readonly string[]) {
  if (!Array.isArray(refs) || refs.length > 128 || refs.some((ref) => typeof ref !== 'string')) return null;
  if (!sw.rootViewTokens || sw.rootViewTokens.viewId !== viewId || sw.rootViewTokens.scopeKey !== rootScopeKey(scope)) {
    return null;
  }
  const resolved = refs.map((ref) => sw.rootViewTokens!.entries.get(ref)?.nativeId);
  return resolved.some((value) => !value) ? null : resolved as string[];
}

function resolveActionNativeIds(actions: readonly PublicRangeShiftAction[] | undefined, action: 'keep' | 'unmount',
  allowed: readonly string[]): string[] | null {
  if (!actions) return action === 'keep' ? [] : [...allowed];
  const allowedSet = new Set(allowed);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of actions) {
    const nativeId = nativeForRef(row.ref);
    if (!nativeId || !allowedSet.has(nativeId) || seen.has(nativeId)) return null;
    seen.add(nativeId);
    if (row.action !== action) continue;
    out.push(nativeId);
  }
  if (action === 'unmount') {
    const keep = new Set(actions.filter((row) => row.action === 'keep').map((row) => nativeForRef(row.ref)));
    for (const nativeId of allowed) if (!keep.has(nativeId) && !out.includes(nativeId)) out.push(nativeId);
  }
  return out;
}

function resolveRemoteDeleteNativeIds(refs: readonly string[] | undefined, preview: ScopePreviewRecord,
  unmountNativeIds: readonly string[]): string[] | null {
  if (!refs || refs.length === 0) return [];
  const allowed = new Set([...(preview.removedNativeIds ?? []), ...unmountNativeIds]);
  const out: string[] = [];
  for (const ref of refs) {
    const nativeId = nativeForRef(ref);
    if (!nativeId || !allowed.has(nativeId)) return null;
    out.push(nativeId);
  }
  return out;
}


function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

async function collectionRootNodeId(scope: SyncScope): Promise<{ readonly rootNodeId: string } | Record<string, never>> {
  const header = await syncState.getRecoveryHeader(scope);
  if (typeof header?.rootNodeId === 'string' && header.rootNodeId) return { rootNodeId: header.rootNodeId };
  const mapped = (await syncState.listMappings(scope)).find((row) => row.projection.content?.folderRole === 'root');
  if (mapped && !mapped.colpId.startsWith('pending-') && !mapped.colpId.startsWith('mount:')) {
    return { rootNodeId: mapped.colpId };
  }
  return {};
}
