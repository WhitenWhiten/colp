import { bindAuthoredMountReceipt } from '../push-mount-role.js';
import { filterBootstrapFacts } from './fact-boundary.js';
import { bootstrapRunInFlight } from './run-identity.js';
import { bindKnownRoleMounts } from './known-role-mounts.js';
export { bootstrapRunInFlight } from './run-identity.js';
import { authoritativeColp, placeholderOccupant, mountNeedsRemote, mountRemoteFromReceipt, receiptTargetId,
  operationPayload, remoteFromRecovery, liveRemoteFromMapping } from './coordinator-operations.js';
import { recordKns09FirstRun } from '../kns-09-release.js';
import { digestJson, validateOperation } from '../bookmark-event-codec.js';
import { virtualNativeId } from '../projection-native-occupancy.js';
import { buildAttentionReport, publicAttentionSummary } from './attention-report.js';
import type {
  BootstrapMode, BootstrapRunRecord, BookmarkEventRecord, JsonObject, MappingInput, MountBindingRecord,
  QueueOperation, RecoveryNodeRecord, ScopePreviewRecord, SyncScope, createSyncStateStore,
} from '../sync-state-store.js';
import { applyInboxToFacts } from './local-facts.js';
import { scopeKey } from '../sync-state/scope-key.js';
import {
  bootstrapOpId, bootstrapRunOpPrefix, matchLocalRemote, type LocalMatchReport, type LocalNodeFact, type MappingFact, type MountFact,
  type PlannedOperation, type RemoteNodeFact, type SidecarFact,
} from './matcher.js';

type Store = ReturnType<typeof createSyncStateStore>;
export type PauseAfter = 'confirmed' | 'scanning' | 'matching' | `enqueue:${number}`;

export interface ConfirmInput {
  readonly confirmationId: string; readonly previewId?: string; readonly libraryId?: string;
  readonly treeDigest: string; readonly confirmationVersion: string;
  readonly localFacts: readonly LocalNodeFact[]; readonly remoteFacts?: readonly RemoteNodeFact[];
  readonly mappings?: readonly MappingFact[]; readonly sidecars?: readonly SidecarFact[];
  readonly mounts: readonly MountFact[]; readonly rootNodeId?: string | null;
  readonly bootstrapMode?: BootstrapMode; readonly previewOnly?: boolean;
  readonly destructiveConfirmed?: boolean; readonly pauseAfter?: PauseAfter;
  /** Mounts whose frozen remote-delete evidence must keep its boundary version. */
  readonly preserveBoundaryNativeIds?: readonly string[];
}

export interface BootstrapView {
  readonly run: BootstrapRunRecord; readonly report: LocalMatchReport | null;
  readonly queuedOpIds: readonly string[];
}

