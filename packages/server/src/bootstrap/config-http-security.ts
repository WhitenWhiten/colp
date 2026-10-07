import { parseTrustedIngress } from './trusted-ingress.js';
import {
  parseCacheBooleanEnv,
  parseChromeExtensionTrustedOrigins,
  parsePositiveInt,
  requireNonEmpty,
} from './config-parse-helpers.js';
import { resolveLimiterRedisUrl } from './config-redis-roles.js';
import {
  BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  resolveBetterAuthCookieName,
} from '../modules/auth/better-auth-config.js';
import type {
  BetterAuthCutoverMode,
  BetterAuthFeatureConfig,
  BetterAuthOauthIssuerFeatureConfig,
  BetterAuthSocialProviderConfig,
  HttpSecurityConfig,
} from './config-types.js';

const DEFAULT_BODY_LIMIT_BYTES = 131_072;
/** Shipped default for `HTTP_REQUEST_TIMEOUT_MS`. Exported so the classification
 * run-apply transaction budget can pin that it stays below the HTTP cut-off. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 72_000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 60;
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_SEARCH_ANON_RATE_LIMIT_MAX = 30;
const DEFAULT_SEARCH_ACCOUNT_RATE_LIMIT_MAX = 120;
const DEFAULT_SEARCH_RATE_LIMIT_WINDOW_MS = 60_000;
const DEV_BETTER_AUTH_SECRET = 'dev-better-auth-secret-0123456789abcdef';
const DEV_BETTER_AUTH_SESSION_TOKEN_KEY = Buffer.alloc(32, 0x5a);
const DEV_BETTER_AUTH_SESSION_TOKEN_KEYS = `1:${DEV_BETTER_AUTH_SESSION_TOKEN_KEY.toString('base64')}`;
const DEV_BETTER_AUTH_LEGACY_PLAINTEXT_READ_UNTIL = new Date('2100-01-01T00:00:00.000Z');
const MAX_PRODUCTION_LEGACY_PLAINTEXT_BRIDGE_MS = 31 * 24 * 60 * 60 * 1000;
const DEFAULT_DCR_MAX_ANONYMOUS_CLIENTS = 10_000;
const DEFAULT_DCR_UNUSED_CLIENT_RETENTION_SECONDS = 86_400;
const DEFAULT_DCR_MAX_OWNED_CLIENTS_PER_USER = 20;
const DEFAULT_DCR_MAX_OWNED_CLIENTS = 100_000;


export function parseBetterAuthProviderCredential(
  env: NodeJS.ProcessEnv,
  name: 'GOOGLE' | 'GITHUB',
): BetterAuthSocialProviderConfig | undefined {
  const clientId = env[`BETTER_AUTH_${name}_CLIENT_ID`]?.trim() ?? '';
  const clientSecret = env[`BETTER_AUTH_${name}_CLIENT_SECRET`]?.trim() ?? '';
  if (clientId === '' && clientSecret === '') return undefined;
  if (clientId === '') {
    throw new Error(`BETTER_AUTH_${name}_CLIENT_ID is required when a ${name} provider is configured`);
  }
  if (clientSecret === '') {
    throw new Error(`BETTER_AUTH_${name}_CLIENT_SECRET is required when a ${name} provider is configured`);
  }
  return Object.freeze({ clientId, clientSecret });
}

export function loadBetterAuthConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  productOrigin: string,
  allowedOrigins: readonly string[],
): BetterAuthFeatureConfig {
  // KNOWN_FEATURE_* boolean style (G1 §6): illegal values fail startup.
  const enabledFlag = (env.BETTER_AUTH_ENABLED ?? 'false').trim().toLowerCase();
  if (enabledFlag !== 'true' && enabledFlag !== 'false') {
    throw new Error('BETTER_AUTH_ENABLED must be true or false');
  }
  const enabled = enabledFlag === 'true';
  // AUTH-P1-b: unused at runtime (only BETTER_AUTH_ENABLED switches BA vs OIDC).
  // Still parsed so illegal values fail startup; do not route on this field.
  const rawCutoverMode = (env.BETTER_AUTH_CUTOVER_MODE ?? 'shadow').trim().toLowerCase();
  if (rawCutoverMode !== 'shadow' && rawCutoverMode !== 'canary' && rawCutoverMode !== 'on') {
    throw new Error('BETTER_AUTH_CUTOVER_MODE must be one of: shadow, canary, on');
  }
  const cutoverMode: BetterAuthCutoverMode = rawCutoverMode;
  const emailOtpFlag = (env.BETTER_AUTH_EMAIL_OTP_ENABLED ?? 'false').trim().toLowerCase();
  if (emailOtpFlag !== 'true' && emailOtpFlag !== 'false') {
    throw new Error('BETTER_AUTH_EMAIL_OTP_ENABLED must be true or false');
  }
  const socialFlag = (env.BETTER_AUTH_SOCIAL_ENABLED ?? 'false').trim().toLowerCase();
  if (socialFlag !== 'true' && socialFlag !== 'false') {
    throw new Error('BETTER_AUTH_SOCIAL_ENABLED must be true or false');
  }
  const socialEnabled = socialFlag === 'true';
  // Secret is required only when enabled (>= 32 chars, better-auth contract).
  // An explicitly present-but-blank secret is a misconfiguration: it must fail
  // startup even in non-production (no silent dev-default substitution).
  // The published dev literal is a NODE_ENV=test convenience only — development
  // and production must set BETTER_AUTH_SECRET explicitly.
  if (enabled && env.BETTER_AUTH_SECRET !== undefined && env.BETTER_AUTH_SECRET.trim() === '') {
    throw new Error('BETTER_AUTH_SECRET is required');
  }
  const secret = enabled
    ? requireNonEmpty(env, 'BETTER_AUTH_SECRET', nodeEnv === 'test' ? DEV_BETTER_AUTH_SECRET : undefined)
    : null;
  if (secret !== null && secret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
  }
  const sessionTokenProtection = enabled
    ? loadBetterAuthSessionTokenProtection(env, nodeEnv, secret as string)
    : null;
  const basePath = env.BETTER_AUTH_BASE_PATH?.trim() || '/api/v1/auth';
  if (!basePath.startsWith('/') || basePath.endsWith('/') || basePath.includes('?')) {
    throw new Error('BETTER_AUTH_BASE_PATH must be an absolute path without a trailing slash');
  }
  // G1 §4 / G3: TLS stays frozen to `__Host-known_session`. Insecure HTTP
  // allows that name or `known_session` and emits `known_session`.
  const cookieName = resolveBetterAuthCookieName(
    env.BETTER_AUTH_COOKIE_NAME?.trim()
      || (env.COLP_INSECURE_HTTP === 'true' ? 'known_session' : '__Host-known_session'),
    env,
  );
  const sessionExpiresInSeconds = parsePositiveInt(
    env.BETTER_AUTH_SESSION_EXPIRES_IN_SECONDS,
    86_400,
    'BETTER_AUTH_SESSION_EXPIRES_IN_SECONDS',
    { max: 31_536_000 },
  );
  const sessionUpdateAgeSeconds = parsePositiveInt(
    env.BETTER_AUTH_SESSION_UPDATE_AGE_SECONDS,
    60,
    'BETTER_AUTH_SESSION_UPDATE_AGE_SECONDS',
    { max: 86_400 },
  );
  if (sessionUpdateAgeSeconds >= sessionExpiresInSeconds) {
    throw new Error('BETTER_AUTH_SESSION_UPDATE_AGE_SECONDS must be smaller than BETTER_AUTH_SESSION_EXPIRES_IN_SECONDS');
  }
  const otpTtlSeconds = parsePositiveInt(
    env.BETTER_AUTH_OTP_TTL_SECONDS,
    300,
    'BETTER_AUTH_OTP_TTL_SECONDS',
    { max: 3_600 },
  );
  const otpMaxAttempts = parsePositiveInt(
    env.BETTER_AUTH_OTP_MAX_ATTEMPTS,
    3,
    'BETTER_AUTH_OTP_MAX_ATTEMPTS',
    { min: 1, max: 10 },
  );
  const bodyLimitBytes = parsePositiveInt(
    env.BETTER_AUTH_BODY_LIMIT_BYTES,
    DEFAULT_BODY_LIMIT_BYTES,
    'BETTER_AUTH_BODY_LIMIT_BYTES',
    { max: 10_485_760 },
  );
  // AUTH-P1-b: unused at runtime. Still parsed (comma-separated opaque
  // emails/account IDs; empty default; duplicates fail closed) so env
  // misconfig fails startup. Do not route canary traffic from this field.
  const canaryAllowlist = Object.freeze(
    (env.BETTER_AUTH_CANARY_ALLOWLIST ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  if (new Set(canaryAllowlist).size !== canaryAllowlist.length) {
    throw new Error('BETTER_AUTH_CANARY_ALLOWLIST must not contain duplicate entries');
  }
  // Provider credentials are parsed only when the capability is enabled: with
  // SOCIAL_ENABLED=false the section stays credential-free and provider env is
  // ignored entirely (ADR §6 — the non-empty checks apply when the flag is true).
  const google = socialEnabled ? parseBetterAuthProviderCredential(env, 'GOOGLE') : undefined;
  const github = socialEnabled ? parseBetterAuthProviderCredential(env, 'GITHUB') : undefined;
  if (socialEnabled && google === undefined && github === undefined) {
    throw new Error('BETTER_AUTH_SOCIAL_ENABLED=true requires at least one configured provider (BETTER_AUTH_GOOGLE_CLIENT_ID/SECRET or BETTER_AUTH_GITHUB_CLIENT_ID/SECRET)');
  }
  const issuerFlag = (env.BETTER_AUTH_OAUTH_ISSUER_ENABLED ?? 'false').trim().toLowerCase();
  if (issuerFlag !== 'true' && issuerFlag !== 'false') {
    throw new Error('BETTER_AUTH_OAUTH_ISSUER_ENABLED must be true or false');
  }
  const oauthIssuerEnabled = issuerFlag === 'true';
  if (oauthIssuerEnabled && !enabled) {
    throw new Error('BETTER_AUTH_OAUTH_ISSUER_ENABLED=true requires BETTER_AUTH_ENABLED=true');
  }
  const oauthIssuer = oauthIssuerEnabled ? parseBetterAuthOauthIssuer(env) : null;
  return Object.freeze({
    enabled,
    cutoverMode,
    canaryAllowlist,
    emailOtpEnabled: emailOtpFlag === 'true',
    socialEnabled,
    baseUrl: productOrigin,
    basePath,
    secret,
    sessionTokenProtection,
    trustedOrigins: Object.freeze([
      ...new Set([
        ...allowedOrigins,
        ...(enabled ? parseChromeExtensionTrustedOrigins(env.SYNC_EXTENSION_IDS) : []),
      ]),
    ]),
    cookieName,
    sessionExpiresInSeconds,
    sessionUpdateAgeSeconds,
    otpTtlSeconds,
    otpMaxAttempts,
    bodyLimitBytes,
    social: Object.freeze({
      ...(google ? { google } : {}),
      ...(github ? { github } : {}),
    }),
    oauthIssuerEnabled,
    oauthIssuer,
  });
}

/** Parse `version:base64-32-byte-key` entries; first entry is the active key. */
export function parseBetterAuthSessionTokenKeys(
  raw: string,
): readonly Readonly<{ readonly version: number; readonly key: Buffer }>[] {
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error('BETTER_AUTH_SESSION_TOKEN_KEYS must contain at least one key');
  }
  if (entries.length > 8) {
    throw new Error('BETTER_AUTH_SESSION_TOKEN_KEYS must contain at most 8 keys');
  }
  const parsed = entries.map((entry, index) => {
    const separator = entry.indexOf(':');
    if (separator <= 0 || separator === entry.length - 1 || entry.indexOf(':', separator + 1) !== -1) {
      throw new Error(`BETTER_AUTH_SESSION_TOKEN_KEYS entry ${index + 1} must be version:base64`);
    }
    const versionText = entry.slice(0, separator);
    if (!/^[1-9][0-9]{0,9}$/u.test(versionText)) {
      throw new Error(`BETTER_AUTH_SESSION_TOKEN_KEYS entry ${index + 1} has an invalid version`);
    }
    const version = Number(versionText);
    if (!Number.isSafeInteger(version) || version > 2_147_483_647) {
      throw new Error(`BETTER_AUTH_SESSION_TOKEN_KEYS entry ${index + 1} has an invalid version`);
    }
    const encoded = entry.slice(separator + 1);
    if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/u.test(encoded)) {
      throw new Error(`BETTER_AUTH_SESSION_TOKEN_KEYS entry ${index + 1} must be canonical base64`);
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) {
      throw new Error(`BETTER_AUTH_SESSION_TOKEN_KEYS entry ${index + 1} must decode to 32 bytes`);
    }
    return Object.freeze({ version, key });
  });
  if (new Set(parsed.map((entry) => entry.version)).size !== parsed.length) {
    throw new Error('BETTER_AUTH_SESSION_TOKEN_KEYS versions must be unique');
  }
  if (new Set(parsed.map((entry) => entry.key.toString('base64'))).size !== parsed.length) {
    throw new Error('BETTER_AUTH_SESSION_TOKEN_KEYS key material must be unique');
  }
  return Object.freeze(parsed);
}

