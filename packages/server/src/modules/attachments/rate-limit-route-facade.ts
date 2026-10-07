/**
 * P4A-RL04 route-facing rate-limit facade contract (plan §2.2.4, §8 RL04).
 *
 * This module-layer contract freezes what the TRANSPORT sees of the composed
 * distributed limiter (no infrastructure types):
 *
 *  - `AttachmentRouteRateLimitFacade` extends the RL02 sealed
 *    `AttachmentAdmissionRateLimiter` (mode + `checkAdmission` +
 *    readiness + close) with the RL02 config, so the routes can resolve the
 *    per-route budget for the frozen `RateLimit-Policy` header without ever
 *    touching the Redis adapter; the implementation lives in
 *    `infrastructure/rate-limit` and satisfies this shape structurally;
 *  - the route handlers call the facade AFTER authentication and cheap
 *    body/schema validation and BEFORE any database/R2 work (plan §2.3:
 *    admission gates expensive work; exhausted requests must create zero
 *    ledger/R2 side effects);
 *  - `ATTACHMENT_RATE_LIMIT_FIXED_SCOPE` is the pre-database stable subject
 *    scope for EVERY attachment route (`issue`, `complete`, `download`,
 *    `status`): the key must be built BEFORE the database read, so the scope
 *    segment is a fixed route token and the per-principal isolation comes
 *    from the HMAC principal segment (plan §2.3: keys never carry
 *    blob/generation identity or raw text). The `issue` route NEVER uses the
 *    client collectionId as a scope — rotating nonexistent collections would
 *    mint fresh per-principal buckets (KA-P4-AM-02); the `status` route
 *    NEVER uses the client blobId as a scope — rotating blobIds would mint
 *    fresh buckets per polled blob (KA-P4-AM-16); a per-collection
 *    sub-budget must use the authoritative collection ID after the database
 *    load and authorization, never the raw body;
 *  - `AttachmentRateLimitLogEntry` is the fixed-class structured log shape
 *    (route/mode/decision/failure class/shadow mismatch only): logs and
 *    metrics never carry a subject, principal, Collection, key, URL or HMAC
 *    (plan §2.3 "metric/log 只记录固定 route、mode、decision、failure
 *    class").
 *
 * Configuration reload is NOT a runtime operation: the mode/budgets are
 * parsed once in `loadConfig` and changing them requires an API restart
 * (rollback = set ATTACHMENTS_RATE_LIMIT_MODE=off and restart, plan §13.3);
 * this boundary is documented here and in the composition.
 */
import type { AttachmentMetricRateLimitDecision } from './attachments-metrics.js';
import type { AttachmentRateLimitConfig } from './rate-limit-config.js';
import type {
  AttachmentAdmissionRateLimiter,
  AttachmentRateLimitRouteClass,
  RateLimitFailureClass,
} from './rate-limit-contracts.js';

/**
 * The pre-database stable subject scope for every attachment route
 * (`issue`, `complete`, `download`, `status`) admission. The
 * tenant/Collection fact is a PostgreSQL read + authorization inside the use
 * cases, so the admission key is built with this fixed token as the scope
 * segment; the HMAC principal segment keeps every subject key per-principal
 * and low-cardinality (plan §2.3). The `issue` route must never use the
 * client collectionId as a scope (KA-P4-AM-02) and the `status` route must
 * never use the client blobId as a scope (KA-P4-AM-16); the raw Collection
 * or blob identity never enters a Redis key or log.
 */
export const ATTACHMENT_RATE_LIMIT_FIXED_SCOPE = 'attachments';

/** Fixed-class rate-limit log entry; never subject/principal/key/URL text. */
export interface AttachmentRateLimitLogEntry {
  readonly routeClass: AttachmentRateLimitRouteClass;
  readonly mode: 'off' | 'shadow' | 'enforce';
  /** The sealed RL01 decision dimension actually recorded for the route. */
  readonly decision: AttachmentMetricRateLimitDecision;
  /** Fixed infrastructure failure class, or null when there was no failure. */
  readonly failureClass: RateLimitFailureClass | null;
  /** True when the Redis decision disagreed with the local reference in shadow mode. */
  readonly shadowMismatch: boolean;
}

/**
 * The route-facing distributed admission facade (RL02
 * `AttachmentAdmissionRateLimiter` + the per-route budgets the frozen
 * `RateLimit-Policy` header needs). Transport and bootstrap only see this
 * module-facade type; the RL03/RL04 infrastructure implementation satisfies
 * it structurally (no ioredis type can leak here).
 */
export interface AttachmentRouteRateLimitFacade extends AttachmentAdmissionRateLimiter {
  /** The full RL02 config (URL/secret REFS only, never secret values). */
  readonly config: AttachmentRateLimitConfig;
}
