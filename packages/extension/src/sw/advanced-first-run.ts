import { personalTreeApi } from '../bookmark-subscriptions/personal-boundary.js';
import { configuredPersonalSyncPolicy, personalSyncFetch, personalSyncNativeApi } from '../personal-sync-fetch.js';
import { digestJson } from '../bookmark-event-codec.js';
import { advancedLocalFacts } from '../bootstrap/advanced-local-facts.js';
import { advancedConfirmationProof, buildAdvancedPlan,
  validateAdvancedConfirmation, type AdvancedConfirmationBinding } from '../bootstrap/advanced-plan.js';
import type { AdvancedPlan, AdvancedMode } from '../bootstrap/advanced-plan-types.js';
import type { LocalNodeFact, MappingFact, MountFact, RemoteNodeFact } from '../bootstrap/matcher.js';
import { loadCompleteRemoteSnapshot, type CompleteRemoteSnapshot } from '../bootstrap/remote-snapshot.js';
import { scanBoundary } from '../bookmark-boundary.js';
import { createChromeBookmarkTreeAdapter } from '../chrome-bookmark-tree.js';
import { matchLocalRemote } from '../bootstrap/matcher.js';
import { fetchSyncEndpoints } from '../manifest-client.js';
import type { JsonObject, SyncScope } from '../sync-state-store.js';
import type { FirstRunConfirmRequest, FirstRunOrScopeResponse, FirstRunPreviewOk,
  FirstRunPreviewRequest } from '../types.js';
import { hasBookmarkPermission, extensionOrigin, rootScopeKey, sw, store, syncState } from './runtime.js';
import { currentSyncScope, loadConfig } from './scope.js';
import { readRootFolders, sameDiscovered } from './roots.js';
import { kns09Paused } from '../kns-09-release.js';
import { syncSessionNeedsRenewal, sessionMatchesCredentialAuthority } from '../session-client.js';
import type { StoredCredential, StoredSession } from '../types.js';

const ADVANCED_PREVIEW_TTL_MS = 30 * 60 * 1_000;
const MAX_ADVANCED_PREVIEWS = 16;

export type AdvancedPreviewMode = AdvancedMode | 'merge' | 'preview-only';

interface CachedAdvancedPreview {
  readonly cacheKey: string;
  readonly previewId: string;
  readonly viewId: string;
  readonly mode: AdvancedPreviewMode;
  readonly scope: SyncScope;
  readonly scopeKey: string;
  readonly boundaryVersion: string;
  readonly selectedNativeIds: readonly string[];
  readonly excludedNativeIds: readonly string[];
  readonly discovered: readonly { readonly nativeId: string; readonly ancestorNativeIds: readonly string[] }[];
  readonly mounts: readonly MountFact[];
  readonly rootNodeId: string;
  readonly localFacts: readonly LocalNodeFact[];
  readonly remoteFacts: readonly RemoteNodeFact[];
  readonly mappings: readonly MappingFact[];
  readonly mappingDigest: string;
  readonly treeDigest: string;
  readonly snapshot: Pick<CompleteRemoteSnapshot, 'snapshotId' | 'revision' | 'syncCursor' | 'identityDigest'>;
  readonly plan?: AdvancedPlan;
  readonly report: ReportCounts;
  readonly counts: Pick<FirstRunPreviewOk, 'bookmarkCount' | 'folderCount' | 'skippedCount'>;
  readonly expiresAt: number;
}

interface ReportCounts {
  readonly matched: number;
  readonly localOnly: number;
  readonly remoteOnly: number;
  readonly candidates: number;
  readonly conflicts: number;
}

const advancedPreviews = new Map<string, CachedAdvancedPreview>();
const confirmationInFlight = new Map<string, Promise<FirstRunOrScopeResponse>>();

/** Stable plan identity: a service-worker restart can reconstruct it from previewId. */
export function advancedPlanIdFromPreview(previewId: string): string {
  const digest = digestJson(['advanced-plan', previewId]);
  return `advanced.plan.${digest.slice('sha256:'.length)}`;
}

export function clearAdvancedPreviewCache(): void {
  advancedPreviews.clear();
}

export function advancedPreviewCacheSize(): number {
  pruneAdvancedPreviews(Date.now());
  return advancedPreviews.size;
}

