/**
 * Publishing Insights ingest rate-limit HMAC key codec (PI-02).
 *
 * Deliberately independent from auth/search/attachment codecs: unique hash-tag
 * purpose `insights-ingest` and sealed family `publishing-insights-ingest`.
 *
 * Canonical key layout:
 *
 *   known:<env>:ratelimit:v1:{insights-ingest:<subjectHmac>}:publishing-insights-ingest:<window>
 *
 * subjectHmac is base64url-truncated HMAC-SHA-256 over the quota identity
 * (visitor + collection + eventType [+ node]). Raw IP, UA, cookie, and
 * subject id never enter the key text. Anonymous visitor material is
 * always `ipua|{/24|/56}|ua-class` — a cookie is not a quota subject.
 */
import { createHmac } from 'node:crypto';

export const PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_FAMILY = 'publishing-insights-ingest' as const;
export type PublishingInsightsIngestRateLimitFamily =
  typeof PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_FAMILY;

export const PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_KEY_SCHEMA_VERSION = 1;
export const PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
export const PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_KEY_MAX_LENGTH = 512;
export const PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_SUBJECT_MAX_LENGTH = 512;

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const KEY_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):ratelimit:v1:\{insights-ingest:([A-Za-z0-9_-]{32})\}:publishing-insights-ingest:(\d{1,16})$/u;

export interface PublishingInsightsIngestRateLimitKeyBuildInput {
  readonly keyPrefix?: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly subject: string;
  readonly windowStartEpochMs: number;
}

export type PublishingInsightsIngestRateLimitKeyRejectReason =
  | 'malformed'
  | 'invalid_prefix'
  | 'invalid_environment'
  | 'invalid_subject_hmac'
  | 'invalid_window'
  | 'key_too_long';

export class PublishingInsightsIngestRateLimitKeyError extends Error {
  readonly reason: PublishingInsightsIngestRateLimitKeyRejectReason;
  constructor(reason: PublishingInsightsIngestRateLimitKeyRejectReason, message: string) {
    super(message);
    this.name = 'PublishingInsightsIngestRateLimitKeyError';
    this.reason = reason;
  }
}

export function assertPublishingInsightsIngestRateLimitSubject(subject: string): void {
  if (typeof subject !== 'string' || subject.length === 0
    || subject.length > PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_SUBJECT_MAX_LENGTH) {
    throw new PublishingInsightsIngestRateLimitKeyError(
      'malformed',
      `publishing-insights ingest rate-limit subject must be 1-${PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_SUBJECT_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(subject)) {
    throw new PublishingInsightsIngestRateLimitKeyError(
      'malformed',
      'publishing-insights ingest rate-limit subject must not contain control characters',
    );
  }
}

export function publishingInsightsIngestRateLimitSubjectHmac(keySecret: Buffer, subject: string): string {
  assertPublishingInsightsIngestRateLimitSubject(subject);
  return createHmac('sha256', keySecret)
    .update(subject, 'utf8')
    .digest('base64url')
    .slice(0, PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
}

export function buildPublishingInsightsIngestRateLimitKey(
  input: PublishingInsightsIngestRateLimitKeyBuildInput,
): string {
  const keyPrefix = input.keyPrefix ?? 'known';
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new PublishingInsightsIngestRateLimitKeyError(
      'invalid_prefix',
      'publishing-insights ingest rate-limit key prefix is invalid',
    );
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new PublishingInsightsIngestRateLimitKeyError(
      'invalid_environment',
      'publishing-insights ingest rate-limit key environment is invalid',
    );
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new PublishingInsightsIngestRateLimitKeyError(
      'invalid_window',
      'publishing-insights ingest rate-limit key window must be a non-negative safe integer',
    );
  }
  const subjectHmac = publishingInsightsIngestRateLimitSubjectHmac(input.keySecret, input.subject);
  const key = `${keyPrefix}:${input.environment}:ratelimit:v${PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_KEY_SCHEMA_VERSION}`
    + `:{insights-ingest:${subjectHmac}}:${PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_FAMILY}:${input.windowStartEpochMs}`;
  if (key.length > PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_KEY_MAX_LENGTH) {
    throw new PublishingInsightsIngestRateLimitKeyError(
      'key_too_long',
      `publishing-insights ingest rate-limit key exceeds ${PUBLISHING_INSIGHTS_INGEST_RATE_LIMIT_KEY_MAX_LENGTH} characters`,
    );
  }
  if (!KEY_PATTERN.test(key)) {
    throw new PublishingInsightsIngestRateLimitKeyError(
      'malformed',
      'built publishing-insights ingest rate-limit key failed canonical parse',
    );
  }
  return key;
}

export const PUBLISHING_INSIGHTS_VIEW_PREVIEW_WINDOW_MS = 30 * 60 * 1000;
export const PUBLISHING_INSIGHTS_RESOURCE_OPEN_WINDOW_MS = 5 * 60 * 1000;
