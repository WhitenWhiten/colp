import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertProfileClaims,
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
  profileOrder,
  profilePorts,
} from '../../src/conformance/internal.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  endpointContracts,
  profileDependencies,
  profileRequiredEndpoints,
  validateManifestSemantics,
  type EndpointKey,
  type ProtocolProfile,
} from '../../src/semantic/index.js';
import { supportedProfiles } from '../../src/index.js';
import type { Manifest } from '../../src/types/index.js';
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

const evidenceIds = [
  'core.profile-claims-profile-order',
  'core.profile-claims-dependency-closure',
  'core.profile-claims-endpoint-gates',
  'core.profile-claims-port-gates',
  'core.profile-claims-required-evidence',
  'core.profile-claims-advisory-levels',
  'core.profile-claims-zero-required-guard',
  'core.profile-claims-evidence-artifact',
  'core.profile-claims-runtime-probes',
  'core.profile-claims-exact-assertion',
  'core.profile-claims-legacy-manifest',
  'core.profile-claims-empty-bundle',
  'core.profile-claims-frozen-registries',
] as const;

const requirements: readonly ConformanceRequirement[] = profiles.flatMap((profile) =>
  (
    [
      ['MUST', 'must'],
      ['MUST_NOT', 'must-not'],
      ['SHOULD', 'should'],
      ['SHOULD_NOT', 'should-not'],
      ['MAY', 'may'],
    ] as const
  ).map(([level, suffix]) => ({
    id: `TEST-${profile}-${suffix}`,
    level,
    profile,
    source: 'CORE-0022 synthetic registry',
    requirement: `${profile} ${level} requirement`,
    selector: { marker: `${profile}-${suffix}` },
    implementation: ['test'],
    tests: [`test.${profile}.${suffix}`],
  })),
);

const metadata = {
  protocolVersion: '0.1',
  packageVersion: 'core-0022-test',
  requirementsDigest: `sha256:${'1'.repeat(64)}`,
} as const;

const allEndpoints = new Set<EndpointKey>(Object.keys(endpointContracts) as EndpointKey[]);
const allPorts = new Set<ConformancePort>(Object.values(profilePorts).flat());
const probes: DeploymentRuntimeProbes = {
  registeredEndpoints: allEndpoints,
  availablePorts: allPorts,
  deploymentEvidence: completeDeploymentEvidence,
};

function artifact(
  passedRequirementIds: readonly string[] = requirements.map((requirement) => requirement.id),
): ConformanceEvidenceArtifact {
  return {
    schemaVersion: 1,
    ...metadata,
    sourceRevision: '0123456789abcdef',
    reportDigest: `sha256:${'2'.repeat(64)}`,
    passedRequirementIds,
  };
}

function claims(
  runtimeProbes: DeploymentRuntimeProbes = probes,
  runtimeEvidence: ConformanceEvidenceArtifact = artifact(),
  registry: readonly ConformanceRequirement[] = requirements,
): readonly ProtocolProfile[] {
  return evaluateProfileClaimsWithEvidence(
    runtimeProbes,
    runtimeEvidence,
    metadata,
    registry,
    profileRequiredEndpoints,
  );
}

function requiredIds(registry = requirements): readonly string[] {
  return registry
    .filter((requirement) => requirement.level === 'MUST' || requirement.level === 'MUST_NOT')
    .map((requirement) => requirement.id);
}

async function manifestFixture(): Promise<Manifest> {
  const path = resolve(
    import.meta.dirname,
    '..',
    '..',
    'fixtures',
    'protocol',
    'examples',
    'public-manifest.json',
  );
  return JSON.parse(await readFile(path, 'utf8')) as Manifest;
}

const closureCases = [
  ['core', ['core']],
  ['publication', ['core', 'publication']],
  ['feed', ['core', 'publication', 'feed']],
  ['publisher', ['core', 'publication', 'publisher']],
  ['sync', ['core', 'sync']],
  ['mcp-read', ['core', 'mcp-read']],
  ['mcp-write', ['core', 'publication', 'publisher', 'mcp-read', 'mcp-write']],
] as const satisfies readonly (readonly [ProtocolProfile, readonly ProtocolProfile[]])[];

