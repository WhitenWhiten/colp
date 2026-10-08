import {
  assertMcpReadFeatureConfig,
  PHASE4B_MCP_CONFIG_DEFAULT_I_JSON_LIMITS,
  PHASE4B_MCP_CONFIG_DEFAULT_REQUEST_RATE_LIMIT,
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
  PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX,
  DEFAULT_MCP_WRITE_MAINTENANCE_INTERVAL_MS,
  MCP_WRITE_MAINTENANCE_INTERVAL_MAX_MS,
  MCP_WRITE_MAINTENANCE_INTERVAL_MIN_MS,
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_PROTOCOL_VERSIONS,
  mcpReadFeatureConfigAssertOptions,
  type McpReadFeatureConfig,
  type McpReadListenBudgetConfig,
  type McpReadOauthMetadataConfig,
  type McpReadOutputBudgetConfig,
  type McpReadRequestBudgetConfig,
} from '../modules/mcp/index.js';
import { parsePositiveInt, requireNonEmpty } from './config-parse-helpers.js';
import type { McpWriteFeatureConfig } from './config-types.js';

/** Default commit distinct-plan budget for development/test only; production must set env explicitly. */
export const DEFAULT_MCP_WRITE_COMMIT_RATE_LIMIT = Object.freeze({
  maxPlans: 60,
  windowMs: 60_000,
});
const DEV_MCP_COLLECTION_RESOURCE_CURSOR_SECRET = Buffer.alloc(32, 29).toString('base64');


