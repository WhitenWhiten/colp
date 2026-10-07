/**
 * P4A-I05 private attachment configuration surface.
 *
 * The config object stores only a secret REFERENCE (or later an opaque
 * provider handle) — never a copy of an access key. When the feature is
 * disabled, attachment secrets are not parsed at all, no S3 client is
 * constructed, and no delivery route is registered. Every numeric budget has a
 * compile-time hard ceiling (exported constants) and is validated as a safe
 * integer; bad combinations fail closed inside `loadConfig` BEFORE any
 * network/client/route initialization can happen.
 */
import {
  assertDeliveryOriginNotSameSite,
} from './attachments-origin.js';

// ---- compile-time hard ceilings and development/test defaults -------------
export const ATTACHMENTS_GRANT_TTL_MAX_SECONDS = 300;
export const ATTACHMENTS_GRANT_TTL_DEFAULT_SECONDS = 60;
export const ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES = 64 * 1024 * 1024;
export const ATTACHMENTS_SINGLE_PUT_DEFAULT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENTS_VERIFICATION_LEASE_MAX_MS = 3_600_000;
export const ATTACHMENTS_VERIFICATION_LEASE_DEFAULT_MS = 60_000;
export const ATTACHMENTS_VERIFICATION_TIMEOUT_MAX_MS = 600_000;
export const ATTACHMENTS_VERIFICATION_TIMEOUT_DEFAULT_MS = 15_000;
export const ATTACHMENTS_VERIFICATION_RETRY_MAX = 10;
export const ATTACHMENTS_VERIFICATION_RETRY_DEFAULT = 2;
/** Lease must cover timeoutMs * (retryCount + 1) plus this safety margin. */
export const ATTACHMENTS_VERIFICATION_LEASE_MARGIN_MS = 5_000;
export const ATTACHMENTS_INTENT_RETENTION_MAX_HOURS = 720;
export const ATTACHMENTS_INTENT_RETENTION_DEFAULT_HOURS = 24;
export const ATTACHMENTS_STORED_RETENTION_MAX_DAYS = 3650;
export const ATTACHMENTS_STORED_RETENTION_DEFAULT_DAYS = 30;
export const ATTACHMENTS_RETIRED_RETENTION_MAX_DAYS = 3650;
export const ATTACHMENTS_RETIRED_RETENTION_DEFAULT_DAYS = 90;
export const ATTACHMENTS_CLEANUP_BATCH_MAX = 1_000;
export const ATTACHMENTS_CLEANUP_BATCH_DEFAULT = 100;
export const ATTACHMENTS_CLEANUP_LEASE_MAX_MS = 3_600_000;
export const ATTACHMENTS_CLEANUP_LEASE_DEFAULT_MS = 60_000;
export const ATTACHMENTS_CLEANUP_RETRY_MAX = 10;
export const ATTACHMENTS_CLEANUP_RETRY_DEFAULT = 2;
export const ATTACHMENTS_R2_REGION_DEFAULT = 'auto';
export const ATTACHMENTS_PREFIX_MAX_LENGTH = 512;
export const ATTACHMENTS_SECRET_REF_MAX_LENGTH = 256;
/** I10 owner-private delivery capability: bounded exposure window (seconds), mirrors I03. */
export const ATTACHMENTS_DELIVERY_CAPABILITY_TTL_MIN_SECONDS = 1;
export const ATTACHMENTS_DELIVERY_CAPABILITY_TTL_MAX_SECONDS = 120;
export const ATTACHMENTS_DELIVERY_CAPABILITY_TTL_DEFAULT_SECONDS = 60;

/** Fixed allowed-media allowlist for the private unscanned MVP. */
export const ATTACHMENTS_ALLOWED_MEDIA_ALLOWLIST: readonly string[] = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
]);
export const ATTACHMENTS_ALLOWED_MEDIA_DEFAULT: readonly string[] = Object.freeze([
  ...ATTACHMENTS_ALLOWED_MEDIA_ALLOWLIST,
]);

// ---- configuration types --------------------------------------------------
export interface AttachmentsR2Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly livePrefix: string;
  readonly probePrefix: string;
  /** Opaque secret reference only; never a credential value. */
  readonly rwSecretRef: string;
  /** Opaque secret reference only; never a credential value. Must differ from rwSecretRef. */
  readonly roSecretRef: string;
}