const endpointCases = profiles.flatMap((target) =>
  [...profileDependencyClosure(target)].flatMap((dependency) =>
    profileRequiredEndpoints[dependency].map((endpoint) => ({ target, dependency, endpoint })),
  ),
);
const portCases = profiles.flatMap((target) =>
  [...profileDependencyClosure(target)].flatMap((dependency) =>
    profilePorts[dependency].map((port) => ({ target, dependency, port })),
  ),
);
const requiredEvidenceCases = profiles.flatMap((target) => {
  const closure = profileDependencyClosure(target);
  return requirements
    .filter(
      (requirement) =>
        closure.has(requirement.profile) &&
        (requirement.level === 'MUST' || requirement.level === 'MUST_NOT'),
    )
    .map((requirement) => ({ target, requirement }));
});

describe('CORE-0022 profile eligibility', () => {
  it('returns every eligible profile in deterministic order [evidence:core.profile-claims-profile-order]', () => {
    expect(claims()).toEqual(profiles);
    expect(profileOrder).toEqual(profiles);
  });

  it('uses the complete mcp-write dependency closure [evidence:core.profile-claims-dependency-closure]', () => {
    expect([...profileDependencyClosure('mcp-write')].sort()).toEqual([
      'core',
      'mcp-read',
      'mcp-write',
      'publication',
      'publisher',
    ]);
  });

  it.each(closureCases)('computes the complete dependency closure for %s', (profile, expected) => {
    expect([...profileDependencyClosure(profile)].sort()).toEqual([...expected].sort());
  });

  it('expands every required endpoint into an independent gate [evidence:core.profile-claims-endpoint-gates]', () => {
    expect(endpointCases).toHaveLength(49);
    expect(new Set(endpointCases.map(({ endpoint }) => endpoint))).toEqual(
      new Set(Object.values(profileRequiredEndpoints).flat()),
    );
  });

  it.each(endpointCases)(
    'blocks $target when closure endpoint $endpoint from $dependency is absent',
    ({ target, endpoint }) => {
      const registeredEndpoints = new Set(allEndpoints);
      registeredEndpoints.delete(endpoint);
      expect(claims({ ...probes, registeredEndpoints })).not.toContain(target);
    },
  );

  it('expands every required runtime port into an independent gate [evidence:core.profile-claims-port-gates]', () => {
    expect(portCases).toHaveLength(39);
    expect(new Set(portCases.map(({ port }) => port))).toEqual(allPorts);
  });

  it.each(portCases)(
    'blocks $target when closure port $port from $dependency is absent',
    ({ target, port }) => {
      const availablePorts = new Set(allPorts);
      availablePorts.delete(port);
      expect(claims({ ...probes, availablePorts })).not.toContain(target);
    },
  );

  it('expands every test-backed MUST and MUST_NOT into an independent gate [evidence:core.profile-claims-required-evidence]', () => {
    expect(requiredEvidenceCases).toHaveLength(36);
    expect(new Set(requiredEvidenceCases.map(({ requirement }) => requirement.level))).toEqual(
      new Set(['MUST', 'MUST_NOT']),
    );
  });

  it.each(requiredEvidenceCases)(
    'blocks $target when $requirement.id evidence is absent',
    ({ target, requirement }) => {
      const passed = requirements
        .filter((candidate) => candidate.id !== requirement.id)
        .map((candidate) => candidate.id);
      expect(claims(probes, artifact(passed))).not.toContain(target);
    },
  );

  it('does not gate on SHOULD, SHOULD_NOT, or MAY [evidence:core.profile-claims-advisory-levels]', () => {
    expect(claims(probes, artifact(requiredIds()))).toEqual(profiles);
  });

  it('blocks an empty required set [evidence:core.profile-claims-zero-required-guard]', () => {
    const registry = requirements.filter((requirement) => requirement.profile !== 'core');
    expect(claims(probes, artifact(requiredIds(registry)), registry)).toEqual([]);
  });

  it.each(profiles)('blocks %s when its own required set is empty', (profile) => {
    const registry = requirements.filter((requirement) => requirement.profile !== profile);
    expect(claims(probes, artifact(requiredIds(registry)), registry)).not.toContain(profile);
  });
});

