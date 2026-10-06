import {
  endpointContracts,
  profileDependencies,
  type EndpointKey,
  type ProtocolProfile,
} from '../semantic/index.js';
import {
  assertVerifiedDeploymentConformanceEvidence,
  createDeploymentConformancePlan,
  type VerifiedDeploymentConformanceEvidence,
} from './deployment.js';

export interface ConformanceRequirementSelector {
  readonly marker?: string;
  readonly section?: string;
  readonly quote?: string;
  readonly quoteOrdinal?: number;
  readonly keywordOrdinal?: number;
}

export interface ConformanceRequirement {
  readonly id: string;
  readonly level: 'MUST' | 'MUST_NOT' | 'SHOULD' | 'SHOULD_NOT' | 'MAY';
  readonly profile: ProtocolProfile;
  readonly classification?: 'auto' | 'manual';
  readonly source: string;
  readonly requirement: string;
  readonly selector: ConformanceRequirementSelector;
  readonly implementation: readonly string[];
  readonly tests: readonly string[];
}

export type ConformancePort =
  | 'approval'
  | 'audit'
  | 'client'
  | 'feed'
  | 'idempotency'
  | 'mcp'
  | 'outbox'
  | 'publisher'
  | 'schema'
  | 'semantic'
  | 'server'
  | 'sync'
  | 'transactions';

export interface DeploymentRuntimeProbes {
  readonly registeredEndpoints: ReadonlySet<EndpointKey>;
  readonly availablePorts: ReadonlySet<ConformancePort>;
  readonly deploymentEvidence?: VerifiedDeploymentConformanceEvidence;
}

export interface ConformanceEvidenceArtifact {
  readonly schemaVersion: 1;
  readonly protocolVersion: string;
  readonly packageVersion: string;
  readonly sourceRevision: string;
  readonly requirementsDigest: string;
  readonly reportDigest?: string;
  readonly passedRequirementIds: readonly string[];
}

export interface ConformanceMetadata {
  readonly protocolVersion: string;
  readonly packageVersion: string;
  readonly requirementsDigest: string;
}

export const profileOrder = Object.freeze([
  'core',
  'publication',
  'feed',
  'publisher',
  'sync',
  'mcp-read',
  'mcp-write',
] as const satisfies readonly ProtocolProfile[]);

export const profilePorts = Object.freeze({
  core: Object.freeze(['schema', 'semantic']),
  publication: Object.freeze(['client', 'server']),
  feed: Object.freeze(['feed']),
  publisher: Object.freeze(['publisher', 'transactions', 'idempotency', 'outbox']),
  sync: Object.freeze(['sync', 'transactions', 'outbox']),
  'mcp-read': Object.freeze(['mcp']),
  'mcp-write': Object.freeze(['mcp', 'approval', 'audit']),
} as const satisfies Readonly<Record<ProtocolProfile, readonly ConformancePort[]>>);

export function profileDependencyClosure(profile: ProtocolProfile): ReadonlySet<ProtocolProfile> {
  const closure = new Set<ProtocolProfile>();
  const visit = (current: ProtocolProfile): void => {
    if (closure.has(current)) return;
    closure.add(current);
    for (const dependency of profileDependencies[current]) visit(dependency);
  };
  visit(profile);
  return closure;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertValidEvidenceArtifact(
  value: unknown,
  metadata: ConformanceMetadata,
  requirements: readonly ConformanceRequirement[],
): asserts value is ConformanceEvidenceArtifact {
  if (!isRecord(value)) throw new TypeError('Conformance evidence must be an object.');
  const allowedKeys = new Set([
    'schemaVersion',
    'protocolVersion',
    'packageVersion',
    'sourceRevision',
    'requirementsDigest',
    'reportDigest',
    'passedRequirementIds',
  ]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new TypeError(`Unknown conformance evidence fields: ${unknownKeys.join(', ')}`);
  }
  if (value.schemaVersion !== 1) throw new TypeError('Unsupported evidence schemaVersion.');
  for (const key of ['protocolVersion', 'packageVersion', 'requirementsDigest'] as const) {
    if (value[key] !== metadata[key]) {
      throw new TypeError(`Evidence ${key} does not match this package.`);
    }
  }
  if (typeof value.sourceRevision !== 'string' || value.sourceRevision.length === 0) {
    throw new TypeError('Evidence sourceRevision must be a non-empty string.');
  }
  if (!Array.isArray(value.passedRequirementIds)) {
    throw new TypeError('Evidence passedRequirementIds must be an array.');
  }

  const requirementById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const seen = new Set<string>();
  for (const id of value.passedRequirementIds) {
    if (typeof id !== 'string') throw new TypeError('Passed Requirement IDs must be strings.');
    if (seen.has(id)) throw new TypeError(`Duplicate passed Requirement ID: ${id}`);
    seen.add(id);
    const requirement = requirementById.get(id);
    if (requirement === undefined) throw new TypeError(`Unknown passed Requirement ID: ${id}`);
    if (requirement.tests.length === 0) {
      throw new TypeError(`Requirement ${id} has no named tests and cannot be verified.`);
    }
  }

  if (value.passedRequirementIds.length > 0) {
    if (!/^[0-9a-f]{7,64}$/u.test(value.sourceRevision)) {
      throw new TypeError('Verified evidence sourceRevision must be hexadecimal.');
    }
    if (typeof value.reportDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.reportDigest)) {
      throw new TypeError('Verified evidence must bind a SHA-256 reportDigest.');
    }
  } else if (
    value.reportDigest !== undefined &&
    (typeof value.reportDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.reportDigest))
  ) {
    throw new TypeError('Evidence reportDigest must be a SHA-256 digest.');
  }
}

