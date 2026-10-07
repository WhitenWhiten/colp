/**
 * Publishing Insights ingest rate-limit port (PI-02).
 *
 * Family `publishing-insights-ingest` is independent from auth/search
 * purpose strings. Quota identity is HMAC'd with the dedicated ratelimit
 * pepper before it reaches Redis or the in-memory map. Anonymous quota
 * always includes a trusted IP prefix (IPv4 /24, IPv6 /56); a signed
 * insight cookie is visitor_hash continuity only and is never a
 * client-chosen quota key. Fail-closed: quota denial is 429; store
 * failure (including memory maxBuckets exhaustion) is 503 without a
 * fabricated Retry-After.
 */
import { isIP } from 'node:net';
import type { RateLimitRedisClientFactory } from './rate-limit-client.js';
import {
  createRedisFixedWindowStore,
  mapFrozenQuotaOutcome,
  type RedisFixedWindowStore,
} from './redis-fixed-window-store.js';
import {
  PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_FAMILY,
  PUBLISHING_INSIGHTS_RESOURCE_OPEN_WINDOW_MS,
  PUBLISHING_INSIGHTS_VIEW_PREVIEW_WINDOW_MS,
  buildPublishingInsightsIngestRateLimitKey,
  publishingInsightsIngestRateLimitSubjectHmac,
} from './publishing-insights-ingest-rate-limit-key-codec.js';
import type { InsightEventType } from '../../modules/publication/index.js';

export type PublishingInsightsIngestUaClass = 'browser' | 'mobile' | 'bot' | 'unknown';

export type PublishingInsightsIngestVisitor =
  | { readonly kind: 'subject'; readonly subjectId: string }
  | { readonly kind: 'ipua'; readonly ip: string; readonly userAgent: string };

export interface PublishingInsightsIngestRateLimitSubject {
  readonly visitor: PublishingInsightsIngestVisitor;
  readonly slug: string;
  readonly eventType: InsightEventType;
  readonly nodeId?: string;
}

export interface PublishingInsightsIngestRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export type PublishingInsightsIngestRateLimitFailureClass =
  | 'unavailable'
  | 'timeout'
  | 'malformed'
  | 'acl'
  | 'internal';

export interface PublishingInsightsIngestRateLimitFailure {
  readonly class: PublishingInsightsIngestRateLimitFailureClass;
  readonly code: string;
}

export type PublishingInsightsIngestRateLimitOutcome =
  | { readonly kind: 'allowed'; readonly decision: PublishingInsightsIngestRateLimitDecision }
  | { readonly kind: 'denied'; readonly decision: PublishingInsightsIngestRateLimitDecision }
  | { readonly kind: 'failed'; readonly failure: PublishingInsightsIngestRateLimitFailure };

export interface PublishingInsightsIngestRateLimiter {
  consume(subject: PublishingInsightsIngestRateLimitSubject): Promise<PublishingInsightsIngestRateLimitOutcome>;
  readiness(): { readonly status: 'healthy' | 'degraded'; readonly reason: string };
  readonly policy: Readonly<{ readonly [PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_FAMILY]: string }>;
  close(): Promise<void>;
}

export interface MemoryPublishingInsightsIngestRateLimiterOptions {
  readonly keySecret: Buffer;
  readonly environment?: string;
  readonly viewPreviewMaxRequests?: number;
  readonly resourceOpenMaxRequests?: number;
  readonly viewPreviewWindowMs?: number;
  readonly resourceOpenWindowMs?: number;
  readonly now?: () => number;
  /**
   * Hard cap on tracked buckets (default 100_000). At capacity a request
   * for a NEW subject returns `failed` (503) rather than silently
   * allocating another bucket.
   */
  readonly maxBuckets?: number;
  /** Minimum interval between TTL sweeps (default 60s). */
  readonly sweepIntervalMs?: number;
}

export interface MemoryPublishingInsightsIngestRateLimiter extends PublishingInsightsIngestRateLimiter {
  reset(): void;
  size(): number;
}

const DEFAULT_MEMORY_MAX_BUCKETS = 100_000;
const DEFAULT_MEMORY_SWEEP_INTERVAL_MS = 60_000;

