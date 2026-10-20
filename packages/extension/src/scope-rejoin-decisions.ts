import { retryRejoinCandidate, renewRejectedRejoin, rejoinCandidateFields, renewChangedRejoinOrder } from './scope-rejoin-rejection.js';
import { missingRejoinGroups, rejoinDeleteOperationId,
  stageMissingRejoinDelete, type MissingRejoinGroup } from './scope-rejoin-deletion.js';
import { applyRejoinOrder, assertRejoinOrderAuthority, planRejoinOrders, type RejoinOrderInput, type RejoinOrderPlan } from './scope-rejoin-order.js';
import { cachedRejoinAuthority, rejoinBoundaryDigest, rejoinAttemptDigest } from './scope-rejoin-authority.js';
import { assertRejoinBoundary, assertRejoinCanonicalBoundary } from './scope-rejoin-boundary.js';
import { planRejoinRestore } from './scope-rejoin-restore.js';
import { restoreEvidence, remoteDeleteEvidence } from './sync-state/rejoin-decision-repository.js';
import { remoteRejoinDeleteCandidate, resumeRemoteRejoinDelete, stageRemoteRejoinDelete } from './scope-rejoin-remote-delete.js';
import { createRejoinQueue } from './scope-rejoin-parents.js';
import { materializeUnmountedRejoinMembers, rejoinMemberMappings } from './scope-rejoin-materialize.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import { observationValidForPause } from './sync-state/remote-observation.js';
import { rejoinScopeMount } from './scope-commands.js';
import type { JsonObject, MappingInput, ScopeCommandPlanRecord } from './sync-state-store.js';

export type RejoinDecisionChoice = 'keep_remote' | 'delete_remote' | 'keep_local_order' | 'keep_remote_order'
  | 'keep_local' | 'apply_remote_delete';
export type RejoinDecisionBlockedReason = 'pending_upload' | 'unknown_upload' | 'upload_boundary_changed' | 'native_unavailable';
export type RejoinDecisionRecoveryAction = 'retry_sync' | 'reset_sync' | 'refresh';
export type RejoinDecisionRequest = { readonly kind: 'known.sync.rejoinDecisions.get' }
  | { readonly kind: 'known.sync.rejoinDecisions.resolve'; readonly commandId: string; readonly token: string;
      readonly choice: Exclude<RejoinDecisionChoice, 'apply_remote_delete'>; readonly userGesture: true }
  | { readonly kind: 'known.sync.rejoinDecisions.resolve'; readonly commandId: string; readonly token: string;
      readonly choice: 'apply_remote_delete'; readonly userGesture: true;
      readonly affectedCount: number; readonly confirmSubtree: true };
export interface PublicRejoinDecision {
  readonly commandId: string; readonly token: string; readonly kind: 'local_delete' | 'order' | 'remote_delete';
  readonly title: string; readonly affectedCount: number; readonly state: 'pending' | 'applying';
  readonly localOrder?: readonly string[]; readonly remoteOrder?: readonly string[];
  readonly blockedReason?: RejoinDecisionBlockedReason;
  readonly recoveryAction?: RejoinDecisionRecoveryAction;
}
export type RejoinDecisionResponse = { readonly ok: true; readonly decisions: readonly PublicRejoinDecision[] }
  | { readonly ok: false; readonly error: string };
export type RejoinDecisionInput = Omit<RejoinOrderInput, 'mount'> & {
  readonly recoveryAvailability?: () => Promise<{ readonly retryAvailable: boolean; readonly resetAvailable: boolean }>;
};
type DecisionFacts = { input: RejoinOrderInput; mappings: MappingInput[]; group?: MissingRejoinGroup; order?: RejoinOrderPlan };
const choices = ['keep_remote', 'delete_remote', 'keep_local_order', 'keep_remote_order', 'keep_local', 'apply_remote_delete'];
const isDecision = (record: ScopeCommandPlanRecord) => /^rejoin-(delete|order|remote-delete):/.test(record.commandId);

