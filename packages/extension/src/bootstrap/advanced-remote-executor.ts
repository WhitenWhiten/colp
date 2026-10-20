import { digestJson, validateOperation } from '../bookmark-event-codec.js';
import { deletionOperationType } from '../bookmark-deletion-scope.js';
import type { createSyncStateStore, JsonObject, MappingInput, SyncScope } from '../sync-state-store.js';
import type { AdvancedStepRecord } from '../sync-state/advanced-repository.js';
import type { AdvancedNodeValue, AdvancedParentRef, AdvancedRevisionRef, AdvancedStep } from './advanced-plan-types.js';
import type { StepOutcome } from './advanced-executor.js';
import type { RemoteNodeFact } from './matcher.js';

type Store = ReturnType<typeof createSyncStateStore>;
type RemoteStep = Extract<AdvancedStep, { side: 'remote' }>;
type RemoteFactMap = ReadonlyMap<string, RemoteNodeFact>;
type NoopVerification = { readonly facts: RemoteFactMap; readonly target?: RemoteNodeFact;
  readonly revision?: string };

const SPECIAL_MOUNT_ROLES = new Set(['bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks']);

export async function executeAdvancedRemoteStep(input: {
  readonly store: Store; readonly scope: SyncScope; readonly step: RemoteStep; readonly planId: string;
  readonly completed: readonly AdvancedStepRecord[]; readonly now?: () => number;
  readonly refreshRemoteFacts?: () => Promise<readonly RemoteNodeFact[]>;
}): Promise<StepOutcome> {
  const { store, scope, step, completed } = input;
  const opId = `ab.${digestJson({ planId: input.planId, stepId: step.stepId }).slice('sha256:'.length)}`;
  let row = await store.getQueueByOpId(scope, opId);
  if (!row) {
    const operation = await remoteOperation(store, scope, step, completed, opId, (input.now ?? Date.now)(),
      input.refreshRemoteFacts);
    row = await store.allocateSequenceAndEnqueue(scope, {
      opId, batchId: opId, idempotencyKey: opId, digest: 'sha256:pending', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: operation.baseRevision as string | null,
      operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: operation,
    }, { validateOperation, digestOperation: digestJson });
  }
  if (['blocked', 'rejected'].includes(row.status)) return { state: 'changed', code: 'advanced_remote_conflict' };
  if (row.status !== 'terminal') return { state: 'waiting' };
  const receipt = await store.getQueueReceipt(scope, row.sequence);
  const results = receipt?.result?.results;
  const result = Array.isArray(results) && results.length === 1 ? results[0] : undefined;
  if (!receipt || receipt.opId !== row.opId || receipt.operationDigest !== row.digest
      || !result || typeof result !== 'object' || Array.isArray(result)
      || result.opId !== row.opId || result.sequence !== row.sequence
      || !['applied', 'rebased', 'noop'].includes(String(result.status))) {
    return { state: 'changed', code: 'advanced_receipt_invalid' };
  }
  const status = String(result.status) as 'applied' | 'rebased' | 'noop';
  const targetFieldPresent = result.targetId !== undefined;
  const receivedTargetId = typeof result.targetId === 'string' && result.targetId.length > 0
    ? result.targetId : undefined;
  if (targetFieldPresent && !receivedTargetId) {
    return { state: 'changed', code: 'advanced_receipt_invalid' };
  }
  const expectedTargetId = step.action === 'create' ? undefined : step.target.nodeId;
  // COLP permits noop to omit targetId because it carries no resource
  // mutation. Every other non-create result must echo the plan target; the
  // omitted noop identity is recovered from the immutable plan only after its
  // fresh snapshot postcondition has been checked below.
  if (step.action === 'create' ? !receivedTargetId
    : (receivedTargetId !== undefined && receivedTargetId !== expectedTargetId)
      || (status !== 'noop' && receivedTargetId === undefined)) {
    return { state: 'changed', code: 'advanced_receipt_invalid' };
  }
  const revisionFieldPresent = result.revision !== undefined;
  const receiptRevision = typeof result.revision === 'string' && result.revision.length > 0
    ? result.revision : undefined;
  if (revisionFieldPresent && !receiptRevision) {
    return { state: 'changed', code: 'advanced_receipt_invalid' };
  }
  if ((status === 'applied' || status === 'rebased') && !receiptRevision) {
    return { state: 'changed', code: 'advanced_receipt_invalid' };
  }
  let revision = receiptRevision;
  if (status === 'noop') {
    const verification = await verifyNoop({ step, completed, targetId: receivedTargetId ?? expectedTargetId,
      resultRevision: receiptRevision, refreshRemoteFacts: input.refreshRemoteFacts });
    if (!verification) return { state: 'changed', code: 'advanced_receipt_invalid' };
    revision = verification.revision;
  }
  const targetId = step.action === 'create' ? receivedTargetId! : expectedTargetId!;
  if (step.action === 'delete') {
    // Receipt authority precedes plan completion. Startup range repair must not
    // materialize this old snapshot member while its Pull tombstone is pending.
    await store.putRemoteObservation(scope, { colpId: targetId, kind: 'tombstone',
      remoteRevision: revision ?? step.before.revision,
      cursor: typeof result.cursor === 'string' ? result.cursor : `advanced:${opId}`,
      payload: { deleted: true }, sourceDigest: row.digest, observedAt: (input.now ?? Date.now)() });
    return { state: 'complete', evidence: { targetId, opId, ...(revision ? { revision } : {}) } };
  }
  if (!revision) return { state: 'changed', code: 'advanced_receipt_invalid' };
  const nativeId = step.action === 'create' ? step.source.nativeId : step.target.nativeId;
  const mount = (await store.listMountBindings(scope)).find((binding) => binding.nativeRootId === nativeId);
  if (step.action === 'create' && status === 'rebased' && specialMount(step, mount)) {
    if (!await verifyRebasedSpecialMount({ step, completed, targetId: receivedTargetId!, revision,
      mount, refreshRemoteFacts: input.refreshRemoteFacts })) {
      return { state: 'changed', code: 'advanced_receipt_invalid' };
    }
  }
  const prior = await store.getMappingByNativeId(scope, nativeId);
  if (prior && prior.colpId !== targetId) return { state: 'changed', code: 'advanced_mapping_collision' };
  const parentId = resolveAdvancedReference(step.after.parent, completed, 'targetId');
  const parent = await store.getMappingByColpId(scope, parentId);
  const content: JsonObject = { title: step.after.node.title,
    ...(step.after.node.url === undefined ? {} : { url: step.after.node.url }),
    ...(step.after.node.folderRole ? { folderRole: step.after.node.folderRole } : {}) };
  const mapping: MappingInput = { nativeId, colpId: targetId,
    rootNativeId: mount?.nativeRootId ?? parent?.rootNativeId ?? prior?.rootNativeId ?? nativeId,
    nodeKind: step.after.node.kind,
    ...(parent && !mount ? { parentNativeId: parent.nativeId, parentColpId: parentId } : {}),
    ...(mount ? { mountId: mount.mountId, ...(mount.rootRole ? { rootRole: mount.rootRole } : {}) }
      : parent?.mountId ? { mountId: parent.mountId, ...(parent.rootRole ? { rootRole: parent.rootRole } : {}) } : {}),
    projection: { revision, resourceRevision: revision,
      digest: digestJson(content), contentDigest: digestJson(content), content,
      ...(prior?.projection.childrenRevision ? { childrenRevision: prior.projection.childrenRevision } : {}) } };
  // A replay after mapping persistence is idempotent; it cannot bind a different
  // live native node to the same server identity.
  const occupied = await store.getMappingByColpId(scope, targetId);
  if (occupied && occupied.nativeId !== nativeId) {
    if (!occupied.nativeId.startsWith('unmounted:') && !occupied.nativeId.startsWith('recovery:')) {
      return { state: 'changed', code: 'advanced_mapping_collision' };
    }
    await store.deleteMapping(scope, occupied.nativeId);
  }
  await store.putMapping(scope, mapping);
  if (mount && mount.remoteMountNodeId !== targetId) {
    const { scopeKey: _key, ...binding } = mount;
    await store.putMountBinding(scope, { ...binding, remoteMountNodeId: targetId, status: 'active' });
  }
  return { state: 'complete', evidence: { targetId, nativeId, revision, opId,
    ...(mapping.projection.childrenRevision ? { childrenRevision: mapping.projection.childrenRevision } : {}) } };
}

