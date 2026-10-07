import { createHash } from 'node:crypto';
import {
  assertProfileClaims,
  createDeploymentConformancePlan,
  type ConformancePort,
  type DeploymentConformanceScope,
  type VerifiedDeploymentConformanceEvidence,
  type VerifiedProfileClaims,
} from '@know-n/colp/conformance';
import type { EndpointKey } from '@know-n/colp/semantic';
import { PHASE4B_MCP_CONFIG_PROTOCOL_VERSION } from './config.js';
import {
  assertPhase4bMcpConformanceCandidate,
  verifyPhase4bMcpSdkAcceptedEvidence,
  type Phase4bMcpConformanceCandidate,
} from './read-profile-claim-gate.js';

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

export function createPhase4bMcpWriteProfileClaimController(): Phase4bMcpWriteProfileClaimController {
  let active: Phase4bMcpWriteProfileClaims | undefined;
  const controller = Object.freeze({
    current() {
      return active;
    },
    activate(claims: Phase4bMcpWriteProfileClaims) {
      assertPhase4bMcpWriteProfileClaims(claims);
      if (active !== undefined && active !== claims) {
        throw new TypeError('MCP Write Profile claims are already active for this process');
      }
      active = claims;
    },
  });
  issuedControllers.add(controller);
  return controller;
}

export function assertPhase4bMcpWriteProfileClaimController(
  value: Phase4bMcpWriteProfileClaimController,
): void {
  if (!issuedControllers.has(value)) {
    throw new TypeError('MCP Write Profile claim controller must be issued by this module');
  }
}

export function claimPhase4bMcpWriteProfiles(input: {
  readonly acceptedEvidence: unknown;
  readonly conformanceCandidate: unknown;
  readonly deploymentEvidence: VerifiedDeploymentConformanceEvidence;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly generatedAt: string;
}): Phase4bMcpWriteProfileClaims {
  const verified = verifyPhase4bMcpSdkAcceptedEvidence(
    input.acceptedEvidence,
  );
  assertPhase4bMcpConformanceCandidate(input.conformanceCandidate);
  const candidate = input.conformanceCandidate as Phase4bMcpConformanceCandidate;
  if (verified.artifact.conformanceCandidateDigest !== candidate.evidenceDigest) {
    throw new TypeError('MCP accepted evidence does not bind the current COLP conformance candidate');
  }
  if (!/^[0-9a-f]{40,64}$/u.test(input.sourceRevision)) {
    throw new TypeError('MCP Write sourceRevision must be a full hexadecimal commit ID');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.sourceDigest)) {
    throw new TypeError('MCP Write sourceDigest must be a lowercase SHA-256 digest');
  }
  canonicalInstant(input.generatedAt, 'MCP Write claim generatedAt');

  if (!Object.isFrozen(input.deploymentEvidence)) {
    throw new TypeError('MCP Write deployment evidence must be issued by runDeploymentConformanceProbes');
  }
  const plan = PHASE4B_MCP_WRITE_CONFORMANCE_PLAN;
  if (input.deploymentEvidence.profiles.join('\0') !== plan.profiles.join('\0')
    || input.deploymentEvidence.capabilities.join('\0') !== plan.capabilities.join('\0')
    || input.deploymentEvidence.passedProbeIds.join('\0') !== plan.probeIds.join('\0')) {
    throw new TypeError('MCP Write deployment conformance evidence is incomplete or has the wrong scope');
  }
  const binding = input.deploymentEvidence.mcpBinding;
  if (binding === undefined
    || binding.schemaVersion !== 1
    || binding.mcpVersion !== candidate.mcpVersion
    || binding.packageVersion !== candidate.packageVersion
    || !deepEqual(binding.sdkLock, candidate.sdkLock)
    || binding.fixtureTopologyDigest !== candidate.fixtureTopologyDigest
    || binding.requirementsDigest !== candidate.requirementsDigest
    || binding.probeFamilyIds.join('\0') !== PHASE4B_MCP_WRITE_REQUIRED_PROBE_FAMILY_IDS.join('\0')
    || binding.evidenceDigest !== phase4bMcpBindingDigest(binding)) {
    throw new TypeError('MCP Write deployment evidence does not bind the accepted COLP conformance candidate');
  }

  const profiles = assertProfileClaims(PHASE4B_MCP_WRITE_PROFILE_CLAIMS, {
    registeredEndpoints: new Set<EndpointKey>(PHASE4B_MCP_WRITE_ENDPOINTS),
    availablePorts: new Set<ConformancePort>(PHASE4B_MCP_WRITE_PORTS),
    deploymentEvidence: input.deploymentEvidence,
  });
  if (profiles.join('\0') !== PHASE4B_MCP_WRITE_PROFILE_CLAIMS.join('\0')) {
    throw new TypeError('COLP returned an unexpected MCP Write Profile claim set');
  }
  const claims = deepFreeze({
    profiles,
    sourceRevision: input.sourceRevision,
    sourceDigest: input.sourceDigest,
    evidenceDigest: verified.artifact.evidenceDigest,
    generatedAt: input.generatedAt,
    protocolVersion: PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
  });
  issuedClaims.add(claims);
  return claims;
}

export function assertPhase4bMcpWriteProfileClaims(
  value: Phase4bMcpWriteProfileClaims,
): asserts value is Phase4bMcpWriteProfileClaims {
  if (!issuedClaims.has(value)) {
    throw new TypeError('MCP Write Profile claims must be issued by claimPhase4bMcpWriteProfiles');
  }
}

export function inspectPhase4bMcpWriteProfileClaims(
  value: Phase4bMcpWriteProfileClaims,
): Readonly<{
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly evidenceDigest: string;
}> {
  assertPhase4bMcpWriteProfileClaims(value);
  return Object.freeze({
    sourceRevision: value.sourceRevision,
    sourceDigest: value.sourceDigest,
    evidenceDigest: value.evidenceDigest,
  });
}

function phase4bMcpBindingDigest(value: {
  readonly mcpVersion: string;
  readonly packageVersion: string;
  readonly sdkLock: Readonly<Record<string, string>>;
  readonly fixtureTopologyDigest: string;
  readonly requirementsDigest: string;
  readonly probeFamilyIds: readonly string[];
}): string {
  const selected = Object.freeze({
    mcpVersion: value.mcpVersion,
    packageVersion: value.packageVersion,
    sdkLock: value.sdkLock,
    fixtureTopologyDigest: value.fixtureTopologyDigest,
    requirementsDigest: value.requirementsDigest,
    probeFamilyIds: value.probeFamilyIds,
  });
  return `sha256:${createHash('sha256').update(canonicalJson(selected), 'utf8').digest('hex')}`;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') {
    const primitive = JSON.stringify(value);
    return primitive === undefined ? 'undefined' : primitive;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC instant`);
  }
  return value;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
