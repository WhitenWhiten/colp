import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HttpSecurityConfig } from '../bootstrap/config.js';
import {
  PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_FAMILY,
  COLLABORATION_INVITE_RATE_LIMIT_FAMILY,
  type AuthRateLimiter,
  type AuthRateLimitOutcome,
  type AuthRateLimitRouteFamily,
  type AuthRateLimitSubject,
  type CollaborationInviteRateLimitFamily,
  type EffectPageRateLimiter,
  type EffectPageRateLimitOutcome,
  type EffectPageRateLimitSubject,
  type PublishingInsightsIngestRateLimitFamily,
  type ProductSurfaceRateLimiter,
  type SearchRateLimitOutcome,
  type SearchRateLimitRouteFamily,
  type SearchRateLimitSubject,
  type SearchRateLimiter,
  type SyncColpRateLimitOutcome,
  type SyncColpRateLimitRouteFamily,
  type SyncColpRateLimitSubject,
  type SyncColpRateLimiter,
} from '../infrastructure/rate-limit/index.js';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import { AUTH_ROUTE_MANIFEST, type AuthRouteManifestEntry } from './auth/auth-route-manifest.js';
import { ProductHttpError } from './product-error.js';

/**
 * Auth / session routes that receive the Phase 1 IP rate limit. Task A4:
 * this list and the family map are derived from the SINGLE auth-route
 * manifest (auth-route-manifest.ts) — every manifest entry that carries a
 * rate-limit family is rate-limited here. Task C4: the Better Auth surface
 * is split into dedicated sealed families (sign-in / sign-up / otp / reset /
 * link / mfa / oauth-callback) carried by the same manifest, including the pending endpoints
 * (the onRequest gate consumes the family bucket before routing, so
 * unmounted endpoints cannot be used to launder traffic past a budget). The
 * legacy OIDC paths keep their families until F3 removes them.
 */
export const AUTH_RATE_LIMITED_PATHS: readonly string[] = Object.freeze(
  [...new Set(
    AUTH_ROUTE_MANIFEST
      .filter((entry) => entry.rateLimitFamily !== null)
      .map((entry) => entry.path),
  )],
);

/**
 * PI-02 Publishing Insights ingest admission map. Independent of auth/search
 * families and of their HMAC purpose strings (`{auth:…}` / `{search:…}`).
 * The route handler consumes this family; the map is the sealed path→family
 * registration (same hang as AUTH_RATE_LIMIT_FAMILY_BY_PATH).
 */
export const PUBLISHING_INSIGHTS_INGEST_RATE_LIMITED_PATHS: readonly string[] = Object.freeze([
  '/api/v1/public-collections/:slug/insight-events',
  '/api/v1/public-collections/{slug}/insight-events',
]);

const PUBLISHING_INSIGHTS_INGEST_FAMILY_BY_PATH: Readonly<
  Record<string, PublishingInsightsIngestRateLimitFamily>
> = Object.freeze({
  '/api/v1/public-collections/:slug/insight-events': PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_FAMILY,
  '/api/v1/public-collections/{slug}/insight-events': PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_FAMILY,
});

export function publishingInsightsIngestRateLimitFamilyForPath(
  urlPath: string,
): PublishingInsightsIngestRateLimitFamily | null {
  return PUBLISHING_INSIGHTS_INGEST_FAMILY_BY_PATH[urlPath] ?? null;
}

export const COLLABORATION_INVITE_RATE_LIMITED_PATHS: readonly string[] = Object.freeze([
  '/api/v1/collections/:collectionId/members/invites',
  '/api/v1/collections/{collectionId}/members/invites',
  '/api/v1/me/collaboration-invites/:inviteId/accept',
  '/api/v1/me/collaboration-invites/{inviteId}/accept',
  '/api/v1/me/collaboration-invites/:inviteId/decline',
  '/api/v1/me/collaboration-invites/{inviteId}/decline',
]);

