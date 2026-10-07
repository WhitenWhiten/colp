/**
 * Product-surface rate-limit HMAC
 * key codec.
 *
 * Independent of auth/search/explore/sync/insights/invite purpose strings.
 * Hash-tag purpose is a sealed surface token;
 * the single family token is `admission` so one surface never shares a
 * counter with another even when Redis URL/prefix are reused.
 *
 * Canonical key (each purpose has an independent default prefix; production
 * may use one umbrella prefix because the sealed purpose remains in the key):
 *
 *   known-product-route:<env>:ratelimit:v1:{library-order:<subjectHmac>}:admission:<window>
 *
 * Subject is the existing in-process consume key (trusted client IP × path,
 * or principal × endpoint family). The raw subject never enters the key text.
 */
import { createHmac } from 'node:crypto';

export const PRODUCT_SURFACE_RATE_LIMIT_PURPOSES = Object.freeze([
  'follow', 'collection-follow', 'feed', 'notification',
  'library-order', 'favicon-policy', 'link-health', 'classify-inbox', 'classification-profile', 'classification-run', 'classification-settings', 'classification-preview', 'classification-confirmation', 'export-job',
  'organize-plan', 'collection-version', 'readable-replica', 'public-object', 'reports',
  'community-vote', 'community-comment', 'community-curation', 'community-public-reads',
  'credentials', 'credential-issuance',
  'automation-token-credential', 'automation-token-client', 'credits-read',
  'governance-report', 'governance-action', 'governance-appeal',
] as const);
export type ProductSurfaceRateLimitPurpose = (typeof PRODUCT_SURFACE_RATE_LIMIT_PURPOSES)[number];

export const PRODUCT_SURFACE_RATE_LIMIT_FAMILY = 'admission' as const;
export type ProductSurfaceRateLimitFamily = typeof PRODUCT_SURFACE_RATE_LIMIT_FAMILY;

export const PRODUCT_SURFACE_RATE_LIMIT_DEFAULT_PREFIX = Object.freeze({
  follow: 'known-follow',
  'collection-follow': 'known-collection-follow',
  feed: 'known-feed',
  notification: 'known-notification',
  'library-order': 'known-library-order',
  'favicon-policy': 'known-favicon-policy',
  'link-health': 'known-link-health',
  'classify-inbox': 'known-classify-inbox',
  'classification-settings': 'known-classification-settings',
  'classification-profile': 'known-classification-profile',
  'classification-run': 'known-classification-run',
  'classification-preview': 'known-classification-preview',
  'classification-confirmation': 'known-classification-confirmation',
  'export-job': 'known-export-job',
  'organize-plan': 'known-organize-plan',
  'collection-version': 'known-collection-version',
  'readable-replica': 'known-readable-replica',
  'public-object': 'known-public-object',
  reports: 'known-reports',
  'community-vote': 'known-community-vote',
  'community-comment': 'known-community-comment',
  'community-curation': 'known-community-curation',
  'community-public-reads': 'known-community-public-reads',
  credentials: 'known-credentials',
  'credential-issuance': 'known-credential-issuance',
  'automation-token-credential': 'known-automation-token-credential',
  'automation-token-client': 'known-automation-token-client',
  'credits-read': 'known-credits-read',
  'governance-report': 'known-governance-report',
  'governance-action': 'known-governance-action',
  'governance-appeal': 'known-governance-appeal',
} as const satisfies Record<ProductSurfaceRateLimitPurpose, string>);

export const PRODUCT_SURFACE_RATE_LIMIT_KEY_SCHEMA_VERSION = 1;
export const PRODUCT_SURFACE_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
export const PRODUCT_SURFACE_RATE_LIMIT_KEY_MAX_LENGTH = 512;
export const PRODUCT_SURFACE_RATE_LIMIT_SUBJECT_MAX_LENGTH = 256;

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const PRODUCT_SURFACE_RATE_LIMIT_KEY_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):ratelimit:v1:\{(automation-token-client|automation-token-credential|credits-read|collection-follow|collection-version|readable-replica|classify-inbox|library-order|organize-plan|public-object|credential-issuance|credentials|reports|link-health|export-job|favicon-policy|notification|follow|feed|community-vote|community-comment|community-curation|community-public-reads|governance-report|governance-action|governance-appeal):([A-Za-z0-9_-]{32})\}:admission:(\d{1,16})$/u;

export interface ProductSurfaceRateLimitKeyBuildInput {
  readonly keyPrefix?: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly purpose: ProductSurfaceRateLimitPurpose;
  readonly subject: string;
  readonly windowStartEpochMs: number;
}

export type ProductSurfaceRateLimitKeyRejectReason =
  | 'malformed'
  | 'invalid_prefix'
  | 'invalid_environment'
  | 'invalid_purpose'
  | 'invalid_window'
  | 'key_too_long';

export interface ProductSurfaceRateLimitKeyParts {
  readonly keyPrefix: string;
  readonly environment: string;
  readonly schemaVersion: 1;
  readonly purpose: ProductSurfaceRateLimitPurpose;
  readonly subjectHmac: string;
  readonly family: ProductSurfaceRateLimitFamily;
  readonly windowStartEpochMs: number;
}

