/**
 * P4A-RL02 rate-limit HTTP header mapping contract (P01 frozen header
 * contract; plan §8 RL02/RL04 "503 must not carry a fabricated Retry-After
 * quota fact").
 *
 * Pure functions only. The frozen OpenAPI contract (`AttachmentRateLimited`
 * vs `AttachmentServiceUnavailable`) maps onto admission outcomes as:
 *
 *  - denied (quota exhausted) -> HTTP 429 with `Retry-After`
 *    (decimal seconds) and the fixed `RateLimit-Policy`
 *    (`attachments-<route-class>:<max>:<window-ms>`) — a REAL quota fact;
 *  - unavailable (infrastructure failure) -> HTTP 503 with NO quota headers:
 *    `Retry-After` and `RateLimit-Policy` are deliberately absent because a
 *    retry delay without an exhausted quota would be a fabricated fact;
 *  - allowed / complete-emergency fallback -> the request proceeds with NO
 *    quota headers. The P01 contract deliberately defines no rate-limit
 *    headers on success; adding any such header would require extending the
 *    frozen OpenAPI contract first (RL04/RL07 follow-up, never silently).
 *
 * `Cache-Control: private,no-store` and `X-Request-Id` belong to the route
 * envelope (already frozen by P01) and are not part of this mapping.
 */
import type { AttachmentAdmissionOutcome, AttachmentRateLimitRouteClass } from './rate-limit-contracts.js';
import { ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES } from './rate-limit-contracts.js';
import {
  ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING,
  ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS,
} from './rate-limit-config.js';
import type { AttachmentRouteRatePolicy } from './rate-limit-route-policy.js';

export const RATE_LIMIT_HEADER_RETRY_AFTER = 'Retry-After';
export const RATE_LIMIT_HEADER_RATE_LIMIT_POLICY = 'RateLimit-Policy';

export type AttachmentRateLimitHttpHeaders = Readonly<Record<string, string>>;

export type AttachmentRateLimitHttpMapping =
  | {
    readonly status: 429;
    readonly headers: Readonly<{ 'Retry-After': string; 'RateLimit-Policy': string }>;
  }
  | {
    readonly status: 503;
    readonly headers: Readonly<Record<string, never>>;
  }
  | {
    readonly status: undefined;
    readonly headers: Readonly<Record<string, never>>;
  };

/**
 * Formats the frozen `RateLimit-Policy` value:
 * `attachments-<route-class>:<rateMax>:<rateWindowMs>` (OpenAPI pattern
 * `^attachments-[a-z-]+:[0-9]+:[0-9]+$`). Fail-closed on unknown route
 * classes and unbounded budgets.
 */
export function formatRateLimitPolicyHeader(
  routeClass: AttachmentRateLimitRouteClass,
  rateMax: number,
  rateWindowMs: number,
): string {
  if (!ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES.includes(routeClass)) {
    throw new RangeError(`unknown rate-limit route class: ${String(routeClass)}`);
  }
  if (!Number.isSafeInteger(rateMax) || rateMax < 1 || rateMax > ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING) {
    throw new RangeError('RateLimit-Policy rateMax must be a bounded positive safe integer');
  }
  if (!Number.isSafeInteger(rateWindowMs) || rateWindowMs < 1 || rateWindowMs > ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS) {
    throw new RangeError('RateLimit-Policy rateWindowMs must be a bounded positive safe integer');
  }
  return `attachments-${routeClass}:${rateMax}:${rateWindowMs}`;
}

/**
 * Maps an admission outcome to its HTTP status and quota headers. Only the
 * exhausted (429) path emits quota headers; 503 and success paths emit none,
 * so an infrastructure failure can never masquerade as a quota fact.
 */
export function mapRateLimitAdmissionToHttp(
  outcome: AttachmentAdmissionOutcome,
  policy: AttachmentRouteRatePolicy,
): AttachmentRateLimitHttpMapping {
  if (outcome.kind === 'denied') {
    return {
      status: 429,
      headers: Object.freeze({
        [RATE_LIMIT_HEADER_RETRY_AFTER]: String(outcome.decision.retryAfterSeconds),
        [RATE_LIMIT_HEADER_RATE_LIMIT_POLICY]: formatRateLimitPolicyHeader(
          policy.routeClass,
          policy.rateMax,
          policy.rateWindowMs,
        ),
      }),
    };
  }
  if (outcome.kind === 'unavailable') {
    return { status: 503, headers: Object.freeze({}) };
  }
  // allowed / complete-emergency fallback: proceed, no quota headers.
  return { status: undefined, headers: Object.freeze({}) };
}
