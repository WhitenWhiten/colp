/**
 * T06 anonymous-public Metadata query cache decorator (plan §6.4 T06 / §3.1 /
 * §4.2 / §4.3).
 *
 * Placement: `infrastructure/publication` wraps the Application query output
 * (`getPublicationCollectionMetadata`), never the raw `PublicationMetadataReadPort`
 * rows (those carry owner/membership/visibility internals and are unvalidated).
 *
 * Behaviour:
 * - Only `principal.kind === 'anonymous'` is cached. Authenticated owner/member
 *   requests bypass the cache completely (zero cache commands) and keep the
 *   authoritative application path.
 * - Read path: `store.get(epochKey)` (missing => 0; malformed => origin bypass), then
 *   `readThrough(dataKey(epoch))`. The data key embeds the collection epoch so
 *   T09's rotation makes old values unreachable.
 * - The origin loader returns only values that already passed the application
 *   DTO/COLP schema and semantic checks. `kind:'metadata'` results are
 *   cacheable; confirmed anonymous not-found is returned as `null` so the
 *   decorator writes a 5s hard-TTL negative marker; public tombstones
 *   (`kind:'gone'`) and permission concealment / schema / database failures are
 *   never written.
 * - Cached values are never trusted after decode: every hit is shape-validated;
 *   a bad envelope/shape is treated as a miss, re-loaded from origin and
 *   healed. `serveStale` is forced to false and cannot be overridden.
 * - CacheKeyError (unkeyable collection id/slug) and cache_unavailable epoch
 *   reads fail open to the authoritative origin path.
 */
import {
  getPublicationCollectionMetadata,
  isValidPublicationCollectionMetadata,
  PublicationMetadataConfirmedNotFoundError,
  PublicationMetadataNotFoundError,
  type PublicationMetadataQueryInput,
  type PublicationMetadataQueryPorts,
  type PublicationMetadataResult,
} from '../../modules/publication/index.js';
import {
  CACHE_ERROR_CATEGORY,
  CACHE_PROJECTION,
  CacheAbortError,
  CacheKeyError,
  CacheStoreError,
  buildCacheDataKey,
  buildCacheEpochKey,
  CacheFallbackRejectedError,
  encodeCacheEnvelope,
  isRecord,
  normalizeCacheQuery,
  readThrough,
  recordCacheEpochCorrupt,
  runOriginWithCacheAbort,
  type CacheFailurePolicy,
  type CacheKeyOptions,
  type CacheReadDependencies,
  type CacheReadPolicy,
  type CacheStore,
} from '../cache/index.js';
import type { Metrics } from '../telemetry/index.js';
import { readPublicationCacheEpoch } from './publication-cache-epoch.js';

/** Default hard TTL for the confirmed anonymous not-found negative entry (plan §6.4 T06). */
export const PUBLICATION_METADATA_NEGATIVE_TTL_MS = 5_000;

/** Marker value stored (with a short hard TTL) for a confirmed anonymous not-found. */
const NEGATIVE_MARKER = Object.freeze({ kind: 'not_found' });

/**
 * Internal carrier for a confirmed public tombstone (`kind:'gone'`). Tombstones
 * are returned to the caller but never written to the cache; readThrough has no
 * "return without caching" loader contract, so the loader raises this and the
 * decorator unwraps it from the `loader_error` result.
 */
class PublicationMetadataGoneResultError extends Error {
  readonly result: PublicationMetadataResult;
  constructor(result: PublicationMetadataResult) {
    super('publication metadata tombstone results are not cacheable');
    this.name = 'PublicationMetadataGoneResultError';
    this.result = result;
  }
}

/** `CacheReadDependencies` minus the loader: the decorator supplies its own origin loader. */
export type PublicationMetadataCacheDeps = Omit<CacheReadDependencies, 'loader'> & {
  readonly failurePolicy: CacheFailurePolicy;
  /** Optional metrics sink for the low-cardinality epoch-corruption counter. */
  readonly metrics?: Metrics;
};

