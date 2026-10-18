import { SUBTREE_OBSERVATION_EXTENSION } from '@know-n/colp/sync/canonical';
import { detachScopeMount } from './scope-detach.js';
import { digestJson } from './bookmark-event-codec.js';
import { scanBoundary, type BoundaryScan } from './bookmark-boundary.js';
import { folderIsInMount, folderIsInSyncRange } from './bookmark-sync-range.js';
import type { NormalizedBookmarkRoot } from './chrome-bookmark-tree.js';
import { PREVIEW_TTL_MS } from './sync-state/mount-repository.js';
import { canonicalJson } from './sync-state/codec.js';
import { mappedSubtreeDeleteSource, remoteSubtreeMappings, scopeSubtreeDeleteSource } from './subtree-observation.js';
import type {
  MappingInput, MountBindingRecord, RemoteDeleteFreezeEntry, ScopePreviewRecord, SyncScope,
  createSyncStateStore,
} from './sync-state-store.js';
import { detectRangeShifts, keepShiftedMount, preserveShiftMappings, type RangeShiftCandidate } from './scope-range-shift.js';
import { countRemoteMountDescendants } from './scope-remote-count.js';
import { rangePreviewChanges, type RangePreviewChanges } from './range-preview-changes.js';

type Store = ReturnType<typeof createSyncStateStore>;

export interface RangeDiff {
  readonly addedNativeIds: readonly string[];
  readonly removedNativeIds: readonly string[];
  readonly shiftNativeIds: readonly string[];
  readonly shifts: readonly RangeShiftCandidate[];
}

export function liveAuthorityFromExport(exported: Awaited<ReturnType<Store['exportScope']>>) {
  return {
    scope: exported.scope, mappings: exported.mappings, queue: exported.queue,
    mountBindings: exported.mountBindings, bootstrapRuns: exported.bootstrapRuns,
  };
}

export function boundaryDigestFromScan(scan: Pick<BoundaryScan, 'selectedNativeIds' | 'excludedNativeIds' | 'mounts'>): string {
  return digestJson({
    selected: [...scan.selectedNativeIds], excluded: [...scan.excludedNativeIds],
    mounts: scan.mounts.map((mount) => mount.nativeRootId),
  });
}

/** Removing a range also reviews folders outside the next selection. */
export function rangeTreeDigest(roots: readonly NormalizedBookmarkRoot[], scan: Pick<BoundaryScan, 'treeDigest'>): string {
  return digestJson({ boundary: scan.treeDigest, tree: canonicalJson(roots) });
}

export function diffLiveRange(input: {
  readonly liveMounts: readonly MountBindingRecord[];
  readonly mappings: readonly MappingInput[];
  readonly selectedNativeIds: readonly string[];
  readonly excludedNativeIds?: readonly string[];
  readonly previousExcludedNativeIds?: readonly string[];
  readonly discovered: ReadonlyMap<string, readonly string[]>;
}): RangeDiff {
  const previousExcluded = new Set(input.previousExcludedNativeIds);
  const ancestors = (id: string) => input.discovered.get(id) ?? [];
  const liveSelected = input.liveMounts.filter((mount) => mount.status !== 'detached' && !mount.pendingShift
    && !folderIsInMount(mount.nativeRootId, ancestors(mount.nativeRootId), previousExcluded))
    .map((mount) => mount.nativeRootId);
  const next = new Set(input.selectedNativeIds);
  const excluded = new Set(input.excludedNativeIds);
  const included = (id: string) => folderIsInSyncRange(id, ancestors(id), next, excluded);
  const live = new Set(liveSelected);
  const shifts = detectRangeShifts(input);
  const shiftNative = new Set(shifts.map((row) => row.nativeRootId));
  const resumed = input.liveMounts.filter(mount => mount.status === 'detached' && !mount.pendingShift
    && included(mount.nativeRootId)).map(mount => mount.nativeRootId);
  const addedNativeIds = [...new Set([...input.selectedNativeIds.filter(id => included(id) && !live.has(id)), ...resumed])];
  // Selecting an ancestor keeps existing nested mounts in the sync range.
  const removedNativeIds = liveSelected.filter((id) => !included(id)
    && !shiftNative.has(id));
  return { addedNativeIds, removedNativeIds, shiftNativeIds: [...shiftNative], shifts };
}