const COLLABORATION_INVITE_FAMILY_BY_PATH: Readonly<
  Record<string, CollaborationInviteRateLimitFamily>
> = Object.freeze({
  '/api/v1/collections/:collectionId/members/invites': COLLABORATION_INVITE_RATE_LIMIT_FAMILY,
  '/api/v1/collections/{collectionId}/members/invites': COLLABORATION_INVITE_RATE_LIMIT_FAMILY,
  '/api/v1/me/collaboration-invites/:inviteId/accept': COLLABORATION_INVITE_RATE_LIMIT_FAMILY,
  '/api/v1/me/collaboration-invites/{inviteId}/accept': COLLABORATION_INVITE_RATE_LIMIT_FAMILY,
  '/api/v1/me/collaboration-invites/:inviteId/decline': COLLABORATION_INVITE_RATE_LIMIT_FAMILY,
  '/api/v1/me/collaboration-invites/{inviteId}/decline': COLLABORATION_INVITE_RATE_LIMIT_FAMILY,
});

export function collaborationInviteRateLimitFamilyForPath(
  urlPath: string,
): CollaborationInviteRateLimitFamily | null {
  return COLLABORATION_INVITE_FAMILY_BY_PATH[urlPath] ?? null;
}

export interface FixedWindowRateLimiter {
  /** Attempt to consume one unit for the key. */
  consume(key: string): { readonly allowed: true } | {
    readonly allowed: false;
    readonly retryAfterSeconds: number;
  };
  /** Test helper: clear all buckets and reset counters. */
  reset(): void;
  /** Test helper: current bucket size (approximate). */
  size(): number;
  /** Cumulative expired buckets removed by TTL sweeps (read-only metric). */
  evictions(): number;
  /** Cumulative new-key requests denied because the map is at capacity (read-only metric). */
  capacityRejections(): number;
}

export interface FixedWindowRateLimiterOptions {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly now?: () => number;
  /**
   * Hard cap on tracked buckets (default 100_000). At capacity a request
   * for a NEW key is denied; live buckets are never evicted and existing
   * keys keep their budgets.
   */
  readonly maxBuckets?: number;
  /**
   * Minimum interval between TTL sweeps (default windowMs). Cleanup is
   * amortized: no single request pays an O(n) pass more often than once
   * per sweepIntervalMs. Expired buckets are reclaimed no later than
   * windowMs + sweepIntervalMs after creation while traffic continues.
   */
  readonly sweepIntervalMs?: number;
}

const DEFAULT_MAX_BUCKETS = 100_000;

/**
 * Single-process fixed-window rate limiter.
 * Explicitly non-distributed: multi-replica production needs a shared adapter.
 *
 * Memory safety (FIX-M-002): the bucket map is bounded by `maxBuckets` and
 * expired buckets are reclaimed by an amortized TTL sweep that runs at most
 * once per `sweepIntervalMs`. Overload policy is deterministic: when the map
 * is at capacity, a request for a key with no bucket is DENIED with a
 * Retry-After equal to the time until the earliest tracked bucket expires —
 * still-valid buckets are never evicted and budgets are never silently
 * reset. `size()`, `evictions()` and `capacityRejections()` expose read-only
 * metrics for tests and operations.
 */