export interface AttachmentsVerificationConfig {
  readonly leaseMs: number;
  readonly timeoutMs: number;
  readonly retryCount: number;
}

export interface AttachmentsCleanupConfig {
  /** Durable claim lease (ms); lease expiry makes the claim takeoverable. */
  readonly leaseMs: number;
  /** Bounded in-process provider/DB retry budget per candidate (0..10). */
  readonly retryCount: number;
}

export interface AttachmentsRetentionConfig {
  readonly intentRetentionHours: number;
  readonly storedRetentionDays: number;
  readonly retiredRetentionDays: number;
}

export interface AttachmentsFeatureConfig {
  readonly enabled: true;
  readonly r2: AttachmentsR2Config;
  /** Create-only grant TTL in seconds (1..300). */
  readonly grantTtlSeconds: number;
  /** Single-PUT hard size ceiling in bytes (1..64 MiB compile ceiling). */
  readonly singlePutMaxBytes: number;
  /** Subset of the fixed allowlist; never arbitrary MIME input. */
  readonly allowedMedia: readonly string[];
  readonly verification: AttachmentsVerificationConfig;
  readonly retention: AttachmentsRetentionConfig;
  readonly cleanupBatchSize: number;
  readonly cleanup: AttachmentsCleanupConfig;
  /** Exact https origin (no path/query/userinfo) for credential-free delivery. */
  readonly isolatedDeliveryOrigin: string;
  /** Opaque secret reference for the delivery-capability HMAC key (never a value). */
  readonly deliveryCapabilitySecretRef: string;
  /** Owner-private delivery capability TTL in seconds (1..120). */
  readonly deliveryCapabilityTtlSeconds: number;
}

/** Log-safe view: never exposes endpoint, bucket, prefixes, or secret refs. */
export interface AttachmentsFeatureConfigSanitized {
  readonly enabled: boolean;
  readonly region: string;
  readonly grantTtlSeconds: number;
  readonly singlePutMaxBytes: number;
  readonly allowedMedia: readonly string[];
  readonly verification: AttachmentsVerificationConfig;
  readonly retention: AttachmentsRetentionConfig;
  readonly cleanupBatchSize: number;
  readonly cleanup: AttachmentsCleanupConfig;
  readonly deliveryCapabilityTtlSeconds: number;
  readonly deliveryOriginHost: string;
}

export interface AttachmentsParseContext {
  readonly nodeEnv: string;
  /** Known application origin (PRODUCT_ORIGIN) used for the same-site check. */
  readonly appOrigin: string;
}

