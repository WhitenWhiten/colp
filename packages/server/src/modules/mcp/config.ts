/**
 * P4B-R02 feature-scoped MCP Read configuration contract.
 *
 * Phase 4B only accepts MCP `2026-07-28` (migration decision §1, plan §1.3):
 * the protocol version is a frozen constant, never an environment choice, and
 * legacy mode/Session/Legacy configuration must fail closed instead of being
 * silently ignored (migration decision §8). The MCP endpoint path is the
 * single frozen `POST /collections/-/mcp` (plan §1.6). The request budgets are
 * the R01 hard limits (`phase4b-mcp-entry-contract.ts`) or stricter; listen
 * and output budgets are bounded feature-scoped values frozen here.
 *
 * This module is deliberately pure: no Fastify, no route registration, no
 * live Manifest write, no credential verification (plan §6 P4B-R02 "不包含").
 * `bootstrap/config.ts` owns env parsing and assembles the frozen object;
 * this module owns the types, the constants and the fail-closed assertions so
 * they can be tested directly.
 */
import { MCP_PROTOCOL_VERSION } from '@know-n/colp/mcp';
import { assertOidcEndpointUrl } from '../../bootstrap/oidc-endpoint-policy.js';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_PROTOCOL_VERSIONS,
} from './mcp-compat-protocol.js';

/** Modern-only fixed protocol version (migration decision §1.3, plan §3.5.3). */
export const PHASE4B_MCP_CONFIG_PROTOCOL_VERSION = '2026-07-28' as const;

/** The unique MCP endpoint path; only POST is registered (plan §1.6, R01 contract). */
export const PHASE4B_MCP_CONFIG_ENDPOINT_PATH = '/collections/-/mcp' as const;

// Source-bound cross-check: the host config must never select a second
// protocol version (plan §1.5, migration decision §8). Failing at load time is
// the fail-closed proof of "no protocol version choice".
if (PHASE4B_MCP_CONFIG_PROTOCOL_VERSION !== MCP_PROTOCOL_VERSION) {
  throw new Error(`phase4b mcp config protocol drift: host ${PHASE4B_MCP_CONFIG_PROTOCOL_VERSION} != COLP ${MCP_PROTOCOL_VERSION}`);
}

/**
 * Frozen request budgets, identical to the R01 transport hard limits
 * (`PHASE4B_MCP_HARD_LIMITS`). Feature config may tighten but never exceed
 * these values (plan §6 P4B-R02: "与 R01 硬限制一致或更严").
 */
export const PHASE4B_MCP_CONFIG_REQUEST_BUDGET_MAX = Object.freeze({
  maxBodyBytes: 65_536,
  maxHeaderCount: 64,
  maxHeaderNameBytes: 128,
  maxHeaderValueBytes: 4_096,
  maxConcurrent: 1,
  maxQueue: 2,
} as const);

/** Default listen budgets (bounded; never unbounded). */
export const PHASE4B_MCP_CONFIG_DEFAULT_LISTEN_BUDGET = Object.freeze({
  maxConnections: 16,
  maxQueueBytes: 262_144,
  maxDurationMs: 3_600_000,
} as const);

/** Default output budgets (bounded; never unbounded). */
export const PHASE4B_MCP_CONFIG_DEFAULT_OUTPUT_BUDGET = Object.freeze({
  maxBytes: 1_048_576,
  maxItems: 10_000,
  maxDepth: 16,
} as const);

/** Frozen strict I-JSON request parse limits for MCP bodies. */
export const PHASE4B_MCP_CONFIG_DEFAULT_I_JSON_LIMITS = Object.freeze({
  maxDepth: 16,
  maxMembers: 10_000,
} as const);

/** Frozen host upper bounds; MCP strict I-JSON limits must never exceed these. */
export const PHASE4B_MCP_CONFIG_I_JSON_LIMIT_MAX = Object.freeze({
  maxDepth: 64,
  maxMembers: 100_000,
} as const);