export function createFixedWindowRateLimiter(
  options: FixedWindowRateLimiterOptions,
): FixedWindowRateLimiter {
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1) {
    throw new Error('rate limit maxRequests must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
    throw new Error('rate limit windowMs must be a positive safe integer');
  }
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
    throw new Error('rate limit maxBuckets must be a positive safe integer');
  }
  const sweepIntervalMs = options.sweepIntervalMs ?? options.windowMs;
  if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
    throw new Error('rate limit sweepIntervalMs must be a positive safe integer');
  }
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweepAt = now();
  let observedTime = lastSweepAt;
  let evictionCount = 0;
  let capacityRejectionCount = 0;

  return {
    consume(key: string) {
      // Fixed-length windows expire in insertion order; clamp clock rollback.
      const t = Math.max(now(), observedTime);
      observedTime = t;
      // Amortized TTL sweep: at most one O(n) pass per sweepIntervalMs.
      if (t - lastSweepAt >= sweepIntervalMs) {
        lastSweepAt = t;
        for (const [bucketKey, bucket] of buckets) {
          if (t >= bucket.resetAt) {
            buckets.delete(bucketKey);
            evictionCount += 1;
          }
        }
      }
      let bucket = buckets.get(key);
      if (!bucket || t >= bucket.resetAt) {
        if (!bucket && buckets.size >= maxBuckets) {
          // Overload policy: refuse the new key instead of evicting a live
          // bucket. The map is non-empty here (size >= maxBuckets >= 1), so
          // the earliest resetAt is always finite. Retry-After is the time
          // until that bucket expires and a sweep may free capacity.
          capacityRejectionCount += 1;
          const earliestResetAt = buckets.values().next().value!.resetAt;
          const retryAfterSeconds = Math.max(1, Math.ceil((earliestResetAt - t) / 1000));
          return { allowed: false, retryAfterSeconds };
        }
        bucket = { count: 0, resetAt: t + options.windowMs };
        // Reopening an expired key moves its new deadline to the end.
        buckets.delete(key);
        buckets.set(key, bucket);
      }
      if (bucket.count >= options.maxRequests) {
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - t) / 1000));
        return { allowed: false, retryAfterSeconds };
      }
      bucket.count += 1;
      return { allowed: true };
    },
    reset() {
      buckets.clear();
      evictionCount = 0;
      capacityRejectionCount = 0;
      lastSweepAt = now();
      observedTime = lastSweepAt;
    },
    size() {
      return buckets.size;
    },
    evictions() {
      return evictionCount;
    },
    capacityRejections() {
      return capacityRejectionCount;
    },
  };
}

/**
 * PERIPH-P1-c: follow / feed / notification admission accepts the in-process
 * limiter (existing HTTP 429 tests) or the shared Redis family. Redis
 * failures surface as `failed` so transport can 503 without fabricating
 * quota facts.
 */
export type ProductAdmissionRateLimiter = FixedWindowRateLimiter | ProductSurfaceRateLimiter;

/**
 * Contract COMMUNITY_RATE_LIMITS families (CS): each name maps to one
 * sealed product-surface purpose (`community-vote`, `community-comment`,
 * `community-curation`, `community-public-reads`), so the four budgets
 * never share a counter. Route admission picks the family per endpoint;
 * the consume subject is `account:<id>` for an authenticated session and
 * `ip:<trusted client>` otherwise.
 */
export type CommunityRateLimitFamily = 'vote' | 'comment' | 'curation' | 'publicReads';

export interface CommunityRateLimiters {
  readonly vote: ProductAdmissionRateLimiter;
  readonly comment: ProductAdmissionRateLimiter;
  readonly curation: ProductAdmissionRateLimiter;
  readonly publicReads: ProductAdmissionRateLimiter;
}

export type ProductAdmissionConsumeResult =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'denied'; readonly retryAfterSeconds: number }
  | { readonly kind: 'failed' };

export function isProductSurfaceRateLimiter(
  limiter: ProductAdmissionRateLimiter,
): limiter is ProductSurfaceRateLimiter {
  return typeof (limiter as ProductSurfaceRateLimiter).readiness === 'function';
}

export async function consumeProductAdmission(
  limiter: ProductAdmissionRateLimiter,
  key: string,
): Promise<ProductAdmissionConsumeResult> {
  if (isProductSurfaceRateLimiter(limiter)) {
    const outcome = await limiter.consume(key);
    if (outcome.kind === 'failed') return { kind: 'failed' };
    if (outcome.kind === 'denied') {
      return { kind: 'denied', retryAfterSeconds: outcome.decision.retryAfterSeconds };
    }
    return { kind: 'allowed' };
  }
  const decision = limiter.consume(key);
  if (!decision.allowed) {
    return { kind: 'denied', retryAfterSeconds: decision.retryAfterSeconds };
  }
  return { kind: 'allowed' };
}

