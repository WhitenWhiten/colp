import type { RejoinChrome } from './scope-rejoin-mutation.js';
import { detachScopeMount } from './scope-detach.js';
export { detachScopeMount } from './scope-detach.js';
import { createBootstrapCoordinator, type ConfirmInput } from './bootstrap/coordinator.js';
import { digestJson } from './bookmark-event-codec.js';
import { scopeSubtreeDeleteSource } from './subtree-observation.js';
import {
  deletionNodeKind, deletionOperationType, type DeletionNodeKind,
} from './bookmark-deletion-scope.js';
import { COLP_QUEUE_STAMP } from './colp-queue-stamp.js';
import { isProtocolOpaqueId } from './protocol-id.js';
import { kns09Paused } from './kns-09-release.js';
import { classifyRejoinMappings, type RejoinClassification } from './scope-reconcile.js';
import { unmountedRejoinMembers } from './scope-rejoin-materialize.js';
import { applyRejoinObservations } from './scope-rejoin-reconcile.js';
import { consumeRangePreview, previewRangeChange, previewRejection } from './scope-range.js';
import { countRemoteMountDescendants } from './scope-remote-count.js';
import type {
  FirstRunOrScopeResponse, FirstRunPreviewOk,
} from './types.js';
import type {
  JsonObject, MappingInput, MountBindingRecord, RemoteDeleteFreezeEntry, ScopePreviewRecord, SyncScope,
  createSyncStateStore,
} from './sync-state-store.js';
import type { NormalizedBookmarkRoot } from './chrome-bookmark-tree.js';

type Store = ReturnType<typeof createSyncStateStore>;

export function mintRemoteDeleteConfirmation(input: {
  readonly mountId: string; readonly affectedCount: number; readonly boundaryVersion: string;
}): string {
  return digestJson({ kind: 'known.scope.remoteDelete', mountId: input.mountId,
    affectedCount: input.affectedCount, boundaryVersion: input.boundaryVersion });
}

export function frozenRemoteDeleteCommand(preview: ScopePreviewRecord, nativeId: string): {
  readonly mountId: string; readonly confirmationToken: string; readonly affectedCount: number;
  readonly previewId: string;
} | null {
  const frozen = preview.remoteDeleteEvidence?.find((row) => row.nativeRootId === nativeId);
  if (!frozen) return null;
  return {
    mountId: frozen.mountId, affectedCount: frozen.affectedCount, previewId: preview.previewId,
    confirmationToken: mintRemoteDeleteConfirmation({
      mountId: frozen.mountId, affectedCount: frozen.affectedCount, boundaryVersion: frozen.boundaryVersion,
    }),
  };
}

export async function countMountAffected(store: Store, scope: SyncScope, mountId: string): Promise<number> {
  const mount = await store.getMountBinding(scope, mountId);
  if (!mount) throw new Error('mount_not_found');
  return countRemoteMountDescendants(store, scope, mount);
}

export async function rejoinScopeMount(store: Store, scope: SyncScope, mountId: string,
  nativePresent: ReadonlySet<string>, extraNativeIds: readonly string[] = [], chrome?: RejoinChrome): Promise<{
    readonly mount: MountBindingRecord; readonly classification: RejoinClassification;
  }> {
  let mount = await store.getMountBinding(scope, mountId);
  if (!mount) throw new Error('mount_not_found');
  if ((await store.getScope(scope))?.rootStatus === 'permission_required') {
    await store.putScopeCommandPlan(scope, {
      commandId: `rejoin:${mount.mountId}`, kind: 'rejoin', confirmationVersion: mount.boundaryVersion,
      baselineDigest: mount.pauseBaseline?.lastAppliedCursor ?? null, phase: 'pending',
      dependencies: [], updatedAt: Date.now(), mountId: mount.mountId, retryReason: 'permission_required',
    });
    const mappings = await store.listMappings(scope);
    return { mount, classification: classifyRejoinMappings({ mount, mappings, nativePresent, extraNativeIds }) };
  }
  if (chrome) {
    const result = await applyRejoinObservations({ store, scope, mount, ...chrome });
    const leftover = unmountedRejoinMembers(await store.listMappings(scope), mount);
    if (!result.unknown && !result.conflicts && leftover.length === 0) {
      mount = await store.rejoinMount(scope, mountId);
    }
  }
  const mappings = await store.listMappings(scope);
  return { mount, classification: classifyRejoinMappings({ mount, mappings, nativePresent, extraNativeIds }) };
}

