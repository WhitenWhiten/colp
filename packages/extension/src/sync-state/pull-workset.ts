import { pullDeferral } from '../pull-deferral.js';
import { conflictResolutionBindings } from './conflict-resolution-bindings.js';
import { markQueuePullEchoApplied } from './pull-queue-echo.js';
import { pullEventCallFact } from './recovery-repository.js';
import {
  SyncStateError, type AckIntentRecord, type IntentRecord, type UnknownRecord,
} from './types.js';
import {
  cursorPage, iterateCursor, iterateCursorSequentially, pageEventsRange, requestValue, scopeRowsRange,
  transactionDone,
} from './idb.js';
import { INDEXES, STORES } from './schema.js';

/** One IndexedDB page of a state/target index. Callers still return the whole match set. */
export const PULL_INDEX_PAGE = 200;
/** Completed pages retained when `prunePullHistory` is called with only the page argument. */
export const PULL_HISTORY_PAGE_KEEP = 10_000;
/**
 * Completed events retained alongside the page cap.
 * One ordinary wake applies at most 20 pages of 100 events (`durable-sync-engine.ts`).
 * This keeps that applied tail, not the 10_000-page page cap.
 */
export const PULL_HISTORY_EVENT_KEEP = 2_000;
/** Stored JSON bytes of completed page, event, and effect rows retained with the page cap. */
export const PULL_HISTORY_BYTE_KEEP = 8 * 1024 * 1024;

const PULL_EVENT_STATES = ['staged', 'intent_prepared', 'browser_call_started', 'native_event_observed',
  'awaiting_confirmation', 'authority_committed', 'page_complete', 'blocked'] as const;
const OPEN_PULL_EVENT_STATES = PULL_EVENT_STATES.filter((state) => state !== 'page_complete');
const TERMINAL_PULL_STATES = new Set(['authority_committed', 'page_complete']);

export interface PullHistoryBudget { readonly maxEvents?: number; readonly maxBytes?: number }
export interface PullHistoryLimits { readonly keep: number; readonly maxEvents: number; readonly maxBytes: number }

