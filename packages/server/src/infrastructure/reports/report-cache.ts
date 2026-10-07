import {
  CACHE_PROJECTION, CacheKeyError, buildCacheDataKey, buildCacheEpochKey,
  normalizeCacheQuery, readThrough, type CacheFailurePolicy, type CacheKeyOptions,
  type CacheReadDependencies, type CacheReadPolicy, type CacheStore,
  CacheFallbackRejectedError, CacheSingleflight, CacheBulkhead,
  CacheStoreError, CACHE_ERROR_CATEGORY,
} from '../cache/index.js';
import {
  getPublicReportSeries, getPublicReportIssue, listPublicReportDirectory,
  type PublicReportSeries, type PublicReportIssue, type PublicReportPage,
  type ReportUnitOfWork,
  REPORT_ISSUE_KEY_MAX_LENGTH,
  REPORT_SUMMARY_MAX_LENGTH,
  REPORT_TITLE_MAX_LENGTH,
} from '../../modules/reports/index.js';
type CacheMetrics = { increment(name: string, value?: number): void };
const CACHE_SHADOW_DIGEST_MISMATCH_METRIC = 'cache.shadow.digest_mismatch';

export interface ReportCacheReader {
  readonly series: (unit: ReportUnitOfWork, slug: string, signal?: AbortSignal) => Promise<PublicReportSeries | null>;
  readonly issue: (unit: ReportUnitOfWork, slug: string, editionId: string, signal?: AbortSignal) => Promise<{ readonly series: PublicReportSeries; readonly issue: PublicReportIssue } | null>;
  readonly directory: (unit: ReportUnitOfWork, config: Parameters<typeof listPublicReportDirectory>[1], limit: number, cursor?: string, signal?: AbortSignal, language?: string | null) => Promise<PublicReportPage>;
}

export interface ReportCacheOptions {
  readonly store: CacheStore;
  readonly key: CacheKeyOptions;
  readonly policy?: CacheReadPolicy;
  readonly metadataPolicy?: CacheReadPolicy;
  readonly issuesPolicy?: CacheReadPolicy;
  readonly directoryPolicy?: CacheReadPolicy;
  readonly failurePolicy: CacheFailurePolicy;
  readonly singleflight?: CacheSingleflight;
  readonly bulkhead?: CacheBulkhead;
  readonly clock?: () => number;
  readonly metadataEnabled?: boolean;
  readonly issuesEnabled?: boolean;
  readonly directoryEnabled?: boolean;
  readonly mode?: 'shadow' | 'serve';
  readonly metrics?: CacheMetrics;
}

const defaultPolicy: CacheReadPolicy = Object.freeze({
  domain: 'reports', softTtlMs: 10_000, hardTtlMs: 30_000,
  jitterMs: 0, serveStale: false, maxEntryBytes: 524_288, lockTtlMs: 1_500, lockWaitCount: 3,
});
async function readEpoch(store: CacheStore, key: string, signal: AbortSignal): Promise<number> {
  let raw: string | null;
  try {
    raw = await store.get(key, signal);
  } catch (error) {
    // Epoch reads are part of the cache operation, not a readiness probe. Turn
    // adapter-specific failures into the shared classified error so the T05
    // breaker can fall back to PostgreSQL instead of leaking a 500.
    if (error instanceof CacheStoreError) throw error;
    if (signal.aborted) throw error;
    throw new CacheStoreError(CACHE_ERROR_CATEGORY.UNAVAILABLE, 'report cache epoch unavailable');
  }
  if (raw === null || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) return 0;
  const value = Number(raw); return Number.isSafeInteger(value) ? value : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

const PUBLIC_SERIES_REQUIRED = Object.freeze([
  'id', 'indexable', 'issues', 'slug', 'summary', 'title', 'updatedAt', 'visibility',
]);
const PUBLIC_SERIES_OPTIONAL = Object.freeze([
  'curator', 'followerCount', 'sourceCollectionSlug', 'tags', 'language',
]);
const PUBLIC_SERIES_ALLOWED = new Set([...PUBLIC_SERIES_REQUIRED, ...PUBLIC_SERIES_OPTIONAL]);

function hasPublicSeriesKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return PUBLIC_SERIES_REQUIRED.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => PUBLIC_SERIES_ALLOWED.has(key));
}

function isOptionalCatalogTags(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= 64
    && value.every((item) => typeof item === 'string' && item.length >= 1 && item.length <= 64);
}

function isOptionalCatalogLanguage(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 35);
}