export async function executeRemoteDelete(store: Store, scope: SyncScope, command: {
  readonly mountId: string; readonly confirmationToken: string; readonly affectedCount: number;
  readonly previewId?: string;
}): Promise<FirstRunOrScopeResponse> {
  if (await kns09Paused('ui')) return { ok: false, error: 'sync_paused' };
  if (command.previewId && command.mountId.startsWith('excluded:')) {
    const frozen = await loadRemoteDeleteFreeze(store, scope, command);
    if (!frozen?.subtreeSource || command.affectedCount !== frozen.affectedCount || command.confirmationToken !== mintRemoteDeleteConfirmation({
      mountId: command.mountId, affectedCount: frozen.affectedCount, boundaryVersion: frozen.boundaryVersion,
    })) return { ok: false, error: 'preview_stale' };
    const mapping = await store.getMappingByNativeId(scope, frozen.nativeRootId);
    if (!mapping || mapping.colpId !== frozen.remoteMountNodeId
      || !(await store.getScope(scope))?.privateRoots?.includes(mapping.colpId)) return { ok: false, error: 'preview_stale' };
    const opId = `range.private.${digestJson([command.previewId, frozen.nativeRootId]).slice(7)}`;
    if (!await store.getQueueByOpId(scope, opId)) {
      const source = await scopeSubtreeDeleteSource(store, scope, mapping.colpId);
      if (digestJson(source) !== digestJson(frozen.subtreeSource)) return { ok: false, error: 'preview_stale' };
      await enqueueColpDelete(store, scope, { opId, targetId: mapping.colpId, kind: mapping.nodeKind,
        baseRevision: mapping.projection.revision, source });
    }
    return { ok: true, phase: 'syncing', firstRun: 'completed' };
  }
  const mount = await store.getMountBinding(scope, command.mountId);
  if (!mount) return { ok: false, error: command.previewId ? 'preview_stale' : 'mount_not_found' };
  if (!mount.remoteMountNodeId) return { ok: false, error: command.previewId ? 'preview_stale' : 'mount_not_bound' };
  const freeze = await loadRemoteDeleteFreeze(store, scope, command);
  if (command.previewId && !freeze) return { ok: false, error: 'preview_stale' };
  const affectedCount = freeze?.affectedCount ?? command.affectedCount;
  const boundaryVersion = freeze?.boundaryVersion ?? mount.boundaryVersion;
  const expected = mintRemoteDeleteConfirmation({
    mountId: command.mountId, affectedCount, boundaryVersion,
  });
  if (command.confirmationToken !== expected) return { ok: false, error: 'confirmation_mismatch' };
  if (freeze && command.affectedCount !== freeze.affectedCount) {
    return { ok: false, error: 'confirmation_mismatch' };
  }
  if (mount.rootRole) {
    if (!command.previewId || !freeze?.subtreeSource || !freeze.contentDeletes || freeze.remoteMountNodeId !== mount.remoteMountNodeId
      || freeze.boundaryVersion !== mount.boundaryVersion) return { ok: false, error: 'preview_stale' };
    const operations = freeze.contentDeletes.map(child => ({ ...child,
      opId: `range.private.${digestJson([command.previewId!, child.targetId]).slice(7)}` }));
    // A retry resumes the frozen plan even after some children have echoed.
    if (!(await Promise.all(operations.map(child => store.getQueueByOpId(scope, child.opId)))).some(Boolean)) {
      const source = await scopeSubtreeDeleteSource(store, scope, mount.remoteMountNodeId);
      if (digestJson(source) !== digestJson(freeze.subtreeSource)) return { ok: false, error: 'preview_stale' };
    }
    for (const child of operations) await enqueueColpDelete(store, scope, child);
    return { ok: true, phase: 'syncing', firstRun: 'completed' };
  }
  let liveCount: number;
  try { liveCount = await countMountAffected(store, scope, command.mountId); }
  catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'remote_subtree_unknown' || code === 'mount_not_bound' || code === 'mount_not_found') {
      return { ok: false, error: freeze ? 'preview_stale' : code };
    }
    throw error;
  }
  if (freeze) {
    if (freeze.remoteMountNodeId !== mount.remoteMountNodeId
      || freeze.boundaryVersion !== mount.boundaryVersion || freeze.affectedCount !== liveCount) {
      return { ok: false, error: 'preview_stale' };
    }
  } else if (command.affectedCount !== liveCount) {
    return { ok: false, error: 'confirmation_mismatch' };
  }
  if (!freeze?.subtreeSource) return { ok: false, error: 'preview_stale' };
  let liveSource: JsonObject;
  try { liveSource = await scopeSubtreeDeleteSource(store, scope, mount.remoteMountNodeId); }
  catch { return { ok: false, error: 'preview_stale' }; }
  if (digestJson(freeze.subtreeSource) !== digestJson(liveSource)) {
    return { ok: false, error: 'preview_stale' };
  }
  const targetId = freeze.remoteMountNodeId;
  if (mount.status !== 'detached') await detachScopeMount(store, scope, command.mountId);
  const reserved = await store.planRemoteDelete(scope, {
    mountId: command.mountId, confirmationToken: command.confirmationToken, affectedCount,
    opId: reuseOrAllocateRemoteDeleteOpId(mount.pendingRemoteDelete?.opId),
  });
  const opId = reserved.pendingRemoteDelete!.opId!;
  const existing = await store.getQueueByOpId(scope, opId);
  if (!existing) {
    const remote = await store.getMappingByColpId(scope, targetId);
    // F002: the wire operation follows the target node's own kind — never the
    // descendant count. `affectedCount` stays preview/freeze/confirmation
    // evidence (token minting above, `planRemoteDelete` ledger, UI copy).
    try {
      const { kind, revision } = await remoteDeleteTargetFacts(store, scope, targetId, remote);
      await enqueueColpDelete(store, scope, {
        opId, targetId, kind, baseRevision: revision, source: freeze.subtreeSource,
      });
    } catch {
      return { ok: false, error: 'enqueue_failed' };
    }
  }
  const recorded = await store.getScope(scope);
  return { ok: true, phase: 'syncing', firstRun: recorded?.firstRun ?? 'none' };
}

