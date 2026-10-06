import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/conformance/generated/requirements.json', () => {
  const profiles = ['core', 'publication', 'feed', 'publisher', 'sync', 'mcp-read', 'mcp-write'];
  const requirements = profiles.flatMap((profile) => [
    {
      id: `CORE-0023-${profile}-MUST`,
      level: 'MUST',
      profile,
      source: 'CORE-0023 synthetic registry',
      requirement: `${profile} required behavior`,
      selector: { marker: `${profile}-must` },
      implementation: ['test'],
      tests: [`core-0023.${profile}.must`],
    },
    {
      id: `CORE-0023-${profile}-MUST-NOT`,
      level: 'MUST_NOT',
      profile,
      source: 'CORE-0023 synthetic registry',
      requirement: `${profile} prohibited behavior`,
      selector: { marker: `${profile}-must-not` },
      implementation: ['test'],
      tests: [`core-0023.${profile}.must-not`],
    },
  ]);
  return {
    default: {
      protocolVersion: '0.1',
      packageVersion: 'core-0023-test',
      requirementsDigest: `sha256:${'3'.repeat(64)}`,
      requirements,
    },
  };
});

vi.mock('../../src/conformance/generated/evidence.json', () => {
  const profiles = ['core', 'publication', 'feed', 'publisher', 'sync', 'mcp-read', 'mcp-write'];
  return {
    default: {
      schemaVersion: 1,
      protocolVersion: '0.1',
      packageVersion: 'core-0023-test',
      sourceRevision: '0123456789abcdef',
      requirementsDigest: `sha256:${'3'.repeat(64)}`,
      reportDigest: `sha256:${'4'.repeat(64)}`,
      passedRequirementIds: profiles.flatMap((profile) => [
        `CORE-0023-${profile}-MUST`,
        `CORE-0023-${profile}-MUST-NOT`,
      ]),
    },
  };
});

import {
  assertProfileClaims,
  type ConformancePort,
  type DeploymentRuntimeProbes,
  type VerifiedDeploymentConformanceEvidence,
} from '../../src/conformance/index.js';
import { profilePorts } from '../../src/conformance/internal.js';
import { endpointContracts, type EndpointKey } from '../../src/semantic/index.js';
import {
  completeDeploymentEvidence,
  coreDeploymentEvidence,
  publicationDeploymentEvidence,
} from './deployment-evidence.js';

const completeProbes: DeploymentRuntimeProbes = {
  registeredEndpoints: new Set(Object.keys(endpointContracts) as EndpointKey[]),
  availablePorts: new Set<ConformancePort>(Object.values(profilePorts).flat()),
  deploymentEvidence: completeDeploymentEvidence,
};

function probesWith(
  deploymentEvidence: VerifiedDeploymentConformanceEvidence,
): DeploymentRuntimeProbes {
  return { ...completeProbes, deploymentEvidence };
}

describe('CORE-0023 verified publication boundary [review:core.0023-synthetic-registry]', () => {
  it('returns a frozen non-empty copy of the exact verified request', () => {
    const requested = ['core', 'sync'] as const;
    const verified = assertProfileClaims(requested, completeProbes);

    expect(verified).toEqual(requested);
    expect(verified).not.toBe(requested);
    expect(verified).not.toHaveLength(0);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(() => (verified as unknown as ProtocolProfile[]).push('feed')).toThrow(TypeError);
  });

  it('does not change when caller-owned input mutates after verification', () => {
    const requested: ProtocolProfile[] = ['core'];
    const verified = assertProfileClaims(requested, completeProbes);

    requested.push('sync');
    expect(requested).toEqual(['core', 'sync']);
    expect(verified).toEqual(['core']);
  });

  it('accepts the exact core and publication deployment scope', () => {
    expect(assertProfileClaims(
      ['core', 'publication'],
      probesWith(publicationDeploymentEvidence),
    )).toEqual(['core', 'publication']);
  });

  it('does not use evidence issued for a narrower scope to assert broader claims', () => {
    expect(() => assertProfileClaims(
      ['core', 'publication'],
      probesWith(coreDeploymentEvidence),
    )).toThrow(/lack complete/u);
    expect(() => assertProfileClaims(
      ['core', 'sync'],
      probesWith(publicationDeploymentEvidence),
    )).toThrow(/lack complete/u);
  });

  it('rejects reconstructed and partial evidence at the public assertion boundary', () => {
    for (const evidence of [
      { ...publicationDeploymentEvidence },
      { ...publicationDeploymentEvidence, passedProbeIds: [] },
      { ...publicationDeploymentEvidence, profiles: ['core'] },
    ]) {
      expect(() => assertProfileClaims(
        ['core', 'publication'],
        probesWith(evidence as unknown as VerifiedDeploymentConformanceEvidence),
      )).toThrow(/returned by runDeploymentConformanceProbes/u);
    }
  });
});

type ProtocolProfile = import('../../src/semantic/index.js').ProtocolProfile;
