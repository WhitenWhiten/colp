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
import { completeDeploymentEvidence, createPassingDeploymentTarget } from './deployment-evidence.js';

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
