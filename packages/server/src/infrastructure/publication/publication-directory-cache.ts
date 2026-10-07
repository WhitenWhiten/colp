/**
 * T07 anonymous-public Directory first-page query cache decorator (plan §6.4
 * T07 / §3.1 / §4.2 / §4.3).
 *
 * Placement: `infrastructure/publication` wraps the Application query output
 * (`getPublicationDirectoryPage`), never the raw `PublicationDirectoryReadPort`
 * rows (those carry owner/membership/visibility internals and are unvalidated).
 *
 * Behaviour:
 * - Only the anonymous *default first page* is cached: principal anonymous, no
 *   filter fields (tag/creator/kind/updatedSince/q), no cursor and a limit that
 *   normalizes to the current default (an explicit default limit is included).
 *   Authenticated member reads, filtered queries and continuation pages bypass
 *   the cache completely (zero cache commands) and keep the authoritative
 *   application path.
 * - The default-query decision is delegated to the exact application parser
 *   (`normalizePublicationDirectoryQuery`), so a configured maxPageSize that
 *   shrinks the default limit is honored and an invalid query always keeps the
 *   origin's error with zero cache commands.
 * - Canonical query hash: the normalized `filter + limit` shape hashed by the
 *   T02 codec (`normalizeCacheQuery` + `buildCacheDataKey`). Directory is one
 *   global scope (`{publication-directory}`) shared by every collection; the
 *   data key embeds the global Directory epoch so T09's rotation makes old
 *   first pages unreachable. No unbounded Set / KEYS / SCAN is used.
 * - The origin loader returns only values that already passed the Directory
 *   COLP schema, sort and cursor validation. The cached value is exactly the
 *   validated public projection: `{ projection: 'public', directory, nextCursor }`.
 *   `nextCursor` is never regenerated, re-sorted or extended on a hit; body,
 *   order, total and cursor stay equivalent to the reference path.
 * - Cached values are never trusted after decode: every hit is shape-validated;
 *   a bad envelope/shape is treated as a miss, re-loaded from origin and
 *   healed. `serveStale` is forced to false and cannot be overridden.
 * - CacheKeyError and cache_unavailable epoch reads fail open to the
 *   authoritative origin path.
 */
import {
  getPublicationDirectoryPage,
  isValidPublicationCollectionDirectory,
  normalizePublicationDirectoryQuery,
  PUBLICATION_DIRECTORY_DEFAULT_LIMIT,
  PUBLICATION_DIRECTORY_MAX_LIMIT,
  type PublicationDirectoryPageResult,
  type PublicationDirectoryQueryInput,
  type PublicationDirectoryQueryPorts,
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
export type PublicationDirectoryCacheDeps = Omit<CacheReadDependencies, 'loader'> & {
  readonly failurePolicy: CacheFailurePolicy;
  /** Optional metrics sink for the low-cardinality epoch-corruption counter. */
  readonly metrics?: Metrics;
};

export interface PublicationDirectoryCacheOptions {
  /** Domain read policy (soft/hard TTLs, budgets); `serveStale` is always forced false. */
  readonly policy: CacheReadPolicy;
  readonly deps: PublicationDirectoryCacheDeps;
  /** Redis key namespace (`environment` + optional `keyPrefix`). */
  readonly key: CacheKeyOptions;
}

/**
 * Same call surface as `getPublicationDirectoryPage` so T10 can substitute the
 * cached reader for `dependencies.query` without changing the transport.
 * `signal` defaults to a never-aborted controller when the caller has none.
 */
export type PublicationDirectoryCacheReader = (
  ports: PublicationDirectoryQueryPorts,
  input: PublicationDirectoryQueryInput,
  signal?: AbortSignal,
) => Promise<PublicationDirectoryPageResult>;

export function createPublicationDirectoryCache(
  options: PublicationDirectoryCacheOptions,
): PublicationDirectoryCacheReader {
  const { deps, policy } = options;
  const keyOptions = options.key;

  return async (ports, input, signal): Promise<PublicationDirectoryPageResult> => {
    const requestSignal = signal ?? new AbortController().signal;

    // Only the anonymous default first page is cached. Member reads, filtered
    // queries and continuations bypass with zero cache commands.
    if (!isDefaultFirstPageQuery(ports, input)) {
      return getPublicationDirectoryPage(ports, input, requestSignal);
    }

    const limit = defaultDirectoryLimit(ports);
    const query = normalizeCacheQuery({ limit });
    if (query.kind !== 'ok') {
      return getPublicationDirectoryPage(ports, input, requestSignal); // defensive fail-open
    }
    const domain = { kind: 'publication-directory' as const };

    let epochKey: string;
    try {
      epochKey = buildCacheEpochKey({ ...keyOptions, domain });
    } catch (error) {
      if (error instanceof CacheKeyError) {
        // Unkeyable query: never let a key-build error break reads.
        return getPublicationDirectoryPage(ports, input, requestSignal);
      }
      throw error;
    }

    const loader = async (loadSignal: AbortSignal): Promise<unknown | null> => {
      const result = await runOriginWithCacheAbort(
        loadSignal,
        (s) => getPublicationDirectoryPage(ports, input, s),
      );
      // Only the validated public projection is cacheable. Member projections
      // cannot reach this path (the guard requires anonymous), but a defensive
      // rejection keeps authority facts out of the anonymous value.
      if (result.projection !== 'public') {
        throw new Error('publication directory member projection is not cacheable');
      }
      return { projection: 'public', directory: result.directory, nextCursor: result.nextCursor };
    };

    const readPolicy = { ...policy, serveStale: false } as const;
    const readDeps: CacheReadDependencies = {
      ...deps,
      loader,
      validateCachedValue: (value) => isValidCachedDirectoryProjection(value, limit),
    };
    let policyResult;
    try {
      policyResult = await deps.failurePolicy.readOperationWithPolicy<PublicationDirectoryPageResult>(
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
            projection: CACHE_PROJECTION.PUBLICATION_DIRECTORY_PAGE,
            epoch,
            query: query.query,
          });
          return readThrough<PublicationDirectoryPageResult>(dataKey, readPolicy, readDeps, requestSignal);
        },
      );
    } catch (error) {
      if (error instanceof CacheKeyError) return getPublicationDirectoryPage(ports, input, requestSignal);
      throw error;
    }
    const result = policyResult.result;

    switch (result.kind) {
      case 'cache_hit':
      case 'stale_hit': {
        // serveStale is forced false, so stale_hit is defensive only.
        return result.value;
      }
      case 'origin':
        // The loader only ever returns a validated public first-page projection.
        return result.value;
      case 'not_found':
        // The Directory origin always produces a page (possibly empty), so a
        // not-found is an internal contract violation, never a negative cache.
        throw new Error('publication directory origin returned no page');
      case 'loader_error':
        throw result.error;
      case 'fallback_rejected':
        throw new CacheFallbackRejectedError('publication directory');
    }
  };
}