export function createBootstrapCoordinator(options: {
  readonly store: Store; readonly scope: SyncScope; readonly now?: () => number;
  readonly randomUUID?: () => string; readonly retireLegacy?: () => Promise<void>;
}) {
  const store = options.store; const scope = options.scope;
  const now = options.now ?? Date.now; const uuid = options.randomUUID ?? (() => crypto.randomUUID());

  async function confirm(input: ConfirmInput): Promise<BootstrapView> {
    if (input.previewOnly || (input.bootstrapMode && input.bootstrapMode !== 'merge')) {
      if (!input.previewOnly && input.destructiveConfirmed) throw new Error('bootstrap_execution_unsupported');
      return preview(input);
    }
    const existing = (await store.listBootstrapRuns(scope)).find((row) => row.confirmationId === input.confirmationId);
    if (existing) {
      if (existing.previewId !== undefined && existing.previewId !== input.previewId
          || existing.treeDigest !== undefined && existing.treeDigest !== input.treeDigest
          || existing.confirmationVersion !== undefined && existing.confirmationVersion !== input.confirmationVersion) {
        throw new Error('confirmation_conflict');
      }
      // A worker can stop after persisting the run but before binding mounts.
      if (existing.phase === 'confirmed') await bindMounts(input.mounts, input.confirmationVersion);
      return advance(existing.runId, input);
    }
    const run = await persist({
      runId: uuid(), phase: 'confirmed', bootstrapMode: input.bootstrapMode ?? 'merge',
      confirmationId: input.confirmationId, updatedAt: now(), confirmationVersion: input.confirmationVersion,
      ...(input.previewId ? { previewId: input.previewId } : {}), treeDigest: input.treeDigest,
      ...(input.libraryId ? { libraryId: input.libraryId } : {}),
      ...(input.previewOnly ? { previewOnly: true } : {}),
      ...(input.destructiveConfirmed ? { destructiveConfirmed: true } : {}),
      resumeCursor: 'confirmed',
      ...(input.mounts.some((mount) => mount.rootRole && !mount.remoteMountNodeId)
        ? { mountResolveRequest: input.mounts.flatMap((mount) => mount.rootRole ? [mount.rootRole] : []).join(',') }
        : {}),
    });
    // Range jobs after onboarding must not reopen the first-run UI.
    if ((await store.getScope(scope))?.firstRun !== 'completed') await store.setFirstRun(scope, 'running');
    await bindMounts(input.mounts, input.confirmationVersion, input.preserveBoundaryNativeIds);
    if (input.pauseAfter === 'confirmed') return view(run.runId, null);
    return advance(run.runId, input);
  }

  async function resume(input: ConfirmInput): Promise<BootstrapView | null> {
    const runs = [...await store.listBootstrapRuns(scope)].sort((left, right) => right.updatedAt - left.updatedAt);
    const existing = runs.find((row) => row.confirmationId === input.confirmationId && bootstrapRunInFlight(row.phase))
      ?? runs.find((row) => bootstrapRunInFlight(row.phase));
    if (!existing) return null;
    return advance(existing.runId, { ...input, confirmationId: existing.confirmationId });
  }

  async function advance(runId: string, input: ConfirmInput): Promise<BootstrapView> {
    let run = requireRun(await store.listBootstrapRuns(scope), runId);
    if (run.previewOnly || run.bootstrapMode !== 'merge') {
      if (!run.previewOnly && run.destructiveConfirmed) throw new Error('bootstrap_execution_unsupported');
      return preview({ ...input, bootstrapMode: run.bootstrapMode });
    }
    if (run.phase === 'completed' || run.phase === 'needs_attention') {
      const matched = await rematch(run, input);
      const attention = buildAttentionReport(run, matched.report, now());
      const phase = publicAttentionSummary(attention).pendingCount > 0 ? 'needs_attention' : 'completed';
      if (run.reportDigest !== matched.report.reportDigest || run.phase !== phase
          || JSON.stringify(run.attention) !== JSON.stringify(attention)) {
        await store.putScopeDiagnostic(scope, { kind: 'bootstrap_attention_history', code: 'bootstrap_attention_refreshed', details: { runId,
          previousDigest: run.reportDigest ?? 'unrecorded', pendingCount: run.attention ? publicAttentionSummary(run.attention).pendingCount : 0 } });
        await store.putBootstrapRun(scope, { ...matched.run, phase, attention,
          reportDigest: matched.report.reportDigest, updatedAt: now() }, run);
      }
      return view(runId, matched.report);
    }
    if (run.phase === 'confirmed') {
      const retired = await retireIfNeeded(run);
      run = retired; if (run.phase === 'confirmed') return view(runId, null);
    }
    if (input.pauseAfter === 'confirmed') return view(runId, null);
    if (run.phase === 'scanning' || run.resumeCursor === 'confirmed') {
      run = await persist({ ...run, phase: 'scanning', resumeCursor: 'scanning', retryReason: undefined, updatedAt: now() });
    }
    if (input.pauseAfter === 'scanning') return view(runId, null);
    const matched = await rematch(run, input);
    const report = matched.report;
    run = await persist({
      ...matched.run, phase: 'matching', reportDigest: report.reportDigest, resumeCursor: 'matching',
      updatedAt: now(),
      ...(report.mountResolveRoles.length
        ? { mountResolveRequest: report.mountResolveRoles.join(',') } : {}),
    });
    if (input.pauseAfter === 'matching' || run.previewOnly || input.previewOnly) {
      return view(runId, report);
    }
    run = await persist({ ...run, phase: 'syncing', resumeCursor: run.resumeCursor, updatedAt: now() });
    const queued = await enqueuePlanned(run, report, input.pauseAfter, {
      callerRemoteFacts: input.remoteFacts !== undefined, fromRecovery: matched.fromRecovery,
    });
    const pendingMount = (await store.listMountBindings(scope)).some(mountNeedsRemote);
    const rootId = inputRoot(report, matched.rootNodeId);
    const waitingParent = report.planned.some((op) =>
      (op.reason === 'local-only' || op.reason === 'mount-resolve') && !canEnqueue(op, rootId));
    const inboxPending = (await pendingEvents()).length > 0;
    const upload = await bootstrapUploadStatus(run.confirmationId, input);
    const attention = report.candidates.length > 0 || report.conflicts.length > 0;
    const done = queued.caughtUp && !pendingMount && !waitingParent && !inboxPending
      && !upload.pending && !upload.rejected;
    const phase = done ? (attention ? 'needs_attention' : 'completed') : 'syncing';
    run = await persist({
      ...run, phase, resumeCursor: queued.resumeCursor, reportDigest: report.reportDigest, updatedAt: now(),
      retryReason: upload.rejected ? 'bootstrap_upload_rejected' : queued.retryReason,
      attention: attention ? buildAttentionReport(run, report, now()) : undefined,
    });
    if (done) {
      await store.setFirstRun(scope, 'completed');
      recordKns09FirstRun(attention ? 'attention' : 'completed', scope, run.confirmationId);
    }
    return view(run.runId, report);
  }

  async function status(): Promise<{ phase: BootstrapRunRecord['phase']; firstRun: string; runId?: string;
    retryReason?: string; attention?: BootstrapRunRecord['attention'] }> {
    const recorded = await store.getScope(scope);
    const runs = [...await store.listBootstrapRuns(scope)].sort((left, right) => right.updatedAt - left.updatedAt);
    const run = runs.find(row => row.attention && publicAttentionSummary(row.attention).pendingCount > 0) ?? runs[0];
    return {
      phase: run?.phase ?? 'draft', firstRun: recorded?.firstRun ?? 'none',
      ...(run ? { runId: run.runId } : {}),
      ...(run?.retryReason ? { retryReason: run.retryReason } : {}),
      ...(run?.attention ? { attention: run.attention } : {}),
    };
  }

  async function preview(input: ConfirmInput): Promise<BootstrapView> {
    const run: BootstrapRunRecord = {
      scopeKey: scopeKey(scope), runId: `preview:${input.confirmationId}`, phase: 'matching',
      bootstrapMode: input.bootstrapMode ?? 'merge', confirmationId: input.confirmationId,
      updatedAt: now(), previewOnly: true,
    };
    const matched = await rematch(run, input, true);
    return { run: { ...run, reportDigest: matched.report.reportDigest }, report: matched.report, queuedOpIds: [] };
  }

  async function rematch(run: BootstrapRunRecord, input: ConfirmInput, readOnly = false):
    Promise<{ report: LocalMatchReport; run: BootstrapRunRecord; rootNodeId: string | null;
      fromRecovery: boolean }> {
    const events = await pendingEvents();
    const allLocal = applyInboxToFacts(input.localFacts, events);
    const [recorded, live, preview, removals] = await Promise.all([store.getScope(scope), store.listMappings(scope),
      run.previewId ? store.getScopePreview(scope, run.previewId) : null, store.listDeletionJournal(scope)]);
    const nativeByColp = new Map(live.map(row => [row.colpId, row.nativeId]));
    const { facts: local, skipped } = filterBootstrapFacts({ facts: allLocal, parents: live, mounts: input.mounts,
      privateNativeIds: (recorded?.privateRoots ?? []).flatMap(id => nativeByColp.get(id) ?? []),
      excludedNativeIds: preview?.boundary.excludedNativeIds ?? [], removedNativeIds: removals.map(row => row.nativeId) });
    if (!readOnly) for (const item of skipped) {
      await store.putIngressDiagnostic(scope, { code: item.reason }, { sourceId: `bootstrap:${run.runId}:${item.nativeId}` });
    }
    const loaded = await remoteFromStore(run, input);
    run = loaded.run;
    const remote = input.remoteFacts ?? loaded.remote;
    const rootNodeId = input.rootNodeId ?? loaded.rootNodeId
      ?? remote.find((row) => row.folderRole === 'root')?.nodeId ?? null;
    if (!readOnly) {
      await bindKnownRoleMounts(store, scope, remote, rootNodeId);
      await bindResolvedMounts(run.confirmationId);
    }
    const storedMappings = input.mappings ?? (await store.listMappings(scope)).filter(row => row.projection.revision !== 'local-root').map((row) => (
      { nativeId: row.nativeId, colpId: row.colpId }));
    const mounts = await mergeMounts(input.mounts);
    const mappings = mergeAuthoritativeMappings(storedMappings,
      await mappingsFromTerminalCreates(run.confirmationId, local, mounts));
    const report = matchLocalRemote({
      scopeKey: run.scopeKey, confirmationId: run.confirmationId, local, remote, mappings, mounts,
      sidecars: input.sidecars, rootNodeId,
      bootstrapMode: run.bootstrapMode, destructiveConfirmed: run.destructiveConfirmed === true,
      previewOnly: run.previewOnly === true,
    });
    if (!readOnly) {
      await persistConfirmedMatches(report, local, remote);
      await bindResolvedMounts(run.confirmationId);
    }
    return { report, run, rootNodeId, fromRecovery: loaded.fromRecovery };
  }

  async function persistConfirmedMatches(report: LocalMatchReport, local: readonly LocalNodeFact[],
    remote: readonly RemoteNodeFact[]): Promise<void> {
    const localById = new Map(local.map((row) => [row.nativeId, row]));
    const remoteById = new Map(remote.map((row) => [row.nodeId, row]));
    const mountByRoot = new Map((await store.listMountBindings(scope)).map((row) => [row.nativeRootId, row]));
    const live = await store.listMappings(scope);
    const byNative = new Map(live.map((row) => [row.nativeId, row.colpId]));
    const byColp = new Map(live.map((row) => [row.colpId, row.nativeId]));
    // report.matched is already parent-first for structural pairs.
    for (const pair of report.matched) {
      const row = localById.get(pair.nativeId); const fact = remoteById.get(pair.nodeId);
      if (!row || !fact || !authoritativeColp(pair.nodeId) || virtualNativeId(row.nativeId)
          || virtualNativeId(pair.nodeId) || fact.folderRole === 'root' || byNative.has(row.nativeId)) continue;
      const occupant = byColp.get(pair.nodeId);
      // Unique indexes: never rebind a live native or steal a live colpId.
      if (occupant && occupant !== row.nativeId && !placeholderOccupant(occupant)) continue;
      const mount = mountByRoot.get(row.mountNativeRootId);
      const content: JsonObject = { title: fact.title, ...(fact.url ? { url: fact.url } : {}),
        ...(fact.folderRole ? { folderRole: fact.folderRole } : {}) };
      const digest = digestJson(content);
      const mapping: MappingInput = {
        nativeId: row.nativeId, colpId: pair.nodeId, rootNativeId: row.mountNativeRootId, nodeKind: row.kind,
        ...(row.parentNativeId ? { parentNativeId: row.parentNativeId } : {}),
        ...(row.folderRole ? { rootRole: row.folderRole } : {}),
        ...(fact.parentId && authoritativeColp(fact.parentId) ? { parentColpId: fact.parentId } : {}),
        ...(mount ? { mountId: mount.mountId } : {}),
        ...(mount?.rootRole && row.nativeId === row.mountNativeRootId ? { rootRole: mount.rootRole } : {}),
        projection: { revision: fact.revision, resourceRevision: fact.revision, digest, contentDigest: digest,
          content, ...(fact.childrenRevision ? { childrenRevision: fact.childrenRevision } : {}) },
      };
      try { await store.putMapping(scope, mapping); }
      catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'constraint') throw error;
        continue;
      }
      if (occupant && occupant !== row.nativeId) byNative.delete(occupant);
      byNative.set(row.nativeId, pair.nodeId); byColp.set(pair.nodeId, row.nativeId);
    }
  }

  async function remoteFromStore(run: BootstrapRunRecord, input: ConfirmInput):
    Promise<{ run: BootstrapRunRecord; remote: RemoteNodeFact[]; fromRecovery: boolean; rootNodeId: string | null }> {
    const header = await store.getRecoveryHeader(scope);
    const nodes = await store.listRecoveryNodes(scope);
    const headerRoot = header && typeof header.rootNodeId === 'string' ? header.rootNodeId : null;
    if (nodes.length > 0) {
      const syncCursor = header && typeof header.syncCursor === 'string' ? header.syncCursor : undefined;
      if (syncCursor && !run.snapshotCursor) {
        run = { ...run, snapshotCursor: syncCursor, updatedAt: now() };
      }
      const remote = nodes.map(remoteFromRecovery);
      return {
        run, remote, fromRecovery: true,
        rootNodeId: headerRoot ?? remote.find((row) => row.folderRole === 'root')?.nodeId ?? input.rootNodeId ?? null,
      };
    }
    const remote = (await store.listMappings(scope)).flatMap((row) => liveRemoteFromMapping(row));
    if (remote.length > 0) {
      return {
        run, remote, fromRecovery: false,
        rootNodeId: headerRoot ?? input.rootNodeId
          ?? remote.find((row) => row.folderRole === 'root')?.nodeId ?? null,
      };
    }
    if (input.rootNodeId) {
      return { run, remote: [{ nodeId: input.rootNodeId, parentId: null, kind: 'folder', title: '',
        folderRole: 'root', revision: 'rev-root-1' }], fromRecovery: false, rootNodeId: input.rootNodeId };
    }
    return { run, remote: [], fromRecovery: false, rootNodeId: headerRoot };
  }

  async function enqueuePlanned(run: BootstrapRunRecord, report: LocalMatchReport,
    pauseAfter: PauseAfter | undefined, evidence: { readonly callerRemoteFacts: boolean; readonly fromRecovery: boolean }):
    Promise<{ caughtUp: boolean; resumeCursor: string; retryReason?: string }> {
    const frozen = (await store.getEngineState(scope))?.recoveryFrozen === true;
    if (frozen) {
      await persist({ ...run, phase: 'syncing', retryReason: 'queue_recovery_frozen', updatedAt: now() });
      return { caughtUp: false, resumeCursor: run.resumeCursor ?? 'matching', retryReason: 'queue_recovery_frozen' };
    }
    if (!evidence.callerRemoteFacts && !evidence.fromRecovery && !await replicaSnapshotted()) {
      await persist({ ...run, phase: 'syncing', retryReason: 'snapshot_pending', updatedAt: now() });
      return { caughtUp: false, resumeCursor: run.resumeCursor ?? 'matching', retryReason: 'snapshot_pending' };
    }
    const limit = pauseAfter?.startsWith('enqueue:') ? Number(pauseAfter.slice(8)) : Number.POSITIVE_INFINITY;
    let added = 0; let index = 0;
    const rootId = inputRoot(report, null);
    for (const op of report.planned) {
      if (!canEnqueue(op, rootId)) { index += 1; continue; }
      try {
        const prior = await store.getQueueByOpId(scope, op.opId);
        if (!prior) {
          await enqueueOp(op);
          added += 1;
          await persist({ ...run, phase: 'syncing', resumeCursor: `enqueue:${index + 1}`, updatedAt: now() });
          if (added >= limit) return { caughtUp: false, resumeCursor: `enqueue:${index + 1}` };
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'bootstrap_native_removed') { index += 1; continue; }
        if (isQueueRecoveryFrozen(error)) {
          await persist({ ...run, phase: 'syncing', retryReason: 'queue_recovery_frozen', updatedAt: now() });
          return { caughtUp: false, resumeCursor: `enqueue:${index}`, retryReason: 'queue_recovery_frozen' };
        }
        throw error;
      }
      index += 1;
    }
    return { caughtUp: true, resumeCursor: `enqueue:${report.planned.length}` };
  }

  async function enqueueOp(op: PlannedOperation): Promise<QueueOperation | null> {
    const occurredAt = new Date(now()).toISOString();
    const payload = operationPayload(op, occurredAt);
    const parent = op.parentId ? await store.getMappingByColpId(scope, op.parentId) : null;
    const provisionalCreateMapping: MappingInput | undefined = op.reason === 'local-only' && op.nativeId && op.node && parent
      ? { nativeId: op.nativeId, colpId: `pending-${op.opId}`, nodeKind: op.node.kind,
        parentNativeId: parent.nativeId, parentColpId: parent.colpId, rootNativeId: parent.rootNativeId,
        ...(op.node.folderRole && op.node.folderRole !== 'custom' ? { rootRole: op.node.folderRole as MappingInput['rootRole'] } : {}),
        projection: { revision: `local-${op.opId}`, digest: digestJson(op.node),
          content: { title: op.node.title, ...(op.node.url ? { url: op.node.url } : {}), ...(op.node.folderRole ? { folderRole: op.node.folderRole } : {}) } } } : undefined;
    return store.allocateSequenceAndEnqueue(scope, {
      opId: op.opId, batchId: op.opId, idempotencyKey: op.opId, digest: 'sha256:pending', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: op.type === 'create_node' ? null : 'revision-0',
      operationRevision: `local-${op.opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload,
    }, { validateOperation, digestOperation: digestJson, ...(provisionalCreateMapping ? { provisionalCreateMapping } : {}) });
  }

  async function mappingsFromTerminalCreates(confirmationId: string, local: readonly LocalNodeFact[],
    mounts: readonly MountFact[]): Promise<MappingFact[]> {
    // Only these ids are ever consulted, so read only these: the whole queue was
    // scanned to build a map then asked about a few keys, and it is never pruned.
    const wantedOpIds = [
      ...local.map((row) => bootstrapOpId(confirmationId, 'create', row.nativeId)),
      ...mounts.flatMap((mount) => {
        const key = mount.rootRole ?? mount.customSourceKey;
        return key ? [bootstrapOpId(confirmationId, 'mount', key)] : [];
      }),
    ];
    const byOpId = new Map<string, QueueOperation>();
    for (const opId of new Set(wantedOpIds)) {
      const row = await store.getQueueByOpId(scope, opId);
      if (row) byOpId.set(opId, row);
    }
    const receiptsByOpId = await receiptsForOps(wantedOpIds);
    const facts: MappingFact[] = [];
    const pushIfTerminal = (opKey: string, nativeId: string) => {
      if (byOpId.get(opKey)?.status !== 'terminal') return;
      const targetId = receiptTargetId(receiptsByOpId.get(opKey));
      if (targetId) facts.push({ nativeId, colpId: targetId });
    };
    for (const row of local) pushIfTerminal(bootstrapOpId(confirmationId, 'create', row.nativeId), row.nativeId);
    for (const mount of mounts) {
      const key = mount.rootRole ?? mount.customSourceKey;
      if (key) pushIfTerminal(bootstrapOpId(confirmationId, 'mount', key), mount.nativeRootId);
    }
    return facts;
  }

  async function bindResolvedMounts(confirmationId: string): Promise<void> {
    const mounts = await store.listMountBindings(scope);
    const unresolved = mounts.filter(mountNeedsRemote);
    if (unresolved.length === 0) return;
    const mappings = await store.listMappings(scope);
    const byNative = new Map(mappings.map((row) => [row.nativeId, row]));
    let receiptsByOpId: Map<string, { readonly opId: string; readonly result?: JsonObject }> | undefined;
    const queued = await allQueue();
    for (const mount of unresolved) {
      const { scopeKey: _scopeKey, ...binding } = mount;
      if (authoritativeColp(mount.remoteMountNodeId) && mount.status === 'pending') {
        await store.putMountBinding(scope, { ...binding, status: 'active' });
        continue;
      }
      const mapping = byNative.get(mount.nativeRootId);
      let remoteId = mapping && mapping.projection.revision !== 'local-root' && authoritativeColp(mapping.colpId) ? mapping.colpId : null;
      if (!remoteId) {
        receiptsByOpId ??= await receiptsForOps(
          queued.filter((row) => row.status === 'terminal').map((row) => row.opId));
        remoteId = mountRemoteFromReceipt(mount, mapping?.colpId, queued, receiptsByOpId, confirmationId);
      }
      if (!remoteId) continue;
      const mountKey = mount.rootRole ?? mount.customSourceKey;
      const op = mountKey ? queued.find(row => row.opId === bootstrapOpId(confirmationId, 'mount', mountKey)) : undefined;
      const receipt = op?.status === 'terminal' ? await store.getQueueReceipt(scope, op.sequence) : undefined;
      const result = (receipt?.result?.results as JsonObject[] | undefined)?.find(row => row.opId === op?.opId);
      if (op && result?.targetId === remoteId && typeof result.revision === 'string' && ['applied', 'rebased'].includes(String(result.status))) {
        await bindAuthoredMountReceipt(store, scope, op, remoteId, result.revision);
        if ((await store.getEngineState(scope))?.recoveryFrozen) return;
      }
      await store.putMountBinding(scope, { ...binding, remoteMountNodeId: remoteId, status: 'active' });
    }
  }

  async function retireIfNeeded(run: BootstrapRunRecord): Promise<BootstrapRunRecord> {
    const recorded = await store.getScope(scope);
    if (!recorded?.legacyCanonicalRoot || !options.retireLegacy) {
      return persist({ ...run, phase: 'scanning', resumeCursor: 'scanning', updatedAt: now() });
    }
    try {
      await options.retireLegacy();
      return persist({ ...run, phase: 'scanning', resumeCursor: 'scanning', retryReason: undefined, updatedAt: now() });
    } catch (error) {
      const retryReason = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)
        ? error.message : 'legacy_remount_failed';
      return persist({ ...run, phase: 'confirmed', resumeCursor: 'confirmed', retryReason, updatedAt: now() });
    }
  }

  async function bindMounts(mounts: readonly MountFact[], boundaryVersion: string,
    preserveBoundaryNativeIds: readonly string[] = []): Promise<void> {
    const existing = await store.listMountBindings(scope);
    const byRoot = new Map(existing.map((row) => [row.nativeRootId, row]));
    // A root whose frozen remote-delete plan is applied after this confirmation
    // must keep the mount version that plan was minted against.
    const preserved = new Set(preserveBoundaryNativeIds);
    const records: Omit<MountBindingRecord, 'scopeKey'>[] = mounts.map((mount) => {
      const prior = byRoot.get(mount.nativeRootId);
      const { scopeKey: _scopeKey, rootRole: _role, customSourceKey: _source, ...previous } = prior ?? {} as Partial<MountBindingRecord>;
      return { ...previous,
        mountId: prior?.mountId ?? `mount:${mount.nativeRootId}`, nativeRootId: mount.nativeRootId,
        remoteMountNodeId: mount.remoteMountNodeId ?? prior?.remoteMountNodeId ?? null,
        boundaryVersion: prior && preserved.has(mount.nativeRootId) ? prior.boundaryVersion : boundaryVersion,
        materialized: prior?.materialized ?? false, status: prior?.status ?? 'pending',
        ...(mount.rootRole ? { rootRole: mount.rootRole } : {}),
        ...(mount.customSourceKey ? { customSourceKey: mount.customSourceKey } : {}),
      };
    });
    // Range bootstraps add mounts to an established replica. Existing detached
    // mounts and their pause baselines remain available for a later rejoin.
    for (const record of records) await store.putMountBinding(scope, record);
  }

  async function mergeMounts(input: readonly MountFact[]): Promise<MountFact[]> {
    const live = await store.listMountBindings(scope);
    const mapped = new Map((await store.listMappings(scope)).filter(row => row.projection.revision !== 'local-root')
      .map((row) => [row.nativeId, row.colpId]));
    const source = input.length > 0 ? input : live.map((row) => ({
      nativeRootId: row.nativeRootId, remoteMountNodeId: row.remoteMountNodeId,
      ...(row.rootRole ? { rootRole: row.rootRole } : {}),
      ...(row.customSourceKey ? { customSourceKey: row.customSourceKey } : {}),
    }));
    return source.map((mount) => {
      const row = live.find((item) => item.nativeRootId === mount.nativeRootId);
      const fromMap = mapped.get(mount.nativeRootId);
      const remote = [row?.remoteMountNodeId, fromMap, mount.remoteMountNodeId].find((id) => authoritativeColp(id));
      return { ...mount, remoteMountNodeId: remote ?? mount.remoteMountNodeId ?? null };
    });
  }

  async function pendingEvents(): Promise<BookmarkEventRecord[]> {
    const rows: BookmarkEventRecord[] = []; let after = 0;
    while (true) {
      const page = await store.listBookmarkEventsByStatus(scope, 'pending', after, 1_000);
      rows.push(...page); if (page.length < 1_000) return rows;
      after = page[page.length - 1]!.ordinal;
    }
  }

  async function persist(row: Omit<BootstrapRunRecord, 'scopeKey'>): Promise<BootstrapRunRecord> {
    return store.putBootstrapRun(scope, row);
  }

  async function view(runId: string, report: LocalMatchReport | null): Promise<BootstrapView> {
    const run = requireRun(await store.listBootstrapRuns(scope), runId);
    const queued = await allQueue();
    return { run, report, queuedOpIds: queued.map((item) => item.opId) };
  }

  async function allQueue(): Promise<QueueOperation[]> {
    const rows: QueueOperation[] = []; let after = 0;
    while (true) {
      const page = await store.listQueue(scope, undefined, after, 1_000);
      rows.push(...page); if (page.length < 1_000) return rows;
      after = page[page.length - 1]!.sequence;
    }
  }

  async function bootstrapUploadStatus(confirmationId: string, input: ConfirmInput) {
    const expected = new Set(input.localFacts.map(fact => bootstrapOpId(confirmationId, 'create', fact.nativeId)));
    for (const mount of input.mounts) {
      const key = mount.rootRole ?? mount.customSourceKey;
      if (key) expected.add(bootstrapOpId(confirmationId, 'mount', key));
    }
    const prefix = bootstrapRunOpPrefix(confirmationId);
    const rows = (await allQueue()).filter(row => row.opId.startsWith(prefix) || expected.has(row.opId));
    const pending = rows.some(row => row.status !== 'terminal' && row.status !== 'rejected');
    let rejected = rows.some(row => row.status === 'rejected');
    if (!pending && !rejected) {
      for (const row of rows) {
        const receipt = await store.getQueueReceipt(scope, row.sequence);
        const results = receipt?.result?.results;
        const status = Array.isArray(results) && results[0] && typeof results[0] === 'object'
          && !Array.isArray(results[0]) ? (results[0] as JsonObject).status : undefined;
        if (status !== 'applied' && status !== 'rebased' && status !== 'noop') { rejected = true; break; }
      }
    }
    return { pending, rejected };
  }

  /**
   * Receipts for a named set of operations.
   *
   * This used to read the ENTIRE queue through `allQueue()` and then keep only the
   * rows whose opId was asked for, so the cost grew with the whole settled history
   * to produce a handful of receipts — and the queue is never pruned, so that
   * history only grows. `getQueueByOpId` is a unique `[scopeKey, opId]` index, so
   * each wanted operation is one lookup and nothing else is read.
   */
  async function receiptsForOps(opIds: readonly string[]):
    Promise<Map<string, { readonly opId: string; readonly result?: JsonObject }>> {
    const receipts = new Map<string, { readonly opId: string; readonly result?: JsonObject }>();
    for (const opId of new Set(opIds)) {
      const queuedOp = await store.getQueueByOpId(scope, opId);
      if (!queuedOp || queuedOp.status !== 'terminal') continue;
      const receipt = await store.getQueueReceipt(scope, queuedOp.sequence);
      if (receipt) receipts.set(opId, receipt);
    }
    return receipts;
  }

  async function replicaSnapshotted(): Promise<boolean> {
    return (await store.listAckIntents(scope)).some((intent) => intent.kind === 'bootstrap'
      && intent.state === 'complete');
  }

  return Object.freeze({ confirm, advance, resume, status, preview });
}

export function previewStaleFromScan(scan: Pick<ScopePreviewRecord, 'bookmarkCount' | 'folderCount' | 'skippedCount'>) {
  return { ok: false as const, error: 'preview_stale' as const, bookmarkCount: scan.bookmarkCount,
    folderCount: scan.folderCount, skippedCount: scan.skippedCount };
}

function requireRun(runs: readonly BootstrapRunRecord[], runId: string): BootstrapRunRecord {
  const run = runs.find((item) => item.runId === runId);
  if (!run) throw new Error('bootstrap_run_not_found');
  return run;
}

function mergeAuthoritativeMappings(base: readonly MappingFact[], extra: readonly MappingFact[]): MappingFact[] {
  const byNative = new Map(base.map((row) => [row.nativeId, row.colpId]));
  for (const row of extra) {
    const current = byNative.get(row.nativeId);
    if (!authoritativeColp(current) && authoritativeColp(row.colpId)) byNative.set(row.nativeId, row.colpId);
  }
  return [...byNative.entries()].map(([nativeId, colpId]) => ({ nativeId, colpId }));
}

function canEnqueue(op: PlannedOperation, rootNodeId: string | null): boolean {
  if (op.type === 'create_node' && op.reason === 'mount-resolve') return Boolean(op.parentId || rootNodeId);
  if (op.type === 'create_node' && op.reason === 'local-only') {
    if (!authoritativeColp(op.parentId)) return false;
    if (rootNodeId && op.parentId === rootNodeId && op.node?.kind === 'bookmark') return false;
    return true;
  }
  if (op.type === 'delete_node') return Boolean(op.targetId);
  return Boolean(op.targetId);
}

function inputRoot(report: LocalMatchReport, rootNodeId: string | null): string | null {
  return report.planned.find((op) => op.reason === 'mount-resolve')?.parentId ?? rootNodeId;
}

function isQueueRecoveryFrozen(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return code === 'queue_recovery_frozen' || message === 'queue_recovery_frozen';
}
