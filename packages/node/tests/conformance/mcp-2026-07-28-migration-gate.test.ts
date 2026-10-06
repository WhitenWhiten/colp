import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertProfileClaims,
  bundledConformanceEvidence,
  evaluateProfileClaims,
  runDeploymentConformanceProbes,
  type ConformancePort,
  type DeploymentRuntimeProbes,
} from '../../src/conformance/index.js';
import { profilePorts } from '../../src/conformance/internal.js';
import { endpointContracts, type EndpointKey } from '../../src/semantic/index.js';
import {
  applyMcpEvidenceQuarantine,
  generateVerifiedEvidence,
  isMigratingMcpReleaseProfile,
  mcpAcceptedProtocolVersion,
  mcpMigrationProtocolVersion,
  mcpMigrationQuarantinedProfiles,
  requiredRequirementIdsForProfile,
  requirementsDigest,
  validateMcpMigrationClosedEvidence,
  validateReleaseEvidenceArtifact,
} from '../../scripts/lib/conformance-evidence.mjs';
import { completeDeploymentEvidence, createPassingDeploymentTarget } from './deployment-evidence.js';

type RequirementLevel = 'MUST' | 'MUST_NOT' | 'SHOULD' | 'SHOULD_NOT' | 'MAY';

function requirement(
  id: string,
  profile: string,
  level: RequirementLevel,
  tests: readonly string[] = [`test.${id.toLowerCase()}`],
) {
  return {
    id,
    level,
    profile,
    source: `test/${id}`,
    requirement: `${id} synthetic acceptance requirement`,
    selector: { marker: id },
    implementation: ['test'],
    tests: [...tests],
  };
}

const registry = {
  version: '0.1',
  requirements: [
    requirement('CORE-MUST', 'core', 'MUST'),
    requirement('PUBLICATION-MUST', 'publication', 'MUST'),
    requirement('PUBLISHER-MUST', 'publisher', 'MUST'),
    requirement('FEED-MUST', 'feed', 'MUST'),
    requirement('SYNC-MUST', 'sync', 'MUST'),
    requirement('MCP-READ-MUST', 'mcp-read', 'MUST'),
    requirement('MCP-WRITE-MUST', 'mcp-write', 'MUST'),
  ],
} as const;

const context = {
  protocolVersion: String(registry.version),
  packageVersion: 'mcp-acceptance-test',
  requirementsDigest: requirementsDigest(registry),
  requirements: registry.requirements,
};

const sourceRevision = 'a'.repeat(40);
const allIds = registry.requirements.map((item) => item.id);
const nonMcpIds = allIds.filter((id) => !id.startsWith('MCP-'));

function artifact(passedRequirementIds: readonly string[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    protocolVersion: context.protocolVersion,
    packageVersion: context.packageVersion,
    sourceRevision,
    requirementsDigest: context.requirementsDigest,
    reportDigest: `sha256:${'b'.repeat(64)}`,
    passedRequirementIds: [...passedRequirementIds],
  };
}

function releaseErrors(candidate: unknown, profile: string): readonly string[] {
  return validateReleaseEvidenceArtifact(candidate, context, { profile, sourceRevision });
}