export async function handleAdvancedFirstRunPreview(message: FirstRunPreviewRequest): Promise<FirstRunOrScopeResponse> {
  try {
    const scope = await currentSyncScope();
    await configuredPersonalSyncPolicy()?.capture(scope);
    if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
    if (await kns09Paused('ui')) return { ok: false, error: 'sync_paused' };
    if (await advancedWorkBusy(scope)) return { ok: false, error: 'sync_busy' };
    const mode = message.bootstrapMode;
    if (!mode) return { ok: false, error: 'request_invalid' };
    const selected = resolvePreviewRefs(scope, message.viewId, message.selectedRefs);
    const excluded = resolvePreviewRefs(scope, message.viewId, message.excludedRefs);
    if (!selected || !excluded) return { ok: false, error: 'request_invalid' };
    const current = await readRootFolders();
    if (!sw.rootViewTokens || !sameDiscovered(current.discovered, [...sw.rootViewTokens.entries.values()])) {
      sw.rootViewTokens = undefined; return { ok: false, error: 'request_invalid' };
    }
    const tree = await createChromeBookmarkTreeAdapter(await personalSyncNativeApi(scope, personalTreeApi())).read();
    const privateNativeIds = [...new Set([...await privateNativeIdsFor(scope), ...excluded])];
    const scan = scanBoundary({ roots: tree.roots, selectedNativeIds: selected,
      excludedNativeIds: excluded, privateNativeIds });
    const authority = await readSnapshotAuthority(scope);
    const rootNodeId = rootId(authority.snapshot.remoteFacts);
    if (!rootNodeId) return { ok: false, error: 'snapshot_root_invalid' };
    const mounts = await resolvedMounts(scope, scan.mounts, authority.snapshot.remoteFacts, rootNodeId);
    const localFacts = normalizeMountFacts(advancedLocalFacts(tree.roots, scan), scan.selectedNativeIds);
    const mappings = (await syncState.listMappings(scope)).map(({ nativeId, colpId }) => ({ nativeId, colpId }));
    const mappingDigest = digestJson(mappings as unknown as JsonObject[]);
    const treeDigest = advancedTreeDigest(scan.treeDigest, localFacts);
    const previewId = crypto.randomUUID();
    const result = buildPreviewPlan({ scope, previewId, mode,
      boundaryVersion: boundaryVersion(await syncState.getScope(scope)),
      treeDigest, snapshot: authority.snapshot, localFacts, remoteFacts: authority.snapshot.remoteFacts,
      mappings, mounts, rootNodeId });
    const cache = cachePreview({ scope, scopeKey: rootScopeKey(scope), viewId: message.viewId, previewId, mode,
      boundaryVersion: result.boundaryVersion,
      selectedNativeIds: scan.selectedNativeIds, excludedNativeIds: scan.excludedNativeIds,
      discovered: current.discovered, mounts, rootNodeId, localFacts, remoteFacts: authority.snapshot.remoteFacts,
      mappings, mappingDigest, treeDigest, snapshot: authority.snapshot, plan: result.plan, report: result.report,
      counts: { bookmarkCount: scan.bookmarkCount, folderCount: scan.folderCount, skippedCount: scan.skippedCount } });
    return previewResponse(cache, scan.warnings);
  } catch (error) {
    return { ok: false, error: advancedErrorCode(error) };
  }
}

export async function handleAdvancedFirstRunConfirm(
  message: Extract<FirstRunConfirmRequest, { readonly kind: 'known.firstRun.confirm' }>,
): Promise<FirstRunOrScopeResponse> {
  let scope: SyncScope;
  try { scope = await currentSyncScope(); }
  catch { return { ok: false, error: 'not_connected' }; }
  const key = `${rootScopeKey(scope)}\u001f${message.previewId}\u001f${message.confirmationId}`;
  const prior = confirmationInFlight.get(key);
  if (prior) return prior;
  const operation = confirmAdvanced(scope, message).finally(() => {
    if (confirmationInFlight.get(key) === operation) confirmationInFlight.delete(key);
  });
  confirmationInFlight.set(key, operation);
  return operation;
}

