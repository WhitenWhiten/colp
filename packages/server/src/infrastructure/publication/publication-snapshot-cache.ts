/**
 * T08 anonymous-public Snapshot default-first-page query cache decorator (plan
 * §6.4 T08 / §3.1 / §4.2 / §4.3).
 *
 * Placement: `infrastructure/publication` wraps the Application query output
 * (`getPublicationSnapshotPage`), never the raw `PublicationSnapshotReadPort`
 * rows (those carry owner/membership/visibility internals and are unvalidated).
 *
 * Behaviour:
 * - Only the anonymous *default first page* is cached: principal anonymous,
 *   root/depth/pageCursor absent, include empty and a limit that normalizes to
 *   the current default (an explicit default limit is included). Authenticated
 *   member reads, non-default shapes and continuation pages bypass the cache
 *   completely (zero cache commands) and keep the authoritative application
 *   path.
 * - The default-query decision is delegated to the exact application parser
 *   (`normalizePublicationSnapshotQuery`), so an invalid query always keeps the
 *   origin's error with zero cache commands.
 * - Canonical query hash: the normalized root/depth/include/limit/pageCursor
 *   shape hashed by the T02 codec (`normalizeCacheQuery` + `buildCacheDataKey`)
 *   together with the collection-scoped domain `{pub:<collectionId>}` and the
 *   T02 protocol/schema versions. The data key embeds the collection epoch so
 *   T09's rotation makes old first pages unreachable. No unbounded Set / KEYS /
 *   SCAN is used.
 * - The origin loader returns only values that already passed the Snapshot
 *   COLP schema, bookmark-URL and semantic validation. The cached value is
 *   exactly the validated public projection: `{ projection: 'public', snapshot,
 *   nextCursor, byteLength }`. `ownerSubjectId` is an internal authority fact
 *   (a T02 forbidden field) and is never cached; the anonymous wire route never
 *   consumes it. `nextCursor` is never regenerated, re-sorted or extended on a
 *   hit; body bytes, revision, ETag and cursor stay equivalent to the reference
 *   path.
 * - Size: the 512 KiB budget is applied to the final UTF-8 byte length of the
 *   encoded envelope (T02 codec). Oversized values are served from origin and
 *   never written, never truncated.
 * - Cached values are never trusted after decode: every hit is shape-validated;
 *   a bad envelope/shape is treated as a miss, re-loaded from origin and
 *   healed. `serveStale` is forced to false and cannot be overridden.
 * - `snapshot_expired`, `resource_not_found`, permission concealment and
 *   database failures propagate untouched (loader_error) and are never
 *   serialized as success envelopes.
 * - CacheKeyError and cache_unavailable epoch reads fail open to the
 *   authoritative origin path.
 */
import {
  getPublicationSnapshotPage,
  isValidPublicationSnapshot,
  normalizePublicationSnapshotQuery,
  PUBLICATION_SNAPSHOT_DEFAULT_LIMIT,
  type PublicationSnapshotPageResult,
  type PublicationSnapshotQueryInput,
  type PublicationSnapshotQueryPorts,
} from '../../modules/publication/index.js';
import {
  CACHE_PROJECTION,
  CacheKeyError,
  buildCacheDataKey,
  buildCacheEpochKey,
  CacheFallbackRejectedError,
  isRecord,
  normalizeCacheQuery,
  readThrough,
  recordCacheEpochCorrupt,
  runOriginWithCacheAbort,
  type CacheFailurePolicy,
  type CacheKeyOptions,
  type CacheReadDependencies,
  type CacheReadPolicy,
} from '../cache/index.js';
import type { Metrics } from '../telemetry/index.js';
import { readPublicationCacheEpoch } from './publication-cache-epoch.js';

/** `CacheReadDependencies` minus the loader: the decorator supplies its own origin loader. */
export type PublicationSnapshotCacheDeps = Omit<CacheReadDependencies, 'loader'> & {
  readonly failurePolicy: CacheFailurePolicy;
  /** Optional metrics sink for the low-cardinality epoch-corruption counter. */
  readonly metrics?: Metrics;
};

/**
 * The only cacheable anonymous Snapshot value: the validated public projection.
 * `ownerSubjectId` (an internal authority fact) is deliberately absent.
 */
export interface PublicationSnapshotCachedValue {
  readonly projection: 'public';
  readonly snapshot: PublicationSnapshotPageResult['snapshot'];
  readonly nextCursor: string | null;
  readonly byteLength: number;
}

/**
 * The anonymous wire result surface: `PublicationSnapshotPageResult` without
 * the internal `ownerSubjectId` authority fact. The anonymous snapshot route
 * consumes only `snapshot`/`nextCursor`/`projection`/`byteLength`, so T10 can
 * substitute the cached reader for the anonymous transport without changing
 * the handler.
 */