// ---- parsing --------------------------------------------------------------
export function parseAttachmentsFeatureConfig(
  env: NodeJS.ProcessEnv,
  context: AttachmentsParseContext,
): AttachmentsFeatureConfig | undefined {
  const flag = (env.ATTACHMENTS_ENABLED ?? 'false').trim().toLowerCase();
  if (flag !== 'true' && flag !== 'false') {
    throw new Error('ATTACHMENTS_ENABLED must be true or false');
  }
  if (flag !== 'true') return undefined;

  const production = context.nodeEnv === 'production';
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (value) return value;
    throw new Error(`${key} is required when ATTACHMENTS_ENABLED=true`);
  };

  const endpoint = parseR2Endpoint(required('ATTACHMENTS_R2_ENDPOINT'), production);
  const region = parseRegion(env.ATTACHMENTS_R2_REGION, production);
  const bucket = parseR2Bucket(required('ATTACHMENTS_R2_BUCKET'));
  const livePrefix = parsePrefix(required('ATTACHMENTS_R2_LIVE_PREFIX'), 'ATTACHMENTS_R2_LIVE_PREFIX');
  const probePrefix = parsePrefix(required('ATTACHMENTS_R2_PROBE_PREFIX'), 'ATTACHMENTS_R2_PROBE_PREFIX');
  const rwSecretRef = parseSecretRef(required('ATTACHMENTS_R2_RW_SECRET_REF'), 'ATTACHMENTS_R2_RW_SECRET_REF');
  const roSecretRef = parseSecretRef(required('ATTACHMENTS_R2_RO_SECRET_REF'), 'ATTACHMENTS_R2_RO_SECRET_REF');
  const delivery = parseIsolatedDeliveryOrigin(required('ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN'));
  assertDeliveryOriginNotSameSite(
    context.appOrigin,
    delivery.origin,
    'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
    context.nodeEnv === 'production',
  );
  const deliveryCapabilitySecretRef = parseSecretRef(
    required('ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF'),
    'ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF',
  );
  const deliveryCapabilityTtlSeconds = parseBoundedInt(
    env.ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS, ATTACHMENTS_DELIVERY_CAPABILITY_TTL_DEFAULT_SECONDS,
    'ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS',
    { max: ATTACHMENTS_DELIVERY_CAPABILITY_TTL_MAX_SECONDS, required: production },
  );

  const config: AttachmentsFeatureConfig = Object.freeze({
    enabled: true,
    r2: Object.freeze({
      endpoint,
      region,
      bucket,
      livePrefix,
      probePrefix,
      rwSecretRef,
      roSecretRef,
    }),
    grantTtlSeconds: parseBoundedInt(
      env.ATTACHMENTS_GRANT_TTL_SECONDS, ATTACHMENTS_GRANT_TTL_DEFAULT_SECONDS,
      'ATTACHMENTS_GRANT_TTL_SECONDS', { max: ATTACHMENTS_GRANT_TTL_MAX_SECONDS, required: production },
    ),
    singlePutMaxBytes: parseBoundedInt(
      env.ATTACHMENTS_SINGLE_PUT_MAX_BYTES, ATTACHMENTS_SINGLE_PUT_DEFAULT_BYTES,
      'ATTACHMENTS_SINGLE_PUT_MAX_BYTES', { max: ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES, required: production },
    ),
    allowedMedia: parseAllowedMedia(env.ATTACHMENTS_ALLOWED_MEDIA, production),
    verification: Object.freeze({
      leaseMs: parseBoundedInt(
        env.ATTACHMENTS_VERIFICATION_LEASE_MS, ATTACHMENTS_VERIFICATION_LEASE_DEFAULT_MS,
        'ATTACHMENTS_VERIFICATION_LEASE_MS', { max: ATTACHMENTS_VERIFICATION_LEASE_MAX_MS, required: production },
      ),
      timeoutMs: parseBoundedInt(
        env.ATTACHMENTS_VERIFICATION_TIMEOUT_MS, ATTACHMENTS_VERIFICATION_TIMEOUT_DEFAULT_MS,
        'ATTACHMENTS_VERIFICATION_TIMEOUT_MS', { max: ATTACHMENTS_VERIFICATION_TIMEOUT_MAX_MS, required: production },
      ),
      retryCount: parseBoundedInt(
        env.ATTACHMENTS_VERIFICATION_RETRY_COUNT, ATTACHMENTS_VERIFICATION_RETRY_DEFAULT,
        'ATTACHMENTS_VERIFICATION_RETRY_COUNT',
        { min: 0, max: ATTACHMENTS_VERIFICATION_RETRY_MAX, required: production },
      ),
    }),
    retention: Object.freeze({
      intentRetentionHours: parseBoundedInt(
        env.ATTACHMENTS_INTENT_RETENTION_HOURS, ATTACHMENTS_INTENT_RETENTION_DEFAULT_HOURS,
        'ATTACHMENTS_INTENT_RETENTION_HOURS', { max: ATTACHMENTS_INTENT_RETENTION_MAX_HOURS, required: production },
      ),
      storedRetentionDays: parseBoundedInt(
        env.ATTACHMENTS_STORED_RETENTION_DAYS, ATTACHMENTS_STORED_RETENTION_DEFAULT_DAYS,
        'ATTACHMENTS_STORED_RETENTION_DAYS', { max: ATTACHMENTS_STORED_RETENTION_MAX_DAYS, required: production },
      ),
      retiredRetentionDays: parseBoundedInt(
        env.ATTACHMENTS_RETIRED_RETENTION_DAYS, ATTACHMENTS_RETIRED_RETENTION_DEFAULT_DAYS,
        'ATTACHMENTS_RETIRED_RETENTION_DAYS', { max: ATTACHMENTS_RETIRED_RETENTION_MAX_DAYS, required: production },
      ),
    }),
    cleanupBatchSize: parseBoundedInt(
      env.ATTACHMENTS_CLEANUP_BATCH_SIZE, ATTACHMENTS_CLEANUP_BATCH_DEFAULT,
      'ATTACHMENTS_CLEANUP_BATCH_SIZE', { max: ATTACHMENTS_CLEANUP_BATCH_MAX, required: production },
    ),
    cleanup: Object.freeze({
      leaseMs: parseBoundedInt(
        env.ATTACHMENTS_CLEANUP_LEASE_MS, ATTACHMENTS_CLEANUP_LEASE_DEFAULT_MS,
        'ATTACHMENTS_CLEANUP_LEASE_MS', { max: ATTACHMENTS_CLEANUP_LEASE_MAX_MS, required: production },
      ),
      retryCount: parseBoundedInt(
        env.ATTACHMENTS_CLEANUP_RETRY_COUNT, ATTACHMENTS_CLEANUP_RETRY_DEFAULT,
        'ATTACHMENTS_CLEANUP_RETRY_COUNT', { min: 0, max: ATTACHMENTS_CLEANUP_RETRY_MAX, required: production },
      ),
    }),
    isolatedDeliveryOrigin: delivery.origin,
    deliveryCapabilitySecretRef,
    deliveryCapabilityTtlSeconds,
  });
  assertAttachmentsFeatureConfig(config);
  return config;
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  options: { readonly min?: number; readonly max?: number; readonly required?: boolean } = {},
): number {
  if (raw === undefined || raw.trim() === '') {
    if (options.required === true) throw new Error(`${label} is required when ATTACHMENTS_ENABLED=true`);
    return fallback;
  }
  const min = options.min ?? 1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${label} must be a safe integer >= ${min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${label} must be <= ${options.max}`);
  }
  return value;
}

function parseAllowedMedia(raw: string | undefined, required: boolean): readonly string[] {
  const tokens = (raw ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) {
    if (required) throw new Error('ATTACHMENTS_ALLOWED_MEDIA is required when ATTACHMENTS_ENABLED=true');
    return ATTACHMENTS_ALLOWED_MEDIA_DEFAULT;
  }
  for (const token of tokens) {
    if (!ATTACHMENTS_ALLOWED_MEDIA_ALLOWLIST.includes(token)) {
      throw new Error(`ATTACHMENTS_ALLOWED_MEDIA contains unsupported media type: ${token}`);
    }
  }
  if (new Set(tokens).size !== tokens.length) {
    throw new Error('ATTACHMENTS_ALLOWED_MEDIA must not contain duplicates');
  }
  return Object.freeze([...tokens]);
}

const R2_ENDPOINT_HOST_PATTERN = /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/iu;

/** Non-production loopback object-server endpoints for focused test fixtures. */
const R2_LOOPBACK_ENDPOINT_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '127.0.0.2', '::1', 'localhost']);

function parseR2Endpoint(raw: string, production: boolean): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ATTACHMENTS_R2_ENDPOINT must be a valid https account R2 direct endpoint');
  }
  if (url.username || url.password) throw new Error('ATTACHMENTS_R2_ENDPOINT must not contain userinfo');
  if (url.search || url.hash) throw new Error('ATTACHMENTS_R2_ENDPOINT must not contain a query or fragment');
  if (url.pathname !== '/') throw new Error('ATTACHMENTS_R2_ENDPOINT must not contain a path');
  const accountShape = url.protocol === 'https:' && R2_ENDPOINT_HOST_PATTERN.test(url.hostname);
  if (production) {
    if (!accountShape) {
      throw new Error(
        'ATTACHMENTS_R2_ENDPOINT must be an account R2 direct endpoint (https://<32-hex-account-id>.r2.cloudflarestorage.com)',
      );
    }
  } else if (!accountShape && !isR2LoopbackEndpoint(url)) {
    // Non-production keeps the strict account shape AND additionally accepts
    // loopback object servers used by focused process/HTTP fixtures (the same
    // affordance the P03/P08 suites apply to the composed config object).
    throw new Error(
      'ATTACHMENTS_R2_ENDPOINT must be an account R2 direct endpoint or a loopback test endpoint (http://127.0.0.1:<port>)',
    );
  }
  return value;
}

function isR2LoopbackEndpoint(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (!R2_LOOPBACK_ENDPOINT_HOSTS.has(host)) return false;
  if (!url.port) return false;
  const port = Number(url.port);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function parseRegion(raw: string | undefined, production: boolean): string {
  if (raw === undefined || raw.trim() === '') {
    if (production) throw new Error('ATTACHMENTS_R2_REGION is required when ATTACHMENTS_ENABLED=true');
    return ATTACHMENTS_R2_REGION_DEFAULT;
  }
  const value = raw.trim();
  if (!/^[a-z0-9-]{1,64}$/u.test(value)) {
    throw new Error('ATTACHMENTS_R2_REGION must be a lowercase ASCII token of at most 64 characters');
  }
  return value;
}

const R2_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

function parseR2Bucket(raw: string): string {
  const value = raw.trim();
  if (!R2_BUCKET_PATTERN.test(value)) {
    throw new Error(
      'ATTACHMENTS_R2_BUCKET must be 3-63 lowercase letters, digits, dots, or hyphens, starting and ending with a letter or digit',
    );
  }
  if (value.includes('..')) throw new Error('ATTACHMENTS_R2_BUCKET must not contain consecutive dots');
  if (IPV4_PATTERN.test(value)) throw new Error('ATTACHMENTS_R2_BUCKET must not be an IPv4-formatted name');
  return value;
}

function parsePrefix(raw: string, label: string): string {
  const value = raw.trim();
  if (value.length < 2 || value.length > ATTACHMENTS_PREFIX_MAX_LENGTH) {
    throw new Error(`${label} must be 2-${ATTACHMENTS_PREFIX_MAX_LENGTH} characters and end with /`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/u.test(value)) {
    throw new Error(`${label} must be an object-key prefix ending with / using [A-Za-z0-9._-] segments`);
  }
  if (value.includes('//')) throw new Error(`${label} must not contain empty segments`);
  const segments = value.slice(0, -1).split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`${label} must not contain . or .. segments`);
  }
  if (segments.some((segment) => segment.toLowerCase() === 'quarantine')) {
    throw new Error(`${label} must not use the reserved quarantine segment`);
  }
  return value;
}

const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u;

function parseSecretRef(raw: string, label: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.length > ATTACHMENTS_SECRET_REF_MAX_LENGTH
    || !SECRET_REF_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a non-empty secret reference of at most ${ATTACHMENTS_SECRET_REF_MAX_LENGTH} characters`,
    );
  }
  return value;
}

