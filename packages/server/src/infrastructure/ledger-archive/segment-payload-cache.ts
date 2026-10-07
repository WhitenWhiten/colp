import { LedgerArchiveColdReadError } from './cold-reader.js';
import { SharedFlight } from '../async/shared-flight.js';

export const SEGMENT_CACHE_JS_OVERHEAD = 3n;
export const DEFAULT_MAX_CACHED_BYTES = 64n * 1024n * 1024n;
export const DEFAULT_MAX_BYTES_PER_SEGMENT = 16n * 1024n * 1024n;
export const DEFAULT_MAX_CONCURRENT_LOADS = 2;
const KEY_OVERHEAD_BYTES = 24n;

export interface SegmentPayloadCacheKey {
  readonly segmentId: string;
  readonly contentDigest: string;
  readonly archiveSchemaVersion: number;
}

export interface SegmentPayloadCacheOptions {
  readonly maxCachedBytes?: bigint;
  readonly maxBytesPerSegment?: bigint;
  readonly maxConcurrentLoads?: number;
  readonly maxQueuedLoads?: number;
  readonly maxRowsPerSegment?: number;
  readonly loadTimeoutMs?: number;
}

export interface SegmentPayloadCacheStats {
  readonly loads: number;
  readonly lookups: number;
  readonly scans: number;
  readonly evictions: number;
  readonly busy: number;
  readonly retainedBytes: bigint;
  readonly inFlight: number;
  readonly queued: number;
}

