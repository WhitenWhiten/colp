import type { UnknownRecord } from './sync-state/types.js';

/**
 * What happened to one remote item a person asked to try again (D3 / B-07).
 *  - `retried`: its held events were staged again on their own, completed page. The next apply pass (the engine's
 *    next wake) takes them in through the ordinary machinery: preflight, mapping, Rule B, intents. The cursor and
 *    the Ack are never touched.
 *  - `superseded`: the server's later state for the node, or its deletion, or the bookmark landing by other means,
 *    makes the held change moot; the item was closed.
 *  - `unavailable`: nothing was changed (the stored event is gone, a conflict decision owns the hold, the folder
 *    it goes into is itself held, the node's page is still being applied, sync is not running normally).
 */
export type PullItemRetryOutcome = 'retried' | 'superseded' | 'unavailable';

export type PullItemRetryPlan =
  | { readonly outcome: 'restage'; readonly eventIds: readonly string[]; readonly parentId?: string }
  | { readonly outcome: 'superseded' | 'unavailable' };

type Effect = {
  readonly kind?: string; readonly node?: { readonly id?: string; readonly parentId?: unknown };
  readonly placement?: { readonly parentId?: unknown }; readonly tombstone?: { readonly targetId?: string };
  readonly rootTombstone?: { readonly targetId?: string }; readonly members?: unknown;
};

const effectOf = (event: UnknownRecord): Effect | undefined => (event.payload as { effect?: Effect } | undefined)?.effect;
const CREATING = new Set(['node_created', 'node_restored']);
const APPLYING = new Set(['node_created', 'node_restored', 'node_moved', 'node_content_updated']);
const DELETING = new Set(['node_deleted', 'subtree_deleted']);
/** Event states in which no apply pass owns the event any more. */
const SETTLED = new Set(['authority_committed', 'page_complete']);

/** The one node a Pull event is about; undefined for a conflict or a shape this build does not know. */
export function pullEventSubjectId(event: UnknownRecord): string | undefined {
  const effect = effectOf(event);
  const id = effect?.kind === 'node_deleted' ? effect.tombstone?.targetId
    : effect?.kind === 'subtree_deleted' ? effect.rootTombstone?.targetId : effect?.node?.id;
  return typeof id === 'string' ? id : undefined;
}

/** Whether the event belongs to the node's history: it is about the node, or a subtree deletion that lists it. */
export function pullEventTouchesNode(event: UnknownRecord, nodeId: string): boolean {
  if (pullEventSubjectId(event) === nodeId) return true;
  const effect = effectOf(event);
  return effect?.kind === 'subtree_deleted' && Array.isArray(effect.members) && effect.members.includes(nodeId);
}

/** An event this browser set aside and committed with nothing written (`setAsidePullEvent`). */
export function isSetAsideEvent(event: UnknownRecord): boolean {
  const evidence = event.apiResultEvidence as { readonly setAside?: unknown } | null | undefined;
  return SETTLED.has(String(event.state)) && typeof evidence?.setAside === 'string';
}

/**
 * A held event staged again on its completed page by `restagePullIssues`. It is applied like a deferred event
 * (outside the page flow, no cursor), and the mark ends with the page flag: a finished event is history again.
 */
export function isItemRetryEvent(event: UnknownRecord, generation: number): boolean {
  return event.itemRetry === generation && event.state !== 'page_complete';
}

/** The row a held event becomes: staged again, as if the page had just delivered it, marked as a retry. */
export function restagedPullEvent(event: UnknownRecord, generation: number): UnknownRecord {
  const {
    intentId: _intentId, apiResultEvidence: _apiResult, pendingMappings: _mappings, pendingObservations: _observations,
    pendingDeleteNativeIds: _deletes, pendingRangeExit: _rangeExit, deferredNativeIntentId: _nativeWait,
    deferredRemoteDeleteId: _remoteDelete, ...kept
  } = event;
  return { ...kept, state: 'staged', itemRetry: generation };
}

/** The folder a held change goes into (create, restore, move) or sits in (content update). */
function parentOf(event: UnknownRecord): string | undefined {
  const effect = effectOf(event);
  const parent = effect?.placement?.parentId ?? effect?.node?.parentId;
  return typeof parent === 'string' ? parent : undefined;
}

/**
 * Decides what trying again means for one node, from the events the store holds about it (`chain`, oldest first, as the
 * server delivered them) and whether a real bookmark stands for the node now.
 *
 * Accept the server's state, never an older one: only the run of held events at the end of the node's history is
 * taken up again, in order, so the node ends at its latest known state. A later event that was applied or deleted
 * the node closes the item; a later event still in flight is left to the page flow (try again in a moment).
 */
export function planItemRetry(chain: readonly UnknownRecord[], landed: boolean): PullItemRetryPlan {
  let last = -1;
  for (let index = chain.length - 1; index >= 0; index -= 1) if (isSetAsideEvent(chain[index]!)) { last = index; break; }
  if (last < 0) return { outcome: 'unavailable' };
  const newer = chain.slice(last + 1);
  if (newer.some(event => !SETTLED.has(String(event.state)))) return { outcome: 'unavailable' };
  if (newer.length > 0) return { outcome: 'superseded' };
  let first = last;
  while (first > 0 && isSetAsideEvent(chain[first - 1]!)) first -= 1;
  let run = chain.slice(first, last + 1);
  const kinds = run.map(event => effectOf(event)?.kind ?? '');
  if (kinds.some(kind => !APPLYING.has(kind) && !DELETING.has(kind))) return { outcome: 'unavailable' };
  let lastDelete = -1;
  kinds.forEach((kind, index) => { if (DELETING.has(kind)) lastDelete = index; });
  if (lastDelete >= 0) run = run.slice(lastDelete + 1);
  if (run.length === 0) return { outcome: 'superseded' };
  const head = effectOf(run[0]!)?.kind ?? '';
  // A create that is already here must not be made twice; an update with nothing to update cannot make the node.
  if (landed === CREATING.has(head)) return { outcome: landed ? 'superseded' : 'unavailable' };
  const parentId = parentOf(run[0]!);
  return { outcome: 'restage', eventIds: run.map(event => String(event.eventId)), ...(parentId ? { parentId } : {}) };
}