export interface PublicationMetadataCacheOptions {
  /** Domain read policy (soft/hard TTLs, budgets); `serveStale` is always forced false. */
  readonly policy: CacheReadPolicy;
  readonly deps: PublicationMetadataCacheDeps;
  /** Redis key namespace (`environment` + optional `keyPrefix`). */
  readonly key: CacheKeyOptions;
  /** Confirmed not-found hard TTL (ms); defaults to 5s. */
  readonly notFoundTtlMs?: number;
}

/**
 * Same call surface as `getPublicationCollectionMetadata` so T10 can substitute
 * the cached reader for `dependencies.query` without changing the transport.
 * `signal` defaults to a never-aborted controller when the caller has none.
 */
export type PublicationMetadataCacheReader = (
  ports: PublicationMetadataQueryPorts,
  input: PublicationMetadataQueryInput,
  signal?: AbortSignal,
) => Promise<PublicationMetadataResult>;

export function createPublicationMetadataCache(
  options: PublicationMetadataCacheOptions,
): PublicationMetadataCacheReader {
  const notFoundTtlMs = options.notFoundTtlMs ?? PUBLICATION_METADATA_NEGATIVE_TTL_MS;
  if (!Number.isSafeInteger(notFoundTtlMs) || notFoundTtlMs < 1) {
    throw new RangeError('publication metadata notFoundTtlMs must be a positive safe integer');
  }
  const { deps, policy } = options;
  const keyOptions = options.key;

  return async (ports, input, signal): Promise<PublicationMetadataResult> => {
    const requestSignal = signal ?? new AbortController().signal;

    // Authenticated owner/member reads bypass the anonymous cache entirely:
    // no anonymous key is read or written and the authoritative path runs.
    if (input.principal.kind !== 'anonymous') {
      return getPublicationCollectionMetadata(ports, input, requestSignal);
    }

    // ID/slug isolation: the key carries the normalized identifier in both the
    // domain scope and the query hash, and the locator kind namespaces the
    // epoch (`pubid` vs `pubslug`), so an id and an unrelated slug that happen
    // to share a string never share an epoch key. Slug lookups are scoped by
    // the slug itself because the collection id is only known after the first
    // origin load; T09 rotates the same slug/collection epoch this reader
    // consumes.
    const query = normalizeCacheQuery(
      input.collectionId !== undefined
        ? { collectionId: input.collectionId }
        : { publicationSlug: input.publicationSlug },
    );
    if (query.kind !== 'ok') {
      return getPublicationCollectionMetadata(ports, input, requestSignal); // defensive fail-open
    }
    const domain = input.collectionId !== undefined
      ? { kind: 'publication' as const, locator: 'pubid' as const, collectionId: input.collectionId }
      : { kind: 'publication' as const, locator: 'pubslug' as const, collectionId: input.publicationSlug };

    let epochKey: string;
    try {
      epochKey = buildCacheEpochKey({ ...keyOptions, domain });
    } catch (error) {
      if (error instanceof CacheKeyError) {
        // Unkeyable collection id/slug: never let a key-build error break reads.
        return getPublicationCollectionMetadata(ports, input, requestSignal);
      }
      throw error;
    }

    const loader = async (loadSignal: AbortSignal): Promise<unknown | null> => {
      const outcome = await runOriginQuery(ports, input, loadSignal);
      switch (outcome.kind) {
        case 'metadata':
          return outcome.result;
        case 'confirmed_not_found':
          return null;
        case 'gone':
          throw new PublicationMetadataGoneResultError(outcome.result);
        case 'error':
          throw outcome.error;
      }
    };

    let dataKey: string | undefined;
    const readPolicy = { ...policy, serveStale: false } as const;
    const readDeps: CacheReadDependencies = {
      ...deps,
      loader,
      validateCachedValue: isValidMetadataCacheValue,
    };
    let policyResult;
    try {
      policyResult = await deps.failurePolicy.readOperationWithPolicy<PublicationMetadataResult>(
        readPolicy,
        readDeps,
        requestSignal,
        async () => {
          const epoch = await readPublicationCacheEpoch(deps.store, epochKey, requestSignal, () => {
            if (deps.metrics !== undefined) recordCacheEpochCorrupt(deps.metrics, policy.domain);
          });
          dataKey = buildCacheDataKey({
            ...keyOptions,
            domain,
            projection: CACHE_PROJECTION.PUBLICATION_METADATA,
            epoch,
            query: query.query,
          });
          return readThrough<PublicationMetadataResult>(dataKey, readPolicy, readDeps, requestSignal);
        },
      );
    } catch (error) {
      if (error instanceof CacheKeyError) return getPublicationCollectionMetadata(ports, input, requestSignal);
      throw error;
    }
    const result = policyResult.result;

    switch (result.kind) {
      case 'cache_hit': {
        if (isNegativeMarker(result.value)) throw new PublicationMetadataNotFoundError();
        if (!(await isCurrentPublicMetadata(ports, result.value))) {
          return getPublicationCollectionMetadata(ports, input, requestSignal);
        }
        return result.value;
      }
      case 'stale_hit': {
        // serveStale is forced false, so this branch is defensive only.
        if (isNegativeMarker(result.value)) throw new PublicationMetadataNotFoundError();
        if (!(await isCurrentPublicMetadata(ports, result.value))) {
          return getPublicationCollectionMetadata(ports, input, requestSignal);
        }
        return result.value;
      }
      case 'origin':
        // The loader only ever returns a validated public 'metadata' projection.
        return result.value;
      case 'not_found':
        // Confirmed anonymous not-found: write the short hard-TTL negative entry.
        if (policyResult.kind === 'read_through' && dataKey !== undefined) {
          await writeNegativeMarker(deps.store, dataKey, notFoundTtlMs, deps.clock, policy.maxEntryBytes, requestSignal);
        }
        throw new PublicationMetadataNotFoundError();
      case 'loader_error':
        if (result.error instanceof PublicationMetadataGoneResultError) return result.error.result;
        // Hidden results (base PublicationMetadataNotFoundError), schema and
        // database failures propagate untouched so transport semantics hold.
        throw result.error;
      case 'fallback_rejected':
        throw new CacheFallbackRejectedError('publication metadata');
    }
  };
}

