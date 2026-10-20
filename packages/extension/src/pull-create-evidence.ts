import { SyncFailureError } from './sync-failure-class.js';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import { digest } from './pull-codec.js';
import { chromeCreate, nodeCreate } from './pull-projection.js';
import type { PullApplierOptions, PullBookmarkApi } from './pull-applier-types.js';
import { executeNativeCreate, type NativeCreateOutcome } from './native-create-executor.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { IntentRecord, MappingInput } from './sync-state-store.js';
import { NativeWriteNotStartedError } from './native-call-result.js';
import { createCheckedPullNative } from './pull-native-create-boundary.js';

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
  try { return await executeNativeCreate({
    scope: options.scope, store: options.store, api, intentId: `intent:${eventId}`,
    owner: {
      scopeKey: scopeKey(options.scope), generation: options.scope.generation, commandId: 'pull',
      eventId, colpId, substep: 'create',
    },
    parentNativeId: parentId, expected: expectedChrome(event), create,
    operationId: event.operation.opId, crash: options.crash, now: options.now,
    liveWorkKind: 'create',
  }); } catch (error) {
    if (error instanceof NativeWriteNotStartedError) {
      const intent = await options.store.getApplyIntent(options.scope, `intent:${eventId}`);
      if (intent?.eventId === eventId && intent.nativeResult === 'not_started' && intent.replayState === 'not_started'
          && !intent.apiResultEvidence && !intent.nativeEventEvidence) {
        await options.store.persistApplyIntentFacts(options.scope, intent.intentId, {
          state: 'intent_prepared', eventState: 'intent_prepared', apiPhase: 'intent_prepared',
        });
      }
    }
    throw error;
  }
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
  return executePullNativeCreate(options, api, event, parentId, eventId, () => createCheckedPullNative({
    ...options, api, parentColpId: effect.placement.parentId, placement: effect.placement,
    details: { parentId, ...chromeCreate(effect.node) },
  }), effect.node.id);
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
