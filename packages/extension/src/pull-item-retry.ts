import type { PullItemRetryOutcome } from './pull-item-retry-plan.js';
import type { PullApplierOptions } from './pull-applier-types.js';

export type { PullItemRetryOutcome } from './pull-item-retry-plan.js';

/** All the entry points need: the store and the scope the Status card is showing. */
export type PullItemRetryOptions = Pick<PullApplierOptions, 'store' | 'scope'>;

/**
 * Try again for remote items this browser set aside (D3 / B-07): re-stage the stored events and accept the server's
 * state. `nodeIds` are the `nodeId`s `listPullIssues` returns. All of them are decided in one store transaction, in
 * the order the server delivered their events, so a folder and what is inside it go back in together.
 *
 *  - It re-applies outside the page flow: each held event of a node goes back to `staged` on its own completed
 *    page and the ordinary apply pass (the engine's next wake; call `scheduleSyncEngineWake('manual')` after a
 *    `retried`) takes it in like a deferred event. Preflight, mapping, Rule B and the intents are the same ones
 *    every event meets. The cursor is never moved or republished and no page, Ack or checkpoint is touched.
 *  - It only acts on the latest known server state: the run of held events at the end of the node's history. A later
 *    applied event or a remote delete closes the item as `superseded`; a later event still in flight, a stored
 *    event that is gone (history is pruned, a Snapshot recovery drops it), a conflict hold, a held folder it goes
 *    into, or sync that is not running normally leave everything as it was (`unavailable`).
 *  - If Chrome refuses again, the item is set aside again by the same Rule B count (three wakes of the same
 *    refusal), and an item-class failure sets it aside at once; either way the issue reappears with its new reason.
 *    While the retry is pending the item is not listed: it is neither held nor done.
 *
 * Run it where queue changes run (the engine's lane) so it cannot race an apply pass.
 */
export async function retrySetAsidePullItems(options: PullItemRetryOptions, nodeIds: readonly string[]):
Promise<ReadonlyMap<string, PullItemRetryOutcome>> {
  const decided = await options.store.restagePullIssues(options.scope, nodeIds);
  return new Map(decided.map(([nodeId, outcome]) => [nodeId, outcome === 'restaged' ? 'retried' : outcome]));
}

/** The same for one item. */
export async function retrySetAsidePullItem(options: PullItemRetryOptions, nodeId: string): Promise<PullItemRetryOutcome> {
  return (await retrySetAsidePullItems(options, [nodeId])).get(nodeId) ?? 'unavailable';
}