function loadBetterAuthSessionTokenProtection(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  betterAuthSecret: string,
): Readonly<{
  readonly keys: readonly Readonly<{ readonly version: number; readonly key: Buffer }>[];
  readonly legacyPlaintextReadUntil: Date | null;
}> {
  if (env.BETTER_AUTH_SESSION_TOKEN_KEYS !== undefined
      && env.BETTER_AUTH_SESSION_TOKEN_KEYS.trim() === '') {
    throw new Error('BETTER_AUTH_SESSION_TOKEN_KEYS is required');
  }
  const raw = requireNonEmpty(
    env,
    'BETTER_AUTH_SESSION_TOKEN_KEYS',
    nodeEnv === 'test' ? DEV_BETTER_AUTH_SESSION_TOKEN_KEYS : undefined,
  );
  const keys = parseBetterAuthSessionTokenKeys(raw);
  if (nodeEnv === 'production'
      && keys.some((entry) => entry.key.equals(DEV_BETTER_AUTH_SESSION_TOKEN_KEY))) {
    throw new Error('BETTER_AUTH_SESSION_TOKEN_KEYS must not use the test default in production');
  }
  const secretBytes = Buffer.from(betterAuthSecret, 'utf8');
  if (keys.some((entry) => (
    (secretBytes.length === 32 && entry.key.equals(secretBytes))
      || entry.key.toString('base64') === betterAuthSecret
      || entry.key.toString('base64url') === betterAuthSecret
      || entry.key.toString('hex') === betterAuthSecret.toLowerCase()
  ))) {
    throw new Error('BETTER_AUTH_SESSION_TOKEN_KEYS must be independent from BETTER_AUTH_SECRET');
  }
  const rawDeadline = env.BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL?.trim();
  let legacyPlaintextReadUntil: Date | null = nodeEnv === 'test'
    ? new Date(DEV_BETTER_AUTH_LEGACY_PLAINTEXT_READ_UNTIL)
    : null;
  if (rawDeadline !== undefined && rawDeadline !== '') {
    const parsed = new Date(rawDeadline);
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error('BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL must be an ISO-8601 timestamp');
    }
    if (parsed.getTime() <= Date.now()) {
      throw new Error('BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL must be in the future; remove it after cutover');
    }
    if (nodeEnv === 'production'
        && parsed.getTime() - Date.now() > MAX_PRODUCTION_LEGACY_PLAINTEXT_BRIDGE_MS) {
      throw new Error('BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL must be at most 31 days in the future');
    }
    legacyPlaintextReadUntil = parsed;
  } else if (rawDeadline === '') {
    legacyPlaintextReadUntil = null;
  }
  return Object.freeze({ keys, legacyPlaintextReadUntil });
}

