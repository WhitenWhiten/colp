import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  bundledConformanceEvidence,
  conformanceRequirements,
  type ConformanceRequirement,
} from '@know-n/colp/conformance';
import {
  assertPhase2PublicationProfileClaims,
  inspectPhase2PublicationProfileClaims,
  verifyPhase2PublicationEvidence,
  type Phase2PublicationProfileClaims,
  type VerifiedPhase2PublicationEvidence,
  type VerifyPhase2PublicationEvidenceOptions,
} from '../../src/modules/publication/index.js';

const MAX_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
const REQUIRED_PROFILES = new Set(['core', 'publication']);
const REQUIRED_LEVELS = new Set(['MUST', 'MUST_NOT']);
const PHASE2_REQUIRED_PACKAGE_REQUIREMENTS = Object.freeze(
  conformanceRequirements
    .filter(isPhase2RequiredRequirement)
    .sort((left, right) => left.id.localeCompare(right.id)),
);
export const PHASE2_REQUIRED_PACKAGE_REQUIREMENT_COUNT =
  PHASE2_REQUIRED_PACKAGE_REQUIREMENTS.length;

export interface Phase2PackageRequirementMapping {
  readonly id: string;
  readonly profile: 'core' | 'publication';
  readonly level: 'MUST' | 'MUST_NOT';
  readonly source: string;
  readonly implementation: readonly string[];
  readonly tests: readonly string[];
  readonly passed: boolean;
}

export interface Phase2PackageRequirementSummary {
  readonly expected: number;
  readonly mapped: number;
  readonly passed: number;
  readonly complete: boolean;
  readonly requiredSetDigest: string;
  readonly packageEvidence: {
    readonly packageVersion: string;
    readonly requirementsDigest: string;
  };
  readonly requirements: readonly Phase2PackageRequirementMapping[];
}

export interface Phase2ReleaseGateResult {
  readonly evidence: 'phase2_publication_release_gate';
  readonly accepted: true;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly acceptanceEvidenceDigest: string;
  readonly packageRequirements: Phase2PackageRequirementSummary;
  readonly claimedProfiles: readonly ['core', 'publication'];
}

/** Maps the current package build's complete Core + Publication Required set. */
export function createPhase2ReleaseRequirementMapping(): Phase2PackageRequirementSummary {
  const passedIds = new Set(bundledConformanceEvidence.passedRequirementIds);
  const requirements = PHASE2_REQUIRED_PACKAGE_REQUIREMENTS.map((requirement) => Object.freeze({
    id: requirement.id,
    profile: requirement.profile as 'core' | 'publication',
    level: requirement.level as 'MUST' | 'MUST_NOT',
    source: requirement.source,
    implementation: Object.freeze([...requirement.implementation]),
    tests: Object.freeze([...requirement.tests]),
    passed: requirement.tests.length > 0 && passedIds.has(requirement.id),
  }));
  const passed = requirements.filter((requirement) => requirement.passed).length;
  const complete = requirements.length === PHASE2_REQUIRED_PACKAGE_REQUIREMENT_COUNT
    && passed === PHASE2_REQUIRED_PACKAGE_REQUIREMENT_COUNT
    && bundledConformanceEvidence.schemaVersion === 2;
  return deepFreeze({
    expected: PHASE2_REQUIRED_PACKAGE_REQUIREMENT_COUNT,
    mapped: requirements.length,
    passed,
    complete,
    requiredSetDigest: `sha256:${createHash('sha256')
      .update(requirements.map(({ id }) => id).join('\n'), 'utf8')
      .digest('hex')}`,
    packageEvidence: {
      packageVersion: bundledConformanceEvidence.packageVersion,
      requirementsDigest: bundledConformanceEvidence.requirementsDigest,
    },
    requirements,
  });
}

/** Final pure release decision after the official COLP assertion issued claims. */
export function evaluatePhase2ReleaseGate(input: {
  readonly acceptanceEvidence: VerifiedPhase2PublicationEvidence;
  readonly profileClaims: Phase2PublicationProfileClaims;
}): Phase2ReleaseGateResult {
  assertPhase2PublicationProfileClaims(input.profileClaims);
  const binding = inspectPhase2PublicationProfileClaims(input.profileClaims);
  if (binding.sourceRevision !== input.acceptanceEvidence.sourceRevision
      || binding.sourceDigest !== input.acceptanceEvidence.sourceDigest
      || binding.evidenceDigest !== input.acceptanceEvidence.evidenceDigest) {
    throw new TypeError('Phase 2 Profile claims do not bind the supplied acceptance evidence');
  }
  const packageRequirements = createPhase2ReleaseRequirementMapping();
  if (!packageRequirements.complete) {
    throw new TypeError(
      `Phase 2 package requirement evidence is incomplete: ${packageRequirements.passed}/${packageRequirements.expected}`,
    );
  }
  if (input.profileClaims.profiles.length !== 2
      || input.profileClaims.profiles[0] !== 'core'
      || input.profileClaims.profiles[1] !== 'publication') {
    throw new TypeError('Phase 2 release claims must be exactly core and publication');
  }
  return deepFreeze({
    evidence: 'phase2_publication_release_gate' as const,
    accepted: true as const,
    sourceRevision: binding.sourceRevision,
    sourceDigest: binding.sourceDigest,
    acceptanceEvidenceDigest: binding.evidenceDigest,
    packageRequirements,
    claimedProfiles: ['core', 'publication'] as const,
  });
}

/** Reads a bounded regular JSON file and applies the same pure source-binding validator. */
export async function readPhase2PublicationEvidenceFile(
  path: string,
  options: VerifyPhase2PublicationEvidenceOptions,
): Promise<VerifiedPhase2PublicationEvidence> {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TypeError('Phase 2 evidence path must be non-empty');
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError('Phase 2 evidence path must name a regular non-symlink file');
  }
  if (metadata.size <= 0 || metadata.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new TypeError('Phase 2 evidence file size is invalid');
  }
  const source = await readFile(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TypeError('Phase 2 evidence file is not valid JSON');
  }
  return verifyPhase2PublicationEvidence(value, options);
}

function isPhase2RequiredRequirement(
  requirement: ConformanceRequirement,
): boolean {
  return REQUIRED_PROFILES.has(requirement.profile)
    && REQUIRED_LEVELS.has(requirement.level);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
