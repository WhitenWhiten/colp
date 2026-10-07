/**
 * Collection bookmark-count batch read-through decorator (library collection
 * bookmark-count plan §5.2 / §5.3 / P4).
 *
 * Existing `readThrough` is single-key. This domain caches an authenticated
 * list COUNT integer addressed by `(collectionId, contentRevision)` and MUST
 * batch: parallel GET (`Promise.all`), one origin `countBookmarks` (GROUP BY)
 * for the miss set, then SET each miss envelope. Hits never touch origin and
 * never SET. Same-process same data key uses `CacheSingleflight`; the
 * distributed lock is per collection data key (`SET NX PX` via
 * `store.setIfAbsent` / `buildCacheLockKey`) — never one lock for the page.
 *
 * This is the serve-path primitive. `KNOWN_CACHE_MODE` off/shadow/serve and
 * HTTP wiring are P5. Redis GET/SET/lock errors fail open to origin COUNT and
 * never throw to the caller. `serveStale` is forced false: a soft-expired
 * value is refreshed in the foreground and a refresh failure must not return
 * the stale integer. `0` is a real empty-collection count and is written.
 *
 * Application / Domain / Transport stay free of ioredis; this module only
 * uses `CacheStore`. The origin port is structural so cache does not import
 * the collections module.
 */
import { randomUUID } from 'node:crypto';
import type { CacheBulkhead } from './cache-bulkhead.js';
import type { CacheCircuitBreaker } from './cache-circuit-breaker.js';
import {
  runOriginWithCacheAbort,
  throwIfCacheAborted,
} from './cache-abort.js';
import {
  buildCollectionBookmarkCountCacheDataKey,
  encodeCollectionBookmarkCountCacheEnvelope,
  decodeCollectionBookmarkCountCacheEnvelope,
  isValidCollectionBookmarkCountCacheValue,
} from './collection-bookmark-count-cache-codec.js';
import { CACHE_ERROR_CATEGORY, CacheStoreError, type CacheStore } from './cache-store.js';
import {
  CacheKeyError,
  type CacheKeyOptions,
} from './cache-key-codec.js';
import { type CacheSingleflightLike } from './cache-singleflight.js';
import {
  buildCacheLockKey,
  buildCacheSingleflightKey,
  cacheDefaultSleep,
  computeCacheLockPollIntervalMs,
  type CacheReadPolicy,
} from './read-through-cache.js';

/** Plan §5.2: soft TTL for `collection.bookmark-count`. */
export const COLLECTION_BOOKMARK_COUNT_CACHE_SOFT_TTL_MS = 60_000;
/** Plan §5.2: hard TTL (revision addressing; TTL only recycles old revision keys). */
export const COLLECTION_BOOKMARK_COUNT_CACHE_HARD_TTL_MS = 300_000;
/** Low-cardinality domain label; never a cache key or collection id. */
export const COLLECTION_BOOKMARK_COUNT_CACHE_DOMAIN = 'collection-bookmark-count';

const DEFAULT_MAX_ENTRY_BYTES = 524_288;
const DEFAULT_LOCK_TTL_MS = 1_500;
/** Downward-only jitter budget: 10% of the plan hard TTL. */
const DEFAULT_HARD_TTL_JITTER_MS = Math.floor(COLLECTION_BOOKMARK_COUNT_CACHE_HARD_TTL_MS * 0.1);

export interface CollectionBookmarkCountCacheEntry {
  readonly collectionId: string;
  readonly contentRevision: string;
}

/**
 * Structural origin port (same shape as application `CollectionBookmarkCountReadPort`).
 * Cache must not import the collections module; P5 injects the Postgres adapter.
 */