export async function advancedFirstRunStatus(scope: SyncScope): Promise<FirstRunOrScopeResponse | null> {
  const plans = (await syncState.listAdvancedPlans(scope)).filter((plan) => plan.state !== 'completed')
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const plan = plans[0];
  if (!plan) return null;
  const [runs, loaded] = await Promise.all([
    syncState.listBootstrapRuns(scope), syncState.readAdvancedPlan(scope, plan.planId),
  ]);
  const run = runs.find((candidate) => candidate.runId === plan.planId);
  const attention = plan.state === 'attention' || run?.phase === 'needs_attention'
    || loaded?.steps.some((step) => step.state === 'attention') === true;
  const phase = attention ? 'needs_attention' : 'syncing';
  const recorded = await syncState.getScope(scope);
  return { ok: true, phase, firstRun: recorded?.firstRun === 'completed' ? 'completed' : 'running' };
}

function buildPreviewPlan(input: {
  readonly scope: SyncScope; readonly previewId: string; readonly mode: AdvancedPreviewMode;
  readonly boundaryVersion: string;
  readonly treeDigest: string; readonly snapshot: CompleteRemoteSnapshot;
  readonly localFacts: readonly LocalNodeFact[]; readonly remoteFacts: readonly RemoteNodeFact[];
  readonly mappings: readonly MappingFact[]; readonly mounts: readonly MountFact[]; readonly rootNodeId: string;
}): { readonly boundaryVersion: string; readonly plan?: AdvancedPlan; readonly report: ReportCounts } {
  const report = previewReport(input);
  if (input.mode === 'merge' || input.mode === 'preview-only') {
    return { boundaryVersion: input.boundaryVersion, report };
  }
  const plan = buildAdvancedPlan({ scope: input.scope, planId: advancedPlanIdFromPreview(input.previewId),
    confirmationId: input.previewId, mode: input.mode, boundaryVersion: input.boundaryVersion,
    treeDigest: input.treeDigest, remoteSnapshotId: input.snapshot.snapshotId,
    remoteRevision: input.snapshot.revision, remoteCursor: input.snapshot.syncCursor,
    local: input.localFacts, remote: input.remoteFacts, mappings: input.mappings, mounts: input.mounts,
    rootNodeId: input.rootNodeId });
  return { boundaryVersion: input.boundaryVersion, plan, report };
}

function previewReport(input: {
  readonly scope: SyncScope; readonly mode: AdvancedPreviewMode; readonly localFacts: readonly LocalNodeFact[];
  readonly remoteFacts: readonly RemoteNodeFact[]; readonly mappings: readonly MappingFact[];
  readonly mounts: readonly MountFact[]; readonly rootNodeId: string;
}): ReportCounts {
  const report = matchLocalRemote({ scopeKey: rootScopeKey(input.scope), confirmationId: 'advanced-preview',
    bootstrapMode: input.mode === 'preview-only' ? 'merge' : input.mode, previewOnly: true,
    local: input.localFacts, remote: input.remoteFacts, mappings: input.mappings, mounts: input.mounts,
    rootNodeId: input.rootNodeId });
  return { matched: report.matched.length, localOnly: report.localOnly.length, remoteOnly: report.remoteOnly.length,
    candidates: report.candidates.length, conflicts: report.conflicts.length };
}

function cachePreview(input: Omit<CachedAdvancedPreview, 'cacheKey' | 'expiresAt'>): CachedAdvancedPreview {
  const cacheKey = `${rootScopeKey(input.scope)}\u001f${input.previewId}`;
  pruneAdvancedPreviews(Date.now());
  const value: CachedAdvancedPreview = { ...input, cacheKey, expiresAt: Date.now() + ADVANCED_PREVIEW_TTL_MS };
  advancedPreviews.delete(cacheKey); advancedPreviews.set(cacheKey, value);
  pruneAdvancedPreviews(Date.now());
  return value;
}

function pruneAdvancedPreviews(now: number): void {
  for (const [key, value] of advancedPreviews) if (value.expiresAt <= now) advancedPreviews.delete(key);
  while (advancedPreviews.size >= MAX_ADVANCED_PREVIEWS) {
    const first = advancedPreviews.keys().next().value as string | undefined;
    if (!first) break;
    advancedPreviews.delete(first);
  }
}

function cachedPreview(scope: SyncScope, previewId: string): CachedAdvancedPreview | undefined {
  const key = `${rootScopeKey(scope)}\u001f${previewId}`;
  const value = advancedPreviews.get(key);
  if (!value || value.expiresAt <= Date.now()) {
    advancedPreviews.delete(key); return undefined;
  }
  advancedPreviews.delete(key); advancedPreviews.set(key, value);
  return value;
}

