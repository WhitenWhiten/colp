import {
  createDeploymentConformancePlan,
  type ConformancePort,
  type DeploymentConformanceScope,
  type VerifiedProfileClaims,
} from '@know-n/colp/conformance';
import type { EndpointKey } from '@know-n/colp/semantic';
import { PHASE4B_MCP_CONFIG_PROTOCOL_VERSION } from './config.js';

/**
 * P4B-R14 host claim gate.
 *
 * The MCP 2026-07-28 Read surface stays unclaimed until the accepted
 * COLP-MCP-15 artifact, the current source-bound deployment binding, and the
 * official `runDeploymentConformanceProbes` evidence all pass the final COLP
 * `assertProfileClaims` gate. This controller never requests or publishes
 * `mcp-write`; a deployment evidence set that expands to that profile fails
 * closed.
 */
export const PHASE4B_MCP_READ_PROFILE_CLAIMS = Object.freeze(['core', 'mcp-read'] as const);
export const PHASE4B_MCP_READ_ENDPOINTS = Object.freeze(['mcp'] as const satisfies readonly EndpointKey[]);
export const PHASE4B_MCP_READ_PORTS = Object.freeze([
  'schema',
  'semantic',
  'mcp',
] as const satisfies readonly ConformancePort[]);

export const PHASE4B_MCP_READ_CONFORMANCE_SCOPE = Object.freeze({
  profiles: PHASE4B_MCP_READ_PROFILE_CLAIMS,
  capabilities: Object.freeze([]),
}) satisfies DeploymentConformanceScope;

export const PHASE4B_MCP_READ_CONFORMANCE_PLAN = createDeploymentConformancePlan(
  PHASE4B_MCP_READ_CONFORMANCE_SCOPE,
);
export const PHASE4B_MCP_READ_REQUIRED_PROBE_FAMILY_IDS = Object.freeze([
  'mcp-2026-07-28.transport-header-contracts',
  'mcp-2026-07-28.discovery-contracts',
  'mcp-2026-07-28.subscription-contracts',
  'mcp-2026-07-28.read-schema-contracts',
  'mcp-2026-07-28.oauth-client-contracts',
] as const);

Object.freeze([
  'mcp-2026-07-28.transport-header-contracts',
  'mcp-2026-07-28.discovery-contracts',
  'mcp-2026-07-28.subscription-contracts',
  'mcp-2026-07-28.read-schema-contracts',
  'mcp-2026-07-28.write-mrtr-contracts',
  'mcp-2026-07-28.oauth-client-contracts',
] as const);
Object.freeze([
  'mcp-read.transport-contracts',
  'mcp-write.approval-contracts',
] as const);
Object.freeze({
  '@modelcontextprotocol/core': '2.3.1',
  '@modelcontextprotocol/client': '2.3.1',
  '@modelcontextprotocol/server': '2.3.1',
} as const);

export interface Phase4bMcpReadProfileClaims {
  readonly profiles: VerifiedProfileClaims;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly evidenceDigest: string;
  readonly generatedAt: string;
  readonly protocolVersion: typeof PHASE4B_MCP_CONFIG_PROTOCOL_VERSION;
}

export interface Phase4bMcpReadProfileClaimController {
  current(): Phase4bMcpReadProfileClaims | undefined;
  activate(claims: Phase4bMcpReadProfileClaims): void;
}

new WeakSet<object>();
const issuedClaims = new WeakSet<object>();
const issuedControllers = new WeakSet<object>();

export function assertPhase4bMcpReadProfileClaimController(
  value: Phase4bMcpReadProfileClaimController,
): void {
  if (!issuedControllers.has(value)) {
    throw new TypeError('MCP Read Profile claim controller must be issued by this module');
  }
}

export function assertPhase4bMcpReadProfileClaims(
  value: Phase4bMcpReadProfileClaims,
): asserts value is Phase4bMcpReadProfileClaims {
  if (!issuedClaims.has(value)) {
    throw new TypeError('MCP Read Profile claims must be issued by claimPhase4bMcpReadProfiles');
  }
}
