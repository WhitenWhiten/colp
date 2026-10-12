import { personalTreeApi } from '../bookmark-subscriptions/personal-boundary.js';
import { localFactsFromRoots } from '../bootstrap/local-facts.js';
import { confirmAddRange, executeRemoteDelete, frozenRemoteDeleteCommand, rejoinScopeMount } from '../scope-commands.js';
import { collectNativeIds } from '../scope-reconcile.js';
import { nativeChromeFacts } from './native-chrome.js';
import { scanBoundary, countFolderContents } from '../bookmark-boundary.js';
import { createChromeBookmarkTreeAdapter } from '../chrome-bookmark-tree.js';
import { kns09Paused } from '../kns-09-release.js';
import {
  applyConfirmedRange, consumeRangePreview, discoveredFromRoots, previewRangeChange, previewRejection,
} from '../scope-range.js';
import type { ScopePreviewRecord, SyncScope } from '../sync-state-store.js';
import type {
  PublicRangeChangeRow, PublicRangePreview, PublicRangeShiftAction, RootRequest, RootResponse,
} from '../types.js';
import { recoverBookmarkEvents } from './bookmarks.js';
import { scheduleSyncEngineWake } from './engine.js';
import { hasBookmarkPermission, rootScopeKey, sw, syncState } from './runtime.js';
import { currentSyncScope } from './scope.js';
import { readRootFolders, sameDiscovered } from './roots.js';

type PreviewRequest = Extract<RootRequest, { readonly kind: 'known.roots.preview' }>;
type ConfirmRequest = Extract<RootRequest, { readonly kind: 'known.roots.confirm' }>;