function forgetCachedPreview(value: CachedAdvancedPreview): void {
  advancedPreviews.delete(value.cacheKey);
}

function previewResponse(cache: CachedAdvancedPreview, warnings: readonly { readonly code: string }[]): FirstRunPreviewOk {
  const advanced = cache.plan ? confirmationForPlan(cache.plan) : undefined;
  return { ok: true, previewId: cache.previewId, boundaryVersion: cache.boundaryVersion,
    treeDigest: cache.treeDigest, ...cache.counts, warnings, report: cache.report,
    ...(advanced ? { advanced } : {}) };
}

function confirmationForPlan(plan: AdvancedPlan): NonNullable<FirstRunPreviewOk['advanced']> {
  const expected = { scopeFingerprint: plan.scopeFingerprint, treeDigest: plan.treeDigest, mode: plan.mode,
    remoteSnapshotId: plan.remoteSnapshotId, remoteRevision: plan.remoteRevision, remoteCursor: plan.remoteCursor,
    destructivePlanDigest: plan.destructivePlanDigest } satisfies Omit<AdvancedConfirmationBinding, 'confirmationProof'>;
  const deletes = plan.checklist.filter((item) => item.action === 'delete' || item.action === 'remove').map((item) => {
    const step = plan.steps.find((candidate) => candidate.stepId === item.stepId);
    const baseRevision = step && step.side === 'remote' && step.action === 'delete'
      ? step.payload.baseRevision : undefined;
    return { targetId: item.targetId, side: item.side, kind: item.kind, title: item.title,
      parentId: item.parentId, ...(baseRevision ? { baseRevision } : {}) };
  });
  return { ...expected, confirmationProof: advancedConfirmationProof(expected), deletes };
}

async function confirmAdvanced(scope: SyncScope,
  message: Extract<FirstRunConfirmRequest, { readonly kind: 'known.firstRun.confirm' }>): Promise<FirstRunOrScopeResponse> {
  if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
  if (await kns09Paused('coordinator')) return { ok: false, error: 'sync_paused' };
  const mode = message.bootstrapMode;
  const confirmation = message.advancedConfirmation;
  if (!mode || mode === 'merge' || !confirmation || confirmation.mode !== mode) {
    return { ok: false, error: 'request_invalid' };
  }
  const libraryId = 'libraryId' in message ? message.libraryId : undefined;
  if (!libraryId) return { ok: false, error: 'library_required' };
  if (libraryId !== scope.collectionId) return { ok: false, error: 'scope_mismatch' };
  const planId = advancedPlanIdFromPreview(message.previewId);
  let existing;
  try { existing = await existingPlan(scope, planId, message.previewId, message.confirmationId, mode); }
  catch (error) { return { ok: false, error: advancedErrorCode(error) }; }
  if (existing) return advancedPlanStatus(scope, existing);
  if (await advancedWorkBusy(scope)) return { ok: false, error: 'sync_busy' };
  const cache = cachedPreview(scope, message.previewId);
  if (!cache) return { ok: false, error: 'preview_stale' };
  if (!cache.plan || cache.mode !== mode || cache.plan.planId !== planId) {
    forgetCachedPreview(cache);
    return { ok: false, error: 'preview_stale' };
  }
  const fresh = await rescanAdvanced(scope, cache);
  if (!fresh.ok) {
    if (!fresh.response.ok && fresh.response.error === 'preview_stale') forgetCachedPreview(cache);
    return fresh.response;
  }
  const expected = expectedConfirmation(fresh.plan);
  try { validateAdvancedConfirmation(confirmation, expected); }
  catch (error) {
    forgetCachedPreview(cache);
    return staleConfirmationResponse(fresh.counts, advancedErrorCode(error));
  }
  if (fresh.plan.digest !== cache.plan.digest || fresh.snapshot.identityDigest !== cache.snapshot.identityDigest) {
    forgetCachedPreview(cache);
    return staleConfirmationResponse(fresh.counts, 'bootstrap_confirmation_stale');
  }
  const metadata = advancedPlanMetadata({ scope, cache, plan: fresh.plan, confirmationId: message.confirmationId,
    selectedNativeIds: fresh.selectedNativeIds, excludedNativeIds: fresh.excludedNativeIds,
    mounts: fresh.mounts, rootNodeId: fresh.rootNodeId, boundaryVersion: fresh.boundaryVersion });
  const steps = [...snapshotFactSteps(fresh.remoteFacts, fresh.plan),
    // The pure planner deliberately shares immutable parent/value objects.
    // Persist their JSON representation, not shared JavaScript references.
    ...fresh.plan.steps.map((step) => JSON.parse(JSON.stringify(step)) as JsonObject)];
  const committed = await syncState.commitAdvancedPlan(scope, { planId, metadata, steps, now: Date.now() });
  try {
    // Activation is retry-safe. If the worker is interrupted after the atomic
    // plan commit, the engine sees the active plan on its next wake.
    const { activateAdvancedPlan } = await import('../bootstrap/advanced-run.js');
    await activateAdvancedPlan(syncState, scope, committed);
  } catch {
    return { ok: true, phase: 'syncing', firstRun: 'running' };
  }
  return { ok: true, phase: 'syncing', firstRun: 'running' };
}

