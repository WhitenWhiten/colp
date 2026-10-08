/**
 * P4B-R02/R14/W10 MCP Manifest candidate.
 *
 * Builds a validated, serializable COLP `Manifest` fragment for the Modern
 * `2026-07-28` MCP read surface from the frozen feature config (endpoint,
 * serverUuid, OAuth metadata, `features.mcp.protocolVersion`). It is a
 * *candidate* only (plan §6 P4B-R02):
 *
 * - it never writes the live Manifest and never registers a route;
 * - it never claims `mcp-write` on its own; `mcp-read` and `mcp-write` are
 *   activated only by the host claim controllers and remain absent unless the
 *   corresponding issued claims are passed into the candidate;
 * - schema + semantic validity is enforced against the canonical COLP
 *   validators so a drifting endpoint/serverUuid/protocolVersion fails closed.
 *
 * Deliberately pure: no Fastify, no I/O, no claim controller import.
 */
import { createValidatorRegistry, validateWireDocument } from '@know-n/colp/schema';
import { validateManifestSemantics } from '@know-n/colp/semantic';
import type { Manifest, ServiceUrl } from '@know-n/colp/types';
import {
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
  assertMcpReadFeatureConfig,
  type McpReadFeatureConfig,
  type McpReadFeatureConfigAssertOptions,
} from './config.js';
import {
  PHASE4B_MCP_READ_PROFILE_CLAIMS,
  assertPhase4bMcpReadProfileClaims,
  type Phase4bMcpReadProfileClaims,
} from './read-profile-claim-gate.js';
import {
  PHASE4B_MCP_WRITE_PROFILE_CLAIMS,
  assertPhase4bMcpWriteProfileClaims,
  type Phase4bMcpWriteProfileClaims,
} from './write-profile-claim-gate.js';
import { PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH } from './protected-resource-metadata.js';

const validators = createValidatorRegistry();

/** The candidate never declares MCP Profile claims (plan §3.5.1, §6 P4B-R02 不包含 claim). */
export const PHASE4B_MCP_READ_MANIFEST_PROFILES = Object.freeze(['core']) as readonly ['core'];

/**
 * Assert options plus runtime advertisement from feature flags.
 * Official COLP claim objects still win when the host supplies them.
 * `advertiseRead` / `advertiseWrite` make the live list match the mounted
 * surface without waiting for the acceptance-script claim controllers.
 */
export interface McpReadManifestCandidateOptions extends McpReadFeatureConfigAssertOptions {
  readonly advertiseRead?: boolean;
  readonly advertiseWrite?: boolean;
}

