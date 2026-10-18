import { iterateCursor, requestValue } from './idb.js';
import { INDEXES } from './schema.js';
import { validateQueueRecord } from './queue-validate.js';
import { type JsonObject, type JsonValue, type QueueOperation } from './types.js';

const LIVE_STATUSES = ['pending', 'claimed', 'deferred', 'unknown', 'gap', 'blocked'] as const;
const UNSETTLED_STATUSES = ['pending', 'claimed', 'deferred', 'unknown'] as const;
/** A parent chain that cannot be walked in this many hops is treated as unknown. */
const MAX_ANCESTOR_HOPS = 64;
type MappingRow = { readonly nativeId: string; readonly parentNativeId?: string };

async function someLiveQueueRow(queue: IDBObjectStore, key: string,
  matches: (row: QueueOperation) => boolean): Promise<boolean> {
  for (const status of LIVE_STATUSES) {
    let found = false;
    await iterateCursor(queue.index(INDEXES.queueByStatusSequence),
      IDBKeyRange.bound([key, status, 1], [key, status, Number.MAX_SAFE_INTEGER]), (value) => {
        if (matches(value as QueueOperation)) { found = true; return false; }
        return undefined;
      });
    if (found) return true;
  }
  return false;
}

/**
 * The earliest non-terminal row. The queue is never pruned, so a bounded
 * sequence scan stops seeing outstanding work once a scope accumulates more
 * than one contract page of terminal rows; read the earliest row per
 * non-terminal status instead. 'rejected' rows are settled history —
 * firstOutstanding, hasRecoverableQueueWork and commitRecovery already treat
 * them that way — so a permanently refused operation must not mask the pending
 * work behind it, or one bad row wedges outbound push forever.
 */
export async function firstLiveQueueRow(queue: IDBObjectStore, key: string,
  maxRecordBytes: number, afterSequence = 0): Promise<QueueOperation | null> {
  const index = queue.index(INDEXES.queueByStatusSequence); const candidates: QueueOperation[] = [];
  if (afterSequence >= Number.MAX_SAFE_INTEGER) return null;
  for (const status of LIVE_STATUSES) {
    const value = await requestValue(index.get(
      IDBKeyRange.bound([key, status, afterSequence + 1], [key, status, Number.MAX_SAFE_INTEGER])));
    if (value) candidates.push(validateQueueRecord(value, maxRecordBytes));
  }
  return candidates.sort((left, right) => left.sequence - right.sequence)[0] ?? null;
}

/**
 * F010: what the operation an inbox event is about to enqueue refers to.
 * `nativeIds` carries every native node the event rewrites, including the
 * subtree a delete covers.
 */
export interface EnqueueSubject {
  readonly targetId?: string;
  readonly parentIds?: readonly string[];
  readonly nativeIds?: readonly string[];
}

/**
 * F010: an unsettled attempt (a lost response keeps the attempt so the exact
 * bytes can be replayed, a deferred row still owns its lane slot, a claim is in
 * flight) may only hold work that really depends on it. Blocking every new
 * operation of the scope turned one lost response into a client-wide ingress
 * stop, so the hold is narrowed to the same canonical target, a parent the
 * operation writes into, or the same native subtree. Everything else is
 * admitted; the queue still pushes in sequence order, so a dependent operation
 * can never overtake its predecessor on the wire.
 */
export async function findBlockingUnsettledAttempt(queue: IDBObjectStore, key: string,
  subject: EnqueueSubject, mappings?: IDBObjectStore): Promise<QueueOperation | null> {
  for (const row of await unsettledAttempts(queue, key)) {
    if (await rowBlocksEnqueue(row, key, subject, mappings)) return row;
  }
  return null;
}

/** Synchronous pre-filter: only rows that own an attempt can block an enqueue. */
async function unsettledAttempts(queue: IDBObjectStore, key: string): Promise<QueueOperation[]> {
  const candidates: QueueOperation[] = [];
  for (const status of UNSETTLED_STATUSES) {
    await iterateCursor(queue.index(INDEXES.queueByStatusSequence),
      IDBKeyRange.bound([key, status, 1], [key, status, Number.MAX_SAFE_INTEGER]),
      (value) => { const row = value as QueueOperation;
        if (row.attempt !== undefined || row.status === 'claimed') candidates.push(row); });
  }
  return candidates;
}

