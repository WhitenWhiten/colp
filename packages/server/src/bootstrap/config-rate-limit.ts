import {
  parseCacheBooleanEnv,
  parsePositiveInt,
} from './config-parse-helpers.js';
import { resolveLimiterRedisUrl } from './config-redis-roles.js';
import type {
  CollaborationInviteCleanupConfig,
  CollaborationInviteRateLimitSharedConfig,
  EmailCallbackRateLimitSharedConfig,
  ExploreDirectoryRateLimitSharedConfig,
  McpRateLimitSharedConfig,
  PublishingInsightsRateLimitSharedConfig,
  RedisRateLimitFamilySharedConfig,
  SyncColpRateLimitSharedConfig,
} from './config-types.js';

const DEFAULT_COLLABORATION_INVITE_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_COLLABORATION_INVITE_CLEANUP_BATCH_SIZE = 5_000;
/** Documented single-process development pepper; production must not use this. */
const DEV_COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET = 'dev-collaboration-invite-rate-limit-hmac-key';


export function loadMcpRateLimitSharedConfig(env: NodeJS.ProcessEnv): McpRateLimitSharedConfig {
  const enabled = parseCacheBooleanEnv(env, 'MCP_RATE_LIMIT_SHARED', false);
  const redisUrl = resolveLimiterRedisUrl(env, 'MCP_RATE_LIMIT_REDIS_URL', {
    enabled,
    requiredMessage: 'MCP_RATE_LIMIT_REDIS_URL is required when MCP_RATE_LIMIT_SHARED=true',
  });
  const rawSecret = env.MCP_RATE_LIMIT_KEY_SECRET?.trim() ?? '';
  let keySecret: Buffer | null = null;
  if (rawSecret !== '') {
    if (rawSecret.length < 16 || rawSecret.length > 512) {
      throw new Error('MCP_RATE_LIMIT_KEY_SECRET must be 16-512 characters');
    }
    keySecret = Buffer.from(rawSecret, 'utf8');
  } else if (enabled) {
    throw new Error('MCP_RATE_LIMIT_KEY_SECRET is required when MCP_RATE_LIMIT_SHARED=true');
  }
  const keyPrefix = (env.MCP_RATE_LIMIT_KEY_PREFIX ?? 'known').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(keyPrefix)) {
    throw new Error(
      'MCP_RATE_LIMIT_KEY_PREFIX must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  const commandTimeoutMs = parsePositiveInt(
    env.MCP_RATE_LIMIT_COMMAND_TIMEOUT_MS,
    75,
    'MCP_RATE_LIMIT_COMMAND_TIMEOUT_MS',
    { max: 5_000 },
  );
  const connectTimeoutMs = parsePositiveInt(
    env.MCP_RATE_LIMIT_CONNECT_TIMEOUT_MS,
    1_000,
    'MCP_RATE_LIMIT_CONNECT_TIMEOUT_MS',
    { max: 30_000 },
  );
  const maxRetriesPerRequest = parsePositiveInt(
    env.MCP_RATE_LIMIT_MAX_RETRIES_PER_REQUEST,
    1,
    'MCP_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
    { min: 0, max: 10 },
  );
  return Object.freeze({
    enabled,
    redisUrl,
    keySecret,
    keyPrefix,
    commandTimeoutMs,
    connectTimeoutMs,
    maxRetriesPerRequest,
  });
}

/**
 * FIX-L-061 email callback shared Redis limiter config (mirrors the MCP
 * shared loader with the EMAIL_CALLBACK_RATE_LIMIT_* variable family).
 * Defaults to disabled (zero Redis connections); `=true` requires the URL
 * and key secret (fail closed, exactly like MCP).
 */
