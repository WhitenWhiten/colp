import { isProxy } from 'node:util/types';
import { DEFAULT_IMMUTABLE_JSON_MAX_DEPTH, immutableJsonSnapshot } from '../shared/immutable-json.js';
import type { SyncPullEventPage } from './pull.js';

/**
 * Own keys copied for one event-store page.
 *
 * Not `limit * (per-event maximum + framing)`. One event may still use the
 * full per-event member budget; measured framing for that event is 8 keys,
 * and a 1,000-event page of ordinary deletes is about 15,005 members.
 * 100,000 admits those pages without scaling to 10,003,005 at limit 1,000.
 */
export const SYNC_PULL_PAGE_MAX_MEMBERS = 100_000;

/**
 * UTF-8 JSON bytes copied for one multi-event event-store page.
 *
 * SDK memory budget for that copy. Not HTTP `pullResponseBytes` (legacy
 * 2 MiB) and not the client response `maxBytes`. A one-event page is exempt
 * so a single per-event-legal payload stays deliverable.
 */
export const SYNC_PULL_PAGE_MAX_BYTES = 1_048_576;

export const pullPageSnapshotLimits = Object.freeze({
  maxMembers: SYNC_PULL_PAGE_MAX_MEMBERS,
  maxDepth: DEFAULT_IMMUTABLE_JSON_MAX_DEPTH + 3,
});

class PullPageBudgetError extends RangeError {}

/**
 * Keep a prefix from one authoritative read. No re-query can mix its revision
 * with another cut. One full-page probe and at most ceil(log2(limit)) prefix
 * probes touch uncopied input;
 * only the chosen prefix is cloned, and omitted entries keep hasMore true.
 * Descriptor inspection never invokes accessors or Proxy traps.
 */
export function snapshotPullEventStorePage(raw: SyncPullEventPage, limit: number): SyncPullEventPage {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || isProxy(raw)) {
    throw new TypeError('Sync Pull event store page must be plain JSON.');
  }
  const prototype = Object.getPrototypeOf(raw) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Sync Pull event store page must be plain JSON.');
  }
  const allowed = new Set(['entries', 'hasMore', 'collectionRevision', 'recommendedPullAfterSeconds']);
  const metadata: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (typeof key !== 'string' || !allowed.has(key) || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Sync Pull event store page must contain only its plain data fields.');
    }
    if (key !== 'entries') metadata[key] = descriptor.value;
  }
  const count = pullPageEntryCount(raw);
  if (count === undefined) throw new TypeError('Sync Pull event store entries must be a plain dense array.');
  if (count > limit) throw new RangeError('Sync Pull event store returned more entries than requested.');
  const source = Object.getOwnPropertyDescriptor(raw, 'entries')!.value as unknown[];
  if (Reflect.ownKeys(source).length !== count + 1) {
    throw new TypeError('Sync Pull event store entries must be a plain dense array.');
  }
  const entries: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError('Sync Pull event store entries must be a plain dense array.');
    }
    entries.push(descriptor.value);
  }
  const frame = immutableJsonSnapshot(metadata, 'Sync Pull page metadata') as Omit<SyncPullEventPage, 'entries'>;
  if (typeof frame.hasMore !== 'boolean') throw new TypeError('Sync Pull hasMore must be boolean.');
  const candidate = (size: number) => ({
    ...frame, entries: entries.slice(0, size), hasMore: size < count || frame.hasMore,
  });
  const fits = (size: number): boolean => {
    try { assertSyncPullEventStorePageBudget(candidate(size)); return true; }
    catch (error) { if (error instanceof PullPageBudgetError) return false; throw error; }
  };
  let size = count;
  if (!fits(size)) {
    if (count < 2) throw new PullPageBudgetError('Sync Pull event store page exceeds its whole-page budget.');
    let lower = 1;
    let upper = count - 1;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      if (fits(middle)) lower = middle;
      else upper = middle - 1;
    }
    size = lower;
  }
  // Plain-data validation and per-event validation still reject malformed
  // selected input before event cursors or any response can be persisted.
  return immutableJsonSnapshot(candidate(size), 'Sync Pull event store page', pullPageSnapshotLimits) as SyncPullEventPage;
}