async function existingPlan(scope: SyncScope, planId: string, previewId: string,
  confirmationId: string, mode: string) {
  const plans = await syncState.listAdvancedPlans(scope);
  const plan = plans.find((candidate) => candidate.planId === planId
    || candidate.metadata.previewId === previewId);
  if (!plan) return null;
  if (plan.metadata.confirmationId !== confirmationId || plan.metadata.mode !== mode) {
    throw new Error('bootstrap_confirmation_stale');
  }
  return plan;
}

async function advancedPlanStatus(scope: SyncScope, plan: { readonly planId: string;
  readonly state: 'active' | 'completed' | 'attention' }): Promise<FirstRunOrScopeResponse> {
  const runs = await syncState.listBootstrapRuns(scope);
  const loaded = plan.state === 'active' ? await syncState.readAdvancedPlan(scope, plan.planId) : null;
  const attention = plan.state === 'attention' || runs.some((run) => run.runId === plan.planId
    && run.phase === 'needs_attention') || loaded?.steps.some((step) => step.state === 'attention') === true;
  const phase = plan.state === 'completed' ? 'completed' : attention ? 'needs_attention' : 'syncing';
  return { ok: true, phase, firstRun: phase === 'completed' ? 'completed' : 'running' };
}

async function rescanAdvanced(scope: SyncScope, cache: CachedAdvancedPreview): Promise<{
  readonly ok: true; readonly plan: AdvancedPlan; readonly snapshot: CompleteRemoteSnapshot;
  readonly remoteFacts: readonly RemoteNodeFact[]; readonly mounts: readonly MountFact[]; readonly rootNodeId: string;
  readonly selectedNativeIds: readonly string[]; readonly excludedNativeIds: readonly string[];
  readonly boundaryVersion: string; readonly counts: Pick<FirstRunPreviewOk, 'bookmarkCount' | 'folderCount' | 'skippedCount'>;
} | { readonly ok: false; readonly response: FirstRunOrScopeResponse }> {
  try {
    if (!sw.rootViewTokens || sw.rootViewTokens.viewId !== cache.viewId
        || sw.rootViewTokens.scopeKey !== rootScopeKey(scope)) {
      return { ok: false, response: staleConfirmationResponse(cache.counts, 'boundary_changed') };
    }
    const current = await readRootFolders();
    if (!sameDiscovered(current.discovered, cache.discovered)) {
      return { ok: false, response: staleConfirmationResponse(cache.counts, 'boundary_changed') };
    }
    const tree = await createChromeBookmarkTreeAdapter(await personalSyncNativeApi(scope, personalTreeApi())).read();
    const scan = scanBoundary({ roots: tree.roots, selectedNativeIds: cache.selectedNativeIds,
      excludedNativeIds: cache.excludedNativeIds, privateNativeIds: [...new Set([...await privateNativeIdsFor(scope), ...cache.excludedNativeIds])] });
    const localFacts = normalizeMountFacts(advancedLocalFacts(tree.roots, scan), scan.selectedNativeIds);
    const treeDigest = advancedTreeDigest(scan.treeDigest, localFacts);
    const recorded = await syncState.getScope(scope);
    const currentBoundary = boundaryVersion(recorded);
    if (currentBoundary !== cache.boundaryVersion || treeDigest !== cache.treeDigest) {
      return { ok: false, response: staleConfirmationResponse({ bookmarkCount: scan.bookmarkCount,
        folderCount: scan.folderCount, skippedCount: scan.skippedCount }, 'boundary_changed') };
    }
    const authority = await readSnapshotAuthority(scope);
    if (authority.snapshot.snapshotId !== cache.snapshot.snapshotId
        || authority.snapshot.revision !== cache.snapshot.revision
        || authority.snapshot.syncCursor !== cache.snapshot.syncCursor) {
      return { ok: false, response: staleConfirmationResponse({ bookmarkCount: scan.bookmarkCount,
        folderCount: scan.folderCount, skippedCount: scan.skippedCount }, 'snapshot_changed') };
    }
    const rootNodeId = rootId(authority.snapshot.remoteFacts);
    if (!rootNodeId || rootNodeId !== cache.rootNodeId) {
      return { ok: false, response: staleConfirmationResponse({ bookmarkCount: scan.bookmarkCount,
        folderCount: scan.folderCount, skippedCount: scan.skippedCount }, 'snapshot_scope_changed') };
    }
    const mounts = await resolvedMounts(scope, scan.mounts, authority.snapshot.remoteFacts, rootNodeId);
    if (digestJson(mounts as unknown as JsonObject[]) !== digestJson(cache.mounts as unknown as JsonObject[])) {
      return { ok: false, response: staleConfirmationResponse({ bookmarkCount: scan.bookmarkCount,
        folderCount: scan.folderCount, skippedCount: scan.skippedCount }, 'boundary_changed') };
    }
    const mappings = (await syncState.listMappings(scope)).map(({ nativeId, colpId }) => ({ nativeId, colpId }));
    const mappingDigest = digestJson(mappings as unknown as JsonObject[]);
    if (mappingDigest !== cache.mappingDigest) {
      return { ok: false, response: staleConfirmationResponse({ bookmarkCount: scan.bookmarkCount,
        folderCount: scan.folderCount, skippedCount: scan.skippedCount }, 'mapping_changed') };
    }
    const plan = buildAdvancedPlan({ scope, planId: cache.plan?.planId, confirmationId: cache.previewId,
      mode: cache.mode as AdvancedMode, boundaryVersion: currentBoundary, treeDigest,
      remoteSnapshotId: authority.snapshot.snapshotId, remoteRevision: authority.snapshot.revision,
      remoteCursor: authority.snapshot.syncCursor, local: localFacts, remote: authority.snapshot.remoteFacts,
      mappings, mounts, rootNodeId });
    return { ok: true, plan, snapshot: authority.snapshot, remoteFacts: authority.snapshot.remoteFacts,
      mounts, rootNodeId, selectedNativeIds: scan.selectedNativeIds, excludedNativeIds: scan.excludedNativeIds,
      boundaryVersion: currentBoundary, counts: { bookmarkCount: scan.bookmarkCount,
        folderCount: scan.folderCount, skippedCount: scan.skippedCount } };
  } catch (error) {
    return { ok: false, response: { ok: false, error: advancedErrorCode(error) } };
  }
}

