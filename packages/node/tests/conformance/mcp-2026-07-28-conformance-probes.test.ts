import { describe, expect, it, vi } from 'vitest';

import {
  createDeploymentConformancePlan,
  deploymentConformanceProbeIds,
  profileDeploymentConformanceProbes,
  runDeploymentConformanceProbe,
  runDeploymentConformanceProbes,
  type DeploymentConformanceProbeId,
  type DeploymentConformanceScope,
  type DeploymentConformanceTarget,
} from '../../src/conformance/index.js';
import {
  createVersionedMcpEvidenceBinding,
  legacyMcpConformanceProbeIds,
  mcpConformanceProbeFamilies,
} from '../../src/conformance/mcp-conformance.js';
import { createPassingDeploymentTarget } from './deployment-evidence.js';

const packageVersion = '1.2.3';
const requirementsDigest = `sha256:${'b'.repeat(64)}`;

const readFamilies = [
  'mcp-2026-07-28.transport-header-contracts',
  'mcp-2026-07-28.discovery-contracts',
  'mcp-2026-07-28.subscription-contracts',
  'mcp-2026-07-28.read-schema-contracts',
  'mcp-2026-07-28.oauth-client-contracts',
] as const;

const mcpScope = (profiles: readonly string[]): DeploymentConformanceScope => ({
  profiles: profiles as DeploymentConformanceScope['profiles'],
  capabilities: [],
  mcpConformance: { packageVersion, requirementsDigest },
});


describe('MCP 2026-07-28 deployment probe families (COLP-MCP-14)', () => {
  it('replaces the generic Read/Write probes with six fixed versioned families', () => {
    for (const family of mcpConformanceProbeFamilies) {
      expect(deploymentConformanceProbeIds, family).toContain(family);
    }
    for (const legacy of legacyMcpConformanceProbeIds) {
      expect(deploymentConformanceProbeIds, legacy).not.toContain(legacy);
    }
    expect(profileDeploymentConformanceProbes['mcp-read']).toEqual([...readFamilies]);
    expect(profileDeploymentConformanceProbes['mcp-write']).toEqual([
      'mcp-2026-07-28.write-mrtr-contracts',
    ]);
  });

  it('plans the exact versioned family set for each MCP Profile closure', () => {
    const readPlan = createDeploymentConformancePlan({
      profiles: ['core', 'mcp-read'],
      capabilities: [],
    });
    expect(readPlan.probeIds).toEqual([...readFamilies]);

    const writePlan = createDeploymentConformancePlan({
      profiles: ['core', 'publication', 'publisher', 'mcp-read', 'mcp-write'],
      capabilities: [],
    });
    expect(new Set(writePlan.probeIds)).toEqual(new Set([
      // publisher contributes ordinary and managed bookmark write capabilities,
      // so its dependency closure adds these core capability probes.
      'core.id-ledger-persistence',
      'core.pre-write-validation',
      'core.parent-cycle-transaction',
      'core.node-subtree-transaction',
      'core.managed-bookmarks-transaction',
      'publication.http-contracts',
      'publisher.transaction-contracts',
      ...mcpConformanceProbeFamilies,
    ]));
    expect(writePlan.probeIds).toContain('mcp-2026-07-28.write-mrtr-contracts');
    expect(writePlan.probeIds).not.toContain('mcp-read.transport-contracts');
    expect(writePlan.probeIds).not.toContain('mcp-write.approval-contracts');
  });

  it('runs every versioned family probe against a passing deployment', async () => {
    for (const family of mcpConformanceProbeFamilies) {
      await expect(
        runDeploymentConformanceProbe(createPassingDeploymentTarget(), family),
        family,
      ).resolves.toBeUndefined();
    }
  });

  it('issues MCP target evidence with the exact versioned source binding', async () => {
    const evidence = await runDeploymentConformanceProbes(
      createPassingDeploymentTarget(),
      mcpScope(['core', 'mcp-read']),
    );
    expect(evidence.profiles).toEqual(['core', 'mcp-read']);
    expect(evidence.passedProbeIds).toEqual([...readFamilies]);
    expect(evidence.mcpBinding).toMatchObject({
      schemaVersion: 1,
      mcpVersion: '2026-07-28',
      packageVersion,
      sdkLock: {
        '@modelcontextprotocol/core': '2.3.1',
        '@modelcontextprotocol/client': '2.3.1',
        '@modelcontextprotocol/server': '2.3.1',
      },
      fixtureTopologyDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      requirementsDigest,
      probeFamilyIds: [...readFamilies],
    });
    expect(evidence.mcpBinding?.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.mcpBinding)).toBe(true);
  });

  it('fails closed when an MCP scope omits the mcpConformance binding', async () => {
    const target = createPassingDeploymentTarget();
    const execute = vi.spyOn(target, 'execute');
    const restart = vi.spyOn(target, 'restart');
    const readDiagnostics = vi.spyOn(target, 'readDiagnostics');
    await expect(runDeploymentConformanceProbes(
      target,
      { profiles: ['core', 'mcp-read'], capabilities: [] },
    )).rejects.toThrow(/mcpConformance/u);
    expect(execute).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(readDiagnostics).not.toHaveBeenCalled();
  });

  it('keeps the preflight MCP binding when caller state changes during probe I/O', async () => {
    const mcpConformance = { packageVersion, requirementsDigest };
    const target = createPassingDeploymentTarget();
    const execute = target.execute.bind(target);
    target.execute = async (command) => {
      mcpConformance.packageVersion = '9.9.9';
      mcpConformance.requirementsDigest = `sha256:${'e'.repeat(64)}`;
      return execute(command);
    };
    const evidence = await runDeploymentConformanceProbes(target, {
      profiles: ['core', 'mcp-read'], capabilities: [], mcpConformance,
    });
    expect(evidence.mcpBinding).toMatchObject({ packageVersion: '1.2.3', requirementsDigest: `sha256:${'b'.repeat(64)}` });
  });

  it.each([
    ['empty package version', { packageVersion: '' }, /packageVersion/u],
    ['non-string package version', { packageVersion: 1 }, /packageVersion/u],
    ['malformed requirements digest', { requirementsDigest: 'nope' }, /requirementsDigest/u],
    ['extra mcpConformance member', { extra: true }, /only packageVersion and requirementsDigest/u],
  ] as const)('rejects a malformed %s in the MCP deployment scope', async (_label, partial, expected) => {
    await expect(runDeploymentConformanceProbes(
      createPassingDeploymentTarget(),
      {
        profiles: ['core', 'mcp-read'],
        capabilities: [],
        mcpConformance: { packageVersion, requirementsDigest, ...partial } as never,
      },
    )).rejects.toThrow(expected);
  });

  it.each(legacyMcpConformanceProbeIds as unknown as readonly DeploymentConformanceProbeId[])(
    'rejects the legacy unversioned probe %s as rejected migration input',
    async (legacy) => {
      await expect(runDeploymentConformanceProbe(
        createPassingDeploymentTarget(),
        legacy,
      )).rejects.toThrow(/rejected migration input|legacy/i);
    },
  );

  it('rejects an unknown probe ID at the runner', async () => {
    await expect(runDeploymentConformanceProbe(
      createPassingDeploymentTarget(),
      'mcp-2026-07-28.future-family' as DeploymentConformanceProbeId,
    )).rejects.toThrow(/Unknown deployment conformance probe/u);
  });
});

