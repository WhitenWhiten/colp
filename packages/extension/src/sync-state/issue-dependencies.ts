import { OPEN_REMOTE_DELETE_STATES } from '../remote-delete-pending-facts.js';
import { PARK_MARKER_PREFIX } from '../bookmark-event-quarantine.js';
import { openIngressIssue, ingressProtectsNode, blockedPullIssue } from './open-issue-facts.js';
/** Transaction-local view of the same durable issue roots used by Pull and delete protection. */
import { projectUnresolvedNativeWait } from '../native-wait-open.js';
import { cursorPage, pageEventsRange, requestValue } from './idb.js';
import { localIssueRange, pullIssueRange } from './pull-issue-repository.js';
import { STORES, INDEXES } from './schema.js';
import type { IntentRecord, UnknownRecord, BookmarkEventRecord } from './types.js';

export const ISSUE_DEPENDENCY_STORES = [STORES.receipts, STORES.mappings, STORES.diagnostics, STORES.intents, STORES.pullEvents, STORES.bookmarkEvents, STORES.pullPages, STORES.remoteDeleteDecisions, STORES.scopeCommandPlans, STORES.metadata] as const;

const MAX = Number.MAX_SAFE_INTEGER;
/** Page states that can still carry an unresolved issue. */
const BLOCKED_PAGE_STATE = 'blocked';
/** Intents whose durable native wait is still open, by the indexes that hold them. */
const NATIVE_WAIT_RESULTS = ['result_unknown', 'waiting_dependency'] as const;
const NATIVE_WAIT_REASONS = ['native_result_unknown'] as const;

/** One parent edge of the durable mapping graph, resolved on demand. */
export interface DependencyParent {
  /** False when no mapping row names this colp id. */
  readonly known: boolean;
  readonly parent: string | null;
}

/**
 * T09: the mapping graph is read edge-by-edge through its unique colp/native
 * indexes. A dependency walk touches its own ancestor chain, not every mapping
 * in the scope, and repeated lookups are memoized for the lifetime of the
 * transaction-local graph.
 */
export interface DependencyAncestry {
  parentOf(colpId: string): Promise<DependencyParent>;
  colpIdForNative(nativeId: string): Promise<string | undefined>;
}

export interface DependencyGraph {
  readonly roots: Set<string>;
  readonly independentRoots: Set<string>;
  readonly prerequisiteOpIds: Set<string>;
  readonly decisions: UnknownRecord[];
  readonly parents: DependencyAncestry;
  /** Parents recorded by the bookmark event of one operation, read by op id. */
  readonly operationParents: { get(opId: string): Promise<readonly string[]> };
}

function createAncestry(mappings: IDBObjectStore, key: string): DependencyAncestry {
  const edges = new Map<string, DependencyParent>();
  const natives = new Map<string, string | undefined>();
  async function colpIdForNative(nativeId: string): Promise<string | undefined> {
    if (natives.has(nativeId)) return natives.get(nativeId);
    const row = await requestValue<UnknownRecord | undefined>(
      mappings.index(INDEXES.mappingByNativeId).get([key, nativeId]));
    const colpId = row && typeof row.colpId === 'string' ? row.colpId : undefined;
    natives.set(nativeId, colpId); return colpId;
  }
  async function parentOf(colpId: string): Promise<DependencyParent> {
    const cached = edges.get(colpId); if (cached) return cached;
    const row = await requestValue<UnknownRecord | undefined>(
      mappings.index(INDEXES.mappingByColpId).get([key, colpId]));
    let edge: DependencyParent;
    if (!row) edge = { known: false, parent: null };
    else {
      const parentColpId = typeof row.parentColpId === 'string' ? row.parentColpId : undefined;
      const parentNativeId = typeof row.parentNativeId === 'string' ? row.parentNativeId : undefined;
      const parent = parentColpId ?? (parentNativeId === undefined ? null
        : await colpIdForNative(parentNativeId) ?? parentNativeId);
      edge = { known: true, parent };
    }
    edges.set(colpId, edge); return edge;
  }
  return { parentOf, colpIdForNative };
}

/**
 * Operation context parents, read only for the operations a caller actually
 * evaluates. The old graph materialized one entry for every processed event in
 * the scope; this is one bounded index range per looked-up op id.
 */