/** Never trust a public metadata hit across an owner lifecycle or revision change. */
async function isCurrentPublicMetadata(
  ports: PublicationMetadataQueryPorts,
  value: PublicationMetadataResult,
): Promise<boolean> {
  if (value.kind !== 'metadata') return true;
  try {
    const collectionId = value.metadata.collection.id;
    if (ports.collectionControl === undefined) return false;
    const control = await ports.collectionControl.collectionControl(collectionId);
    if (control.hidePublic || control.restrictPublication === true) return false;
    if (ports.reads.isPublicCacheCurrent === undefined) return false;
    return await ports.reads.isPublicCacheCurrent(collectionId, value.metadata.collection.revision);
  } catch {
    // A freshness check failure must fail open to the authoritative query, not
    // serve a potentially stale private publication from Redis.
    return false;
  }
}

type OriginOutcome =
  | { readonly kind: 'metadata'; readonly result: PublicationMetadataResult }
  | { readonly kind: 'gone'; readonly result: PublicationMetadataResult }
  | { readonly kind: 'confirmed_not_found' }
  | { readonly kind: 'error'; readonly error: unknown };

/**
 * Runs the authoritative application query under the cache-abort contract and
 * discriminates the only two cache-worthy outcomes: a validated public
 * `metadata` projection and a confirmed anonymous not-found. Hidden/private
 * results, schema failures and database errors are never cached; a request
 * cancellation surfaces as CacheAbortError (never as a loader error or a
 * breaker success).
 */
