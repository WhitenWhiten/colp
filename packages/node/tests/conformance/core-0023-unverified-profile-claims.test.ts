import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  assertProfileClaims,
  bundledConformanceEvidence,
  conformanceRequirements,
  evaluateProfileClaims,
  type ConformanceEvidenceArtifact,
  type ConformancePort,
  type ConformanceRequirement,
  type DeploymentRuntimeProbes,
  type VerifiedProfileClaims,
} from '../../src/conformance/index.js';
import {
  evaluateProfileClaimsWithEvidence,
  profileDependencyClosure,
  profilePorts,
} from '../../src/conformance/internal.js';
import { supportedProfiles } from '../../src/index.js';
import {
  endpointContracts,
  profileRequiredEndpoints,
  type EndpointKey,
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

const requirements: readonly ConformanceRequirement[] = profiles.flatMap((profile) => [
  {
    id: `CORE-0023-${profile}-MUST`,
    level: 'MUST',
    profile,
    source: 'CORE-0023 synthetic registry',
    requirement: `${profile} required behavior`,
    implementation: ['test'],
    tests: [`core-0023.${profile}.must`],
  },
  {
    id: `CORE-0023-${profile}-MUST-NOT`,
    level: 'MUST_NOT',
    profile,
    source: 'CORE-0023 synthetic registry',
    requirement: `${profile} prohibited behavior`,
    implementation: ['test'],
    tests: [`core-0023.${profile}.must-not`],
  },
]);

const metadata = {
  protocolVersion: '0.1',
  packageVersion: 'core-0023-test',
  requirementsDigest: `sha256:${'3'.repeat(64)}`,
} as const;

const allEndpoints = new Set<EndpointKey>(Object.keys(endpointContracts) as EndpointKey[]);
const allPorts = new Set<ConformancePort>(Object.values(profilePorts).flat());
const completeProbes: DeploymentRuntimeProbes = {
  registeredEndpoints: allEndpoints,
  availablePorts: allPorts,
  deploymentEvidence: completeDeploymentEvidence,
};

function artifact(
  passedRequirementIds: readonly string[] = requirements.map(({ id }) => id),
): ConformanceEvidenceArtifact {
  return {
    schemaVersion: 2,
    ...metadata,
    passedRequirementIds,
  };
}

function eligible(
  probes: DeploymentRuntimeProbes = completeProbes,
  evidence: ConformanceEvidenceArtifact = artifact(),
  registry: readonly ConformanceRequirement[] = requirements,
): readonly ProtocolProfile[] {
  return evaluateProfileClaimsWithEvidence(
    probes,
    evidence,
    metadata,
    registry,
    profileRequiredEndpoints,
  );
}

const endpointOmissionCases = profiles.flatMap((target) =>
  [...profileDependencyClosure(target)].flatMap((dependency) =>
    profileRequiredEndpoints[dependency].map((endpoint) => ({ target, dependency, endpoint })),
  ),
);

const portOmissionCases = profiles.flatMap((target) =>
  [...profileDependencyClosure(target)].flatMap((dependency) =>
    profilePorts[dependency].map((port) => ({ target, dependency, port })),
  ),
);

const requiredEvidenceOmissionCases = profiles.flatMap((target) => {
  const closure = profileDependencyClosure(target);
  return requirements
    .filter(({ level, profile }) =>
      closure.has(profile) && (level === 'MUST' || level === 'MUST_NOT'),
    )
    .map((requirement) => ({ target, requirement }));
});

const missingDependencyCases = [
  ['publication without core', ['publication'], /requires profile core/u],
  ['feed without publication', ['core', 'feed'], /requires profile publication/u],
  [
    'mcp-write without mcp-read',
    ['core', 'publication', 'publisher', 'mcp-write'],
    /requires profile mcp-read/u,
  ],
  [
    'mcp-write without publisher',
    ['core', 'mcp-read', 'mcp-write'],
    /requires profile publisher/u,
  ],
] as const;

describe('CORE-0023 unverified Profile claims are prohibited [evidence:core.unverified-profile-claim-prohibited]', () => {
  it('covers every expanded claim gate', () => {
    expect(profiles).toHaveLength(7);
    expect(requirements).toHaveLength(14);
    expect(endpointOmissionCases).toHaveLength(49);
    expect(portOmissionCases).toHaveLength(39);
    expect(requiredEvidenceOmissionCases).toHaveLength(36);
    expect(missingDependencyCases).toHaveLength(4);
    expect(
      new Set(requiredEvidenceOmissionCases.map(({ requirement }) => requirement.level)),
    ).toEqual(new Set(['MUST', 'MUST_NOT']));
  });

  it('accepts synthetic fully verified evidence only through the internal evaluator', () => {
    expect(eligible()).toEqual(profiles);
  });

  it.each(endpointOmissionCases)(
    'does not claim $target when required endpoint $endpoint from $dependency is missing',
    ({ target, endpoint }) => {
      const registeredEndpoints = new Set(allEndpoints);
      registeredEndpoints.delete(endpoint);
      expect(eligible({ ...completeProbes, registeredEndpoints })).not.toContain(target);
    },
  );

  it.each(portOmissionCases)(
    'does not claim $target when required port $port from $dependency is missing',
    ({ target, port }) => {
      const availablePorts = new Set(allPorts);
      availablePorts.delete(port);
      expect(eligible({ ...completeProbes, availablePorts })).not.toContain(target);
    },
  );

  it.each(requiredEvidenceOmissionCases)(
    'does not claim $target when $requirement.level evidence $requirement.id is missing',
    ({ target, requirement }) => {
      const passedIds = requirements
        .filter(({ id }) => id !== requirement.id)
        .map(({ id }) => id);
      expect(eligible(completeProbes, artifact(passedIds))).not.toContain(target);
    },
  );

  it('does not infer partial or highest-profile marketing claims', () => {
    const publicationMust = requirements.find(
      ({ profile, level }) => profile === 'publication' && level === 'MUST',
    )!;
    const passedIds = requirements
      .filter(({ id }) => id !== publicationMust.id)
      .map(({ id }) => id);

    expect(eligible(completeProbes, artifact(passedIds))).toEqual(['core', 'sync', 'mcp-read']);
    expect(eligible(completeProbes, artifact(passedIds))).not.toEqual(['core', 'publication']);
    expect(eligible(completeProbes, artifact(passedIds))).not.toContain('mcp-write');
  });
});

describe('CORE-0023 rejects invalid proof artifacts [evidence:core.unverified-profile-claim-prohibited]', () => {
  const invalidEvidenceCases = [
    ['stale package', { ...artifact(), packageVersion: 'stale' }, /packageVersion/u],
    ['wrong protocol', { ...artifact(), protocolVersion: '9.9' }, /protocolVersion/u],
    [
      'wrong registry digest',
      { ...artifact(), requirementsDigest: `sha256:${'9'.repeat(64)}` },
      /requirementsDigest/u,
    ],
    ['retired source binding', { ...artifact(), sourceRevision: 'not-a-revision' }, /Unknown conformance evidence fields/u],
    ['unknown evidence', artifact(['CORE-0023-UNKNOWN']), /Unknown passed Requirement ID/u],
    [
      'duplicate evidence IDs',
      artifact([requirements[0]!.id, requirements[0]!.id]),
      /Duplicate passed Requirement ID/u,
    ],
    [
      'non-string evidence ID',
      artifact([23 as unknown as string]),
      /Passed Requirement IDs must be strings/u,
    ],
    [
      'non-array evidence list',
      { ...artifact(), passedRequirementIds: 'CORE-0023-core-MUST' },
      /passedRequirementIds must be an array/u,
    ],
  ] as const;

  it('keeps the invalid-proof matrix explicit and static', () => {
    expect(invalidEvidenceCases).toHaveLength(8);
  });

  it.each(invalidEvidenceCases)('rejects %s evidence', (_label, evidence, error) => {
    expect(() =>
      eligible(completeProbes, evidence as unknown as ConformanceEvidenceArtifact),
    ).toThrow(error);
  });

  it('rejects evidence attached to a requirement with no named Conformance Test', () => {
    const noTestRequirement: ConformanceRequirement = {
      ...requirements[0]!,
      tests: [],
    };
    expect(() =>
      eligible(completeProbes, artifact([noTestRequirement.id]), [noTestRequirement]),
    ).toThrow(/has no named tests/u);
  });
});

describe('CORE-0023 public claim boundary remains guarded [evidence:core.unverified-profile-claim-prohibited]', () => {
  const incompleteClaimError =
    /lack complete endpoint, port, deployment-probe, or MUST\/MUST_NOT evidence: core/u;

  it('requires deployment evidence for runtime Manifest claims', () => {
    expect(bundledConformanceEvidence.passedRequirementIds).toContain('CORE-0023');
    const incompleteProbes = { registeredEndpoints: new Set<EndpointKey>(), availablePorts: new Set<ConformancePort>() };
    expect(evaluateProfileClaims(incompleteProbes)).toEqual([]);
    expect(() => assertProfileClaims(['core'], incompleteProbes)).toThrow(incompleteClaimError);
  });

  it('rejects a core Manifest claim when a required runtime port is missing', () => {
    const availablePorts = new Set(allPorts);
    availablePorts.delete('schema');
    expect(evaluateProfileClaims({ ...completeProbes, availablePorts })).not.toContain('core');
    expect(() => assertProfileClaims(['core'], { ...completeProbes, availablePorts })).toThrow(
      incompleteClaimError,
    );
  });

  it('does not treat core as eligible when a bundled MUST id is absent from evidence', () => {
    expect(evaluateProfileClaims(completeProbes)).toContain('core');
    const passed = new Set(bundledConformanceEvidence.passedRequirementIds);
    const coreMust = conformanceRequirements.find(
      ({ profile, level, id }) => profile === 'core' && level === 'MUST' && passed.has(id),
    );
    expect(coreMust).toEqual(expect.objectContaining({ level: 'MUST', profile: 'core' }));
    const passedRequirementIds = bundledConformanceEvidence.passedRequirementIds.filter(
      (id) => id !== coreMust!.id,
    );
    expect(
      evaluateProfileClaimsWithEvidence(
        completeProbes,
        { ...bundledConformanceEvidence, passedRequirementIds },
        {
          protocolVersion: bundledConformanceEvidence.protocolVersion,
          packageVersion: bundledConformanceEvidence.packageVersion,
          requirementsDigest: bundledConformanceEvidence.requirementsDigest,
        },
        conformanceRequirements,
        profileRequiredEndpoints,
      ),
    ).not.toContain('core');
  });

  const invalidRequestedSetCases = [
    ['empty', [], /must not be empty/u],
    ['duplicate', ['core', 'core'], /Duplicate Manifest profile/u],
    ['unknown', ['core', 'future'], /Unknown or legacy Manifest profile/u],
    ['legacy reader', ['core', 'reader'], /Unknown or legacy Manifest profile/u],
    ['legacy sync-server', ['core', 'sync-server'], /Unknown or legacy Manifest profile/u],
    ['legacy mcp-server', ['core', 'mcp-server'], /Unknown or legacy Manifest profile/u],
    ['non-string member', ['core', 23], /Unknown or legacy Manifest profile/u],
    ['null member', ['core', null], /Unknown or legacy Manifest profile/u],
  ] as const;

  it('keeps every invalid requested-set category explicit and static', () => {
    expect(invalidRequestedSetCases).toHaveLength(8);
  });

  it.each(invalidRequestedSetCases)('rejects a %s requested set', (_label, requested, error) => {
    expect(() =>
      assertProfileClaims(requested as unknown as readonly ProtocolProfile[], completeProbes),
    ).toThrow(error);
  });

  it.each([
    ['string', 'core'],
    ['Set', new Set(['core'])],
    ['object', { 0: 'core', length: 1 }],
  ])('rejects a non-array %s requested-profile container', (_label, requested) => {
    expect(() =>
      assertProfileClaims(requested as unknown as readonly ProtocolProfile[], completeProbes),
    ).toThrow(/must be an array/u);
  });

  it.each(missingDependencyCases)(
    'rejects a missing dependency claim: %s',
    (_label, requested, error) => {
      expect(() => assertProfileClaims(requested, completeProbes)).toThrow(error);
    },
  );

  it('keeps public supportedProfiles restricted to the verified set', () => {
    expect(supportedProfiles).toEqual([
      'core',
      'publication',
      'publisher',
      'feed',
      'sync',
      'mcp-read',
      'mcp-write',
    ]);
  });

  it('distinguishes diagnostic eligibility from verified publication claims at compile time', () => {
    expectTypeOf(evaluateProfileClaims).returns.not.toMatchTypeOf<VerifiedProfileClaims>();
    expectTypeOf(assertProfileClaims).returns.toEqualTypeOf<VerifiedProfileClaims>();
  });
});
