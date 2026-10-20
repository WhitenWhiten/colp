import type { SyncPullEventV02 } from '@know-n/colp/types';
import {
  isRemoteDeleteEffect, isSelfEchoDelete, remoteDeleteDecisionId, remoteDeleteMemberIds,
  remoteDeleteRevision, remoteDeleteTargetId, type OpEvent,
} from './remote-delete-policy.js';
import { lookupBookmark, lookupBookmarkChildren } from './bookmark-api-error.js';
import { hasUnsettledDeleteEdits } from './remote-delete-local-work.js';
import type { PullApplierOptions, PullBookmarkApi } from './pull-applier-types.js';
import { mayMutateNative } from './pull-mount-apply.js';
import type { JsonObject, MappingInput } from './sync-state-store.js';
import type { LocalSyncExclusionRecord, RemoteDeleteDecisionRecord } from './sync-state/remote-delete-repository.js';

type Store = PullApplierOptions['store'];

export async function settleParkedRemoteDeletes(options: PullApplierOptions, now: () => number): Promise<void> {
  const restoring = await options.store.listRemoteDeleteDecisions(options.scope, ['restoring', 'pending']);
  for (const decision of restoring) {
    const raw = await options.store.getPullEvent(options.scope, decision.eventId);
    if (!raw?.payload) continue;
    if (decision.state === 'pending' && decision.action === 'keep_local') await resolveKeepLocal(options.store, options.scope, raw.payload as OpEvent, decision, now);
    else if (decision.state === 'restoring') await settleRestoreIfReady(options, decision, raw.payload as OpEvent, now);
  }
}

export async function interceptStagedRemoteDelete(options: PullApplierOptions, api: PullBookmarkApi,
  eventId: string, pageId: string, event: OpEvent, now: () => number): Promise<'continue' | 'skip'> {
  if (!isRemoteDeleteEffect(event.effect) || isSelfEchoDelete(event, options.scope.replicaId)) return 'continue';
  const mounts = await options.store.listMountBindings(options.scope);
  const members = remoteDeleteMemberIds(event);
  const mappings = await Promise.all(members.map((id) => options.store.getMappingByColpId(options.scope, id)));
  const root = mappings.find((mapping) => mapping?.colpId === remoteDeleteTargetId(event.effect));
  if (!root || !mayMutateNative(root, mounts)) return 'continue';
  let policy = (await options.store.getRemoteDeletePolicy(options.scope)).policy;
  const existing = await options.store.getRemoteDeleteDecision(options.scope, remoteDeleteDecisionId(eventId));
  if (existing) {
    if (existing.state === 'applying') return 'continue';
    if (existing.state === 'restoring') {
      await settleRestoreIfReady(options, existing, event, now);
      return 'skip';
    }
    if (existing.state === 'pending' && existing.policy === 'keep_local') {
      await resolveKeepLocal(options.store, options.scope, event, existing, now);
    }
    return 'skip';
  }
  const live: MappingInput[] = [];
  for (const row of mappings) if (row) live.push(row);
  if (policy === 'sync') {
    for (const row of live) {
      const looked = await lookupBookmark(id => api.get(id), row.nativeId);
      if (looked.class === 'present' && await hasUnsettledDeleteEdits(options.store, options.scope, row, looked.nodes[0]!)) {
        policy = 'confirm'; break;
      }
    }
    if (policy === 'sync') return 'continue';
  }
  const nativeIds = await freezeNativeIds(api, live, root);
  const draft = decisionDraft(options, eventId, pageId, event, nativeIds, root, policy, now());
  const parked = await options.store.parkRemoteDelete(options.scope, { decision: draft });
  if (policy === 'keep_local') await resolveKeepLocal(options.store, options.scope, event, parked, now);
  return 'skip';
}

export async function settleAppliedRemoteDelete(options: PullApplierOptions, eventId: string,
  event: OpEvent, now: () => number): Promise<void> {
  if (!isRemoteDeleteEffect(event.effect)) return;
  const decision = await options.store.getRemoteDeleteDecision(options.scope, remoteDeleteDecisionId(eventId));
  if (!decision || (decision.state !== 'applying' && decision.state !== 'pending')) return;
  if (decision.state === 'pending' && decision.policy !== 'sync') return;
  await options.store.settleRemoteDelete(options.scope, {
    decisionId: decision.decisionId, state: 'applied', expectedStates: ['applying', 'pending'], now: now(),
    apiResultEvidence: { recovery: 'remote_delete_applied', operationId: event.operation.opId },
  });
}

export async function collectSubtreeNativeIds(api: PullBookmarkApi, rootNativeId: string): Promise<string[]> {
  const ids = [rootNativeId];
  const visit = async (parentId: string) => {
    const looked = await lookupBookmarkChildren((id) => api.getChildren(id), parentId);
    if (looked.class === 'not_found') return;
    if (looked.class !== 'present') throw new Error(looked.message);
    for (const child of looked.nodes) {
      if (!child.id || ids.includes(child.id)) continue;
      ids.push(child.id);
      await visit(child.id);
    }
  };
  await visit(rootNativeId);
  return ids;
}

