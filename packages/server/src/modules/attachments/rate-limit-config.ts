/**
 * P4A-RL02 distributed rate-limit configuration contract (plan §2.3
 * suggested config contract + §8 RL02 production scope).
 *
 * The config object stores the connection URL and only an opaque secret
 * REFERENCE (never the HMAC secret value). Every numeric value has a
 * compile-time hard ceiling and is validated as a safe integer; any invalid
 * or contradictory input fails closed INSIDE `parseAttachmentRateLimitConfig`
 * BEFORE any client/route initialization can happen. The Redis URL is only
 * checked for scheme and userinfo (plan §8 RL02 test note: "URL 只验证
 * scheme/必要字段"), and validation errors NEVER echo the raw URL or the
 * secret — the sanitize view carries no URL and no secret either.
 *
 * Per-route budgets (plan §2.3 + FIX-L-051): issue 30/60000, complete
 * 60/60000, download 30/60000, status 60/60000 (the owner-private read
 * budget added by KA-P4-AM-16) and the bounded complete emergency
 * 15/60000 (hard ceiling 1000).
 *
 * The multi-replica production gate (`assertProductionRateLimitProfile`,
 * plan §2.2.6) is a pure decision function for bootstrap: with
 * `attachments.enabled=true` on a production multi-replica profile the mode
 * must be `enforce` with `required=true`, otherwise the Attachment
 * capability must be rejected; single-instance acceptance may explicitly
 * record `off`.
 */
import {
  ATTACHMENT_RATE_LIMIT_MODES,
  type AttachmentRateLimitMode,
  type AttachmentRateLimitRouteClass,
} from './rate-limit-contracts.js';

// ---------------------------------------------------------------------------
// Compile-time hard ceilings and plan §2.3 suggested defaults
// ---------------------------------------------------------------------------

export const ATTACHMENTS_RATE_LIMIT_MODE_DEFAULT = 'off';
export const ATTACHMENTS_RATE_LIMIT_REQUIRED_DEFAULT = false;
export const ATTACHMENTS_RATE_LIMIT_KEY_PREFIX_DEFAULT = 'known';
export const ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_DEFAULT_MS = 75;
export const ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MAX_MS = 5_000;
export const ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_DEFAULT_MS = 1_000;
export const ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_MAX_MS = 30_000;
export const ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST_DEFAULT = 1;
export const ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST_MAX = 10;
/** Per-route quota ceiling (rateMax) and fixed-window ceiling. */
export const ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING = 10_000;
export const ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS = 3_600_000;
/** Bounded in-process emergency budget for `complete` (plan §2.2.3). */
export const ATTACHMENTS_RATE_LIMIT_EMERGENCY_RATE_MAX_HARD_CEILING = 1_000;
export const ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX_DEFAULT = 30;
export const ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS_DEFAULT = 60_000;
export const ATTACHMENTS_UPLOAD_COMPLETE_RATE_MAX_DEFAULT = 60;
export const ATTACHMENTS_UPLOAD_COMPLETE_RATE_WINDOW_MS_DEFAULT = 60_000;
export const ATTACHMENTS_DOWNLOAD_RATE_MAX_DEFAULT = 30;
export const ATTACHMENTS_DOWNLOAD_RATE_WINDOW_MS_DEFAULT = 60_000;
/** FIX-L-051 owner-private status read budget (KA-P4-AM-16). */
export const ATTACHMENTS_STATUS_RATE_MAX_DEFAULT = 60;
export const ATTACHMENTS_STATUS_RATE_WINDOW_MS_DEFAULT = 60_000;
export const ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX_DEFAULT = 15;
export const ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS_DEFAULT = 60_000;

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

export interface AttachmentRateLimitRouteConfig {
  /** Allowed attempts per fixed window (safe integer 1..ceiling). */
  readonly rateMax: number;
  /** Fixed window length in ms (safe integer 1..ceiling). */
  readonly rateWindowMs: number;
}

export interface AttachmentRateLimitConfig {
  readonly mode: AttachmentRateLimitMode;
  /** Readiness fact: enforce+required blocks attachments when Redis degrades. */
  readonly required: boolean;
  /** rediss:// or redis:// endpoint; null only in off mode without a URL. */
  readonly redisUrl: string | null;
  /** Opaque HMAC key secret reference; never the secret value. */
  readonly keySecretRef: string | null;
  /** Redis key namespace prefix (plan §2.3 key contract); default 'known'. */
  readonly keyPrefix: string;
  /** Per-command timeout (ms); default 75, hard ceiling 5000. */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); default 1000, hard ceiling 30000. */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request; default 1, range 0..10. */
  readonly maxRetriesPerRequest: number;
  /** Fixed per-route budgets (plan §2.3). */
  readonly routes: Readonly<Record<AttachmentRateLimitRouteClass, AttachmentRateLimitRouteConfig>>;
  /** Bounded in-process emergency budget for complete (plan §2.2.3). */
  readonly completeEmergency: AttachmentRateLimitRouteConfig;
}