export function validRejoinDecisionRequest(value: unknown): value is RejoinDecisionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.kind === 'known.sync.rejoinDecisions.get') return Object.keys(row).length === 1;
  const subtree = row.choice === 'apply_remote_delete';
  return row.kind === 'known.sync.rejoinDecisions.resolve' && Object.keys(row).length === (subtree ? 7 : 5) && row.userGesture === true
    && (!subtree || row.confirmSubtree === true && Number.isSafeInteger(row.affectedCount) && Number(row.affectedCount) >= 0)
    && typeof row.commandId === 'string' && row.commandId.length <= 1_024 && /^rejoin-(delete|order|remote-delete):/.test(row.commandId)
    && typeof row.token === 'string' && /^sha256:[0-9a-f]{64}$/.test(row.token)
    && typeof row.choice === 'string' && choices.includes(row.choice);
}
async function facts(input: RejoinDecisionInput, record: ScopeCommandPlanRecord): Promise<DecisionFacts> {
  const mount = record.mountId ? await input.store.getMountBinding(input.scope, record.mountId) : null;
  if (!mount || mount.pauseBaseline?.generation !== input.scope.generation) throw new Error('preview_stale');
  const scoped = cachedRejoinAuthority({ ...input, mount });
  const mappings = rejoinMemberMappings(await input.store.listMappings(input.scope), mount);
  const observations = (await input.store.listRemoteObservations(input.scope))
    .filter(row => observationValidForPause(row, mount.pauseBaseline));
  const current: DecisionFacts = record.rejoinDecision?.kind === 'local_delete'
    ? { input: scoped, mappings, group: (await missingRejoinGroups(scoped, mappings, observations))
      .find(row => row.root.colpId === record.rejoinDecision?.rootId) }
    : { input: scoped, mappings, order: (await planRejoinOrders(scoped, mappings, observations,
      record.rejoinDecision?.rejectedReferences ? String(record.rejoinDecision.parentId) : undefined))
      .find(row => row.parent.colpId === record.rejoinDecision?.parentId) };
  return { ...current, ...(current.group ? { group: retryRejoinCandidate(current.group, record) } : {}),
    ...(current.order ? { order: retryRejoinCandidate(current.order, record) } : {}) };
}

/** Stored accepted evidence, rather than partly mutated live state, owns the public choice. */
export async function listRejoinDecisions(input: RejoinDecisionInput): Promise<PublicRejoinDecision[]> {
  const names = new Map((await input.store.listMappings(input.scope))
    .map(row => [row.nativeId, String(row.projection.content?.title ?? '')]));
  const result: PublicRejoinDecision[] = [];
  let recovery: Awaited<ReturnType<NonNullable<RejoinDecisionInput['recoveryAvailability']>>> | undefined;
  for (const record of await input.store.listScopeCommandPlans(input.scope)) {
    if (!isDecision(record) || ['active', 'failed'].includes(record.phase) || !record.baselineDigest) continue;
    const value = record.rejoinDecision!;
    const blockedReason = typeof value.blockedReason === 'string' ? value.blockedReason as RejoinDecisionBlockedReason : undefined;
    if (blockedReason && input.recoveryAvailability) recovery ??= await input.recoveryAvailability();
    const recoveryAction: RejoinDecisionRecoveryAction = blockedReason === 'upload_boundary_changed'
      ? recovery?.resetAvailable ? 'reset_sync' : 'refresh'
      : recovery?.retryAvailable ? 'retry_sync' : recovery?.resetAvailable ? 'reset_sync' : 'refresh';
    result.push({ commandId: record.commandId, token: record.baselineDigest,
      kind: value.kind === 'remote_delete' ? 'remote_delete' : value.kind === 'order' ? 'order' : 'local_delete', title: String(value.title ?? ''),
      affectedCount: Number(value.affectedCount ?? record.dependencies.length),
      state: record.phase === 'pending' ? 'pending' : 'applying',
      ...(blockedReason ? { blockedReason, recoveryAction } : {}),
      ...(Array.isArray(value.localOrder) ? { localOrder: value.localOrder.map(id => names.get(String(id)) ?? '') } : {}),
      ...(Array.isArray(value.remoteOrder) ? { remoteOrder: value.remoteOrder.map(id => names.get(String(id)) ?? '') } : {}) });
  }
  return result;
}