export function createMemoryPublishingInsightsIngestRateLimiter(
  options: MemoryPublishingInsightsIngestRateLimiterOptions,
): MemoryPublishingInsightsIngestRateLimiter {
  const viewPreviewMax = options.viewPreviewMaxRequests ?? 1;
  const resourceOpenMax = options.resourceOpenMaxRequests ?? 1;
  const viewPreviewWindowMs = options.viewPreviewWindowMs ?? PUBLISHING_INSIGHTS_VIEW_PREVIEW_WINDOW_MS;
  const resourceOpenWindowMs = options.resourceOpenWindowMs ?? PUBLISHING_INSIGHTS_RESOURCE_OPEN_WINDOW_MS;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MEMORY_MAX_BUCKETS;
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
    throw new Error('publishing-insights memory rate limiter maxBuckets must be a positive safe integer');
  }
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_MEMORY_SWEEP_INTERVAL_MS;
  if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
    throw new Error('publishing-insights memory rate limiter sweepIntervalMs must be a positive safe integer');
  }
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const environment = options.environment ?? 'test';
  const policy = Object.freeze({
    [PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_FAMILY]:
      `publishing-insights-ingest:1:${viewPreviewWindowMs}/${resourceOpenWindowMs}`,
  });
  const now = options.now ?? Date.now;
  let lastSweepAt = now();
  return {
    policy,
    async consume(subject) {
      const windowMs = subject.eventType === 'resource_open' ? resourceOpenWindowMs : viewPreviewWindowMs;
      const maxRequests = subject.eventType === 'resource_open' ? resourceOpenMax : viewPreviewMax;
      const t = now();
      if (t - lastSweepAt >= sweepIntervalMs) {
        lastSweepAt = t;
        for (const [bucketKey, existing] of buckets) {
          if (t >= existing.resetAt) buckets.delete(bucketKey);
        }
      }
      const windowStartEpochMs = Math.floor(t / windowMs) * windowMs;
      const identity = quotaIdentity(subject, options.keySecret);
      const key = buildPublishingInsightsIngestRateLimitKey({
        environment,
        keySecret: options.keySecret,
        subject: identity,
        windowStartEpochMs,
      });
      let bucket = buckets.get(key);
      if (!bucket || t >= bucket.resetAt) {
        if (!bucket && buckets.size >= maxBuckets) {
          // Fail closed: do not silently allocate a new bucket past capacity.
          return {
            kind: 'failed',
            failure: { class: 'unavailable', code: 'rate_limit_capacity_exhausted' },
          };
        }
        bucket = { count: 0, resetAt: t + windowMs };
        buckets.set(key, bucket);
      }
      if (bucket.count >= maxRequests) {
        return {
          kind: 'denied',
          decision: {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - t) / 1000)),
          },
        };
      }
      bucket.count += 1;
      return { kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 } };
    },
    readiness() {
      return { status: 'healthy', reason: 'none' };
    },
    async close() {},
    reset() {
      buckets.clear();
      lastSweepAt = now();
    },
    size() {
      return buckets.size;
    },
  };
}

export interface RedisPublishingInsightsIngestRateLimitStoreOptions {
  readonly redisUrl: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly keyPrefix?: string;
  readonly viewPreviewMaxRequests?: number;
  readonly resourceOpenMaxRequests?: number;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
  readonly createClient?: RateLimitRedisClientFactory;
  readonly now?: () => number;
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly closeTimeoutMs?: number;
}

export function createRedisPublishingInsightsIngestRateLimitStore(
  options: RedisPublishingInsightsIngestRateLimitStoreOptions,
): PublishingInsightsIngestRateLimiter {
  if (typeof options.redisUrl !== 'string' || options.redisUrl.length === 0) {
    throw new Error('createRedisPublishingInsightsIngestRateLimitStore requires a redis URL');
  }
  if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length === 0) {
    throw new Error('createRedisPublishingInsightsIngestRateLimitStore requires a non-empty HMAC key secret buffer');
  }
  return new RedisPublishingInsightsIngestRateLimitStore(options);
}

class RedisPublishingInsightsIngestRateLimitStore implements PublishingInsightsIngestRateLimiter {
  readonly policy: Readonly<{ readonly [PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_FAMILY]: string }>;
  private readonly inner: RedisFixedWindowStore<PublishingInsightsIngestRateLimitSubject>;

  constructor(options: RedisPublishingInsightsIngestRateLimitStoreOptions) {
    const viewPreviewMaxRequests = options.viewPreviewMaxRequests ?? 1;
    const resourceOpenMaxRequests = options.resourceOpenMaxRequests ?? 1;
    const keyPrefix = options.keyPrefix ?? 'known';
    this.policy = Object.freeze({
      [PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_FAMILY]:
        `publishing-insights-ingest:1:${PUBLISHING_INSIGHTS_VIEW_PREVIEW_WINDOW_MS}/${PUBLISHING_INSIGHTS_RESOURCE_OPEN_WINDOW_MS}`,
    });
    this.inner = createRedisFixedWindowStore<PublishingInsightsIngestRateLimitSubject>({
      redisUrl: options.redisUrl,
      commandTimeoutMs: options.commandTimeoutMs,
      connectTimeoutMs: options.connectTimeoutMs,
      maxRetriesPerRequest: options.maxRetriesPerRequest,
      createClient: options.createClient,
      now: options.now,
      failureThreshold: options.failureThreshold,
      cooldownMs: options.cooldownMs,
      closeTimeoutMs: options.closeTimeoutMs,
      resolveAdmission: (subject, nowMs) => {
        const windowMs = subject.eventType === 'resource_open'
          ? PUBLISHING_INSIGHTS_RESOURCE_OPEN_WINDOW_MS
          : PUBLISHING_INSIGHTS_VIEW_PREVIEW_WINDOW_MS;
        return {
          key: buildPublishingInsightsIngestRateLimitKey({
            keyPrefix,
            environment: options.environment,
            keySecret: options.keySecret,
            subject: quotaIdentity(subject, options.keySecret),
            windowStartEpochMs: Math.floor(nowMs / windowMs) * windowMs,
          }),
          rateMax: subject.eventType === 'resource_open' ? resourceOpenMaxRequests : viewPreviewMaxRequests,
          windowMs,
        };
      },
    });
  }

