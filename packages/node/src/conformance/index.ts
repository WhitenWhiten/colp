import evidenceJson from './generated/evidence.json' with { type: 'json' };
import requirementsJson from './generated/requirements.json' with { type: 'json' };

import {
  profileDependencies,
  profileRequiredEndpoints,
  type EndpointKey,
  type ProtocolProfile,
} from '../semantic/index.js';
import {
  assertValidEvidenceArtifact,
  evaluateProfileClaimsWithEvidence,
  type ConformanceEvidenceArtifact,
  type ConformanceMetadata,
  type ConformancePort,
  type ConformanceRequirement,
  type DeploymentRuntimeProbes,
} from './internal.js';

export {
  createDeploymentConformancePlan,
  deploymentCapabilityConformanceProbes,
  deploymentConformanceCapabilityIds,
  deploymentConformanceProbeIds,
  profileDeploymentConformanceCapabilities,
  profileDeploymentConformanceProbes,
  runDeploymentConformanceProbe,
  runDeploymentConformanceProbes,
  type DeploymentConformanceCapabilityId,
  type DeploymentConformanceCommand,
  type DeploymentConformancePlan,
  type DeploymentConformanceProbeId,
  type DeploymentConformanceScope,
  type DeploymentConformanceTarget,
  type ParentProbeNode,
  type VerifiedDeploymentConformanceEvidence,
} from './deployment.js';

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const protocolExampleContracts = {
  'access-policy.json': 'accessPolicy',
  'change-plan.json': 'changePlan',
  'change-plan-request.json': 'changePlanRequest',
  'collection-directory.json': 'collectionDirectory',
  'collection-metadata.json': 'collectionMetadata',
  'collection-snapshot.json': 'snapshot',
  'global-resource-identity.json': 'canonicalResourceUri',
  'mcp-tools-list.json': 'mcpToolsList',
  'local-bookmark-node.json': 'node',
  'node-detail.json': 'nodeDetail',
  'problem.json': 'problem',
  'protected-publication-snapshot.json': 'snapshot',
  'public-feed.json': 'feed',
  'public-manifest.json': 'manifest',
  'publisher-annotation-create.json': 'annotationCreate',
  'publisher-collection-create-result.json': 'collectionCreateResult',
  'publisher-collection-create.json': 'collectionCreateRequest',
  'publisher-node-move.json': 'nodeMoveRequest',
  'release-directory.json': 'releaseDirectory',
  'release-result.json': 'releaseResult',
  'sync-pull.json': 'syncPull',
  'sync-pull-v02.json': 'syncPullV02',
  'sync-push-result.json': 'syncPushResult',
  'sync-push.json': 'syncPush',
  'sync-session-request.json': 'syncSessionRequest',
  'sync-session-result.json': 'syncSessionResult',
  'sync-snapshot.json': 'snapshot',
  'sync-update-operation.json': 'operation',
} as const;

export type ProtocolExampleName = keyof typeof protocolExampleContracts;
export type {
  ConformanceEvidenceArtifact,
  ConformancePort,
  ConformanceRequirement,
  DeploymentRuntimeProbes,
  ProtocolProfile,
};

declare const verifiedProfileClaimsBrand: unique symbol;

/**
 * An immutable, non-empty Profile list that passed the bundled conformance
 * evidence and deployment-probe gates at the Manifest publication boundary.
 */
export type VerifiedProfileClaims = readonly [ProtocolProfile, ...ProtocolProfile[]] & {
  readonly [verifiedProfileClaimsBrand]: true;
};

export const conformanceRequirements = deepFreeze(
  requirementsJson.requirements as readonly unknown[] as readonly ConformanceRequirement[],
);

const conformanceMetadata: ConformanceMetadata = Object.freeze({
  protocolVersion: requirementsJson.protocolVersion,
  packageVersion: requirementsJson.packageVersion,
  requirementsDigest: requirementsJson.requirementsDigest,
});

assertValidEvidenceArtifact(evidenceJson, conformanceMetadata, conformanceRequirements);
export const bundledConformanceEvidence: ConformanceEvidenceArtifact = Object.freeze({
  ...evidenceJson,
  passedRequirementIds: Object.freeze([...evidenceJson.passedRequirementIds]),
});

const conformanceProfileEndpoints = deepFreeze(
  {
    core: [...profileRequiredEndpoints.core],
    publication: [...profileRequiredEndpoints.publication],
    feed: [...profileRequiredEndpoints.feed],
    publisher: [...profileRequiredEndpoints.publisher],
    sync: [...profileRequiredEndpoints.sync],
    'mcp-read': [...profileRequiredEndpoints['mcp-read']],
    'mcp-write': [...profileRequiredEndpoints['mcp-write']],
  } satisfies Readonly<Record<ProtocolProfile, readonly EndpointKey[]>>,
);

export function evaluateProfileClaims(probes: DeploymentRuntimeProbes): readonly ProtocolProfile[] {
  return evaluateProfileClaimsWithEvidence(
    probes,
    bundledConformanceEvidence,
    conformanceMetadata,
    conformanceRequirements,
    conformanceProfileEndpoints,
  );
}

const protocolProfiles = new Set<unknown>(Object.keys(profileDependencies));

/**
 * Rejects a deployment Manifest profile list unless every explicit claim and
 * dependency is backed by this package's evidence and the deployment probes.
 * Publish the returned snapshot, not the caller-owned input or the diagnostic
 * eligibility list returned by `evaluateProfileClaims`.
 */
export function assertProfileClaims(
  requestedProfiles: readonly ProtocolProfile[],
  probes: DeploymentRuntimeProbes,
): VerifiedProfileClaims {
  if (!Array.isArray(requestedProfiles)) {
    throw new TypeError('Requested profiles must be an array.');
  }
  if (requestedProfiles.length === 0) {
    throw new TypeError('A Manifest profile claim list must not be empty.');
  }

  const seen = new Set<ProtocolProfile>();
  for (const requested of requestedProfiles as readonly unknown[]) {
    if (!protocolProfiles.has(requested)) {
      throw new TypeError(`Unknown or legacy Manifest profile: ${String(requested)}`);
    }
    const profile = requested as ProtocolProfile;
    if (seen.has(profile)) {
      throw new TypeError(`Duplicate Manifest profile: ${profile}`);
    }
    seen.add(profile);
  }

  for (const profile of seen) {
    for (const dependency of profileDependencies[profile]) {
      if (!seen.has(dependency)) {
        throw new TypeError(`Profile ${profile} requires profile ${dependency}.`);
      }
    }
  }

  const eligible = new Set(evaluateProfileClaims(probes));
  const ineligible = [...seen].filter((profile) => !eligible.has(profile));
  if (ineligible.length > 0) {
    throw new TypeError(
      `Manifest profiles lack complete endpoint, port, deployment-probe, or MUST/MUST_NOT evidence: ${ineligible.join(', ')}`,
    );
  }

  return Object.freeze([...seen]) as unknown as VerifiedProfileClaims;
}
