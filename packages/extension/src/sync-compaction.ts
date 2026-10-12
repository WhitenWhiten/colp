import { compactNativePayload } from './compacted-native-facts.js';
export const COMPACTION_BATCH = 200;
export const COMPACTED_MARK = Object.freeze({ compacted: true as const });

export type CompactFault = 'after_summary' | 'after_delete' | 'after_watermark';

interface CompactableQueueRow {
  readonly status: string;
  readonly sequence: number;
  readonly opId: string;
  readonly digest: string;
  readonly payload: { readonly compacted?: unknown; readonly [key: string]: unknown };
  readonly attempt?: unknown;
}

interface CompactableEventRow {
  readonly status: string;
  readonly eventId: string;
  readonly ordinal: number;
  readonly opId: string | null;
  readonly dedupeKey: string;
  readonly details: { readonly compacted?: unknown; readonly [key: string]: unknown };
}

export interface CompactionWatermark {
  readonly scopeKey: string;
  readonly queueThroughSequence: number;
  readonly eventThroughOrdinal: number;
  readonly compactedAt: number;
  readonly remainingEligible: boolean;
}

export interface CompactSummary {
  readonly scopeKey: string;
  readonly kind: 'queue' | 'event';
  readonly id: string;
  readonly digest: string;
  readonly opId: string;
  readonly sequence?: number;
  readonly ordinal?: number;
}

export interface CompactReport {
  readonly watermark: CompactionWatermark;
  readonly compactedQueue: number;
  readonly compactedEvents: number;
  readonly summaries: readonly CompactSummary[];
}

export interface CompactStoreNames {
  readonly queue: string;
  readonly receipts: string;
  readonly cursors: string;
  readonly events: string;
  readonly watermarks: string;
  readonly summaries: string;
}

export interface CompactIndexNames {
  readonly queueByStatus: string;
  readonly queueByOpId: string;
  readonly eventByStatus: string;
}

export function queuePayloadIsCompacted(payload: CompactableQueueRow['payload']): boolean {
  return payload.compacted === true;
}

export function compactedQueuePayload(payload: CompactableQueueRow['payload']): {
  readonly compacted: true;
  readonly type?: string;
  readonly targetId?: string;
  readonly payload?: Record<string, unknown>;
} {
  const nativePayload = compactNativePayload(payload);
  return {
    ...COMPACTED_MARK,
    ...(typeof payload.type === 'string' ? { type: payload.type } : {}),
    ...(typeof payload.targetId === 'string' ? { targetId: payload.targetId } : {}),
    ...(nativePayload ? { payload: nativePayload } : {}),
  };
}

export function eventDetailsAreCompacted(details: CompactableEventRow['details']): boolean {
  return details.compacted === true;
}