export function loadEmailCallbackRateLimitSharedConfig(env: NodeJS.ProcessEnv): EmailCallbackRateLimitSharedConfig {
  const enabled = parseCacheBooleanEnv(env, 'EMAIL_CALLBACK_RATE_LIMIT_SHARED', false);
  const redisUrl = resolveLimiterRedisUrl(env, 'EMAIL_CALLBACK_RATE_LIMIT_REDIS_URL', {
    enabled,
    requiredMessage:
      'EMAIL_CALLBACK_RATE_LIMIT_REDIS_URL is required when EMAIL_CALLBACK_RATE_LIMIT_SHARED=true',
  });
  const rawSecret = env.EMAIL_CALLBACK_RATE_LIMIT_KEY_SECRET?.trim() ?? '';
  let keySecret: Buffer | null = null;
  if (rawSecret !== '') {
    if (rawSecret.length < 16 || rawSecret.length > 512) {
      throw new Error('EMAIL_CALLBACK_RATE_LIMIT_KEY_SECRET must be 16-512 characters');
    }
    keySecret = Buffer.from(rawSecret, 'utf8');
  } else if (enabled) {
    throw new Error('EMAIL_CALLBACK_RATE_LIMIT_KEY_SECRET is required when EMAIL_CALLBACK_RATE_LIMIT_SHARED=true');
  }
  const keyPrefix = (env.EMAIL_CALLBACK_RATE_LIMIT_KEY_PREFIX ?? 'known').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(keyPrefix)) {
    throw new Error(
      'EMAIL_CALLBACK_RATE_LIMIT_KEY_PREFIX must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  const commandTimeoutMs = parsePositiveInt(
    env.EMAIL_CALLBACK_RATE_LIMIT_COMMAND_TIMEOUT_MS,
    75,
    'EMAIL_CALLBACK_RATE_LIMIT_COMMAND_TIMEOUT_MS',
    { max: 5_000 },
  );
  const connectTimeoutMs = parsePositiveInt(
    env.EMAIL_CALLBACK_RATE_LIMIT_CONNECT_TIMEOUT_MS,
    1_000,
    'EMAIL_CALLBACK_RATE_LIMIT_CONNECT_TIMEOUT_MS',
    { max: 30_000 },
  );
  const maxRetriesPerRequest = parsePositiveInt(
    env.EMAIL_CALLBACK_RATE_LIMIT_MAX_RETRIES_PER_REQUEST,
    1,
    'EMAIL_CALLBACK_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
    { min: 0, max: 10 },
  );
  return Object.freeze({
    enabled,
    redisUrl,
    keySecret,
    keyPrefix,
    commandTimeoutMs,
    connectTimeoutMs,
    maxRetriesPerRequest,
  });
}

/**
 * S-02 shared Redis limiter for Publishing Insights ingest. Mirrors
 * SEARCH_RATE_LIMIT_SHARED (URL, prefix, timeouts). Pepper is always
 * PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY — this loader does not accept a
 * third production secret. Redis URL may reuse SEARCH_RATE_LIMIT_REDIS_URL.
 */
export function loadPublishingInsightsRateLimitSharedConfig(
  env: NodeJS.ProcessEnv,
): PublishingInsightsRateLimitSharedConfig {
  const enabled = parseCacheBooleanEnv(env, 'PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED', false);
  const redisUrl = resolveLimiterRedisUrl(env, 'PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL', {
    enabled,
    allowSearchFallback: true,
    requiredMessage:
      'PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL is required when PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED=true',
  });
  const keyPrefix = (env.PUBLISHING_INSIGHTS_RATE_LIMIT_KEY_PREFIX ?? 'known').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(keyPrefix)) {
    throw new Error(
      'PUBLISHING_INSIGHTS_RATE_LIMIT_KEY_PREFIX must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  const commandTimeoutMs = parsePositiveInt(
    env.PUBLISHING_INSIGHTS_RATE_LIMIT_COMMAND_TIMEOUT_MS,
    75,
    'PUBLISHING_INSIGHTS_RATE_LIMIT_COMMAND_TIMEOUT_MS',
    { max: 5_000 },
  );
  const connectTimeoutMs = parsePositiveInt(
    env.PUBLISHING_INSIGHTS_RATE_LIMIT_CONNECT_TIMEOUT_MS,
    1_000,
    'PUBLISHING_INSIGHTS_RATE_LIMIT_CONNECT_TIMEOUT_MS',
    { max: 30_000 },
  );
  const maxRetriesPerRequest = parsePositiveInt(
    env.PUBLISHING_INSIGHTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST,
    1,
    'PUBLISHING_INSIGHTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
    { min: 0, max: 10 },
  );
  return Object.freeze({
    enabled,
    redisUrl,
    keyPrefix,
    commandTimeoutMs,
    connectTimeoutMs,
    maxRetriesPerRequest,
  });
}