async function verifyNoop(input: { readonly step: RemoteStep; readonly completed: readonly AdvancedStepRecord[];
  readonly targetId?: string; readonly resultRevision?: string;
  readonly refreshRemoteFacts?: () => Promise<readonly RemoteNodeFact[]> }): Promise<NoopVerification | null> {
  if (!input.refreshRemoteFacts) return null;
  const facts = indexCompleteRemoteFacts(await input.refreshRemoteFacts());
  if (!facts) return null;
  if (input.step.action === 'delete') {
    // A noop delete is only authoritative when a complete fresh snapshot
    // proves that the planned resource is absent. A live target means the
    // server did not perform the destructive operation.
    if (facts.has(input.step.target.nodeId) || input.resultRevision !== undefined) return null;
    return { facts };
  }
  if (!input.targetId) return null;
  const target = facts.get(input.targetId);
  if (!target || target.managed || target.privateLocal) return null;
  const parentId = resolveAdvancedReference(input.step.after.parent, input.completed, 'targetId');
  if (target.parentId !== parentId || !sameRemoteContent(target, input.step.after.node)) return null;
  if (input.resultRevision !== undefined && input.resultRevision !== target.revision) return null;
  return { facts, target, revision: target.revision };
}

async function verifyRebasedSpecialMount(input: { readonly step: RemoteStep; readonly completed: readonly AdvancedStepRecord[];
  readonly targetId: string; readonly revision: string;
  readonly mount: Awaited<ReturnType<Store['listMountBindings']>>[number] | undefined;
  readonly refreshRemoteFacts?: () => Promise<readonly RemoteNodeFact[]> }): Promise<boolean> {
  if (!input.refreshRemoteFacts || !input.mount?.rootRole || input.step.action !== 'create') return false;
  const facts = indexCompleteRemoteFacts(await input.refreshRemoteFacts());
  if (!facts) return false;
  const target = facts.get(input.targetId);
  const parentId = resolveAdvancedReference(input.step.after.parent, input.completed, 'targetId');
  return Boolean(target && !target.managed && !target.privateLocal && target.kind === 'folder'
    && target.folderRole === input.mount.rootRole && target.parentId === parentId
    && target.revision === input.revision);
}

