import {
  createDeploymentConformancePlan,
  type ConformancePort,
  type DeploymentConformanceScope,
  type VerifiedProfileClaims,
} from '@know-n/colp/conformance';
import type { EndpointKey } from '@know-n/colp/semantic';
import { PHASE4B_MCP_CONFIG_PROTOCOL_VERSION } from './config.js';

/**
 * MCP-W10 host claim gate.
 *
 * The complete `core -> publication -> publisher -> mcp-read -> mcp-write`
 * closure stays unclaimed until the accepted COLP-MCP-15 artifact, current
 * source-bound deployment binding, official write deployment probes, and the
 * full endpoint/port surface all pass COLP `assertProfileClaims`. Package
 * profile arrays are never accepted as evidence; a copied or read-only
 * deployment evidence object fails closed.
 */
export const PHASE4B_MCP_WRITE_PROFILE_CLAIMS = Object.freeze([
  'core',
  'publication',
  'publisher',
  'mcp-read',
  'mcp-write',
] as const);

export const PHASE4B_MCP_WRITE_ENDPOINTS = Object.freeze([
  'directory',
  'collection',
  'snapshot',
  'nodes',
  'node',
  'nodeMove',
  'annotations',
  'annotation',
  'attachments',
  'attachment',
  'relations',
  'relation',
  'release',
  'releases',
  'releaseItem',
  'releaseSnapshot',
  'mcp',
] as const satisfies readonly EndpointKey[]);

export const PHASE4B_MCP_WRITE_PORTS = Object.freeze([
  'schema',
  'semantic',
  'client',
  'server',
  'publisher',
  'transactions',
  'idempotency',
  'outbox',
  'mcp',
  'approval',
  'audit',
] as const satisfies readonly ConformancePort[]);

export const PHASE4B_MCP_WRITE_CONFORMANCE_SCOPE = Object.freeze({
  profiles: PHASE4B_MCP_WRITE_PROFILE_CLAIMS,
  capabilities: Object.freeze([]),
}) satisfies DeploymentConformanceScope;

export const PHASE4B_MCP_WRITE_CONFORMANCE_PLAN = createDeploymentConformancePlan(
  PHASE4B_MCP_WRITE_CONFORMANCE_SCOPE,
);

/** Read families plus the accepted Write MRTR family, in canonical probe order. */
export const PHASE4B_MCP_WRITE_REQUIRED_PROBE_FAMILY_IDS = Object.freeze([
  'mcp-2026-07-28.transport-header-contracts',
  'mcp-2026-07-28.discovery-contracts',
  'mcp-2026-07-28.subscription-contracts',
  'mcp-2026-07-28.read-schema-contracts',
  'mcp-2026-07-28.write-mrtr-contracts',
  'mcp-2026-07-28.oauth-client-contracts',
] as const);

export interface Phase4bMcpWriteProfileClaims {
  readonly profiles: VerifiedProfileClaims;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly evidenceDigest: string;
  readonly generatedAt: string;
  readonly protocolVersion: typeof PHASE4B_MCP_CONFIG_PROTOCOL_VERSION;
}

export interface Phase4bMcpWriteProfileClaimController {
  current(): Phase4bMcpWriteProfileClaims | undefined;
  activate(claims: Phase4bMcpWriteProfileClaims): void;
}

const issuedClaims = new WeakSet<object>();
const issuedControllers = new WeakSet<object>();

export function assertPhase4bMcpWriteProfileClaimController(
  value: Phase4bMcpWriteProfileClaimController,
): void {
  if (!issuedControllers.has(value)) {
    throw new TypeError('MCP Write Profile claim controller must be issued by this module');
  }
}

export function assertPhase4bMcpWriteProfileClaims(
  value: Phase4bMcpWriteProfileClaims,
): asserts value is Phase4bMcpWriteProfileClaims {
  if (!issuedClaims.has(value)) {
    throw new TypeError('MCP Write Profile claims must be issued by claimPhase4bMcpWriteProfiles');
  }
}