function expectedConfirmation(plan: AdvancedPlan): Omit<AdvancedConfirmationBinding, 'confirmationProof'> {
  return { scopeFingerprint: plan.scopeFingerprint, treeDigest: plan.treeDigest, mode: plan.mode,
    remoteSnapshotId: plan.remoteSnapshotId, remoteRevision: plan.remoteRevision, remoteCursor: plan.remoteCursor,
    destructivePlanDigest: plan.destructivePlanDigest };
}

function advancedPlanMetadata(input: {
  readonly scope: SyncScope; readonly cache: CachedAdvancedPreview; readonly plan: AdvancedPlan;
  readonly confirmationId: string; readonly selectedNativeIds: readonly string[];
  readonly excludedNativeIds: readonly string[]; readonly mounts: readonly MountFact[];
  readonly rootNodeId: string; readonly boundaryVersion: string;
}): JsonObject {
  return { mode: input.plan.mode, confirmationId: input.confirmationId, previewId: input.cache.previewId,
    treeDigest: input.plan.treeDigest, scopeFingerprint: input.plan.scopeFingerprint,
    remoteSnapshotId: input.plan.remoteSnapshotId, remoteRevision: input.plan.remoteRevision,
    remoteCursor: input.plan.remoteCursor, destructivePlanDigest: input.plan.destructivePlanDigest,
    selectedNativeIds: [...input.selectedNativeIds], excludedNativeIds: [...input.excludedNativeIds],
    discovered: input.cache.discovered as unknown as JsonObject[],
    mounts: input.mounts as unknown as JsonObject[], rootNodeId: input.rootNodeId,
    boundaryVersion: input.boundaryVersion, libraryId: input.scope.collectionId };
}

