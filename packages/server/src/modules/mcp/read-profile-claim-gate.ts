import { createPhase4bMcpPackageEvidence } from './colp-package-evidence.js';
import { createHash } from 'node:crypto';
import {
  assertProfileClaims,
  bundledConformanceEvidence,
  createDeploymentConformancePlan,
  type ConformancePort,
  type DeploymentConformanceScope,
  type VerifiedDeploymentConformanceEvidence,
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

export const PHASE4B_MCP_SDK_ACCEPTED_ARTIFACT_NAME = 'mcp-2026-07-28-sdk-accepted' as const;
export const PHASE4B_MCP_SDK_ACCEPTED_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const PHASE4B_MCP_READ_REQUIRED_PROBE_FAMILY_IDS = Object.freeze([
  'mcp-2026-07-28.transport-header-contracts',
  'mcp-2026-07-28.discovery-contracts',
  'mcp-2026-07-28.subscription-contracts',
  'mcp-2026-07-28.read-schema-contracts',
  'mcp-2026-07-28.oauth-client-contracts',
] as const);

const MCP_20260728_PROBE_FAMILY_IDS = Object.freeze([
  'mcp-2026-07-28.transport-header-contracts',
  'mcp-2026-07-28.discovery-contracts',
  'mcp-2026-07-28.subscription-contracts',
  'mcp-2026-07-28.read-schema-contracts',
  'mcp-2026-07-28.write-mrtr-contracts',
  'mcp-2026-07-28.oauth-client-contracts',
] as const);
const LEGACY_MCP_PROBE_IDS = Object.freeze([
  'mcp-read.transport-contracts',
  'mcp-write.approval-contracts',
] as const);
const MCP_20260728_SDK_LOCK = Object.freeze({
  '@modelcontextprotocol/core': '2.3.1',
  '@modelcontextprotocol/client': '2.3.1',
  '@modelcontextprotocol/server': '2.3.1',
} as const);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface Phase4bMcp20260728SdkAcceptedEvidence {
  readonly candidate: typeof PHASE4B_MCP_SDK_ACCEPTED_ARTIFACT_NAME;
  readonly schemaVersion: typeof PHASE4B_MCP_SDK_ACCEPTED_EVIDENCE_SCHEMA_VERSION;
  readonly mcpVersion: typeof PHASE4B_MCP_CONFIG_PROTOCOL_VERSION;
  readonly packageVersion: string;
  readonly sdkLock: Readonly<Record<keyof typeof MCP_20260728_SDK_LOCK, string>>;
  readonly fixtureTopologyDigest: string;
  readonly requirementsDigest: string;
  readonly probeFamilyIds: readonly string[];
  readonly conformanceCandidateDigest: string;
  readonly evidenceDigest: string;
}

export interface Phase4bMcpConformanceCandidate {
  readonly candidate: 'mcp-conformance-candidate';
  readonly schemaVersion: 1;
  readonly mcpVersion: typeof PHASE4B_MCP_CONFIG_PROTOCOL_VERSION;
  readonly packageVersion: string;
  readonly sdkLock: Readonly<Record<keyof typeof MCP_20260728_SDK_LOCK, string>>;
  readonly fixtureTopologyDigest: string;
  readonly requirementsDigest: string;
  readonly probeFamilyIds: readonly string[];
  readonly evidenceDigest: string;
}

export interface VerifiedPhase4bMcpSdkAcceptedEvidence {
  readonly artifact: Readonly<Phase4bMcp20260728SdkAcceptedEvidence>;
  readonly verifiedAt: string;
}

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

const issuedAcceptedEvidence = new WeakSet<object>();
const issuedClaims = new WeakSet<object>();
const issuedControllers = new WeakSet<object>();

export function validatePhase4bMcpSdkAcceptedEvidenceErrors(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['MCP 2026-07-28 SDK accepted artifact must be an object.'];
  }
  const artifact = value as Record<string, unknown>;
  const errors: string[] = [];
  exactKeys(artifact, [
    'candidate', 'schemaVersion', 'mcpVersion', 'packageVersion', 'sdkLock',
    'fixtureTopologyDigest', 'requirementsDigest', 'probeFamilyIds',
    'conformanceCandidateDigest', 'evidenceDigest',
  ], 'MCP accepted artifact', errors);
  if (artifact.candidate !== PHASE4B_MCP_SDK_ACCEPTED_ARTIFACT_NAME) {
    errors.push(`MCP accepted artifact must be named ${PHASE4B_MCP_SDK_ACCEPTED_ARTIFACT_NAME}.`);
  }
  if (artifact.schemaVersion !== PHASE4B_MCP_SDK_ACCEPTED_EVIDENCE_SCHEMA_VERSION) {
    errors.push('MCP accepted artifact schemaVersion must be 1.');
  }
  if (artifact.mcpVersion !== PHASE4B_MCP_CONFIG_PROTOCOL_VERSION) {
    errors.push(`MCP accepted artifact must bind the exact version ${PHASE4B_MCP_CONFIG_PROTOCOL_VERSION}.`);
  }
  if (typeof artifact.packageVersion !== 'string'
    || artifact.packageVersion !== bundledConformanceEvidence.packageVersion) {
    errors.push('MCP accepted artifact packageVersion must match the installed COLP release.');
  }
  const installed = createPhase4bMcpPackageEvidence().candidate;
  if (artifact.requirementsDigest !== installed.requirementsDigest
    || artifact.fixtureTopologyDigest !== installed.fixtureTopologyDigest) {
    errors.push('MCP accepted artifact does not bind the installed COLP package evidence.');
  }
  if (!deepEqual(artifact.sdkLock, MCP_20260728_SDK_LOCK)) {
    errors.push('MCP accepted artifact SDK lock does not match the locked 2.3.1 SDK set.');
  }
  for (const name of [
    'fixtureTopologyDigest', 'requirementsDigest',
    'conformanceCandidateDigest', 'evidenceDigest',
  ] as const) {
    if (typeof artifact[name] !== 'string' || !SHA256_PATTERN.test(artifact[name]!)) {
      errors.push(`MCP accepted artifact ${name} must be a SHA-256 digest.`);
    }
  }
  errors.push(...validateProbeFamilyIds(artifact.probeFamilyIds));
  if (typeof artifact.evidenceDigest === 'string'
    && artifact.evidenceDigest !== acceptedEvidenceDigest(value)) {
    errors.push('MCP accepted artifact evidenceDigest does not match the accepted binding fields.');
  }
  return errors;
}

