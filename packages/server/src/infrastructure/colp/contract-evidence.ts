import {
  bundledConformanceEvidence,
  conformanceRequirements,
  deploymentConformanceProbeIds,
} from '@know-n/colp/conformance';

export interface ColpContractEvidence {
  readonly evidence: 'colp_public_contract';
  readonly publicEntrypoint: '@know-n/colp/conformance';
  readonly bundledEvidenceAvailable: boolean;
  readonly requirementCount: number;
  readonly deploymentProbeCount: number;
  readonly phase2RequiredRequirementCount: number;
  readonly phase2PassedRequirementCount: number;
  readonly phase2ReleaseEvidenceComplete: boolean;
  readonly claimedProfiles: readonly [];
}

/** Inspects package-level evidence without asserting deployment conformance or Profiles. */
export function inspectColpContractEvidence(): ColpContractEvidence {
  const phase2Required = conformanceRequirements.filter((requirement) =>
    (requirement.profile === 'core' || requirement.profile === 'publication')
    && (requirement.level === 'MUST' || requirement.level === 'MUST_NOT'));
  const passed = new Set(bundledConformanceEvidence.passedRequirementIds);
  const phase2PassedRequirementCount = phase2Required.filter((requirement) =>
    requirement.tests.length > 0 && passed.has(requirement.id)).length;
  return {
    evidence: 'colp_public_contract',
    publicEntrypoint: '@know-n/colp/conformance',
    bundledEvidenceAvailable: bundledConformanceEvidence !== undefined,
    requirementCount: conformanceRequirements.length,
    deploymentProbeCount: deploymentConformanceProbeIds.length,
    phase2RequiredRequirementCount: phase2Required.length,
    phase2PassedRequirementCount,
    phase2ReleaseEvidenceComplete: phase2Required.length > 0
      && phase2PassedRequirementCount === phase2Required.length
      && bundledConformanceEvidence.schemaVersion === 2,
    claimedProfiles: [],
  };
}