export type PublicationSnapshotCacheResult = Omit<PublicationSnapshotPageResult, 'ownerSubjectId'>;

export interface PublicationSnapshotCacheOptions {
  /** Domain read policy (soft/hard TTLs, budgets); `serveStale` is always forced false. */
  readonly policy: CacheReadPolicy;
  readonly deps: PublicationSnapshotCacheDeps;
  /** Redis key namespace (`environment` + optional `keyPrefix`). */
  readonly key: CacheKeyOptions;
}

/**
 * Same call surface as `getPublicationSnapshotPage` minus the internal
 * `ownerSubjectId` fact, so T10 can substitute the cached reader for the
 * anonymous snapshot route without changing the transport. `signal` defaults to
 * a never-aborted controller when the caller has none.
 */
export type PublicationSnapshotCacheReader = (
  ports: PublicationSnapshotQueryPorts,
  input: PublicationSnapshotQueryInput,
  signal?: AbortSignal,
) => Promise<PublicationSnapshotCacheResult>;
export function createPublicationSnapshotCache(
  options: PublicationSnapshotCacheOptions,
): PublicationSnapshotCacheReader {
  const { deps, policy } = options;
  const keyOptions = options.key;

  return async (ports, input, signal): Promise<PublicationSnapshotCacheResult> => {
    const requestSignal = signal ?? new AbortController().signal;

    // Only the anonymous default first page is cached. Member reads, non-default
    // shapes and continuations bypass with zero cache commands.
    if (!isDefaultFirstPageQuery(input)) {
      return toPublicResult(await getPublicationSnapshotPage(ports, input, requestSignal));
    }

    // The guard already validated the default shape; normalize once more to
    // build the canonical query hash. root/depth/include/limit/pageCursor are
    // all part of the hash (never dropped from the key).
    const normalized = normalizePublicationSnapshotQuery(input.query);
    const query = normalizeCacheQuery({
      root: normalized.root ?? null,
      depth: normalized.depth ?? null,
      include: normalized.include,
      limit: normalized.limit,
      pageCursor: normalized.pageCursor ?? null,
    });
    if (query.kind !== 'ok') {
      return toPublicResult(await getPublicationSnapshotPage(ports, input, requestSignal)); // defensive fail-open
    }
    const domain = { kind: 'publication' as const, locator: 'pubid' as const, collectionId: input.collectionId };

    let epochKey: string;
    try {
      epochKey = buildCacheEpochKey({ ...keyOptions, domain });
    } catch (error) {
      if (error instanceof CacheKeyError) {
        // Unkeyable collection id: never let a key-build error break reads.
        return toPublicResult(await getPublicationSnapshotPage(ports, input, requestSignal));
      }
      throw error;
    }

    const loader = async (loadSignal: AbortSignal): Promise<unknown | null> => {
      const result = await runOriginWithCacheAbort(
        loadSignal,
        (s) => getPublicationSnapshotPage(ports, input, s),
      );
      // Only the validated public projection is cacheable. Member projections
      // cannot reach this path (the guard requires anonymous), but a defensive
      // rejection keeps authority facts out of the anonymous value.
      if (result.projection !== 'public') {
        throw new Error('publication snapshot member projection is not cacheable');
      }
      return toCachedValue(result);
    };

    const readPolicy = { ...policy, serveStale: false } as const;
    const readDeps: CacheReadDependencies = {
      ...deps,
      loader,
      validateCachedValue: (value) => isValidCachedSnapshotProjection(value, input.collectionId),
    };
    let policyResult;
    try {
      policyResult = await deps.failurePolicy.readOperationWithPolicy<PublicationSnapshotCachedValue>(
        readPolicy,
        readDeps,
        requestSignal,
        async () => {
          const epoch = await readPublicationCacheEpoch(deps.store, epochKey, requestSignal, () => {
            if (deps.metrics !== undefined) recordCacheEpochCorrupt(deps.metrics, policy.domain);
          });
          const dataKey = buildCacheDataKey({
            ...keyOptions,
            domain,
            projection: CACHE_PROJECTION.PUBLICATION_SNAPSHOT,
            epoch,
            query: query.query,
          });
          return readThrough<PublicationSnapshotCachedValue>(dataKey, readPolicy, readDeps, requestSignal);
        },
      );
    } catch (error) {
      if (error instanceof CacheKeyError) {
        return toPublicResult(await getPublicationSnapshotPage(ports, input, requestSignal));
      }
      throw error;
    }
    const result = policyResult.result;

    switch (result.kind) {
      case 'cache_hit':
      case 'stale_hit': {
        // serveStale is forced false, so stale_hit is defensive only.
        if (!(await isCurrentPublicSnapshot(ports, result.value))) {
          return toPublicResult(await getPublicationSnapshotPage(ports, input, requestSignal));
        }
        return result.value;
      }
      case 'origin':
        // The loader only ever returns a validated public first-page projection.
        return result.value;
      case 'not_found':
        // The Snapshot origin always produces a page or throws; a not-found is
        // an internal contract violation, never a negative cache.
        throw new Error('publication snapshot origin returned no page');
      case 'loader_error':
        // snapshot_expired / resource_not_found / permission / schema / database
        // errors propagate untouched; they are never written as success values.
        throw result.error;
      case 'fallback_rejected':
        throw new CacheFallbackRejectedError('publication snapshot');
    }
  };
}

