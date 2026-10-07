import { loadSharedFaviconConfig } from './config-favicon-shared.js';
import {
  FEED_CURSOR_TTL_MS,
  FOLLOW_CURSOR_TTL_MS,
  PUBLIC_ACTIVITY_CURSOR_TTL_MS,
  type FeedOperationsConfig,
  type RetainedFeedCursorKey,
  type RetainedFollowCursorKey,
  type RetainedPublicActivityCursorKey,
} from '../modules/social/index.js';
import {
  NOTIFICATION_INBOX_CURSOR_TTL_MS,
  type NotificationOperationsConfig,
  type RetainedNotificationInboxCursorKey,
} from '../modules/notifications/index.js';
import { parseCanonicalUtcTimestamp, parsePositiveInt, requireNonEmpty } from './config-parse-helpers.js';
import type {
  CollectionFollowFeatureConfig,
  CommunityFeatureConfig,
  FaviconPolicyAdmissionConfig,
  LibraryOrderAdmissionConfig,
  FeedFeatureConfig,
  FollowFeatureConfig,
  NotificationFeatureConfig,
  PublicActivityFeatureConfig,
  RedisRateLimitFamilySharedConfig,
} from './config-types.js';

const DEFAULT_FEED_QUEUE_AGE_NOT_READY_MS = 60_000;
const DEFAULT_FEED_QUEUE_BACKLOG_NOT_READY = 1_000;
const DEFAULT_FEED_DEAD_LETTER_NOT_READY = 1;
const DEFAULT_FEED_FANOUT_PAGE_SIZE = 500;
const DEFAULT_FEED_FANOUT_PROGRESS_AGE_NOT_READY_MS = 300_000;
const DEFAULT_FEED_WITHDRAWAL_BACKLOG_NOT_READY = 1_000;
const DEFAULT_FEED_REBUILD_MAX_EVENTS = 500;
const DEFAULT_FEED_REBUILD_MAX_RECIPIENTS = 100;
const DEFAULT_FEED_REBUILD_MAX_TOTAL_RECIPIENTS = 10_000;
const DEFAULT_FEED_REBUILD_TIMEOUT_MS = 30_000;
const DEFAULT_FEED_PURGE_BATCH_SIZE = 250;
const DEFAULT_FEED_RETENTION_DAYS = 90;
const DEFAULT_NOTIFICATION_QUEUE_AGE_NOT_READY_MS = 60_000;
const DEFAULT_NOTIFICATION_QUEUE_BACKLOG_NOT_READY = 1_000;
const DEFAULT_NOTIFICATION_QUEUE_DEAD_LETTER_NOT_READY = 1;
const DEFAULT_NOTIFICATION_DELIVERY_BACKLOG_DEGRADED = 1_000;
const DEFAULT_NOTIFICATION_DELIVERY_DEAD_LETTER_DEGRADED = 1;
const DEFAULT_NOTIFICATION_RETENTION_DAYS = 90;
const DEFAULT_NOTIFICATION_PURGE_BATCH_SIZE = 250;
const DEFAULT_NOTIFICATION_RECOVERY_BATCH_SIZE = 100;
const DEFAULT_NOTIFICATION_RECOVERY_MAX_EVENTS = 500;
const DEFAULT_NOTIFICATION_RECOVERY_TIMEOUT_MS = 30_000;

export function parseFollowRetainedKeys(raw: string): readonly RetainedFollowCursorKey[] {
  if (raw === '') return Object.freeze([]);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('FOLLOW_CURSOR_RETAINED_KEYS must be a JSON array'); }
  if (!Array.isArray(value) || value.length > 8) throw new Error('FOLLOW_CURSOR_RETAINED_KEYS must contain at most 8 keys');
  return Object.freeze(value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`FOLLOW_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'id,lastIssuedAt,retainUntil,secret'
      || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id)
      || typeof item.secret !== 'string' || typeof item.lastIssuedAt !== 'string' || typeof item.retainUntil !== 'string') {
      throw new Error(`FOLLOW_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    }
    const bytes = Buffer.from(item.secret, 'base64'); const canonical = bytes.length >= 32 && bytes.toString('base64') === item.secret; bytes.fill(0);
    const lastIssuedAt = parseCanonicalUtcTimestamp(item.lastIssuedAt, `FOLLOW_CURSOR_RETAINED_KEYS[${index}].lastIssuedAt`);
    const retainUntil = parseCanonicalUtcTimestamp(item.retainUntil, `FOLLOW_CURSOR_RETAINED_KEYS[${index}].retainUntil`);
    if (!canonical || retainUntil - lastIssuedAt < FOLLOW_CURSOR_TTL_MS) throw new Error(`FOLLOW_CURSOR_RETAINED_KEYS[${index}] does not cover Follow cursor TTL`);
    return Object.freeze({ id: item.id, secret: item.secret,
      lastIssuedAt: new Date(lastIssuedAt).toISOString(), retainUntil: new Date(retainUntil).toISOString() });
  }));
}

