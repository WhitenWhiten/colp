/**
 * P4B-R04 protected resource metadata contract.
 *
 * The published document is fixed to the validated feature config: one
 * resource identifier, one authorization server issuer identifier (RFC 9728),
 * the frozen scope directory, and the configured JWKS URI. It never accepts
 * user-supplied discovery, never selects a protocol version, and never exposes
 * Session or Legacy configuration (migration decision §8).
 */
import {
  assertMcpReadFeatureConfig,
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  type McpReadFeatureConfig,
  type McpReadFeatureConfigAssertOptions,
} from './config.js';
import { MCP_COMPAT_ENDPOINT_PATH } from './mcp-compat-protocol.js';
import { withMcpOauthAcceptedScopes } from './oauth-verifier.js';

/** Ordinary Product scopes added to MCP PRM / consent without replacing native MCP scopes. */
export const MCP_OAUTH_PRODUCT_READ_SCOPE = 'product:read' as const;
export const MCP_OAUTH_PRODUCT_WRITE_SCOPE = 'product:write' as const;

function withOrdinaryProductOauthScopes(scopes: readonly string[]): readonly string[] {
  const extra = [MCP_OAUTH_PRODUCT_READ_SCOPE, MCP_OAUTH_PRODUCT_WRITE_SCOPE]
    .filter((scope) => !scopes.includes(scope));
  return extra.length === 0 ? scopes : [...scopes, ...extra];
}

/** Compat resource URL derived from the strict MCP OAuth audience. */
export function mcpCompatResourceAudience(strictAudience: string): string {
  const url = new URL(strictAudience);
  return `${url.origin}${MCP_COMPAT_ENDPOINT_PATH}`;
}

/**
 * Audiences both MCP HTTP surfaces accept. Token `aud` is whichever resource
 * the client requested; verifiers on strict and compat both allow this set.
 */
export function mcpOauthAcceptedAudiences(strictAudience: string): readonly string[] {
  const compat = mcpCompatResourceAudience(strictAudience);
  if (compat === strictAudience) return Object.freeze([strictAudience]);
  return Object.freeze([strictAudience, compat]);
}

/** Unique OAuth protected resource metadata path published with the MCP surface. */
export const PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource' as const;

/** RFC 9728 resource-path-inserted alias for the strict MCP endpoint. */
export const PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH =
  `${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}` as const;

/** RFC 9728 path-inserted alias for the host-compat endpoint. */
export const PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_COMPAT_RESOURCE_PATH =
  `${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH}${MCP_COMPAT_ENDPOINT_PATH}` as const;

/** Which MCP HTTP surface a PRM document or challenge describes. */
export type McpProtectedResourceMetadataSurface = 'strict' | 'compat';

export interface CreateMcpReadProtectedResourceMetadataOptions
  extends McpReadFeatureConfigAssertOptions {
  readonly surface?: McpProtectedResourceMetadataSurface;
}

export interface McpReadProtectedResourceMetadata {
  /** Protected resource identifier for the accessed URL (RFC 9728 `resource`). */
  readonly resource: string;
  /** Exactly one authorization server issuer identifier from validated config. */
  readonly authorization_servers: readonly string[];
  /** Frozen scope directory used by the R03 verifier. */
  readonly scopes_supported: readonly string[];
  /** JWKS URL used by the R03 verifier; null only in non-production dev config. */
  readonly jwks_uri: string | null;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Absolute RFC 9728 path-inserted PRM URL for a surface, from validated
 * `config.origin` — never from request Host or Origin.
 */
export function mcpProtectedResourceMetadataUrl(
  config: Pick<McpReadFeatureConfig, 'origin'>,
  surface: McpProtectedResourceMetadataSurface = 'strict',
): string {
  const path = surface === 'compat'
    ? PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_COMPAT_RESOURCE_PATH
    : PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH;
  return `${config.origin}${path}`;
}

function protectedResourceIdentifier(
  config: McpReadFeatureConfig,
  surface: McpProtectedResourceMetadataSurface,
): string {
  if (surface === 'compat') {
    if (config.compat === undefined) {
      throw new Error('MCP compat protected resource metadata requires the compat feature');
    }
    return `${config.origin}${MCP_COMPAT_ENDPOINT_PATH}`;
  }
  return config.oauth.audience;
}

/**
 * Builds the stable protected resource metadata from frozen config. Any config
 * drift that would make the published document disagree with the R03 verifier
 * fails closed at composition time. `authorization_servers` is the issuer
 * identifier (`config.oauth.issuer`), never the authorization-server metadata URL.
 */
export function createMcpReadProtectedResourceMetadata(
  config: McpReadFeatureConfig,
  options: CreateMcpReadProtectedResourceMetadataOptions = {},
): McpReadProtectedResourceMetadata {
  assertMcpReadFeatureConfig(config, options);
  const surface = options.surface ?? 'strict';
  const resource = protectedResourceIdentifier(config, surface);
  return deepFreeze({
    resource,
    authorization_servers: [config.oauth.issuer],
    scopes_supported: [...withMcpOauthAcceptedScopes(withOrdinaryProductOauthScopes(config.oauth.scopes))],
    jwks_uri: config.oauth.jwksUri,
  });
}