describe('CORE-0022 evidence and runtime input validation', () => {
  const invalidEvidenceCases: readonly (readonly [string, object, RegExp])[] = [
    ['protocol version', { ...artifact(), protocolVersion: '0.2' }, /protocolVersion/u],
    ['package version', { ...artifact(), packageVersion: 'stale' }, /packageVersion/u],
    [
      'requirements digest',
      { ...artifact(), requirementsDigest: `sha256:${'9'.repeat(64)}` },
      /requirementsDigest/u,
    ],
    ['source revision', { ...artifact(), sourceRevision: 'working-tree' }, /hexadecimal/u],
    ['missing report digest', { ...artifact(), reportDigest: undefined }, /reportDigest/u],
    ['malformed report digest', { ...artifact(), reportDigest: 'sha256:nope' }, /reportDigest/u],
    ['unknown field', { ...artifact(), passingTests: [] }, /Unknown conformance/u],
    ['unknown requirement', artifact(['TEST-core-must', 'UNKNOWN']), /Unknown passed/u],
    [
      'duplicate requirement',
      artifact(['TEST-core-must', 'TEST-core-must']),
      /Duplicate passed/u,
    ],
  ];

  it('binds verified evidence to package, protocol, registry, source, and report [evidence:core.profile-claims-evidence-artifact]', () => {
    expect(() => assertValidEvidenceArtifact(artifact(), metadata, requirements)).not.toThrow();
  });

  it.each(invalidEvidenceCases)('rejects invalid evidence: %s', (_label, value, error) => {
    expect(() => assertValidEvidenceArtifact(value, metadata, requirements)).toThrow(error);
  });

  it('rejects evidence for a requirement without named tests', () => {
    const noTestRequirement: ConformanceRequirement = { ...requirements[0]!, tests: [] };
    expect(() =>
      assertValidEvidenceArtifact(artifact([noTestRequirement.id]), metadata, [noTestRequirement]),
    ).toThrow(/has no named tests/u);
  });

  it('requires actual Sets with known members [evidence:core.profile-claims-runtime-probes]', () => {
    expect(() => claims()).not.toThrow();
    expect(() =>
      claims({ registeredEndpoints: new Set(['unknown' as EndpointKey]), availablePorts: allPorts }),
    ).toThrow(/Unknown registered endpoint/u);
    expect(() =>
      claims({ registeredEndpoints: allEndpoints, availablePorts: new Set(['unknown' as ConformancePort]) }),
    ).toThrow(/Unknown runtime port/u);
  });

  it.each([
    { registeredEndpoints: [], availablePorts: [] },
    { registeredEndpoints: new Proxy(new Set(), {}), availablePorts: new Set() },
    {
      registeredEndpoints: { has: () => true, [Symbol.iterator]: function* () {} },
      availablePorts: new Set(),
    },
  ])('rejects a non-Set probe container', (runtimeProbes) => {
    expect(() => claims(runtimeProbes as unknown as DeploymentRuntimeProbes)).toThrow(/actual Set/u);
  });

  it('uses intrinsic Set iteration and membership', () => {
    class HostileSet<Value> extends Set<Value> {
      override has(): boolean {
        return true;
      }

      override [Symbol.iterator](): SetIterator<Value> {
        return new Set<Value>().values();
      }
    }
    const registeredEndpoints = new HostileSet<EndpointKey>(['directory']);
    expect(
      claims({ registeredEndpoints, availablePorts: allPorts }),
    ).not.toContain('publication');
    registeredEndpoints.add('unknown' as EndpointKey);
    expect(() => claims({ registeredEndpoints, availablePorts: allPorts })).toThrow(
      /Unknown registered endpoint/u,
    );
  });
});

