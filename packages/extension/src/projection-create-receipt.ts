import { virtualNativeId } from './projection-native-occupancy.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

/**
 * B-04: the browser id of a projection create this extension already finished, read from the apply-intent receipt.
 *
 * `executeNativeCreate` stores Chrome's answer (`persistReceipt`) before the projection intent learns it
 * (`observedNativeId`), and between the two sit two library-wide occupancy reads. A worker killed in that window
 * left an equal-content bookmark and a receipt naming it, but replay asked "is there an equal bookmark?" first and
 * called the create unknown for good. The receipt is proof, so it is consulted first: it answers only when the
 * bookmark it names is still under the parent and no other node of the library owns it (the claims are read only then).
 */
export async function recordedProjectionCreate(store: Pick<ReturnType<typeof createSyncStateStore>, 'getApplyIntent'>,
  scope: SyncScope, intentId: string, children: readonly { readonly id: string }[],
  occupancy: () => Promise<ReadonlyMap<string, string>>, colpId: string): Promise<string | undefined> {
  const apply = await store.getApplyIntent(scope, `projection:${intentId}`);
  if (!apply) return undefined;
  const confirmation = apply.nativeResultConfirmation;
  const nativeId = typeof apply.apiResultEvidence?.nativeId === 'string' ? apply.apiResultEvidence.nativeId
    : (confirmation?.kind === 'api_return' || confirmation?.kind === 'candidate_event') ? confirmation.nativeId : undefined;
  if (typeof nativeId !== 'string' || virtualNativeId(nativeId) || !children.some((child) => child.id === nativeId)) return undefined;
  const owner = (await occupancy()).get(nativeId);
  return owner === undefined || owner === colpId ? nativeId : undefined;
}