export async function resolveRejoinDecision(input: RejoinDecisionInput,
  request: Extract<RejoinDecisionRequest, { kind: 'known.sync.rejoinDecisions.resolve' }>): Promise<void> {
  if (!validRejoinDecisionRequest(request)) throw new Error('request_invalid');
  let record = await input.store.getScopeCommandPlan(input.scope, request.commandId);
  if (!record || !isDecision(record)) throw new Error('decision_not_found');
  if (record.phase === 'active' && record.baselineDigest === request.token && record.retryReason === request.choice) return;
  if (record.rejoinDecision?.kind === 'remote_delete') {
    if (!['keep_local', 'apply_remote_delete'].includes(request.choice)) throw new Error('request_invalid');
    if (record.phase === 'pending') {
      const current = await remoteDeleteFacts(input, record);
      if (record.baselineDigest !== request.token || current.candidate.token !== request.token) {
        await stageRemoteRejoinDelete(current.input, current.candidate); throw new Error('preview_stale');
      }
      if (current.candidate.blockedReason) throw new Error('rejoin_dependency_pending');
      if (request.choice === 'apply_remote_delete' && request.affectedCount !== current.candidate.affectedCount) throw new Error('preview_stale');
      record = await input.store.confirmRejoinDecision(input.scope, { commandId: record.commandId, token: request.token,
        choice: request.choice, dependencies: [] });
      input.crash?.('after_rejoin_confirmation');
    } else if (record.baselineDigest !== request.token || record.retryReason !== request.choice) throw new Error('decision_already_made');
    await refreshRejoinDecisions(input); return;
  }
  if (record.phase === 'pending') {
    const current = await facts(input, record);
    const candidate = current.group ?? current.order;
    if (!candidate || record.baselineDigest !== request.token || candidate.token !== request.token) {
      if (candidate) await putPlan(input, record, { baselineDigest: candidate.token,
        rejoinDecision: { ...record.rejoinDecision, ...rejoinCandidateFields(candidate),
          authorityDigest: candidate.authorityDigest, boundaryDigest: candidate.boundaryDigest } });
      throw new Error('preview_stale');
    }
    const allowed = current.group ? ['keep_remote', 'delete_remote'] : ['keep_local_order', 'keep_remote_order'];
    if (!allowed.includes(request.choice)) throw new Error('request_invalid');
    let dependencies: readonly string[] = [];
    let evidence: JsonObject;
    if (current.group && request.choice === 'keep_remote') {
      const restore = await planRejoinRestore(current.input, current.group);
      dependencies = restore.changes.filter(row => row.after.nativeId.startsWith('unmounted:')).map(row => row.after.colpId);
      evidence = { restore: restore as unknown as JsonObject };
    } else if (current.group) {
      if (!current.group.remote || current.group.blockedByLocalMove) throw new Error('rejoin_waiting_local_move');
      await assertRejoinBoundary(current.input, current.group.root, { allowMissing: true,
        expectedBoundary: current.group.boundaryDigest });
      dependencies = [rejoinDeleteOperationId(current.group)];
      const { token: previewDigest, ...deletion } = current.group;
      evidence = { deletion: { ...deletion, previewDigest } as unknown as JsonObject };
    } else {
      const { token: previewDigest, ...order } = current.order!;
      evidence = { order: { ...order, previewDigest } as unknown as JsonObject };
    }
    record = await input.store.confirmRejoinDecision(input.scope, { commandId: record.commandId,
      token: request.token, choice: request.choice, dependencies, evidence });
    input.crash?.('after_rejoin_confirmation');
  } else if (record.baselineDigest !== request.token || record.retryReason !== request.choice) {
    throw new Error('decision_already_made');
  }
  await refreshRejoinDecisions(input);
}