export function isAuthRateLimitedPath(urlPath: string): boolean {
  return authRateLimitRouteFamilyForPath(urlPath) !== null;
}

/**
 * Sealed auth route families. The family is the route dimension of the
 * shared rate-limit key (FIX-M-001): OIDC, session, me, sign-in, sign-up,
 * otp, reset, link, mfa and oauth-callback budgets never share a counter.
 * Task A4/C4: the mapping is derived from the single auth-route manifest;
 * the avatar upload route shares the 'me' family, so a client that exhausts
 * its profile budget (PATCH /me or avatar uploads) is throttled across BOTH
 * surfaces by one counter — the sealed family list itself is manifest-owned.
 */
const AUTH_RATE_LIMIT_FAMILY_BY_PATH: Readonly<Record<string, AuthRateLimitRouteFamily>> =
  buildAuthRateLimitFamilyMap();

/** Derive the path→family map from the manifest (conflict = programming error). */
function buildAuthRateLimitFamilyMap(
  entries: readonly AuthRouteManifestEntry[] = AUTH_ROUTE_MANIFEST,
): Readonly<Record<string, AuthRateLimitRouteFamily>> {
  const map: Record<string, AuthRateLimitRouteFamily> = {};
  for (const entry of entries) {
    if (entry.rateLimitFamily === null) continue;
    const existing: AuthRateLimitRouteFamily | undefined = map[entry.path];
    if (existing !== undefined && existing !== entry.rateLimitFamily) {
      throw new Error(
        `auth manifest assigns conflicting rate-limit families for ${entry.path}: ${existing} vs ${entry.rateLimitFamily}`,
      );
    }
    map[entry.path] = entry.rateLimitFamily;
  }
  return map;
}

/**
 * Fastify-style path match: exact templates stay exact; `:param` matches one
 * non-empty segment. Rejects extra/missing segments and substring hits.
 */
function authRateLimitPathMatches(template: string, urlPath: string): boolean {
  if (template === urlPath) return true;
  if (!template.includes(':')) return false;
  const templateParts = template.split('/');
  const urlParts = urlPath.split('/');
  if (templateParts.length !== urlParts.length) return false;
  for (let i = 0; i < templateParts.length; i += 1) {
    const expected = templateParts[i]!;
    const actual = urlParts[i]!;
    if (expected.startsWith(':') && expected.length > 1) {
      if (actual.length === 0) return false;
      continue;
    }
    if (expected !== actual) return false;
  }
  return true;
}

function lookupAuthRateLimitFamily(
  urlPath: string,
  familyByPath: Readonly<Record<string, AuthRateLimitRouteFamily>>,
): AuthRateLimitRouteFamily | null {
  const exact = familyByPath[urlPath];
  if (exact !== undefined) return exact;
  for (const [template, family] of Object.entries(familyByPath)) {
    if (authRateLimitPathMatches(template, urlPath)) return family;
  }
  return null;
}

/** Route family for an auth path, or null for any non-auth path. */
export function authRateLimitRouteFamilyForPath(urlPath: string): AuthRateLimitRouteFamily | null {
  return lookupAuthRateLimitFamily(urlPath, AUTH_RATE_LIMIT_FAMILY_BY_PATH);
}

/**
 * Auth rate-limit subject: trusted client IP + route family. The client IP
 * is Fastify's `request.ip`, which only honors X-Forwarded-For when
 * `trustProxy` is configured (trusted-ingress allowlist, or the legacy hop
 * count in non-production) — the trusted proxy resolution ALWAYS runs
 * before the key is built (never raw spoofable forwarded headers).
 */