/** Default request rate limit for development/test only; production must set env explicitly. */
export const PHASE4B_MCP_CONFIG_DEFAULT_REQUEST_RATE_LIMIT = Object.freeze({
  maxRequests: 120,
  windowMs: 60_000,
} as const);

/** Frozen upper bounds for MCP request and commit rate/cost windows. */
export const PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX = Object.freeze({
  maxRequests: 10_000,
  maxPlans: 10_000,
  windowMs: 3_600_000,
} as const);

/**
 * Legacy MCP 2025-11-25 configuration keys that must never appear. Presence of
 * any of them fails boot even when the feature flag is off (migration decision
 * §8: "不能静默忽略造成误判"). Frozen so the rejection surface cannot drift.
 */
export const PHASE4B_MCP_FORBIDDEN_LEGACY_ENV_KEYS = Object.freeze([
  'MCP_PROTOCOL_MODE',
  'MCP_PROTOCOL_VERSION',
  'MCP_LEGACY_DEADLINE',
  'MCP_LEGACY_ADAPTER',
  'MCP_SESSION_STORE',
  'MCP_SESSION_BUDGET',
  'MCP_SESSION_TTL_MS',
  'MCP_SESSION_MAX_CONCURRENT',
] as const);

export interface McpReadOauthMetadataConfig {
  /** OAuth issuer identifier URL (https). */
  readonly issuer: string;
  /** OAuth resource audience URL (https). */
  readonly audience: string;
  /** Authorization server metadata URL (https). */
  readonly authorizationServerMetadataUrl: string;
  /** JWKS URL (https); required in production, optional in development. */
  readonly jwksUri: string | null;
  /** Frozen scope support set (1..32 entries). */
  readonly scopes: readonly string[];
  /**
   * Shared revocation store wiring: `postgres` (multi-instance DB store) or
   * `none` (no store; production readiness reports MCP OAuth unavailable and
   * authenticated requests fail closed). Default `none`; production must opt
   * in explicitly (FIX-L-042).
   */
  readonly revocationStore: 'postgres' | 'none';
}

export interface McpReadRequestBudgetConfig {
  readonly maxBodyBytes: number;
  readonly maxHeaderCount: number;
  readonly maxHeaderNameBytes: number;
  readonly maxHeaderValueBytes: number;
  readonly maxConcurrent: number;
  readonly maxQueue: number;
}

export interface McpReadListenBudgetConfig {
  readonly maxConnections: number;
  readonly maxQueueBytes: number;
  readonly maxDurationMs: number;
}

export interface McpReadOutputBudgetConfig {
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly maxDepth: number;
}

export interface McpReadIJsonLimitConfig {
  readonly maxDepth: number;
  readonly maxMembers: number;
}

export interface McpReadCollectionResourceCursorKeyConfig {
  /** Base64-encoded deployment secret containing at least 32 random bytes. */
  readonly id: string;
  readonly secret: string;
}

export interface McpReadCollectionResourceConfig {
  readonly cursorKeys: {
    readonly active: McpReadCollectionResourceCursorKeyConfig;
    readonly retained: readonly McpReadCollectionResourceCursorKeyConfig[];
  };
  readonly cursorTtlMs: number;
}

export interface McpReadBudgetsConfig {
  readonly request: McpReadRequestBudgetConfig;
  readonly listen: McpReadListenBudgetConfig;
  readonly output: McpReadOutputBudgetConfig;
  readonly strictIJson: McpReadIJsonLimitConfig;
}

/**
 * Feature-scoped MCP Read configuration (P4B-R02). Present on `AppConfig` only
 * when `KNOWN_FEATURE_MCP_READ=true`; when the flag is off no MCP-specific
 * configuration is required and no endpoint/profile is exposed (plan §6
 * P4B-R02 完成标准).
 */
