/**
 * P4B-R07 stable MCP Resource identity service.
 *
 * This module is the single host-facing authority for MCP Logical Resource
 * identities. It delegates URI formatting/parsing and template projection to
 * the COLP-MCP-09 codec/templates through the COLP-MCP-12 `/mcp` package
 * surface, binds those factories to the frozen `McpReadFeatureConfig`
 * serverUuid, and fails closed on any codec/template drift from that
 * authority. Resource, Tool-link, listen, and audit references must use this
 * service; HTTPS URLs, Core identity URIs, and display names are never
 * treated as Logical URIs.
 */
import {
  createMcpResourceTemplates,
  createMcpResourceUriCodec,
  type Mcp20260728CacheMetadata,
  type McpReadResource,
  type McpResourceTemplates,
  type McpResourceUriCodec,
} from '@know-n/colp/mcp';
import {
  assertMcpReadFeatureConfig,
  type McpReadFeatureConfig,
  type McpReadFeatureConfigAssertOptions,
} from './config.js';

/** Conservative cache shell for the static public Resource template set. */
export const PHASE4B_MCP_RESOURCE_TEMPLATES_CACHE_METADATA: Mcp20260728CacheMetadata =
  Object.freeze({
    ttlMs: 0,
    cacheScope: 'public',
  } as const);

export type Phase4bMcpResourceIdentityOptions = McpReadFeatureConfigAssertOptions;

export interface Phase4bMcpResourceIdentity {
  /** Stable Manifest/Publication serverUuid bound into every URI. */
  readonly serverUuid: string;
  /** COLP URI codec bound to this host identity. */
  readonly codec: McpResourceUriCodec;
  /** COLP Modern Resource templates bound to this host identity. */
  readonly templates: McpResourceTemplates;
  readonly collectionMetadata: (collectionId: string) => string;
  readonly collectionSnapshot: (collectionId: string) => string;
  readonly collectionNode: (collectionId: string, nodeId: string) => string;
  readonly parse: (uri: string) => McpReadResource;
}

/**
 * Creates the stable host Resource identity service from the frozen feature
 * config. The codec and template set are COLP-owned; this module only binds,
 * snapshots, and drift-checks them.
 */
export function createPhase4bMcpResourceIdentity(
  config: McpReadFeatureConfig,
  options: Phase4bMcpResourceIdentityOptions = {},
): Phase4bMcpResourceIdentity {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('MCP resource identity options must be an object.');
  }
  assertMcpReadFeatureConfig(config, options);
  const expectedServerUuid = readOptionalOwnData(options, 'expectedServerUuid');
  if (
    expectedServerUuid !== undefined
    && (typeof expectedServerUuid !== 'string' || expectedServerUuid !== config.serverUuid)
  ) {
    throw new Error('MCP resource identity serverUuid mismatch.');
  }

  const codec = createMcpResourceUriCodec({ serverUuid: config.serverUuid });
  const templates = createMcpResourceTemplates({ serverUuid: config.serverUuid });
  if (codec.serverUuid !== config.serverUuid) {
    throw new Error('MCP resource identity serverUuid drift from COLP codec.');
  }

  const authorityPrefix = `colp://${config.serverUuid}/collections/`;
  for (const template of templates) {
    if (!template.uriTemplate.startsWith(authorityPrefix) || template.uriTemplate.includes('{serverUuid}')) {
      throw new Error('MCP resource template drift from stable serverUuid.');
    }
  }

  const probe = codec.collectionMetadata('collection-1');
  const parsedProbe = codec.parse(probe);
  if (
    parsedProbe.kind !== 'collection-metadata'
    || parsedProbe.collectionId !== 'collection-1'
  ) {
    throw new Error('MCP resource codec round trip is not stable.');
  }

  return Object.freeze({
    serverUuid: config.serverUuid,
    codec,
    templates,
    collectionMetadata: codec.collectionMetadata,
    collectionSnapshot: codec.collectionSnapshot,
    collectionNode: codec.collectionNode,
    parse: codec.parse,
  });
}

function readOptionalOwnData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new TypeError('MCP resource identity options must use own data properties.');
  }
  return descriptor.value;
}