export function authRateLimitSubjectFor(request: FastifyRequest, urlPath: string): AuthRateLimitSubject | null {
  return authRateLimitSubjectForPath(request, urlPath, AUTH_RATE_LIMIT_FAMILY_BY_PATH);
}

/** Subject resolution against an explicit family map (install-time mode). */
function authRateLimitSubjectForPath(
  request: FastifyRequest,
  urlPath: string,
  familyByPath: Readonly<Record<string, AuthRateLimitRouteFamily>>,
): AuthRateLimitSubject | null {
  const routeFamily = lookupAuthRateLimitFamily(urlPath, familyByPath);
  if (routeFamily === null) return null;
  const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
  return { routeFamily, clientIp: ip };
}

/**
 * In-memory auth rate limiter over the single-process fixed-window limiter
 * (unit tests and single-instance deployments). The port is async so the
 * shared Redis adapter and the memory adapter share one contract.
 */
export interface MemoryAuthRateLimiter extends AuthRateLimiter {
  /** Test helper: clear all buckets and reset counters. */
  reset(): void;
  /** Test helper: current bucket size (approximate). */
  size(): number;
  /** Cumulative expired-bucket TTL evictions (read-only metric). */
  evictions(): number;
  /** Cumulative new-key denials at capacity (read-only metric). */
  capacityRejections(): number;
}

export function createMemoryAuthRateLimiter(
  options: FixedWindowRateLimiterOptions,
): MemoryAuthRateLimiter {
  const inner = createFixedWindowRateLimiter(options);
  return {
    async consume(subject: AuthRateLimitSubject): Promise<AuthRateLimitOutcome> {
      const result = inner.consume(`${subject.routeFamily}|${subject.clientIp}`);
      if (result.allowed) {
        return { kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 } };
      }
      return { kind: 'denied', decision: { allowed: false, retryAfterSeconds: result.retryAfterSeconds } };
    },
    readiness() {
      return { status: 'healthy', reason: 'none', lastCheckedAtEpochMs: Date.now() };
    },
    async close() {
      // The in-memory limiter owns no external resources.
    },
    reset() {
      inner.reset();
    },
    size() {
      return inner.size();
    },
    evictions() {
      return inner.evictions();
    },
    capacityRejections() {
      return inner.capacityRejections();
    },
  };
}

/**
 * Client key for auth rate limits.
 * Uses Fastify's `request.ip`, which only honors X-Forwarded-For when
 * `trustProxy` is configured (trusted-ingress allowlist, or the legacy hop
 * count in non-production). Never read spoofable forwarded headers directly.
 */
export function rateLimitClientKey(request: FastifyRequest, routePath: string): string {
  const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
  return `${routePath}|${ip}`;
}

// ---------------------------------------------------------------------------
// FIX-M-006 Search rate limiter: in-memory adapter over the single-process
// fixed-window limiter, mirroring the auth memory adapter. The port is async
// so the shared Redis adapter and the memory adapter share one contract. The
// anonymous family keys on the TRUSTED client IP, the account family on the
// account id, and each family carries its OWN budget (the anonymous budget
// is independent from the auth parameters — PUB-R03).
// ---------------------------------------------------------------------------

export interface MemorySearchRateLimiterOptions {
  /** Anonymous Search budget per fixed window (trusted client IP). */
  readonly anonymousMaxRequests: number;
  /** Authenticated Search budget per fixed window (account id). */
  readonly accountMaxRequests: number;
  readonly windowMs: number;
  readonly now?: () => number;
  /** Hard cap on tracked buckets per family (default 100_000). */
  readonly maxBuckets?: number;
  /** Minimum interval between TTL sweeps (default windowMs). */
  readonly sweepIntervalMs?: number;
}

export interface MemorySearchRateLimiter extends SearchRateLimiter {
  /** Test helper: clear all buckets and reset counters. */
  reset(): void;
  /** Test helper: current bucket size across both families (approximate). */
  size(): number;
}