describe('MCP 2026-07-28 acceptance gate (COLP-MCP-15)', () => {
  it('defines the exact modern MCP baseline and the restored mcp-* set', () => {
    expect(mcpMigrationProtocolVersion).toBe('2026-07-28');
    expect(mcpAcceptedProtocolVersion).toBe('2026-07-28');
    expect(mcpMigrationQuarantinedProfiles).toEqual([]);
    expect(isMigratingMcpReleaseProfile('mcp-read')).toBe(false);
    expect(isMigratingMcpReleaseProfile('mcp-write')).toBe(false);
  });

  it.each(['mcp-read', 'mcp-write'] as const)(
    'fails closed when %s release evidence omits MCP Requirement records',
    (profile) => {
      const errors = releaseErrors(artifact(nonMcpIds), profile);
      expect(errors.join('\n')).toMatch(/lacks verified Required/u);
    },
  );

  it.each(['mcp-read', 'mcp-write'] as const)(
    'accepts %s release evidence that carries the complete MCP closure',
    (profile) => {
      expect(releaseErrors(artifact(allIds), profile)).toEqual([]);
    },
  );

  it('rejects mcp-write when only evidence metadata is refreshed without MCP records', () => {
    const refreshedMetadata = {
      ...artifact(nonMcpIds),
      protocolVersion: '0.2',
      packageVersion: '0.1.0',
      requirementsDigest: `sha256:${'c'.repeat(64)}`,
    };
    const closed = validateMcpMigrationClosedEvidence(refreshedMetadata, context, {
      profile: 'mcp-write',
    });
    expect(closed.join('\n')).toMatch(/no MCP-\* Requirement evidence|required to hold/i);
    expect(releaseErrors(refreshedMetadata, 'mcp-write').join('\n')).toMatch(
      /protocolVersion|packageVersion|requirementsDigest/u,
    );
  });

  it.each(['mcp-read', 'mcp-write'] as const)(
    'accepts %s when the artifact carries its MCP Requirement evidence',
    (profile) => {
      expect(validateMcpMigrationClosedEvidence(artifact(allIds), context, { profile })).toEqual([]);
    },
  );

  it.each(['mcp-read', 'mcp-write'] as const)(
    'rejects %s when the artifact carries no MCP Requirement evidence',
    (profile) => {
      const errors = validateMcpMigrationClosedEvidence(artifact(nonMcpIds), context, { profile });
      expect(errors.join('\n')).toMatch(/no MCP-\* Requirement evidence|required to hold/i);
    },
  );

  it('refuses to apply the accepted-state check to a non-MCP profile', () => {
    expect(validateMcpMigrationClosedEvidence(artifact(allIds), context, { profile: 'core' })
      .join('\n')).toMatch(/not an MCP release profile/u);
  });

  it('keeps MCP Requirements registered and never strips MCP evidence', () => {
    expect(requiredRequirementIdsForProfile(registry, 'mcp-read')).toContain('MCP-READ-MUST');
    expect(requiredRequirementIdsForProfile(registry, 'mcp-write')).toContain('MCP-WRITE-MUST');
    expect(applyMcpEvidenceQuarantine(allIds, registry.requirements)).toEqual(allIds);
  });

  it('keeps MCP Requirement IDs when evidence is regenerated from a passing run', async () => {
    const report = {
      success: true,
      testResults: [{
        assertionResults: allIds.map((id) => ({
          fullName: `suite [evidence:test.${id.toLowerCase()}]`,
          status: 'passed',
        })),
      }],
    };
    const generated = await generateVerifiedEvidence({
      registry,
      context,
      sourceRevision,
      repositoryRoot: resolve(import.meta.dirname, '..', '..', '..', '..'),
      runGit: async (arguments_: readonly string[]) => (arguments_[0] === 'rev-parse' ? `${sourceRevision}\n` : ''),
      runTests: async () => JSON.stringify(report),
    });
    expect(generated.passedRequirementIds).toEqual(allIds);
    expect(generated.passedRequirementIds).toContain('MCP-READ-MUST');
    expect(generated.passedRequirementIds).toContain('MCP-WRITE-MUST');
  });

  it('keeps non-MCP release validation intact after acceptance', () => {
    for (const profile of ['core', 'publication', 'publisher', 'feed', 'sync'] as const) {
      expect(releaseErrors(artifact(nonMcpIds), profile), profile).toEqual([]);
    }
  });
});

describe('bundled MCP evidence acceptance (COLP-MCP-15)', () => {
  const completeProbes: DeploymentRuntimeProbes = {
    registeredEndpoints: new Set(Object.keys(endpointContracts) as EndpointKey[]),
    availablePorts: new Set<ConformancePort>(Object.values(profilePorts).flat()),
    deploymentEvidence: completeDeploymentEvidence,
  };

  it('given cooperative adapter observations, assertProfileClaims freezes mcp-read and mcp-write', () => {
    expect(bundledConformanceEvidence.passedRequirementIds.some((id) => id.startsWith('MCP-'))).toBe(true);
    const verified = assertProfileClaims(
      ['core', 'publication', 'publisher', 'mcp-read', 'mcp-write'],
      completeProbes,
    );
    expect(verified).toContain('mcp-read');
    expect(verified).toContain('mcp-write');
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it('keeps every registered Profile claim eligible with complete probes', () => {
    const claims = evaluateProfileClaims(completeProbes);
    expect(claims).toEqual([
      'core',
      'publication',
      'feed',
      'publisher',
      'sync',
      'mcp-read',
      'mcp-write',
    ]);
    for (const profile of ['core', 'publication', 'feed', 'publisher', 'sync', 'mcp-read', 'mcp-write'] as const) {
      expect(claims).toContain(profile);
    }
  });

  it('given cooperative adapter observations, assertProfileClaims freezes an explicit mcp-read request', () => {
    const verified = assertProfileClaims(['core', 'mcp-read'], completeProbes);
    expect(verified).toEqual(['core', 'mcp-read']);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(
      assertProfileClaims(['core', 'publication', 'publisher', 'mcp-read', 'mcp-write'], completeProbes),
    ).toEqual(['core', 'publication', 'publisher', 'mcp-read', 'mcp-write']);
  });

  it('does not let assertProfileClaims freeze Verified claims from an unvalidated HTTP observation', async () => {
    const target = createPassingDeploymentTarget();
    const execute = target.execute;
    target.execute = async (command) => command.kind === 'publication.http-contract'
      ? {
          challenge: command.challenge,
          initialStatus: 200,
          conditionalStatus: 304,
          etag: '"deployment"',
          validated: false,
        }
      : execute(command);

    await expect(runDeploymentConformanceProbes(target, {
      profiles: ['core', 'publication'],
      capabilities: [],
    })).rejects.toThrow(/Publication HTTP contract observation is incomplete/u);

    expect(() => assertProfileClaims(['core', 'publication'], {
      registeredEndpoints: completeProbes.registeredEndpoints,
      availablePorts: completeProbes.availablePorts,
    })).toThrow(/lack complete/u);
  });
});