export function verifyPhase4bMcpSdkAcceptedEvidence(
  value: unknown,
): VerifiedPhase4bMcpSdkAcceptedEvidence {
  const errors = validatePhase4bMcpSdkAcceptedEvidenceErrors(value);
  if (errors.length > 0) {
    throw new TypeError(`Invalid MCP 2026-07-28 SDK accepted artifact:\n- ${errors.join('\n- ')}`);
  }
  const artifact = deepFreeze(
    structuredClone(value),
  ) as Phase4bMcp20260728SdkAcceptedEvidence;
  const verified = deepFreeze({
    artifact,
    verifiedAt: new Date().toISOString(),
  });
  issuedAcceptedEvidence.add(verified);
  return verified;
}

export function validatePhase4bMcpConformanceCandidateErrors(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['MCP conformance candidate must be an object.'];
  }
  const candidate = value as Record<string, unknown>;
  const errors: string[] = [];
  exactKeys(candidate, [
    'candidate', 'schemaVersion', 'mcpVersion', 'packageVersion', 'sdkLock',
    'fixtureTopologyDigest', 'requirementsDigest',
    'probeFamilyIds', 'evidenceDigest',
  ], 'MCP conformance candidate', errors);
  if (candidate.candidate !== 'mcp-conformance-candidate') {
    errors.push('MCP conformance candidate must be named mcp-conformance-candidate.');
  }
  if (candidate.schemaVersion !== 1) {
    errors.push('MCP conformance candidate schemaVersion must be 1.');
  }
  if (candidate.mcpVersion !== PHASE4B_MCP_CONFIG_PROTOCOL_VERSION) {
    errors.push(`MCP conformance candidate must bind the exact version ${PHASE4B_MCP_CONFIG_PROTOCOL_VERSION}.`);
  }
  if (typeof candidate.packageVersion !== 'string'
    || candidate.packageVersion !== bundledConformanceEvidence.packageVersion) {
    errors.push('MCP conformance candidate packageVersion must match the installed COLP release.');
  }
  const installed = createPhase4bMcpPackageEvidence().candidate;
  if (candidate.requirementsDigest !== installed.requirementsDigest
    || candidate.fixtureTopologyDigest !== installed.fixtureTopologyDigest) {
    errors.push('MCP conformance candidate does not bind the installed COLP package evidence.');
  }
  if (!deepEqual(candidate.sdkLock, MCP_20260728_SDK_LOCK)) {
    errors.push('MCP conformance candidate SDK lock does not match the locked 2.3.1 SDK set.');
  }
  for (const name of [
    'fixtureTopologyDigest', 'requirementsDigest', 'evidenceDigest',
  ] as const) {
    if (typeof candidate[name] !== 'string' || !SHA256_PATTERN.test(candidate[name]!)) {
      errors.push(`MCP conformance candidate ${name} must be a SHA-256 digest.`);
    }
  }
  if (!deepEqual(candidate.probeFamilyIds, MCP_20260728_PROBE_FAMILY_IDS)) {
    errors.push('MCP conformance candidate probe families do not match the accepted 2026-07-28 family set.');
  }
  if (typeof candidate.evidenceDigest === 'string'
    && candidate.evidenceDigest !== phase4bMcpConformanceCandidateDigest(candidate)) {
    errors.push('MCP conformance candidate evidenceDigest does not match the candidate binding fields.');
  }
  return errors;
}