export async function previewRangeChange(store: Store, scope: SyncScope, input: {
  readonly roots: readonly NormalizedBookmarkRoot[];
  readonly selectedNativeIds: readonly string[];
  readonly excludedNativeIds?: readonly string[];
  readonly privateNativeIds?: readonly string[];
  readonly discovered?: ReadonlyMap<string, readonly string[]>;
  readonly now?: () => number;
}): Promise<{
  readonly preview: ScopePreviewRecord; readonly scan: BoundaryScan; readonly diff: RangeDiff;
  readonly changes: RangePreviewChanges;
}> {
  const scan = scanBoundary({
    roots: input.roots, selectedNativeIds: input.selectedNativeIds,
    excludedNativeIds: input.excludedNativeIds ?? [], privateNativeIds: input.privateNativeIds ?? [],
  });
  const recorded = await store.getScope(scope);
  const liveMounts = await store.listMountBindings(scope);
  const mappings = await store.listMappings(scope);
  const discovered = input.discovered ?? discoveredFromRoots(input.roots);
  const previousPrivate = new Set((recorded?.privateRoots ?? []).map(id => mappings.find(row => row.colpId === id)?.nativeId).filter((id): id is string => Boolean(id)));
  const previousScan = scanBoundary({ roots: input.roots,
    selectedNativeIds: liveMounts.filter(mount => mount.status !== 'detached' && !mount.pendingShift).map(mount => mount.nativeRootId),
    privateNativeIds: [...previousPrivate] });
  const changes = rangePreviewChanges(input.roots, previousScan, scan);
  const mountDiff = diffLiveRange({
    liveMounts, mappings, selectedNativeIds: scan.selectedNativeIds, discovered,
    excludedNativeIds: [...scan.excludedNativeIds, ...(input.privateNativeIds ?? [])], previousExcludedNativeIds: [...previousPrivate],
  });
  const nextPrivate = new Set(input.privateNativeIds ?? []);
  const newlyPrivate = [...nextPrivate].filter(id => !previousPrivate.has(id)
    && mappings.some(row => row.nativeId === id && !row.projection.revision.startsWith('local-')));
  const reincluded = [...previousPrivate].filter(id => discovered.has(id) && (scan.selectedNativeIds.includes(id) || (discovered.get(id) ?? []).some(ancestor => scan.selectedNativeIds.includes(ancestor))) && !nextPrivate.has(id)
    && !(discovered.get(id) ?? []).some(ancestor => nextPrivate.has(ancestor)));
  const reincludedColp = new Set(mappings.filter(row => reincluded.includes(row.nativeId)
    || (discovered.get(row.nativeId) ?? []).some(ancestor => reincluded.includes(ancestor))).map(row => row.colpId));
  for (let after = 0;;) {
    const queued = await store.listQueue(scope, undefined, after, 1000);
    if (queued.some(row => row.opId.startsWith('range.private.') && reincludedColp.has(String(row.payload.targetId))
      && row.status !== 'rejected' && (row.status !== 'terminal' || !row.echoApplied))) throw new Error('sync_busy');
    if (queued.length < 1000) break;
    after = queued[queued.length - 1]!.sequence;
  }
  const diff: RangeDiff = { ...mountDiff,
    addedNativeIds: [...new Set([...mountDiff.addedNativeIds, ...reincluded])],
    removedNativeIds: [...new Set([...mountDiff.removedNativeIds, ...newlyPrivate])],
  };
  const now = input.now ?? Date.now;
  const previewId = crypto.randomUUID();
  const remoteDeleteEvidence = await remoteDeleteEvidenceFor(store, scope,
    [...new Set([...diff.removedNativeIds, ...diff.shiftNativeIds])]);
  const preview = await store.putScopePreview(scope, {
    previewId, boundaryVersion: recorded?.boundaryVersion ?? '0', treeDigest: rangeTreeDigest(input.roots, scan),
    bookmarkCount: scan.bookmarkCount, folderCount: scan.folderCount, skippedCount: scan.skippedCount,
    expiresAt: now() + PREVIEW_TTL_MS, warnings: scan.warnings,
    boundary: { selectedNativeIds: scan.selectedNativeIds, excludedNativeIds: scan.excludedNativeIds,
      mounts: scan.mounts },
    kind: 'range', boundaryDigest: boundaryDigestFromScan(scan),
    addedNativeIds: diff.addedNativeIds, removedNativeIds: diff.removedNativeIds,
    privateNativeIds: input.privateNativeIds ?? [], shiftNativeIds: diff.shiftNativeIds,
    ...(remoteDeleteEvidence.length ? { remoteDeleteEvidence } : {}),
  });
  return { preview, scan, diff, changes };
}