/** Confirmed and applying work both resume after worker eviction; a GET drives this before listing. */
export async function refreshRejoinDecisions(input: RejoinDecisionInput): Promise<void> {
  input = cachedRejoinAuthority(input);
  const touched = new Set<string>();
  for (const record of await input.store.listScopeCommandPlans(input.scope)) {
    if (record.rejoinDecision?.kind === 'remote_delete' && record.phase === 'pending' && !record.rejoinDecision.supersededBy) {
      try {
        const current = await remoteDeleteFacts(input, record);
        if (current.candidate.token !== record.baselineDigest
          || current.candidate.blockedReason !== record.rejoinDecision.blockedReason) await stageRemoteRejoinDelete(current.input, current.candidate);
      } catch (error) {
        if (!(error instanceof Error) || !['rejoin_boundary_changed', 'preview_stale', 'rejoin_parent_missing'].includes(error.message)) throw error;
        await putPlan(input, record, { rejoinDecision: { ...record.rejoinDecision, blockedReason: 'native_unavailable' } });
      }
      continue;
    }
    if (!isDecision(record) || !['confirmed', 'applying'].includes(record.phase)) continue;
    const mount = record.mountId ? await input.store.getMountBinding(input.scope, record.mountId) : null;
    if (!mount) { await failDecision(input, record, 'rejoin_boundary_changed'); continue; }
    const scoped = cachedRejoinAuthority({ ...input, mount });
    try {
      if (rejoinBoundaryDigest(await input.store.getScope(input.scope)) !== record.rejoinDecision?.boundaryDigest
        || mount.boundaryVersion !== record.confirmationVersion) throw new Error('rejoin_boundary_changed');
      if (record.rejoinDecision?.kind === 'remote_delete') {
        await resumeRemoteRejoinDelete(scoped, record); touched.add(mount.mountId); continue;
      }
      const complete = record.retryReason === 'keep_remote' ? await resumeRestore(scoped, record)
        : record.retryReason === 'delete_remote' ? await resumeDelete(scoped, record)
          : await resumeOrder(scoped, record);
      if (complete) {
        await input.store.completeRejoinDecision(input.scope, record.commandId); touched.add(mount.mountId);
      }
    } catch (error) {
      if (record.rejoinDecision?.kind === 'remote_delete' && error instanceof Error
        && ['rejoin_boundary_changed', 'preview_stale', 'rejoin_parent_missing'].includes(error.message)) {
        try {
          const current = await remoteDeleteFacts(input, record);
          if (current.candidate.token !== record.baselineDigest) await stageRemoteRejoinDelete(current.input, current.candidate);
          else await putPlan(input, record, { rejoinDecision: { ...record.rejoinDecision, blockedReason: 'native_unavailable' } });
        } catch (currentError) {
          if (!(currentError instanceof Error)
            || !['rejoin_boundary_changed', 'preview_stale', 'rejoin_parent_missing'].includes(currentError.message)) throw currentError;
          await putPlan(input, record, { rejoinDecision: { ...record.rejoinDecision, blockedReason: 'native_unavailable' } });
        }
        continue;
      }
      if (error instanceof Error && ['rejoin_order_changed', 'preview_stale'].includes(error.message)
        && record.rejoinDecision?.kind === 'order' && await renewChangedRejoinOrder(scoped, record)) continue;
      if (error instanceof Error && ['rejoin_boundary_changed', 'preview_stale', 'scope_not_found', 'scope_retired'].includes(error.message)) {
        await failDecision(input, record, error.message); continue;
      }
      if (error instanceof Error && error.message === 'rejoin_parent_missing') continue;
      throw error;
    }
  }
  // A decision and its native work can finish just before the worker exits.
  // Resume only a still-open comparison for this pause, never a historical
  // completed decision after the user has paused the mount again.
  for (const record of await input.store.listScopeCommandPlans(input.scope)) {
    if (record.kind !== 'rejoin' || isDecision(record) || !record.mountId
      || !['comparing', 'pending', 'applying'].includes(record.phase)) continue;
    const mount = await input.store.getMountBinding(input.scope, record.mountId);
    if (!mount || mount.status !== 'detached' || record.confirmationVersion !== mount.boundaryVersion
      || record.baselineDigest !== rejoinAttemptDigest(mount, await input.store.getScope(input.scope))) continue;
    const dependencies = await currentRejoinDependencies({ ...input, mount });
    if (dependencies.every(row => row.phase === 'active') && (dependencies.length || record.phase === 'applying')) {
      touched.add(mount.mountId);
    }
  }
  for (const mountId of touched) await rejoinScopeMount(input.store, input.scope, mountId, new Set(), [], input);
}
async function remoteDeleteFacts(input: RejoinDecisionInput, record: ScopeCommandPlanRecord) {
  const mount = record.mountId ? await input.store.getMountBinding(input.scope, record.mountId) : null;
  const before = remoteDeleteEvidence(record).authority.before;
  const root = await input.store.getMappingByNativeId(input.scope, before.nativeId);
  if (!mount || mount.status !== 'detached' || !root || root.colpId !== before.colpId
    || rejoinAttemptDigest(mount, await input.store.getScope(input.scope)) !== record.rejoinDecision?.attemptDigest) throw new Error('preview_stale');
  const scoped = cachedRejoinAuthority({ ...input, mount });
  return { input: scoped, candidate: await remoteRejoinDeleteCandidate(scoped, root) };
}

