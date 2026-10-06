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
  createMcpConformanceCandidate,
  evaluateMcpConformanceProbeCoverage,
  legacyMcpConformanceProbeIds,
  mcpConformanceProbeFamilies,
} from '../../src/conformance/mcp-conformance.js';
import { createPassingDeploymentTarget } from './deployment-evidence.js';

const sourceRevision = 'a'.repeat(40);
const requirementsDigest = `sha256:${'b'.repeat(64)}`;
const reportDigest = `sha256:${'c'.repeat(64)}`;

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
  mcpConformance: { sourceRevision, requirementsDigest, reportDigest },
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
      sourceRevision,
      sdkLock: {
        '@modelcontextprotocol/core': '2.0.0',
        '@modelcontextprotocol/client': '2.0.0',
        '@modelcontextprotocol/server': '2.0.0',
      },
      fixtureTopologyDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      requirementsDigest,
      reportDigest,
      probeFamilyIds: [...readFamilies],
    });
    expect(evidence.mcpBinding?.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.mcpBinding)).toBe(true);
  });

  it('fails closed when an MCP scope omits the source-bound target evidence input', async () => {
    const target = createPassingDeploymentTarget();
    const execute = vi.spyOn(target, 'execute');
    const restart = vi.spyOn(target, 'restart');
    const readDiagnostics = vi.spyOn(target, 'readDiagnostics');
    await expect(runDeploymentConformanceProbes(
      target,
      { profiles: ['core', 'mcp-read'], capabilities: [] },
    )).rejects.toThrow(/mcpConformance|source binding/i);
    expect(execute).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(readDiagnostics).not.toHaveBeenCalled();
  });

  it('keeps the preflight source binding when caller state changes during probe I/O', async () => {
    const mcpConformance = { sourceRevision, requirementsDigest, reportDigest };
    const target = createPassingDeploymentTarget();
    const execute = target.execute.bind(target);
    target.execute = async (command) => {
      mcpConformance.sourceRevision = 'd'.repeat(40);
      mcpConformance.reportDigest = `sha256:${'e'.repeat(64)}`;
      return execute(command);
    };
    const evidence = await runDeploymentConformanceProbes(target, {
      profiles: ['core', 'mcp-read'], capabilities: [], mcpConformance,
    });
    expect(evidence.mcpBinding).toMatchObject({ sourceRevision, requirementsDigest, reportDigest });
  });

  it.each([
    ['non-hex source revision', { sourceRevision: 'not-a-revision' }, /sourceRevision/u],
    ['short source revision', { sourceRevision: 'abc1234' }, /sourceRevision/u],
    ['malformed report digest', { reportDigest: 'md5:abc' }, /reportDigest/u],
    ['malformed requirements digest', { requirementsDigest: 'nope' }, /requirementsDigest/u],
    ['extra mcpConformance member', { extra: true }, /only sourceRevision, requirementsDigest, and reportDigest/u],
  ] as const)('rejects a malformed %s in the MCP deployment scope', async (_label, partial, expected) => {
    await expect(runDeploymentConformanceProbes(
      createPassingDeploymentTarget(),
      {
        profiles: ['core', 'mcp-read'],
        capabilities: [],
        mcpConformance: { sourceRevision, requirementsDigest, reportDigest, ...partial },
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

describe('MCP 2026-07-28 target-evidence runner verdict (COLP-MCP-14)', () => {
  it('accepts a candidate when the deployment target evidence carries the identical binding', async () => {
    const candidate = createMcpConformanceCandidate({
      sourceRevision,
      requirementsDigest,
      reportDigest,
    });
    const evidence = await runDeploymentConformanceProbes(
      createPassingDeploymentTarget(),
      {
        profiles: ['core', 'publication', 'publisher', 'mcp-read', 'mcp-write'],
        capabilities: [],
        mcpConformance: { sourceRevision, requirementsDigest, reportDigest },
      },
    );
    expect(evidence.mcpBinding?.evidenceDigest).toBe(candidate.evidenceDigest);
    expect(evaluateMcpConformanceProbeCoverage(candidate, evidence)).toBe(true);
  });

  it('rejects the verdict when the target source revision differs from the candidate', async () => {
    const candidate = createMcpConformanceCandidate({
      sourceRevision,
      requirementsDigest,
      reportDigest,
    });
    const evidence = await runDeploymentConformanceProbes(
      createPassingDeploymentTarget(),
      {
        profiles: ['core', 'mcp-read'],
        capabilities: [],
        mcpConformance: {
          sourceRevision: 'b'.repeat(40),
          requirementsDigest,
          reportDigest,
        },
      },
    );
    expect(evaluateMcpConformanceProbeCoverage(candidate, evidence)).toBe(false);
  });

  it('rejects the verdict when the deployment never exercised the full family set', async () => {
    const candidate = createMcpConformanceCandidate({
      sourceRevision,
      requirementsDigest,
      reportDigest,
    });
    const partial = await runDeploymentConformanceProbes(
      createPassingDeploymentTarget(),
      mcpScope(['core', 'mcp-read']),
    );
    expect(partial.passedProbeIds).not.toContain('mcp-2026-07-28.write-mrtr-contracts');
    expect(evaluateMcpConformanceProbeCoverage(candidate, partial)).toBe(false);
  });
});