export function previewRejection(preview: ScopePreviewRecord | null, input: {
  readonly now: number; readonly liveBoundaryVersion: string; readonly treeDigest?: string;
}): 'request_invalid' | 'duplicate_confirm' | 'preview_stale' | null {
  if (!preview || preview.expiresAt <= input.now) return 'request_invalid';
  if (preview.consumedAt !== undefined) return 'duplicate_confirm';
  if ((preview.boundaryVersion ?? '0') !== input.liveBoundaryVersion) return 'preview_stale';
  if (input.treeDigest !== undefined && preview.treeDigest !== input.treeDigest) return 'preview_stale';
  return null;
}

export async function consumeRangePreview(store: Store, scope: SyncScope, preview: ScopePreviewRecord,
  now = Date.now()): Promise<void> {
  const { scopeKey: _scopeKey, ...row } = preview;
  await store.putScopePreview(scope, { ...row, consumedAt: now });
}

export async function applyConfirmedRange(store: Store, scope: SyncScope, input: {
  readonly preview: ScopePreviewRecord;
  readonly keepNativeIds: readonly string[];
  readonly unmountNativeIds: readonly string[];
  readonly remoteDeleteNativeIds?: readonly string[];
}): Promise<{ readonly kept: readonly string[]; readonly unmounted: readonly string[] }> {
  const mounts = await store.listMountBindings(scope);
  const byNative = new Map(mounts.map((mount) => [mount.nativeRootId, mount]));
  const keep = new Set(input.keepNativeIds);
  const unmount = new Set(input.unmountNativeIds);
  const kept: string[] = [];
  const unmounted: string[] = [];
  for (const nativeId of input.preview.shiftNativeIds ?? []) {
    const mount = byNative.get(nativeId);
    if (!mount) continue;
    if (keep.has(nativeId)) {
      const updated = await keepShiftedMount(store, scope, { mount, nativeRootId: nativeId });
      const colpId = updated.remoteMountNodeId ?? mount.pendingShift?.colpId;
      if (colpId) {
        await preserveShiftMappings(store, scope, {
          nativeRootId: nativeId, colpId, mountId: updated.mountId,
        });
      }
      kept.push(nativeId);
      continue;
    }
    if (unmount.has(nativeId) || !keep.has(nativeId)) {
      const detached = await detachScopeMount(store, scope, mount.mountId);
      const { scopeKey: _scopeKey, pendingShift: _shift, ...binding } = detached;
      await store.putMountBinding(scope, binding);
      unmounted.push(nativeId);
    }
  }
  for (const nativeId of input.preview.removedNativeIds ?? []) {
    if (keep.has(nativeId)) continue;
    const mount = byNative.get(nativeId);
    if (!mount || mount.status === 'detached') continue;
    // A private browser root keeps its role binding; deselecting it must stop
    // the mount too, otherwise ingress and a reload silently restore syncing.
    if (mount.rootRole && input.preview.boundary.selectedNativeIds.includes(nativeId)) continue;
    await detachScopeMount(store, scope, mount.mountId);
    unmounted.push(nativeId);
  }
  const existing = await store.listMountBindings(scope);
  await mergePreviewMounts(store, scope, existing, input.preview);
  return { kept, unmounted };
}