function createOperationParents(events: IDBObjectStore, key: string, ancestry: DependencyAncestry) {
  const cache = new Map<string, Promise<readonly string[]>>();
  async function read(opId: string): Promise<readonly string[]> {
    const rows = await cursorPage<BookmarkEventRecord>(events.index(INDEXES.eventByOperationOrdinal),
      IDBKeyRange.bound([key, opId], [key, opId, []]), MAX);
    // The old scan iterated primary-key (eventId) order, so the LAST event that
    // carried a context won for a repeated op id. Keep that tie break.
    let chosen: BookmarkEventRecord | undefined;
    for (const event of rows) {
      const context = event.opId ? event.details.context as UnknownRecord | undefined : undefined;
      if (!context) continue;
      if (!chosen || event.eventId > chosen.eventId) chosen = event;
    }
    if (!chosen) return [];
    const context = chosen.details.context as UnknownRecord;
    const parents: string[] = [];
    for (const value of [context.sourceParentNativeId, context.targetParentNativeId, context.parentNativeId]) {
      if (typeof value !== 'string') continue;
      parents.push(await ancestry.colpIdForNative(value) ?? value);
    }
    return parents;
  }
  return { get(opId: string): Promise<readonly string[]> {
    const cached = cache.get(opId); if (cached) return cached;
    const pending = read(opId); cache.set(opId, pending); return pending;
  } };
}

/** Same traversal as `dependsOnIssue`, with parent edges resolved by index instead of a full map. */
export async function dependsOnIssueOrdered(targets: readonly string[], roots: ReadonlySet<string>,
  parentOf: (id: string) => Promise<DependencyParent>): Promise<boolean> {
  if (roots.size === 0) return false;
  for (const target of targets) {
    let id: string | null = target; const seen = new Set<string>();
    for (let depth = 0; id !== null; depth++) {
      if (roots.has(id)) return true;
      if (seen.has(id) || depth >= 256) return true;
      seen.add(id);
      const edge = await parentOf(id);
      if (!edge.known) { if (id !== target) return true; break; }
      id = edge.parent;
    }
  }
  return false;
}