async function resumeRestore(input: RejoinOrderInput, record: ScopeCommandPlanRecord): Promise<boolean> {
  const evidence = restoreEvidence(record);
  const all = await input.store.listMappings(input.scope);
  const root = all.find(row => row.nativeId === input.mount.nativeRootId);
  if (!root || root.colpId !== input.mount.remoteMountNodeId) throw new Error('rejoin_boundary_changed');
  const presentIds = new Set(all.map(row => row.colpId));
  if (record.phase === 'applying' && record.dependencies.some(id => !presentIds.has(id))) {
    throw new Error('rejoin_boundary_changed');
  }
  if (record.phase === 'confirmed') {
    const projected = new Map(all.map(row => [row.colpId, row as MappingInput]));
    for (const change of evidence.changes) projected.set(change.after.colpId, change.after);
    await assertRejoinCanonicalBoundary(input, [...projected.values()], evidence.changes.map(row => row.after),
      String(record.rejoinDecision?.boundaryDigest));
    await input.store.prepareRejoinRestore(input.scope, record.commandId);
    input.crash?.('after_rejoin_restore_preparation');
  }
  await assertRejoinCanonicalBoundary(input, await input.store.listMappings(input.scope),
    evidence.changes.map(row => row.after), String(record.rejoinDecision?.boundaryDigest));
  await materializeUnmountedRejoinMembers(input, await input.store.listMappings(input.scope));
  const current = new Map((await input.store.listMappings(input.scope)).map(row => [row.colpId, row]));
  const mounts = new Map((await input.store.listMountBindings(input.scope)).map(row => [row.mountId, row]));
  for (const id of record.dependencies) {
    const mapping = current.get(id);
    if (!mapping) throw new Error('rejoin_boundary_changed');
    const destination = mapping.mountId ? mounts.get(mapping.mountId) : undefined;
    if (destination?.status === 'detached' && destination.mountId !== input.mount.mountId) continue;
    if (mapping.nativeId.startsWith('sidecar:')) continue;
    if (isNonChromeNativeId(mapping.nativeId) || !await input.getNative(mapping.nativeId)) return false;
  }
  await input.store.deleteRemoteObservations(input.scope, record.dependencies);
  return true;
}

async function resumeDelete(input: RejoinOrderInput, record: ScopeCommandPlanRecord): Promise<boolean> {
  const opId = record.dependencies[0];
  if (!opId) throw new Error('command_decision_invalid');
  await input.store.authorizeRejoinRecovery(input.scope, record.commandId);
  if (!await input.store.getQueueByOpId(input.scope, opId)) {
    const current = await facts(input, record);
    if (!current.group || current.group.token !== record.baselineDigest) throw new Error('preview_stale');
    await stageMissingRejoinDelete(input, current.group, opId);
  }
  if (record.phase === 'confirmed') await putPlan(input, record, { phase: 'applying' });
  return dependenciesComplete(input, record);
}