export function createMemorySearchRateLimiter(
  options: MemorySearchRateLimiterOptions,
): MemorySearchRateLimiter {
  const anonymousInner = createFixedWindowRateLimiter({
    maxRequests: options.anonymousMaxRequests,
    windowMs: options.windowMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxBuckets === undefined ? {} : { maxBuckets: options.maxBuckets }),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
  });
  const accountInner = createFixedWindowRateLimiter({
    maxRequests: options.accountMaxRequests,
    windowMs: options.windowMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxBuckets === undefined ? {} : { maxBuckets: options.maxBuckets }),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
  });
  const policy: Readonly<Record<SearchRateLimitRouteFamily, string>> = Object.freeze({
    anonymous: `search:anonymous:${options.anonymousMaxRequests}:${options.windowMs}`,
    account: `search:account:${options.accountMaxRequests}:${options.windowMs}`,
  });
  const consumeInner = (subject: SearchRateLimitSubject) =>
    (subject.family === 'anonymous' ? anonymousInner : accountInner)
      .consume(`${subject.family}|${subject.subject}`);
  return {
    async consume(subject: SearchRateLimitSubject): Promise<SearchRateLimitOutcome> {
      const result = consumeInner(subject);
      if (result.allowed) {
        return { kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 } };
      }
      return { kind: 'denied', decision: { allowed: false, retryAfterSeconds: result.retryAfterSeconds } };
    },
    readiness() {
      return { status: 'healthy', reason: 'none', lastCheckedAtEpochMs: Date.now() };
    },
    policy,
    async close() {
      // The in-memory limiter owns no external resources.
    },
    reset() {
      anonymousInner.reset();
      accountInner.reset();
    },
    size() {
      return anonymousInner.size() + accountInner.size();
    },
  };
}

export interface MemorySyncColpRateLimiterOptions {
  readonly pushMaxRequests: number;
  readonly pushWindowMs: number;
  readonly pullMaxRequests: number;
  readonly pullWindowMs: number;
  readonly now?: () => number;
  readonly maxBuckets?: number;
  readonly sweepIntervalMs?: number;
}

export interface MemorySyncColpRateLimiter extends SyncColpRateLimiter {
  reset(): void;
  size(): number;
}

/**
 * P-09 in-process Sync COLP limiter: two independent fixed-window maps so
 * push and pull never share a counter. Capacity exhaustion is fail-closed
 * (denied) like today's in-route `createFixedWindowRateLimiter`.
 */
export function createMemorySyncColpRateLimiter(
  options: MemorySyncColpRateLimiterOptions,
): MemorySyncColpRateLimiter {
  const innerOptions = {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxBuckets === undefined ? {} : { maxBuckets: options.maxBuckets }),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
  };
  const pushInner = createFixedWindowRateLimiter({
    maxRequests: options.pushMaxRequests,
    windowMs: options.pushWindowMs,
    ...innerOptions,
  });
  const pullInner = createFixedWindowRateLimiter({
    maxRequests: options.pullMaxRequests,
    windowMs: options.pullWindowMs,
    ...innerOptions,
  });
  const policy: Readonly<Record<SyncColpRateLimitRouteFamily, string>> = Object.freeze({
    push: `sync:push:${options.pushMaxRequests}:${options.pushWindowMs}`,
    pull: `sync:pull:${options.pullMaxRequests}:${options.pullWindowMs}`,
  });
  const consumeInner = (subject: SyncColpRateLimitSubject) =>
    (subject.family === 'push' ? pushInner : pullInner).consume(subject.clientIp);
  return {
    async consume(subject: SyncColpRateLimitSubject): Promise<SyncColpRateLimitOutcome> {
      const result = consumeInner(subject);
      if (result.allowed) {
        return { kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 } };
      }
      return { kind: 'denied', decision: { allowed: false, retryAfterSeconds: result.retryAfterSeconds } };
    },
    readiness() {
      return { status: 'healthy', reason: 'none', lastCheckedAtEpochMs: Date.now() };
    },
    policy,
    async close() {
      // The in-memory limiter owns no external resources.
    },
    reset() {
      pushInner.reset();
      pullInner.reset();
    },
    size() {
      return pushInner.size() + pullInner.size();
    },
  };
}