export function parseFeedRetainedKeys(raw: string): readonly RetainedFeedCursorKey[] {
  if (raw === '') return Object.freeze([]);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('FEED_CURSOR_RETAINED_KEYS must be a JSON array'); }
  if (!Array.isArray(value) || value.length > 8) throw new Error('FEED_CURSOR_RETAINED_KEYS must contain at most 8 keys');
  return Object.freeze(value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`FEED_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'id,lastIssuedAt,retainUntil,secret'
      || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id)
      || typeof item.secret !== 'string' || typeof item.lastIssuedAt !== 'string' || typeof item.retainUntil !== 'string') {
      throw new Error(`FEED_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    }
    const bytes = Buffer.from(item.secret, 'base64');
    const canonical = bytes.length >= 32 && bytes.toString('base64') === item.secret; bytes.fill(0);
    const lastIssuedAt = parseCanonicalUtcTimestamp(item.lastIssuedAt, `FEED_CURSOR_RETAINED_KEYS[${index}].lastIssuedAt`);
    const retainUntil = parseCanonicalUtcTimestamp(item.retainUntil, `FEED_CURSOR_RETAINED_KEYS[${index}].retainUntil`);
    if (!canonical || retainUntil - lastIssuedAt < FEED_CURSOR_TTL_MS) {
      throw new Error(`FEED_CURSOR_RETAINED_KEYS[${index}] does not cover Feed cursor TTL`);
    }
    return Object.freeze({ id: item.id, secret: item.secret,
      lastIssuedAt: new Date(lastIssuedAt).toISOString(), retainUntil: new Date(retainUntil).toISOString() });
  }));
}

export function parsePublicActivityRetainedKeys(raw: string): readonly RetainedPublicActivityCursorKey[] {
  if (raw === '') return Object.freeze([]);
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    throw new Error('PUBLIC_ACTIVITY_CURSOR_RETAINED_KEYS must be a JSON array');
  }
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error('PUBLIC_ACTIVITY_CURSOR_RETAINED_KEYS must contain at most 8 keys');
  }
  return Object.freeze(value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`PUBLIC_ACTIVITY_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    }
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'id,lastIssuedAt,retainUntil,secret'
      || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id)
      || typeof item.secret !== 'string' || typeof item.lastIssuedAt !== 'string'
      || typeof item.retainUntil !== 'string') {
      throw new Error(`PUBLIC_ACTIVITY_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    }
    const bytes = Buffer.from(item.secret, 'base64');
    const canonical = bytes.length >= 32 && bytes.toString('base64') === item.secret; bytes.fill(0);
    const lastIssuedAt = parseCanonicalUtcTimestamp(
      item.lastIssuedAt, `PUBLIC_ACTIVITY_CURSOR_RETAINED_KEYS[${index}].lastIssuedAt`,
    );
    const retainUntil = parseCanonicalUtcTimestamp(
      item.retainUntil, `PUBLIC_ACTIVITY_CURSOR_RETAINED_KEYS[${index}].retainUntil`,
    );
    if (!canonical || retainUntil - lastIssuedAt < PUBLIC_ACTIVITY_CURSOR_TTL_MS) {
      throw new Error(
        `PUBLIC_ACTIVITY_CURSOR_RETAINED_KEYS[${index}] does not cover public Activity cursor TTL`,
      );
    }
    return Object.freeze({ id: item.id, secret: item.secret,
      lastIssuedAt: new Date(lastIssuedAt).toISOString(), retainUntil: new Date(retainUntil).toISOString() });
  }));
}

export function parseNotificationRetainedKeys(raw: string): readonly RetainedNotificationInboxCursorKey[] {
  if (raw === '') return Object.freeze([]);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('NOTIFICATION_CURSOR_RETAINED_KEYS must be a JSON array'); }
  if (!Array.isArray(value) || value.length > 8) throw new Error('NOTIFICATION_CURSOR_RETAINED_KEYS must contain at most 8 keys');
  return Object.freeze(value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`NOTIFICATION_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'id,lastIssuedAt,retainUntil,secret'
      || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id)
      || typeof item.secret !== 'string' || typeof item.lastIssuedAt !== 'string' || typeof item.retainUntil !== 'string') {
      throw new Error(`NOTIFICATION_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    }
    const bytes = Buffer.from(item.secret, 'base64');
    const canonical = bytes.length >= 32 && bytes.toString('base64') === item.secret; bytes.fill(0);
    const lastIssuedAt = parseCanonicalUtcTimestamp(item.lastIssuedAt, `NOTIFICATION_CURSOR_RETAINED_KEYS[${index}].lastIssuedAt`);
    const retainUntil = parseCanonicalUtcTimestamp(item.retainUntil, `NOTIFICATION_CURSOR_RETAINED_KEYS[${index}].retainUntil`);
    if (!canonical || retainUntil - lastIssuedAt < NOTIFICATION_INBOX_CURSOR_TTL_MS) {
      throw new Error(`NOTIFICATION_CURSOR_RETAINED_KEYS[${index}] does not cover Notification cursor TTL`);
    }
    return Object.freeze({ id: item.id, secret: item.secret,
      lastIssuedAt: new Date(lastIssuedAt).toISOString(), retainUntil: new Date(retainUntil).toISOString() });
  }));
}