export function assertPhase4bMcpConformanceCandidate(
  value: unknown,
): asserts value is Phase4bMcpConformanceCandidate {
  const errors = validatePhase4bMcpConformanceCandidateErrors(value);
  if (errors.length > 0) {
    throw new TypeError(`Invalid MCP conformance candidate:\n- ${errors.join('\n- ')}`);
  }
}

export function createPhase4bMcpReadProfileClaimController(): Phase4bMcpReadProfileClaimController {
  let active: Phase4bMcpReadProfileClaims | undefined;
  const controller = Object.freeze({
    current() {
      return active;
    },
    activate(claims: Phase4bMcpReadProfileClaims) {
      assertPhase4bMcpReadProfileClaims(claims);
      if (active !== undefined && active !== claims) {
        throw new TypeError('MCP Read Profile claims are already active for this process');
      }
      active = claims;
    },
  });
  issuedControllers.add(controller);
  return controller;
}

export function assertPhase4bMcpReadProfileClaimController(
  value: Phase4bMcpReadProfileClaimController,
): void {
  if (!issuedControllers.has(value)) {
    throw new TypeError('MCP Read Profile claim controller must be issued by this module');
  }
}

export function claimPhase4bMcpReadProfiles(input: {
  readonly acceptedEvidence: VerifiedPhase4bMcpSdkAcceptedEvidence;
  readonly conformanceCandidate: unknown;
  readonly deploymentEvidence: VerifiedDeploymentConformanceEvidence;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly generatedAt: string;
}): Phase4bMcpReadProfileClaims {
  if (!issuedAcceptedEvidence.has(input.acceptedEvidence)) {
    throw new TypeError('MCP accepted evidence must be returned by verifyPhase4bMcpSdkAcceptedEvidence');
  }
  assertPhase4bMcpConformanceCandidate(input.conformanceCandidate);
  const candidate = input.conformanceCandidate;
  if (input.acceptedEvidence.artifact.conformanceCandidateDigest !== candidate.evidenceDigest) {
    throw new TypeError('MCP accepted evidence does not bind the current COLP conformance candidate');
  }
  if (!/^[0-9a-f]{40,64}$/u.test(input.sourceRevision)) {
    throw new TypeError('MCP Read sourceRevision must be a full hexadecimal commit ID');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.sourceDigest)) {
    throw new TypeError('MCP Read sourceDigest must be a lowercase SHA-256 digest');
  }
  canonicalInstant(input.generatedAt, 'MCP Read claim generatedAt');

  if (input.deploymentEvidence.profiles.includes('mcp-write')) {
    throw new TypeError('MCP Read claim gate refuses deployment evidence that includes mcp-write');
  }
  const plan = PHASE4B_MCP_READ_CONFORMANCE_PLAN;
  if (input.deploymentEvidence.profiles.join('\0') !== plan.profiles.join('\0')
    || input.deploymentEvidence.capabilities.join('\0') !== plan.capabilities.join('\0')
    || input.deploymentEvidence.passedProbeIds.join('\0') !== plan.probeIds.join('\0')) {
    throw new TypeError('MCP Read deployment conformance evidence is incomplete or has the wrong scope');
  }
  const binding = input.deploymentEvidence.mcpBinding;
  if (binding === undefined
    || binding.schemaVersion !== 1
    || binding.mcpVersion !== candidate.mcpVersion
    || binding.packageVersion !== candidate.packageVersion
    || !deepEqual(binding.sdkLock, candidate.sdkLock)
    || binding.fixtureTopologyDigest !== candidate.fixtureTopologyDigest
    || binding.requirementsDigest !== candidate.requirementsDigest
    || binding.probeFamilyIds.join('\0') !== PHASE4B_MCP_READ_REQUIRED_PROBE_FAMILY_IDS.join('\0')
    || binding.evidenceDigest !== phase4bMcpBindingDigest(binding)) {
    throw new TypeError('MCP Read deployment evidence does not bind the accepted COLP conformance candidate');
  }

  const profiles = assertProfileClaims(PHASE4B_MCP_READ_PROFILE_CLAIMS, {
    registeredEndpoints: new Set<EndpointKey>(PHASE4B_MCP_READ_ENDPOINTS),
    availablePorts: new Set<ConformancePort>(PHASE4B_MCP_READ_PORTS),
    deploymentEvidence: input.deploymentEvidence,
  });
  if (profiles.join('\0') !== PHASE4B_MCP_READ_PROFILE_CLAIMS.join('\0')
    || profiles.includes('mcp-write')) {
    throw new TypeError('COLP returned an unexpected MCP Read Profile claim set');
  }
  const claims = deepFreeze({
    profiles,
    sourceRevision: input.sourceRevision,
    sourceDigest: input.sourceDigest,
    evidenceDigest: input.acceptedEvidence.artifact.evidenceDigest,
    generatedAt: input.generatedAt,
    protocolVersion: PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
  });
  issuedClaims.add(claims);
  return claims;
}

