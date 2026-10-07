import { createHash, timingSafeEqual } from 'node:crypto';
import {
  assertProfileClaims,
  createDeploymentConformancePlan,
  type ConformancePort,
  type DeploymentConformanceScope,
  type VerifiedDeploymentConformanceEvidence,
  type VerifiedProfileClaims,
} from '@know-n/colp/conformance';
import type { EndpointKey } from '@know-n/colp/semantic';
import {
  validatePhase3ServerSyncAcceptanceArtifact,
  type Phase3ServerSyncAcceptanceEvidence,
} from './phase3-server-sync-acceptance-evidence.js';
import {
  validatePhase3AuthoritativePullEvidence,
  type Phase3AuthoritativePullEvidence,
} from './phase3-authoritative-pull-acceptance-evidence.js';

export const PHASE3_SYNC_TASK_GATES = Object.freeze([
  'P3-08', 'P3-09', 'P3-16', 'P3-19', 'P3-21', 'P3-22', 'P3-23', 'P3-24',
  'P3-25', 'P3-26', 'P3-27', 'P3-29', 'P3-31', 'P3-32', 'P3-33', 'P3-34',
  'P3-35', 'P3-37', 'P3-38',
] as const);

export const PHASE3_SYNC_ENDPOINTS = Object.freeze([
  'syncSessions', 'syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict',
] as const satisfies readonly EndpointKey[]);

export const PHASE3_SYNC_PORTS = Object.freeze([
  'schema', 'semantic', 'sync', 'transactions', 'outbox',
] as const satisfies readonly ConformancePort[]);

export const PHASE3_SYNC_PROFILE_CLAIMS = Object.freeze(['core', 'sync'] as const);
export const PHASE3_SYNC_CONFORMANCE_SCOPE = Object.freeze({
  profiles: PHASE3_SYNC_PROFILE_CLAIMS,
  capabilities: Object.freeze([]),
}) satisfies DeploymentConformanceScope;
export const PHASE3_SYNC_CONFORMANCE_PLAN = createDeploymentConformancePlan(
  PHASE3_SYNC_CONFORMANCE_SCOPE,
);

export interface Phase3SyncDeploymentBinding {
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly configDigest: string;
  readonly migrationDigest: string;
  readonly extensionConfigDigest: string;
  readonly extensionMigrationDigest: string;
  readonly colpVersion: '0.2';
  readonly colpDigest: string;
  readonly backendArtifactDigest: string;
  readonly extensionArtifactDigest: string;
  readonly browserVersion: string;
  readonly protocolVersions: readonly ['0.1', '0.2'];
  readonly maxBatchOperations: 1;
  readonly credentialVerifier: 'extension-oauth-jwks';
  readonly endpoints: readonly string[];
  readonly ports: readonly string[];
}

export interface Phase3SyncTaskGateEvidence {
  readonly task: typeof PHASE3_SYNC_TASK_GATES[number];
  readonly accepted: true;
  readonly evidenceDigest: string;
}

export interface Phase3MultiDeviceClaimEvidence {
  readonly format: 'known.phase3.multi-device-recovery.v1';
  readonly schemaVersion: 1;
  readonly accepted: true;
  readonly mode: 'acceptance';
  readonly stage: 'full';
  readonly profileClaimed: false;
  readonly deploymentProven: false;
  readonly runtime: { readonly browser: string; readonly protocolVersion: '0.2' };
  readonly artifact: {
    readonly sha256: string;
    readonly configDigest: string;
    readonly migrationDigest: string;
  };
  readonly managedPolicy: {
    readonly sameArtifact: true;
    readonly artifactSha256: string;
    readonly writeRejected: true;
    readonly managedNodeCount: number;
  };
  readonly redaction: { readonly scannedBytes: number; readonly leaks: 0 };
  readonly evidenceDigest: string;
  readonly [key: string]: unknown;
}

export interface VerifiedPhase3SyncPrerequisites {
  readonly binding: Readonly<Phase3SyncDeploymentBinding>;
  readonly serverSync: Phase3ServerSyncAcceptanceEvidence;
  readonly authoritativePull: Phase3AuthoritativePullEvidence;
  readonly multiDevice: Phase3MultiDeviceClaimEvidence;
  readonly taskGates: readonly Phase3SyncTaskGateEvidence[];
  readonly aggregateDigest: string;
}

export interface Phase3SyncProfileClaims {
  readonly profiles: VerifiedProfileClaims;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly aggregateDigest: string;
}

export interface Phase3SyncProfileClaimController {
  current(): Phase3SyncProfileClaims | undefined;
  activate(claims: Phase3SyncProfileClaims): void;
}

const issuedPrerequisites = new WeakSet<object>();
const issuedClaims = new WeakSet<object>();
const issuedControllers = new WeakSet<object>();