/** Log-safe view: never exposes the URL, the secret reference, or secrets. */
export interface AttachmentRateLimitConfigSanitized {
  readonly mode: AttachmentRateLimitMode;
  readonly required: boolean;
  readonly keyPrefix: string;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
  readonly routes: Readonly<Record<AttachmentRateLimitRouteClass, AttachmentRateLimitRouteConfig>>;
  readonly completeEmergency: AttachmentRateLimitRouteConfig;
  readonly redisConfigured: boolean;
  readonly keySecretConfigured: boolean;
}

// ---------------------------------------------------------------------------
// Parsing (fail closed; errors never echo the URL or the secret)
// ---------------------------------------------------------------------------

const RATE_LIMIT_KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u;
const SECRET_REF_MAX_LENGTH = 256;

function parseRateLimitBoolean(raw: string | undefined, label: string, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${label} must be true or false`);
  }
  return value === 'true';
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  options: { readonly min?: number; readonly max?: number } = {},
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
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

/**
 * Scheme + userinfo validation only (plan §8 RL02: "URL 只验证 scheme/必要
 * 字段"). The error message is a fixed sentence and NEVER interpolates the
 * raw URL, its host, userinfo or credentials.
 */
function parseRateLimitRedisUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('ATTACHMENTS_RATE_LIMIT_REDIS_URL must use redis:// or rediss:// scheme');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('ATTACHMENTS_RATE_LIMIT_REDIS_URL must use redis:// or rediss:// scheme');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('ATTACHMENTS_RATE_LIMIT_REDIS_URL must not contain userinfo');
  }
  return raw;
}

/** Opaque secret REFERENCE parsing, same style as the R2 secret refs. */
function parseRateLimitSecretRef(raw: string): string {
  if (raw.length === 0 || raw.length > SECRET_REF_MAX_LENGTH || !SECRET_REF_PATTERN.test(raw)) {
    throw new Error(
      'ATTACHMENTS_RATE_LIMIT_KEY_SECRET must be a non-empty secret reference of at most 256 characters',
    );
  }
  return raw;
}

function parseRouteRateConfig(
  env: NodeJS.ProcessEnv,
  rateMaxKey: string,
  rateMaxFallback: number,
  rateMaxCap: number,
  windowKey: string,
  windowFallback: number,
): AttachmentRateLimitRouteConfig {
  const rateMax = parseBoundedInt(env[rateMaxKey], rateMaxFallback, rateMaxKey, {
    max: rateMaxCap,
  });
  const rateWindowMs = parseBoundedInt(env[windowKey], windowFallback, windowKey, {
    max: ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS,
  });
  return Object.freeze({ rateMax, rateWindowMs });
}

export function parseAttachmentRateLimitConfig(env: NodeJS.ProcessEnv): AttachmentRateLimitConfig {
  const modeRaw = (env.ATTACHMENTS_RATE_LIMIT_MODE ?? ATTACHMENTS_RATE_LIMIT_MODE_DEFAULT).trim().toLowerCase();
  if (!ATTACHMENT_RATE_LIMIT_MODES.includes(modeRaw as AttachmentRateLimitMode)) {
    throw new Error('ATTACHMENTS_RATE_LIMIT_MODE must be one of off, shadow or enforce');
  }
  const mode = modeRaw as AttachmentRateLimitMode;

  const required = parseRateLimitBoolean(
    env.ATTACHMENTS_RATE_LIMIT_REQUIRED,
    'ATTACHMENTS_RATE_LIMIT_REQUIRED',
    ATTACHMENTS_RATE_LIMIT_REQUIRED_DEFAULT,
  );

  const rawUrl = env.ATTACHMENTS_RATE_LIMIT_REDIS_URL?.trim() ?? '';
  let redisUrl: string | null = null;
  if (rawUrl !== '') {
    redisUrl = parseRateLimitRedisUrl(rawUrl);
  } else if (mode !== 'off') {
    throw new Error('ATTACHMENTS_RATE_LIMIT_REDIS_URL is required when ATTACHMENTS_RATE_LIMIT_MODE is shadow or enforce');
  }

  const rawKeySecret = env.ATTACHMENTS_RATE_LIMIT_KEY_SECRET?.trim() ?? '';
  let keySecretRef: string | null = null;
  if (rawKeySecret !== '') {
    keySecretRef = parseRateLimitSecretRef(rawKeySecret);
  } else if (mode !== 'off') {
    throw new Error('ATTACHMENTS_RATE_LIMIT_KEY_SECRET is required when ATTACHMENTS_RATE_LIMIT_MODE is shadow or enforce');
  }

  if (mode === 'off' && required) {
    throw new RangeError('ATTACHMENTS_RATE_LIMIT_REQUIRED=true requires ATTACHMENTS_RATE_LIMIT_MODE=shadow or enforce');
  }

  const keyPrefix = (env.ATTACHMENTS_RATE_LIMIT_KEY_PREFIX ?? ATTACHMENTS_RATE_LIMIT_KEY_PREFIX_DEFAULT).trim();
  if (!RATE_LIMIT_KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new Error(
      'ATTACHMENTS_RATE_LIMIT_KEY_PREFIX must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }

  const commandTimeoutMs = parseBoundedInt(
    env.ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MS,
    ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_DEFAULT_MS,
    'ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MS',
    { max: ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MAX_MS },
  );
  const connectTimeoutMs = parseBoundedInt(
    env.ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_MS,
    ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_DEFAULT_MS,
    'ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_MS',
    { max: ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_MAX_MS },
  );
  const maxRetriesPerRequest = parseBoundedInt(
    env.ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST,
    ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST_DEFAULT,
    'ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
    { min: 0, max: ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST_MAX },
  );

  const routes = Object.freeze({
    issue: parseRouteRateConfig(
      env,
      'ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX', ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX_DEFAULT,
      ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING,
      'ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS', ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS_DEFAULT,
    ),
    complete: parseRouteRateConfig(
      env,
      'ATTACHMENTS_UPLOAD_COMPLETE_RATE_MAX', ATTACHMENTS_UPLOAD_COMPLETE_RATE_MAX_DEFAULT,
      ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING,
      'ATTACHMENTS_UPLOAD_COMPLETE_RATE_WINDOW_MS', ATTACHMENTS_UPLOAD_COMPLETE_RATE_WINDOW_MS_DEFAULT,
    ),
    download: parseRouteRateConfig(
      env,
      'ATTACHMENTS_DOWNLOAD_RATE_MAX', ATTACHMENTS_DOWNLOAD_RATE_MAX_DEFAULT,
      ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING,
      'ATTACHMENTS_DOWNLOAD_RATE_WINDOW_MS', ATTACHMENTS_DOWNLOAD_RATE_WINDOW_MS_DEFAULT,
    ),
    status: parseRouteRateConfig(
      env,
      'ATTACHMENTS_STATUS_RATE_MAX', ATTACHMENTS_STATUS_RATE_MAX_DEFAULT,
      ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING,
      'ATTACHMENTS_STATUS_RATE_WINDOW_MS', ATTACHMENTS_STATUS_RATE_WINDOW_MS_DEFAULT,
    ),
  });
  const completeEmergency = parseRouteRateConfig(
    env,
    'ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX', ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX_DEFAULT,
    ATTACHMENTS_RATE_LIMIT_EMERGENCY_RATE_MAX_HARD_CEILING,
    'ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS', ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS_DEFAULT,
  );

  const config: AttachmentRateLimitConfig = Object.freeze({
    mode,
    required,
    redisUrl,
    keySecretRef,
    keyPrefix,
    commandTimeoutMs,
    connectTimeoutMs,
    maxRetriesPerRequest,
    routes,
    completeEmergency,
  });
  assertAttachmentRateLimitConfig(config);
  return config;
}

// ---------------------------------------------------------------------------
// Cross-field assertions (fail closed; re-checks everything on a literal)
// ---------------------------------------------------------------------------

export function assertAttachmentRateLimitConfig(config: AttachmentRateLimitConfig): void {
  assertBounded(config.commandTimeoutMs, 'commandTimeoutMs', 1, ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MAX_MS);
  assertBounded(config.connectTimeoutMs, 'connectTimeoutMs', 1, ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_MAX_MS);
  assertBounded(config.maxRetriesPerRequest, 'maxRetriesPerRequest', 0, ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST_MAX);
  assertBounded(config.routes.issue.rateMax, 'routes.issue.rateMax', 1, ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING);
  assertBounded(config.routes.issue.rateWindowMs, 'routes.issue.rateWindowMs', 1, ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS);
  assertBounded(config.routes.complete.rateMax, 'routes.complete.rateMax', 1, ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING);
  assertBounded(config.routes.complete.rateWindowMs, 'routes.complete.rateWindowMs', 1, ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS);
  assertBounded(config.routes.download.rateMax, 'routes.download.rateMax', 1, ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING);
  assertBounded(config.routes.download.rateWindowMs, 'routes.download.rateWindowMs', 1, ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS);
  assertBounded(config.routes.status.rateMax, 'routes.status.rateMax', 1, ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING);
  assertBounded(config.routes.status.rateWindowMs, 'routes.status.rateWindowMs', 1, ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS);
  assertBounded(config.completeEmergency.rateMax, 'completeEmergency.rateMax', 1, ATTACHMENTS_RATE_LIMIT_EMERGENCY_RATE_MAX_HARD_CEILING);
  assertBounded(config.completeEmergency.rateWindowMs, 'completeEmergency.rateWindowMs', 1, ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS);
  if (config.mode === 'off' && config.required) {
    throw new RangeError('ATTACHMENTS_RATE_LIMIT_REQUIRED=true requires ATTACHMENTS_RATE_LIMIT_MODE=shadow or enforce');
  }
  if (config.mode !== 'off' && config.redisUrl === null) {
    throw new RangeError('ATTACHMENTS_RATE_LIMIT_REDIS_URL is required when ATTACHMENTS_RATE_LIMIT_MODE is shadow or enforce');
  }
  if (config.mode !== 'off' && config.keySecretRef === null) {
    throw new RangeError('ATTACHMENTS_RATE_LIMIT_KEY_SECRET is required when ATTACHMENTS_RATE_LIMIT_MODE is shadow or enforce');
  }
}

function assertBounded(value: number, name: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a safe integer between ${min} and ${max}`);
  }
}