/** D2 / mcp() resource rules: HTTPS (HTTP loopback only), no query/fragment/credentials. */
function parseBetterAuthOauthIssuer(env: NodeJS.ProcessEnv): BetterAuthOauthIssuerFeatureConfig {
  const resource = (env.MCP_OAUTH_AUDIENCE ?? '').trim();
  if (resource === '') {
    throw new Error('MCP_OAUTH_AUDIENCE is required when BETTER_AUTH_OAUTH_ISSUER_ENABLED=true');
  }
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    throw new Error('MCP_OAUTH_AUDIENCE must be an absolute URL');
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP_OAUTH_AUDIENCE must not contain credentials');
  }
  if (resource.includes('#') || resource.includes('?')) {
    throw new Error('MCP_OAUTH_AUDIENCE must not contain a query or fragment');
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('MCP_OAUTH_AUDIENCE must use HTTPS (HTTP is allowed only for loopback)');
  }
  const scopes = (env.MCP_OAUTH_SCOPES ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (scopes.length === 0) {
    throw new Error('MCP_OAUTH_SCOPES is required when BETTER_AUTH_OAUTH_ISSUER_ENABLED=true');
  }
  if (scopes.length > 32) throw new Error('MCP_OAUTH_SCOPES must contain at most 32 scopes');
  for (const scope of scopes) {
    if (!/^[a-z][a-z0-9._:-]{0,127}$/u.test(scope)) {
      throw new Error(`MCP_OAUTH_SCOPES entry is invalid: ${scope}`);
    }
  }
  if (new Set(scopes).size !== scopes.length) {
    throw new Error('MCP_OAUTH_SCOPES entries must be unique');
  }
  const dcrMaxAnonymousClients = parsePositiveInt(
    env.BETTER_AUTH_DCR_MAX_ANONYMOUS_CLIENTS,
    DEFAULT_DCR_MAX_ANONYMOUS_CLIENTS,
    'BETTER_AUTH_DCR_MAX_ANONYMOUS_CLIENTS',
    { max: 1_000_000 },
  );
  const dcrUnusedClientRetentionSeconds = parsePositiveInt(
    env.BETTER_AUTH_DCR_UNUSED_CLIENT_RETENTION_SECONDS,
    DEFAULT_DCR_UNUSED_CLIENT_RETENTION_SECONDS,
    'BETTER_AUTH_DCR_UNUSED_CLIENT_RETENTION_SECONDS',
    { min: 60, max: 31_536_000 },
  );
  const dcrMaxOwnedClientsPerUser = parsePositiveInt(
    env.BETTER_AUTH_DCR_MAX_OWNED_CLIENTS_PER_USER,
    DEFAULT_DCR_MAX_OWNED_CLIENTS_PER_USER,
    'BETTER_AUTH_DCR_MAX_OWNED_CLIENTS_PER_USER',
    { max: 1_000 },
  );
  const dcrMaxOwnedClients = parsePositiveInt(
    env.BETTER_AUTH_DCR_MAX_OWNED_CLIENTS,
    DEFAULT_DCR_MAX_OWNED_CLIENTS,
    'BETTER_AUTH_DCR_MAX_OWNED_CLIENTS',
    { max: 1_000_000 },
  );
  return Object.freeze({
    resource,
    scopes: Object.freeze(scopes),
    accessTokenExpiresInSeconds: BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    dcrMaxAnonymousClients,
    dcrUnusedClientRetentionSeconds,
    dcrMaxOwnedClientsPerUser,
    dcrMaxOwnedClients,
  });
}