describe('MCP 2026-07-28 family probe fault injection (COLP-MCP-14)', () => {
  it('rejects a deployment that mishandles the Base64 header codec', async () => {
    const wrongCodec = createPassingDeploymentTarget();
    const execute = wrongCodec.execute;
    wrongCodec.execute = async (command) => {
      const result = await execute(command) as Record<string, unknown>;
      return command.kind === 'mcp-2026-07-28.transport-header-contract'
        ? { ...result, codec: 'plain', decoded: null }
        : result;
    };
    await expect(runDeploymentConformanceProbe(
      wrongCodec,
      'mcp-2026-07-28.transport-header-contracts',
    )).rejects.toThrow(/codec|decoded|transport-header/i);

    const acceptsConflicts = createPassingDeploymentTarget();
    const conflictsExecute = acceptsConflicts.execute;
    acceptsConflicts.execute = async (command) => {
      const result = await conflictsExecute(command) as Record<string, unknown>;
      const isConflicting = command.kind === 'mcp-2026-07-28.transport-header-contract'
        && new Set(command.headers
          .filter((header) => header.name === 'Mcp-Method')
          .map((header) => header.value)).size > 1;
      return isConflicting ? { ...result, accepted: true, unique: false } : result;
    };
    await expect(runDeploymentConformanceProbe(
      acceptsConflicts,
      'mcp-2026-07-28.transport-header-contracts',
    )).rejects.toThrow(/conflicting|cardinality|accepted/i);
  });

  it('rejects a deployment that discovers a stale protocol version', async () => {
    const stale = createPassingDeploymentTarget();
    const execute = stale.execute;
    stale.execute = async (command) => {
      const result = await execute(command) as Record<string, unknown>;
      return command.kind === 'mcp-2026-07-28.discovery-contract'
        ? { ...result, protocolVersion: '2025-11-25' }
        : result;
    };
    await expect(runDeploymentConformanceProbe(
      stale,
      'mcp-2026-07-28.discovery-contracts',
    )).rejects.toThrow(/2026-07-28|protocolVersion/u);
  });

  it('rejects a deployment that routes misrouted subscription notifications', async () => {
    const misrouted = createPassingDeploymentTarget();
    const execute = misrouted.execute;
    misrouted.execute = async (command) => {
      const result = await execute(command) as Record<string, unknown>;
      return command.kind === 'mcp-2026-07-28.subscription-contract'
        ? { ...result, notificationRouted: true, bodyCarried: true }
        : result;
    };
    await expect(runDeploymentConformanceProbe(
      misrouted,
      'mcp-2026-07-28.subscription-contracts',
    )).rejects.toThrow(/notificationRouted|bodyCarried|subscription/i);
  });

  it('rejects a deployment that accepts a Schema bomb beyond the budget', async () => {
    const acceptingBomb = createPassingDeploymentTarget();
    const execute = acceptingBomb.execute;
    acceptingBomb.execute = async (command) => {
      const result = await execute(command) as Record<string, unknown>;
      return command.kind === 'mcp-2026-07-28.read-schema-contract'
        ? { ...result, accepted: true, refsResolved: true }
        : result;
    };
    await expect(runDeploymentConformanceProbe(
      acceptingBomb,
      'mcp-2026-07-28.read-schema-contracts',
    )).rejects.toThrow(/accepted|budget|schema/i);
  });

  it('rejects a deployment whose MRTR input_required result is unbound', async () => {
    const unbound = createPassingDeploymentTarget();
    const execute = unbound.execute;
    unbound.execute = async (command) => {
      const result = await execute(command) as Record<string, unknown>;
      return command.kind === 'mcp-2026-07-28.write-mrtr-contract'
        ? { ...result, requestState: null, serverInitiated: true }
        : result;
    };
    await expect(runDeploymentConformanceProbe(
      unbound,
      'mcp-2026-07-28.write-mrtr-contracts',
    )).rejects.toThrow(/requestState|serverInitiated|MRTR/i);
  });

  it('rejects a deployment with a broken OAuth iss / DCR / issuer-keyed credential binding', async () => {
    const broken = createPassingDeploymentTarget();
    const execute = broken.execute;
    broken.execute = async (command) => {
      const result = await execute(command) as Record<string, unknown>;
      return command.kind === 'mcp-2026-07-28.oauth-client-contract'
        ? { ...result, issuerValidated: true, dcrApplicationType: 'web', credentialIssuerKeyed: false }
        : result;
    };
    await expect(runDeploymentConformanceProbe(
      broken,
      'mcp-2026-07-28.oauth-client-contracts',
    )).rejects.toThrow(/issuerValidated|credentialIssuerKeyed|OAuth/i);
  });
});

describe('MCP 2026-07-28 target evidence binding (COLP-MCP-14)', () => {
  it('stamps the binding derived from the scope and the exercised families', async () => {
    const evidence = await runDeploymentConformanceProbes(
      createPassingDeploymentTarget(),
      mcpScope(['core', 'publication', 'publisher', 'mcp-read', 'mcp-write']),
    );
    const expected = createVersionedMcpEvidenceBinding({ packageVersion, requirementsDigest });
    expect(evidence.mcpBinding?.evidenceDigest).toBe(expected.evidenceDigest);
    expect(evidence.passedProbeIds).toEqual(expect.arrayContaining([...mcpConformanceProbeFamilies]));
  });

  it('changes the binding digest when the package version differs', async () => {
    const evidence = await runDeploymentConformanceProbes(
      createPassingDeploymentTarget(),
      {
        profiles: ['core', 'publication', 'publisher', 'mcp-read', 'mcp-write'],
        capabilities: [],
        mcpConformance: { packageVersion: '2.0.0', requirementsDigest },
      },
    );
    const expected = createVersionedMcpEvidenceBinding({ packageVersion, requirementsDigest });
    expect(evidence.mcpBinding?.evidenceDigest).not.toBe(expected.evidenceDigest);
  });
});