export function verifyPhase3SyncPrerequisites(input: {
  readonly binding: Phase3SyncDeploymentBinding;
  readonly serverSync: Phase3ServerSyncAcceptanceEvidence;
  readonly authoritativePull: Phase3AuthoritativePullEvidence;
  readonly multiDevice: Phase3MultiDeviceClaimEvidence;
  readonly taskGates: readonly Phase3SyncTaskGateEvidence[];
}): VerifiedPhase3SyncPrerequisites {
  const binding = validateBinding(input.binding);
  const serverSync = validatePhase3ServerSyncAcceptanceArtifact(input.serverSync);
  const authoritativePull = validatePhase3AuthoritativePullEvidence(input.authoritativePull);
  const multiDevice = validateMultiDevice(input.multiDevice, binding);
  const taskGates = validateTaskGates(input.taskGates);

  if (serverSync.runtime.configDigest !== binding.configDigest
      || serverSync.migrations.chainDigest !== binding.migrationDigest
      || serverSync.colp.packageDigest !== binding.colpDigest) {
    throw new TypeError('P3-26 evidence does not match the current deployment binding');
  }
  const aggregateDigest = sha256Hex(canonicalJson({
    binding,
    serverSync: serverSync.evidenceDigest,
    authoritativePull: authoritativePull.projectionDigest,
    multiDevice: multiDevice.evidenceDigest,
    taskGates,
  }));
  const verified = deepFreeze({
    binding, serverSync, authoritativePull, multiDevice, taskGates, aggregateDigest,
  });
  issuedPrerequisites.add(verified);
  return verified;
}

export function createPhase3SyncProfileClaimController(): Phase3SyncProfileClaimController {
  let active: Phase3SyncProfileClaims | undefined;
  const controller = Object.freeze({
    current: () => active,
    activate(claims: Phase3SyncProfileClaims) {
      assertPhase3SyncProfileClaims(claims);
      if (active !== undefined && active !== claims) {
        throw new TypeError('Sync Profile claims are already active for this process');
      }
      active = claims;
    },
  });
  issuedControllers.add(controller);
  return controller;
}

export function assertPhase3SyncProfileClaimController(
  value: Phase3SyncProfileClaimController,
): void {
  if (!issuedControllers.has(value)) {
    throw new TypeError('Sync Profile claim controller must be issued by this module');
  }
}

export function claimPhase3SyncProfiles(input: {
  readonly prerequisites: VerifiedPhase3SyncPrerequisites;
  readonly deploymentEvidence: VerifiedDeploymentConformanceEvidence;
}): Phase3SyncProfileClaims {
  if (!issuedPrerequisites.has(input.prerequisites)) {
    throw new TypeError('Phase 3 prerequisites must be returned by verifyPhase3SyncPrerequisites');
  }
  const plan = PHASE3_SYNC_CONFORMANCE_PLAN;
  if (input.deploymentEvidence.profiles.join('\0') !== plan.profiles.join('\0')
      || input.deploymentEvidence.capabilities.join('\0') !== plan.capabilities.join('\0')
      || input.deploymentEvidence.passedProbeIds.join('\0') !== plan.probeIds.join('\0')) {
    throw new TypeError('Phase 3 deployment conformance evidence is incomplete or has the wrong scope');
  }
  const profiles = assertProfileClaims(PHASE3_SYNC_PROFILE_CLAIMS, {
    registeredEndpoints: new Set<EndpointKey>(PHASE3_SYNC_ENDPOINTS),
    availablePorts: new Set<ConformancePort>(PHASE3_SYNC_PORTS),
    deploymentEvidence: input.deploymentEvidence,
  });
  if (profiles.join('\0') !== PHASE3_SYNC_PROFILE_CLAIMS.join('\0')) {
    throw new TypeError('COLP returned an unexpected Phase 3 Profile claim set');
  }
  const claims = deepFreeze({
    profiles,
    sourceRevision: input.prerequisites.binding.sourceRevision,
    sourceDigest: input.prerequisites.binding.sourceDigest,
    aggregateDigest: input.prerequisites.aggregateDigest,
  });
  issuedClaims.add(claims);
  return claims;
}

export function assertPhase3SyncProfileClaims(
  value: Phase3SyncProfileClaims,
): asserts value is Phase3SyncProfileClaims {
  if (!issuedClaims.has(value)) {
    throw new TypeError('Sync Profile claims must be issued by claimPhase3SyncProfiles');
  }
}

export function inspectPhase3SyncPrerequisites(
  value: VerifiedPhase3SyncPrerequisites,
): Readonly<{ readonly aggregateDigest: string; readonly binding: Phase3SyncDeploymentBinding }> {
  if (!issuedPrerequisites.has(value)) {
    throw new TypeError('Phase 3 prerequisites were not issued by this module');
  }
  return Object.freeze({ aggregateDigest: value.aggregateDigest, binding: value.binding });
}