/**
 * Cache guard for the only cacheable Directory shape: anonymous principal, no
 * filter fields, no cursor and the current default first-page limit. Uses the
 * exact application parser so invalid queries and a configured maxPageSize
 * that shrinks the default limit follow normalizeQuery's real result.
 */
function isDefaultFirstPageQuery(
  ports: PublicationDirectoryQueryPorts,
  input: PublicationDirectoryQueryInput,
): boolean {
  if (input.principal.kind !== 'anonymous') return false;
  const configuredMax = ports.maxPageSize ?? PUBLICATION_DIRECTORY_MAX_LIMIT;
  let normalized: ReturnType<typeof normalizePublicationDirectoryQuery>;
  try {
    normalized = normalizePublicationDirectoryQuery(input.query, configuredMax);
  } catch {
    // Invalid queries are never cached: delegate to origin, which raises the
    // same error, with zero cache commands.
    return false;
  }
  return Object.keys(normalized.filter).length === 0
    && normalized.cursor === undefined
    && normalized.limit === Math.min(
      PUBLICATION_DIRECTORY_DEFAULT_LIMIT,
      Math.min(PUBLICATION_DIRECTORY_MAX_LIMIT, configuredMax),
    );
}

/** The normalized default limit for this deployment's configured maxPageSize. */
function defaultDirectoryLimit(ports: PublicationDirectoryQueryPorts): number {
  return Math.min(
    PUBLICATION_DIRECTORY_DEFAULT_LIMIT,
    Math.min(PUBLICATION_DIRECTORY_MAX_LIMIT, ports.maxPageSize ?? PUBLICATION_DIRECTORY_MAX_LIMIT),
  );
}

const DIRECTORY_KINDS = new Set(['bookmarks', 'reading_path', 'knowledge_collection', 'mixed']);
const DIRECTORY_VALUE_KEYS = new Set(['projection', 'directory', 'nextCursor']);
const DIRECTORY_KEYS = new Set(['protocolVersion', 'collections', 'nextCursor']);
const DIRECTORY_COLLECTION_KEYS = new Set([
  'id', 'canonicalUrl', 'title', 'summary', 'kind', 'tags', 'language',
  'nodeCount', 'updatedAt', 'visibility', 'links', 'extensions',
]);
const DIRECTORY_LINKS_KEYS = new Set(['self', 'canonical', 'snapshot']);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Structural shape check for a cached public Directory first page (plan §6.4
 * T07). The nested DTO is revalidated with the same COLP registry as the
 * authoritative query before the value can be returned.
 */
function isValidCachedDirectoryProjection(value: unknown, maxCollections: number): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, DIRECTORY_VALUE_KEYS) || value.projection !== 'public') return false;
  if (value.nextCursor !== null && typeof value.nextCursor !== 'string') return false;
  const directory = value.directory;
  if (!isRecord(directory) || !hasOnlyKeys(directory, DIRECTORY_KEYS)) return false;
  if (!isValidPublicationCollectionDirectory(directory)) return false;
  if (directory.protocolVersion !== '0.1' || directory.nextCursor !== value.nextCursor) return false;
  const collections = directory.collections;
  if (!Array.isArray(collections) || collections.length > maxCollections) return false;
  return collections.every((item) => isValidDirectoryCollection(item));
}

function isValidDirectoryCollection(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, DIRECTORY_COLLECTION_KEYS)) return false;
  if (typeof value.id !== 'string'
    || typeof value.canonicalUrl !== 'string'
    || typeof value.title !== 'string'
    || typeof value.kind !== 'string' || !DIRECTORY_KINDS.has(value.kind)
    || typeof value.nodeCount !== 'number' || !Number.isSafeInteger(value.nodeCount) || value.nodeCount < 0
    || typeof value.updatedAt !== 'string'
    || value.visibility !== 'public') {
    return false;
  }
  if (value.summary !== undefined && typeof value.summary !== 'string') return false;
  if (value.language !== undefined && typeof value.language !== 'string') return false;
  if (value.tags !== undefined && (
    !Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string')
  )) return false;
  const links = value.links;
  if (!isRecord(links) || !hasOnlyKeys(links, DIRECTORY_LINKS_KEYS)
    || typeof links.self !== 'string' || typeof links.canonical !== 'string' || typeof links.snapshot !== 'string') {
    return false;
  }
  const extensions = value.extensions;
  // The anonymous wire projection emits only the empty extension container, so
  // any cached extension content is not origin-equivalent and is healed.
  if (!isRecord(extensions) || Object.keys(extensions).length !== 0) return false;
  return true;
}