async function rowBlocksEnqueue(row: QueueOperation, key: string, subject: EnqueueSubject,
  mappings: IDBObjectStore | undefined): Promise<boolean> {
  const canonical = [row.payload.targetId, `pending-${row.opId}`]
    .filter((value): value is string => typeof value === 'string');
  if (subject.targetId !== undefined && canonical.includes(subject.targetId)) return true;
  for (const parentId of subject.parentIds ?? []) if (canonical.includes(parentId)) return true;
  if (mappings === undefined || (subject.nativeIds ?? []).length === 0) return false;
  const anchor = await nativeAnchor(mappings, key, canonical);
  return anchor !== undefined && await subtreeOverlaps(mappings, key, anchor, subject.nativeIds!);
}

/** The native node a queue row rewrites, resolved through its durable mapping. */
async function nativeAnchor(mappings: IDBObjectStore, key: string, canonical: readonly string[]) {
  for (const colpId of canonical) {
    const mapping = await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, colpId])) as
      MappingRow | undefined;
    if (mapping) return mapping.nativeId;
  }
  return undefined;
}

async function subtreeOverlaps(mappings: IDBObjectStore, key: string, anchor: string,
  nativeIds: readonly string[]): Promise<boolean> {
  if (nativeIds.includes(anchor)) return true;
  const anchorChain = await ancestorChain(mappings, key, anchor);
  if (anchorChain === null || nativeIds.some((nativeId) => anchorChain.includes(nativeId))) return true;
  for (const nativeId of nativeIds) {
    const chain = await ancestorChain(mappings, key, nativeId);
    if (chain === null || chain.includes(anchor)) return true;
  }
  return false;
}

async function ancestorChain(mappings: IDBObjectStore, key: string, nativeId: string): Promise<string[] | null> {
  const chain: string[] = []; const seen = new Set<string>(); let current: string | undefined = nativeId;
  while (current !== undefined && chain.length < MAX_ANCESTOR_HOPS && !seen.has(current)) {
    seen.add(current); chain.push(current);
    const mapping = await requestValue(mappings.index(INDEXES.mappingByNativeId).get([key, current])) as
      MappingRow | undefined;
    current = mapping?.parentNativeId;
  }
  // A capped or cyclic walk cannot prove disjointness. Keep dependent ingress
  // parked until the unsettled attempt settles, rather than admitting a guess.
  return current === undefined ? chain : null;
}

/** The canonical parents an operation places work into. */
export function enqueueParentIds(operation: JsonObject): string[] {
  const nested = operation.payload;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return [];
  const record = nested as JsonObject;
  return [record.parentId, record.newParentId]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function enqueueTargetId(operation: JsonObject): string | undefined {
  const targetId: JsonValue | undefined = operation.targetId;
  return typeof targetId === 'string' && targetId.length > 0 ? targetId : undefined;
}

export function hasPendingMove(queue: IDBObjectStore, key: string, targetId: JsonValue | undefined): Promise<boolean> {
  return someLiveQueueRow(queue, key, (row) => row.payload.type === 'move_node' && row.payload.targetId === targetId);
}

/** SYNC-F011: point-query the queue by target+revision instead of a scope scan. */
export async function hasQueueRevisionForTarget(
  queue: IDBObjectStore, key: string, colpId: string, revision: string,
): Promise<boolean> {
  let found = false;
  await iterateCursor(queue.index(INDEXES.queueByTargetRevision),
    IDBKeyRange.only([key, colpId, revision]), (value) => {
      const row = value as QueueOperation;
      if (row.status !== 'rejected' && (row.payload.type === 'update_node_content'
        || row.payload.type === 'move_node')) { found = true; return false; }
    });
  return found;
}