export interface McpReadFeatureConfig {
  readonly enabled: true;
  /** Frozen endpoint path (plan §1.6). */
  readonly endpointPath: typeof PHASE4B_MCP_CONFIG_ENDPOINT_PATH;
  /** Exact same-origin as Publication (endpoint must stay on the host origin). */
  readonly origin: string;
  /** Full endpoint URL = origin + endpointPath. */
  readonly endpoint: string;
  /** Must equal the Publication serverUuid (anti-drift, plan §6 P4B-R02). */
  readonly serverUuid: string;
  /** Exact allowed Origins (https, or loopback http outside production). */
  readonly allowedOrigins: readonly string[];
  /** Frozen OAuth metadata (verifier is a later task; this task only freezes fields). */
  readonly oauth: McpReadOauthMetadataConfig;
  readonly budgets: McpReadBudgetsConfig;
  /** Per-principal/client/IP MCP request admission limit; production requires explicit env. */
  readonly requestRateLimit: {
    readonly maxRequests: number;
    readonly windowMs: number;
  };
  /** MCP-specific opaque Resource list cursor keyring and expiry. */
  readonly collectionResources: McpReadCollectionResourceConfig;
  /** Frozen protocol version; never configurable. */
  readonly protocolVersion: typeof PHASE4B_MCP_CONFIG_PROTOCOL_VERSION;
  /**
   * Host compatibility surface. Present only when `KNOWN_FEATURE_MCP_COMPAT=true`
   * (which requires MCP Read). Absent entirely when the flag is off.
   */
  readonly compat?: McpCompatFeatureConfig;
}

/** Nested MCP compatibility config; path and versions are code constants. */
export interface McpCompatFeatureConfig {
  readonly enabled: true;
  readonly endpointPath: typeof MCP_COMPAT_ENDPOINT_PATH;
  readonly supportedProtocolVersions: typeof MCP_COMPAT_PROTOCOL_VERSIONS;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SCOPE_RE = /^[a-z][a-z0-9._:-]{0,127}$/u;
const CURSOR_KEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;
const MCP_COLLECTION_RESOURCE_CURSOR_TTL_MS_MAX = 3_600_000;
const LOOPBACK_HOSTNAMES = Object.freeze(['localhost', '127.0.0.1', '[::1]'] as const);

/**
 * Fail-closed same-origin check for issuer and JWKS (T-06 / T-08). Used
 * whenever both URLs are configured. This helper must not grow a second flag;
 * ADR P4's NODE_ENV=test loopback allowance lives in assertMcpReadFeatureConfig.
 */
export function assertMcpOauthIssuerJwksSameOrigin(issuer: string, jwksUri: string): void {
  let issuerUrl: URL;
  let jwksUrl: URL;
  try {
    issuerUrl = new URL(issuer);
    jwksUrl = new URL(jwksUri);
  } catch {
    throw new Error('MCP OAuth issuer and JWKS URI must be absolute URLs');
  }
  if (issuerUrl.origin !== jwksUrl.origin) {
    throw new Error('MCP OAuth issuer and JWKS URI must share the same origin');
  }
}

function isLoopback(hostname: string): boolean {
  return (LOOPBACK_HOSTNAMES as readonly string[]).includes(hostname.toLowerCase());
}

function parseExactOrigin(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
    if (url.origin !== value || url.username || url.password) throw new Error('not exact');
  } catch {
    throw new Error(`${label} must be an exact absolute origin URL without userinfo`);
  }
  return url;
}