async function loadRemoteDeleteFreeze(store: Store, scope: SyncScope, command: {
  readonly mountId: string; readonly previewId?: string;
}): Promise<RemoteDeleteFreezeEntry | null> {
  if (!command.previewId) return null;
  const preview = await store.getScopePreview(scope, command.previewId);
  return preview?.remoteDeleteEvidence?.find((row) => row.mountId === command.mountId) ?? null;
}

/**
 * Kind evidence for the remote delete target, strongest first: the complete
 * staged snapshot row the confirmation was frozen against (the server's own
 * kind), then the durable mapping identity (`nodeKind`, then a projected `url`).
 * `undefined` is unproven and `deletionOperationType` fails safe toward
 * `delete_subtree`. The mount root is a folder by contract, so an unproven kind
 * here must never become `delete_node`.
 */
async function remoteDeleteTargetFacts(store: Store, scope: SyncScope, targetId: string,
  mapping: MappingInput | null): Promise<{ kind: DeletionNodeKind | undefined; revision: string }> {
  const header = await store.getRecoveryHeader(scope);
  const snapshot = header?.complete
    ? (await store.listRecoveryNodes(scope)).find((node) => node.snapshotId === header.snapshotId
      && node.colpId === targetId)
    : undefined;
  const revision = snapshot?.mapping.projection.revision ?? mapping?.projection.revision;
  if (!revision) throw new Error('subtree_observation_unavailable');
  return { revision, kind: deletionNodeKind({
    ...(snapshot ? { snapshotKind: snapshot.kind } : {}),
    mappedKind: mapping?.nodeKind ?? null,
    mappedContent: mapping?.projection.content ?? null,
  }) };
}

export async function previewAddRange(store: Store, scope: SyncScope, input: {
  readonly roots: readonly NormalizedBookmarkRoot[]; readonly selectedNativeIds: readonly string[];
  readonly excludedNativeIds?: readonly string[]; readonly privateNativeIds?: readonly string[];
}): Promise<FirstRunPreviewOk> {
  const { preview, scan } = await previewRangeChange(store, scope, input);
  return {
    ok: true, previewId: preview.previewId, boundaryVersion: preview.boundaryVersion, treeDigest: scan.treeDigest,
    bookmarkCount: scan.bookmarkCount, folderCount: scan.folderCount, skippedCount: scan.skippedCount,
    warnings: scan.warnings,
  };
}

