import type { SyncPullEventV02 } from '@know-n/colp/types';
import { lookupBookmark, type BookmarkNode } from './bookmark-api-error.js';
import { collectNativeOccupancy, executeNativeCreate } from './native-create-executor.js';
import type { ConfirmNativeWaitInput, ConfirmNativeWaitResult } from './native-wait.js';
import { createCheckedPullNative } from './pull-native-create-boundary.js';
import { prepareNativeWriteCheck, type NativeCreateParentProof } from './pull-native-write-boundary.js';
import { NativeWriteNotStartedError } from './native-call-result.js';
import { boundaryDrifted, rangePlanFromAnchors } from './pull-range-move.js';
import { planFromAnchors } from './pull-range-plan.js';
import { chromeCreate } from './pull-projection.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import { canonicalJson } from './sync-state/codec.js';
import { scopeKey } from './sync-state/scope-key.js';
import { materializationChildEventId, type MaterializationWaitAuthority } from './sync-state/materialization-wait-authority.js';
import type { IntentRecord, MappingInput } from './sync-state-store.js';

type MoveEvent = Extract<SyncPullEventV02, { kind: 'operation' }> & {
  readonly effect: Extract<Extract<SyncPullEventV02, { kind: 'operation' }>['effect'], { kind: 'node_moved' }>;
};
class InvalidMaterializationWait extends Error {}
function invalid(): never { throw new InvalidMaterializationWait('request_invalid'); }

/** An observed onCreated identifies a candidate, never an API receipt. The
 * explicit user decision is still needed, and pre-existing siblings cannot
 * become evidence for the earlier unknown invocation. */
export function observedNativeWaitCandidate(intent: IntentRecord): string | undefined {
  const id = intent.nativeEventEvidence?.nativeId;
  const correlation = materializationChildEventId(intent) ? intent.anchors?.rangeCorrelationId : intent.suspendedCorrelationId;
  return typeof id === 'string' && typeof correlation === 'string' && intent.nativeEventEvidence?.eventDigest === correlation
    && !(Array.isArray(intent.anchors?.beforeNativeIds) && intent.anchors.beforeNativeIds.includes(id)) ? id : undefined;
}

/** Range copies retain their old mapping until completePullPage performs its
 * existing atomic source unbind / destination bind / source exclusion. */
export async function confirmMaterializationWait(input: ConfirmNativeWaitInput,
  intent: IntentRecord): Promise<ConfirmNativeWaitResult | undefined> {
  const eventId = intent.eventId ?? materializationChildEventId(intent);
  if (!eventId) return undefined;
  const root = await input.store.getApplyIntent(input.scope, `intent:${eventId}`);
  if (root?.anchors?.rangeAction !== 'materialize_independent') return undefined;
  if (input.action === 'cancel' && intent.eventId) return undefined;
  try {
    if (input.action === 'cancel') return await cancelChild(input, intent, root, eventId);
    const current = await authority(input, intent, root);
    const patch = { expectedWaitRef: input.waitRef, expectedGeneration: input.generation,
      expectedNativeResult: 'result_unknown' as const, expectedMaterialization: current.proof };
    await input.assertCurrent?.();
    if (input.action === 'bind') {
      await input.store.persistApplyIntentFacts(input.scope, input.intentId, { ...patch,
        nativeResult: 'applied_with_evidence', nativeResultConfirmation: { kind: 'candidate_event', nativeId: input.nativeId! },
        nativeWaitDecision: { action: 'bind', waitRef: input.waitRef }, waitReason: null,
        replayState: 'awaiting_receipt', eventState: 'browser_call_started' });
      return { ok: true, result: 'bound', nativeId: input.nativeId! };
    }
    await input.store.persistApplyIntentFacts(input.scope, input.intentId, { ...patch,
      nativeWaitDecision: { action: 'keep_local_and_create', waitRef: input.waitRef },
      nativeResult: 'not_started', replayState: 'not_started', state: 'intent_prepared', apiPhase: 'intent_prepared',
      eventState: 'intent_prepared', apiResultEvidence: null, nativeEventEvidence: null,
      nativeResultConfirmation: null, waitReason: null });
    let outcome: Awaited<ReturnType<typeof executeNativeCreate>>;
    try { outcome = await executeNativeCreate({ scope: input.scope, store: input.store, api: input.api!,
      intentId: intent.intentId, owner: { scopeKey: scopeKey(input.scope), generation: input.generation,
        commandId: intent.commandId!, eventId, colpId: intent.colpId!, substep: intent.substep! },
      parentNativeId: intent.nativeParentId!, expected: current.content, liveWorkKind: 'create',
      create: () => createCheckedPullNative({ ...input, api: input.api!, parent: current.parent,
        parentColpId: current.parent.colpId, parentProof: current.parentProof,
        expectedBoundaryVersion: current.boundaryVersion,
        ...(current.placement ? { placement: current.placement } : {}),
        details: { parentId: intent.nativeParentId!, index: current.index, ...current.content } }) });
    } catch (error) {
      const refused = await input.store.getApplyIntent(input.scope, intent.intentId);
      if (error instanceof NativeWriteNotStartedError && refused?.nativeResult === 'not_started'
          && !refused.apiResultEvidence && !refused.nativeEventEvidence) {
        await input.store.persistApplyIntentFacts(input.scope, intent.intentId, {
          state: 'intent_prepared', apiPhase: 'intent_prepared', eventState: 'intent_prepared' });
      }
      throw error;
    }
    return outcome.result === 'applied_with_evidence'
      ? { ok: true, result: 'kept_local', nativeId: outcome.nativeId } : { ok: false, code: 'request_invalid' };
  } catch (error) {
    if (error instanceof InvalidMaterializationWait) return { ok: false, code: 'request_invalid' };
    throw error;
  }
}