describe('CORE-0022 exact Manifest claims', () => {
  it('rejects claims outside bundled eligibility [evidence:core.profile-claims-exact-assertion]', () => {
    expect(() => assertProfileClaims(
      ['core'],
      { registeredEndpoints: new Set(), availablePorts: new Set() },
    )).toThrow(/lack complete/u);
  });

  it.each([
    ['empty', [], /must not be empty/u],
    ['duplicate', ['core', 'core'], /Duplicate/u],
    ['unknown', ['core', 'future'], /Unknown or legacy/u],
    ['legacy reader', ['core', 'reader'], /Unknown or legacy/u],
    ['legacy sync-server', ['core', 'sync-server'], /Unknown or legacy/u],
    ['legacy mcp-server', ['core', 'mcp-server'], /Unknown or legacy/u],
    ['missing direct dependency', ['core', 'mcp-write'], /requires profile mcp-read/u],
    [
      'missing transitive dependency',
      ['core', 'mcp-read', 'publisher', 'mcp-write'],
      /requires profile publication/u,
    ],
  ] as const)('rejects %s exact claims', (_label, requested, error) => {
    expect(() =>
      assertProfileClaims(requested as unknown as readonly ProtocolProfile[], probes),
    ).toThrow(error);
  });

  it('rejects a non-array exact claim list', () => {
    expect(() =>
      assertProfileClaims('core' as unknown as readonly ProtocolProfile[], probes),
    ).toThrow(/must be an array/u);
  });
});

describe('CORE-0022 Manifest legacy names', () => {
  it('rejects legacy names structurally and semantically [evidence:core.profile-claims-legacy-manifest]', async () => {
    const manifest = await manifestFixture();
    (manifest.mounts[0]!.profiles as unknown[]).push('reader');
    expect(createValidatorRegistry().validate('manifest', manifest).valid).toBe(false);
    expect(validateManifestSemantics(manifest)).toMatchObject({ valid: false });
  });

  it.each(['reader', 'sync-server', 'mcp-server'] as const)(
    'reports invalid_profile without crashing for %s',
    async (legacyProfile) => {
      const manifest = await manifestFixture();
      (manifest.mounts[0]!.profiles as unknown[]).push(legacyProfile);
      expect(createValidatorRegistry().validate('manifest', manifest).valid).toBe(false);
      expect(validateManifestSemantics(manifest)).toEqual({
        valid: false,
        issues: [
          {
            code: 'invalid_profile',
            path: `/mounts/0/profiles/${manifest.mounts[0]!.profiles.length - 1}`,
            message: `Profile ${legacyProfile} is not valid in a Manifest.`,
          },
        ],
      });
    },
  );
});

describe('CORE-0022 generated and exported contracts', () => {
  it('ships a bound evidence artifact and an exact public profile set [evidence:core.profile-claims-empty-bundle]', () => {
    expect(bundledConformanceEvidence.passedRequirementIds).toBeInstanceOf(Array);
    expect(evaluateProfileClaims({ registeredEndpoints: allEndpoints, availablePorts: allPorts })).toEqual([]);
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

  it('freezes the dependency and endpoint registries [evidence:core.profile-claims-frozen-registries]', () => {
    expect(Object.isFrozen(profileDependencies)).toBe(true);
    expect(Object.values(profileDependencies).every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(profileRequiredEndpoints)).toBe(true);
    expect(Object.values(profileRequiredEndpoints).every(Object.isFrozen)).toBe(true);
    expect(profileDependencies).toEqual({
      core: [],
      publication: ['core'],
      feed: ['publication'],
      publisher: ['publication'],
      sync: ['core'],
      'mcp-read': ['core'],
      'mcp-write': ['mcp-read', 'publisher'],
    });
  });

  it('registers only the CORE-0022 implementation and evidence tests', () => {
    const core0022 = conformanceRequirements.find((requirement) => requirement.id === 'CORE-0022');
    expect(core0022).toMatchObject({
      level: 'MUST',
      profile: 'core',
      source: 'SPECIFICATION.md#colp-section-11',
    });
    expect(core0022?.tests).toEqual(evidenceIds);
  });
});