/**
 * S-04 shared Redis limiter for collaboration invites. Mirrors
 * SEARCH_RATE_LIMIT_SHARED (URL, prefix, timeouts) with an independent
 * HMAC pepper. Redis URL may reuse SEARCH_RATE_LIMIT_REDIS_URL.
 *
 * The HMAC pepper is required whenever the invite limiter is composed:
 * production never mints a per-process key, shared Redis never does either,
 * and non-production single-process uses a documented development default.
 */
export function loadCollaborationInviteRateLimitSharedConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): CollaborationInviteRateLimitSharedConfig {
  const enabled = parseCacheBooleanEnv(env, 'COLLABORATION_INVITE_RATE_LIMIT_SHARED', false);
  const redisUrl = resolveLimiterRedisUrl(env, 'COLLABORATION_INVITE_RATE_LIMIT_REDIS_URL', {
    enabled,
    allowSearchFallback: true,
    requiredMessage:
      'COLLABORATION_INVITE_RATE_LIMIT_REDIS_URL is required when COLLABORATION_INVITE_RATE_LIMIT_SHARED=true',
  });
  const rawSecret = env.COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET?.trim() ?? '';
  let keySecret: Buffer;
  if (rawSecret !== '') {
    if (rawSecret.length < 16 || rawSecret.length > 512) {
      throw new Error('COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET must be 16-512 characters');
    }
    if (nodeEnv === 'production' && rawSecret === DEV_COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET) {
      throw new Error(
        'COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET must not use the development default in production',
      );
    }
    keySecret = Buffer.from(rawSecret, 'utf8');
  } else if (enabled) {
    throw new Error(
      'COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET is required when COLLABORATION_INVITE_RATE_LIMIT_SHARED=true',
    );
  } else if (nodeEnv === 'production') {
    throw new Error('COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET is required');
  } else {
    keySecret = Buffer.from(DEV_COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET, 'utf8');
  }
  const keyPrefix = (env.COLLABORATION_INVITE_RATE_LIMIT_KEY_PREFIX ?? 'known').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(keyPrefix)) {
    throw new Error(
      'COLLABORATION_INVITE_RATE_LIMIT_KEY_PREFIX must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  const commandTimeoutMs = parsePositiveInt(
    env.COLLABORATION_INVITE_RATE_LIMIT_COMMAND_TIMEOUT_MS,
    75,
    'COLLABORATION_INVITE_RATE_LIMIT_COMMAND_TIMEOUT_MS',
    { max: 5_000 },
  );
  const connectTimeoutMs = parsePositiveInt(
    env.COLLABORATION_INVITE_RATE_LIMIT_CONNECT_TIMEOUT_MS,
    1_000,
    'COLLABORATION_INVITE_RATE_LIMIT_CONNECT_TIMEOUT_MS',
    { max: 30_000 },
  );
  const maxRetriesPerRequest = parsePositiveInt(
    env.COLLABORATION_INVITE_RATE_LIMIT_MAX_RETRIES_PER_REQUEST,
    1,
    'COLLABORATION_INVITE_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
    { min: 0, max: 10 },
  );
  return Object.freeze({
    enabled,
    redisUrl,
    keySecret,
    keyPrefix,
    commandTimeoutMs,
    connectTimeoutMs,
    maxRetriesPerRequest,
  });
}

/**
 * P-04 shared Redis limiter for Explore and COLP Directory. Mirrors
 * SEARCH_RATE_LIMIT_SHARED (URL, prefix, timeouts) with an independent
 * HMAC pepper and a distinct default prefix (`known-explore`). Redis URL
 * may reuse SEARCH_RATE_LIMIT_REDIS_URL.
 */