export function assertPhase4bMcpReadProfileClaims(
  value: Phase4bMcpReadProfileClaims,
): asserts value is Phase4bMcpReadProfileClaims {
  if (!issuedClaims.has(value)) {
    throw new TypeError('MCP Read Profile claims must be issued by claimPhase4bMcpReadProfiles');
  }
}

export function inspectPhase4bMcpReadProfileClaims(
  value: Phase4bMcpReadProfileClaims,
): Readonly<{
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly evidenceDigest: string;
}> {
  assertPhase4bMcpReadProfileClaims(value);
  return Object.freeze({
    sourceRevision: value.sourceRevision,
    sourceDigest: value.sourceDigest,
    evidenceDigest: value.evidenceDigest,
  });
}

function acceptedEvidenceDigest(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  const artifact = value as Record<string, unknown>;
  const selected = Object.freeze({
    candidate: artifact.candidate,
    schemaVersion: artifact.schemaVersion,
    mcpVersion: artifact.mcpVersion,
    packageVersion: artifact.packageVersion,
    sdkLock: artifact.sdkLock,
    fixtureTopologyDigest: artifact.fixtureTopologyDigest,
    requirementsDigest: artifact.requirementsDigest,
    probeFamilyIds: artifact.probeFamilyIds,
    conformanceCandidateDigest: artifact.conformanceCandidateDigest,
  });
  return `sha256:${createHash('sha256').update(canonicalJson(selected), 'utf8').digest('hex')}`;
}

function phase4bMcpConformanceCandidateDigest(value: Record<string, unknown>): string {
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

function validateProbeFamilyIds(value: unknown): string[] {
  if (!Array.isArray(value)) return ['MCP accepted artifact probeFamilyIds must be an array.'];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const probeId of value) {
    if (typeof probeId !== 'string') {
      errors.push('MCP accepted artifact probeFamilyIds must contain strings.');
      continue;
    }
    if ((LEGACY_MCP_PROBE_IDS as readonly string[]).includes(probeId)) {
      errors.push(`Legacy MCP probe ID ${probeId} is rejected migration input.`);
    } else if (!(MCP_20260728_PROBE_FAMILY_IDS as readonly string[]).includes(probeId)) {
      errors.push(`MCP probe family ${probeId} is not a registered 2026-07-28 family.`);
    }
    if (seen.has(probeId)) errors.push(`MCP probe family repeats: ${probeId}.`);
    seen.add(probeId);
  }
  for (const required of PHASE4B_MCP_READ_REQUIRED_PROBE_FAMILY_IDS) {
    if (!seen.has(required)) errors.push(`MCP accepted artifact misses required probe family ${required}.`);
  }
  return errors;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string, errors: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join('\0') !== wanted.join('\0')) {
    errors.push(`${label} fields are incomplete or unknown.`);
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') {
    const primitive = JSON.stringify(value);
    if (primitive === undefined) return 'undefined';
    return primitive;
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