const FOLLOWED_COLLECTIONS_CURSOR_TTL_MS = 15 * 60 * 1000;
const DEV_FOLLOWED_COLLECTIONS_CURSOR_KEY_ID = 'dev-followed-collections-v1';
const DEV_FOLLOWED_COLLECTIONS_CURSOR_SECRET = Buffer.alloc(32, 29).toString('base64');

export function parseFollowedCollectionsRetainedKeys(
  raw: string,
): CollectionFollowFeatureConfig['cursorKeys']['retained'] {
  if (raw === '') return Object.freeze([]);
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    throw new Error('FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS must be a JSON array');
  }
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error('FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS must contain at most 8 keys');
  }
  return Object.freeze(value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    }
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'id,lastIssuedAt,retainUntil,secret'
      || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id)
      || typeof item.secret !== 'string' || typeof item.lastIssuedAt !== 'string'
      || typeof item.retainUntil !== 'string') {
      throw new Error(`FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS[${index}] is invalid`);
    }
    const bytes = Buffer.from(item.secret, 'base64');
    const canonical = bytes.length >= 32 && bytes.toString('base64') === item.secret; bytes.fill(0);
    const lastIssuedAt = parseCanonicalUtcTimestamp(
      item.lastIssuedAt, `FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS[${index}].lastIssuedAt`,
    );
    const retainUntil = parseCanonicalUtcTimestamp(
      item.retainUntil, `FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS[${index}].retainUntil`,
    );
    if (!canonical || retainUntil - lastIssuedAt < FOLLOWED_COLLECTIONS_CURSOR_TTL_MS) {
      throw new Error(
        `FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS[${index}] does not cover Followed collections cursor TTL`,
      );
    }
    return Object.freeze({ id: item.id, secret: item.secret,
      lastIssuedAt: new Date(lastIssuedAt).toISOString(), retainUntil: new Date(retainUntil).toISOString() });
  }));
}

export function loadCollectionFollowFeatureConfig(
  env: NodeJS.ProcessEnv,
  args: {
    readonly nodeEnv: string;
    readonly flag: string;
    readonly rateLimitShared: RedisRateLimitFamilySharedConfig;
    readonly siblingCursorSecrets: {
      readonly followSecret: string;
      readonly feedSecret: string;
      readonly classifyKey: string;
      readonly editorKey: string;
      readonly ownedKey: string;
      readonly linkHealthKey: string;
      readonly collectionHistoryKey: string;
      readonly notificationSecret: string;
      readonly publicActivitySecret: string;
    };
  },
): CollectionFollowFeatureConfig {
  const { nodeEnv, flag, rateLimitShared, siblingCursorSecrets } = args;
  const cursorKeyId = requireNonEmpty(env, 'FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID',
    nodeEnv === 'production' ? undefined : DEV_FOLLOWED_COLLECTIONS_CURSOR_KEY_ID);
  const cursorSecret = requireNonEmpty(env, 'FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET',
    nodeEnv === 'production' ? undefined : DEV_FOLLOWED_COLLECTIONS_CURSOR_SECRET);
  if (nodeEnv === 'production' && (cursorSecret === DEV_FOLLOWED_COLLECTIONS_CURSOR_SECRET
    || cursorKeyId === DEV_FOLLOWED_COLLECTIONS_CURSOR_KEY_ID
    || cursorSecret === siblingCursorSecrets.followSecret
    || cursorSecret === siblingCursorSecrets.feedSecret
    || cursorSecret === siblingCursorSecrets.classifyKey
    || cursorSecret === siblingCursorSecrets.editorKey
    || cursorSecret === siblingCursorSecrets.ownedKey
    || cursorSecret === siblingCursorSecrets.linkHealthKey
    || cursorSecret === siblingCursorSecrets.collectionHistoryKey
    || cursorSecret === siblingCursorSecrets.notificationSecret
    || cursorSecret === siblingCursorSecrets.publicActivitySecret
    || Buffer.byteLength(cursorSecret, 'utf8') < 32)) {
    throw new Error(
      'Followed collections cursor keys must be independent non-development values of at least 32 bytes in production',
    );
  }
  const cursorBytes = Buffer.from(cursorSecret, 'base64');
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(cursorKeyId)
      || cursorBytes.length < 32 || cursorBytes.toString('base64') !== cursorSecret) {
    cursorBytes.fill(0); throw new Error('FOLLOWED_COLLECTIONS_CURSOR_ACTIVE key is invalid');
  }
  cursorBytes.fill(0);
  const retainedKeys = parseFollowedCollectionsRetainedKeys(
    env.FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS?.trim() ?? '',
  );
  const keys = [{ id: cursorKeyId, secret: cursorSecret }, ...retainedKeys];
  if (new Set(keys.map((key) => key.id)).size !== keys.length
      || new Set(keys.map((key) => key.secret)).size !== keys.length) {
    throw new Error('Followed collections cursor key ids and material must be unique');
  }
  return Object.freeze({
    enabled: flag === 'true',
    cursorKeys: Object.freeze({ active: Object.freeze({ id: cursorKeyId, secret: cursorSecret }),
      retained: retainedKeys }),
    rateLimit: Object.freeze({
      maxRequests: parsePositiveInt(env.COLLECTION_FOLLOW_RATE_LIMIT_MAX, 120,
        'COLLECTION_FOLLOW_RATE_LIMIT_MAX', { max: 10_000 }),
      windowMs: parsePositiveInt(env.COLLECTION_FOLLOW_RATE_LIMIT_WINDOW_MS, 60_000,
        'COLLECTION_FOLLOW_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
    }),
    rateLimitShared,
    timeoutMs: parsePositiveInt(env.COLLECTION_FOLLOW_HTTP_TIMEOUT_MS, 2_000,
      'COLLECTION_FOLLOW_HTTP_TIMEOUT_MS', { max: 30_000 }),
  });
}