export interface McpReadManifestCandidate {
  /** Canonically validated COLP Manifest (deeply frozen). */
  readonly manifest: Manifest;
  /** Exact MCP endpoint URL (frozen origin + /collections/-/mcp). */
  readonly endpoint: string;
  /** Frozen protocol version stamped into features.mcp. */
  readonly protocolVersion: typeof PHASE4B_MCP_CONFIG_PROTOCOL_VERSION;
  /** Candidate profiles: baseline core, plus mcp-read only when claims are active. */
  readonly profiles: readonly string[];
  /** True only when the host claim controller supplied active mcp-read claims. */
  readonly claimed: boolean;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Builds the read-only MCP Manifest candidate from the frozen feature config.
 * Throws (fail closed) on any config drift or COLP schema/semantic violation.
 */
export function createMcpReadManifestCandidate(
  config: McpReadFeatureConfig,
  mcpReadProfileClaims?: Phase4bMcpReadProfileClaims,
  mcpWriteProfileClaims?: Phase4bMcpWriteProfileClaims,
  options: McpReadManifestCandidateOptions = {},
): McpReadManifestCandidate {
  assertMcpReadFeatureConfig(config, options);
  if (mcpReadProfileClaims !== undefined) {
    assertPhase4bMcpReadProfileClaims(mcpReadProfileClaims);
  }
  if (mcpWriteProfileClaims !== undefined) {
    assertPhase4bMcpWriteProfileClaims(mcpWriteProfileClaims);
  }
  const advertiseWrite = options.advertiseWrite === true;
  const advertiseRead = options.advertiseRead === true || advertiseWrite;
  const writeClaimed = mcpWriteProfileClaims !== undefined || advertiseWrite;
  const profiles = mcpWriteProfileClaims?.profiles
    ?? (writeClaimed ? PHASE4B_MCP_WRITE_PROFILE_CLAIMS : undefined)
    ?? mcpReadProfileClaims?.profiles
    ?? (advertiseRead ? PHASE4B_MCP_READ_PROFILE_CLAIMS : undefined)
    ?? PHASE4B_MCP_READ_MANIFEST_PROFILES;
  const title = writeClaimed ? 'Known MCP' : 'Known MCP Read';
  const endpoints = (writeClaimed
    ? {
        directory: `${config.origin}/colp/v0.1/directory`,
        collection: `${config.origin}/colp/v0.1/collections/{collectionId}`,
        snapshot: `${config.origin}/colp/v0.1/collections/{collectionId}/snapshot`,
        nodes: `${config.origin}/colp/v0.1/collections/{collectionId}/nodes`,
        node: `${config.origin}/colp/v0.1/collections/{collectionId}/nodes/{nodeId}`,
        nodeMove: `${config.origin}/colp/v0.1/collections/{collectionId}/nodes/{nodeId}/move`,
        annotations: `${config.origin}/colp/v0.1/collections/{collectionId}/annotations`,
        annotation: `${config.origin}/colp/v0.1/collections/{collectionId}/annotations/{annotationId}`,
        attachments: `${config.origin}/colp/v0.1/collections/{collectionId}/attachments`,
        attachment: `${config.origin}/colp/v0.1/collections/{collectionId}/attachments/{attachmentId}`,
        relations: `${config.origin}/colp/v0.1/collections/{collectionId}/relations`,
        relation: `${config.origin}/colp/v0.1/collections/{collectionId}/relations/{relationId}`,
        release: `${config.origin}/colp/v0.1/collections/{collectionId}/release`,
        releases: `${config.origin}/colp/v0.1/collections/{collectionId}/releases`,
        releaseItem: `${config.origin}/colp/v0.1/collections/{collectionId}/releases/{releaseId}`,
        releaseSnapshot: `${config.origin}/colp/v0.1/collections/{collectionId}/releases/{releaseId}/snapshot`,
        mcp: config.endpoint,
      }
    : {
        mcp: config.endpoint,
      }) as unknown as Manifest['mounts'][number]['endpoints'];
  const manifest: Manifest = {
    protocol: 'https://know-n.com/colp/spec/0.1',
    protocolVersions: ['0.1'],
    serverId: `${config.origin}/` as Manifest['serverId'],
    serverUuid: config.serverUuid,
    title,
    mounts: [{
      id: 'mcp',
      baseUrl: `${config.origin}/` as Manifest['mounts'][number]['baseUrl'],
      profiles: profiles as unknown as Manifest['mounts'][number]['profiles'],
      endpoints,
      features: {
        mcp: {
          // `tools` reflects the real runtime exposure: the read surface
          // always serves the read-only `collections.get` /
          // `collections.get_snapshot` tools to authenticated principals
          // (05-mcp-profile.md §"mcp-read 可以…暴露的 Tool 必须全部为只读
          // Tool"), so the flag must not be overloaded as a write-claim
          // marker (2026-08-27 MCP usability audit, MCP-U-11).
          protocolVersion: config.protocolVersion,
          resources: true,
          tools: true,
        },
        ...(writeClaimed ? {
          patch: {
            mediaTypes: ['application/merge-patch+json'],
          } as NonNullable<Manifest['mounts'][number]['features']['patch']>,
        } : {}),
      },
      auth: {
        anonymousRead: true,
        apiKeys: false,
        oauth: true,
        protectedResourceMetadata:
          `${config.origin}${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH}` as ServiceUrl,
      },
      limits: {
        maxPageSize: 200,
        maxSnapshotNodes: 100_000,
        minPollIntervalSeconds: 60,
        recommendedPollIntervalSeconds: 300,
        ...(writeClaimed ? { idempotencyRetentionSeconds: 86_400 } : {}),
      },
    }],
  };
  const validation = validateWireDocument<Manifest, unknown>(
    validators,
    'manifest',
    manifest,
    validateManifestSemantics,
  );
  if (!validation.valid) {
    throw new Error(`MCP read Manifest candidate failed COLP ${validation.stage} validation`);
  }
  return deepFreeze({
    manifest: validation.value,
    endpoint: config.endpoint,
    protocolVersion: config.protocolVersion,
    profiles,
    claimed: mcpReadProfileClaims !== undefined
      || mcpWriteProfileClaims !== undefined
      || advertiseRead
      || advertiseWrite,
  });
}

/**
 * True when the given candidate is a pure read-only fragment: no mcp-read /
 * mcp-write profile, no activated claim, endpoint frozen to the unique path.
 * Used to prove the Manifest stays closed until the host claim controller
 * activates a Profile (plan §3.5.1, §6 P4B-R02 完成标准).
 */
export function isMcpReadManifestCandidateClosed(candidate: McpReadManifestCandidate): boolean {
  return candidate.claimed === false
    && candidate.profiles.length === 1
    && candidate.profiles[0] === 'core'
    && !candidate.profiles.includes('mcp-read')
    && !candidate.profiles.includes('mcp-write')
    && candidate.endpoint.endsWith(PHASE4B_MCP_CONFIG_ENDPOINT_PATH)
    && candidate.manifest.mounts[0].features.mcp?.protocolVersion === PHASE4B_MCP_CONFIG_PROTOCOL_VERSION;
}
