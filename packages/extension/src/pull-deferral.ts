import { isItemRetryEvent } from './pull-item-retry-plan.js';
import { remoteDeleteDeferral, remoteDeleteDeferralMatches } from './remote-delete-pending-facts.js';
import { requestValue } from './sync-state/idb.js';
import { STORES } from './sync-state/schema.js';
import type { RemoteDeleteDecisionRecord } from './sync-state/remote-delete-repository.js';
import type { IntentRecord, UnknownRecord } from './sync-state/types.js';

/** A deferral accounts for a validated page; it never asserts native success.
 * Decisions wait for policy; native waits retain the exact uncertain invocation. */
export type PullDeferral = { readonly kind: 'remote_delete'; readonly id: string }
  | { readonly kind: 'native_result'; readonly id: string };
export function pullDeferral(event: UnknownRecord): PullDeferral | undefined {
  const decision = remoteDeleteDeferral(event);
  if (decision) return { kind: 'remote_delete', id: decision };
  if (typeof event.deferredNativeIntentId === 'string') return { kind: 'native_result', id: event.deferredNativeIntentId };
  return undefined;
}
export async function validatedPullDeferral(tx: IDBTransaction, key: string, event: UnknownRecord,
  generation: number): Promise<boolean> {
  // D3: a set-aside item a person asked to try again is staged on its completed page and applied like a deferred event.
  if (isItemRetryEvent(event, generation)) return true;
  const binding = pullDeferral(event); if (!binding) return false;
  if (binding.kind === 'remote_delete') {
    const decision = await requestValue<RemoteDeleteDecisionRecord | undefined>(tx.objectStore(STORES.remoteDeleteDecisions).get([key, binding.id]));
    return remoteDeleteDeferralMatches(event, decision, generation);
  }
  const intent = await requestValue<IntentRecord | undefined>(tx.objectStore(STORES.intents).get([key, binding.id]));
  if (!intent || intent.generation !== generation || !intent.eventId) return false;
  const original = await requestValue<UnknownRecord | undefined>(tx.objectStore(STORES.pullEvents).get([key, intent.eventId]));
  return original?.intentId === intent.intentId && original.deferredNativeIntentId === intent.intentId;
}