export function loadExploreDirectoryRateLimitSharedConfig(
  env: NodeJS.ProcessEnv,
): ExploreDirectoryRateLimitSharedConfig {
  const enabled = parseCacheBooleanEnv(env, 'EXPLORE_DIRECTORY_RATE_LIMIT_SHARED', false);
  const redisUrl = resolveLimiterRedisUrl(env, 'EXPLORE_DIRECTORY_RATE_LIMIT_REDIS_URL', {
    enabled,
    allowSearchFallback: true,
    requiredMessage:
      'EXPLORE_DIRECTORY_RATE_LIMIT_REDIS_URL is required when EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true',
  });
  const rawSecret = env.EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET?.trim() ?? '';
  let keySecret: Buffer | null = null;
  if (rawSecret !== '') {
    if (rawSecret.length < 16 || rawSecret.length > 512) {
      throw new Error('EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET must be 16-512 characters');
    }
    keySecret = Buffer.from(rawSecret, 'utf8');
  } else if (enabled) {
    throw new Error(
      'EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET is required when EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true',
    );
  }
  const keyPrefix = (env.EXPLORE_DIRECTORY_RATE_LIMIT_KEY_PREFIX ?? 'known-explore').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(keyPrefix)) {
    throw new Error(
      'EXPLORE_DIRECTORY_RATE_LIMIT_KEY_PREFIX must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  const searchPrefix = (env.SEARCH_RATE_LIMIT_KEY_PREFIX ?? 'known').trim();
  if (keyPrefix === searchPrefix) {
    throw new Error(
      'EXPLORE_DIRECTORY_RATE_LIMIT_KEY_PREFIX must be independent from SEARCH_RATE_LIMIT_KEY_PREFIX',
    );
  }
  const commandTimeoutMs = parsePositiveInt(
    env.EXPLORE_DIRECTORY_RATE_LIMIT_COMMAND_TIMEOUT_MS,
    75,
    'EXPLORE_DIRECTORY_RATE_LIMIT_COMMAND_TIMEOUT_MS',
    { max: 5_000 },
  );
  const connectTimeoutMs = parsePositiveInt(
    env.EXPLORE_DIRECTORY_RATE_LIMIT_CONNECT_TIMEOUT_MS,
    1_000,
    'EXPLORE_DIRECTORY_RATE_LIMIT_CONNECT_TIMEOUT_MS',
    { max: 30_000 },
  );
  const maxRetriesPerRequest = parsePositiveInt(
    env.EXPLORE_DIRECTORY_RATE_LIMIT_MAX_RETRIES_PER_REQUEST,
    1,
    'EXPLORE_DIRECTORY_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
    { min: 0, max: 10 },
  );
  return Object.freeze({
    enabled,
    redisUrl,
    keySecret,
    keyPrefix,
    commandTimeoutMs,
    connectTimeoutMs,
    maxRetriesPerRequest,
  });
}

/**
 * P-09 shared Redis limiter for COLP Sync push/pull. Mirrors
 * EXPLORE_DIRECTORY_RATE_LIMIT_SHARED (URL, prefix, timeouts) with an
 * independent HMAC pepper and a distinct default prefix (`known-sync`).
 * Redis URL may reuse SEARCH_RATE_LIMIT_REDIS_URL.
 */
export function loadSyncRateLimitSharedConfig(env: NodeJS.ProcessEnv): SyncColpRateLimitSharedConfig {
  const enabled = parseCacheBooleanEnv(env, 'SYNC_RATE_LIMIT_SHARED', false);
  const redisUrl = resolveLimiterRedisUrl(env, 'SYNC_RATE_LIMIT_REDIS_URL', {
    enabled,
    allowSearchFallback: true,
    requiredMessage: 'SYNC_RATE_LIMIT_REDIS_URL is required when SYNC_RATE_LIMIT_SHARED=true',
  });
  const rawSecret = env.SYNC_RATE_LIMIT_KEY_SECRET?.trim() ?? '';
  let keySecret: Buffer | null = null;
  if (rawSecret !== '') {
    if (rawSecret.length < 16 || rawSecret.length > 512) {
      throw new Error('SYNC_RATE_LIMIT_KEY_SECRET must be 16-512 characters');
    }
    keySecret = Buffer.from(rawSecret, 'utf8');
  } else if (enabled) {
    throw new Error(
      'SYNC_RATE_LIMIT_KEY_SECRET is required when SYNC_RATE_LIMIT_SHARED=true',
    );
  }
  const keyPrefix = (env.SYNC_RATE_LIMIT_KEY_PREFIX ?? 'known-sync').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(keyPrefix)) {
    throw new Error(
      'SYNC_RATE_LIMIT_KEY_PREFIX must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  const searchPrefix = (env.SEARCH_RATE_LIMIT_KEY_PREFIX ?? 'known').trim();
  if (keyPrefix === searchPrefix) {
    throw new Error(
      'SYNC_RATE_LIMIT_KEY_PREFIX must be independent from SEARCH_RATE_LIMIT_KEY_PREFIX',
    );
  }
  const commandTimeoutMs = parsePositiveInt(
    env.SYNC_RATE_LIMIT_COMMAND_TIMEOUT_MS,
    75,
    'SYNC_RATE_LIMIT_COMMAND_TIMEOUT_MS',
    { max: 5_000 },
  );
  const connectTimeoutMs = parsePositiveInt(
    env.SYNC_RATE_LIMIT_CONNECT_TIMEOUT_MS,
    1_000,
    'SYNC_RATE_LIMIT_CONNECT_TIMEOUT_MS',
    { max: 30_000 },
  );
  const maxRetriesPerRequest = parsePositiveInt(
    env.SYNC_RATE_LIMIT_MAX_RETRIES_PER_REQUEST,
    1,
    'SYNC_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
    { min: 0, max: 10 },
  );
  return Object.freeze({
    enabled,
    redisUrl,
    keySecret,
    keyPrefix,
    commandTimeoutMs,
    connectTimeoutMs,
    maxRetriesPerRequest,
  });
}

interface RedisRateLimitFamilyEnvNames {
  readonly sharedFlag: string;
  readonly redisUrl: string;
  readonly keySecret: string;
  readonly keyPrefix: string;
  readonly commandTimeoutMs: string;
  readonly connectTimeoutMs: string;
  readonly maxRetriesPerRequest: string;
  readonly defaultKeyPrefix: string;
}

/**
 * PERIPH-P1-c shared Redis family loader. Mirrors
 * EXPLORE_DIRECTORY_RATE_LIMIT_SHARED / SYNC_RATE_LIMIT_SHARED (URL may
 * reuse SEARCH_RATE_LIMIT_REDIS_URL; prefix must be independent from
 * SEARCH_RATE_LIMIT_KEY_PREFIX).
 */
export function loadRedisRateLimitFamilySharedConfig(
  env: NodeJS.ProcessEnv,
  names: RedisRateLimitFamilyEnvNames,
): RedisRateLimitFamilySharedConfig {
  const enabled = parseCacheBooleanEnv(env, names.sharedFlag, false);
  const redisUrl = resolveLimiterRedisUrl(env, names.redisUrl, {
    enabled,
    allowSearchFallback: true,
    requiredMessage: `${names.redisUrl} is required when ${names.sharedFlag}=true`,
  });
  const rawSecret = env[names.keySecret]?.trim() ?? '';
  let keySecret: Buffer | null = null;
  if (rawSecret !== '') {
    if (rawSecret.length < 16 || rawSecret.length > 512) {
      throw new Error(`${names.keySecret} must be 16-512 characters`);
    }
    keySecret = Buffer.from(rawSecret, 'utf8');
  } else if (enabled) {
    throw new Error(`${names.keySecret} is required when ${names.sharedFlag}=true`);
  }
  const keyPrefix = (env[names.keyPrefix] ?? names.defaultKeyPrefix).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(keyPrefix)) {
    throw new Error(
      `${names.keyPrefix} must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]`,
    );
  }
  const searchPrefix = (env.SEARCH_RATE_LIMIT_KEY_PREFIX ?? 'known').trim();
  if (keyPrefix === searchPrefix) {
    throw new Error(
      `${names.keyPrefix} must be independent from SEARCH_RATE_LIMIT_KEY_PREFIX`,
    );
  }
  const commandTimeoutMs = parsePositiveInt(
    env[names.commandTimeoutMs],
    75,
    names.commandTimeoutMs,
    { max: 5_000 },
  );
  const connectTimeoutMs = parsePositiveInt(
    env[names.connectTimeoutMs],
    1_000,
    names.connectTimeoutMs,
    { max: 30_000 },
  );
  const maxRetriesPerRequest = parsePositiveInt(
    env[names.maxRetriesPerRequest],
    1,
    names.maxRetriesPerRequest,
    { min: 0, max: 10 },
  );
  return Object.freeze({
    enabled,
    redisUrl,
    keySecret,
    keyPrefix,
    commandTimeoutMs,
    connectTimeoutMs,
    maxRetriesPerRequest,
  });
}

export const FOLLOW_RATE_LIMIT_FAMILY_ENV: RedisRateLimitFamilyEnvNames = Object.freeze({
  sharedFlag: 'FOLLOW_RATE_LIMIT_SHARED',
  redisUrl: 'FOLLOW_RATE_LIMIT_REDIS_URL',
  keySecret: 'FOLLOW_RATE_LIMIT_KEY_SECRET',
  keyPrefix: 'FOLLOW_RATE_LIMIT_KEY_PREFIX',
  commandTimeoutMs: 'FOLLOW_RATE_LIMIT_COMMAND_TIMEOUT_MS',
  connectTimeoutMs: 'FOLLOW_RATE_LIMIT_CONNECT_TIMEOUT_MS',
  maxRetriesPerRequest: 'FOLLOW_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
  defaultKeyPrefix: 'known-follow',
});

export const COLLECTION_FOLLOW_RATE_LIMIT_FAMILY_ENV: RedisRateLimitFamilyEnvNames = Object.freeze({
  sharedFlag: 'COLLECTION_FOLLOW_RATE_LIMIT_SHARED',
  redisUrl: 'COLLECTION_FOLLOW_RATE_LIMIT_REDIS_URL',
  keySecret: 'COLLECTION_FOLLOW_RATE_LIMIT_KEY_SECRET',
  keyPrefix: 'COLLECTION_FOLLOW_RATE_LIMIT_KEY_PREFIX',
  commandTimeoutMs: 'COLLECTION_FOLLOW_RATE_LIMIT_COMMAND_TIMEOUT_MS',
  connectTimeoutMs: 'COLLECTION_FOLLOW_RATE_LIMIT_CONNECT_TIMEOUT_MS',
  maxRetriesPerRequest: 'COLLECTION_FOLLOW_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
  defaultKeyPrefix: 'known-collection-follow',
});

export const FEED_RATE_LIMIT_FAMILY_ENV: RedisRateLimitFamilyEnvNames = Object.freeze({
  sharedFlag: 'FEED_RATE_LIMIT_SHARED',
  redisUrl: 'FEED_RATE_LIMIT_REDIS_URL',
  keySecret: 'FEED_RATE_LIMIT_KEY_SECRET',
  keyPrefix: 'FEED_RATE_LIMIT_KEY_PREFIX',
  commandTimeoutMs: 'FEED_RATE_LIMIT_COMMAND_TIMEOUT_MS',
  connectTimeoutMs: 'FEED_RATE_LIMIT_CONNECT_TIMEOUT_MS',
  maxRetriesPerRequest: 'FEED_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
  defaultKeyPrefix: 'known-feed',
});

export const NOTIFICATION_RATE_LIMIT_FAMILY_ENV: RedisRateLimitFamilyEnvNames = Object.freeze({
  sharedFlag: 'NOTIFICATION_RATE_LIMIT_SHARED',
  redisUrl: 'NOTIFICATION_RATE_LIMIT_REDIS_URL',
  keySecret: 'NOTIFICATION_RATE_LIMIT_KEY_SECRET',
  keyPrefix: 'NOTIFICATION_RATE_LIMIT_KEY_PREFIX',
  commandTimeoutMs: 'NOTIFICATION_RATE_LIMIT_COMMAND_TIMEOUT_MS',
  connectTimeoutMs: 'NOTIFICATION_RATE_LIMIT_CONNECT_TIMEOUT_MS',
  maxRetriesPerRequest: 'NOTIFICATION_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
  defaultKeyPrefix: 'known-notification',
});

export const EFFECT_PAGE_RATE_LIMIT_FAMILY_ENV: RedisRateLimitFamilyEnvNames = Object.freeze({
  sharedFlag: 'SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED',
  redisUrl: 'SYNC_EFFECT_PAGE_RATE_LIMIT_REDIS_URL',
  keySecret: 'SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_SECRET',
  keyPrefix: 'SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_PREFIX',
  commandTimeoutMs: 'SYNC_EFFECT_PAGE_RATE_LIMIT_COMMAND_TIMEOUT_MS',
  connectTimeoutMs: 'SYNC_EFFECT_PAGE_RATE_LIMIT_CONNECT_TIMEOUT_MS',
  maxRetriesPerRequest: 'SYNC_EFFECT_PAGE_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
  defaultKeyPrefix: 'known-effect-page',
});

export const PUBLIC_ACTIVITY_RATE_LIMIT_FAMILY_ENV: RedisRateLimitFamilyEnvNames = Object.freeze({
  sharedFlag: 'PUBLIC_ACTIVITY_RATE_LIMIT_SHARED',
  redisUrl: 'PUBLIC_ACTIVITY_RATE_LIMIT_REDIS_URL',
  keySecret: 'PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET',
  keyPrefix: 'PUBLIC_ACTIVITY_RATE_LIMIT_KEY_PREFIX',
  commandTimeoutMs: 'PUBLIC_ACTIVITY_RATE_LIMIT_COMMAND_TIMEOUT_MS',
  connectTimeoutMs: 'PUBLIC_ACTIVITY_RATE_LIMIT_CONNECT_TIMEOUT_MS',
  maxRetriesPerRequest: 'PUBLIC_ACTIVITY_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
  defaultKeyPrefix: 'known-public-activity',
});

/**
 * Shared admission backing for the eight product-route families that
 * historically fell back to independent process-local windows. The Redis
 * key codec still seals and separates each purpose; this config deliberately
 * shares only connection/timeout/key-material settings.
 */
export const PRODUCT_ROUTE_RATE_LIMIT_FAMILY_ENV: RedisRateLimitFamilyEnvNames = Object.freeze({
  sharedFlag: 'PRODUCT_ROUTE_RATE_LIMIT_SHARED',
  redisUrl: 'PRODUCT_ROUTE_RATE_LIMIT_REDIS_URL',
  keySecret: 'PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET',
  keyPrefix: 'PRODUCT_ROUTE_RATE_LIMIT_KEY_PREFIX',
  commandTimeoutMs: 'PRODUCT_ROUTE_RATE_LIMIT_COMMAND_TIMEOUT_MS',
  connectTimeoutMs: 'PRODUCT_ROUTE_RATE_LIMIT_CONNECT_TIMEOUT_MS',
  maxRetriesPerRequest: 'PRODUCT_ROUTE_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
  defaultKeyPrefix: 'known-product-route',
});

export function assertIndependentRateLimitPrefixes(
  pairs: readonly (readonly [label: string, prefix: string])[],
): void {
  const seen = new Map<string, string>();
  for (const [label, prefix] of pairs) {
    const previous = seen.get(prefix);
    if (previous !== undefined) {
      throw new Error(`${label} must be independent from ${previous}`);
    }
    seen.set(prefix, label);
  }
}

export function loadCollaborationInviteCleanupConfig(
  env: NodeJS.ProcessEnv,
): CollaborationInviteCleanupConfig {
  return Object.freeze({
    cleanupIntervalMs: parsePositiveInt(
      env.COLLABORATION_INVITE_CLEANUP_INTERVAL_MS,
      DEFAULT_COLLABORATION_INVITE_CLEANUP_INTERVAL_MS,
      'COLLABORATION_INVITE_CLEANUP_INTERVAL_MS',
    ),
    cleanupBatchSize: parsePositiveInt(
      env.COLLABORATION_INVITE_CLEANUP_BATCH_SIZE,
      DEFAULT_COLLABORATION_INVITE_CLEANUP_BATCH_SIZE,
      'COLLABORATION_INVITE_CLEANUP_BATCH_SIZE',
      { max: 10_000 },
    ),
  });
}