/** Never trust a public snapshot hit across an owner lifecycle or revision change. */
async function isCurrentPublicSnapshot(
  ports: PublicationSnapshotQueryPorts,
  value: PublicationSnapshotCachedValue,
): Promise<boolean> {
  try {
    const collectionId = value.snapshot.collection.id;
    if (ports.collectionControl === undefined) return false;
    const control = await ports.collectionControl.collectionControl(collectionId);
    if (control.hidePublic || control.restrictPublication === true) return false;
    if (ports.reads.isPublicCacheCurrent === undefined) return false;
    return await ports.reads.isPublicCacheCurrent(collectionId, value.snapshot.revision);
  } catch {
    return false;
  }
}

/** Strips the internal ownerSubjectId authority fact for the anonymous wire surface. */
function toPublicResult(result: PublicationSnapshotPageResult): PublicationSnapshotCacheResult {
  return {
    projection: result.projection,
    snapshot: result.snapshot,
    nextCursor: result.nextCursor,
    byteLength: result.byteLength,
  };
}

/** Converts a validated public origin result into the cacheable public projection. */
function toCachedValue(result: PublicationSnapshotPageResult): PublicationSnapshotCachedValue {
  return {
    projection: 'public',
    snapshot: result.snapshot,
    nextCursor: result.nextCursor,
    byteLength: result.byteLength,
  };
}
/**
 * Cache guard for the only cacheable Snapshot shape: anonymous principal,
 * root/depth/pageCursor absent, include empty and the current default first
 * page limit. Uses the exact application parser so an invalid query and an
 * explicit default limit follow normalizeQuery's real result (absent or
 * explicit default both normalize to `PUBLICATION_SNAPSHOT_DEFAULT_LIMIT`).
 */
function isDefaultFirstPageQuery(input: PublicationSnapshotQueryInput): boolean {
  if (input.principal.kind !== 'anonymous') return false;
  let normalized: ReturnType<typeof normalizePublicationSnapshotQuery>;
  try {
    normalized = normalizePublicationSnapshotQuery(input.query);
  } catch {
    // Invalid queries are never cached: delegate to origin, which raises the
    // same error, with zero cache commands.
    return false;
  }
  return normalized.root === undefined
    && normalized.depth === undefined
    && normalized.include.length === 0
    && normalized.limit === PUBLICATION_SNAPSHOT_DEFAULT_LIMIT
    && normalized.pageCursor === undefined;
}

const SNAPSHOT_VALUE_KEYS = new Set(['snapshot', 'projection', 'nextCursor', 'byteLength']);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Structural shape check for a cached public Snapshot first page (plan §6.4
 * T08: "命中返回的 value 应等价于校验后的公开投影；对 envelope value 做形状校验").
 * The nested Snapshot is revalidated with the same COLP schema, URL and
 * semantic validators as the authoritative query before it can be returned.
 */
function isValidCachedSnapshotProjection(value: unknown, collectionId: string): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, SNAPSHOT_VALUE_KEYS) || value.projection !== 'public') return false;
  if (value.nextCursor !== null && typeof value.nextCursor !== 'string') return false;
  const byteLength = value.byteLength;
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) return false;

  const snapshot = value.snapshot;
  if (!isValidPublicationSnapshot(snapshot)) return false;

  // P4A-P09: while no shared-exposure eligibility exists the gate-derived
  // projection is ALWAYS an empty attachments array (the eligibility union is
  // closed on the explicit ineligible verdict). A cached snapshot that carries
  // ANY attachment entry is a pre-gate old artifact (or a cache-poisoning
  // attempt): reject it so the read-through treats it as a miss and rebuilds
  // through the gate instead of serving private projections from the cache.
  if (snapshot.attachments.length !== 0) return false;

  const page = snapshot.page;
  if (!isRecord(page)) return false;
  if (page.nextCursor !== value.nextCursor) return false;
  if (typeof page.hasMore !== 'boolean' || page.hasMore !== (value.nextCursor !== null)) return false;
  const sequence = page.sequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) return false;

  if (snapshot.collection.id !== collectionId || snapshot.collection.revision !== snapshot.revision) return false;

  return byteLength === Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
}