/** User-confirmed inclusion retires old tombstones and never-synced local identities. */
export async function releaseReincludedPrivateMappings(store: Store, scope: SyncScope, input: {
  readonly previousPrivateRoots: readonly string[]; readonly privateNativeIds: readonly string[];
  readonly discovered: ReadonlyMap<string, readonly string[]>;
}): Promise<void> {
  const mappings = await store.listMappings(scope);
  const oldRoots = mappings.filter(row => input.previousPrivateRoots.includes(row.colpId)).map(row => row.nativeId);
  for (const mapping of mappings) {
    const ancestors = input.discovered.get(mapping.nativeId) ?? [];
    const wasPrivate = oldRoots.includes(mapping.nativeId) || ancestors.some(id => oldRoots.includes(id));
    const staysPrivate = input.privateNativeIds.some(id => id === mapping.nativeId || ancestors.includes(id));
    if (!wasPrivate || staysPrivate) continue;
    if ((await store.getRemoteObservation(scope, mapping.colpId))?.kind === 'tombstone') await store.commitTombstoneMappingRepair(scope, mapping);
    else if (mapping.projection.revision === 'local-root') await store.deleteMapping(scope, mapping.nativeId);
  }
}

export async function mountIdForNative(store: Store, scope: SyncScope, nativeId: string): Promise<string | undefined> {
  const mount = (await store.listMountBindings(scope)).find((row) => row.nativeRootId === nativeId);
  return mount?.mountId;
}

/** A narrower selection takes ownership of its mapped subtree from a removed parent mount. */
export async function adoptSelectedSubtreeMappings(store: Store, scope: SyncScope, preview: ScopePreviewRecord,
  scan: BoundaryScan, discovered: ReadonlyMap<string, readonly string[]>): Promise<void> {
  const mounts = await store.listMountBindings(scope);
  const removed = new Set(preview.removedNativeIds);
  const byNative = new Map(mounts.filter(mount => mount.status === 'active').map(mount => [mount.nativeRootId, mount]));
  for (const mapping of await store.listMappings(scope)) {
    const source = mounts.find(mount => mount.mountId === mapping.mountId || mount.nativeRootId === mapping.rootNativeId);
    if (source?.status !== 'detached' || !removed.has(source.nativeRootId)) continue;
    const classification = scan.classifications.get(mapping.nativeId);
    if (classification !== 'ordinary-folder' && classification !== 'special-root') continue;
    const target = [mapping.nativeId, ...[...(discovered.get(mapping.nativeId) ?? [])].reverse()]
      .map(id => byNative.get(id)).find(mount => mount !== undefined);
    if (!target || !target.remoteMountNodeId) continue;
    const { scopeKey: _scopeKey, ...row } = mapping;
    await store.putMapping(scope, { ...row, rootNativeId: target.nativeRootId, mountId: target.mountId });
  }
}

export async function removalCounts(store: Store, scope: SyncScope, nativeIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const evidence = await remoteDeleteEvidenceFor(store, scope, nativeIds);
  const byNative = new Map(evidence.map((row) => [row.nativeRootId, row.affectedCount]));
  for (const nativeId of nativeIds) counts.set(nativeId, byNative.get(nativeId) ?? 0);
  return counts;
}

/** Validate every destructive choice before changing mounts or browser authority. */
export async function rangeRemoteDeletesMatch(store: Store, scope: SyncScope, preview: ScopePreviewRecord,
  nativeIds: readonly string[]): Promise<boolean> {
  if (!nativeIds.length) return true;
  const live = await remoteDeleteEvidenceFor(store, scope, nativeIds);
  return nativeIds.every(id => {
    const frozen = preview.remoteDeleteEvidence?.find(row => row.nativeRootId === id);
    const current = live.find(row => row.nativeRootId === id);
    return frozen !== undefined && current !== undefined && canonicalJson(frozen) === canonicalJson(current);
  });
}