export async function confirmAddRange(store: Store, scope: SyncScope, input: {
  readonly previewId: string; readonly confirmationId: string; readonly treeDigest: string;
  readonly localFacts: ConfirmInput['localFacts']; readonly remoteFacts?: ConfirmInput['remoteFacts'];
  readonly rootNodeId?: string | null; readonly now?: () => number;
}): Promise<FirstRunOrScopeResponse> {
  if (await kns09Paused('coordinator')) return { ok: false, error: 'sync_paused' };
  const recordedScope = await store.getScope(scope);
  const preview = await store.getScopePreview(scope, input.previewId);
  const rejected = previewRejection(preview, {
    now: Date.now(), liveBoundaryVersion: recordedScope?.boundaryVersion ?? '0', treeDigest: input.treeDigest,
  });
  if (rejected === 'duplicate_confirm') return { ok: false, error: 'duplicate_confirm' };
  if (rejected === 'preview_stale' && preview) {
    return { ok: false, error: 'preview_stale', bookmarkCount: preview.bookmarkCount,
      folderCount: preview.folderCount, skippedCount: preview.skippedCount };
  }
  if (!preview || rejected) return { ok: false, error: 'request_invalid' };
  const priorFirstRun = recordedScope?.firstRun;
  const existing = await store.listMountBindings(scope);
  await mergePreviewMounts(store, scope, existing, preview);
  const mappings = provenMappings(await store.listMappings(scope), input.localFacts.map((row) => row.nativeId));
  const provenNative = new Set(mappings.map((row) => row.nativeId));
  const localFacts = input.localFacts.filter((row) => !provenNative.has(row.nativeId));
  const mounts = (await store.listMountBindings(scope)).map((mount) => ({
    nativeRootId: mount.nativeRootId, remoteMountNodeId: mount.remoteMountNodeId,
    ...(mount.rootRole ? { rootRole: mount.rootRole } : {}),
    ...(mount.customSourceKey ? { customSourceKey: mount.customSourceKey } : {}),
  }));
  const view = await createBootstrapCoordinator({
    store, scope, now: input.now, randomUUID: () => input.confirmationId,
  }).confirm({
    confirmationId: input.confirmationId, previewId: input.previewId, treeDigest: input.treeDigest,
    confirmationVersion: preview.boundaryVersion, localFacts, mounts,
    mappings, ...(input.remoteFacts ? { remoteFacts: input.remoteFacts } : {}),
    ...(input.rootNodeId !== undefined ? { rootNodeId: input.rootNodeId } : {}),
  });
  // Keep onboarding completed; later range jobs resume from the bootstrap run.
  if (priorFirstRun === 'completed') await store.setFirstRun(scope, 'completed');
  await consumeRangePreview(store, scope, preview);
  const recorded = await store.getScope(scope);
  return { ok: true, phase: view.run.phase, firstRun: recorded?.firstRun ?? 'running' };
}

function provenMappings(mappings: readonly MappingInput[], localNativeIds: readonly string[]) {
  const local = new Set(localNativeIds);
  return mappings.filter((mapping) => local.has(mapping.nativeId) && !mapping.colpId.startsWith('pending-')
    && !mapping.nativeId.startsWith('recovery:'))
    .map((mapping) => ({ nativeId: mapping.nativeId, colpId: mapping.colpId }));
}

async function mergePreviewMounts(store: Store, scope: SyncScope, existing: readonly MountBindingRecord[],
  preview: ScopePreviewRecord): Promise<void> {
  const byRoot = new Map(existing.map((mount) => [mount.nativeRootId, mount]));
  for (const planned of preview.boundary.mounts.filter((mount) => mount.writable)) {
    const prior = byRoot.get(planned.nativeRootId);
    if (prior?.status === 'detached') continue;
    byRoot.set(planned.nativeRootId, {
      scopeKey: preview.scopeKey, mountId: prior?.mountId ?? `mount:${planned.nativeRootId}`,
      nativeRootId: planned.nativeRootId, remoteMountNodeId: prior?.remoteMountNodeId ?? null,
      boundaryVersion: preview.boundaryVersion, materialized: planned.materialized,
      status: prior?.status === 'active' || prior?.status === 'pending' ? prior.status : 'pending',
      ...(planned.rootRole ? { rootRole: planned.rootRole } : {}),
      ...(planned.customSourceKey ? { customSourceKey: planned.customSourceKey } : {}),
    });
  }
  await store.replaceMountBindings(scope, [...byRoot.values()].map(({ scopeKey: _scopeKey, ...row }) => row));
}

function reuseOrAllocateRemoteDeleteOpId(prior: string | undefined): string {
  if (prior && isProtocolOpaqueId(prior) && !prior.includes(':')) return prior;
  return crypto.randomUUID();
}

async function enqueueColpDelete(store: Store, scope: SyncScope, input: {
  readonly opId: string; readonly targetId: string; readonly kind: DeletionNodeKind | undefined;
  readonly baseRevision: string;
  readonly source: JsonObject;
}): Promise<void> {
  if (await store.getQueueByOpId(scope, input.opId)) return;
  const occurredAt = new Date().toISOString();
  // The type comes from the target kind through the same resolver as the
  // browser-event path and `translateSyncBrowserDelete`; booleans/descendant
  // counts are never a type source on this path.
  const payload = {
    type: deletionOperationType(input.kind), opId: input.opId, targetId: input.targetId,
    baseRevision: input.baseRevision, occurredAt, dependencies: [], payload: { reason: 'scope_remote_delete' },
    source: input.source,
  };
  await store.allocateSequenceAndEnqueue(scope, {
    opId: input.opId, batchId: input.opId, idempotencyKey: input.opId, digest: digestJson(payload),
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: input.baseRevision,
    operationRevision: `local-${input.opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload,
  }, COLP_QUEUE_STAMP);
}