function parseIsolatedDeliveryOrigin(raw: string): { readonly origin: string; readonly host: string } {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN must be a valid absolute https origin');
  }
  if (url.protocol !== 'https:') throw new Error('ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN must use https');
  if (url.username || url.password) throw new Error('ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN must not contain userinfo');
  if (url.search || url.hash) throw new Error('ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN must not contain a query or fragment');
  if (url.pathname !== '/') throw new Error('ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN must not contain a path');
  return { origin: url.origin, host: url.hostname };
}

// ---- cross-field assertions ------------------------------------------------
export function assertAttachmentsFeatureConfig(config: AttachmentsFeatureConfig): void {
  if (config.r2.rwSecretRef === config.r2.roSecretRef) {
    throw new RangeError('ATTACHMENTS_R2_RW_SECRET_REF and ATTACHMENTS_R2_RO_SECRET_REF must be distinct references');
  }
  if (config.deliveryCapabilitySecretRef === config.r2.rwSecretRef
    || config.deliveryCapabilitySecretRef === config.r2.roSecretRef) {
    throw new RangeError('ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF must be distinct from the R2 secret references');
  }
  const live = config.r2.livePrefix;
  const probe = config.r2.probePrefix;
  if (live === probe || live.startsWith(probe) || probe.startsWith(live)) {
    throw new RangeError('ATTACHMENTS_R2_LIVE_PREFIX and ATTACHMENTS_R2_PROBE_PREFIX must not overlap');
  }
  const worstCaseVerificationMs = config.verification.timeoutMs * (config.verification.retryCount + 1);
  if (config.verification.leaseMs < worstCaseVerificationMs + ATTACHMENTS_VERIFICATION_LEASE_MARGIN_MS) {
    throw new RangeError(
      'ATTACHMENTS_VERIFICATION_LEASE_MS must cover timeoutMs * (retryCount + 1) plus a safety margin',
    );
  }
  if (config.retention.intentRetentionHours >= config.retention.storedRetentionDays * 24) {
    throw new RangeError(
      'ATTACHMENTS_INTENT_RETENTION_HOURS must be shorter than ATTACHMENTS_STORED_RETENTION_DAYS',
    );
  }
  if (config.retention.retiredRetentionDays < config.retention.storedRetentionDays) {
    throw new RangeError(
      'ATTACHMENTS_RETIRED_RETENTION_DAYS must be at least ATTACHMENTS_STORED_RETENTION_DAYS',
    );
  }
  assertBounded(config.grantTtlSeconds, 'grantTtlSeconds', 1, ATTACHMENTS_GRANT_TTL_MAX_SECONDS);
  assertBounded(config.singlePutMaxBytes, 'singlePutMaxBytes', 1, ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES);
  assertBounded(config.verification.leaseMs, 'verification.leaseMs', 1, ATTACHMENTS_VERIFICATION_LEASE_MAX_MS);
  assertBounded(config.verification.timeoutMs, 'verification.timeoutMs', 1, ATTACHMENTS_VERIFICATION_TIMEOUT_MAX_MS);
  assertBounded(config.verification.retryCount, 'verification.retryCount', 0, ATTACHMENTS_VERIFICATION_RETRY_MAX);
  assertBounded(config.retention.intentRetentionHours, 'retention.intentRetentionHours', 1,
    ATTACHMENTS_INTENT_RETENTION_MAX_HOURS);
  assertBounded(config.retention.storedRetentionDays, 'retention.storedRetentionDays', 1,
    ATTACHMENTS_STORED_RETENTION_MAX_DAYS);
  assertBounded(config.retention.retiredRetentionDays, 'retention.retiredRetentionDays', 1,
    ATTACHMENTS_RETIRED_RETENTION_MAX_DAYS);
  assertBounded(config.cleanupBatchSize, 'cleanupBatchSize', 1, ATTACHMENTS_CLEANUP_BATCH_MAX);
  assertBounded(config.cleanup.leaseMs, 'cleanup.leaseMs', 1, ATTACHMENTS_CLEANUP_LEASE_MAX_MS);
  assertBounded(config.cleanup.retryCount, 'cleanup.retryCount', 0, ATTACHMENTS_CLEANUP_RETRY_MAX);
  assertBounded(config.deliveryCapabilityTtlSeconds, 'deliveryCapabilityTtlSeconds', 1, ATTACHMENTS_DELIVERY_CAPABILITY_TTL_MAX_SECONDS);
  if (config.allowedMedia.length === 0) throw new RangeError('allowedMedia must not be empty');
  for (const media of config.allowedMedia) {
    if (!ATTACHMENTS_ALLOWED_MEDIA_ALLOWLIST.includes(media)) {
      throw new RangeError(`allowedMedia contains unsupported media type: ${media}`);
    }
  }
}

function assertBounded(value: number, name: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
}

// ---- log-safe view ---------------------------------------------------------
export function sanitizeAttachmentsFeatureConfig(
  config: AttachmentsFeatureConfig,
): AttachmentsFeatureConfigSanitized {
  return Object.freeze({
    enabled: config.enabled,
    region: config.r2.region,
    grantTtlSeconds: config.grantTtlSeconds,
    singlePutMaxBytes: config.singlePutMaxBytes,
    allowedMedia: Object.freeze([...config.allowedMedia]),
    verification: Object.freeze({ ...config.verification }),
    retention: Object.freeze({ ...config.retention }),
    cleanupBatchSize: config.cleanupBatchSize,
    cleanup: Object.freeze({ ...config.cleanup }),
    deliveryCapabilityTtlSeconds: config.deliveryCapabilityTtlSeconds,
    deliveryOriginHost: new URL(config.isolatedDeliveryOrigin).hostname,
  });
}
