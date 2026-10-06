import { describe, expect, it } from 'vitest';

import {
  bundledConformanceEvidence,
  conformanceRequirements,
  evaluateProfileClaims,
  type ConformanceEvidenceArtifact,
  type ConformancePort,
  type ConformanceRequirement,
  type DeploymentRuntimeProbes,
} from '../../src/conformance/index.js';
import {
  assertValidEvidenceArtifact,
  evaluateProfileClaimsWithEvidence,
  profileDependencyClosure,
} from '../../src/conformance/internal.js';
import {
  endpointContracts,
  profileRequiredEndpoints,
  type ProtocolProfile,
} from '../../src/semantic/index.js';
import { completeDeploymentEvidence } from './deployment-evidence.js';

const profiles = [
  'core',
  'publication',
  'feed',
  'publisher',
  'sync',
  'mcp-read',
  'mcp-write',
] as const satisfies readonly ProtocolProfile[];

const syntheticRequirements: readonly ConformanceRequirement[] = profiles.map((profile) => ({
  id: `TEST-${profile}`,
  level: 'MUST',
  profile,
  source: 'test',
  requirement: `${profile} requirement`,
  implementation: ['test'],
  tests: [`test.${profile}`],
}));

const metadata = {
  protocolVersion: '0.1',
  packageVersion: 'test-package',
  requirementsDigest: `sha256:${'1'.repeat(64)}`,
} as const;

const allPorts = new Set<ConformancePort>([
  'approval',
  'audit',
  'client',
  'feed',
  'idempotency',
  'mcp',
  'outbox',
  'publisher',
  'schema',
  'semantic',
  'server',
  'sync',
  'transactions',
]);

const allProbes: DeploymentRuntimeProbes = {
  registeredEndpoints: new Set(Object.keys(endpointContracts) as (keyof typeof endpointContracts)[]),
  availablePorts: allPorts,
  deploymentEvidence: completeDeploymentEvidence,
};

function evidence(passedRequirementIds = syntheticRequirements.map((item) => item.id)) {
  return {
    schemaVersion: 2,
    ...metadata,
    passedRequirementIds,
  } as const satisfies ConformanceEvidenceArtifact;
}

describe('profile claims', () => {
  it('uses the complete transitive dependency closure for mcp-write', () => {
    expect([...profileDependencyClosure('mcp-write')].sort()).toEqual([
      'core',
      'mcp-read',
      'mcp-write',
      'publication',
      'publisher',
    ]);
    expect(
      evaluateProfileClaimsWithEvidence(
        allProbes,
        evidence(),
        metadata,
        syntheticRequirements,
        profileRequiredEndpoints,
      ),
    ).toContain('mcp-write');
  });

  it.each(['core', 'publication', 'publisher', 'mcp-read'] as const)(
    'blocks mcp-write when its %s dependency evidence is absent',
    (missingProfile) => {
      const passed = syntheticRequirements
        .filter((item) => item.profile !== missingProfile)
        .map((item) => item.id);
      expect(
        evaluateProfileClaimsWithEvidence(
          allProbes,
          evidence(passed),
          metadata,
          syntheticRequirements,
          profileRequiredEndpoints,
        ),
      ).not.toContain('mcp-write');
    },
  );

  it('blocks mcp-write when a dependency port is absent', () => {
    const ports = new Set(allPorts);
    ports.delete('transactions');
    expect(
      evaluateProfileClaimsWithEvidence(
        { ...allProbes, availablePorts: ports },
        evidence(),
        metadata,
        syntheticRequirements,
        profileRequiredEndpoints,
      ),
    ).not.toContain('mcp-write');
  });

  it('blocks a profile when one of its dependency endpoints is absent', () => {
    const endpoints = new Set(allProbes.registeredEndpoints);
    endpoints.delete('directory');
    expect(
      evaluateProfileClaimsWithEvidence(
        { ...allProbes, registeredEndpoints: endpoints },
        evidence(),
        metadata,
        syntheticRequirements,
        profileRequiredEndpoints,
      ),
    ).not.toContain('publication');
  });

  it('does not vacuously claim a profile with no required records', () => {
    const requirementsWithoutCore = syntheticRequirements.filter((item) => item.profile !== 'core');
    const passed = requirementsWithoutCore.map((item) => item.id);
    expect(
      evaluateProfileClaimsWithEvidence(
        allProbes,
        evidence(passed),
        metadata,
        requirementsWithoutCore,
        profileRequiredEndpoints,
      ),
    ).not.toContain('core');
  });

  it('rejects runtime attempts to supply passingTests', () => {
    expect(() =>
      evaluateProfileClaims({
        registeredEndpoints: new Set(),
        availablePorts: new Set(),
        passingTests: new Set(conformanceRequirements.flatMap((item) => item.tests)),
      } as unknown as DeploymentRuntimeProbes),
    ).toThrow(/deploymentEvidence/u);
  });

  it('keeps bundled evidence immutable and requires runtime probes for claims', () => {
    expect(bundledConformanceEvidence.passedRequirementIds).toBeInstanceOf(Array);
    expect(
      evaluateProfileClaims({ registeredEndpoints: new Set(), availablePorts: new Set() }),
    ).toEqual([]);
    expect(Object.isFrozen(conformanceRequirements)).toBe(true);
    expect(Object.isFrozen(conformanceRequirements[0])).toBe(true);
    expect(Object.isFrozen(conformanceRequirements[0]?.tests)).toBe(true);
  });
});