function assertPositiveBounded(
  value: number,
  label: string,
  max: number,
  min = 1,
): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a safe integer in ${min}..${max}`);
  }
}

/** Fail-closed host assertion for strict I-JSON parse limits. */
export function assertPhase4bMcpIJsonLimitConfig(limits: McpReadIJsonLimitConfig): void {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new Error('MCP strict I-JSON limits are required');
  }
  assertPositiveBounded(
    limits.maxDepth,
    'MCP strict I-JSON maxDepth',
    PHASE4B_MCP_CONFIG_I_JSON_LIMIT_MAX.maxDepth,
  );
  assertPositiveBounded(
    limits.maxMembers,
    'MCP strict I-JSON maxMembers',
    PHASE4B_MCP_CONFIG_I_JSON_LIMIT_MAX.maxMembers,
  );
}

/**
 * Re-assert options for MCP Read feature config. ADR P4's loopback allowance
 * is `oauthIssuerEnabled === true && nodeEnv === 'test'` only. Self-hosted
 * `COLP_INSECURE_HTTP=true` is a separate operator acknowledgement and is the
 * only other way production accepts an http MCP origin. Boot-time composition
 * must pass the same object `loadConfig` used, or re-assert defaults to
 * production-strict unless that acknowledgement is set in the process environment.
 */
export interface McpReadFeatureConfigAssertOptions {
  readonly production?: boolean;
  readonly expectedServerUuid?: string;
  readonly oauthIssuerEnabled?: boolean;
  readonly nodeEnv?: string;
  readonly insecureHttp?: boolean;
}

/** Same P4 mapping `loadMcpReadFeatureConfig` / API boot use for re-assert. */
export function mcpReadFeatureConfigAssertOptions(input: {
  readonly nodeEnv: string;
  readonly oauthIssuerEnabled: boolean;
  readonly insecureHttp?: boolean;
}): McpReadFeatureConfigAssertOptions {
  return Object.freeze({
    production: input.nodeEnv === 'production',
    oauthIssuerEnabled: input.oauthIssuerEnabled,
    nodeEnv: input.nodeEnv,
    insecureHttp: input.insecureHttp ?? process.env.COLP_INSECURE_HTTP === 'true',
  });
}

/** Fail-closed assertion for the frozen MCP Read feature config. */
export function assertMcpReadFeatureConfig(
  config: McpReadFeatureConfig,
  options: McpReadFeatureConfigAssertOptions = {},
): void {
  const production = options.production === true;
  // ADR P4: NODE_ENV=test + built-in issuer may use same-origin loopback
  // issuer/JWKS. COLP_INSECURE_HTTP is the self-hosted acknowledgement that
  // the product origin itself is http, including on a LAN address.
  const insecureHttp = options.insecureHttp ?? process.env.COLP_INSECURE_HTTP === 'true';
  const allowSameOriginLoopback =
    options.oauthIssuerEnabled === true && options.nodeEnv === 'test';
  const oauthEndpointMode = (allowSameOriginLoopback || insecureHttp) ? 'relaxed' : 'strict';
  const httpAllowed = (hostname: string): boolean => insecureHttp || isLoopback(hostname);
  if (config.protocolVersion !== PHASE4B_MCP_CONFIG_PROTOCOL_VERSION) {
    throw new Error(`MCP read protocolVersion is fixed to ${PHASE4B_MCP_CONFIG_PROTOCOL_VERSION}`);
  }
  if (config.endpointPath !== PHASE4B_MCP_CONFIG_ENDPOINT_PATH) {
    throw new Error(`MCP endpoint path is frozen at ${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`);
  }
  const origin = parseExactOrigin(config.origin, 'MCP origin');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && httpAllowed(origin.hostname))) {
    throw new Error('MCP origin must use https (http is allowed only for loopback)');
  }
  if (production && origin.protocol !== 'https:' && !insecureHttp) {
    throw new Error('MCP origin must use https in production');
  }
  if (config.endpoint !== `${config.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`) {
    throw new Error('MCP endpoint must stay on the configured origin at /collections/-/mcp');
  }
  if (!UUID_RE.test(config.serverUuid)) {
    throw new Error('MCP serverUuid must be a lowercase UUID');
  }
  if (options.expectedServerUuid !== undefined && config.serverUuid !== options.expectedServerUuid) {
    throw new Error('MCP serverUuid drift: expected the Publication serverUuid');
  }
  if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0
      || config.allowedOrigins.length > 8) {
    throw new Error('MCP allowedOrigins must contain 1..8 entries');
  }
  for (const originValue of config.allowedOrigins) {
    const allowed = parseExactOrigin(originValue, 'MCP allowed origin');
    if (allowed.protocol !== 'https:' && !(allowed.protocol === 'http:' && httpAllowed(allowed.hostname))) {
      throw new Error('MCP allowed origins must use https (http is allowed only for loopback)');
    }
    if (production && allowed.protocol !== 'https:' && !insecureHttp) {
      throw new Error('MCP allowed origins must use https in production');
    }
  }
  assertOidcEndpointUrl('MCP OAuth issuer', config.oauth.issuer, oauthEndpointMode);
  assertOidcEndpointUrl('MCP OAuth audience', config.oauth.audience, oauthEndpointMode);
  assertOidcEndpointUrl('MCP OAuth authorization server metadata URL', config.oauth.authorizationServerMetadataUrl, oauthEndpointMode);
  if (config.oauth.jwksUri === null) {
    if (production) throw new Error('MCP OAuth JWKS URI is required in production');
  } else {
    assertOidcEndpointUrl('MCP OAuth JWKS URI', config.oauth.jwksUri, oauthEndpointMode);
    // T-06 / T-08: issuer and JWKS share origin whenever both are configured.
    // Issuer-on is required for the P4 loopback allowance above; this helper
    // stays flag-free.
    assertMcpOauthIssuerJwksSameOrigin(config.oauth.issuer, config.oauth.jwksUri);
  }
  if (!Array.isArray(config.oauth.scopes) || config.oauth.scopes.length === 0
      || config.oauth.scopes.length > 32) {
    throw new Error('MCP OAuth scopes must contain 1..32 entries');
  }
  if (new Set(config.oauth.scopes).size !== config.oauth.scopes.length) {
    throw new Error('MCP OAuth scopes must be unique');
  }
  for (const scope of config.oauth.scopes) {
    if (typeof scope !== 'string' || !SCOPE_RE.test(scope)) {
      throw new Error(`MCP OAuth scope is invalid: ${String(scope)}`);
    }
  }
  if (config.oauth.revocationStore !== 'postgres' && config.oauth.revocationStore !== 'none') {
    throw new Error('MCP OAuth revocationStore must be postgres or none');
  }

  const request = config.budgets.request;
  assertPositiveBounded(request.maxBodyBytes, 'MCP request maxBodyBytes', PHASE4B_MCP_CONFIG_REQUEST_BUDGET_MAX.maxBodyBytes);
  assertPositiveBounded(request.maxHeaderCount, 'MCP request maxHeaderCount', PHASE4B_MCP_CONFIG_REQUEST_BUDGET_MAX.maxHeaderCount);
  assertPositiveBounded(request.maxHeaderNameBytes, 'MCP request maxHeaderNameBytes', PHASE4B_MCP_CONFIG_REQUEST_BUDGET_MAX.maxHeaderNameBytes);
  assertPositiveBounded(request.maxHeaderValueBytes, 'MCP request maxHeaderValueBytes', PHASE4B_MCP_CONFIG_REQUEST_BUDGET_MAX.maxHeaderValueBytes);
  assertPositiveBounded(request.maxConcurrent, 'MCP request maxConcurrent', PHASE4B_MCP_CONFIG_REQUEST_BUDGET_MAX.maxConcurrent);
  assertPositiveBounded(request.maxQueue, 'MCP request maxQueue', PHASE4B_MCP_CONFIG_REQUEST_BUDGET_MAX.maxQueue);

  const listen = config.budgets.listen;
  assertPositiveBounded(listen.maxConnections, 'MCP listen maxConnections', 1_024);
  assertPositiveBounded(listen.maxQueueBytes, 'MCP listen maxQueueBytes', 1_048_576);
  assertPositiveBounded(listen.maxDurationMs, 'MCP listen maxDurationMs', 86_400_000);

  const output = config.budgets.output;
  assertPositiveBounded(output.maxBytes, 'MCP output maxBytes', 16_777_216);
  assertPositiveBounded(output.maxItems, 'MCP output maxItems', 100_000);
  assertPositiveBounded(output.maxDepth, 'MCP output maxDepth', 64);
  assertPhase4bMcpIJsonLimitConfig(config.budgets.strictIJson);

  const requestRateLimit = config.requestRateLimit;
  if (!requestRateLimit || typeof requestRateLimit !== 'object' || Array.isArray(requestRateLimit)) {
    throw new Error('MCP requestRateLimit config is required');
  }
  assertPositiveBounded(
    requestRateLimit.maxRequests,
    'MCP requestRateLimit maxRequests',
    PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.maxRequests,
  );
  assertPositiveBounded(
    requestRateLimit.windowMs,
    'MCP requestRateLimit windowMs',
    PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.windowMs,
  );

  const collectionResources = config.collectionResources;
  if (!collectionResources || typeof collectionResources !== 'object' || Array.isArray(collectionResources)) {
    throw new Error('MCP collectionResources config is required');
  }
  if (
    !Number.isSafeInteger(collectionResources.cursorTtlMs)
    || collectionResources.cursorTtlMs < 1_000
    || collectionResources.cursorTtlMs > MCP_COLLECTION_RESOURCE_CURSOR_TTL_MS_MAX
  ) {
    throw new Error('MCP collectionResources cursorTtlMs must be a safe integer in 1000..3600000');
  }
  const cursorKeys = collectionResources.cursorKeys;
  if (!cursorKeys || typeof cursorKeys !== 'object' || Array.isArray(cursorKeys)
      || !cursorKeys.active || !Array.isArray(cursorKeys.retained) || cursorKeys.retained.length > 8) {
    throw new Error('MCP collectionResources cursorKeys must contain an active key and at most 8 retained keys');
  }
  const allCursorKeys = [cursorKeys.active, ...cursorKeys.retained];
  if (new Set(allCursorKeys.map((key) => key.id)).size !== allCursorKeys.length) {
    throw new Error('MCP collectionResources cursor key ids must be unique');
  }
  if (new Set(allCursorKeys.map((key) => key.secret)).size !== allCursorKeys.length) {
    throw new Error('MCP collectionResources cursor key material must not be reused');
  }
  for (const key of allCursorKeys) {
    if (!key || typeof key !== 'object' || !CURSOR_KEY_ID_RE.test(key.id)) {
      throw new Error('MCP collectionResources cursor key id is invalid');
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(key.secret, 'base64');
    } catch {
      throw new Error('MCP collectionResources cursor key secret encoding is invalid');
    }
    const canonical = bytes.toString('base64');
    if (bytes.byteLength < 32 || canonical !== key.secret) {
      bytes.fill(0);
      throw new Error('MCP collectionResources cursor key secret must be canonical base64 with at least 32 bytes');
    }
    bytes.fill(0);
  }

  if (config.compat !== undefined) {
    assertMcpCompatFeatureConfig(config.compat);
  }
}

/** Fail-closed assertion for the nested MCP compatibility config. */
export function assertMcpCompatFeatureConfig(compat: McpCompatFeatureConfig): void {
  if (compat.enabled !== true) {
    throw new Error('MCP compat config is present only when enabled');
  }
  if (compat.endpointPath !== MCP_COMPAT_ENDPOINT_PATH) {
    throw new Error(`MCP compat endpoint path is frozen at ${MCP_COMPAT_ENDPOINT_PATH}`);
  }
  if (
    !Array.isArray(compat.supportedProtocolVersions)
    || compat.supportedProtocolVersions.length !== MCP_COMPAT_PROTOCOL_VERSIONS.length
    || compat.supportedProtocolVersions.some(
      (version, index) => version !== MCP_COMPAT_PROTOCOL_VERSIONS[index],
    )
  ) {
    throw new Error('MCP compat supportedProtocolVersions must be exactly ["2025-11-25"]');
  }
}

/**
 * Fail-closed absence gate for legacy MCP configuration (migration decision
 * §8). Called unconditionally so legacy mode/Session/Legacy keys can never be
 * silently ignored, even while the Modern feature flag is off.
 */
export function assertNoForbiddenMcpLegacyEnvKeys(
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const key of PHASE4B_MCP_FORBIDDEN_LEGACY_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') {
      throw new Error(`${key} is legacy MCP 2025-11-25 configuration; Phase 4B accepts only MCP 2026-07-28 and must fail closed`);
    }
  }
}
