/**
 * Completed bootstrap Ack is not proof that a pending Pull page or unknown
 * Chrome create has settled. Authority refresh is server auth only.
 */
import { pendingNativeOrPullFacts } from './native-repair.js';
import type { SyncScope } from './sync-state-store.js';

export { pendingNativeOrPullFacts };

export function mayUnfreezeForCompletedBootstrapAck(input: {
  readonly pendingIncompletePull: boolean;
  readonly nativeResultUnknown: boolean;
}): boolean {
  return !input.pendingIncompletePull && !input.nativeResultUnknown;
}

/** Session activation settles server authority; local work keeps its own hold. */
export async function readCompletedBootstrapState(
  store: Parameters<typeof pendingNativeOrPullFacts>[0], scope: SyncScope,
): Promise<{ recoveryFrozen: boolean; authorityRefreshRequired: false }> {
  return {
    recoveryFrozen: !mayUnfreezeForCompletedBootstrapAck(await pendingNativeOrPullFacts(store, scope)),
    authorityRefreshRequired: false,
  };
}