function snapshotFactSteps(remoteFacts: readonly RemoteNodeFact[], plan: AdvancedPlan): JsonObject[] {
  const nativeByRemote = new Map(plan.matched.map((pair) => [pair.nodeId, pair.nativeId]));
  return remoteFacts.map((fact) => ({ kind: 'snapshot-fact', fact: fact as unknown as JsonObject,
    nativeId: nativeByRemote.get(fact.nodeId) ?? null }));
}

async function readSnapshotAuthority(scope: SyncScope): Promise<{
  readonly credential: StoredCredential; readonly session: StoredSession; readonly snapshot: CompleteRemoteSnapshot;
}> {
  const config = await loadConfig();
  if (config.serverOrigin !== scope.serverOrigin) throw new Error('scope_mismatch');
  let credential = await store.loadCredential();
  let session = await store.loadSession();
  if (!credential?.subject || credential.subject !== scope.accountId) throw new Error('not_connected');
  // Preview and confirmation are read-only gates. Let the existing session
  // authority lane refresh an expired session; never register or rewrite a
  // scope while producing a confirmation-bound snapshot.
  if (!session || session.collection.collectionId !== scope.collectionId
      || !(await sessionMatchesCredentialAuthority(session, credential)) || syncSessionNeedsRenewal(session)) {
    throw new Error('session_expired');
  }
  if (!credential?.subject || credential.subject !== scope.accountId
      || session.collection.collectionId !== scope.collectionId
      || session.replicaLease.generation !== String(scope.generation)) throw new Error('scope_mismatch');
  const endpoints = await fetchSyncEndpoints(config);
  const snapshot = await loadCompleteRemoteSnapshot({ endpoint: endpoints.syncSnapshot,
    credential, session, scope, origin: extensionOrigin(), fetcher: personalSyncFetch(scope) });
  return { credential, session, snapshot };
}

async function resolvedMounts(scope: SyncScope, planned: readonly {
  readonly nativeRootId: string; readonly rootRole?: 'bookmarks-bar' | 'other-bookmarks' | 'mobile-bookmarks';
  readonly customSourceKey?: string; readonly writable: boolean;
}[], remoteFacts: readonly RemoteNodeFact[], rootNodeId: string): Promise<MountFact[]> {
  const bindings = await syncState.listMountBindings(scope);
  const byNative = new Map(bindings.filter((binding) => binding.status !== 'detached')
    .map((binding) => [binding.nativeRootId, binding]));
  const selected = new Map<string, MountFact>();
  for (const mount of planned) {
    if (!mount.writable) continue;
    const binding = byNative.get(mount.nativeRootId);
    const remoteMountNodeId = binding?.remoteMountNodeId ?? roleRemoteId(mount.rootRole, remoteFacts, rootNodeId);
    selected.set(mount.nativeRootId, { nativeRootId: mount.nativeRootId,
      remoteMountNodeId: remoteMountNodeId ?? null, ...(mount.rootRole ? { rootRole: mount.rootRole } : {}),
      ...(mount.customSourceKey ? { customSourceKey: mount.customSourceKey } : {}) });
  }
  for (const binding of byNative.values()) if (!selected.has(binding.nativeRootId)
      && planned.some((mount) => mount.nativeRootId === binding.nativeRootId)) {
    selected.set(binding.nativeRootId, { nativeRootId: binding.nativeRootId,
      remoteMountNodeId: binding.remoteMountNodeId, ...(binding.rootRole ? { rootRole: binding.rootRole } : {}),
      ...(binding.customSourceKey ? { customSourceKey: binding.customSourceKey } : {}) });
  }
  return [...selected.values()];
}

function roleRemoteId(role: MountFact['rootRole'], remoteFacts: readonly RemoteNodeFact[], rootNodeId: string): string | null {
  if (!role) return null;
  const candidates = remoteFacts.filter((row) => row.parentId === rootNodeId && row.folderRole === role);
  if (candidates.length > 1) throw new Error('advanced_mount_ambiguous');
  return candidates[0]?.nodeId ?? null;
}