export type ProductSurfaceRateLimitKeyParseResult =
  | { readonly kind: 'ok'; readonly parts: ProductSurfaceRateLimitKeyParts }
  | { readonly kind: 'rejected'; readonly reason: ProductSurfaceRateLimitKeyRejectReason };

export class ProductSurfaceRateLimitKeyError extends Error {
  readonly reason: ProductSurfaceRateLimitKeyRejectReason;
  constructor(reason: ProductSurfaceRateLimitKeyRejectReason, message: string) {
    super(message);
    this.name = 'ProductSurfaceRateLimitKeyError';
    this.reason = reason;
  }
}

export function assertProductSurfaceRateLimitSubject(subject: string): void {
  if (typeof subject !== 'string' || subject.length === 0
    || subject.length > PRODUCT_SURFACE_RATE_LIMIT_SUBJECT_MAX_LENGTH) {
    throw new ProductSurfaceRateLimitKeyError(
      'malformed',
      `product-surface rate-limit subject must be 1-${PRODUCT_SURFACE_RATE_LIMIT_SUBJECT_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(subject)) {
    throw new ProductSurfaceRateLimitKeyError(
      'malformed',
      'product-surface rate-limit subject must not contain control characters',
    );
  }
}

export function productSurfaceRateLimitSubjectHmac(keySecret: Buffer, subject: string): string {
  assertProductSurfaceRateLimitSubject(subject);
  return createHmac('sha256', keySecret)
    .update(subject, 'utf8')
    .digest('base64url')
    .slice(0, PRODUCT_SURFACE_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
}

export function parseProductSurfaceRateLimitKey(key: string): ProductSurfaceRateLimitKeyParseResult {
  if (typeof key !== 'string' || key.length === 0 || key.length > PRODUCT_SURFACE_RATE_LIMIT_KEY_MAX_LENGTH) {
    return { kind: 'rejected', reason: 'malformed' };
  }
  const match = PRODUCT_SURFACE_RATE_LIMIT_KEY_PATTERN.exec(key);
  if (!match) return { kind: 'rejected', reason: 'malformed' };
  const windowRaw = match[5]!;
  if (windowRaw.length > 1 && windowRaw.startsWith('0')) {
    return { kind: 'rejected', reason: 'invalid_window' };
  }
  const windowStartEpochMs = Number(windowRaw);
  if (!Number.isSafeInteger(windowStartEpochMs)) {
    return { kind: 'rejected', reason: 'invalid_window' };
  }
  return {
    kind: 'ok',
    parts: Object.freeze({
      keyPrefix: match[1]!,
      environment: match[2]!,
      schemaVersion: PRODUCT_SURFACE_RATE_LIMIT_KEY_SCHEMA_VERSION,
      purpose: match[3] as ProductSurfaceRateLimitPurpose,
      subjectHmac: match[4]!,
      family: PRODUCT_SURFACE_RATE_LIMIT_FAMILY,
      windowStartEpochMs,
    }),
  };
}

export function buildProductSurfaceRateLimitKey(input: ProductSurfaceRateLimitKeyBuildInput): string {
  const keyPrefix = input.keyPrefix ?? PRODUCT_SURFACE_RATE_LIMIT_DEFAULT_PREFIX[input.purpose];
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new ProductSurfaceRateLimitKeyError(
      'invalid_prefix',
      'product-surface rate-limit key prefix must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new ProductSurfaceRateLimitKeyError(
      'invalid_environment',
      'product-surface rate-limit key environment must be 1-64 characters of [A-Za-z0-9_.-]',
    );
  }
  if (!PRODUCT_SURFACE_RATE_LIMIT_PURPOSES.includes(input.purpose)) {
    throw new ProductSurfaceRateLimitKeyError(
      'invalid_purpose',
      `unknown product-surface rate-limit purpose: ${String(input.purpose)}`,
    );
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new ProductSurfaceRateLimitKeyError(
      'invalid_window',
      'product-surface rate-limit key window must be a non-negative safe integer',
    );
  }
  const subjectHmac = productSurfaceRateLimitSubjectHmac(input.keySecret, input.subject);
  const key = `${keyPrefix}:${input.environment}:ratelimit:v${PRODUCT_SURFACE_RATE_LIMIT_KEY_SCHEMA_VERSION}`
    + `:{${input.purpose}:${subjectHmac}}:${PRODUCT_SURFACE_RATE_LIMIT_FAMILY}:${input.windowStartEpochMs}`;
  if (key.length > PRODUCT_SURFACE_RATE_LIMIT_KEY_MAX_LENGTH) {
    throw new ProductSurfaceRateLimitKeyError(
      'key_too_long',
      `product-surface rate-limit key exceeds ${PRODUCT_SURFACE_RATE_LIMIT_KEY_MAX_LENGTH} characters`,
    );
  }
  if (parseProductSurfaceRateLimitKey(key).kind !== 'ok') {
    throw new ProductSurfaceRateLimitKeyError(
      'malformed',
      'built product-surface rate-limit key failed canonical parse',
    );
  }
  return key;
}