function validPublicUrl(value: unknown, expectedSlug?: string, expectedIssueId?: string): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const parsed = new URL(value, 'https://know-n.com');
    const pathPattern = /^\/reports\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/issues\/([A-Za-z0-9._~-]{1,128}))?$/u;
    const match = pathPattern.exec(parsed.pathname);
    return parsed.origin === 'https://know-n.com'
      && parsed.username === '' && parsed.password === ''
      && match !== null
      && (expectedSlug === undefined || match[1] === expectedSlug)
      && (expectedIssueId === undefined || match[2] === expectedIssueId)
      && parsed.search === '' && parsed.hash === '';
  } catch { return false; }
}

function isPublicIssue(value: unknown, expectedSlug?: string): value is PublicReportIssue {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['id', 'publishedAt', 'sourceCollectionSlug', 'summary', 'title', 'url',
    'issueKey', 'editionOrdinal', 'periodStart', 'periodEnd'])) return false;
  return typeof value.id === 'string' && value.id.length >= 1 && value.id.length <= REPORT_ISSUE_KEY_MAX_LENGTH
    && typeof value.title === 'string' && value.title.length >= 1 && value.title.length <= REPORT_TITLE_MAX_LENGTH
    && (value.summary === null || (typeof value.summary === 'string' && value.summary.length <= REPORT_SUMMARY_MAX_LENGTH))
    && typeof value.publishedAt === 'string' && Number.isFinite(Date.parse(value.publishedAt))
    && validPublicUrl(value.url, expectedSlug, value.id as string)
    && typeof value.issueKey === 'string' && value.issueKey.length >= 1 && value.issueKey.length <= REPORT_ISSUE_KEY_MAX_LENGTH
    && typeof value.editionOrdinal === 'number' && Number.isSafeInteger(value.editionOrdinal) && value.editionOrdinal >= 1
    && (value.periodStart === null || (typeof value.periodStart === 'string' && Number.isFinite(Date.parse(value.periodStart))))
    && (value.periodEnd === null || (typeof value.periodEnd === 'string' && Number.isFinite(Date.parse(value.periodEnd))))
    && typeof value.sourceCollectionSlug === 'string'
    && value.sourceCollectionSlug.length >= 1 && value.sourceCollectionSlug.length <= 63
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.sourceCollectionSlug);
}

function isCurator(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['avatarUrl', 'displayName', 'handle', 'profileId'])) return false;
  return typeof value.profileId === 'string' && value.profileId.length >= 1 && value.profileId.length <= 128
    && typeof value.handle === 'string' && value.handle.length >= 1 && value.handle.length <= 64
    && typeof value.displayName === 'string' && value.displayName.length >= 1 && value.displayName.length <= 120
    && (value.avatarUrl === null || value.avatarUrl === undefined
      || (typeof value.avatarUrl === 'string' && value.avatarUrl.startsWith('https://') && value.avatarUrl.length <= 2048));
}

function isSeries(value: unknown, expectedSlug?: string): value is PublicReportSeries {
  if (!isPlainRecord(value) || !hasPublicSeriesKeys(value)) return false;
  const slug = value.slug;
  return typeof value.id === 'string' && value.id.length >= 1 && value.id.length <= 128
    && typeof value.title === 'string' && value.title.length >= 1 && value.title.length <= REPORT_TITLE_MAX_LENGTH
    && (value.summary === null || (typeof value.summary === 'string' && value.summary.length <= REPORT_SUMMARY_MAX_LENGTH))
    && typeof slug === 'string' && slug.length >= 3 && slug.length <= 63
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)
    && (expectedSlug === undefined || slug === expectedSlug)
    && (value.visibility === 'public' || value.visibility === 'unlisted')
    && typeof value.indexable === 'boolean'
    && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
    && (value.curator === undefined || isCurator(value.curator))
    && (value.followerCount === undefined
      || (typeof value.followerCount === 'number' && Number.isSafeInteger(value.followerCount) && value.followerCount >= 0))
    && (value.sourceCollectionSlug === undefined
      || (typeof value.sourceCollectionSlug === 'string'
        && value.sourceCollectionSlug.length >= 1 && value.sourceCollectionSlug.length <= 63
        && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.sourceCollectionSlug)))
    && (value.tags === undefined || isOptionalCatalogTags(value.tags))
    && (value.language === undefined || isOptionalCatalogLanguage(value.language))
    && Array.isArray(value.issues) && value.issues.length <= 100
    && value.issues.every((issue) => isPublicIssue(issue, slug));
}
function isIssueResult(
  value: unknown,
  expectedEditionId?: string,
): value is { readonly series: PublicReportSeries; readonly issue: PublicReportIssue } {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['issue', 'series'])) return false;
  return isSeries(value.series)
    && isPublicIssue(value.issue, value.series.slug)
    && (expectedEditionId === undefined || value.issue.id === expectedEditionId);
}
function isDirectory(value: unknown, expectedLimit?: number): value is PublicReportPage {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['items', 'nextCursor'])) return false;
  return Array.isArray(value.items) && value.items.length <= 100
    && (expectedLimit === undefined || value.items.length <= expectedLimit)
    && value.items.every((item) => isSeries(item))
    && (value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length <= 2_048));
}

