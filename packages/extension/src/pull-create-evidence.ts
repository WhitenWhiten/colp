import { SyncFailureError } from './sync-failure-class.js';
import { recordKns09Stop } from './kns-09-release.js';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import { digest } from './pull-codec.js';
import { chromeCreate, nodeCreate } from './pull-projection.js';
import type { PullApplierOptions, PullBookmarkApi } from './pull-applier-types.js';
import { executeNativeCreate, type NativeCreateOutcome } from './native-create-executor.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { IntentRecord, MappingInput } from './sync-state-store.js';

type Event = Extract<SyncPullEventV02, { kind: 'operation' }>;

export type { NativeCreateOutcome };

export function sidecarExpectation(effectDigest: string, mapping: MappingInput,
  parentNativeId = mapping.parentNativeId ?? null) {
  return { eventKind: 'sidecar', nativeId: mapping.nativeId, parentNativeId,
    details: { effectDigest }, anchors: {}, preStateDigest: mapping.projection.digest };
}

export function createExpectation(effect: Event['effect'], parentNativeId: string, index: number,
  children: readonly { readonly id: string }[]) {
  if (effect.kind !== 'node_created' && effect.kind !== 'node_restored' && effect.kind !== 'node_moved') {
    throw new SyncFailureError('pull_effect_kind_invalid');
  }
  const node = nodeCreate(effect.node);
  return { eventKind: 'create' as const, nativeId: '', parentNativeId,
    details: { parentId: parentNativeId, index, node }, correlationDetails: { parentId: parentNativeId, node },
    anchors: { afterId: effect.placement.afterId, beforeId: effect.placement.beforeId, index,
      beforeNativeIds: children.map(child => child.id) }, preStateDigest: digest(children) };
}

export async function executePullNativeCreate(options: PullApplierOptions, api: PullBookmarkApi, event: Event,
  parentId: string, eventId: string, create: () => Promise<{ readonly id: string }>,
  colpId = createColpId(event)): Promise<NativeCreateOutcome> {
  return executeNativeCreate({
    scope: options.scope, store: options.store, api, intentId: `intent:${eventId}`,
    owner: {
      scopeKey: scopeKey(options.scope), generation: options.scope.generation, commandId: 'pull',
      eventId, colpId, substep: 'create',
    },
    parentNativeId: parentId, expected: expectedChrome(event), create,
    operationId: event.operation.opId, crash: options.crash, now: options.now,
    liveWorkKind: 'create',
  });
}

/** Recovery/execute entry. Only `applied_with_evidence` yields a nativeId; never create on unknown. */
export async function recoverCreatedNative(options: PullApplierOptions, api: PullBookmarkApi, event: Event,
  parentId: string, _intent: Pick<IntentRecord, 'apiResultEvidence' | 'nativeEventEvidence'> | {
    readonly anchors?: IntentRecord['anchors']; readonly apiResultEvidence?: IntentRecord['apiResultEvidence'];
    readonly nativeEventEvidence?: IntentRecord['nativeEventEvidence'];
  } | null,
  freezeWithoutEvidence = false): Promise<NativeCreateOutcome> {
  void freezeWithoutEvidence;
  const effect = event.effect;
  if (effect.kind !== 'node_created' && effect.kind !== 'node_restored' && effect.kind !== 'node_moved') {
    return { result: 'failed', code: 'pull_effect_kind_invalid' };
  }
  const eventId = `${event.cursor}:${event.operation.opId}`;
  return executePullNativeCreate(options, api, event, parentId, eventId, async () => api.create({
    parentId, ...chromeCreate(effect.node),
  }), effect.node.id);
}

export async function recoverCreatedNativeEvidence(options: PullApplierOptions, api: PullBookmarkApi, parentId: string,
  expected: { readonly title?: string; readonly url?: string }, intent: Pick<IntentRecord, 'intentId'> | null,
  colpId: string, freezeWithoutEvidence = false,
): Promise<NativeCreateOutcome> {
  void freezeWithoutEvidence;
  if (!intent) return { result: 'failed', code: 'intent_not_found' };
  return executeNativeCreate({
    scope: options.scope, store: options.store, api, intentId: intent.intentId,
    owner: {
      scopeKey: scopeKey(options.scope), generation: options.scope.generation, commandId: 'pull',
      eventId: intent.intentId, colpId, substep: 'create',
    },
    parentNativeId: parentId, expected, liveWorkKind: 'create', crash: options.crash, now: options.now,
    create: async () => api.create({ parentId, ...expected }),
  });
}

function createColpId(event: Event): string {
  const effect = event.effect;
  if (effect.kind === 'node_created' || effect.kind === 'node_restored' || effect.kind === 'node_moved') {
    return effect.node.id;
  }
  throw new SyncFailureError('pull_effect_kind_invalid');
}

function expectedChrome(event: Event): { readonly title?: string; readonly url?: string } {
  const effect = event.effect;
  if (effect.kind === 'node_created' || effect.kind === 'node_restored' || effect.kind === 'node_moved') {
    return chromeCreate(effect.node);
  }
  return {};
}

export function recordDuplicateCreateStop(scope: PullApplierOptions['scope']): void {
  recordKns09Stop('duplicateNode', scope);
}
