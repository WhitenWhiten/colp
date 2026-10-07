/**
 * T09 Redis epoch invalidator (plan §4.3 / §4.4 / §6.4 T09).
 *
 * Rotates the fixed epoch keys that the T06/T07/T08 publication readers
 * consume:
 * - `{pub:<collectionId>}:pubid` — ID-scoped Metadata/Snapshot epoch (T06/T08);
 * - `{pub:<publicationSlug>}:pubslug` — slug-scoped Metadata epoch (T06: slug
 *   lookups are scoped by the slug because the collection id is only known
 *   after the first origin load). The locator kind namespaces the two epochs
 *   so an ID and an unrelated slug that happen to share a string never share
 *   an epoch key;
 * - `{publication-directory}` — global Directory first-page epoch (T07).
 *
 * Safety contract:
 * - The invalidator accepts only a legal invalidation scope (collectionId,
 *   publicationSlug, signal) taken from the delivery request. It never accepts
 *   an epoch value from an event and never calls `set` on an epoch key; the
 *   only mutation primitive is `CacheStore.rotateEpoch` (atomic INCR+PEXPIRE),
 *   so epochs are strictly monotonic and a duplicate or late event can only
 *   advance the pointer, never re-enable a historical epoch.
 * - Epoch TTL (default 120s) must exceed 2x the maximum data hard TTL (30s
 *   Metadata/Snapshot), so an epoch cannot expire while a data key written
 *   under it is still reachable (plan §4.3).
 * - Failures are classified honestly: Redis/store failures are retryable;
 *   an unkeyable scope (CacheKeyError) is permanent because retrying cannot
 *   fix it and it dead-letters instead of retrying forever.
 * - Metrics/logs stay low-cardinality: only the fixed `cache.epoch.rotation_total`
 *   counter is emitted; no collection id, slug, URL or payload text is used.
 */
import type { Metrics } from '../telemetry/index.js';
import {
  buildCacheEpochKey,
  CacheKeyError,
  type CacheKeyDomain,
  type CacheKeyOptions,
} from '../cache/cache-key-codec.js';
import type { CacheStore } from '../cache/cache-store.js';
import { PublicationCachePurgeProviderError } from './publication-cache-purge.js';

/**
 * Maximum data hard TTL any Publication cache domain writes (Metadata and
 * Snapshot both default to 30s; Directory defaults to 15s). The epoch TTL must
 * be strictly greater than twice this value (plan §4.3).
 */
export const PUBLICATION_MAX_DATA_HARD_TTL_MS = 30_000;

/**
 * Epoch key TTL: 120s > 2 x 30s. Long enough that an epoch survives two full
 * data hard-TTL generations, short enough that orphaned epochs naturally
 * expire once every old data key has been reclaimed.
 */
export const PUBLICATION_CACHE_EPOCH_TTL_MS = 120_000;

/** The only metric this invalidator emits: one increment per successful rotateEpoch. */
export const CACHE_EPOCH_ROTATION_METRIC = 'cache.epoch.rotation_total';

/** Legal invalidation scope derived from a purge request (never carries an epoch value). */
export interface RedisPublicationInvalidationScope {
  readonly collectionId: string;
  readonly publicationSlug: string;
  readonly signal: AbortSignal;
}

export interface RedisPublicationCacheInvalidatorOptions {
  readonly store: CacheStore;
  /** Redis key namespace (`environment` + optional `keyPrefix`). */
  readonly key: CacheKeyOptions;
  /** Epoch key TTL in ms; must be > 2 x PUBLICATION_MAX_DATA_HARD_TTL_MS. Defaults to 120s. */
  readonly epochTtlMs?: number;
  readonly metrics?: Metrics;
}

export class RedisPublicationCacheInvalidator {
  readonly epochTtlMs: number;
  private readonly store: CacheStore;
  private readonly key: CacheKeyOptions;
  private readonly metrics: Metrics | undefined;

  constructor(options: RedisPublicationCacheInvalidatorOptions) {
    const epochTtlMs = options.epochTtlMs ?? PUBLICATION_CACHE_EPOCH_TTL_MS;
    if (!Number.isSafeInteger(epochTtlMs) || epochTtlMs < 1) {
      throw new RangeError('publication cache epochTtlMs must be a positive safe integer');
    }
    if (epochTtlMs <= 2 * PUBLICATION_MAX_DATA_HARD_TTL_MS) {
      throw new RangeError(
        'publication cache epochTtlMs must be greater than 2x the max data hard TTL '
        + `(${2 * PUBLICATION_MAX_DATA_HARD_TTL_MS}ms) so an epoch outlives every data key under it`,
      );
    }
    this.store = options.store;
    this.key = options.key;
    this.epochTtlMs = epochTtlMs;
    this.metrics = options.metrics;
  }

  /**
   * Rotates both epochs a collection purge affects: the ID-scoped epoch
   * (`pubid`, consumed by T06/T08) and the slug-scoped epoch (`pubslug`, T06
   * slug lookups). The locator kinds make the two epoch keys distinct even
   * when the id and the slug are the same string, so both are always rotated.
   */
  async rotateCollection(scope: RedisPublicationInvalidationScope): Promise<void> {
    await this.rotateEpochFor(
      { kind: 'publication', locator: 'pubid', collectionId: scope.collectionId },
      scope.signal,
    );
    await this.rotateEpochFor(
      { kind: 'publication', locator: 'pubslug', collectionId: scope.publicationSlug },
      scope.signal,
    );
  }

  /** Rotates the global Directory first-page epoch ({publication-directory}). */
  async rotateDirectory(signal: AbortSignal): Promise<void> {
    await this.rotateEpochFor({ kind: 'publication-directory' }, signal);
  }

  private async rotateEpochFor(domain: CacheKeyDomain, signal: AbortSignal): Promise<void> {
    let key: string;
    try {
      key = buildCacheEpochKey({ ...this.key, domain });
    } catch (error) {
      if (error instanceof CacheKeyError) {
        throw new PublicationCachePurgeProviderError(
          'permanent',
          `publication cache scope is not keyable (${error.reason})`,
          { cause: error },
        );
      }
      throw new PublicationCachePurgeProviderError(
        'retryable',
        'failed to build publication cache epoch key',
        { cause: error },
      );
    }
    try {
      await this.store.rotateEpoch(key, this.epochTtlMs, signal);
    } catch (error) {
      if (error instanceof PublicationCachePurgeProviderError) throw error;
      throw new PublicationCachePurgeProviderError(
        'retryable',
        'publication cache epoch rotation failed',
        { cause: error },
      );
    }
    this.metrics?.increment(CACHE_EPOCH_ROTATION_METRIC, 1);
  }
}
