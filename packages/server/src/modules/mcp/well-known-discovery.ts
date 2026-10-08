/**
 * MCP2-02 anonymous machine-readable discovery document.
 *
 * Published at `GET /.well-known/mcp`. Field values come from the frozen
 * `McpReadFeatureConfig` (origin / endpoint / protocolVersion). There are no
 * new config keys for the strict document. When host compatibility is on,
 * `endpoints.strict` / `endpoints.compatibility` are added without changing
 * the existing top-level fields.
 */
import {
  assertMcpReadFeatureConfig,
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
  type McpReadFeatureConfig,
  type McpReadFeatureConfigAssertOptions,
} from './config.js';
import { PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH } from './protected-resource-metadata.js';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_PROTOCOL_VERSIONS,
  MCP_COMPAT_RECOMMENDED_CLIENTS,
} from './mcp-compat-protocol.js';

/** Unique first-touch discovery path; not an `/api/v1` product route. */
export const PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH = '/.well-known/mcp' as const;

/** Anonymous clients may list and call the two public read tools (MCP2-05). */
export const PHASE4B_MCP_WELL_KNOWN_ANONYMOUS_TOOLS = true;

/**
 * Default consent scopes advertised on both well-known endpoint descriptors.
 * Does not include high-risk `access:write` or `changes:commit`.
 */
export const MCP_WELL_KNOWN_DISCOVERY_SUGGESTED_SCOPES = Object.freeze([
  'mcp:read:public',
  'mcp:read:own',
  'nodes:write',
  'offline_access',
] as const);

/** Frozen chooser copy: strict path is COLP Profile `2026-07-28` only. */
export const MCP_WELL_KNOWN_STRICT_CHOOSE_WHEN =
  `This path is the COLP MCP Profile endpoint for protocol ${PHASE4B_MCP_CONFIG_PROTOCOL_VERSION} only.`;

/**
 * Frozen chooser copy: compat path is host MCP `2025-11-25` only, not a COLP
 * Profile. Names no client brand so discovery JSON stays client-agnostic.
 */
export const MCP_WELL_KNOWN_COMPAT_CHOOSE_WHEN = [
  `This path is the host compatibility endpoint for MCP ${MCP_COMPAT_PROTOCOL_VERSIONS[0]} only.`,
  'It is not a COLP Profile.',
  `Clients that speak ${MCP_COMPAT_PROTOCOL_VERSIONS[0]} must use this path;`,
  `they must not post ${MCP_COMPAT_PROTOCOL_VERSIONS[0]} to ${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}.`,
].join(' ');

export interface McpWellKnownDiscoveryEndpointDescriptor {
  readonly path: string;
  readonly transport: 'streamable-http';
  readonly supportedProtocolVersions: readonly string[];
  readonly recommendedClients: readonly string[];
  readonly profileClaim: 'mcp-read' | null;
  readonly chooseWhen: string;
  readonly suggestedScopes: readonly string[];
}

export interface McpWellKnownDiscoveryEndpoints {
  readonly strict: McpWellKnownDiscoveryEndpointDescriptor;
  readonly compatibility: McpWellKnownDiscoveryEndpointDescriptor;
}

export interface McpWellKnownDiscoveryDocument {
  readonly endpoint: string;
  readonly transport: 'streamable-http';
  readonly protocolVersion: string;
  readonly documentation: string;
  readonly oauthProtectedResourceMetadata: string;
  readonly anonymous: {
    readonly resources: true;
    readonly tools: boolean;
  };
  readonly endpoints?: McpWellKnownDiscoveryEndpoints;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Builds the static discovery document from validated MCP read config.
 * URLs are never taken from the request Host or Origin.
 */
export function createMcpWellKnownDiscoveryDocument(
  config: McpReadFeatureConfig,
  options: McpReadFeatureConfigAssertOptions = {},
): McpWellKnownDiscoveryDocument {
  assertMcpReadFeatureConfig(config, options);
  const document: McpWellKnownDiscoveryDocument = {
    endpoint: config.endpoint,
    transport: 'streamable-http',
    protocolVersion: config.protocolVersion,
    documentation: `${config.origin}/mcp`,
    oauthProtectedResourceMetadata:
      `${config.origin}${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH}`,
    anonymous: {
      resources: true,
      tools: PHASE4B_MCP_WELL_KNOWN_ANONYMOUS_TOOLS,
    },
    ...(config.compat
      ? {
          endpoints: {
            strict: {
              path: PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
              transport: 'streamable-http' as const,
              supportedProtocolVersions: Object.freeze([PHASE4B_MCP_CONFIG_PROTOCOL_VERSION]),
              recommendedClients: MCP_COMPAT_RECOMMENDED_CLIENTS,
              profileClaim: 'mcp-read' as const,
              chooseWhen: MCP_WELL_KNOWN_STRICT_CHOOSE_WHEN,
              suggestedScopes: MCP_WELL_KNOWN_DISCOVERY_SUGGESTED_SCOPES,
            },
            compatibility: {
              path: MCP_COMPAT_ENDPOINT_PATH,
              transport: 'streamable-http' as const,
              supportedProtocolVersions: MCP_COMPAT_PROTOCOL_VERSIONS,
              recommendedClients: MCP_COMPAT_RECOMMENDED_CLIENTS,
              profileClaim: null,
              chooseWhen: MCP_WELL_KNOWN_COMPAT_CHOOSE_WHEN,
              suggestedScopes: MCP_WELL_KNOWN_DISCOVERY_SUGGESTED_SCOPES,
            },
          },
        }
      : {}),
  };
  return deepFreeze(document);
}