// ---------------------------------------------------------------------------
// Log-safe view
// ---------------------------------------------------------------------------

/**
 * Credential-free startup snapshot. The URL and the secret REFERENCE are
 * never included — only `redisConfigured`/`keySecretConfigured` booleans —
 * so startup logs and readiness probes can never leak connection or HMAC
 * secrets (plan §12 artifact ban + RL07 secret-scan readiness).
 */
export function sanitizeAttachmentRateLimitConfig(
  config: AttachmentRateLimitConfig,
): AttachmentRateLimitConfigSanitized {
  return Object.freeze({
    mode: config.mode,
    required: config.required,
    keyPrefix: config.keyPrefix,
    commandTimeoutMs: config.commandTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    routes: Object.freeze({
      issue: Object.freeze({ ...config.routes.issue }),
      complete: Object.freeze({ ...config.routes.complete }),
      download: Object.freeze({ ...config.routes.download }),
      status: Object.freeze({ ...config.routes.status }),
    }),
    completeEmergency: Object.freeze({ ...config.completeEmergency }),
    redisConfigured: config.redisUrl !== null,
    keySecretConfigured: config.keySecretRef !== null,
  });
}

// ---------------------------------------------------------------------------
// Production multi-replica profile gate (plan §2.2.6, §13.1)
// ---------------------------------------------------------------------------

