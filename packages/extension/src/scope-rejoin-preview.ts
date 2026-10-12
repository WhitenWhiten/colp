/**
 * Rejoin is preview → confirm → remote facts → detach baseline compare.
 * nativeId still present is not content equality; incomplete is never ok:true.
 */
import { digestJson } from './bookmark-event-codec.js';
import { rejoinScopeMount } from './scope-commands.js';
import { consumeRangePreview, previewRejection } from './scope-range.js';
import type { RejoinChrome } from './scope-rejoin-mutation.js';
import { PREVIEW_TTL_MS } from './sync-state/mount-repository.js';
import type {
  FirstRunOrScopeResponse, FirstRunPreviewOk,
} from './types.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;

export async function previewRejoinScopeMount(store: Store, scope: SyncScope, mountId: string,
  chrome?: Pick<RejoinChrome, 'getNative'>, options: { readonly now?: () => number; readonly ttlMs?: number } = {}):
  Promise<FirstRunPreviewOk | { readonly ok: false; readonly error: string }> {
  const mount = await store.getMountBinding(scope, mountId);
  if (!mount) return { ok: false, error: 'mount_not_found' };
  const now = options.now ?? Date.now;
  const warnings: { readonly code: string }[] = [];
  if (chrome) {
    let live = false;
    try { live = Boolean(await chrome.getNative(mount.nativeRootId)); } catch { live = false; }
    if (!live) warnings.push({ code: 'original_location_unavailable' });
  }
  const baseline = mount.pauseBaseline;
  const treeDigest = digestJson({
    mountId, boundaryVersion: mount.boundaryVersion,
    pauseBaseline: baseline ? {
      generation: baseline.generation, boundaryVersion: baseline.boundaryVersion,
      lastAppliedCursor: baseline.lastAppliedCursor, completeness: baseline.completeness,
    } : null,
  });
  const preview = await store.putScopePreview(scope, {
    previewId: crypto.randomUUID(), boundaryVersion: mount.boundaryVersion, treeDigest,
    bookmarkCount: 0, folderCount: 0, skippedCount: 0, expiresAt: now() + (options.ttlMs ?? PREVIEW_TTL_MS),
    warnings, boundary: {
      selectedNativeIds: [mount.nativeRootId], excludedNativeIds: [],
      mounts: [{
        nativeRootId: mount.nativeRootId, writable: true, materialized: mount.materialized,
        ...(mount.rootRole ? { rootRole: mount.rootRole } : {}),
        ...(mount.customSourceKey ? { customSourceKey: mount.customSourceKey } : {}),
      }],
    },
  });
  return {
    ok: true, previewId: preview.previewId, boundaryVersion: preview.boundaryVersion, treeDigest,
    bookmarkCount: 0, folderCount: 0, skippedCount: 0, warnings,
  };
}

export async function confirmRejoinScopeMount(store: Store, scope: SyncScope, input: {
  readonly mountId: string; readonly previewId: string; readonly treeDigest: string; readonly now?: () => number;
}, chrome: RejoinChrome, nativePresent: ReadonlySet<string>): Promise<FirstRunOrScopeResponse> {
  const recorded = await store.getScope(scope);
  const mount = await store.getMountBinding(scope, input.mountId);
  if (!mount) return { ok: false, error: 'mount_not_found' };
  const preview = await store.getScopePreview(scope, input.previewId);
  const rejected = previewRejection(preview, {
    now: (input.now ?? Date.now)(), liveBoundaryVersion: mount.boundaryVersion, treeDigest: input.treeDigest,
  });
  if (rejected === 'duplicate_confirm') return { ok: false, error: 'duplicate_confirm' };
  if (rejected === 'preview_stale') return { ok: false, error: 'preview_stale' };
  if (!preview || rejected) return { ok: false, error: 'request_invalid' };
  if (preview.boundary.selectedNativeIds[0] !== mount.nativeRootId) {
    return { ok: false, error: 'preview_stale' };
  }
  let result: Awaited<ReturnType<typeof rejoinScopeMount>>;
  try {
    result = await rejoinScopeMount(store, scope, input.mountId, nativePresent, [...nativePresent], chrome);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'command_in_flight' || code === 'permission_required') return { ok: false, error: code };
    throw error;
  }
  if (result.mount.status !== 'active') return { ok: false, error: 'rejoin_pending' };
  await consumeRangePreview(store, scope, preview, (input.now ?? Date.now)());
  return { ok: true, phase: 'syncing', firstRun: recorded?.firstRun ?? 'none' };
}
