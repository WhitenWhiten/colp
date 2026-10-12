import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BootstrapNodeKind, DestructivePlan, LocalNodeFact, MappingFact, MountFact, RemoteNodeFact } from './matcher.js';
import { deletionOperationType } from '../bookmark-deletion-scope.js';
import { canonicalJson } from '../sync-state/codec.js';
import type { MappingInput, SyncScope } from '../sync-state-store.js';
import { scopeKey as makeScopeKey } from '../sync-state/scope-key.js';
import {
  AdvancedPlanError, type AdvancedMode, type AdvancedNodeKind, type AdvancedNodeValue, type AdvancedParentRef,
  type AdvancedPlan, type AdvancedPlanInput, type AdvancedRevisionRef, type AdvancedStep,
} from './advanced-plan-types.js';
import {
  authoritativeId, baseStep, changedContent, checklistForStep, desiredLocal, desiredRemote, freezeDeep,
  localDigestFacts, localState, nodeValue, nonEmpty, parentRefId, remoteState, sortLocalChildFirst,
  sortLocalParentFirst, sortRemoteChildFirst, sortRemoteParentFirst, stableId, selectedLocalIds,
  selectedRemoteIds, orderSteps, remoteMaterializedIndex,
} from './advanced-plan-utils.js';
import { compensatedLocalCreateIndex, localParentId, planLocalOrderMoves, planMatchedLocalSteps } from './advanced-local-order.js';
export * from './advanced-plan-types.js';
export interface AdvancedConfirmationBinding {
  readonly scopeFingerprint: string;
  readonly treeDigest: string;
  readonly mode: DestructivePlan['mode'];
  readonly remoteSnapshotId: string;
  readonly remoteRevision: string;
  readonly remoteCursor: string;
  readonly destructivePlanDigest: string;
  readonly confirmationProof: string;
}
/** Bind a confirmation to the selected profile and mount boundary. */
export function advancedScopeFingerprint(scope: SyncScope, boundaryVersion: string,
  mounts: readonly MountFact[]): string {
  return digest({ environment: scope.environment, serverId: scope.serverId, serverOrigin: scope.serverOrigin,
    accountId: scope.accountId, browserProfileId: scope.browserProfileId, collectionId: scope.collectionId,
    replicaId: scope.replicaId, generation: scope.generation, boundaryVersion,
    mounts: mounts.map((mount) => ({ nativeRootId: mount.nativeRootId, rootRole: mount.rootRole ?? null,
      customSourceKey: mount.customSourceKey ?? null, remoteMountNodeId: mount.remoteMountNodeId ?? null }))
      .sort((left, right) => left.nativeRootId.localeCompare(right.nativeRootId)) });
}
export function destructivePlanDigest(plan: {
  readonly mode: DestructivePlan['mode'];
  readonly deletes: readonly { readonly targetId: string; readonly side: 'local' | 'remote'; readonly nativeId?: string;
    readonly kind?: BootstrapNodeKind; readonly title?: string; readonly url?: string; readonly parentId?: string | null;
    readonly baseRevision?: string }[];
}): string {
  return digest({ mode: plan.mode, deletes: plan.deletes.map((item) => ({ targetId: item.targetId,
    side: item.side, nativeId: item.nativeId ?? null, kind: item.kind ?? null, title: item.title ?? null,
    url: item.url ?? null, parentId: item.parentId ?? null, baseRevision: item.baseRevision ?? null })) });
}
export function advancedConfirmationProof(input: Omit<AdvancedConfirmationBinding, 'confirmationProof'>): string {
  return digest({ scopeFingerprint: input.scopeFingerprint, treeDigest: input.treeDigest, mode: input.mode,
    remoteSnapshotId: input.remoteSnapshotId, remoteRevision: input.remoteRevision,
    remoteCursor: input.remoteCursor, destructivePlanDigest: input.destructivePlanDigest });
}
export function validateAdvancedConfirmation(input: AdvancedConfirmationBinding,
  expected: Omit<AdvancedConfirmationBinding, 'confirmationProof'>): void {
  const fields: Array<keyof Omit<AdvancedConfirmationBinding, 'confirmationProof'>> = [
    'scopeFingerprint', 'treeDigest', 'mode', 'remoteSnapshotId', 'remoteRevision', 'remoteCursor',
    'destructivePlanDigest',
  ];
  for (const field of fields) if (input[field] !== expected[field]) throw new Error('bootstrap_confirmation_stale');
  if (input.confirmationProof !== advancedConfirmationProof(expected)) throw new Error('bootstrap_confirmation_invalid');
}
/**
 * Build a confirmation-bound, immutable plan. The planner has no side effects:
 * all facts are copied into the plan and every create parent is represented by
 * an explicit dependency. Identity comes only from a mapping or a unique
 * title/url/kind match under an already-proven parent.
 */