function pullPageEntryCount(page: unknown): number | undefined {
  if (typeof page !== 'object' || page === null || Array.isArray(page) || isProxy(page)) return undefined;
  const entries = Object.getOwnPropertyDescriptor(page, 'entries');
  if (entries === undefined || !entries.enumerable || !('value' in entries) || !Array.isArray(entries.value)) {
    return undefined;
  }
  if (isProxy(entries.value) || Object.getPrototypeOf(entries.value) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(entries.value, 'length');
  if (length === undefined || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0) {
    return undefined;
  }
  return length.value;
}

/**
 * Rejects a multi-event page that cannot be copied inside the whole-page budget.
 * Runs before the isolating snapshot and before event-cursor resolution, so an
 * over-budget page never becomes a cursor the caller can persist. One entry is
 * left to the per-event budget: a legal single event must stay deliverable.
 * Malformed pages return without deciding; the snapshot reports those errors.
 */
function assertSyncPullEventStorePageBudget(page: unknown): void {
  if (pullPageEntryCount(page) === 1) return;
  const state = { members: 0, bytes: 0 };
  if (!measurePullJson(page, state, new Set(), 0)) return;
}

function measurePullJson(
  value: unknown,
  state: { members: number; bytes: number },
  seen: Set<object>,
  depth: number,
): boolean {
  if (depth > pullPageSnapshotLimits.maxDepth) return false;
  if (value === null) {
    addPullBytes(state, 4);
    return true;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > SYNC_PULL_PAGE_MAX_BYTES) {
      throw new PullPageBudgetError('Sync Pull event store page exceeds its whole-page byte budget.');
    }
    addPullBytes(state, Buffer.byteLength(JSON.stringify(value), 'utf8'));
    return true;
  }
  if (typeof value === 'boolean') {
    addPullBytes(state, value ? 4 : 5);
    return true;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    addPullBytes(state, Buffer.byteLength(JSON.stringify(value), 'utf8'));
    return true;
  }
  if (typeof value !== 'object' || isProxy(value) || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return false;
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
      || lengthDescriptor.value !== value.length || keys.length !== value.length + 1) return false;
    addPullMembers(state, keys.length);
    seen.add(value);
    addPullBytes(state, 1);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return releasePullSeen(seen, value);
      }
      if (index > 0) addPullBytes(state, 1);
      if (!measurePullJson(descriptor.value, state, seen, depth + 1)) return releasePullSeen(seen, value);
    }
    seen.delete(value);
    addPullBytes(state, 1);
    return true;
  }
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  addPullMembers(state, keys.length);
  seen.add(value);
  addPullBytes(state, 1);
  let first = true;
  for (const key of keys) {
    if (typeof key !== 'string') return releasePullSeen(seen, value);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      return releasePullSeen(seen, value);
    }
    if (!first) addPullBytes(state, 1);
    first = false;
    addPullBytes(state, Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
    if (!measurePullJson(descriptor.value, state, seen, depth + 1)) return releasePullSeen(seen, value);
  }
  seen.delete(value);
  addPullBytes(state, 1);
  return true;
}

function addPullMembers(state: { members: number }, count: number): void {
  state.members += count;
  if (state.members > SYNC_PULL_PAGE_MAX_MEMBERS) {
    throw new PullPageBudgetError('Sync Pull event store page exceeds its whole-page member budget.');
  }
}

function addPullBytes(state: { bytes: number }, count: number): void {
  state.bytes += count;
  if (state.bytes > SYNC_PULL_PAGE_MAX_BYTES) {
    throw new PullPageBudgetError('Sync Pull event store page exceeds its whole-page byte budget.');
  }
}

function releasePullSeen(seen: Set<object>, value: object): false {
  seen.delete(value);
  return false;
}