interface ArchiveRowReader {
  readRows(
    segmentId: string,
    onRow: (row: Readonly<{ key: bigint; value: unknown }>) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

interface CacheEntry {
  readonly rows: Map<bigint, unknown>;
  readonly retainedBytes: bigint;
  refCount: number;
  lastAccess: number;
}

export function segmentPayloadCacheKey(key: SegmentPayloadCacheKey): string {
  return `${key.segmentId}\n${key.contentDigest}\n${key.archiveSchemaVersion}`;
}

export function estimateRetainedBytes(valueBytes: bigint, rowCount: number): bigint {
  return (valueBytes + BigInt(rowCount) * KEY_OVERHEAD_BYTES) * SEGMENT_CACHE_JS_OVERHEAD;
}

export function createSegmentPayloadCache(options: SegmentPayloadCacheOptions = {}) {
  const maxCachedBytes = options.maxCachedBytes ?? DEFAULT_MAX_CACHED_BYTES;
  const maxBytesPerSegment = options.maxBytesPerSegment ?? DEFAULT_MAX_BYTES_PER_SEGMENT;
  const maxConcurrentLoads = options.maxConcurrentLoads ?? DEFAULT_MAX_CONCURRENT_LOADS;
  const maxQueuedLoads = options.maxQueuedLoads ?? 16;
  const maxRows = options.maxRowsPerSegment ?? 100_000;
  const loadTimeoutMs = options.loadTimeoutMs ?? 15_000;
  if (maxCachedBytes < 1n || maxCachedBytes > 128n * 1024n * 1024n
      || maxBytesPerSegment < 1n || maxBytesPerSegment > 64n * 1024n * 1024n
      || !Number.isSafeInteger(maxConcurrentLoads) || maxConcurrentLoads < 1 || maxConcurrentLoads > 16
      || !Number.isSafeInteger(maxQueuedLoads) || maxQueuedLoads < 0 || maxQueuedLoads > 1024
      || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1_000_000
      || !Number.isSafeInteger(loadTimeoutMs) || loadTimeoutMs < 100) {
    throw new RangeError('segment_payload_cache_options_invalid');
  }
  const heapBudget = maxCachedBytes + BigInt(maxConcurrentLoads) * maxBytesPerSegment;
  if (heapBudget > 256n * 1024n * 1024n) {
    throw new RangeError('segment_payload_cache_exceeds_api_memory_fraction');
  }

  const completed = new Map<string, CacheEntry>();
  const singleflight = new SharedFlight();
  const inflightAbort = new Map<string, AbortController>();
  let loads = 0;
  let lookups = 0;
  let scans = 0;
  let evictions = 0;
  let busy = 0;
  let activeLoads = 0;
  const loadWaiters: Array<{ grant(): void; cancel(): void }> = [];

  function retainedBytes(): bigint {
    let total = 0n;
    for (const entry of completed.values()) total += entry.retainedBytes;
    return total;
  }

  function evictUnused(needed: bigint): boolean {
    const victims = [...completed.entries()]
      .filter(([, entry]) => entry.refCount === 0)
      .sort((left, right) => left[1].lastAccess - right[1].lastAccess);
    let freeable = maxCachedBytes - retainedBytes();
    for (const [id, entry] of victims) {
      if (freeable >= needed) return true;
      completed.delete(id);
      evictions += 1;
      freeable += entry.retainedBytes;
    }
    return freeable >= needed;
  }

  async function acquireSlot(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (activeLoads < maxConcurrentLoads) { activeLoads += 1; return; }
    if (loadWaiters.length >= maxQueuedLoads) {
      busy += 1;
      throw new LedgerArchiveColdReadError('archive_reader_busy', 'Archive load queue is full.');
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        grant() { signal.removeEventListener('abort', waiter.cancel); resolve(); },
        cancel() {
          const index = loadWaiters.indexOf(waiter);
          if (index >= 0) loadWaiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.cancel);
          reject(signal.reason);
        },
      };
      loadWaiters.push(waiter);
      signal.addEventListener('abort', waiter.cancel, { once: true });
    });
  }

  async function withLoadSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    await acquireSlot(signal);
    try { signal.throwIfAborted(); return await work(); }
    finally {
      // Reserve the slot for a queued waiter before letting a new arrival race it.
      const next = loadWaiters.shift();
      if (next) next.grant();
      else activeLoads -= 1;
    }
  }

  async function materialize(key: SegmentPayloadCacheKey, reader: ArchiveRowReader, signal: AbortSignal): Promise<CacheEntry> {
    const rows = new Map<bigint, unknown>();
    let valueBytes = 0n;
    scans += 1;
    loads += 1;
    await reader.readRows(key.segmentId, (row) => {
      if (signal.aborted) {
        throw new LedgerArchiveColdReadError('archive_read_failed', 'Archive segment load was aborted.');
      }
      if (rows.size >= maxRows) {
        throw new LedgerArchiveColdReadError(
          'archive_materialization_row_ceiling', 'Archive segment exceeds cold-reader row ceiling.',
        );
      }
      if (rows.has(row.key)) {
        throw new LedgerArchiveColdReadError(
          'archive_materialization_duplicate_key', 'Archive segment contains a duplicate row key.',
        );
      }
      let encoded: string;
      try { encoded = JSON.stringify(row.value); } catch (error) {
        throw new LedgerArchiveColdReadError(
          'archive_materialization_value_invalid', 'Archive row cannot be materialized.', error,
        );
      }
      valueBytes += BigInt(Buffer.byteLength(encoded, 'utf8'));
      if (valueBytes > maxBytesPerSegment) {
        throw new LedgerArchiveColdReadError(
          'archive_materialization_byte_ceiling', 'Archive segment exceeds cold-reader memory ceiling.',
        );
      }
      rows.set(row.key, row.value);
    }, signal);
    signal.throwIfAborted();
    const retained = estimateRetainedBytes(valueBytes, rows.size);
    if (retained > maxCachedBytes) {
      throw new LedgerArchiveColdReadError(
        'archive_materialization_byte_ceiling', 'Archive segment exceeds the shared cache budget.',
      );
    }
    if (!evictUnused(retained)) {
      busy += 1;
      throw new LedgerArchiveColdReadError(
        'archive_reader_busy', 'Archive cache has no evictable capacity for this segment.',
      );
    }
    return { rows, retainedBytes: retained, refCount: 0, lastAccess: Date.now() };
  }

  async function load(key: SegmentPayloadCacheKey, reader: ArchiveRowReader, signal?: AbortSignal): Promise<Map<bigint, unknown>> {
    signal?.throwIfAborted();
    const id = segmentPayloadCacheKey(key);
    const hit = completed.get(id);
    if (hit) { hit.lastAccess = Date.now(); return hit.rows; }
    // The caller deadline includes admission queueing; a disconnected participant
    // leaves the shared flight without cancelling other live readers.
    const deadline = AbortSignal.timeout(loadTimeoutMs);
    const request = signal ? AbortSignal.any([signal, deadline]) : deadline;
    return singleflight.run(id, request, async participants => {
      const controller = new AbortController();
      inflightAbort.set(id, controller);
      const operation = AbortSignal.any([participants, controller.signal, deadline]);
      try {
        return await withLoadSlot(operation, async () => {
          const entry = completed.get(id) ?? await materialize(key, reader, operation);
          operation.throwIfAborted();
          completed.set(id, entry);
          return entry.rows;
        });
      } finally {
        if (inflightAbort.get(id) === controller) inflightAbort.delete(id);
      }
    });
  }

  return Object.freeze({
    async get(
      key: SegmentPayloadCacheKey,
      rowKey: bigint,
      reader: ArchiveRowReader,
      signal?: AbortSignal,
    ): Promise<unknown> {
      lookups += 1;
      const rows = await load(key, reader, signal);
      return rows.get(rowKey);
    },
    async readMany(
      key: SegmentPayloadCacheKey,
      rowKeys: readonly bigint[],
      reader: ArchiveRowReader,
      signal?: AbortSignal,
    ): Promise<ReadonlyMap<bigint, unknown>> {
      lookups += rowKeys.length;
      const rows = await load(key, reader, signal);
      const selected = new Map<bigint, unknown>();
      for (const rowKey of rowKeys) {
        if (rows.has(rowKey)) selected.set(rowKey, rows.get(rowKey));
      }
      return selected;
    },
    abort(key: SegmentPayloadCacheKey): void {
      inflightAbort.get(segmentPayloadCacheKey(key))?.abort();
    },
    stats(): SegmentPayloadCacheStats {
      return Object.freeze({
        loads, lookups, scans, evictions, busy, retainedBytes: retainedBytes(),
        inFlight: activeLoads, queued: loadWaiters.length,
      });
    },
  });
}

export type SegmentPayloadCache = ReturnType<typeof createSegmentPayloadCache>;