const DEV_COMMUNITY_CURSOR_HMAC_KEY = Buffer.alloc(32, 41).toString('base64');

export function loadCommunityFeatureConfig(
  env: NodeJS.ProcessEnv,
  args: { readonly nodeEnv: string; readonly flag: string },
): CommunityFeatureConfig {
  const rawKey = requireNonEmpty(env, 'COMMUNITY_CURSOR_HMAC_KEY',
    args.nodeEnv === 'production' ? undefined : DEV_COMMUNITY_CURSOR_HMAC_KEY);
  const keyBytes = Buffer.from(rawKey, 'base64');
  if (keyBytes.length < 32 || keyBytes.toString('base64') !== rawKey) {
    keyBytes.fill(0);
    throw new Error('COMMUNITY_CURSOR_HMAC_KEY must be canonical base64 of at least 32 bytes');
  }
  if (args.nodeEnv === 'production' && rawKey === DEV_COMMUNITY_CURSOR_HMAC_KEY) {
    keyBytes.fill(0);
    throw new Error('COMMUNITY_CURSOR_HMAC_KEY must be a non-development value in production');
  }
  return Object.freeze({
    enabled: args.flag === 'true',
    cursorHmacKey: Buffer.from(keyBytes),
    rateLimit: Object.freeze({
      vote: communityRateLimitBudget(env, 'VOTE', 60),
      comment: communityRateLimitBudget(env, 'COMMENT', 20),
      curation: communityRateLimitBudget(env, 'CURATION', 30),
      publicReads: communityRateLimitBudget(env, 'PUBLIC_READS', 120),
    }),
    timeoutMs: parsePositiveInt(env.COMMUNITY_HTTP_TIMEOUT_MS, 2_000,
      'COMMUNITY_HTTP_TIMEOUT_MS', { max: 30_000 }),
  });
}

/**
 * One contract COMMUNITY_RATE_LIMITS family budget. The per-family window
 * env overrides the shared COMMUNITY_RATE_LIMIT_WINDOW_MS when set.
 */
function communityRateLimitBudget(
  env: NodeJS.ProcessEnv,
  family: 'VOTE' | 'COMMENT' | 'CURATION' | 'PUBLIC_READS',
  defaultMaxRequests: number,
): { readonly maxRequests: number; readonly windowMs: number } {
  const maxName = `COMMUNITY_RATE_LIMIT_${family}_MAX` as const;
  const windowName = `COMMUNITY_RATE_LIMIT_${family}_WINDOW_MS` as const;
  return Object.freeze({
    maxRequests: parsePositiveInt(env[maxName], defaultMaxRequests, maxName, { max: 10_000 }),
    windowMs: parsePositiveInt(
      env[windowName] ?? env.COMMUNITY_RATE_LIMIT_WINDOW_MS, 60_000, windowName, { max: 3_600_000 }),
  });
}