export function loadHttpSecurity(env: NodeJS.ProcessEnv, nodeEnv: string): HttpSecurityConfig {
  const trustedProxyHops = parsePositiveInt(
    env.TRUSTED_PROXY_HOPS,
    0,
    'TRUSTED_PROXY_HOPS',
    { allowZero: true, max: 32 },
  );
  // SEC-T-04: production ignores and refuses hop-count trustProxy. Declare
  // TRUSTED_INGRESS CIDRs instead (empty = peer-only). Hop-count remains a
  // non-production fallback only.
  if (nodeEnv === 'production' && trustedProxyHops > 0) {
    throw new Error(
      'TRUSTED_PROXY_HOPS must be 0 in production; declare TRUSTED_INGRESS CIDRs (empty = peer-only). Hop-count trustProxy is non-production only',
    );
  }
  // FIX-M-006: explicit trusted-ingress allowlist (CIDRs/addresses).
  // Malformed entries fail startup; `declared` tracks an explicit (possibly
  // empty) declaration for the production readiness gate.
  const trustedIngress = parseTrustedIngress(env.TRUSTED_INGRESS);
  const bodyLimitBytes = parsePositiveInt(
    env.HTTP_BODY_LIMIT_BYTES,
    DEFAULT_BODY_LIMIT_BYTES,
    'HTTP_BODY_LIMIT_BYTES',
    { max: 10 * 1024 * 1024 },
  );
  const requestTimeoutMs = parsePositiveInt(
    env.HTTP_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    'HTTP_REQUEST_TIMEOUT_MS',
    { allowZero: true, max: 600_000 },
  );
  const connectionTimeoutMs = parsePositiveInt(
    env.HTTP_CONNECTION_TIMEOUT_MS,
    DEFAULT_CONNECTION_TIMEOUT_MS,
    'HTTP_CONNECTION_TIMEOUT_MS',
    { allowZero: true, max: 600_000 },
  );
  const keepAliveTimeoutMs = parsePositiveInt(
    env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
    'HTTP_KEEP_ALIVE_TIMEOUT_MS',
    { max: 600_000 },
  );
  const authRateLimitMax = parsePositiveInt(
    env.AUTH_RATE_LIMIT_MAX,
    DEFAULT_AUTH_RATE_LIMIT_MAX,
    'AUTH_RATE_LIMIT_MAX',
    { max: 1_000_000 },
  );
  const authRateLimitWindowMs = parsePositiveInt(
    env.AUTH_RATE_LIMIT_WINDOW_MS,
    DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
    'AUTH_RATE_LIMIT_WINDOW_MS',
    { max: 3_600_000 },
  );

  // FIX-M-001: cross-instance shared auth rate-limit adapter. Disabled by
  // default (in-process limiter, zero Redis connections). When enabled, the
  // URL and the HMAC key secret are mandatory and validated fail-closed;
  // errors never echo the URL or the secret.
  const sharedEnabled = parseCacheBooleanEnv(env, 'AUTH_RATE_LIMIT_SHARED', false);
  const sharedRedisUrl = resolveLimiterRedisUrl(env, 'AUTH_RATE_LIMIT_REDIS_URL', {
    enabled: sharedEnabled,
    requiredMessage: 'AUTH_RATE_LIMIT_REDIS_URL is required when AUTH_RATE_LIMIT_SHARED=true',
  });
  const rawSharedSecret = env.AUTH_RATE_LIMIT_KEY_SECRET?.trim() ?? '';
  let sharedKeySecret: Buffer | null = null;
  if (rawSharedSecret !== '') {
    if (rawSharedSecret.length < 16 || rawSharedSecret.length > 512) {
      throw new Error('AUTH_RATE_LIMIT_KEY_SECRET must be 16-512 characters');
    }
    sharedKeySecret = Buffer.from(rawSharedSecret, 'utf8');
  } else if (sharedEnabled) {
    throw new Error('AUTH_RATE_LIMIT_KEY_SECRET is required when AUTH_RATE_LIMIT_SHARED=true');
  }
  const sharedKeyPrefix = (env.AUTH_RATE_LIMIT_KEY_PREFIX ?? 'known').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(sharedKeyPrefix)) {
    throw new Error(
      'AUTH_RATE_LIMIT_KEY_PREFIX must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  const sharedCommandTimeoutMs = parsePositiveInt(
    env.AUTH_RATE_LIMIT_COMMAND_TIMEOUT_MS,
    75,
    'AUTH_RATE_LIMIT_COMMAND_TIMEOUT_MS',
    { max: 5_000 },
  );
  const sharedConnectTimeoutMs = parsePositiveInt(
    env.AUTH_RATE_LIMIT_CONNECT_TIMEOUT_MS,
    1_000,
    'AUTH_RATE_LIMIT_CONNECT_TIMEOUT_MS',
    { max: 30_000 },
  );
  const sharedMaxRetriesPerRequest = parsePositiveInt(
    env.AUTH_RATE_LIMIT_MAX_RETRIES_PER_REQUEST,
    1,
    'AUTH_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
    { min: 0, max: 10 },
  );

  // FIX-M-006: independent Search rate-limit budgets (PUB-R03: the anonymous
  // Search budget never reuses the auth parameters) plus the cross-instance
  // shared adapter, mirroring the auth adapter contract. Errors never echo
  // the URL or the secret.
  const searchAnonMax = parsePositiveInt(
    env.SEARCH_ANON_RATE_LIMIT_MAX,
    DEFAULT_SEARCH_ANON_RATE_LIMIT_MAX,
    'SEARCH_ANON_RATE_LIMIT_MAX',
    { max: 1_000_000 },
  );
  const searchAccountMax = parsePositiveInt(
    env.SEARCH_ACCOUNT_RATE_LIMIT_MAX,
    DEFAULT_SEARCH_ACCOUNT_RATE_LIMIT_MAX,
    'SEARCH_ACCOUNT_RATE_LIMIT_MAX',
    { max: 1_000_000 },
  );
  const searchWindowMs = parsePositiveInt(
    env.SEARCH_RATE_LIMIT_WINDOW_MS,
    DEFAULT_SEARCH_RATE_LIMIT_WINDOW_MS,
    'SEARCH_RATE_LIMIT_WINDOW_MS',
    { max: 3_600_000 },
  );
  const searchSharedEnabled = parseCacheBooleanEnv(env, 'SEARCH_RATE_LIMIT_SHARED', false);
  const searchSharedRedisUrl = resolveLimiterRedisUrl(env, 'SEARCH_RATE_LIMIT_REDIS_URL', {
    enabled: searchSharedEnabled,
    requiredMessage: 'SEARCH_RATE_LIMIT_REDIS_URL is required when SEARCH_RATE_LIMIT_SHARED=true',
  });
  const rawSearchSharedSecret = env.SEARCH_RATE_LIMIT_KEY_SECRET?.trim() ?? '';
  let searchSharedKeySecret: Buffer | null = null;
  if (rawSearchSharedSecret !== '') {
    if (rawSearchSharedSecret.length < 16 || rawSearchSharedSecret.length > 512) {
      throw new Error('SEARCH_RATE_LIMIT_KEY_SECRET must be 16-512 characters');
    }
    searchSharedKeySecret = Buffer.from(rawSearchSharedSecret, 'utf8');
  } else if (searchSharedEnabled) {
    throw new Error('SEARCH_RATE_LIMIT_KEY_SECRET is required when SEARCH_RATE_LIMIT_SHARED=true');
  }
  const searchSharedKeyPrefix = (env.SEARCH_RATE_LIMIT_KEY_PREFIX ?? 'known').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(searchSharedKeyPrefix)) {
    throw new Error(
      'SEARCH_RATE_LIMIT_KEY_PREFIX must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  const searchSharedCommandTimeoutMs = parsePositiveInt(
    env.SEARCH_RATE_LIMIT_COMMAND_TIMEOUT_MS,
    75,
    'SEARCH_RATE_LIMIT_COMMAND_TIMEOUT_MS',
    { max: 5_000 },
  );
  const searchSharedConnectTimeoutMs = parsePositiveInt(
    env.SEARCH_RATE_LIMIT_CONNECT_TIMEOUT_MS,
    1_000,
    'SEARCH_RATE_LIMIT_CONNECT_TIMEOUT_MS',
    { max: 30_000 },
  );
  const searchSharedMaxRetriesPerRequest = parsePositiveInt(
    env.SEARCH_RATE_LIMIT_MAX_RETRIES_PER_REQUEST,
    1,
    'SEARCH_RATE_LIMIT_MAX_RETRIES_PER_REQUEST',
    { min: 0, max: 10 },
  );

  // FIX-M-001/FIX-M-006 startup gate: a production multi-replica declaration
  // without BOTH shared adapters must fail here, before any client/route
  // initialization (single-instance production keeps the in-process
  // limiters).
  const authApiReplicas = parsePositiveInt(
    env.AUTH_API_REPLICAS, 1, 'AUTH_API_REPLICAS', { max: 10_000 },
  );
  if (nodeEnv === 'production' && authApiReplicas > 1) {
    if (!sharedEnabled) {
      throw new Error('Production multi-replica API (AUTH_API_REPLICAS > 1) requires AUTH_RATE_LIMIT_SHARED=true');
    }
    if (!searchSharedEnabled) {
      throw new Error('Production multi-replica API (AUTH_API_REPLICAS > 1) requires SEARCH_RATE_LIMIT_SHARED=true');
    }
  }

  return {
    trustedProxyHops,
    trustedIngress: trustedIngress.entries,
    trustedIngressDeclared: trustedIngress.declared,
    bodyLimitBytes,
    requestTimeoutMs,
    connectionTimeoutMs,
    keepAliveTimeoutMs,
    authRateLimit: {
      maxRequests: authRateLimitMax,
      windowMs: authRateLimitWindowMs,
      shared: Object.freeze({
        enabled: sharedEnabled,
        redisUrl: sharedRedisUrl,
        keySecret: sharedKeySecret,
        keyPrefix: sharedKeyPrefix,
        commandTimeoutMs: sharedCommandTimeoutMs,
        connectTimeoutMs: sharedConnectTimeoutMs,
        maxRetriesPerRequest: sharedMaxRetriesPerRequest,
      }),
    },
    searchRateLimit: {
      anonymousMaxRequests: searchAnonMax,
      accountMaxRequests: searchAccountMax,
      windowMs: searchWindowMs,
      shared: Object.freeze({
        enabled: searchSharedEnabled,
        redisUrl: searchSharedRedisUrl,
        keySecret: searchSharedKeySecret,
        keyPrefix: searchSharedKeyPrefix,
        commandTimeoutMs: searchSharedCommandTimeoutMs,
        connectTimeoutMs: searchSharedConnectTimeoutMs,
        maxRetriesPerRequest: searchSharedMaxRetriesPerRequest,
      }),
    },
    authApiReplicas,
    enableHsts: nodeEnv === 'production' && env.COLP_INSECURE_HTTP !== 'true',
  };
}
