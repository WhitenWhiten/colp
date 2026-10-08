import { assertRedisUrlScheme } from './config-parse-helpers.js';
import type { CacheMode } from './config-types.js';

/**
 * Shared limiter Redis URL keys. Specific values win; otherwise LIMITER_REDIS_URL.
 * Distinct prefixes stay independent — only the instance (host:port) is shared.
 */
export const LIMITER_REDIS_URL_KEYS = Object.freeze([
  'AUTH_RATE_LIMIT_REDIS_URL',
  'SEARCH_RATE_LIMIT_REDIS_URL',
  'MCP_RATE_LIMIT_REDIS_URL',
  'EMAIL_CALLBACK_RATE_LIMIT_REDIS_URL',
  'PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL',
  'COLLABORATION_INVITE_RATE_LIMIT_REDIS_URL',
  'EXPLORE_DIRECTORY_RATE_LIMIT_REDIS_URL',
  'SYNC_RATE_LIMIT_REDIS_URL',
  'FOLLOW_RATE_LIMIT_REDIS_URL',
  'COLLECTION_FOLLOW_RATE_LIMIT_REDIS_URL',
  'FEED_RATE_LIMIT_REDIS_URL',
  'NOTIFICATION_RATE_LIMIT_REDIS_URL',
  'SYNC_EFFECT_PAGE_RATE_LIMIT_REDIS_URL',
  'PUBLIC_ACTIVITY_RATE_LIMIT_REDIS_URL',
  'PRODUCT_ROUTE_RATE_LIMIT_REDIS_URL',
  'ATTACHMENTS_RATE_LIMIT_REDIS_URL',
]);

/** Named limiter purposes that share one noeviction instance. */
export const LIMITER_PURPOSE_COUNT = LIMITER_REDIS_URL_KEYS.length;
/** Conservative Redis key + allocator overhead for a hashed counter. */
export const LIMITER_BYTES_PER_KEY = 128;
/** Current window plus the previous window (fixed-window rollover). */
export const LIMITER_WINDOWS_RETAINED = 2;
export const LIMITER_MEMORY_HEADROOM_NUMERATOR = 5;
export const LIMITER_MEMORY_HEADROOM_DENOMINATOR = 2;
/** Local compose default: small-host peak subjects, not a guessed 64 MiB. */
export const DEFAULT_LIMITER_PEAK_SUBJECTS = 4_000;
/** 10C8G production starting peak; raise LIMITER_PEAK_SUBJECTS with traffic. */
export const PRODUCTION_LIMITER_PEAK_SUBJECTS = 20_000;

export function redisInstanceFingerprint(url: string): string {
  const parsed = new URL(url);
  const host = (parsed.hostname ?? '').toLowerCase();
  const port = parsed.port || (parsed.protocol === 'rediss:' ? '6380' : '6379');
  return `${host}:${port}`;
}

export function estimateLimiterMaxmemoryBytes(peakSubjects: number): number {
  if (!Number.isInteger(peakSubjects) || peakSubjects < 1) {
    throw new Error('LIMITER_PEAK_SUBJECTS must be a positive integer');
  }
  const raw = LIMITER_PURPOSE_COUNT * peakSubjects * LIMITER_WINDOWS_RETAINED * LIMITER_BYTES_PER_KEY;
  return Math.ceil((raw * LIMITER_MEMORY_HEADROOM_NUMERATOR) / LIMITER_MEMORY_HEADROOM_DENOMINATOR);
}

export function formatRedisMaxmemory(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))}mb`;
}

export function resolveCacheRedisUrl(env: NodeJS.ProcessEnv): {
  readonly url: string | null;
  readonly label: 'CACHE_REDIS_URL' | 'REDIS_URL';
} {
  const cache = env.CACHE_REDIS_URL?.trim() ?? '';
  const alias = env.REDIS_URL?.trim() ?? '';
  if (cache !== '' && alias !== '') {
    const cacheUrl = assertRedisUrlScheme(cache, 'CACHE_REDIS_URL');
    const aliasUrl = assertRedisUrlScheme(alias, 'REDIS_URL');
    if (redisInstanceFingerprint(cacheUrl) !== redisInstanceFingerprint(aliasUrl)) {
      throw new Error('CACHE_REDIS_URL and REDIS_URL must name the same cache instance');
    }
    return { url: cacheUrl, label: 'CACHE_REDIS_URL' };
  }
  if (cache !== '') {
    return { url: assertRedisUrlScheme(cache, 'CACHE_REDIS_URL'), label: 'CACHE_REDIS_URL' };
  }
  if (alias !== '') {
    return { url: assertRedisUrlScheme(alias, 'REDIS_URL'), label: 'REDIS_URL' };
  }
  return { url: null, label: 'CACHE_REDIS_URL' };
}

export function resolveLimiterRedisUrl(
  env: NodeJS.ProcessEnv,
  specificKey: string,
  options: {
    readonly enabled: boolean;
    readonly requiredMessage: string;
    readonly allowSearchFallback?: boolean;
  },
): string | null {
  const specific = env[specificKey]?.trim() ?? '';
  if (specific !== '') {
    return assertRedisUrlScheme(specific, specificKey);
  }
  if (!options.enabled) {
    return null;
  }
  const shared = env.LIMITER_REDIS_URL?.trim() ?? '';
  if (shared !== '') {
    return assertRedisUrlScheme(shared, 'LIMITER_REDIS_URL');
  }
  if (options.allowSearchFallback === true) {
    const searchUrl = env.SEARCH_RATE_LIMIT_REDIS_URL?.trim() ?? '';
    if (searchUrl !== '') {
      return assertRedisUrlScheme(searchUrl, 'SEARCH_RATE_LIMIT_REDIS_URL');
    }
  }
  throw new Error(options.requiredMessage);
}

export function collectConfiguredLimiterRedisUrls(env: NodeJS.ProcessEnv): readonly string[] {
  const urls: string[] = [];
  const shared = env.LIMITER_REDIS_URL?.trim() ?? '';
  if (shared !== '') {
    urls.push(assertRedisUrlScheme(shared, 'LIMITER_REDIS_URL'));
  }
  for (const key of LIMITER_REDIS_URL_KEYS) {
    const raw = env[key]?.trim() ?? '';
    if (raw !== '') {
      urls.push(assertRedisUrlScheme(raw, key));
    }
  }
  return Object.freeze(urls);
}

export function assertDistinctRedisRoles(env: NodeJS.ProcessEnv, cacheMode: CacheMode): void {
  const cache = resolveCacheRedisUrl(env);
  if (cache.url === null) {
    return;
  }
  const limiterUrls = collectConfiguredLimiterRedisUrls(env);
  if (limiterUrls.length === 0) {
    return;
  }
  const cacheFingerprint = redisInstanceFingerprint(cache.url);
  for (const limiterUrl of limiterUrls) {
    if (redisInstanceFingerprint(limiterUrl) === cacheFingerprint) {
      throw new Error(
        cacheMode === 'off'
          ? 'CACHE_REDIS_URL/REDIS_URL and limiter Redis must use distinct instances'
          : 'Cache Redis and limiter Redis must use distinct instances',
      );
    }
  }
}