export function loadLibraryOrderAdmissionConfig(env: NodeJS.ProcessEnv): LibraryOrderAdmissionConfig {
  return Object.freeze({
    rateLimit: Object.freeze({
      maxRequests: parsePositiveInt(env.LIBRARY_ORDER_RATE_LIMIT_MAX, 120, 'LIBRARY_ORDER_RATE_LIMIT_MAX', { max: 10_000 }),
      windowMs: parsePositiveInt(env.LIBRARY_ORDER_RATE_LIMIT_WINDOW_MS, 60_000, 'LIBRARY_ORDER_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
    }),
    timeoutMs: parsePositiveInt(env.LIBRARY_ORDER_HTTP_TIMEOUT_MS, 2_000, 'LIBRARY_ORDER_HTTP_TIMEOUT_MS', { max: 30_000 }),
  });
}

export function loadFollowFeatureConfig(
  env: NodeJS.ProcessEnv,
  args: {
    readonly nodeEnv: string;
    readonly flag: string;
    readonly rateLimitShared: RedisRateLimitFamilySharedConfig;
  },
): FollowFeatureConfig {
  const { nodeEnv, flag, rateLimitShared } = args;
  const followCursorKeyId = requireNonEmpty(env, 'FOLLOW_CURSOR_ACTIVE_KEY_ID',
    nodeEnv === 'production' ? undefined : 'dev-follow-v1');
  const followCursorSecret = requireNonEmpty(env, 'FOLLOW_CURSOR_ACTIVE_SECRET',
    nodeEnv === 'production' ? undefined : Buffer.alloc(32, 7).toString('base64'));
  const followCursorBytes = Buffer.from(followCursorSecret, 'base64');
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(followCursorKeyId)
      || followCursorBytes.length < 32 || followCursorBytes.toString('base64') !== followCursorSecret) {
    followCursorBytes.fill(0); throw new Error('FOLLOW_CURSOR_ACTIVE key is invalid');
  }
  followCursorBytes.fill(0);
  const followRetainedKeys = parseFollowRetainedKeys(env.FOLLOW_CURSOR_RETAINED_KEYS?.trim() ?? '');
  const followKeys = [{ id: followCursorKeyId, secret: followCursorSecret }, ...followRetainedKeys];
  if (new Set(followKeys.map((key) => key.id)).size !== followKeys.length
      || new Set(followKeys.map((key) => key.secret)).size !== followKeys.length) {
    throw new Error('Follow cursor key ids and material must be unique');
  }
  return Object.freeze({
    enabled: flag === 'true',
    cursorKeys: Object.freeze({ active: Object.freeze({ id: followCursorKeyId, secret: followCursorSecret }),
      retained: followRetainedKeys }),
    rateLimit: Object.freeze({
      maxRequests: parsePositiveInt(env.FOLLOW_RATE_LIMIT_MAX, 120, 'FOLLOW_RATE_LIMIT_MAX', { max: 10_000 }),
      windowMs: parsePositiveInt(env.FOLLOW_RATE_LIMIT_WINDOW_MS, 60_000, 'FOLLOW_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
    }),
    rateLimitShared,
    timeoutMs: parsePositiveInt(env.FOLLOW_HTTP_TIMEOUT_MS, 2_000, 'FOLLOW_HTTP_TIMEOUT_MS', { max: 30_000 }),
  });
}

export function loadFeedOperationsConfig(
  env: NodeJS.ProcessEnv,
  args: {
    readonly fanoutPageSizeRaw: string | undefined;
    readonly fanoutProgressAgeNotReadyMsRaw: string | undefined;
  },
): { readonly fanoutPageSize: number; readonly operations: FeedOperationsConfig } {
  const fanoutPageSize = parsePositiveInt(args.fanoutPageSizeRaw,
    DEFAULT_FEED_FANOUT_PAGE_SIZE, 'FEED_FANOUT_PAGE_SIZE', { max: 1_000 });
  const feedOperations: FeedOperationsConfig = Object.freeze({
    queueAgeNotReadyMs: parsePositiveInt(env.FEED_QUEUE_AGE_NOT_READY_MS,
      DEFAULT_FEED_QUEUE_AGE_NOT_READY_MS, 'FEED_QUEUE_AGE_NOT_READY_MS', { max: 86_400_000 }),
    queueBacklogNotReady: parsePositiveInt(env.FEED_QUEUE_BACKLOG_NOT_READY,
      DEFAULT_FEED_QUEUE_BACKLOG_NOT_READY, 'FEED_QUEUE_BACKLOG_NOT_READY', { max: 1_000_000 }),
    deadLetterNotReady: parsePositiveInt(env.FEED_DEAD_LETTER_NOT_READY,
      DEFAULT_FEED_DEAD_LETTER_NOT_READY, 'FEED_DEAD_LETTER_NOT_READY', { max: 1_000_000 }),
    fanoutProgressAgeNotReadyMs: parsePositiveInt(args.fanoutProgressAgeNotReadyMsRaw,
      DEFAULT_FEED_FANOUT_PROGRESS_AGE_NOT_READY_MS, 'FEED_FANOUT_PROGRESS_AGE_NOT_READY_MS',
      { max: 86_400_000 }),
    withdrawalBacklogNotReady: parsePositiveInt(env.FEED_WITHDRAWAL_BACKLOG_NOT_READY,
      DEFAULT_FEED_WITHDRAWAL_BACKLOG_NOT_READY, 'FEED_WITHDRAWAL_BACKLOG_NOT_READY',
      { max: 1_000_000 }),
    rebuildMaxEvents: parsePositiveInt(env.FEED_REBUILD_MAX_EVENTS,
      DEFAULT_FEED_REBUILD_MAX_EVENTS, 'FEED_REBUILD_MAX_EVENTS', { max: 10_000 }),
    rebuildMaxRecipientsPerEvent: parsePositiveInt(env.FEED_REBUILD_MAX_RECIPIENTS,
      DEFAULT_FEED_REBUILD_MAX_RECIPIENTS, 'FEED_REBUILD_MAX_RECIPIENTS', { max: 1_000 }),
    rebuildMaxTotalRecipients: parsePositiveInt(env.FEED_REBUILD_MAX_TOTAL_RECIPIENTS,
      DEFAULT_FEED_REBUILD_MAX_TOTAL_RECIPIENTS, 'FEED_REBUILD_MAX_TOTAL_RECIPIENTS',
      { max: 1_000_000 }),
    rebuildTimeoutMs: parsePositiveInt(env.FEED_REBUILD_TIMEOUT_MS,
      DEFAULT_FEED_REBUILD_TIMEOUT_MS, 'FEED_REBUILD_TIMEOUT_MS', { max: 600_000 }),
    purgeBatchSize: parsePositiveInt(env.FEED_PURGE_BATCH_SIZE,
      DEFAULT_FEED_PURGE_BATCH_SIZE, 'FEED_PURGE_BATCH_SIZE', { max: 10_000 }),
    retentionDays: parsePositiveInt(env.FEED_RETENTION_DAYS,
      DEFAULT_FEED_RETENTION_DAYS, 'FEED_RETENTION_DAYS', { max: 3650 }),
  });
  return { fanoutPageSize, operations: feedOperations };
}

export function loadFeedFeatureConfig(
  env: NodeJS.ProcessEnv,
  args: {
    readonly nodeEnv: string;
    readonly flag: string;
    readonly rateLimitShared: RedisRateLimitFamilySharedConfig;
    readonly fanoutPageSize: number;
    readonly operations: FeedOperationsConfig;
  },
): FeedFeatureConfig {
  const { nodeEnv, flag, rateLimitShared, fanoutPageSize, operations } = args;
  const feedCursorKeyId = requireNonEmpty(env, 'FEED_CURSOR_ACTIVE_KEY_ID',
    nodeEnv === 'production' ? undefined : 'dev-feed-v1');
  const feedCursorSecret = requireNonEmpty(env, 'FEED_CURSOR_ACTIVE_SECRET',
    nodeEnv === 'production' ? undefined : Buffer.alloc(32, 11).toString('base64'));
  const feedCursorBytes = Buffer.from(feedCursorSecret, 'base64');
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(feedCursorKeyId)
      || feedCursorBytes.length < 32 || feedCursorBytes.toString('base64') !== feedCursorSecret) {
    feedCursorBytes.fill(0); throw new Error('FEED_CURSOR_ACTIVE key is invalid');
  }
  feedCursorBytes.fill(0);
  const feedRetainedKeys = parseFeedRetainedKeys(env.FEED_CURSOR_RETAINED_KEYS?.trim() ?? '');
  const feedKeys = [{ id: feedCursorKeyId, secret: feedCursorSecret }, ...feedRetainedKeys];
  if (new Set(feedKeys.map((key) => key.id)).size !== feedKeys.length
      || new Set(feedKeys.map((key) => key.secret)).size !== feedKeys.length) {
    throw new Error('Feed cursor key ids and material must be unique');
  }
  return Object.freeze({
    enabled: flag === 'true',
    cursorKeys: Object.freeze({ active: Object.freeze({ id: feedCursorKeyId, secret: feedCursorSecret }),
      retained: feedRetainedKeys }),
    rateLimit: Object.freeze({
      maxRequests: parsePositiveInt(env.FEED_RATE_LIMIT_MAX, 120, 'FEED_RATE_LIMIT_MAX', { max: 10_000 }),
      windowMs: parsePositiveInt(env.FEED_RATE_LIMIT_WINDOW_MS, 60_000, 'FEED_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
    }),
    rateLimitShared,
    timeoutMs: parsePositiveInt(env.FEED_HTTP_TIMEOUT_MS, 2_000, 'FEED_HTTP_TIMEOUT_MS', { max: 30_000 }),
    fanoutPageSize,
    operations,
  });
}

export function loadPublicActivityFeatureConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): PublicActivityFeatureConfig {
  const publicActivityCursorKeyId = requireNonEmpty(env, 'PUBLIC_ACTIVITY_CURSOR_ACTIVE_KEY_ID',
    nodeEnv === 'production' ? undefined : 'dev-public-activity-v1');
  const publicActivityCursorSecret = requireNonEmpty(env, 'PUBLIC_ACTIVITY_CURSOR_ACTIVE_SECRET',
    nodeEnv === 'production' ? undefined : Buffer.alloc(32, 19).toString('base64'));
  const publicActivityCursorBytes = Buffer.from(publicActivityCursorSecret, 'base64');
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(publicActivityCursorKeyId)
      || publicActivityCursorBytes.length < 32
      || publicActivityCursorBytes.toString('base64') !== publicActivityCursorSecret) {
    publicActivityCursorBytes.fill(0); throw new Error('PUBLIC_ACTIVITY_CURSOR_ACTIVE key is invalid');
  }
  publicActivityCursorBytes.fill(0);
  const publicActivityRetainedKeys = parsePublicActivityRetainedKeys(
    env.PUBLIC_ACTIVITY_CURSOR_RETAINED_KEYS?.trim() ?? '',
  );
  const publicActivityKeys = [
    { id: publicActivityCursorKeyId, secret: publicActivityCursorSecret },
    ...publicActivityRetainedKeys,
  ];
  if (new Set(publicActivityKeys.map((key) => key.id)).size !== publicActivityKeys.length
      || new Set(publicActivityKeys.map((key) => key.secret)).size !== publicActivityKeys.length) {
    throw new Error('public Activity cursor key ids and material must be unique');
  }
  return Object.freeze({
    cursorKeys: Object.freeze({
      active: Object.freeze({ id: publicActivityCursorKeyId, secret: publicActivityCursorSecret }),
      retained: publicActivityRetainedKeys,
    }),
  });
}