async function authority(input: ConfirmNativeWaitInput, intent: IntentRecord, root: IntentRecord) {
  const { store, scope, api } = input;
  if (!api || !intent.colpId || !intent.nativeParentId || intent.generation !== scope.generation
      || intent.liveWorkKind !== 'create' || root.generation !== scope.generation) invalid();
  const child = materializationChildEventId(intent);
  if (child ? root.eventId !== child || intent.commandId !== root.anchors?.subtreeCommandId
    : intent.intentId !== root.intentId || intent.commandId !== 'pull' || intent.substep !== 'create') invalid();
  const event = await store.getPullEvent(scope, root.eventId!);
  const payload = event?.payload as unknown as MoveEvent | undefined;
  if (!event || !(child ? ['browser_call_started', 'native_event_observed'] : ['awaiting_confirmation']).includes(String(event.state))
      || payload?.effect.kind !== 'node_moved'
      || root.colpId !== payload.effect.node.id || root.operationId !== payload.operation.opId) invalid();
  const plan = rangePlanFromAnchors(root.anchors, `rx:${payload.operation.opId}`)!;
  const frozen = planFromAnchors(root.anchors, { commandId: plan.commandId, sourceMountId: null,
    destMountId: null, sourceBoundaryVersion: plan.sourceBoundaryVersion, destBoundaryVersion: plan.destBoundaryVersion, nodes: [] });
  const own = frozen.nodes.find(row => row.colpId === intent.colpId);
  if (!own || frozen.nodes.length !== (root.anchors?.nodes as unknown[])?.length) invalid();
  const record = await store.getScope(scope), mounts = await store.listMountBindings(scope);
  const source = await store.getMappingByColpId(scope, root.colpId!);
  const destination = await store.getMappingByColpId(scope, payload.effect.placement.parentId);
  if (!record || record.lifecycle !== 'active' || !source || !destination
      || boundaryDrifted(plan, source, destination, mounts, { generation: scope.generation,
        permissionConfirmed: record.rootStatus !== 'permission_required' })) invalid();
  const mappings = new Map<string, MappingInput & { readonly scopeKey: string }>([[destination.colpId, destination]]);
  const privateIds = new Set<string>();
  for (const id of record.privateRoots ?? []) {
    const mapping = await store.getMappingByColpId(scope, id);
    if (!mapping || virtualNativeId(mapping.nativeId)) invalid();
    mappings.set(id, mapping); privateIds.add(mapping.nativeId);
  }
  const exclusionIds = new Set<string>();
  for (const node of frozen.nodes) {
    const mapping = await store.getMappingByColpId(scope, node.colpId);
    if (!mapping || mapping.nativeId !== node.sourceNativeId || mapping.nodeKind !== node.nodeKind
        || mapping.projection.revision !== node.revision
        || canonicalJson(mapping.projection.content) !== canonicalJson(node.content)) invalid();
    mappings.set(mapping.colpId, mapping);
    if (virtualNativeId(mapping.nativeId)) continue;
    const native = await read(api, mapping.nativeId);
    if (native.parentId !== mapping.parentNativeId || native.title !== node.content?.title
        || native.url !== (node.nodeKind === 'bookmark' ? node.content?.url : undefined)) invalid();
    await ancestry(mapping.nativeId);
  }
  let parent: MappingInput = destination, parentProof: NativeCreateParentProof | undefined;
  if (child) {
    const parentNode = frozen.nodes.find(row => row.colpId === own.parentColpId);
    const prior = parentNode && mappings.get(parentNode.colpId);
    if (!parentNode || !prior) invalid();
    const parentIntentId = parentNode.colpId === root.colpId ? root.intentId : `intent:${child}:range:${parentNode.colpId}`;
    const receipt = await store.getApplyIntent(scope, parentIntentId);
    if (!receipt?.nativeParentId) invalid();
    parent = { ...prior, nativeId: intent.nativeParentId, parentNativeId: receipt.nativeParentId,
      rootNativeId: destination.rootNativeId, mountId: destination.mountId };
    parentProof = { kind: 'create_receipt', eventId: child, intentId: parentIntentId,
      commandId: parentNode.colpId === root.colpId ? 'pull' : String(root.anchors?.subtreeCommandId) };
  }
  if (intent.nativeParentId !== parent.nativeId) invalid();
  const preimage = await read(api, parent.nativeId);
  const boundary = await prepareNativeWriteCheck({ ...input, api, mapping: parent, preimage, parent: true,
    parentProof, expectedBoundaryVersion: plan.destBoundaryVersion ?? undefined });
  await boundary(); await ancestry(parent.nativeId);
  const content = child ? { ...(typeof own.content?.title === 'string' ? { title: own.content.title } : {}),
    ...(own.nodeKind === 'bookmark' && typeof own.content?.url === 'string' ? { url: own.content.url } : {}) }
    : chromeCreate(payload.effect.node);
  if (input.action === 'bind') {
    if (!input.nativeId || observedNativeWaitCandidate(intent) !== input.nativeId) invalid();
    const candidate = await read(api, input.nativeId);
    if (candidate.parentId !== intent.nativeParentId || candidate.title !== content.title
        || candidate.url !== ('url' in content ? content.url : undefined)) invalid();
    await ancestry(candidate.id);
    const occupied = (await collectNativeOccupancy(store, scope)).get(candidate.id);
    if (occupied !== undefined && occupied !== intent.colpId) invalid();
  }
  const index = child ? own.position : root.anchors?.index;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) invalid();
  const proof: MaterializationWaitAuthority = { scope: record, intent, rootIntent: root, event,
    mounts, mappings: [...mappings.values()], exclusionNativeIds: [...exclusionIds],
    sourceColpIds: frozen.nodes.map(row => row.colpId),
    ...(input.action === 'bind' ? { candidateNativeId: input.nativeId! } : {}) };
  return { proof, content, parent, parentProof, index, boundaryVersion: plan.destBoundaryVersion ?? undefined,
    placement: child ? undefined : payload.effect.placement };

  async function ancestry(id: string) {
    const seen = new Set<string>(); let current: string | undefined = id;
    while (current !== undefined) {
      if (seen.has(current) || seen.size >= 256 || privateIds.has(current)) invalid();
      seen.add(current); exclusionIds.add(current);
      if (await store.getLocalSyncExclusion(scope, current)) invalid();
      const node = await read(api!, current);
      if (node.unmodifiable) invalid();
      current = node.parentId;
    }
  }
}