export function evaluateQueueCompactEligibility(input: {
  readonly queued: CompactableQueueRow;
  readonly hasReceipt: boolean;
  readonly hasCursor: boolean;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (input.queued.status !== 'terminal') return { ok: false, reason: 'queue_not_terminal' };
  if (queuePayloadIsCompacted(input.queued.payload) && input.queued.attempt === undefined) {
    return { ok: false, reason: 'queue_already_compacted' };
  }
  if (!input.hasReceipt) return { ok: false, reason: 'receipt_missing' };
  if (!input.hasCursor) return { ok: false, reason: 'cursor_or_ack_missing' };
  return { ok: true };
}

export function evaluateEventCompactEligibility(input: {
  readonly event: CompactableEventRow;
  readonly queued: CompactableQueueRow | undefined;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (input.event.status !== 'processed' || input.event.opId === null) {
    return { ok: false, reason: 'event_not_processed' };
  }
  if (eventDetailsAreCompacted(input.event.details)) return { ok: false, reason: 'event_already_compacted' };
  if (!input.queued || input.queued.status !== 'terminal') return { ok: false, reason: 'queue_not_terminal' };
  return { ok: true };
}

export async function compactScopeTransaction(
  tx: IDBTransaction,
  input: {
    readonly scopeKey: string;
    readonly batch: number;
    readonly now: number;
    readonly fault?: CompactFault;
    readonly stores: CompactStoreNames;
    readonly indexes: CompactIndexNames;
  },
): Promise<CompactReport> {
  const key = input.scopeKey;
  const queueStore = tx.objectStore(input.stores.queue);
  const receipts = tx.objectStore(input.stores.receipts);
  const events = tx.objectStore(input.stores.events);
  const watermarks = tx.objectStore(input.stores.watermarks);
  const summaries = tx.objectStore(input.stores.summaries);
  const prior = await requestValue(watermarks.get(key)) as CompactionWatermark | undefined;
  const cursorRow = await requestValue(tx.objectStore(input.stores.cursors).get(key));
  const hasCursor = cursorRow !== undefined && cursorRow !== null;
  const written: CompactSummary[] = [];
  let queueThrough = prior?.queueThroughSequence ?? 0;
  let eventThrough = prior?.eventThroughOrdinal ?? 0;
  let compactedQueue = 0;
  let compactedEvents = 0;

  const terminalRange = IDBKeyRange.bound(
    [key, 'terminal', queueThrough + 1],
    [key, 'terminal', Number.MAX_SAFE_INTEGER],
  );
  await iterateIndex(queueStore.index(input.indexes.queueByStatus), terminalRange, async (value) => {
    if (compactedQueue >= input.batch) return false;
    const queued = value as CompactableQueueRow;
    const hasReceipt = await receiptExists(receipts, key, queued);
    const eligibility = evaluateQueueCompactEligibility({ queued, hasReceipt, hasCursor });
    if (!eligibility.ok) {
      if (eligibility.reason === 'queue_already_compacted') {
        queueThrough = queued.sequence;
        return undefined;
      }
      return false;
    }
    const summary: CompactSummary = {
      scopeKey: key, kind: 'queue', id: queued.opId, digest: queued.digest, opId: queued.opId,
      sequence: queued.sequence,
    };
    summaries.put(summary);
    injectFault(input.fault, 'after_summary', tx);
    const { attempt: _attempt, ...withoutAttempt } = queued;
    queueStore.put({ ...withoutAttempt, payload: compactedQueuePayload(queued.payload) });
    injectFault(input.fault, 'after_delete', tx);
    written.push(summary);
    queueThrough = queued.sequence;
    compactedQueue += 1;
    return undefined;
  });

  const processedRange = IDBKeyRange.bound(
    [key, 'processed', eventThrough + 1],
    [key, 'processed', Number.MAX_SAFE_INTEGER],
  );
  await iterateIndex(events.index(input.indexes.eventByStatus), processedRange, async (value) => {
    if (compactedEvents >= input.batch) return false;
    const event = value as CompactableEventRow;
    const queued = event.opId === null
      ? undefined
      : await requestValue(queueStore.index(input.indexes.queueByOpId).get([key, event.opId])) as CompactableQueueRow | undefined;
    const eligibility = evaluateEventCompactEligibility({ event, queued });
    if (!eligibility.ok) {
      if (eligibility.reason === 'event_already_compacted') {
        eventThrough = event.ordinal;
        return undefined;
      }
      return false;
    }
    const summary: CompactSummary = {
      scopeKey: key, kind: 'event', id: event.eventId, digest: event.dedupeKey, opId: event.opId!,
      ordinal: event.ordinal,
    };
    summaries.put(summary);
    injectFault(input.fault, 'after_summary', tx);
    events.put({ ...event, details: COMPACTED_MARK });
    injectFault(input.fault, 'after_delete', tx);
    written.push(summary);
    eventThrough = event.ordinal;
    compactedEvents += 1;
    return undefined;
  });

  const watermark: CompactionWatermark = {
    scopeKey: key,
    queueThroughSequence: queueThrough,
    eventThroughOrdinal: eventThrough,
    compactedAt: input.now,
    remainingEligible: compactedQueue === input.batch || compactedEvents === input.batch,
  };
  watermarks.put(watermark);
  injectFault(input.fault, 'after_watermark', tx);
  return { watermark, compactedQueue, compactedEvents, summaries: written };
}

function injectFault(actual: CompactFault | undefined, expected: CompactFault, tx: IDBTransaction): void {
  if (actual !== expected) return;
  tx.abort();
  throw Object.assign(new Error('fault_injected'), { name: 'SyncStateError', code: 'fault_injected' });
}

function receiptExists(
  receipts: IDBObjectStore,
  scopeKey: string,
  queued: CompactableQueueRow,
): Promise<boolean> {
  const index = receipts.indexNames.contains('by_scope_sequence')
    ? receipts.index('by_scope_sequence')
    : null;
  if (!index) return Promise.resolve(false);
  return requestValue(index.get([scopeKey, queued.sequence])).then((row) => {
    if (!row || typeof row !== 'object') return false;
    const record = row as { opId?: unknown; operationDigest?: unknown };
    return record.opId === queued.opId && record.operationDigest === queued.digest;
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('request_failed'));
  });
}

/** Visitors may await requests from this transaction only (no timers/network).
 * IDB completes their microtasks before auto-commit. Forward both visitor and
 * continuation errors to the transaction owner so partial compaction rolls back. */
async function iterateIndex(
  source: IDBIndex,
  range: IDBKeyRange,
  visit: (value: unknown) => Promise<boolean | void>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = source.openCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      try {
        void visit(cursor.value).then((proceed) => {
          if (proceed === false) resolve();
          else cursor.continue();
        }).catch(reject);
      } catch (error) { reject(error); }
    };
  });
}