export function loadNotificationOperationsConfig(env: NodeJS.ProcessEnv): NotificationOperationsConfig {
  return Object.freeze({
    queueAgeNotReadyMs: parsePositiveInt(env.NOTIFICATION_QUEUE_AGE_NOT_READY_MS,
      DEFAULT_NOTIFICATION_QUEUE_AGE_NOT_READY_MS, 'NOTIFICATION_QUEUE_AGE_NOT_READY_MS',
      { max: 86_400_000 }),
    queueBacklogNotReady: parsePositiveInt(env.NOTIFICATION_QUEUE_BACKLOG_NOT_READY,
      DEFAULT_NOTIFICATION_QUEUE_BACKLOG_NOT_READY, 'NOTIFICATION_QUEUE_BACKLOG_NOT_READY',
      { max: 1_000_000 }),
    queueDeadLetterNotReady: parsePositiveInt(env.NOTIFICATION_QUEUE_DEAD_LETTER_NOT_READY,
      DEFAULT_NOTIFICATION_QUEUE_DEAD_LETTER_NOT_READY,
      'NOTIFICATION_QUEUE_DEAD_LETTER_NOT_READY', { max: 1_000_000 }),
    deliveryBacklogDegraded: parsePositiveInt(env.NOTIFICATION_DELIVERY_BACKLOG_DEGRADED,
      DEFAULT_NOTIFICATION_DELIVERY_BACKLOG_DEGRADED,
      'NOTIFICATION_DELIVERY_BACKLOG_DEGRADED', { max: 1_000_000 }),
    deliveryDeadLetterDegraded: parsePositiveInt(env.NOTIFICATION_DELIVERY_DEAD_LETTER_DEGRADED,
      DEFAULT_NOTIFICATION_DELIVERY_DEAD_LETTER_DEGRADED,
      'NOTIFICATION_DELIVERY_DEAD_LETTER_DEGRADED', { max: 1_000_000 }),
    retentionDays: parsePositiveInt(env.NOTIFICATION_RETENTION_DAYS,
      DEFAULT_NOTIFICATION_RETENTION_DAYS, 'NOTIFICATION_RETENTION_DAYS', { max: 3650 }),
    purgeBatchSize: parsePositiveInt(env.NOTIFICATION_PURGE_BATCH_SIZE,
      DEFAULT_NOTIFICATION_PURGE_BATCH_SIZE, 'NOTIFICATION_PURGE_BATCH_SIZE', { max: 10_000 }),
    recoveryBatchSize: parsePositiveInt(env.NOTIFICATION_RECOVERY_BATCH_SIZE,
      DEFAULT_NOTIFICATION_RECOVERY_BATCH_SIZE, 'NOTIFICATION_RECOVERY_BATCH_SIZE', { max: 1_000 }),
    recoveryMaxEvents: parsePositiveInt(env.NOTIFICATION_RECOVERY_MAX_EVENTS,
      DEFAULT_NOTIFICATION_RECOVERY_MAX_EVENTS, 'NOTIFICATION_RECOVERY_MAX_EVENTS', { max: 10_000 }),
    recoveryTimeoutMs: parsePositiveInt(env.NOTIFICATION_RECOVERY_TIMEOUT_MS,
      DEFAULT_NOTIFICATION_RECOVERY_TIMEOUT_MS, 'NOTIFICATION_RECOVERY_TIMEOUT_MS',
      { max: 600_000 }),
  });
}