async function resolveKeepLocal(store: Store, scope: PullApplierOptions['scope'], event: OpEvent,
  decision: RemoteDeleteDecisionRecord, now: () => number): Promise<void> {
  const exclusions: Omit<LocalSyncExclusionRecord, 'scopeKey'>[] = [];
  for (const nativeId of decision.nativeIds) {
    const mapping = await store.getMappingByNativeId(scope, nativeId);
    exclusions.push({
      nativeId, decisionId: decision.decisionId, rootNativeId: decision.nativeIds[0] ?? nativeId,
      generation: decision.generation, sourceKind: 'remote_delete',
      ...(mapping ? { priorColpId: mapping.colpId } : {}),
    });
  }
  const parentMapping = await parentRevisionMapping(store, scope, event);
  await store.settleRemoteDelete(scope, {
    decisionId: decision.decisionId, state: 'keep_local', expectedStates: ['pending', 'keep_local'], now: now(),
    pendingMappings: parentMapping ? [parentMapping] : [], deleteNativeIds: decision.nativeIds,
    exclusions, unbindNativeIds: decision.nativeIds,
    apiResultEvidence: { recovery: 'remote_delete_keep_local', operationId: event.operation.opId },
  });
}

async function settleRestoreIfReady(options: PullApplierOptions, decision: RemoteDeleteDecisionRecord,
  event: OpEvent, now: () => number): Promise<void> {
  if (!decision.restoreOpId) return;
  const queued = await options.store.getQueueByOpId(options.scope, decision.restoreOpId);
  if (queued?.status !== 'terminal') return;
  const receipt = await options.store.getQueueReceipt(options.scope, queued.sequence);
  if (!receiptProvesRestore(receipt, decision)) return;
  const parentMapping = await parentRevisionMapping(options.store, options.scope, event);
  await options.store.settleRemoteDelete(options.scope, {
    decisionId: decision.decisionId, state: 'restored', expectedStates: ['restoring', 'restored'], now: now(),
    restoreOpId: decision.restoreOpId, pendingMappings: parentMapping ? [parentMapping] : [], deleteNativeIds: [],
    apiResultEvidence: { recovery: 'remote_delete_restored', operationId: event.operation.opId },
  });
}

function receiptProvesRestore(receipt: { readonly opId: string; readonly result?: JsonObject } | null,
  decision: RemoteDeleteDecisionRecord): boolean {
  if (!receipt || receipt.opId !== decision.restoreOpId) return false;
  const results = receipt.result?.results;
  const row = Array.isArray(results) && results[0] && typeof results[0] === 'object' && !Array.isArray(results[0])
    ? results[0] as JsonObject : undefined;
  if (!row) return false;
  const status = String(row.status ?? '');
  if (!['applied', 'rebased', 'noop'].includes(status)) return false;
  const targetId = typeof row.targetId === 'string' ? row.targetId : undefined;
  return targetId === undefined || targetId === decision.targetId;
}

function decisionDraft(options: PullApplierOptions, eventId: string, pageId: string, event: OpEvent,
  nativeIds: readonly string[], root: MappingInput, policy: 'confirm' | 'keep_local', updatedAt: number) {
  const effect = event.effect;
  const title = typeof root.projection.content?.title === 'string' && root.projection.content.title
    ? root.projection.content.title : 'Untitled';
  return {
    decisionId: remoteDeleteDecisionId(eventId), eventId, pageId, operationId: event.operation.opId,
    effectId: effect.effectId, effectDigest: effect.effectDigest, targetId: remoteDeleteTargetId(effect)!,
    deleteRevision: remoteDeleteRevision(effect)!, generation: options.scope.generation, nativeIds,
    nodeKind: root.nodeKind ?? 'bookmark', title, policy, updatedAt,
  };
}

async function freezeNativeIds(api: PullBookmarkApi, mappings: readonly MappingInput[],
  root: MappingInput): Promise<string[]> {
  const ids = [...new Set(mappings.map((mapping) => mapping.nativeId))];
  if (root.nodeKind === 'folder') {
    for (const nativeId of await collectSubtreeNativeIds(api, root.nativeId)) {
      if (!ids.includes(nativeId)) ids.push(nativeId);
    }
  }
  return ids;
}

async function parentRevisionMapping(store: Store, scope: PullApplierOptions['scope'], event: OpEvent):
  Promise<MappingInput | null> {
  const effect = event.effect;
  if (!isRemoteDeleteEffect(effect)) return null;
  const parent = await store.getMappingByColpId(scope, effect.parentRevision.parentId);
  if (!parent) return null;
  const { scopeKey: _scopeKey, ...mapping } = parent as MappingInput & { readonly scopeKey?: string };
  return { ...mapping, projection: { ...parent.projection, childrenRevision: effect.parentRevision.childrenRevision } };
}

export async function keepLocalFromDecision(store: Store, scope: PullApplierOptions['scope'], event: OpEvent,
  decision: RemoteDeleteDecisionRecord, now: () => number): Promise<void> {
  await resolveKeepLocal(store, scope, event, decision, now);
}

export async function trySettleRestore(options: PullApplierOptions, decision: RemoteDeleteDecisionRecord,
  event: OpEvent, now: () => number): Promise<void> {
  await settleRestoreIfReady(options, decision, event, now);
}

export function pullEventFromDecision(storeEvent: { readonly payload: unknown }): OpEvent {
  return storeEvent.payload as OpEvent;
}

export type { SyncPullEventV02 };