describe('evidence validation', () => {
  it.each([
    ['protocolVersion', '0.2'],
    ['packageVersion', 'other-package'],
    ['requirementsDigest', `sha256:${'9'.repeat(64)}`],
  ] as const)('rejects a mismatched %s', (key, value) => {
    expect(() =>
      assertValidEvidenceArtifact(
        { ...evidence(), [key]: value },
        metadata,
        syntheticRequirements,
      ),
    ).toThrow(/does not match/u);
  });

  it('rejects unknown and duplicate passed Requirement IDs', () => {
    expect(() =>
      assertValidEvidenceArtifact(
        evidence(['TEST-core', 'UNKNOWN']),
        metadata,
        syntheticRequirements,
      ),
    ).toThrow(/Unknown passed Requirement ID/u);
    expect(() =>
      assertValidEvidenceArtifact(
        evidence(['TEST-core', 'TEST-core']),
        metadata,
        syntheticRequirements,
      ),
    ).toThrow(/Duplicate passed Requirement ID/u);
  });

  it('does not permit a requirement with no named tests to become verified', () => {
    const noTestRequirement: ConformanceRequirement = {
      ...syntheticRequirements[0]!,
      tests: [],
    };
    expect(() =>
      assertValidEvidenceArtifact(
        evidence([noTestRequirement.id]),
        metadata,
        [noTestRequirement],
      ),
    ).toThrow(/has no named tests/u);
  });

  it.each([null, [], 'evidence'])('rejects a non-object artifact: %j', (value) => {
    expect(() => assertValidEvidenceArtifact(value, metadata, syntheticRequirements)).toThrow(
      /must be an object/u,
    );
  });

  it('rejects unknown fields and unsupported schema versions', () => {
    expect(() =>
      assertValidEvidenceArtifact(
        { ...evidence(), runtimePassingTests: [] },
        metadata,
        syntheticRequirements,
      ),
    ).toThrow(/Unknown conformance evidence fields/u);
    expect(() =>
      assertValidEvidenceArtifact(
        { ...evidence(), schemaVersion: 1 },
        metadata,
        syntheticRequirements,
      ),
    ).toThrow(/schemaVersion/u);
  });

  it('validates the passed ID array types', () => {
    expect(() =>
      assertValidEvidenceArtifact(
        { ...evidence(), passedRequirementIds: 'TEST-core' },
        metadata,
        syntheticRequirements,
      ),
    ).toThrow(/must be an array/u);
    expect(() =>
      assertValidEvidenceArtifact(
        { ...evidence(), passedRequirementIds: [1] },
        metadata,
        syntheticRequirements,
      ),
    ).toThrow(/must be strings/u);
  });

  it('rejects fields outside the evidence format', () => {
    expect(() =>
      assertValidEvidenceArtifact(
        { ...evidence(['TEST-core']), sourceRevision: '0123456789abcdef' },
        metadata,
        syntheticRequirements,
      ),
    ).toThrow(/Unknown conformance evidence fields: sourceRevision/u);
  });

  it('rejects malformed runtime probe containers', () => {
    expect(() =>
      evaluateProfileClaimsWithEvidence(
        null as unknown as DeploymentRuntimeProbes,
        evidence(),
        metadata,
        syntheticRequirements,
        profileRequiredEndpoints,
      ),
    ).toThrow(/must be an object/u);
    expect(() =>
      evaluateProfileClaimsWithEvidence(
        { registeredEndpoints: [], availablePorts: [] } as unknown as DeploymentRuntimeProbes,
        evidence(),
        metadata,
        syntheticRequirements,
        profileRequiredEndpoints,
      ),
    ).toThrow(/must be ReadonlySet/u);
  });
});