export interface CollectionBookmarkCountCacheOrigin {
  countBookmarks(collectionIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

export interface CollectionBookmarkCountCache {
  lookupBookmarkCounts(
    entries: readonly CollectionBookmarkCountCacheEntry[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, number>>;
}

export interface CollectionBookmarkCountCacheOptions {
  readonly store: CacheStore;
  readonly origin: CollectionBookmarkCountCacheOrigin;
  readonly clock: () => number;
  readonly singleflight: CacheSingleflightLike;
  readonly bulkhead: CacheBulkhead;
  readonly key: CacheKeyOptions;
  /** Optional; `serveStale` is always forced false. Defaults match plan §5.2. */
  readonly policy?: CacheReadPolicy;
  /**
   * RDS-05 (T-11, 2026-08-27 backend performance audit): the shared T05
   * breaker. While open, a lookup bypasses Redis completely (one origin COUNT
   * through the bulkhead) instead of paying a failing GET per collection;
   * page reads feed success/unavailable outcomes back so recovery follows the
   * same half-open probe protocol as the Publication domains.
   */
  readonly breaker?: CacheCircuitBreaker;
  readonly random?: () => number;
  readonly tokenFactory?: () => string;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface KeyedEntry {
  readonly collectionId: string;
  readonly contentRevision: string;
  readonly dataKey: string;
}

type CountClassification =
  | { readonly kind: 'fresh_hit'; readonly bookmarkCount: number }
  | { readonly kind: 'soft_expired'; readonly bookmarkCount: number }
  | { readonly kind: 'miss' }
  | { readonly kind: 'decode_error' }
  | { readonly kind: 'unavailable' };

interface NormalizedPolicy {
  readonly domain: string;
  readonly softTtlMs: number;
  readonly hardTtlMs: number;
  readonly jitterMs: number;
  readonly maxEntryBytes: number;
  readonly lockTtlMs: number;
  readonly lockWaitCount: number;
  readonly lockWaitTimeoutMs: number;
}

export function defaultCollectionBookmarkCountCachePolicy(): CacheReadPolicy {
  return {
    domain: COLLECTION_BOOKMARK_COUNT_CACHE_DOMAIN,
    softTtlMs: COLLECTION_BOOKMARK_COUNT_CACHE_SOFT_TTL_MS,
    hardTtlMs: COLLECTION_BOOKMARK_COUNT_CACHE_HARD_TTL_MS,
    jitterMs: DEFAULT_HARD_TTL_JITTER_MS,
    serveStale: false,
    maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES,
    lockTtlMs: DEFAULT_LOCK_TTL_MS,
    lockWaitCount: 3,
  };
}

/**
 * Serve-path bookmark-count cache. Empty `entries` is a no-op (zero Redis,
 * zero origin). Unkeyable collection ids fail open to origin for that id and
 * do not poison the rest of the page.
 */
export function createCollectionBookmarkCountCache(
  options: CollectionBookmarkCountCacheOptions,
): CollectionBookmarkCountCache {
  const policy = normalizeBookmarkCountPolicy(options.policy);
  const sleep = options.sleep ?? cacheDefaultSleep;
  const random = options.random ?? Math.random;
  const tokenFactory = options.tokenFactory ?? defaultTokenFactory;

  return {
    async lookupBookmarkCounts(entries, signal) {
      const requestSignal = signal ?? new AbortController().signal;
      throwIfCacheAborted(requestSignal);

      if (entries.length === 0) return new Map();

      const breaker = options.breaker;
      if (breaker !== undefined && !breaker.allowRequest()) {
        // Breaker open: zero Redis commands, one bulkhead-bounded origin COUNT.
        const ids = uniqueIds(entries.map((entry) => entry.collectionId));
        const counts = await options.bulkhead.run(requestSignal, (loadSignal) =>
          runOriginWithCacheAbort(loadSignal, () => options.origin.countBookmarks(ids)));
        return new Map(ids.map((id) => [id, resolvedBookmarkCount(counts, id)]));
      }

      const keyed: KeyedEntry[] = [];
      const keyedByDataKey = new Set<string>();
      const failOpenIds: string[] = [];
      const failOpenSeen = new Set<string>();

      for (const entry of entries) {
        let dataKey: string;
        try {
          dataKey = buildCollectionBookmarkCountCacheDataKey({
            collectionId: entry.collectionId,
            query: { contentRevision: entry.contentRevision },
            environment: options.key.environment,
            keyPrefix: options.key.keyPrefix,
            schemaVersion: options.key.schemaVersion,
          });
        } catch (error) {
          if (error instanceof CacheKeyError) {
            if (!failOpenSeen.has(entry.collectionId)) {
              failOpenSeen.add(entry.collectionId);
              failOpenIds.push(entry.collectionId);
            }
            continue;
          }
          throw error;
        }
        if (keyedByDataKey.has(dataKey)) continue;
        keyedByDataKey.add(dataKey);
        keyed.push({
          collectionId: entry.collectionId,
          contentRevision: entry.contentRevision,
          dataKey,
        });
      }

      let reads: ReadonlyArray<{ item: KeyedEntry; classification: CountClassification }>;
      try {
        reads = await Promise.all(
          keyed.map(async (item) => {
            const classification = await classifyCachedCount(
              item.dataKey,
              policy,
              options.store,
              options.clock,
              requestSignal,
            );
            return { item, classification };
          }),
        );
      } catch (error) {
        // A cancelled half-open probe releases its slot without counting.
        breaker?.recordAbort();
        throw error;
      }
      if (breaker !== undefined && keyed.length > 0) {
        if (reads.some(({ classification }) => classification.kind === 'unavailable')) {
          breaker.recordFailure();
        } else {
          breaker.recordSuccess();
        }
      }

      const result = new Map<string, number>();
      const misses: KeyedEntry[] = [];

      for (const { item, classification } of reads) {
        if (classification.kind === 'fresh_hit') {
          result.set(item.collectionId, classification.bookmarkCount);
          continue;
        }
        if (classification.kind === 'unavailable') {
          if (!failOpenSeen.has(item.collectionId)) {
            failOpenSeen.add(item.collectionId);
            failOpenIds.push(item.collectionId);
          }
          continue;
        }
        misses.push(item);
      }

      const originIds = uniqueIds([
        ...failOpenIds,
        ...misses.map((item) => item.collectionId),
      ]);

      let originPromise: Promise<ReadonlyMap<string, number>> | undefined;
      const loadOriginCounts = (): Promise<ReadonlyMap<string, number>> => {
        if (originIds.length === 0) return Promise.resolve(new Map());
        originPromise ??= options.bulkhead.run(requestSignal, (loadSignal) =>
          runOriginWithCacheAbort(loadSignal, () => options.origin.countBookmarks(originIds)),
        );
        return originPromise;
      };

      const failOpenTask = (async (): Promise<void> => {
        if (failOpenIds.length === 0) return;
        const counts = await loadOriginCounts();
        for (const collectionId of failOpenIds) {
          result.set(collectionId, resolvedBookmarkCount(counts, collectionId));
        }
      })();

      const missTask = Promise.all(misses.map(async (item) => {
        const flightKey = buildCacheSingleflightKey(policy.domain, item.dataKey);
        const count = await options.singleflight.run(flightKey, requestSignal, (flightSignal) =>
          refreshMissLeader(item, {
            store: options.store,
            clock: options.clock,
            random,
            tokenFactory,
            sleep,
            policy,
            loadOriginCounts,
            signal: flightSignal,
          }),
        );
        result.set(item.collectionId, count);
      }));

      await Promise.all([failOpenTask, missTask]);
      return result;
    },
  };
}

function normalizeBookmarkCountPolicy(policy: CacheReadPolicy | undefined): NormalizedPolicy {
  const source = policy ?? defaultCollectionBookmarkCountCachePolicy();
  const jitterMs = source.jitterMs ?? DEFAULT_HARD_TTL_JITTER_MS;
  const lockWaitCount = source.lockWaitCount ?? 3;
  const lockWaitTimeoutMs = source.lockWaitTimeoutMs ?? lockWaitCount * source.lockTtlMs;
  return {
    domain: source.domain,
    softTtlMs: source.softTtlMs,
    hardTtlMs: source.hardTtlMs,
    jitterMs,
    maxEntryBytes: source.maxEntryBytes,
    lockTtlMs: source.lockTtlMs,
    lockWaitCount,
    lockWaitTimeoutMs,
  };
}

async function classifyCachedCount(
  key: string,
  policy: NormalizedPolicy,
  store: CacheStore,
  clock: () => number,
  signal: AbortSignal,
): Promise<CountClassification> {
  let raw: string | null;
  try {
    raw = await store.get(key, signal);
  } catch (error) {
    if (isCacheUnavailable(error)) return { kind: 'unavailable' };
    throw error;
  }
  if (raw === null) return { kind: 'miss' };

  const decoded = decodeCollectionBookmarkCountCacheEnvelope(raw, { maxEntryBytes: policy.maxEntryBytes });
  if (decoded.kind === 'decode_error') return { kind: 'decode_error' };
  const value = decoded.envelope.value;
  if (!isValidCollectionBookmarkCountCacheValue(value)) return { kind: 'decode_error' };

  const now = clock();
  if (now < decoded.envelope.softExpiresAtMs) {
    return { kind: 'fresh_hit', bookmarkCount: value.bookmarkCount };
  }
  if (now < decoded.envelope.hardExpiresAtMs) {
    return { kind: 'soft_expired', bookmarkCount: value.bookmarkCount };
  }
  return { kind: 'miss' };
}

async function refreshMissLeader(
  item: KeyedEntry,
  deps: {
    readonly store: CacheStore;
    readonly clock: () => number;
    readonly random: () => number;
    readonly tokenFactory: () => string;
    readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly policy: NormalizedPolicy;
    readonly loadOriginCounts: () => Promise<ReadonlyMap<string, number>>;
    readonly signal: AbortSignal;
  },
): Promise<number> {
  const lockKey = buildCacheLockKey(item.dataKey);
  const token = deps.tokenFactory();
  const pollIntervalMs = computeCacheLockPollIntervalMs(deps.policy.lockTtlMs);
  const attemptsCap = Math.max(
    deps.policy.lockWaitCount,
    Math.ceil(deps.policy.lockWaitTimeoutMs / pollIntervalMs),
  );
  const deadline = deps.clock() + deps.policy.lockWaitTimeoutMs;
  let lockHeld = false;
  let attempts = 0;

  try {
    while (attempts < attemptsCap && deps.clock() < deadline) {
      throwIfCacheAborted(deps.signal);

      let acquired: boolean;
      try {
        acquired = await deps.store.setIfAbsent(lockKey, token, deps.policy.lockTtlMs, deps.signal);
      } catch (error) {
        if (isCacheUnavailable(error)) {
          return await loadCountWithoutWrite(item.collectionId, deps.loadOriginCounts);
        }
        throw error;
      }

      if (acquired) {
        lockHeld = true;
        return await loadAndWrite(item, deps);
      }

      await deps.sleep(pollIntervalMs + sampleJitter(deps.random, pollIntervalMs), deps.signal);
      const recheck = await classifyCachedCount(
        item.dataKey,
        deps.policy,
        deps.store,
        deps.clock,
        deps.signal,
      );
      if (recheck.kind === 'fresh_hit') return recheck.bookmarkCount;
      if (recheck.kind === 'unavailable') {
        return await loadCountWithoutWrite(item.collectionId, deps.loadOriginCounts);
      }
      attempts += 1;
    }

    return await loadCountWithoutWrite(item.collectionId, deps.loadOriginCounts);
  } finally {
    if (lockHeld) {
      try {
        await deps.store.releaseIfOwner(lockKey, token, new AbortController().signal);
      } catch (error) {
        if (!isCacheUnavailable(error)) throw error;
      }
    }
  }
}

async function loadAndWrite(
  item: KeyedEntry,
  deps: {
    readonly store: CacheStore;
    readonly clock: () => number;
    readonly random: () => number;
    readonly policy: NormalizedPolicy;
    readonly loadOriginCounts: () => Promise<ReadonlyMap<string, number>>;
    readonly signal: AbortSignal;
  },
): Promise<number> {
  const counts = await deps.loadOriginCounts();
  const bookmarkCount = resolvedBookmarkCount(counts, item.collectionId);
  await writeBookmarkCountEnvelope(item.dataKey, bookmarkCount, deps);
  return bookmarkCount;
}

async function loadCountWithoutWrite(
  collectionId: string,
  loadOriginCounts: () => Promise<ReadonlyMap<string, number>>,
): Promise<number> {
  const counts = await loadOriginCounts();
  return resolvedBookmarkCount(counts, collectionId);
}

async function writeBookmarkCountEnvelope(
  key: string,
  bookmarkCount: number,
  deps: {
    readonly store: CacheStore;
    readonly clock: () => number;
    readonly random: () => number;
    readonly policy: NormalizedPolicy;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  const value = { bookmarkCount };
  if (!isValidCollectionBookmarkCountCacheValue(value)) return;

  const now = deps.clock();
  const jitter = computeHardJitter(deps.policy, deps.random);
  const softExpiresAtMs = now + deps.policy.softTtlMs;
  const hardExpiresAtMs = Math.max(now + deps.policy.hardTtlMs - jitter, softExpiresAtMs + 1);
  const encoded = encodeCollectionBookmarkCountCacheEnvelope(
    value,
    { writtenAtMs: now, softExpiresAtMs, hardExpiresAtMs },
    { maxEntryBytes: deps.policy.maxEntryBytes },
  );
  if (encoded.kind !== 'ok') return;

  const ttlMs = hardExpiresAtMs - now;
  try {
    await deps.store.set(key, encoded.encoded, ttlMs, deps.signal);
  } catch (error) {
    if (isCacheUnavailable(error)) return;
    throw error;
  }
}

function resolvedBookmarkCount(counts: ReadonlyMap<string, number>, collectionId: string): number {
  const value = counts.get(collectionId);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return 0;
}

function uniqueIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isCacheUnavailable(error: unknown): boolean {
  return error instanceof CacheStoreError && error.category === CACHE_ERROR_CATEGORY.UNAVAILABLE;
}

function sampleJitter(random: () => number, budgetMs: number): number {
  const sample = Math.max(0, Math.min(1, random()));
  return Math.floor(sample * (budgetMs + 1));
}

function computeHardJitter(policy: NormalizedPolicy, random: () => number): number {
  if (policy.jitterMs === 0) return 0;
  return sampleJitter(random, policy.jitterMs);
}

function defaultTokenFactory(): string {
  return randomUUID();
}