export function buildAdvancedPlan(input: AdvancedPlanInput): AdvancedPlan {
  const context = validateInput(input);
  const identity = resolveIdentity(context);
  const ambiguous = ambiguousUnmatchedIdentity(context, identity);
  if (ambiguous) fail('advanced_identity_ambiguous', ambiguous);
  const steps: AdvancedStep[] = [];
  const remoteCreates = new Map<string, RemoteCreateStep>();
  const localCreates = new Map<string, LocalCreateStep>();
  planRemoteMountCreates(context, steps, remoteCreates);
  if (context.mode === 'upload') {
    planUploadCreates(context, identity, steps, remoteCreates);
    planUploadMatched(context, identity, steps, remoteCreates);
    planUploadDeletes(context, identity, steps, remoteCreates);
  } else {
    planDownloadCreates(context, identity, steps, localCreates);
    // Content and cross-parent moves must precede a possible removal of the
    // old parent. Same-parent ordering moves are appended after those removes
    // so their absolute Chrome indexes describe the final sibling list.
    steps.push(...planMatchedLocalSteps({ confirmationId: context.input.confirmationId, matched: identity.matched,
      localById: context.localById, remoteById: context.remoteById, remoteRows: context.remote,
      protectedLocal: context.protectedLocal, protectedRemote: context.protectedRemote,
      parentForRemote: (row) => localParentRefForRemote(row, context, identity, localCreates) }));
    planDownloadDeletes(context, identity, steps, localCreates);
    steps.push(...planLocalOrderMoves({ confirmationId: context.input.confirmationId, matched: identity.matched,
      localById: context.localById, remoteById: context.remoteById, remoteRows: context.remote,
      mounts: context.mounts.map((mount) => mount.fact), remoteToLocal: identity.remoteToLocal,
      protectedLocal: context.protectedLocal, protectedRemote: context.protectedRemote }));
  }
  const ordered = orderSteps(steps, (code, details) => fail(code as import('./advanced-plan-types.js').AdvancedPlanErrorCode, details));
  const checklist = ordered.map(checklistForStep);
  const scopeFingerprint = input.scopeFingerprint
    ?? (input.scope && input.boundaryVersion !== undefined
      ? advancedScopeFingerprint(input.scope, input.boundaryVersion, input.mounts) : undefined);
  if (!scopeFingerprint) fail('advanced_binding_invalid', { field: 'scopeFingerprint' });
  const contentDigest = input.treeDigest ?? digest(localDigestFacts(context.local));
  const destructiveDigest = digest({ mode: input.mode,
    deletes: ordered.filter((step) => step.action === 'delete' || step.action === 'remove')
      .map((step) => ({ stepId: step.stepId, side: step.side, targetId: checklistForStep(step).targetId,
        before: step.before })) });
  const planId = input.planId ?? stableId(input.confirmationId, 'plan', input.mode);
  const content: Omit<AdvancedPlan, 'digest'> = {
    kind: 'advanced-bootstrap-plan', planId,
    scopeKey: input.scopeKey ?? (input.scope ? makeScopeKey(input.scope) : ''), mode: input.mode,
    scopeFingerprint, treeDigest: contentDigest, remoteSnapshotId: input.remoteSnapshotId,
    remoteRevision: input.remoteRevision, remoteCursor: input.remoteCursor,
    destructivePlanDigest: destructiveDigest,
    matched: identity.matched.map((pair) => ({ nativeId: pair.nativeId, nodeId: pair.nodeId })),
    bindings: identity.matched.flatMap((pair) => {
      const remote = context.remoteById.get(pair.nodeId);
      return remote ? [{ nativeId: pair.nativeId, nodeId: pair.nodeId, remote: remoteState(remote) }] : [];
    }),
    mountBindings: context.mounts.map((mount) => ({ nativeRootId: mount.fact.nativeRootId,
      ...(mount.fact.rootRole ? { rootRole: mount.fact.rootRole } : {}),
      ...(mount.remoteNodeId ? { remoteNodeId: mount.remoteNodeId } : {}),
      ...(remoteCreates.get(mount.fact.nativeRootId)
        ? { createStepId: remoteCreates.get(mount.fact.nativeRootId)!.stepId } : {}) })),
    localOnly: [...identity.localOnly], remoteOnly: [...identity.remoteOnly], steps: ordered, checklist,
  };
  return freezeDeep({ ...content, digest: digest(content) });
}
export const planAdvanced = buildAdvancedPlan;
export const createAdvancedPlan = buildAdvancedPlan;
interface PlanContext {
  readonly input: AdvancedPlanInput;
  readonly mode: AdvancedMode;
  readonly local: readonly LocalNodeFact[];
  readonly remote: readonly RemoteNodeFact[];
  readonly localById: ReadonlyMap<string, LocalNodeFact>;
  readonly remoteById: ReadonlyMap<string, RemoteNodeFact>;
  readonly mounts: readonly MountResolution[];
  readonly mountByNative: ReadonlyMap<string, MountResolution>;
  readonly selectedLocal: ReadonlySet<string>;
  readonly selectedRemote: ReadonlySet<string>;
  readonly protectedLocal: ReadonlySet<string>;
  readonly protectedRemote: ReadonlySet<string>;
}
interface MountResolution {
  readonly fact: MountFact;
  readonly remoteNodeId?: string;
  readonly remoteCreateKey?: string;
}
interface IdentityPair { readonly nativeId: string; readonly nodeId: string }
interface IdentityResult {
  readonly localToRemote: ReadonlyMap<string, string>;
  readonly remoteToLocal: ReadonlyMap<string, string>;
  readonly matched: readonly IdentityPair[];
  readonly localOnly: readonly string[];
  readonly remoteOnly: readonly string[];
}
type RemoteCreateStep = Extract<AdvancedStep, { side: 'remote'; action: 'create' }>;
type LocalCreateStep = Extract<AdvancedStep, { side: 'local'; action: 'create' }>;
type RemoteMoveStep = Extract<AdvancedStep, { side: 'remote'; action: 'move' }>;
function validateInput(input: AdvancedPlanInput): PlanContext {
  if (!input || !['upload', 'download', 'mirror'].includes(input.mode)) fail('advanced_mode_invalid');
  for (const field of ['confirmationId', 'remoteSnapshotId', 'remoteRevision', 'remoteCursor'] as const) {
    if (!nonEmpty(input[field])) fail('advanced_binding_invalid', { field });
  }
  if (!input.rootNodeId || !Array.isArray(input.mounts) || input.mounts.length === 0) fail('advanced_mount_invalid');
  if (input.local.length > 50_000 || input.remote.length > 50_000 || input.mounts.length > 128) {
    fail('advanced_input_invalid', { field: 'size' });
  }
  const localById = uniqueRows(input.local, 'nativeId');
  const remoteById = uniqueRows(input.remote, 'nodeId');
  const mountFacts = uniqueRows(input.mounts, 'nativeRootId');
  const mappings = normalizeMappings(input.mappings);
  validateMappings(mappings, localById, remoteById);
  validateLocalGraph(input.local, localById, mountFacts);
  validateRemoteGraph(input.remote, remoteById, input.rootNodeId);
  const mounts = resolveMounts(input, remoteById);
  const mountByNative = new Map(mounts.map((mount) => [mount.fact.nativeRootId, mount]));
  const selectedLocal = selectedLocalIds(input.local, localById, mountFacts);
  const selectedRemote = selectedRemoteIds(input.remote, remoteById, mounts);
  const protectedLocal = new Set(mounts.map((mount) => mount.fact.nativeRootId));
  const protectedRemote = new Set<string>([input.rootNodeId,
    ...mounts.flatMap((mount) => mount.remoteNodeId ? [mount.remoteNodeId] : [])]);
  for (const row of input.local) if (row.managed || row.privateLocal || row.kind === 'separator') protectedLocal.add(row.nativeId);
  for (const row of input.remote) if (row.managed || row.privateLocal || row.kind === 'separator') protectedRemote.add(row.nodeId);
  return { input, mode: input.mode, local: input.local, remote: input.remote, localById, remoteById,
    mounts, mountByNative, selectedLocal, selectedRemote, protectedLocal, protectedRemote };
}
function uniqueRows<T extends object>(rows: readonly T[], field: keyof T): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const id = row[field];
    if (!nonEmpty(id)) fail('advanced_duplicate_id', { field: String(field) });
    if (result.has(id)) fail('advanced_duplicate_id', { field: String(field), id });
    result.set(id, row);
  }
  return result;
}
function normalizeMappings(rows: readonly (MappingFact | MappingInput)[]): readonly IdentityPair[] {
  const result: IdentityPair[] = []; const natives = new Set<string>(); const remotes = new Set<string>();
  for (const row of rows) {
    if (!nonEmpty(row.nativeId) || !nonEmpty(row.colpId)) fail('advanced_mapping_collision');
    if (natives.has(row.nativeId) || remotes.has(row.colpId)) {
      fail('advanced_mapping_collision', { nativeId: row.nativeId, nodeId: row.colpId });
    }
    natives.add(row.nativeId); remotes.add(row.colpId); result.push({ nativeId: row.nativeId, nodeId: row.colpId });
  }
  return result;
}
function validateMappings(rows: readonly IdentityPair[], local: ReadonlyMap<string, LocalNodeFact>,
  remote: ReadonlyMap<string, RemoteNodeFact>): void {
  for (const row of rows) {
    const left = local.get(row.nativeId); const right = remote.get(row.nodeId);
    if (left && right && left.kind !== right.kind) {
      fail('advanced_identity_kind_mismatch', { nativeId: row.nativeId, nodeId: row.nodeId });
    }
  }
}
function validateLocalGraph(rows: readonly LocalNodeFact[], byId: ReadonlyMap<string, LocalNodeFact>,
  mounts: ReadonlyMap<string, MountFact>): void {
  for (const row of rows) {
    if (!mounts.has(row.mountNativeRootId)) fail('advanced_boundary_violation', { id: row.nativeId });
    validateKind(row.kind, row.url, row.nativeId);
    if (row.parentNativeId !== null && !byId.has(row.parentNativeId)
        && row.parentNativeId !== row.mountNativeRootId && row.nativeId !== row.mountNativeRootId) {
      fail('advanced_parent_missing', { id: row.nativeId, parentId: row.parentNativeId });
    }
    const seen = new Set<string>(); let current: LocalNodeFact | undefined = row;
    while (current?.parentNativeId && current.nativeId !== current.mountNativeRootId) {
      if (seen.has(current.nativeId)) fail('advanced_parent_cycle', { id: row.nativeId });
      seen.add(current.nativeId);
      if (current.parentNativeId === current.mountNativeRootId) break;
      current = byId.get(current.parentNativeId);
      if (!current) fail('advanced_parent_missing', { id: row.nativeId });
    }
  }
}
function validateRemoteGraph(rows: readonly RemoteNodeFact[], byId: ReadonlyMap<string, RemoteNodeFact>,
  rootNodeId: string): void {
  const root = byId.get(rootNodeId);
  if (!root || root.kind !== 'folder' || root.parentId !== null || root.folderRole !== 'root') {
    fail('advanced_root_invalid', { rootNodeId });
  }
  for (const row of rows) {
    validateKind(row.kind, row.url, row.nodeId);
    if (row.nodeId !== rootNodeId && row.parentId === null) fail('advanced_parent_missing', { id: row.nodeId });
    if (row.parentId !== null && !byId.has(row.parentId)) fail('advanced_parent_missing', { id: row.nodeId, parentId: row.parentId });
    if (!nonEmpty(row.revision)) fail('advanced_input_invalid', { field: 'revision', id: row.nodeId });
    const seen = new Set<string>(); let current: RemoteNodeFact | undefined = row;
    while (current?.parentId) {
      if (seen.has(current.nodeId)) fail('advanced_parent_cycle', { id: row.nodeId });
      seen.add(current.nodeId); current = byId.get(current.parentId);
      if (!current) fail('advanced_parent_missing', { id: row.nodeId });
    }
  }
  if (rows.filter((row) => row.folderRole === 'root').length !== 1) fail('advanced_root_invalid', { rootNodeId });
}
function validateKind(kind: AdvancedNodeKind, url: string | undefined, id: string): void {
  if (kind === 'bookmark' && !nonEmpty(url)) fail('advanced_unsupported_node', { id, reason: 'bookmark_url_missing' });
  if (kind !== 'bookmark' && url !== undefined) fail('advanced_unsupported_node', { id, reason: 'non_bookmark_url' });
}
function resolveMounts(input: AdvancedPlanInput, remote: ReadonlyMap<string, RemoteNodeFact>): readonly MountResolution[] {
  const result: MountResolution[] = [];
  for (const fact of input.mounts) {
    if (!nonEmpty(fact.nativeRootId)) fail('advanced_mount_invalid');
    let remoteNodeId = authoritativeId(fact.remoteMountNodeId) ? fact.remoteMountNodeId : undefined;
    if (remoteNodeId && !remote.has(remoteNodeId)) fail('advanced_mount_missing', { id: remoteNodeId });
    if (!remoteNodeId && fact.rootRole) {
      const candidates = [...remote.values()].filter((row) => row.folderRole === fact.rootRole
        && row.parentId === input.rootNodeId);
      if (candidates.length > 1) fail('advanced_mount_ambiguous', { role: fact.rootRole });
      remoteNodeId = candidates[0]?.nodeId;
    }
    if (remoteNodeId) {
      const row = remote.get(remoteNodeId)!;
      if (row.kind !== 'folder' || row.parentId !== input.rootNodeId || row.folderRole === 'root') {
        fail('advanced_mount_invalid', { id: remoteNodeId });
      }
    }
    const remoteCreateKey = !remoteNodeId ? fact.nativeRootId : undefined;
    result.push({ fact, ...(remoteNodeId ? { remoteNodeId } : {}), ...(remoteCreateKey ? { remoteCreateKey } : {}) });
  }
  return result;
}
function resolveIdentity(context: PlanContext): IdentityResult {
  const localToRemote = new Map<string, string>(); const remoteToLocal = new Map<string, string>();
  const matched: IdentityPair[] = [];
  const pair = (nativeId: string, nodeId: string) => {
    if (!context.selectedLocal.has(nativeId) || !context.selectedRemote.has(nodeId)) return;
    if (localToRemote.has(nativeId) || remoteToLocal.has(nodeId)) {
      if (localToRemote.get(nativeId) !== nodeId || remoteToLocal.get(nodeId) !== nativeId) {
        fail('advanced_mapping_collision', { nativeId, nodeId });
      }
      return;
    }
    const local = context.localById.get(nativeId); const remote = context.remoteById.get(nodeId);
    if (!local || !remote || local.kind !== remote.kind) fail('advanced_identity_kind_mismatch', { nativeId, nodeId });
    localToRemote.set(nativeId, nodeId); remoteToLocal.set(nodeId, nativeId); matched.push({ nativeId, nodeId });
  };
  for (const mount of context.mounts) if (mount.remoteNodeId) pair(mount.fact.nativeRootId, mount.remoteNodeId);
  for (const row of normalizeMappings(context.input.mappings)) pair(row.nativeId, row.nodeId);
  for (const row of context.input.sidecars ?? []) pair(row.nativeId, row.colpId);
  const localFacts = context.local.filter((row) => context.selectedLocal.has(row.nativeId));
  const remoteFacts = context.remote.filter((row) => context.selectedRemote.has(row.nodeId));
  let changed = true;
  while (changed) {
    changed = false;
    const groups = new Map<string, { locals: LocalNodeFact[]; remotes: RemoteNodeFact[] }>();
    for (const row of localFacts) {
      if (localToRemote.has(row.nativeId)) continue;
      const parent = localParentRemoteId(row, context, localToRemote); if (!parent) continue;
      const key = `${parent}|${row.kind}|${row.title}|${row.url ?? ''}`;
      const group = groups.get(key) ?? { locals: [], remotes: [] }; group.locals.push(row); groups.set(key, group);
    }
    for (const row of remoteFacts) {
      if (remoteToLocal.has(row.nodeId) || row.folderRole === 'root') continue;
      const key = `${row.parentId ?? ''}|${row.kind}|${row.title}|${row.url ?? ''}`;
      const group = groups.get(key) ?? { locals: [], remotes: [] }; group.remotes.push(row); groups.set(key, group);
    }
    for (const group of groups.values()) if (group.locals.length === 1 && group.remotes.length === 1) {
      pair(group.locals[0]!.nativeId, group.remotes[0]!.nodeId); changed = true;
    }
  }
  const localOnly = context.local.filter((row) => context.selectedLocal.has(row.nativeId)
    && !localToRemote.has(row.nativeId) && !context.protectedLocal.has(row.nativeId)).map((row) => row.nativeId);
  const remoteOnly = context.remote.filter((row) => context.selectedRemote.has(row.nodeId)
    && !remoteToLocal.has(row.nodeId) && !context.protectedRemote.has(row.nodeId)).map((row) => row.nodeId);
  return { localToRemote, remoteToLocal, matched, localOnly, remoteOnly };
}
function localParentRemoteId(row: LocalNodeFact, context: PlanContext,
  pairs: ReadonlyMap<string, string>): string | undefined {
  if (row.parentNativeId === null || row.parentNativeId === row.mountNativeRootId) {
    return context.mountByNative.get(row.mountNativeRootId)?.remoteNodeId;
  }
  return pairs.get(row.parentNativeId);
}
function ambiguousUnmatchedIdentity(context: PlanContext, pairs: IdentityResult): { readonly id: string } | undefined {
  const groups = new Map<string, { locals: string[]; remotes: string[] }>();
  for (const row of context.local) if (pairs.localOnly.includes(row.nativeId)) {
    const key = `${row.kind}|${row.title}|${row.url ?? ''}|${row.mountNativeRootId}`;
    const group = groups.get(key) ?? { locals: [], remotes: [] }; group.locals.push(row.nativeId); groups.set(key, group);
  }
  for (const row of context.remote) if (pairs.remoteOnly.includes(row.nodeId)) {
    const mount = remoteMountFor(row.nodeId, context); const key = `${row.kind}|${row.title}|${row.url ?? ''}|${mount ?? ''}`;
    const group = groups.get(key) ?? { locals: [], remotes: [] }; group.remotes.push(row.nodeId); groups.set(key, group);
  }
  for (const group of groups.values()) if (group.locals.length > 0 && group.remotes.length > 0) {
    return { id: `${group.locals.join(',')}|${group.remotes.join(',')}` };
  }
  return undefined;
}
function remoteMountFor(nodeId: string, context: PlanContext): string | undefined {
  let current = context.remoteById.get(nodeId); const seen = new Set<string>();
  while (current) {
    const mount = context.mounts.find((item) => item.remoteNodeId === current!.nodeId);
    if (mount) return mount.fact.nativeRootId;
    if (current.parentId === null || seen.has(current.nodeId)) return undefined;
    seen.add(current.nodeId); current = context.remoteById.get(current.parentId);
  }
  return undefined;
}
function planRemoteMountCreates(context: PlanContext, steps: AdvancedStep[], creates: Map<string, RemoteCreateStep>): void {
  for (const mount of context.mounts) {
    if (!mount.remoteCreateKey) continue;
    const title = mount.fact.rootRole ?? mount.fact.customSourceKey;
    if (!title) fail('advanced_mount_missing', { id: mount.fact.nativeRootId });
    const node: AdvancedNodeValue = { kind: 'folder', title, ...(mount.fact.rootRole ? { folderRole: mount.fact.rootRole } : {}) };
    const stepId = stableId(context.input.confirmationId, 'remote-create-mount', mount.fact.nativeRootId);
    const parent: AdvancedParentRef = { kind: 'remote-node', id: context.input.rootNodeId! };
    const step: RemoteCreateStep = { ...baseStep(stepId, 'remote', 'create', 'create_node', []),
      source: { nativeId: mount.fact.nativeRootId, fact: localState(context.localById.get(mount.fact.nativeRootId)
        ?? { nativeId: mount.fact.nativeRootId, mountNativeRootId: mount.fact.nativeRootId,
          parentNativeId: null, kind: 'folder', title }) }, parent,
      payload: { type: 'create_node', parent, afterId: null, beforeId: null, node }, before: null,
      after: { nodeId: null, parent, node } };
    steps.push(step); creates.set(mount.fact.nativeRootId, step);
  }
}
function planUploadCreates(context: PlanContext, pairs: IdentityResult, steps: AdvancedStep[],
  creates: Map<string, RemoteCreateStep>): void {
  const rows = context.local.filter((row) => pairs.localOnly.includes(row.nativeId) && !context.protectedLocal.has(row.nativeId));
  for (const row of sortLocalParentFirst(rows, context.localById)) {
    const parent = remoteParentRefForLocal(row, context, pairs, creates); const node = nodeValue(row);
    const stepId = stableId(context.input.confirmationId, 'remote-create', row.nativeId);
    const step: RemoteCreateStep = { ...baseStep(stepId, 'remote', 'create', 'create_node', parent.kind === 'step' ? [parent.stepId] : []),
      source: { nativeId: row.nativeId, fact: localState(row) }, parent,
      payload: { type: 'create_node', parent, afterId: null, beforeId: null, node }, before: null,
      after: { nodeId: null, parent, node } };
    steps.push(step); creates.set(row.nativeId, step);
  }
}
function planUploadMatched(context: PlanContext, pairs: IdentityResult, steps: AdvancedStep[],
  creates: ReadonlyMap<string, RemoteCreateStep>): void {
  for (const pair of pairs.matched) {
    const local = context.localById.get(pair.nativeId)!; const remote = context.remoteById.get(pair.nodeId)!;
    if (context.protectedLocal.has(local.nativeId) || context.protectedRemote.has(remote.nodeId)
        || local.managed || local.privateLocal || remote.managed || remote.privateLocal) continue;
    const node = nodeValue(local); const before = remoteState(remote);
    let updateStepId: string | undefined;
    if (local.title !== remote.title || (local.url ?? '') !== (remote.url ?? '')) {
      const fields = changedContent(remote, local);
      updateStepId = stableId(context.input.confirmationId, 'remote-update', remote.nodeId);
      steps.push({ ...baseStep(updateStepId,
        'remote', 'update', 'update_node_content', []), target: { nodeId: remote.nodeId, nativeId: local.nativeId },
      payload: { type: 'update_node_content', targetId: remote.nodeId, baseRevision: remote.revision,
        base: fields.base, value: fields.value }, before, after: desiredRemote(remote.nodeId,
        remote.parentId ? { kind: 'remote-node', id: remote.parentId } : { kind: 'remote-node', id: context.input.rootNodeId! }, node) });
    }
    const parent = remoteParentRefForLocal(local, context, pairs, creates);
    if (parentRefId(parent) !== remote.parentId) {
      steps.push(remoteMoveStep(context, local, remote, parent, updateStepId));
    }
  }
}
function planUploadDeletes(context: PlanContext, pairs: IdentityResult, steps: AdvancedStep[],
  creates: ReadonlyMap<string, RemoteCreateStep>): void {
  const deleteIds = new Set(pairs.remoteOnly.filter((id) => canDeleteRemote(context, id)));
  const movesBySource = new Map<string, string[]>();
  for (const row of context.remote.filter((item) => context.selectedRemote.has(item.nodeId)
    && !deleteIds.has(item.nodeId))) {
    let parent = row.parentId; const seen = new Set<string>();
    while (parent && !deleteIds.has(parent)) {
      if (seen.has(parent)) fail('advanced_parent_cycle', { id: row.nodeId });
      seen.add(parent); parent = context.remoteById.get(parent)?.parentId ?? null;
    }
    if (!parent) continue;
    const localId = pairs.remoteToLocal.get(row.nodeId);
    if (!localId || context.protectedLocal.has(localId)) fail('advanced_boundary_violation', { id: row.nodeId });
    const local = context.localById.get(localId)!; const destination = remoteParentRefForLocal(local, context, pairs, creates);
    if (parentRefId(destination) === row.parentId || (destination.kind !== 'step' && deleteIds.has(destination.id))) {
      fail('advanced_boundary_violation', { id: row.nodeId });
    }
    if (context.protectedRemote.has(row.nodeId)) fail('advanced_boundary_violation', { id: row.nodeId });
    const moveId = stableId(context.input.confirmationId, 'remote-move', row.nodeId);
    const existing = steps.find((step) => step.stepId === moveId);
    const move = existing && existing.side === 'remote' && existing.action === 'move'
      ? existing : remoteMoveStep(context, local, row, destination);
    if (!existing) steps.push(move);
    if (row.parentId) movesBySource.set(row.parentId, [...(movesBySource.get(row.parentId) ?? []), move.stepId]);
  }
  const deleteStepIds = new Map<string, string>();
  for (const row of context.remote.filter((item) => deleteIds.has(item.nodeId))) {
    deleteStepIds.set(row.nodeId, stableId(context.input.confirmationId, 'remote-delete', row.nodeId));
  }
  for (const row of sortRemoteChildFirst(context.remote.filter((item) => deleteIds.has(item.nodeId)), context.remoteById)) {
    if (!row.parentId || !context.remoteById.has(row.parentId)) fail('advanced_parent_missing', { id: row.nodeId });
    const dependencies = [
      ...context.remote.filter((child) => child.parentId === row.nodeId).flatMap((child) => {
        const childStep = deleteStepIds.get(child.nodeId); return childStep ? [childStep] : [];
      }),
      ...(movesBySource.get(row.nodeId) ?? []),
    ];
    // F002: the delete shape follows the target's own kind — a folder is always
    // `delete_subtree`, matching `translateSyncBrowserDelete` and the
    // browser-event path. Retained descendants are moved out first (above), and
    // an unlisted extra remote child must not turn this into a permanent 422.
    const operation = deletionOperationType(row.kind);
    steps.push({ ...baseStep(deleteStepIds.get(row.nodeId)!, 'remote', 'delete', operation, dependencies),
      target: { nodeId: row.nodeId },
    payload: { type: operation, targetId: row.nodeId, baseRevision: row.revision }, before: remoteState(row), after: null });
  }
}
function remoteMoveStep(context: PlanContext, local: LocalNodeFact, remote: RemoteNodeFact,
  parent: AdvancedParentRef, priorUpdateStepId?: string): RemoteMoveStep {
  const source = remote.parentId ? context.remoteById.get(remote.parentId) : undefined;
  if (!source || !nonEmpty(source.childrenRevision)) fail('advanced_parent_revision_missing', { id: remote.nodeId });
  const targetRevision = targetRemoteChildrenRevision(context, parent);
  const node = nodeValue(local);
  const before = priorUpdateStepId ? { ...remoteState(remote), title: local.title,
    ...(local.url ? { url: local.url } : {}) } : remoteState(remote);
  const baseRevision: AdvancedRevisionRef = priorUpdateStepId
    ? { kind: 'step', stepId: priorUpdateStepId, field: 'revision' } : remote.revision;
  const dependencies = [...(parent.kind === 'step' ? [parent.stepId] : []),
    ...(priorUpdateStepId ? [priorUpdateStepId] : [])];
  return { ...baseStep(stableId(context.input.confirmationId, 'remote-move', remote.nodeId), 'remote', 'move', 'move_node',
    dependencies), target: { nodeId: remote.nodeId, nativeId: local.nativeId }, parent,
  source: { nodeId: remote.nodeId, fact: remoteState(remote) },
  payload: { type: 'move_node', targetId: remote.nodeId, baseRevision, newParent: parent,
    afterId: null, beforeId: null, baseSourceParentRevision: source.childrenRevision!, baseTargetParentRevision: targetRevision },
  before, after: desiredRemote(remote.nodeId, parent, node) };
}
function targetRemoteChildrenRevision(context: PlanContext, parent: AdvancedParentRef): AdvancedRevisionRef {
  if (parent.kind === 'step') return { kind: 'step', stepId: parent.stepId, field: 'childrenRevision' };
  const row = context.remoteById.get(parent.id);
  if (!row || !nonEmpty(row.childrenRevision)) fail('advanced_parent_revision_missing', { id: parent.id });
  return row.childrenRevision;
}
function remoteParentRefForLocal(row: LocalNodeFact, context: PlanContext, pairs: IdentityResult,
  creates: ReadonlyMap<string, RemoteCreateStep>): AdvancedParentRef {
  if (row.parentNativeId === null || row.parentNativeId === row.mountNativeRootId) {
    const mount = context.mountByNative.get(row.mountNativeRootId); if (!mount) fail('advanced_boundary_violation', { id: row.nativeId });
    if (mount.remoteNodeId) return { kind: 'remote-node', id: mount.remoteNodeId };
    const created = creates.get(row.mountNativeRootId); if (created) return { kind: 'step', stepId: created.stepId };
    fail('advanced_mount_missing', { id: row.mountNativeRootId });
  }
  const remoteId = pairs.localToRemote.get(row.parentNativeId!); if (remoteId) return { kind: 'remote-node', id: remoteId };
  const created = creates.get(row.parentNativeId!); if (created) return { kind: 'step', stepId: created.stepId };
  fail('advanced_parent_missing', { id: row.nativeId, parentId: row.parentNativeId! });
}
function planDownloadCreates(context: PlanContext, pairs: IdentityResult, steps: AdvancedStep[],
  creates: Map<string, LocalCreateStep>): void {
  const deleteIds = new Set(pairs.localOnly.filter((id) => canDeleteLocal(context, id)));
  for (const row of sortRemoteParentFirst(context.remote.filter((item) => pairs.remoteOnly.includes(item.nodeId)
    && !context.protectedRemote.has(item.nodeId)), context.remoteById)) {
    const parent = localParentRefForRemote(row, context, pairs, creates); const node = nodeValue(row);
    const index = compensatedLocalCreateIndex(row, parent, context.remote, context.local, deleteIds);
    const stepId = stableId(context.input.confirmationId, 'local-create', row.nodeId);
    const step: LocalCreateStep = { ...baseStep(stepId, 'local', 'create', 'create', parent.kind === 'step' ? [parent.stepId] : []),
      source: { nodeId: row.nodeId, fact: remoteState(row) }, parent,
      payload: { type: 'create', parent, index, node }, before: null,
      after: { nativeId: null, parent, node, index } };
    steps.push(step); creates.set(row.nodeId, step);
  }
}
function planDownloadDeletes(context: PlanContext, pairs: IdentityResult, steps: AdvancedStep[],
  creates: ReadonlyMap<string, LocalCreateStep>): void {
  const deleteIds = new Set(pairs.localOnly.filter((id) => canDeleteLocal(context, id)));
  const movesBySource = new Map<string, string[]>();
  for (const row of context.local.filter((item) => context.selectedLocal.has(item.nativeId)
    && !deleteIds.has(item.nativeId))) {
    let parent = row.parentNativeId; const seen = new Set<string>();
    while (parent && !deleteIds.has(parent)) {
      if (seen.has(parent)) fail('advanced_parent_cycle', { id: row.nativeId });
      seen.add(parent); parent = context.localById.get(parent)?.parentNativeId ?? null;
    }
    if (!parent) continue;
    const remoteId = pairs.localToRemote.get(row.nativeId);
    if (!remoteId || context.protectedRemote.has(remoteId)) fail('advanced_boundary_violation', { id: row.nativeId });
    const remote = context.remoteById.get(remoteId)!; const destination = localParentRefForRemote(remote, context, pairs, creates);
    if (parentRefId(destination) === row.parentNativeId) fail('advanced_boundary_violation', { id: row.nativeId });
    if (context.protectedLocal.has(row.nativeId)) fail('advanced_boundary_violation', { id: row.nativeId });
    const index = remoteMaterializedIndex(remote, context.remote);
    const move = { ...baseStep(stableId(context.input.confirmationId, 'local-move', row.nativeId),
      'local', 'move', 'move', destination.kind === 'step' ? [destination.stepId] : []),
    source: { nodeId: remote.nodeId, fact: remoteState(remote) }, target: { nativeId: row.nativeId, nodeId: remoteId },
    parent: destination, payload: { type: 'move', nativeId: row.nativeId, newParent: destination, index },
    before: localState(row), after: desiredLocal(row.nativeId, destination, nodeValue(remote), index) } as Extract<AdvancedStep, { side: 'local'; action: 'move' }>;
    steps.push(move);
    if (row.parentNativeId) movesBySource.set(row.parentNativeId, [...(movesBySource.get(row.parentNativeId) ?? []), move.stepId]);
  }
  const deleteStepIds = new Map<string, string>();
  for (const row of context.local.filter((item) => deleteIds.has(item.nativeId))) {
    deleteStepIds.set(row.nativeId, stableId(context.input.confirmationId, 'local-remove', row.nativeId));
  }
  for (const row of sortLocalChildFirst(context.local.filter((item) => deleteIds.has(item.nativeId)), context.localById)) {
    const dependencies = [
      ...context.local.filter((child) => child.parentNativeId === row.nativeId).flatMap((child) => {
        const childStep = deleteStepIds.get(child.nativeId); return childStep ? [childStep] : [];
      }),
      ...(movesBySource.get(row.nativeId) ?? []),
    ];
    steps.push({ ...baseStep(deleteStepIds.get(row.nativeId)!,
      'local', 'remove', 'remove', dependencies), target: { nativeId: row.nativeId },
    payload: { type: 'remove', nativeId: row.nativeId, recursive: false }, before: localState(row), after: null });
  }
}
function localParentRefForRemote(row: RemoteNodeFact, context: PlanContext, pairs: IdentityResult,
  creates: ReadonlyMap<string, LocalCreateStep>): AdvancedParentRef {
  if (row.parentId === null) fail('advanced_parent_missing', { id: row.nodeId });
  const mount = context.mounts.find((item) => item.remoteNodeId === row.parentId);
  if (mount) return { kind: 'native-node', id: mount.fact.nativeRootId };
  const nativeId = pairs.remoteToLocal.get(row.parentId!); if (nativeId) return { kind: 'native-node', id: nativeId };
  const created = creates.get(row.parentId!); if (created) return { kind: 'step', stepId: created.stepId };
  fail('advanced_parent_missing', { id: row.nodeId, parentId: row.parentId! });
}

function canDeleteRemote(context: PlanContext, nodeId: string): boolean {
  const row = context.remoteById.get(nodeId);
  return Boolean(row && context.selectedRemote.has(nodeId) && !context.protectedRemote.has(nodeId)
    && !row.managed && !row.privateLocal);
}
function canDeleteLocal(context: PlanContext, nativeId: string): boolean {
  const row = context.localById.get(nativeId);
  return Boolean(row && context.selectedLocal.has(nativeId) && !context.protectedLocal.has(nativeId)
    && !row.managed && !row.privateLocal);
}

export function digest(value: unknown): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))))}`;
}
export function bootstrapOpId(confirmationId: string, kind: string, key: string): string {
  return stableId(confirmationId, kind, key);
}
export function mountResolveOpIdMatches(opId: string, key: string): boolean {
  return opId.includes('.mount.') && opId.endsWith(`.${key}`);
}
function fail(code: import('./advanced-plan-types.js').AdvancedPlanErrorCode,
  details: Readonly<Record<string, string>> = {}): never { throw new AdvancedPlanError(code, details); }