function normalizeMountFacts(facts: readonly LocalNodeFact[], selectedNativeIds: readonly string[]): LocalNodeFact[] {
  const selected = new Set(selectedNativeIds);
  return facts.map((fact) => selected.has(fact.nativeId)
    ? { ...fact, mountNativeRootId: fact.nativeId, parentNativeId: null } : fact);
}

function advancedTreeDigest(scanDigest: string, localFacts: readonly LocalNodeFact[]): string {
  const facts = [...localFacts].sort((left, right) => left.nativeId.localeCompare(right.nativeId));
  return digestJson({ boundary: scanDigest, facts: facts as unknown as JsonObject[] });
}

function rootId(remoteFacts: readonly RemoteNodeFact[]): string | undefined {
  const roots = remoteFacts.filter((fact) => fact.parentId === null && fact.folderRole === 'root'
    && fact.kind === 'folder');
  if (roots.length !== 1) return undefined;
  return roots[0]!.nodeId;
}

function boundaryVersion(record: { readonly boundaryVersion?: string } | null): string {
  return record?.boundaryVersion ?? '0';
}

function staleConfirmationResponse(counts: Pick<FirstRunPreviewOk, 'bookmarkCount' | 'folderCount' | 'skippedCount'>,
  _reason: string): FirstRunOrScopeResponse {
  return { ok: false, error: 'preview_stale', ...counts };
}

function resolvePreviewRefs(scope: SyncScope, viewId: string, refs: readonly string[]): string[] | null {
  if (!Array.isArray(refs) || refs.length > 128 || refs.some((ref) => typeof ref !== 'string')) return null;
  if (!sw.rootViewTokens || sw.rootViewTokens.viewId !== viewId || sw.rootViewTokens.scopeKey !== rootScopeKey(scope)) {
    return null;
  }
  const resolved = refs.map((ref) => sw.rootViewTokens!.entries.get(ref)?.nativeId);
  return resolved.some((value) => !value) ? null : resolved as string[];
}

async function privateNativeIdsFor(scope: SyncScope): Promise<string[]> {
  const recorded = await syncState.getScope(scope);
  const mappings = await syncState.listMappings(scope);
  const byColp = new Map(mappings.map((mapping) => [mapping.colpId, mapping.nativeId]));
  return (recorded?.privateRoots ?? []).map((id) => byColp.get(id)).filter((id): id is string => Boolean(id));
}

async function advancedWorkBusy(scope: SyncScope): Promise<boolean> {
  if ((await syncState.listAdvancedPlans(scope)).some((plan) => plan.state !== 'completed')) return true;
  const statuses = ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'rejected', 'set_aside'] as const;
  const liveQueue = await Promise.all(statuses.map((status) => syncState.listQueue(scope, status, 0, 1)));
  if (liveQueue.some((page) => page.length > 0)) return true;
  const [events, intents, recovery, imports, acks, engine, recorded] = await Promise.all([
    syncState.listBookmarkEventsByStatus(scope, 'pending', 0, 1),
    syncState.listProjectionIntents(scope), syncState.hasRecoveryStaging(scope), syncState.listImportPlans(scope),
    syncState.listAckIntents(scope), syncState.getEngineState(scope), syncState.getScope(scope),
  ]);
  if (events.length > 0 || intents.some((intent) => intent.state !== 'terminal') || recovery
      || imports.some((plan) => plan.state === 'active') || acks.some((ack) => ack.state === 'pending')
      || acks.some((ack) => ack.kind === 'bootstrap' && ack.state === 'complete')) return true;
  if (recorded?.firstRun === 'running' || recorded?.firstRun === 'completed') return true;
  return engine?.phase === 'bootstrap' || engine?.phase === 'pulling' || engine?.phase === 'applying'
    || engine?.phase === 'acking' || engine?.phase === 'pushing';
}

function advancedErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  if (/^[a-z][a-z0-9_]{0,63}$/u.test(value)) {
    if (value === 'bootstrap_confirmation_stale' || value === 'snapshot_changed'
        || value === 'boundary_changed' || value === 'snapshot_scope_changed') return value;
    return value;
  }
  return 'request_invalid';
}