/** Anonymous-only report read cache. Authenticated callers never enter this API. */
export function createReportCache(options: ReportCacheOptions): ReportCacheReader {
  const policy = options.policy ?? defaultPolicy;
  const policies = { metadata: options.metadataPolicy ?? policy, issues: options.issuesPolicy ?? policy, directory: options.directoryPolicy ?? policy };
  const clock = options.clock ?? Date.now;
  const singleflight = options.singleflight ?? new CacheSingleflight();
  const bulkhead = options.bulkhead ?? new CacheBulkhead(8);
  const makeDeps = (loader: (signal: AbortSignal) => Promise<unknown | null>, validate: (value: unknown) => boolean): CacheReadDependencies => ({
    store: options.store, loader, clock, singleflight, bulkhead, validateCachedValue: validate,
  });
  async function read<T>(domain: Parameters<typeof buildCacheEpochKey>[0]['domain'], projection: string, query: Record<string, unknown>, loader: () => Promise<T | null>, validate: (value: unknown) => boolean, signal: AbortSignal, readPolicy: CacheReadPolicy): Promise<T | null> {
    const normalized = normalizeCacheQuery(query);
    if (normalized.kind !== 'ok') return loader();
    try {
      const result = await options.failurePolicy.readOperationWithPolicy<T | null>(
        readPolicy,
        makeDeps(loader, validate),
        signal,
        async () => {
          // Keep the epoch read inside the same breaker/bulkhead operation as
          // the data read. A Redis outage during epoch lookup must have exactly
          // the same bounded origin fallback semantics as a data-key outage.
          const epochKey = buildCacheEpochKey({ ...options.key, domain });
          const epoch = await readEpoch(options.store, epochKey, signal);
          const dataKey = buildCacheDataKey({
            ...options.key,
            domain,
            projection,
            epoch,
            query: normalized.query,
          });
          return readThrough<T | null>(
            dataKey,
            readPolicy,
            makeDeps(loader, validate),
            signal,
          );
        },
      );
      if (result.result.kind === 'cache_hit' || result.result.kind === 'stale_hit' || result.result.kind === 'origin') return result.result.value;
      if (result.result.kind === 'not_found') return null;
      if (result.result.kind === 'loader_error') throw result.result.error;
      throw new CacheFallbackRejectedError('reports');
    } catch (error) {
      if (error instanceof CacheKeyError) return loader();
      throw error;
    }
  }
  const shadow = options.mode === 'shadow';
  async function shadowRead<T>(cached: Promise<T | null>, origin: () => Promise<T | null>): Promise<T | null> {
    let cachedValue: T | null | undefined;
    try { cachedValue = await cached; } catch { cachedValue = undefined; }
    const authoritative = await origin();
    if (cachedValue !== undefined && stableDigest(cachedValue) !== stableDigest(authoritative)) options.metrics?.increment(CACHE_SHADOW_DIGEST_MISMATCH_METRIC);
    return authoritative;
  }
  return {
    series: (unit, slug, signal = new AbortController().signal) => {
      const origin = () => getPublicReportSeries(unit, slug);
      if (options.metadataEnabled === false) return origin();
      const cached = read(
        { kind: 'report', slug }, CACHE_PROJECTION.REPORT, { slug }, origin,
        (value) => isSeries(value, slug), signal, policies.metadata,
      );
      return shadow ? shadowRead(cached, origin) : cached;
    },
    issue: (unit, slug, editionId, signal = new AbortController().signal) => {
      const origin = () => getPublicReportIssue(unit, slug, editionId);
      if (options.issuesEnabled === false) return origin();
      const cached = read(
        { kind: 'report', slug },
        CACHE_PROJECTION.REPORT_ISSUES,
        { slug, editionId },
        origin,
        (value) => isIssueResult(value, editionId),
        signal,
        policies.issues,
      );
      return shadow ? shadowRead(cached, origin) : cached;
    },
    directory: (unit, config, limit, cursor, signal = new AbortController().signal, language) => {
      if (cursor !== undefined || options.directoryEnabled === false) {
        return listPublicReportDirectory(unit, config, limit, cursor, language);
      }
      const origin = () => listPublicReportDirectory(unit, config, limit, undefined, language);
      const cached = read(
        { kind: 'report-directory' },
        CACHE_PROJECTION.REPORT_DIRECTORY,
        { limit, language: language ?? null },
        origin,
        (value) => isDirectory(value, limit),
        signal,
        policies.directory,
      ) as Promise<PublicReportPage>;
      return (shadow ? shadowRead(cached, origin) : cached) as Promise<PublicReportPage>;
    },
  };
}

function stableDigest(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableDigest).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableDigest((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