function specialMount(step: RemoteStep, mount: Awaited<ReturnType<Store['listMountBindings']>>[number] | undefined): boolean {
  return step.action === 'create' && mount?.rootRole !== undefined
    && SPECIAL_MOUNT_ROLES.has(mount.rootRole)
    && step.payload.node.kind === 'folder' && step.payload.node.folderRole === mount.rootRole;
}

function indexCompleteRemoteFacts(facts: readonly RemoteNodeFact[]): RemoteFactMap | null {
  if (!Array.isArray(facts)) return null;
  const byId = new Map<string, RemoteNodeFact>();
  for (const fact of facts) {
    if (!fact || typeof fact.nodeId !== 'string' || fact.nodeId.length === 0 || byId.has(fact.nodeId)
        || (fact.parentId !== null && typeof fact.parentId !== 'string')
        || typeof fact.revision !== 'string' || fact.revision.length === 0
        || !['folder', 'bookmark', 'separator'].includes(fact.kind)
        || typeof fact.title !== 'string'
        || (fact.url !== undefined && typeof fact.url !== 'string')
        || (fact.folderRole !== undefined && typeof fact.folderRole !== 'string')) return null;
    byId.set(fact.nodeId, fact);
  }
  const roots = [...byId.values()].filter((fact) => fact.parentId === null);
  if (roots.length !== 1 || roots[0]?.kind !== 'folder' || roots[0].folderRole !== 'root') return null;
  for (const fact of byId.values()) if (fact.parentId !== null && !byId.has(fact.parentId)) return null;
  for (const fact of byId.values()) {
    const seen = new Set<string>(); let current: RemoteNodeFact | undefined = fact;
    while (current.parentId !== null) {
      if (seen.has(current.nodeId)) return null;
      seen.add(current.nodeId); current = byId.get(current.parentId);
      if (!current) return null;
    }
  }
  return byId;
}