export function pullHistoryLimits(keep: number, budget?: PullHistoryBudget): PullHistoryLimits {
  const maxEvents = budget?.maxEvents ?? PULL_HISTORY_EVENT_KEEP;
  const maxBytes = budget?.maxBytes ?? PULL_HISTORY_BYTE_KEEP;
  if (!Number.isSafeInteger(keep) || keep < 1 || !Number.isSafeInteger(maxEvents) || maxEvents < 1
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new SyncStateError('limit_exceeded');
  return { keep, maxEvents, maxBytes };
}

export function pullTerminalFactId(scopeKeyValue: string, opId: string): string {
  return `pull-terminal:${scopeKeyValue}:${opId}`;
}

/** Small op-id facts. Full pull rows can be dropped; these stay for overlay and conflict coverage. */
export function putPullTerminalFacts(tx: IDBTransaction, scopeKeyValue: string, event: UnknownRecord): void {
  const state = String(event.state);
  if (!TERMINAL_PULL_STATES.has(state)) return;
  const opIds = new Set<string>();
  if (typeof event.operationId === 'string' && event.operationId.length > 0) opIds.add(event.operationId);
  for (const binding of conflictResolutionBindings(event)) opIds.add(binding.opId);
  const store = tx.objectStore(STORES.diagnostics);
  for (const opId of opIds) store.put({
    id: pullTerminalFactId(scopeKeyValue, opId), scopeKey: scopeKeyValue, kind: 'pull_terminal_fact', opId,
  });
}

export async function coveredPullOperationIds(db: IDBDatabase, scopeKeyValue: string,
  opIds: readonly string[]): Promise<string[]> {
  if (opIds.length === 0) return [];
  const tx = db.transaction([STORES.diagnostics, STORES.pullEvents], 'readonly');
  const completion = transactionDone(tx);
  const diagnostics = tx.objectStore(STORES.diagnostics);
  const byOperation = tx.objectStore(STORES.pullEvents).index(INDEXES.pullEventByOperation);
  const covered: string[] = [];
  for (const opId of opIds) {
    const fact = await requestValue(diagnostics.get(pullTerminalFactId(scopeKeyValue, opId))) as UnknownRecord | undefined;
    if (fact?.kind === 'pull_terminal_fact') { covered.push(opId); continue; }
    let matched = false;
    await iterateCursor(byOperation, IDBKeyRange.only([scopeKeyValue, opId]), (value) => {
      if (TERMINAL_PULL_STATES.has(String((value as UnknownRecord).state))) { matched = true; return false; }
      return undefined;
    });
    if (matched) covered.push(opId);
  }
  await completion;
  return covered;
}

export async function readOrderedPullEvents(db: IDBDatabase, scopeKeyValue: string,
  states?: readonly string[]): Promise<UnknownRecord[]> {
  const wanted = states && states.length > 0 ? states : PULL_EVENT_STATES;
  const events: UnknownRecord[] = [];
  for (const state of wanted) events.push(...await readStateIndex(db, STORES.pullEvents, INDEXES.pullEventByState,
    scopeKeyValue, state));
  const pageIds = [...new Set(events.map((event) => String(event.pageId)))];
  const pages = await readPagesForIds(db, scopeKeyValue, pageIds);
  return orderEventsByPageChain(events, pages);
}

export async function readPullPagesByState(db: IDBDatabase, scopeKeyValue: string,
  states: readonly string[]): Promise<UnknownRecord[]> {
  const pages: UnknownRecord[] = [];
  for (const state of states) pages.push(...await readStateIndex(db, STORES.pullPages, INDEXES.pullPageByState,
    scopeKeyValue, state));
  return pages;
}

/** Authority facts for unfinished pages only, read together in one IDB transaction. */
export async function readPullApplyWorkset(db: IDBDatabase, key: string): Promise<{
  pages: UnknownRecord[]; stamps: UnknownRecord[]; intents: IntentRecord[];
}> {
  const tx = db.transaction([STORES.pullPages, STORES.pullEvents, STORES.intents, STORES.diagnostics], 'readonly');
  const completion = transactionDone(tx);
  try {
    const pageIndex = tx.objectStore(STORES.pullPages).index(INDEXES.pullPageByState);
    const pages: UnknownRecord[] = [];
    for (const state of ['staged', 'blocked']) {
      pages.push(...await cursorPage<UnknownRecord>(pageIndex, stateRange(key, state), Number.MAX_SAFE_INTEGER));
    }
    // Snapshot-accounted pages are completed history, but a confirmed native
    // invocation on one still needs its exact page/intent authority to finish.
    // Discover them from live event indexes instead of scanning completed history.
    const pageIds = new Set(pages.map(page => String(page.pageId)));
    for (const state of ['browser_call_started', 'native_event_observed']) {
      const live = await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullEvents).index(INDEXES.pullEventByState),
        stateRange(key, state), Number.MAX_SAFE_INTEGER);
      for (const event of live) {
        if (pullDeferral(event)?.kind !== 'native_result' || pageIds.has(String(event.pageId))) continue;
        const page = await requestValue(tx.objectStore(STORES.pullPages).get([key, String(event.pageId)])) as UnknownRecord | undefined;
        if (page?.state !== 'page_complete' || typeof page.snapshotAccountedBy !== 'string') continue;
        pages.push(page); pageIds.add(String(page.pageId));
      }
    }
    const stamps: UnknownRecord[] = [];
    const intents = new Map<string, IntentRecord>();
    const requested = new Set<string>();
    const eventIndex = tx.objectStore(STORES.pullEvents).index(INDEXES.pullEventByPage);
    for (const page of pages) {
      const pageId = String(page.pageId);
      // Same primary key as putScopeDiagnostic(kind=pull_page_authority, code=pageId).
      const stamp = await requestValue(tx.objectStore(STORES.diagnostics)
        .get(`pull_page_authority:${key}:${pageId}:none`)) as UnknownRecord | undefined;
      if (stamp) stamps.push(stamp);
      await iterateCursorSequentially(eventIndex, pageEventsRange(key, pageId), async (value) => {
        const event = value as UnknownRecord;
        if (typeof event.intentId !== 'string' || requested.has(event.intentId)) return;
        requested.add(event.intentId);
        const intent = await requestValue(tx.objectStore(STORES.intents).get([key, event.intentId])) as IntentRecord | undefined;
        if (intent) intents.set(intent.intentId, intent);
      });
    }
    await completion;
    return { pages, stamps, intents: [...intents.values()] };
  } catch (error) {
    await completion.catch(() => undefined);
    throw error;
  }
}

/**
 * Page-chain order is previousCursor/nextCursor, never pageId.
 * pageId order is only the tie break for two rows that share a previousCursor,
 * matching the old primary-key scan's last-write Map behavior.
 */