async function remoteDeleteEvidenceFor(store: Store, scope: SyncScope, nativeIds: readonly string[]):
  Promise<readonly RemoteDeleteFreezeEntry[]> {
  const mounts = await store.listMountBindings(scope);
  const evidence: RemoteDeleteFreezeEntry[] = [];
  for (const nativeId of nativeIds) {
    const mount = mounts.find((row) => row.nativeRootId === nativeId);
    if (!mount) {
      const mapping = await store.getMappingByNativeId(scope, nativeId);
      if (!mapping || mapping.projection.revision.startsWith('local-') || (await store.getRemoteObservation(scope, mapping.colpId))?.kind === 'tombstone') continue;
      const subtreeSource = await scopeSubtreeDeleteSource(store, scope, mapping.colpId);
      const extensions = subtreeSource.extensions as Record<string, { count: number }>;
      evidence.push({ nativeRootId: nativeId, mountId: `excluded:${nativeId}`, remoteMountNodeId: mapping.colpId,
        boundaryVersion: (await store.getScope(scope))?.boundaryVersion ?? '0',
        affectedCount: extensions[SUBTREE_OBSERVATION_EXTENSION]!.count - 1, subtreeSource });
      continue;
    }
    if (!mount.remoteMountNodeId) throw new Error('mount_not_bound');
    evidence.push({
      nativeRootId: nativeId, mountId: mount.mountId, remoteMountNodeId: mount.remoteMountNodeId,
      affectedCount: await countRemoteMountDescendants(store, scope, mount),
      boundaryVersion: mount.boundaryVersion,
      subtreeSource: await scopeSubtreeDeleteSource(store, scope, mount.remoteMountNodeId),
      ...(mount.rootRole ? { contentDeletes: await freezeRoleContents(store, scope, mount.remoteMountNodeId) } : {}),
    });
  }
  return evidence;
}

export function discoveredFromRoots(roots: readonly NormalizedBookmarkRoot[]): Map<string, readonly string[]> {
  const discovered = new Map<string, readonly string[]>();
  const visit = (node: { readonly nativeId: string; readonly children: readonly { readonly nativeId: string;
    readonly children: readonly unknown[] }[] }, ancestors: readonly string[]) => {
    discovered.set(node.nativeId, ancestors);
    for (const child of node.children) {
      visit(child as { readonly nativeId: string; readonly children: readonly { readonly nativeId: string;
        readonly children: readonly unknown[] }[] }, [...ancestors, node.nativeId]);
    }
  };
  for (const root of roots) visit(root, []);
  return discovered;
}

export async function mergePreviewMounts(store: Store, scope: SyncScope, existing: readonly MountBindingRecord[],
  preview: ScopePreviewRecord): Promise<void> {
  const byRoot = new Map(existing.map((mount) => [mount.nativeRootId, mount]));
  for (const planned of preview.boundary.mounts.filter((mount) => mount.writable)) {
    const prior = byRoot.get(planned.nativeRootId);
    if (prior?.status === 'detached') continue;
    const { scopeKey: _scopeKey, pendingShift: _shift, pendingRemoteDelete: _pending,
      rootRole: _rootRole, customSourceKey: _customSourceKey, ...rest } = prior ?? {
      mountId: `mount:${planned.nativeRootId}`, nativeRootId: planned.nativeRootId, remoteMountNodeId: null,
      boundaryVersion: preview.boundaryVersion, materialized: planned.materialized, status: 'pending' as const,
    };
    byRoot.set(planned.nativeRootId, {
      scopeKey: preview.scopeKey, ...rest, nativeRootId: planned.nativeRootId,
      remoteMountNodeId: prior?.remoteMountNodeId ?? null,
      boundaryVersion: preview.boundaryVersion, materialized: planned.materialized,
      status: prior?.status === 'active' || prior?.status === 'pending' ? prior.status : 'pending',
      // The confirmed plan replaces the mutually exclusive mount identity fields.
      ...(planned.rootRole ? { rootRole: planned.rootRole } : {}),
      ...(planned.customSourceKey ? { customSourceKey: planned.customSourceKey } : {}),
    });
  }
  for (const mount of byRoot.values()) {
    const { scopeKey: _scopeKey, ...row } = mount;
    await store.putMountBinding(scope, row);
  }
}

async function freezeRoleContents(store: Store, scope: SyncScope, rootId: string) {
  const rows = await remoteSubtreeMappings(store, scope);
  const byNative = new Map(rows.map(row => [row.nativeId, row.colpId]));
  return rows.filter(row => (row.parentColpId ?? byNative.get(row.parentNativeId ?? '')) === rootId)
    .map(row => ({ targetId: row.colpId, kind: row.nodeKind ?? 'folder' as const,
      baseRevision: row.projection.revision, source: mappedSubtreeDeleteSource(row.colpId, rows) }));
}