export function parseMcpCollectionResourceRetainedKeys(raw: string): readonly {
  readonly id: string;
  readonly secret: string;
}[] {
  if (raw === '') return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('MCP_COLLECTION_RESOURCE_CURSOR_RETAINED_KEYS must be a JSON array');
  }
  if (!Array.isArray(parsed) || parsed.length > 8) {
    throw new Error('MCP_COLLECTION_RESOURCE_CURSOR_RETAINED_KEYS must be a JSON array with at most 8 entries');
  }
  return Object.freeze(parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`MCP_COLLECTION_RESOURCE_CURSOR_RETAINED_KEYS[${index}] must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'id,secret'
      || typeof record.id !== 'string'
      || typeof record.secret !== 'string') {
      throw new Error(`MCP_COLLECTION_RESOURCE_CURSOR_RETAINED_KEYS[${index}] must contain only id and secret`);
    }
    return Object.freeze({ id: record.id, secret: record.secret });
  }));
}

export function loadMcpWriteFeatureConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  productOrigin: string,
): McpWriteFeatureConfig {
  const rawKey = requireNonEmpty(
    env,
    'MCP_WRITE_REQUEST_STATE_KEY',
    nodeEnv === 'production' ? undefined : Buffer.alloc(32, 77).toString('base64'),
  );
  let bytes: Buffer;
  try {
    bytes = Buffer.from(rawKey, 'base64');
  } catch {
    bytes = Buffer.alloc(0);
  }
  if (bytes.byteLength < 32 || bytes.toString('base64') !== rawKey) {
    bytes.fill(0);
    throw new Error('MCP_WRITE_REQUEST_STATE_KEY must be canonical base64 with at least 32 bytes');
  }
  bytes.fill(0);

  const rawApprovalBaseUri = env.MCP_WRITE_APPROVAL_BASE_URI?.trim();
  const approvalBaseUri = rawApprovalBaseUri
    ? rawApprovalBaseUri
    : `${productOrigin}/approvals`;
  let parsed: URL;
  try {
    parsed = new URL(approvalBaseUri);
  } catch {
    throw new Error('MCP_WRITE_APPROVAL_BASE_URI must be an absolute HTTP(S) URL');
  }
  const insecureHttp = env.COLP_INSECURE_HTTP === 'true';
  if (
    parsed.href !== approvalBaseUri
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.protocol !== 'https:'
      && !(parsed.protocol === 'http:' && (nodeEnv !== 'production' || insecureHttp)))
  ) {
    throw new Error('MCP_WRITE_APPROVAL_BASE_URI must be an exact HTTP(S) origin path without query, fragment, or userinfo');
  }
  if (parsed.pathname === '/api' || parsed.pathname.startsWith('/api/')) {
    throw new Error('MCP_WRITE_APPROVAL_BASE_URI must point to a browser approval UI outside the /api JSON namespace');
  }

  return Object.freeze({
    enabled: true as const,
    requestStateKey: rawKey,
    approvalBaseUri,
    planTtlMilliseconds: parsePositiveInt(
      env.MCP_WRITE_PLAN_TTL_MS,
      900_000,
      'MCP_WRITE_PLAN_TTL_MS',
      { min: 60_000, max: 3_600_000 },
    ),
    maintenanceIntervalMs: parsePositiveInt(
      env.MCP_WRITE_MAINTENANCE_INTERVAL_MS,
      DEFAULT_MCP_WRITE_MAINTENANCE_INTERVAL_MS,
      'MCP_WRITE_MAINTENANCE_INTERVAL_MS',
      {
        min: MCP_WRITE_MAINTENANCE_INTERVAL_MIN_MS,
        max: MCP_WRITE_MAINTENANCE_INTERVAL_MAX_MS,
      },
    ),
    commitRateLimit: loadMcpRateLimitConfig(
      env,
      nodeEnv,
      'MCP_WRITE_COMMIT_RATE_LIMIT',
      DEFAULT_MCP_WRITE_COMMIT_RATE_LIMIT.maxPlans,
      DEFAULT_MCP_WRITE_COMMIT_RATE_LIMIT.windowMs,
      PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.maxPlans,
      PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.windowMs,
      'maxPlans',
    ),
  });
}

export function loadMcpRateLimitConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  prefix: string,
  defaultLimit: number,
  defaultWindowMs: number,
  maxLimit: number,
  maxWindowMs: number,
  valueKey: 'maxRequests',
): Readonly<{ readonly maxRequests: number; readonly windowMs: number }>;
export function loadMcpRateLimitConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  prefix: string,
  defaultLimit: number,
  defaultWindowMs: number,
  maxLimit: number,
  maxWindowMs: number,
  valueKey: 'maxPlans',
): Readonly<{ readonly maxPlans: number; readonly windowMs: number }>;
export function loadMcpRateLimitConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  prefix: string,
  defaultLimit: number,
  defaultWindowMs: number,
  maxLimit: number,
  maxWindowMs: number,
  valueKey: 'maxRequests' | 'maxPlans',
): Readonly<{
  readonly maxRequests?: number;
  readonly maxPlans?: number;
  readonly windowMs: number;
}> {
  const maxKey = `${prefix}_MAX`;
  const windowKey = `${prefix}_WINDOW_MS`;
  if (nodeEnv === 'production' && (!env[maxKey]?.trim() || !env[windowKey]?.trim())) {
    throw new Error(`${maxKey} and ${windowKey} are required in production`);
  }
  const limit = parsePositiveInt(env[maxKey], defaultLimit, maxKey, { max: maxLimit });
  const windowMs = parsePositiveInt(env[windowKey], defaultWindowMs, windowKey, { max: maxWindowMs });
  return Object.freeze(
    valueKey === 'maxPlans'
      ? { maxPlans: limit, windowMs }
      : { maxRequests: limit, windowMs },
  );
}

export function parseMcpScopes(raw: string | undefined): readonly string[] {
  const scopes = (raw ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (scopes.length === 0) {
    throw new Error('MCP_OAUTH_SCOPES is required when KNOWN_FEATURE_MCP_READ is enabled');
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
  return Object.freeze(scopes);
}

export function parseMcpAllowedOrigins(raw: string | undefined): readonly string[] {
  const origins = (raw ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (origins.length === 0) {
    throw new Error('MCP_ALLOWED_ORIGINS is required when KNOWN_FEATURE_MCP_READ is enabled');
  }
  if (origins.length > 8) throw new Error('MCP_ALLOWED_ORIGINS must contain at most 8 origins');
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.origin !== origin || url.username || url.password) throw new Error('origin must be exact');
    } catch {
      throw new Error(`MCP_ALLOWED_ORIGINS entry is not an exact origin: ${origin}`);
    }
  }
  return Object.freeze(origins);
}

/**
 * Phase 4B MCP Read feature-scoped config (P4B-R02). Defaults off; when enabled
 * every MCP value is required and fail-closed (plan §6 P4B-R02). The endpoint
 * path and protocol version are frozen constants; serverUuid must match the
 * Publication serverUuid (anti-drift); budgets never exceed the R01 hard
 * limits; OAuth metadata is frozen without implementing a verifier; secrets
 * are `${VAR}` references, never plaintext.
 */
export function loadMcpReadFeatureConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  publicationOrigin: string,
  publicationServerUuid: string,
  options: {
    readonly oauthIssuerEnabled?: boolean;
    readonly reportsMcpEnabled?: boolean;
    readonly reportsMcpWriteEnabled?: boolean;
    readonly communityEnabled?: boolean;
    readonly contentGovernanceEnabled?: boolean;
  } = {},
): McpReadFeatureConfig | undefined {
  const mcpFlag = (env.KNOWN_FEATURE_MCP_READ ?? 'false').trim().toLowerCase();
  if (mcpFlag !== 'true' && mcpFlag !== 'false') {
    throw new Error('KNOWN_FEATURE_MCP_READ must be true or false');
  }
  const compatFlag = (env.KNOWN_FEATURE_MCP_COMPAT ?? 'false').trim().toLowerCase();
  if (compatFlag !== 'true' && compatFlag !== 'false') {
    throw new Error('KNOWN_FEATURE_MCP_COMPAT must be true or false');
  }
  if (compatFlag === 'true' && mcpFlag !== 'true') {
    throw new Error('KNOWN_FEATURE_MCP_COMPAT requires KNOWN_FEATURE_MCP_READ=true');
  }
  if (mcpFlag !== 'true') {
    if (options.reportsMcpEnabled || options.reportsMcpWriteEnabled) {
      throw new Error(
        'KNOWN_FEATURE_REPORTS_MCP requires KNOWN_FEATURE_MCP_READ=true',
      );
    }
    return undefined;
  }
  const serverUuid = requireNonEmpty(env, 'MCP_SERVER_UUID');
  const allowedOrigins = parseMcpAllowedOrigins(env.MCP_ALLOWED_ORIGINS?.trim());
  const oauthIssuer = requireNonEmpty(env, 'MCP_OAUTH_ISSUER');
  const oauthAudience = requireNonEmpty(env, 'MCP_OAUTH_AUDIENCE');
  const asMetadataUrl = requireNonEmpty(env, 'MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL');
  const jwksUri = env.MCP_OAUTH_JWKS_URI?.trim() || null;
  const scopes = parseMcpScopes(env.MCP_OAUTH_SCOPES?.trim());
  if (options.reportsMcpEnabled && !scopes.includes('reports:read')) {
    throw new Error('KNOWN_FEATURE_REPORTS_MCP requires reports:read in MCP_OAUTH_SCOPES');
  }
  if (options.reportsMcpWriteEnabled
      && (!scopes.includes('reports:write') || !scopes.includes('reports:publish'))) {
    throw new Error(
      'KNOWN_FEATURE_REPORTS_MCP_WRITE requires reports:write and reports:publish in MCP_OAUTH_SCOPES',
    );
  }
  if (options.communityEnabled
      && (!scopes.includes('product:read') || !scopes.includes('product:write'))) {
    throw new Error(
      'KNOWN_FEATURE_COMMUNITY requires product:read and product:write in MCP_OAUTH_SCOPES',
    );
  }
  if (options.contentGovernanceEnabled
      && (!scopes.includes('product:read') || !scopes.includes('product:write'))) {
    throw new Error(
      'KNOWN_FEATURE_CONTENT_GOVERNANCE requires product:read and product:write in MCP_OAUTH_SCOPES',
    );
  }
  const revocationStoreRaw = (env.MCP_OAUTH_REVOCATION_STORE ?? 'none').trim().toLowerCase();
  if (revocationStoreRaw !== 'postgres' && revocationStoreRaw !== 'none') {
    throw new Error("MCP_OAUTH_REVOCATION_STORE must be 'postgres' or 'none'");
  }
  if (nodeEnv === 'production' && jwksUri !== null && revocationStoreRaw !== 'postgres') {
    throw new Error(
      "MCP_OAUTH_REVOCATION_STORE must be 'postgres' in production when MCP OAuth JWKS URI is configured",
    );
  }
  const request: McpReadRequestBudgetConfig = Object.freeze({
    maxBodyBytes: parsePositiveInt(env.MCP_REQUEST_MAX_BODY_BYTES, 65_536,
      'MCP_REQUEST_MAX_BODY_BYTES', { max: 65_536 }),
    maxHeaderCount: parsePositiveInt(env.MCP_REQUEST_MAX_HEADER_COUNT, 64,
      'MCP_REQUEST_MAX_HEADER_COUNT', { max: 64 }),
    maxHeaderNameBytes: parsePositiveInt(env.MCP_REQUEST_MAX_HEADER_NAME_BYTES, 128,
      'MCP_REQUEST_MAX_HEADER_NAME_BYTES', { max: 128 }),
    maxHeaderValueBytes: parsePositiveInt(env.MCP_REQUEST_MAX_HEADER_VALUE_BYTES, 4_096,
      'MCP_REQUEST_MAX_HEADER_VALUE_BYTES', { max: 4_096 }),
    maxConcurrent: parsePositiveInt(env.MCP_REQUEST_MAX_CONCURRENT, 1,
      'MCP_REQUEST_MAX_CONCURRENT', { max: 1 }),
    maxQueue: parsePositiveInt(env.MCP_REQUEST_MAX_QUEUE, 2,
      'MCP_REQUEST_MAX_QUEUE', { max: 2 }),
  });
  const listen: McpReadListenBudgetConfig = Object.freeze({
    maxConnections: parsePositiveInt(env.MCP_LISTEN_MAX_CONNECTIONS, 16,
      'MCP_LISTEN_MAX_CONNECTIONS', { max: 1_024 }),
    maxQueueBytes: parsePositiveInt(env.MCP_LISTEN_MAX_QUEUE_BYTES, 262_144,
      'MCP_LISTEN_MAX_QUEUE_BYTES', { max: 1_048_576 }),
    maxDurationMs: parsePositiveInt(env.MCP_LISTEN_MAX_DURATION_MS, 3_600_000,
      'MCP_LISTEN_MAX_DURATION_MS', { max: 86_400_000 }),
  });
  const output: McpReadOutputBudgetConfig = Object.freeze({
    maxBytes: parsePositiveInt(env.MCP_OUTPUT_MAX_BYTES, 1_048_576,
      'MCP_OUTPUT_MAX_BYTES', { max: 16_777_216 }),
    maxItems: parsePositiveInt(env.MCP_OUTPUT_MAX_ITEMS, 10_000,
      'MCP_OUTPUT_MAX_ITEMS', { max: 100_000 }),
    maxDepth: parsePositiveInt(env.MCP_OUTPUT_MAX_DEPTH, 16,
      'MCP_OUTPUT_MAX_DEPTH', { max: 64 }),
  });
  if (options.communityEnabled && output.maxBytes < 262_144) {
    throw new Error(
      'KNOWN_FEATURE_COMMUNITY requires MCP_OUTPUT_MAX_BYTES of at least 262144 for the community compat tools',
    );
  }
  const collectionResourceActiveKeyId = requireNonEmpty(
    env,
    'MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_KEY_ID',
    nodeEnv === 'production' ? undefined : 'mcp-collection-resource-v1',
  );
  const collectionResourceActiveSecret = requireNonEmpty(
    env,
    'MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_SECRET',
    nodeEnv === 'production' ? undefined : DEV_MCP_COLLECTION_RESOURCE_CURSOR_SECRET,
  );
  const collectionResources = Object.freeze({
    cursorKeys: Object.freeze({
      active: Object.freeze({
        id: collectionResourceActiveKeyId,
        secret: collectionResourceActiveSecret,
      }),
      retained: parseMcpCollectionResourceRetainedKeys(
        env.MCP_COLLECTION_RESOURCE_CURSOR_RETAINED_KEYS?.trim() ?? '',
      ),
    }),
    cursorTtlMs: parsePositiveInt(
      env.MCP_COLLECTION_RESOURCE_CURSOR_TTL_MS,
      900_000,
      'MCP_COLLECTION_RESOURCE_CURSOR_TTL_MS',
      { min: 1_000, max: 3_600_000 },
    ),
  });
  const oauth: McpReadOauthMetadataConfig = Object.freeze({
    issuer: oauthIssuer,
    audience: oauthAudience,
    authorizationServerMetadataUrl: asMetadataUrl,
    jwksUri,
    scopes,
    revocationStore: revocationStoreRaw as 'postgres' | 'none',
  });
  const config: McpReadFeatureConfig = Object.freeze({
    enabled: true,
    endpointPath: PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
    origin: publicationOrigin,
    endpoint: `${publicationOrigin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    serverUuid,
    allowedOrigins,
    oauth,
    budgets: Object.freeze({
      request,
      listen,
      output,
      strictIJson: PHASE4B_MCP_CONFIG_DEFAULT_I_JSON_LIMITS,
    }),
    requestRateLimit: loadMcpRateLimitConfig(
      env,
      nodeEnv,
      'MCP_REQUEST_RATE_LIMIT',
      PHASE4B_MCP_CONFIG_DEFAULT_REQUEST_RATE_LIMIT.maxRequests,
      PHASE4B_MCP_CONFIG_DEFAULT_REQUEST_RATE_LIMIT.windowMs,
      PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.maxRequests,
      PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.windowMs,
      'maxRequests',
    ),
    collectionResources,
    protocolVersion: PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
    ...(compatFlag === 'true'
      ? {
          compat: Object.freeze({
            enabled: true as const,
            endpointPath: MCP_COMPAT_ENDPOINT_PATH,
            supportedProtocolVersions: MCP_COMPAT_PROTOCOL_VERSIONS,
          }),
        }
      : {}),
  });
  assertMcpReadFeatureConfig(config, {
    ...mcpReadFeatureConfigAssertOptions({
      nodeEnv,
      oauthIssuerEnabled: options.oauthIssuerEnabled === true,
      insecureHttp: env.COLP_INSECURE_HTTP === 'true',
    }),
    expectedServerUuid: publicationServerUuid,
  });
  return config;
}