async function runOriginQuery(
  ports: PublicationMetadataQueryPorts,
  input: PublicationMetadataQueryInput,
  signal: AbortSignal,
): Promise<OriginOutcome> {
  try {
    const result = await runOriginWithCacheAbort(signal, (s) => getPublicationCollectionMetadata(ports, input, s));
    if (result.kind === 'gone') return { kind: 'gone', result };
    return { kind: 'metadata', result };
  } catch (error) {
    if (error instanceof CacheAbortError) throw error;
    if (error instanceof PublicationMetadataConfirmedNotFoundError) return { kind: 'confirmed_not_found' };
    return { kind: 'error', error };
  }
}

function isNegativeMarker(value: unknown): boolean {
  return isRecord(value) && value.kind === 'not_found';
}

function isValidMetadataCacheValue(value: unknown): boolean {
  return isNegativeMarker(value) || isValidCachedMetadataProjection(value);
}

/**
 * Structural shape check for a cached public projection (plan §6.4 T06:
 * "命中返回的 value 应等价于校验后的公开投影；对 envelope value 做形状校验").
 * The nested DTO is revalidated with the same COLP registry as the origin path.
 */
function isValidCachedMetadataProjection(value: unknown): boolean {
  if (!isRecord(value) || value.kind !== 'metadata' || value.projection !== 'public') return false;
  if (typeof value.revision !== 'string' || typeof value.updatedAt !== 'string') return false;
  const metadata = value.metadata;
  if (!isRecord(metadata)) return false;
  const collection = metadata.collection;
  const links = metadata.links;
  if (!isRecord(collection) || !isRecord(links)) return false;
  return isValidPublicationCollectionMetadata(metadata)
    && typeof collection.schemaVersion === 'string'
    && typeof collection.id === 'string'
    && typeof collection.canonicalUrl === 'string'
    && typeof collection.slug === 'string'
    && typeof collection.kind === 'string'
    && typeof collection.title === 'string'
    && typeof collection.rootNodeId === 'string'
    && (collection.visibility === 'public' || collection.visibility === 'unlisted')
    && typeof collection.createdAt === 'string'
    && typeof collection.updatedAt === 'string'
    && typeof collection.revision === 'string'
    && isRecord(collection.extensions)
    && typeof links.self === 'string'
    && typeof links.canonical === 'string'
    && typeof links.snapshot === 'string'
    && collection.revision === value.revision
    && collection.updatedAt === value.updatedAt;
}

async function writeNegativeMarker(
  store: CacheStore,
  dataKey: string,
  notFoundTtlMs: number,
  clock: () => number,
  maxEntryBytes: number,
  signal: AbortSignal,
): Promise<void> {
  const now = clock();
  const hardExpiresAtMs = now + notFoundTtlMs;
  // soft == hard: the negative entry is served fresh until its hard TTL.
  await writeEnvelope(
    store,
    dataKey,
    NEGATIVE_MARKER,
    { writtenAtMs: now, softExpiresAtMs: hardExpiresAtMs, hardExpiresAtMs },
    notFoundTtlMs,
    maxEntryBytes,
    signal,
  );
}

/** Encodes and stores an envelope; a cache-unavailable write is swallowed (origin already answered). */
async function writeEnvelope(
  store: CacheStore,
  key: string,
  value: unknown,
  times: { readonly writtenAtMs: number; readonly softExpiresAtMs: number; readonly hardExpiresAtMs: number },
  hardTtlMs: number,
  maxEntryBytes: number,
  signal: AbortSignal,
): Promise<void> {
  const encoded = encodeCacheEnvelope(value, times, { maxEntryBytes });
  if (encoded.kind !== 'ok') return; // oversized/forbidden values are never written
  try {
    await store.set(key, encoded.encoded, hardTtlMs, signal);
  } catch (error) {
    if (error instanceof CacheStoreError && error.category === CACHE_ERROR_CATEGORY.UNAVAILABLE) return;
    throw error;
  }
}