export function loadNotificationFeatureConfig(
  env: NodeJS.ProcessEnv,
  args: {
    readonly nodeEnv: string;
    readonly flag: string;
    readonly rateLimitShared: RedisRateLimitFamilySharedConfig;
    readonly operations: NotificationOperationsConfig;
  },
): NotificationFeatureConfig {
  const { nodeEnv, flag, rateLimitShared, operations } = args;
  const notificationCursorKeyId = requireNonEmpty(env, 'NOTIFICATION_CURSOR_ACTIVE_KEY_ID',
    nodeEnv === 'production' ? undefined : 'dev-notification-v1');
  const notificationCursorSecret = requireNonEmpty(env, 'NOTIFICATION_CURSOR_ACTIVE_SECRET',
    nodeEnv === 'production' ? undefined : Buffer.alloc(32, 13).toString('base64'));
  const notificationCursorBytes = Buffer.from(notificationCursorSecret, 'base64');
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(notificationCursorKeyId)
      || notificationCursorBytes.length < 32 || notificationCursorBytes.toString('base64') !== notificationCursorSecret) {
    notificationCursorBytes.fill(0); throw new Error('NOTIFICATION_CURSOR_ACTIVE key is invalid');
  }
  notificationCursorBytes.fill(0);
  const notificationRetainedKeys = parseNotificationRetainedKeys(env.NOTIFICATION_CURSOR_RETAINED_KEYS?.trim() ?? '');
  return Object.freeze({
    enabled: flag === 'true',
    cursorKeys: Object.freeze({ active: Object.freeze({ id: notificationCursorKeyId,
      secret: notificationCursorSecret }), retained: notificationRetainedKeys }),
    rateLimit: Object.freeze({
      maxRequests: parsePositiveInt(env.NOTIFICATION_RATE_LIMIT_MAX, 120, 'NOTIFICATION_RATE_LIMIT_MAX', { max: 10_000 }),
      windowMs: parsePositiveInt(env.NOTIFICATION_RATE_LIMIT_WINDOW_MS, 60_000, 'NOTIFICATION_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
    }),
    rateLimitShared,
    timeoutMs: parsePositiveInt(env.NOTIFICATION_HTTP_TIMEOUT_MS, 2_000, 'NOTIFICATION_HTTP_TIMEOUT_MS', { max: 30_000 }),
    operations,
  });
}