export function orderEventsByPageChain(events: readonly UnknownRecord[], pages: readonly UnknownRecord[]): UnknownRecord[] {
  const orderedPages = [...pages].sort((left, right) => compareText(String(left.pageId), String(right.pageId)));
  const byPrevious = new Map(orderedPages.map((page) => [String(page.previousCursor), page]));
  const chainedFrom = new Set(orderedPages.map((page) => String(page.nextCursor)));
  const chain: UnknownRecord[] = []; const visited = new Set<string>();
  const append = (start: UnknownRecord | undefined) => {
    let page = start;
    while (page && !visited.has(String(page.pageId))) {
      visited.add(String(page.pageId)); chain.push(page);
      page = byPrevious.get(String(page.nextCursor));
    }
  };
  orderedPages.filter((page) => !chainedFrom.has(String(page.previousCursor))).forEach((page) => append(page));
  orderedPages.forEach((page) => append(page));
  const rank = new Map(chain.map((page, index) => [String(page.pageId), index]));
  return [...events].sort((left, right) =>
    (rank.get(String(left.pageId)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(String(right.pageId)) ?? Number.MAX_SAFE_INTEGER)
    || Number(left.ordinal) - Number(right.ordinal));
}

interface CompletedPageStat {
  readonly pageId: string; readonly completedAt: number; readonly eventCount: number;
  readonly byteLength: number; readonly protected: boolean;
}

/**
 * Intent ids an open event still names through `deferredNativeIntentId`.
 * Completed history is not scanned; the intent's own event is checked separately.
 */
export async function openDeferredIntentIds(events: IDBObjectStore, scopeKeyValue: string): Promise<ReadonlySet<string>> {
  const referenced = new Set<string>();
  for (const state of OPEN_PULL_EVENT_STATES) {
    const rows = await cursorPage<UnknownRecord>(events.index(INDEXES.pullEventByState),
      IDBKeyRange.bound([scopeKeyValue, state], [scopeKeyValue, state, []]), Number.MAX_SAFE_INTEGER);
    for (const event of rows) {
      const binding = pullDeferral(event);
      if (binding?.kind === 'native_result') referenced.add(binding.id);
    }
  }
  return referenced;
}

/** Expired completed intents stay while their own outcome is unfinished or another open event still names them. */
export function expiredCompletedIntentCanBeDeleted(intent: IntentRecord, event: UnknownRecord | undefined,
  referencedIntentIds: ReadonlySet<string>): boolean {
  if (referencedIntentIds.has(intent.intentId)) return false;
  if (intent.state !== 'page_complete' || intent.expiresAt > Date.now()) return false;
  if (intent.repairJobId || intent.waitReason || intent.nativeWaitDecision) return false;
  if (intent.nativeResult === 'unknown' || intent.nativeResult === 'result_unknown') return false;
  if ((intent.replayState === 'unknown' || intent.replayState === 'started' || intent.replayState === 'awaiting_receipt')
      && intent.nativeResult !== 'applied_with_evidence' && intent.nativeResult !== 'absent'
      && intent.nativeResult !== 'failed') return false;
  if (!event) return true;
  if (String(event.state) !== 'page_complete' || pullDeferral(event)) return false;
  return pullEventCallFact(event, intent) === 'known';
}

/** Protected rows stay even when the page/event/byte caps are already full. */
export function pullHistoryKeepIds(pages: readonly CompletedPageStat[], limits: PullHistoryLimits): Set<string> {
  const ranked = [...pages].sort((left, right) => right.completedAt - left.completedAt);
  const keepIds = new Set<string>();
  if (limits.keep >= 1 && ranked[0]) keepIds.add(ranked[0].pageId);
  for (const page of ranked) if (page.protected) keepIds.add(page.pageId);
  let events = 0; let bytes = 0; let kept = 0;
  for (const page of ranked) {
    if (!keepIds.has(page.pageId)) continue;
    events += page.eventCount; bytes += page.byteLength; kept += 1;
  }
  for (const page of ranked) {
    if (keepIds.has(page.pageId)) continue;
    if (kept + 1 > limits.keep || events + page.eventCount > limits.maxEvents
        || bytes + page.byteLength > limits.maxBytes) continue;
    keepIds.add(page.pageId); events += page.eventCount; bytes += page.byteLength; kept += 1;
  }
  return keepIds;
}

export async function pruneCompletedPullPages(tx: IDBTransaction, key: string, limits: PullHistoryLimits,
  maxRecordBytes: number): Promise<number> {
  const pagesStore = tx.objectStore(STORES.pullPages);
  const events = tx.objectStore(STORES.pullEvents);
  const effects = tx.objectStore(STORES.effectPages);
  const intents = tx.objectStore(STORES.intents);
  const acks = await cursorPage<AckIntentRecord>(tx.objectStore(STORES.ackIntents), scopeRowsRange(key),
    Number.MAX_SAFE_INTEGER);
  const pendingAckCursors = new Set(acks.filter((ack) => ack.kind === 'pull' && ack.state === 'pending')
    .map((ack) => ack.cursor));
  const effectBytes = new Map<string, number>();
  await iterateCursor(effects, scopeRowsRange(key), (value) => {
    const row = value as UnknownRecord; const pageId = String(row.pageId);
    effectBytes.set(pageId, (effectBytes.get(pageId) ?? 0) + storedBytes(row));
  });
  const completed: UnknownRecord[] = [];
  await iterateCursor(pagesStore, scopeRowsRange(key), (value) => {
    const page = value as UnknownRecord;
    if (page.state === 'page_complete' && page.completedAt !== undefined) completed.push(page);
  });
  const retainedIntents = new Set<string>();
  await iterateCursor(events, scopeRowsRange(key), value => {
    const event = value as UnknownRecord; const binding = pullDeferral(event);
    if (event.state !== 'page_complete' && binding?.kind === 'native_result') retainedIntents.add(binding.id);
  });
  const stats: CompletedPageStat[] = [];
  for (const page of completed) {
    const pageId = String(page.pageId); const own: UnknownRecord[] = [];
    await iterateCursor(events.index(INDEXES.pullEventByPage), pageEventsRange(key, pageId), (value) => {
      own.push(value as UnknownRecord);
    });
    let protectedPage = pendingAckCursors.has(String(page.nextCursor));
    let bytes = storedBytes(page) + (effectBytes.get(pageId) ?? 0);
    for (const event of own) {
      bytes += storedBytes(event);
      if (typeof event.intentId === 'string' && retainedIntents.has(event.intentId)) protectedPage = true;
      if (String(event.state) !== 'page_complete') { protectedPage = true; continue; }
      if (protectedPage || typeof event.intentId !== 'string') continue;
      const intent = await requestValue(intents.get([key, event.intentId])) as IntentRecord | undefined;
      if (pullEventCallFact(event, intent) !== 'known') protectedPage = true;
      if (intent && intent.expiresAt > Date.now()) protectedPage = true;
    }
    stats.push({ pageId, completedAt: Number(page.completedAt), eventCount: own.length, byteLength: bytes,
      protected: protectedPage });
  }
  const keepIds = pullHistoryKeepIds(stats, limits);
  let removed = 0;
  await iterateCursorSequentially(pagesStore, scopeRowsRange(key), async (value, cursor) => {
    const page = value as UnknownRecord; const pageId = String(page.pageId);
    if (page.state !== 'page_complete' || page.completedAt === undefined || keepIds.has(pageId)) return;
    await iterateCursorSequentially(events.index(INDEXES.pullEventByPage), pageEventsRange(key, pageId),
      async (event, eventCursor) => {
        const row = event as UnknownRecord;
        await markQueuePullEchoApplied(tx, key, row.operationId, maxRecordBytes);
        putPullTerminalFacts(tx, key, row);
        effects.delete(IDBKeyRange.bound([key, String(row.eventId)], [key, String(row.eventId), []]));
        eventCursor.delete(); removed += 1;
      });
    cursor.delete();
  });
  return removed;
}

async function readPagesForIds(db: IDBDatabase, scopeKeyValue: string, pageIds: readonly string[]): Promise<UnknownRecord[]> {
  if (pageIds.length === 0) return [];
  const tx = db.transaction(STORES.pullPages, 'readonly');
  const completion = transactionDone(tx);
  const store = tx.objectStore(STORES.pullPages); const pages: UnknownRecord[] = [];
  for (const pageId of pageIds) {
    const value = await requestValue(store.get([scopeKeyValue, pageId]));
    if (value) pages.push(value as UnknownRecord);
  }
  await completion;
  return pages;
}

async function readStateIndex(db: IDBDatabase, storeName: string, indexName: string, scopeKeyValue: string,
  state: string): Promise<UnknownRecord[]> {
  const rows: UnknownRecord[] = [];
  let after: string | null = null;
  for (;;) {
    const tx = db.transaction(storeName, 'readonly');
    const completion = transactionDone(tx);
    const index = tx.objectStore(storeName).index(indexName);
    const lower = after === null ? [scopeKeyValue, state] : [scopeKeyValue, state, after];
    const page: UnknownRecord[] = []; let last: string | null = null;
    await iterateCursor(index, IDBKeyRange.bound(lower, [scopeKeyValue, state, []]), (value, cursor) => {
      const cursorKey = cursor.key as unknown as readonly [string, string, string];
      if (after !== null && cursorKey[2] === after) return undefined;
      page.push(value as UnknownRecord); last = String(cursorKey[2]);
      return page.length < PULL_INDEX_PAGE;
    });
    await completion;
    rows.push(...page);
    if (page.length < PULL_INDEX_PAGE || last === null) return rows;
    after = last;
  }
}

function stateRange(scopeKeyValue: string, state: string): IDBKeyRange {
  return IDBKeyRange.bound([scopeKeyValue, state], [scopeKeyValue, state, []]);
}
function storedBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  return encoded ? new TextEncoder().encode(encoded).byteLength : 0;
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