// ---------------------------------------------------------------------------
// FIX-M-013 (SYNC-R08) effect-page rate limiter: single-instance memory
// adapter over the single-process fixed-window limiter, mirroring the auth
// and search adapters. The port is async so a shared adapter and this memory
// adapter share one contract. Each request consumes the SUBJECT total bucket
// (trusted client IP + session + replica) and then the per-EFFECT sub-bucket
// (… + effect id). Page indices are deliberately NOT part of any key: a
// client rotating pages must never mint a fresh budget.
// ---------------------------------------------------------------------------

export interface MemoryEffectPageRateLimiterOptions {
  /** Subject total budget per fixed window (trusted client + session + replica). */
  readonly subjectMaxRequests: number;
  /** Per-effect sub-budget per fixed window (… + effect id). */
  readonly effectMaxRequests: number;
  readonly windowMs: number;
  readonly now?: () => number;
  /** Hard cap on tracked buckets per family (default 100_000). */
  readonly maxBuckets?: number;
  /** Minimum interval between TTL sweeps (default windowMs). */
  readonly sweepIntervalMs?: number;
}

export interface MemoryEffectPageRateLimiter extends EffectPageRateLimiter {
  /** Test helper: clear all buckets and reset counters. */
  reset(): void;
  /** Test helper: current bucket size across both families (approximate). */
  size(): number;
}

export function createMemoryEffectPageRateLimiter(
  options: MemoryEffectPageRateLimiterOptions,
): MemoryEffectPageRateLimiter {
  const subjectInner = createFixedWindowRateLimiter({
    maxRequests: options.subjectMaxRequests,
    windowMs: options.windowMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxBuckets === undefined ? {} : { maxBuckets: options.maxBuckets }),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
  });
  const effectInner = createFixedWindowRateLimiter({
    maxRequests: options.effectMaxRequests,
    windowMs: options.windowMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxBuckets === undefined ? {} : { maxBuckets: options.maxBuckets }),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
  });
  const decide = (subject: EffectPageRateLimitSubject): EffectPageRateLimitOutcome => {
    const subjectKey = `${subject.clientIp}|${subject.sessionId}|${subject.replicaId}`;
    const total = subjectInner.consume(subjectKey);
    if (!total.allowed) {
      return { kind: 'denied', decision: {
        allowed: false, retryAfterSeconds: total.retryAfterSeconds, family: 'subject' } };
    }
    const perEffect = effectInner.consume(`${subjectKey}|${subject.effectId}`);
    if (!perEffect.allowed) {
      return { kind: 'denied', decision: {
        allowed: false, retryAfterSeconds: perEffect.retryAfterSeconds, family: 'effect' } };
    }
    return { kind: 'allowed', decision: {
      allowed: true, retryAfterSeconds: 0, family: 'subject' } };
  };
  return {
    async consume(subject: EffectPageRateLimitSubject): Promise<EffectPageRateLimitOutcome> {
      return decide(subject);
    },
    readiness() {
      return { status: 'healthy', reason: 'none', lastCheckedAtEpochMs: Date.now() };
    },
    async close() {
      // The in-memory limiter owns no external resources.
    },
    reset() {
      subjectInner.reset();
      effectInner.reset();
    },
    size() {
      return subjectInner.size() + effectInner.size();
    },
  };
}

/**
 * Minimal header writer: FastifyReply satisfies it directly, and raw
 * http.ServerResponse bad-URL handlers adapt it with a setHeader wrapper so
 * every surface emits the same security baseline (FIX-L-004).
 */