export async function handleRangePreview(message: PreviewRequest): Promise<RootResponse> {
  let scope: SyncScope;
  try { scope = await currentSyncScope(); } catch { return { ok: false, error: 'not_connected' }; }
  if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
  if (await kns09Paused('ui')) return { ok: false, error: 'sync_paused' };
  const selected = resolveRefs(scope, message.viewId, message.selectedRefs);
  const privateLocal = resolveRefs(scope, message.viewId, message.privateRefs);
  if (!selected || !privateLocal) return { ok: false, error: 'request_invalid' };
  const current = await readRootFolders();
  if (!sw.rootViewTokens || !sameDiscovered(current.discovered, [...sw.rootViewTokens.entries.values()])) {
    sw.rootViewTokens = undefined; return { ok: false, error: 'request_invalid' };
  }
  const tree = await createChromeBookmarkTreeAdapter(personalTreeApi()).read();
  let previewResult: Awaited<ReturnType<typeof previewRangeChange>>;
  try {
    previewResult = await previewRangeChange(syncState, scope, {
      roots: tree.roots, selectedNativeIds: selected, privateNativeIds: privateLocal,
      discovered: discoveredFromRoots(tree.roots),
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'remote_subtree_unknown' || code === 'mount_not_bound' || code === 'mount_not_found') {
      return { ok: false, error: 'request_invalid' };
    }
    throw error;
  }
  const { preview, scan, diff } = previewResult;
  return { ok: true, preview: publicPreview(preview, scan.warnings, diff, tree.roots) };
}

export type RangeConfirmResult = { readonly ok: true } | Extract<RootResponse, { readonly ok: false }>;

export async function handleRangeConfirm(message: ConfirmRequest): Promise<RangeConfirmResult> {
  let scope: SyncScope;
  try { scope = await currentSyncScope(); } catch { return { ok: false, error: 'not_connected' }; }
  if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
  if (await kns09Paused('coordinator')) return { ok: false, error: 'sync_paused' };
  const recorded = await syncState.getScope(scope);
  if (recorded?.firstRun !== 'completed') return { ok: false, error: 'request_invalid' };
  const preview = await syncState.getScopePreview(scope, message.previewId);
  const rejected = previewRejection(preview, {
    now: Date.now(), liveBoundaryVersion: recorded.boundaryVersion ?? '0', treeDigest: message.treeDigest,
  });
  if (rejected === 'duplicate_confirm') return { ok: false, error: 'duplicate_confirm' };
  if (rejected === 'preview_stale') return { ok: false, error: 'preview_stale' };
  if (!preview || rejected) return { ok: false, error: 'request_invalid' };
  const tree = await createChromeBookmarkTreeAdapter(personalTreeApi()).read();
  const scan = scanBoundary({
    roots: tree.roots, selectedNativeIds: [...preview.boundary.selectedNativeIds],
    excludedNativeIds: [...preview.boundary.excludedNativeIds],
    privateNativeIds: preview.privateNativeIds ?? [],
  });
  if (scan.treeDigest !== preview.treeDigest) return { ok: false, error: 'preview_stale' };
  const keepNativeIds = resolveActionNativeIds(message.shiftActions, 'keep', preview.shiftNativeIds ?? []);
  const unmountNativeIds = resolveActionNativeIds(message.shiftActions, 'unmount', preview.shiftNativeIds ?? []);
  const remoteDeleteNativeIds = resolveRemoteDeleteNativeIds(message.remoteDeleteRefs, preview);
  if (!keepNativeIds || !unmountNativeIds || !remoteDeleteNativeIds) return { ok: false, error: 'request_invalid' };
  await applyConfirmedRange(syncState, scope, {
    preview, keepNativeIds, unmountNativeIds, remoteDeleteNativeIds,
  });
  const present = collectNativeIds(tree.roots);
  let addedPending = false;
  for (const nativeId of preview.addedNativeIds ?? []) {
    const mount = (await syncState.listMountBindings(scope)).find(row => row.nativeRootId === nativeId);
    if (mount?.status === 'detached') {
      const result = await rejoinScopeMount(syncState, scope, mount.mountId, present, [...present], nativeChromeFacts());
      if (result.mount.status !== 'active') return { ok: false, error: 'request_invalid' };
    } else if (mount) {
      addedPending = true;
    }
  }
  if (addedPending) {
    const started = await confirmAddRange(syncState, scope, {
      previewId: preview.previewId, confirmationId: message.confirmationId, treeDigest: preview.treeDigest,
      localFacts: localFactsFromRoots(tree.roots, preview.boundary.selectedNativeIds,
        preview.boundary.excludedNativeIds, preview.privateNativeIds ?? []),
      ...(await collectionRootNodeId(scope)),
    });
    if (!started.ok) {
      if (started.error === 'sync_paused' || started.error === 'preview_stale'
          || started.error === 'duplicate_confirm') {
        return { ok: false, error: started.error };
      }
      return { ok: false, error: 'request_invalid' };
    }
  }
  for (const nativeId of remoteDeleteNativeIds) {
    const deleted = await remoteDeleteMount(scope, preview, nativeId);
    if (!deleted.ok) {
      if (deleted.error === 'sync_paused' || deleted.error === 'preview_stale') {
        return { ok: false, error: deleted.error };
      }
      return { ok: false, error: 'request_invalid' };
    }
  }
  const selectedNativeIds = unique([
    ...scan.selectedNativeIds, ...keepNativeIds,
  ]);
  const { discovered } = await readRootFolders();
  await syncState.configureBrowserRoots(scope, {
    discovered, selectedNativeIds, privateNativeIds: preview.privateNativeIds ?? [], status: 'ready',
  });
  await syncState.bumpBoundaryVersion(scope);
  await consumeRangePreview(syncState, scope, preview);
  await recoverBookmarkEvents();
  scheduleSyncEngineWake('manual');
  return { ok: true };
}

function publicPreview(preview: ScopePreviewRecord, warnings: readonly { readonly code: string }[],
  diff: { readonly addedNativeIds: readonly string[]; readonly removedNativeIds: readonly string[];
    readonly shiftNativeIds: readonly string[] },
  roots: readonly { readonly nativeId: string; readonly title: string; readonly kind: string;
    readonly children: readonly unknown[] }[]): PublicRangePreview {
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
    addedCount: diff.addedNativeIds.length, removedCount: diff.removedNativeIds.length,
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
  const out: string[] = [];
  for (const row of actions) {
    if (row.action !== action) continue;
    const nativeId = nativeForRef(row.ref);
    if (!nativeId || !allowedSet.has(nativeId)) return null;
    out.push(nativeId);
  }
  if (action === 'unmount') {
    const keep = new Set(actions.filter((row) => row.action === 'keep').map((row) => nativeForRef(row.ref)));
    for (const nativeId of allowed) if (!keep.has(nativeId) && !out.includes(nativeId)) out.push(nativeId);
  }
  return out;
}

function resolveRemoteDeleteNativeIds(refs: readonly string[] | undefined, preview: ScopePreviewRecord): string[] | null {
  if (!refs || refs.length === 0) return [];
  const allowed = new Set([...(preview.removedNativeIds ?? []), ...(preview.shiftNativeIds ?? [])]);
  const out: string[] = [];
  for (const ref of refs) {
    const nativeId = nativeForRef(ref);
    if (!nativeId || !allowed.has(nativeId)) return null;
    out.push(nativeId);
  }
  return out;
}

async function remoteDeleteMount(scope: SyncScope, preview: ScopePreviewRecord, nativeId: string):
  Promise<{ ok: true } | { ok: false; error: string }> {
  const command = frozenRemoteDeleteCommand(preview, nativeId);
  if (!command) return { ok: false, error: 'request_invalid' };
  const result = await executeRemoteDelete(syncState, scope, command);
  if (result.ok) return { ok: true };
  if (result.error === 'confirmation_mismatch') return { ok: false, error: 'preview_stale' };
  return { ok: false, error: result.error };
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