export interface AttachmentRateLimitProductionGate {
  /** `attachments.enabled` (capability active). */
  readonly attachmentsEnabled: boolean;
  /** Production environment flag supplied by bootstrap. */
  readonly production: boolean;
  /** True when the deployment runs more than one API replica. */
  readonly multiReplica: boolean;
  readonly mode: AttachmentRateLimitMode;
  readonly required: boolean;
}

/**
 * Pure verdict: returns a violation message when the profile must be
 * rejected, or null when it may start. A production multi-replica profile
 * with attachments enabled MUST be `enforce + required`; anything else
 * (`off`, `shadow`, or `required=false`) fails closed so bootstrap can
 * refuse to start the Attachment capability (plan §2.2.6). Single-instance
 * acceptance may explicitly record `off`.
 */
export function productionRateLimitProfileViolation(gate: AttachmentRateLimitProductionGate): string | null {
  if (!gate.attachmentsEnabled || !gate.production || !gate.multiReplica) return null;
  if (gate.mode !== 'enforce' || gate.required !== true) {
    return 'multi-replica production requires ATTACHMENTS_RATE_LIMIT_MODE=enforce and ATTACHMENTS_RATE_LIMIT_REQUIRED=true';
  }
  return null;
}

/** Bootstrap entry: throws the stable violation message when the profile fails. */
export function assertProductionRateLimitProfile(gate: AttachmentRateLimitProductionGate): void {
  const violation = productionRateLimitProfileViolation(gate);
  if (violation !== null) throw new Error(violation);
}