async function cancelChild(input: ConfirmNativeWaitInput, intent: IntentRecord, root: IntentRecord,
  eventId: string): Promise<ConfirmNativeWaitResult> {
  const event = await input.store.getPullEvent(input.scope, eventId), scope = await input.store.getScope(input.scope);
  const nodes = root.anchors?.nodes;
  if (!event || !scope || root.eventId !== eventId || root.generation !== input.generation
      || root.anchors?.subtreeCommandId !== intent.commandId || !Array.isArray(nodes)
      || !nodes.some(node => node && typeof node === 'object' && !Array.isArray(node) && node.colpId === intent.colpId)
      || !['browser_call_started', 'native_event_observed'].includes(String(event.state))) invalid();
  await input.assertCurrent?.();
  await input.store.persistApplyIntentFacts(input.scope, intent.intentId, {
    expectedWaitRef: input.waitRef, expectedGeneration: input.generation, expectedNativeResult: 'result_unknown',
    expectedMaterialization: { scope, intent, rootIntent: root, event,
      mappings: [], mounts: await input.store.listMountBindings(input.scope), exclusionNativeIds: [], sourceColpIds: [] },
    nativeWaitDecision: { action: 'cancel', waitRef: input.waitRef }, replayState: 'committed', waitReason: null,
    eventState: 'browser_call_started' });
  return { ok: true, result: 'cancelled' };
}

async function read(api: NonNullable<ConfirmNativeWaitInput['api']>, id: string): Promise<BookmarkNode> {
  const result = await lookupBookmark(key => api.get(key), id);
  if (result.class !== 'present' || result.nodes.length !== 1 || result.nodes[0]?.id !== id) invalid();
  return result.nodes[0];
}