function sameRemoteContent(fact: RemoteNodeFact, desired: AdvancedNodeValue): boolean {
  return fact.kind === desired.kind && fact.title === desired.title
    && (fact.url ?? '') === (desired.url ?? '')
    && (fact.folderRole ?? '') === (desired.folderRole ?? '');
}

async function remoteOperation(store: Store, scope: SyncScope, step: RemoteStep,
  completed: readonly AdvancedStepRecord[], opId: string, now: number,
  refreshRemoteFacts?: () => Promise<readonly RemoteNodeFact[]>): Promise<JsonObject> {
  const common = { opId, occurredAt: new Date(now).toISOString(), dependencies: [] };
  const fields = advancedRemoteOperationFields(step, completed);
  if (step.action !== 'move') return { ...common, ...fields };
  const parentId = resolveAdvancedReference(step.parent, completed, 'targetId');
  const sourceParent = step.before.parentId ? await store.getMappingByColpId(scope, step.before.parentId) : null;
  const targetParent = await store.getMappingByColpId(scope, parentId);
  // Create receipts do not contain a new folder's children revision. Obtain
  // that fence by a validated read, without applying the snapshot to Chrome.
  const refreshed = refreshRemoteFacts ? await refreshRemoteFacts() : [];
  const targetRevision = refreshed.find((fact) => fact.nodeId === parentId)?.childrenRevision
    ?? targetParent?.projection.childrenRevision
    ?? resolveAdvancedRevision(step.payload.baseTargetParentRevision, completed);
  return { ...common, ...fields, payload: { ...fields.payload as JsonObject,
    baseSourceParentRevision: refreshed.find((fact) => fact.nodeId === step.before.parentId)?.childrenRevision
      ?? sourceParent?.projection.childrenRevision ?? step.payload.baseSourceParentRevision,
    baseTargetParentRevision: targetRevision } };
}

/** Stable authority shared by the executor and the last outbound boundary.
 * Parent revision fences are resolved at enqueue time and remain unchanged on
 * retry; only the server can judge their freshness after an unknown response. */
export function advancedRemoteOperationFields(step: RemoteStep, completed: readonly AdvancedStepRecord[]): JsonObject {
  if (step.action === 'create') return { type: 'create_node', baseRevision: null,
    payload: { parentId: resolveAdvancedReference(step.parent, completed, 'targetId'), afterId: null, beforeId: null,
      node: { ...step.payload.node } } };
  const ownRevision = [...completed].reverse().find((item) => item.evidence?.targetId === step.target.nodeId
    && typeof item.evidence.revision === 'string')?.evidence?.revision;
  const baseRevision = typeof ownRevision === 'string' ? ownRevision : resolveAdvancedRevision(step.payload.baseRevision, completed);
  if (step.action === 'delete') {
    // Plans delete child-first. An unstamped subtree request authorizes only
    // this now-empty root; the server refuses any new concurrent descendant.
    return { type: deletionOperationType(step.before.kind), targetId: step.target.nodeId,
      baseRevision, payload: { reason: 'advanced_bootstrap' } };
  }
  if (step.action === 'update') return { type: 'update_node_content', targetId: step.target.nodeId,
    baseRevision, payload: { base: { ...step.payload.base }, value: { ...step.payload.value } } };
  const parentId = resolveAdvancedReference(step.parent, completed, 'targetId');
  return { type: 'move_node', targetId: step.target.nodeId, baseRevision,
    payload: { newParentId: parentId, afterId: null, beforeId: null } };
}

function resolveAdvancedRevision(reference: AdvancedRevisionRef, completed: readonly AdvancedStepRecord[]): string {
  if (typeof reference === 'string') return reference;
  const result = completed.find(item => item.definition.stepId === reference.stepId)?.evidence?.[reference.field];
  if (typeof result !== 'string' || !result) throw new Error('advanced_dependency_missing');
  return result;
}

export function resolveAdvancedReference(reference: AdvancedParentRef | { readonly kind: 'step'; readonly stepId: string },
  completed: readonly AdvancedStepRecord[], field: 'nativeId' | 'targetId' | 'childrenRevision'): string {
  if (reference.kind !== 'step') return reference.id;
  const prior = completed.find((item) => item.definition.stepId === reference.stepId);
  const result = prior?.evidence?.[field];
  if (typeof result !== 'string' || !result) throw new Error('advanced_dependency_missing');
  return result;
}