async function resumeOrder(input: RejoinOrderInput, record: ScopeCommandPlanRecord): Promise<boolean> {
  const order = record.rejoinDecision?.order as unknown as RejoinOrderPlan | undefined;
  if (!order) throw new Error('command_decision_invalid');
  await assertRejoinBoundary(input, order.parent, { expectedBoundary: order.boundaryDigest });
  await input.store.restoreRejectedRejoinBaselines(input.scope, record.commandId);
  if (record.retryReason === 'keep_remote_order') {
    await applyRejoinOrder(input, order, order.remote, record.commandId); return true;
  }
  const queue = createRejoinQueue(input, record.commandId);
  if (record.phase === 'confirmed') {
    await assertRejoinOrderAuthority(input, order);
    const parent = await input.store.getMappingByNativeId(input.scope, order.parent.nativeId);
    if (!parent || !input.getChildren) throw new Error('rejoin_order_changed');
    let pending = (await input.store.listPendingReorders(input.scope)).find(row => row.parentNativeId === parent.nativeId);
    if (!pending) {
      const { scopeKey: _key, ...rest } = parent;
      await input.store.putMapping(input.scope, { ...rest, projection: { ...parent.projection, childrenOrder: [...order.remote],
        ...(order.childrenRevision ? { childrenRevision: order.childrenRevision } : {}) } });
      await queue.reordered(parent.nativeId, order.local);
      pending = (await input.store.listPendingReorders(input.scope)).find(row => row.parentNativeId === parent.nativeId);
    }
    if (!pending) return true;
    record = await putPlan(input, record, { phase: 'applying', dependencies: pending.moves.map(row => row.eventId) });
  }
  await input.store.authorizeRejoinRecovery(input.scope, record.commandId);
  await queue.flush();
  return dependenciesComplete(input, record);
}

async function dependenciesComplete(input: RejoinOrderInput, record: ScopeCommandPlanRecord): Promise<boolean> {
  let complete = true;
  const rows = [];
  for (const id of record.dependencies) {
    const event = await input.store.getBookmarkEvent(input.scope, id);
    const opId = event?.opId ?? id;
    const row = await input.store.getQueueByOpId(input.scope, opId); rows.push(row);
    if (!row || row.status !== 'terminal' || row.recovery?.resultStatus === 'rejected'
      || row.recovery?.code === 'conflict_pending'
      || !(row.echoApplied || (await input.store.pullOperationsCovered(input.scope, [opId])).includes(opId))) complete = false;
  }
  if (!complete) await renewRejectedRejoin(input, record, rows);
  return complete;
}
async function putPlan(input: RejoinDecisionInput, record: ScopeCommandPlanRecord,
  patch: Partial<ScopeCommandPlanRecord>): Promise<ScopeCommandPlanRecord> {
  const latest = await input.store.getScopeCommandPlan(input.scope, record.commandId) ?? record;
  const { scopeKey: _key, ...value } = { ...latest, ...patch, updatedAt: Date.now() };
  await input.store.putScopeCommandPlan(input.scope, value);
  return { ...latest, ...patch, updatedAt: value.updatedAt };
}
async function failDecision(input: RejoinDecisionInput, record: ScopeCommandPlanRecord, reason: string) {
  await putPlan(input, record, { phase: 'failed', retryReason: reason });
}

/** Only dependencies of this attempt can block it; historical failures remain diagnostic history. */
export async function currentRejoinDependencies(input: RejoinOrderInput): Promise<ScopeCommandPlanRecord[]> {
  const attempt = rejoinAttemptDigest(input.mount, await input.store.getScope(input.scope));
  return (await input.store.listScopeCommandPlans(input.scope)).filter(record => isDecision(record)
    && record.mountId === input.mount.mountId && record.rejoinDecision?.attemptDigest === attempt && !record.rejoinDecision?.supersededBy);
}