export async function transactionIssueDependencies(queue: IDBObjectStore, key: string,
  excludeEventId?: string): Promise<DependencyGraph> {
  const tx = queue.transaction;
  const mappings = tx.objectStore(STORES.mappings);
  const diagnostics = tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope);
  const prerequisiteOpIds = new Set<string>();
  const roots = new Set<string>(); const nativeRoots = new Set<string>();
  const pullIssues = await cursorPage<UnknownRecord>(diagnostics, pullIssueRange(key), MAX);
  for (const row of pullIssues) if (row.kind === 'pull_issue' && typeof row.nodeId === 'string') roots.add(row.nodeId);
  const localIssues = await cursorPage<UnknownRecord>(diagnostics, localIssueRange(key), MAX);
  for (const row of localIssues) if (row.kind === 'local_issue' && typeof row.nativeId === 'string') nativeRoots.add(row.nativeId);
  // Only intents that can still be an open native wait are read, by their
  // durable result/reason indexes rather than every intent in the scope.
  const intents = new Map<string, IntentRecord>();
  const intentStore = tx.objectStore(STORES.intents);
  for (const result of NATIVE_WAIT_RESULTS) {
    for (const intent of await cursorPage<IntentRecord>(intentStore.index(INDEXES.intentByNativeResult),
      IDBKeyRange.bound([key, result], [key, result, []]), MAX)) intents.set(intent.intentId, intent);
  }
  for (const reason of NATIVE_WAIT_REASONS) {
    for (const intent of await cursorPage<IntentRecord>(intentStore.index(INDEXES.intentByWaitReason),
      IDBKeyRange.bound([key, reason], [key, reason, []]), MAX)) intents.set(intent.intentId, intent);
  }
  if (intents.size > 0) {
    // A wait is unresolved while its event is still awaiting confirmation, or
    // when no event row exists. Read the awaiting set once; only the (rare)
    // intent whose event is neither awaiting nor absent needs a point check.
    const awaiting = new Set((await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullEvents)
      .index(INDEXES.pullEventByState), IDBKeyRange.bound([key, 'awaiting_confirmation'],
      [key, 'awaiting_confirmation', []]), MAX)).map((event) => String(event.eventId)));
    const events = tx.objectStore(STORES.pullEvents);
    for (const intent of intents.values()) {
      let eventState: unknown;
      if (intent.eventId) {
        eventState = awaiting.has(intent.eventId) ? 'awaiting_confirmation'
          : (await requestValue<UnknownRecord | undefined>(events.get([key, intent.eventId])))?.state;
      }
      if (!projectUnresolvedNativeWait(intent, eventState)) continue;
      if (intent.colpId) roots.add(intent.colpId);
      if (intent.nativeTargetId) nativeRoots.add(intent.nativeTargetId);
    }
  }
  // Park markers are one row per parked event: `ingress:<scope>:park:<eventId>`
  // shares `by_scope` with the whole (unbounded) ingress ledger. Range it to the
  // markers, then resolve the marker events from the pending inbox in one read.
  const markers = await cursorPage<UnknownRecord>(diagnostics, IDBKeyRange.bound(
    [key, `ingress:${key}:${PARK_MARKER_PREFIX}`],
    [key, `ingress:${key}:${PARK_MARKER_PREFIX}\uffff`]), MAX);
  if (markers.length > 0) {
    const pending = new Map((await cursorPage<BookmarkEventRecord>(tx.objectStore(STORES.bookmarkEvents)
      .index(INDEXES.eventByStatusOrdinal), IDBKeyRange.bound([key, 'pending', 0],
      [key, 'pending', MAX]), MAX)).map((event) => [event.eventId, event]));
    const eventStore = tx.objectStore(STORES.bookmarkEvents);
    for (const diagnostic of markers) {
      const park = diagnostic.park as UnknownRecord | undefined;
      if (typeof park?.eventId !== 'string' || park.eventId === excludeEventId) continue;
      // A marker whose event left the pending inbox has no open issue and no
      // pending prerequisite, exactly like the historical scan.
      const event = pending.get(park.eventId);
      if (!event) continue;
      const issue = openIngressIssue(diagnostic, event);
      if (typeof park.dependencyOpId === 'string') prerequisiteOpIds.add(park.dependencyOpId);
      if (typeof park.dependencyEventId === 'string') {
        const predecessor = await requestValue<BookmarkEventRecord | undefined>(eventStore.get([key, park.dependencyEventId]));
        if (predecessor?.opId) prerequisiteOpIds.add(predecessor.opId);
      }
      if (issue && ingressProtectsNode(issue)) nativeRoots.add(issue.nativeId);
    }
  }
  const ancestry = createAncestry(mappings, key);
  for (const nativeId of nativeRoots) {
    const colpId = await ancestry.colpIdForNative(nativeId);
    if (colpId !== undefined) roots.add(colpId);
  }
  const blockedPages = await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullPages)
    .index(INDEXES.pullPageByState), IDBKeyRange.bound([key, BLOCKED_PAGE_STATE],
    [key, BLOCKED_PAGE_STATE, []]), MAX);
  if (blockedPages.length > 0) {
    const pullEvents = tx.objectStore(STORES.pullEvents).index(INDEXES.pullEventByPage);
    for (const page of blockedPages) {
      const events = await cursorPage<UnknownRecord>(pullEvents, pageEventsRange(key, String(page.pageId)), MAX);
      const issue = blockedPullIssue(page, events); for (const id of issue?.nodeIds ?? []) roots.add(id);
    }
  }
  const independentRoots = new Set(roots);
  const decisions: UnknownRecord[] = [];
  const decisionStore = tx.objectStore(STORES.remoteDeleteDecisions).index(INDEXES.remoteDeleteByState);
  for (const state of OPEN_REMOTE_DELETE_STATES) {
    decisions.push(...await cursorPage<UnknownRecord>(decisionStore,
      IDBKeyRange.bound([key, state], [key, state, []]), MAX));
  }
  for (const decision of decisions) roots.add(String(decision.targetId));
  return { roots, independentRoots, prerequisiteOpIds, decisions, parents: ancestry,
    operationParents: createOperationParents(tx.objectStore(STORES.bookmarkEvents), key, ancestry) };
}