function validateBinding(value: Phase3SyncDeploymentBinding): Readonly<Phase3SyncDeploymentBinding> {
  exactKeys(value as unknown as Record<string, unknown>, [
    'sourceRevision', 'sourceDigest', 'configDigest', 'migrationDigest',
    'extensionConfigDigest', 'extensionMigrationDigest', 'colpVersion',
    'colpDigest', 'backendArtifactDigest', 'extensionArtifactDigest', 'browserVersion',
    'protocolVersions', 'maxBatchOperations', 'credentialVerifier', 'endpoints', 'ports',
  ], 'Phase 3 deployment binding');
  if (!/^[0-9a-f]{40}$/u.test(value.sourceRevision)) throw new TypeError('Phase 3 source revision is invalid');
  for (const [label, digest] of Object.entries({
    source: value.sourceDigest, config: value.configDigest, migration: value.migrationDigest,
    extensionConfig: value.extensionConfigDigest,
    extensionMigration: value.extensionMigrationDigest,
    COLP: value.colpDigest, backendArtifact: value.backendArtifactDigest,
    extensionArtifact: value.extensionArtifactDigest,
  })) requireSha256(digest, `Phase 3 ${label}`);
  if (value.colpVersion !== '0.2'
      || value.protocolVersions.join('\0') !== ['0.1', '0.2'].join('\0')) {
    throw new TypeError('Phase 3 requires exact COLP N/N-1 protocol binding');
  }
  if (value.maxBatchOperations !== 1) throw new TypeError('Phase 3 maxBatchOperations must remain 1');
  if (value.credentialVerifier !== 'extension-oauth-jwks') {
    throw new TypeError('Phase 3 extension credential verifier is not production-backed');
  }
  nonEmpty(value.browserVersion, 'Phase 3 browser version');
  exactOrderedSet(value.endpoints, PHASE3_SYNC_ENDPOINTS, 'Phase 3 endpoints');
  exactOrderedSet(value.ports, PHASE3_SYNC_PORTS, 'Phase 3 runtime ports');
  return deepFreeze(structuredClone(value));
}

function validateTaskGates(values: readonly Phase3SyncTaskGateEvidence[]): readonly Phase3SyncTaskGateEvidence[] {
  if (!Array.isArray(values)) throw new TypeError('Phase 3 task gate evidence must be an array');
  exactOrderedSet(values.map(({ task }) => task), PHASE3_SYNC_TASK_GATES, 'Phase 3 task gates');
  for (const value of values) {
    exactKeys(value as unknown as Record<string, unknown>, ['task', 'accepted', 'evidenceDigest'], `Phase 3 ${value.task}`);
    if (value.accepted !== true) throw new TypeError(`Phase 3 ${value.task} is not accepted`);
    requireSha256(value.evidenceDigest, `Phase 3 ${value.task} evidence`);
  }
  return deepFreeze(structuredClone(values));
}

function validateMultiDevice(
  value: Phase3MultiDeviceClaimEvidence,
  binding: Phase3SyncDeploymentBinding,
): Phase3MultiDeviceClaimEvidence {
  if (!value || typeof value !== 'object' || value.format !== 'known.phase3.multi-device-recovery.v1'
      || value.schemaVersion !== 1 || value.accepted !== true || value.mode !== 'acceptance'
      || value.stage !== 'full' || value.profileClaimed !== false || value.deploymentProven !== false) {
    throw new TypeError('P3-38 evidence identity or claim boundary is invalid');
  }
  requireSha256(value.evidenceDigest, 'P3-38 evidence');
  const unsigned = structuredClone(value) as Record<string, unknown>;
  delete unsigned.evidenceDigest;
  const actual = sha256Hex(canonicalJson(unsigned));
  if (!constantTimeHexEqual(value.evidenceDigest, actual)) throw new TypeError('P3-38 evidence digest mismatch');
  if (value.runtime?.protocolVersion !== '0.2' || value.runtime.browser !== binding.browserVersion
      || value.artifact?.sha256 !== binding.extensionArtifactDigest
      || value.artifact.configDigest !== binding.extensionConfigDigest
      || value.artifact.migrationDigest !== binding.extensionMigrationDigest) {
    throw new TypeError('P3-38 runtime or artifact does not match the current deployment binding');
  }
  if (value.managedPolicy?.sameArtifact !== true
      || value.managedPolicy.artifactSha256 !== binding.extensionArtifactDigest
      || value.managedPolicy.writeRejected !== true
      || !Number.isSafeInteger(value.managedPolicy.managedNodeCount)
      || value.managedPolicy.managedNodeCount < 1) {
    throw new TypeError('P3-38 managed bookmark deployment role is incomplete');
  }
  if (value.redaction?.leaks !== 0 || !Number.isSafeInteger(value.redaction.scannedBytes)
      || value.redaction.scannedBytes < 1) {
    throw new TypeError('P3-38 sensitive marker scan is incomplete');
  }
  return deepFreeze(structuredClone(value));
}

function exactOrderedSet(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.join('\0') !== expected.join('\0')) throw new TypeError(`${label} are incomplete or reordered`);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function requireSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be non-empty`);
  return value;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const primitive = JSON.stringify(value);
    if (primitive === undefined) throw new TypeError('Phase 3 evidence contains a non-JSON value');
    return primitive;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