/**
 * FO-01/FO-02 favicon policy/source feature gate + durable job worker config.
 * The flag defaults to false and booleans accept only the exact strings
 * true/false; malformed enabled configuration fails startup (contract
 * `x-config`). The FAVICON_* values implement the frozen contract: const
 * entries must match; ranged values are validated for their runtime consumers.
 */
export function loadFaviconPolicyAdmissionConfig(env: NodeJS.ProcessEnv): FaviconPolicyAdmissionConfig {
  const flag = (env.KNOWN_FEATURE_FAVICON_POLICY ?? 'false').trim().toLowerCase();
  if (flag !== 'true' && flag !== 'false') {
    throw new Error('KNOWN_FEATURE_FAVICON_POLICY must be true or false');
  }
  const retryBackoff = parseFaviconRetryBackoff(env.FAVICON_RETRY_BACKOFF_SECONDS);
  return Object.freeze({
    enabled: flag === 'true',
    cursorHmacKey: loadFaviconCursorHmacKey(env, flag === 'true'),
    timeoutMs: parsePositiveInt(env.FAVICON_POLICY_TIMEOUT_MS, 2_000,
      'FAVICON_POLICY_TIMEOUT_MS', { max: 30_000 }),
    fetchTimeoutMs: parsePositiveInt(env.FAVICON_FETCH_TIMEOUT_MS, 10_000,
      'FAVICON_FETCH_TIMEOUT_MS', { min: 1_000, max: 30_000 }),
    fetchMaxBytes: parseConstInt(env.FAVICON_FETCH_MAX_BYTES, 65_536, 'FAVICON_FETCH_MAX_BYTES'),
    shared: loadSharedFaviconConfig(env),
    fetchMaxRedirects: parseConstInt(env.FAVICON_FETCH_MAX_REDIRECTS, 3, 'FAVICON_FETCH_MAX_REDIRECTS'),
    jobBatchSize: parseConstInt(env.FAVICON_JOB_BATCH_SIZE, 100, 'FAVICON_JOB_BATCH_SIZE'),
    jobMaxAttempts: parseConstInt(env.FAVICON_JOB_MAX_ATTEMPTS, 5, 'FAVICON_JOB_MAX_ATTEMPTS'),
    historyRetentionSeconds: parseConstInt(
      env.FAVICON_HISTORY_RETENTION_SECONDS, 31_536_000, 'FAVICON_HISTORY_RETENTION_SECONDS'),
    jobConcurrency: parseConstInt(env.FAVICON_JOB_CONCURRENCY, 2, 'FAVICON_JOB_CONCURRENCY'),
    retryBackoffSeconds: retryBackoff,
    workerPollIntervalMs: 1_000,
    workerLeaseDurationMs: 60_000,
    gcPollIntervalMs: 60_000,
  });
}

/** FAVICON_RETRY_BACKOFF_SECONDS: const [1,2,4,8,16]. */
function parseFaviconRetryBackoff(raw: string | undefined): readonly number[] {
  const expected = [1, 2, 4, 8, 16];
  if (raw === undefined || raw.trim() === '') return Object.freeze([...expected]);
  const parts = raw.trim().split(',').map((part) => part.trim());
  if (parts.length !== expected.length) {
    throw new Error('FAVICON_RETRY_BACKOFF_SECONDS must be exactly "1,2,4,8,16"');
  }
  const parsed = parts.map((part, index) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value !== expected[index]) {
      throw new Error('FAVICON_RETRY_BACKOFF_SECONDS must be exactly "1,2,4,8,16"');
    }
    return value;
  });
  return Object.freeze(parsed);
}

/**
 * FAVICON_CURSOR_HMAC_KEY: base64url-32-byte-secret, required when the flag
 * is enabled (contract `x-config` requiredWhen). Decodes to exactly 32 bytes
 * and round-trips through base64url. When the feature is disabled the cursor
 * routes are 404 and the value is optional; a deterministic derived default is
 * used only so the production route manifest can still register the (never
 * exposed) operation while the feature is off. The key never leaves this
 * process as plaintext logs.
 */
function loadFaviconCursorHmacKey(env: NodeJS.ProcessEnv, required: boolean): string {
  const raw = (env.FAVICON_CURSOR_HMAC_KEY ?? '').trim();
  if (raw === '') {
    if (required) {
      throw new Error('FAVICON_CURSOR_HMAC_KEY is required when KNOWN_FEATURE_FAVICON_POLICY=true');
    }
    return Buffer.alloc(32, 9).toString('base64url');
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(raw)) {
    throw new Error('FAVICON_CURSOR_HMAC_KEY must be a base64url 32-byte secret');
  }
  const decoded = Buffer.from(raw, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== raw) {
    decoded.fill(0);
    throw new Error('FAVICON_CURSOR_HMAC_KEY must decode to exactly 32 bytes');
  }
  decoded.fill(0);
  return raw;
}

/** Contract `const` integer: absent uses the default; present must equal it exactly. */
function parseConstInt(raw: string | undefined, expected: number, label: string): number {
  if (raw === undefined || raw.trim() === '') return expected;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value !== expected) {
    throw new Error(`${label} must be exactly ${expected}`);
  }
  return value;
}