export interface SecurityHeaderWriter {
  header(name: string, value: string): unknown;
}

/** Security headers appropriate for API + browser-auth JSON/redirect responses. */
export function applySecurityHeaders(
  reply: SecurityHeaderWriter,
  options: { readonly enableHsts: boolean },
): void {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  );
  reply.header('Cross-Origin-Resource-Policy', 'same-site');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  if (options.enableHsts) {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

export interface InstallHttpSecurityOptions {
  readonly security: HttpSecurityConfig;
  /**
   * Auth rate limiter. Production multi-replica compositions inject the
   * shared Redis adapter; tests inject the memory adapter. Defaults to the
   * in-process limiter from config, which is refused when the shared adapter
   * is configured but not injected (composition guard).
   */
  readonly authRateLimiter?: AuthRateLimiter;
  /** Optional fixed-label auth rate-limit decision metrics. */
  readonly metrics?: Metrics;
  /**
   * F2: Better Auth mode removes the legacy OIDC routes from the
   * composition, so the legacy OIDC rate-limit families must not be live:
   * requests to /api/v1/auth/oidc/* consume no bucket and carry no
   * RateLimit-Policy. The exported stateless helpers keep the full manifest
   * view (legacy mode; F3 removes the families).
   */
  readonly excludeLegacyOidcFamilies?: boolean;
}

export function installHttpSecurity(
  app: FastifyInstance,
  options: InstallHttpSecurityOptions,
): AuthRateLimiter {
  const { maxRequests, windowMs } = options.security.authRateLimit;
  let limiter = options.authRateLimiter;
  if (limiter === undefined) {
    if (options.security.authRateLimit.shared.enabled) {
      throw new Error(
        'installHttpSecurity requires an injected authRateLimiter when AUTH_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
      );
    }
    limiter = createMemoryAuthRateLimiter({ maxRequests, windowMs });
  }
  const enableHsts = options.security.enableHsts;
  const metrics = options.metrics;
  // F2: BA mode derives the family map from the manifest WITHOUT the legacy
  // OIDC entries (see InstallHttpSecurityOptions.excludeLegacyOidcFamilies).
  const familyByPath = options.excludeLegacyOidcFamilies
    ? buildAuthRateLimitFamilyMap(AUTH_ROUTE_MANIFEST.filter((entry) => entry.scope !== 'legacy-oidc'))
    : buildAuthRateLimitFamilyMap();

  app.addHook('onRequest', async (request, reply) => {
    applySecurityHeaders(reply, { enableHsts });

    const path = request.url.split('?', 1)[0] ?? request.url;
    const subject = authRateLimitSubjectForPath(request, path, familyByPath);
    if (subject === null) return;

    const outcome = await limiter.consume(subject);
    if (outcome.kind === 'allowed') {
      metrics?.increment('auth.rate_limit.decision.allowed');
      return;
    }
    if (outcome.kind === 'denied') {
      metrics?.increment('auth.rate_limit.decision.denied');
      throw new ProductHttpError({
        statusCode: 429,
        code: 'rate_limited',
        message: 'Too many requests. Please try again later.',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: outcome.decision.retryAfterSeconds,
        headers: {
          'Retry-After': String(outcome.decision.retryAfterSeconds),
          'RateLimit-Policy': `auth:${subject.routeFamily}:${maxRequests}:${windowMs}`,
        },
      });
    }

    // Shared-store failure: explicit fail-closed response. A 503 never
    // fabricates quota facts (no Retry-After / RateLimit-Policy) — an auth
    // outage must never silently admit unlimited traffic.
    metrics?.increment('auth.rate_limit.decision.unavailable');
    throw new ProductHttpError({
      statusCode: 503,
      code: 'feature_temporarily_unavailable',
      message: 'Rate limiting service is temporarily unavailable. Please try again later.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
    });
  });

  return limiter;
}