export function assertRuntimeProbes(value: unknown): asserts value is DeploymentRuntimeProbes {
  if (!isRecord(value)) throw new TypeError('Deployment runtime probes must be an object.');
  const keys = Object.keys(value).sort();
  if (
    keys.join(',') !== 'availablePorts,registeredEndpoints'
    && keys.join(',') !== 'availablePorts,deploymentEvidence,registeredEndpoints'
  ) {
    throw new TypeError(
      'Runtime probes may contain only registeredEndpoints, availablePorts, and deploymentEvidence.',
    );
  }
  const setValues = Set.prototype.values;
  let registeredEndpoints: SetIterator<unknown>;
  let availablePorts: SetIterator<unknown>;
  try {
    registeredEndpoints = setValues.call(value.registeredEndpoints as Set<unknown>);
    availablePorts = setValues.call(value.availablePorts as Set<unknown>);
  } catch {
    throw new TypeError(
      'Runtime endpoint and port probes must be ReadonlySet-compatible actual Set values.',
    );
  }
  const knownEndpoints = new Set(Object.keys(endpointContracts));
  const knownPorts = new Set(Object.values(profilePorts).flat());
  for (const endpoint of registeredEndpoints) {
    if (!knownEndpoints.has(endpoint as EndpointKey)) {
      throw new TypeError(`Unknown registered endpoint probe: ${String(endpoint)}`);
    }
  }
  for (const port of availablePorts) {
    if (!knownPorts.has(port as ConformancePort)) {
      throw new TypeError(`Unknown runtime port probe: ${String(port)}`);
    }
  }
  if (value.deploymentEvidence !== undefined) {
    assertVerifiedDeploymentConformanceEvidence(value.deploymentEvidence);
  }
}

export function evaluateProfileClaimsWithEvidence(
  probes: DeploymentRuntimeProbes,
  evidence: ConformanceEvidenceArtifact,
  metadata: ConformanceMetadata,
  requirements: readonly ConformanceRequirement[],
  profileRequiredEndpoints: Readonly<Record<ProtocolProfile, readonly EndpointKey[]>>,
): readonly ProtocolProfile[] {
  assertRuntimeProbes(probes);
  assertValidEvidenceArtifact(evidence, metadata, requirements);
  const passedIds = new Set(evidence.passedRequirementIds);
  const deploymentEvidence = probes.deploymentEvidence;
  const passedDeploymentProbeIds = new Set(deploymentEvidence?.passedProbeIds ?? []);
  const evidencedProfiles = new Set(deploymentEvidence?.profiles ?? []);
  const evidencedCapabilities = new Set(deploymentEvidence?.capabilities ?? []);

  return Object.freeze(
    profileOrder.filter((profile) => {
      const closure = profileDependencyClosure(profile);
      const requiredDeploymentPlan = createDeploymentConformancePlan({
        profiles: profileOrder.filter((candidate) => closure.has(candidate)),
        capabilities: [],
      });
      if (
        !requiredDeploymentPlan.profiles.every((candidate) => evidencedProfiles.has(candidate))
        || !requiredDeploymentPlan.capabilities.every((capability) =>
          evidencedCapabilities.has(capability))
        || !requiredDeploymentPlan.probeIds.every((probeId) =>
          passedDeploymentProbeIds.has(probeId))
      ) {
        return false;
      }
      for (const dependency of closure) {
        if (
          !profileRequiredEndpoints[dependency].every((endpoint) =>
            Set.prototype.has.call(probes.registeredEndpoints, endpoint),
          ) ||
          !profilePorts[dependency].every((port) =>
            Set.prototype.has.call(probes.availablePorts, port),
          )
        ) {
          return false;
        }
        const required = requirements.filter(
          (requirement) =>
            requirement.profile === dependency &&
            (requirement.level === 'MUST' || requirement.level === 'MUST_NOT'),
        );
        if (
          required.length === 0 ||
          !required.every(
            (requirement) =>
              requirement.tests.length > 0 && passedIds.has(requirement.id),
          )
        ) {
          return false;
        }
      }
      return true;
    }),
  );
}