  async consume(subject: PublishingInsightsIngestRateLimitSubject): Promise<PublishingInsightsIngestRateLimitOutcome> {
    return mapFrozenQuotaOutcome(await this.inner.consume(subject), (decision) =>
      Object.freeze({ allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds }));
  }

  readiness() {
    const snapshot = this.inner.readiness();
    return { status: snapshot.status, reason: snapshot.reason };
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

export function classifyPublishingInsightsUserAgent(userAgent: string): PublishingInsightsIngestUaClass {
  const value = userAgent.trim();
  if (value.length === 0) return 'unknown';
  if (/(bot|crawler|spider|curl|wget|python-requests)/iu.test(value)) return 'bot';
  if (/(Mobile|Android|iPhone|iPad)/u.test(value)) return 'mobile';
  return 'browser';
}

export function publishingInsightsClientIpPrefix(ip: string): string {
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(mapped) === 4) {
    const parts = mapped.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (isIP(mapped) === 6) return ipv6Prefix56(mapped);
  return 'unknown';
}

function quotaIdentity(subject: PublishingInsightsIngestRateLimitSubject, keySecret: Buffer): string {
  const visitor = visitorMaterial(subject.visitor, keySecret);
  const node = subject.eventType === 'resource_open' ? `|node|${subject.nodeId ?? ''}` : '';
  return `visitor|${visitor}|collection|${subject.slug}|event|${subject.eventType}${node}`;
}

function visitorMaterial(visitor: PublishingInsightsIngestVisitor, keySecret: Buffer): string {
  if (visitor.kind === 'subject') {
    return `subject|${publishingInsightsIngestRateLimitSubjectHmac(keySecret, `subject|${visitor.subjectId}`)}`;
  }
  const prefix = publishingInsightsClientIpPrefix(visitor.ip);
  const uaClass = classifyPublishingInsightsUserAgent(visitor.userAgent);
  return `ipua|${publishingInsightsIngestRateLimitSubjectHmac(keySecret, `ipua|${prefix}|${uaClass}`)}`;
}

function ipv6Prefix56(ip: string): string {
  const groups = expandIPv6(ip);
  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  const masked = bytes.slice(0, 7);
  const hextets = [
    (masked[0]! << 8) | masked[1]!,
    (masked[2]! << 8) | masked[3]!,
    (masked[4]! << 8) | masked[5]!,
    masked[6]! << 8,
  ];
  return `${hextets.map((value) => value.toString(16)).join(':')}::`;
}

function expandIPv6(ip: string): readonly number[] {
  const [head, tail] = ip.split('::');
  const parse = (part: string | undefined): number[] => (
    part === undefined || part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16) || 0)
  );
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const fill = 8 - left.length - right.length;
  return [...left, ...Array.from({ length: Math.max(0, fill) }, () => 0), ...right].slice(0, 8);
}

export interface ComposePublishingInsightsIngestRateLimiterOptions {
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly shared: {
    readonly enabled: boolean;
    readonly redisUrl: string | null;
    readonly keyPrefix: string;
    readonly commandTimeoutMs: number;
    readonly connectTimeoutMs: number;
    readonly maxRetriesPerRequest: number;
  };
  readonly createClient?: RateLimitRedisClientFactory;
}

/**
 * Production composition for the ingest limiter. Shared flag true constructs
 * the Redis adapter (HMAC pepper is the caller-supplied insights ratelimit
 * key, never search/auth peppers). Shared flag false keeps the bounded
 * in-process map (test / explicit single-process).
 */
export function composePublishingInsightsIngestRateLimiter(
  options: ComposePublishingInsightsIngestRateLimiterOptions,
): PublishingInsightsIngestRateLimiter {
  if (!options.shared.enabled) {
    return createMemoryPublishingInsightsIngestRateLimiter({
      keySecret: options.keySecret,
      environment: options.environment,
    });
  }
  if (options.shared.redisUrl === null || options.shared.redisUrl.length === 0) {
    throw new Error(
      'API composition refused: PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED=true requires PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL',
    );
  }
  return createRedisPublishingInsightsIngestRateLimitStore({
    redisUrl: options.shared.redisUrl,
    environment: options.environment,
    keySecret: options.keySecret,
    keyPrefix: options.shared.keyPrefix,
    commandTimeoutMs: options.shared.commandTimeoutMs,
    connectTimeoutMs: options.shared.connectTimeoutMs,
    maxRetriesPerRequest: options.shared.maxRetriesPerRequest,
    ...(options.createClient === undefined ? {} : { createClient: options.createClient }),
  });
}
