/**
 * These tests compose deployment probes with `createPassingDeploymentTarget()`,
 * which returns opaque observations from a cooperative in-process adapter.
 * That fixture is not a Manifest. Hosts must not copy it into production probes.
 */
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
  type DeploymentRuntimeProbes,
} from '../../src/conformance/index.js';
import {
  evaluateProfileClaimsWithEvidence,
  profilePorts,
} from '../../src/conformance/internal.js';
import {
  endpointContracts,
  profileRequiredEndpoints,
  type EndpointKey,
} from '../../src/semantic/index.js';
import {
  completeDeploymentEvidence,
  coreDeploymentEvidence,
  createPassingDeploymentTarget,
  publicationDeploymentEvidence,
} from './deployment-evidence.js';

const requirements = [
  {
    id: 'TEST-core-deployment',
    level: 'MUST' as const,
    profile: 'core' as const,
    source: 'test',
    requirement: 'Core deployment scope passes.',
    implementation: ['test'],
    tests: ['test.core.deployment'],
  },
  {
    id: 'TEST-publication-deployment',
    level: 'MUST' as const,
    profile: 'publication' as const,
    source: 'test',
    requirement: 'Publication deployment scope passes.',
    implementation: ['test'],
    tests: ['test.publication.deployment'],
  },
];
const metadata = {
  protocolVersion: '0.1',
  packageVersion: 'test',
  requirementsDigest: `sha256:${'1'.repeat(64)}`,
};
const evidence = {
  schemaVersion: 2 as const,
  ...metadata,
  passedRequirementIds: ['TEST-core-deployment', 'TEST-publication-deployment'],
};
const runtime = (deploymentEvidence: DeploymentRuntimeProbes['deploymentEvidence']): DeploymentRuntimeProbes => ({
  registeredEndpoints: new Set(Object.keys(endpointContracts) as EndpointKey[]),
  availablePorts: new Set(Object.values(profilePorts).flat()),
  ...(deploymentEvidence === undefined ? {} : { deploymentEvidence }),
});

describe('deployment conformance probes', () => {
  it('does not infer deployment capabilities from the core probe prefix', () => {
    const plan = createDeploymentConformancePlan({
      profiles: ['core', 'publication'],
      capabilities: [],
    });

    expect(profileDeploymentConformanceProbes.core).toEqual([]);
    expect(plan.probeIds).toEqual(['publication.http-contracts']);
    expect(plan.probeIds).not.toContain('core.id-ledger-persistence');
    expect(plan.probeIds).not.toContain('core.sync-extension-persistence');
    expect(plan.probeIds).not.toContain('core.ai-provenance-transaction');
    expect(plan.probeIds).not.toContain('core.profile-id-persistence');
    expect(plan.probeIds).not.toContain('core.profile-id-key-rotation');
    expect(plan.probeIds).not.toContain('core.secret-redaction');
  });

  it('accepts opaque evidence for the exact core and publication scope', () => {
    expect(publicationDeploymentEvidence).toMatchObject({
      profiles: ['core', 'publication'],
      capabilities: [],
      passedProbeIds: ['publication.http-contracts'],
    });
    expect(Object.isFrozen(publicationDeploymentEvidence)).toBe(true);
    expect(Object.isFrozen(publicationDeploymentEvidence.profiles)).toBe(true);
    expect(Object.isFrozen(publicationDeploymentEvidence.capabilities)).toBe(true);
    expect(Object.isFrozen(publicationDeploymentEvidence.passedProbeIds)).toBe(true);
    expect(evaluateProfileClaimsWithEvidence(
      runtime(publicationDeploymentEvidence),
      evidence,
      metadata,
      requirements,
      profileRequiredEndpoints,
    )).toEqual(['core', 'publication']);
    expect(evaluateProfileClaimsWithEvidence(
      runtime(undefined),
      evidence,
      metadata,
      requirements,
      profileRequiredEndpoints,
    )).not.toContain('core');
  });

  it('binds ordinary and managed bookmark write evidence to separate capability scopes', async () => {
    const ordinaryEvidence = await runDeploymentConformanceProbes(
      createPassingDeploymentTarget(),
      { profiles: ['core'], capabilities: ['core-authoritative-writes'] },
    );
    const managedEvidence = await runDeploymentConformanceProbes(
      createPassingDeploymentTarget(),
      { profiles: ['core'], capabilities: ['managed-bookmark-writes'] },
    );

    expect(ordinaryEvidence).toMatchObject({
      profiles: ['core'],
      capabilities: ['core-authoritative-writes'],
      passedProbeIds: [
        'core.id-ledger-persistence',
        'core.pre-write-validation',
        'core.parent-cycle-transaction',
        'core.node-subtree-transaction',
      ],
    });
    expect(ordinaryEvidence.passedProbeIds).not.toContain(
      'core.managed-bookmarks-transaction',
    );
    expect(managedEvidence).toMatchObject({
      profiles: ['core'],
      capabilities: ['managed-bookmark-writes'],
      passedProbeIds: ['core.managed-bookmarks-transaction'],
    });
  });

  it('does not reuse valid opaque evidence across a broader profile scope', () => {
    expect(evaluateProfileClaimsWithEvidence(
      runtime(coreDeploymentEvidence),
      evidence,
      metadata,
      requirements,
      profileRequiredEndpoints,
    )).toEqual(['core']);
  });

  it('rejects reconstructed evidence even when every scope field and probe ID is copied', () => {
    expect(() => evaluateProfileClaimsWithEvidence(
      runtime({
        profiles: [...completeDeploymentEvidence.profiles],
        capabilities: [...completeDeploymentEvidence.capabilities],
        passedProbeIds: [...completeDeploymentEvidence.passedProbeIds],
      } as unknown as NonNullable<DeploymentRuntimeProbes['deploymentEvidence']>),
      evidence,
      metadata,
      requirements,
      profileRequiredEndpoints,
    )).toThrow(/returned by runDeploymentConformanceProbes/u);
  });

  it('rejects copied and partial evidence instead of trusting structural scope fields', () => {
    for (const reconstructed of [
      { ...publicationDeploymentEvidence },
      {
        ...publicationDeploymentEvidence,
        passedProbeIds: [],
      },
      {
        ...publicationDeploymentEvidence,
        profiles: ['core'],
      },
    ]) {
      expect(() => evaluateProfileClaimsWithEvidence(
        runtime(reconstructed as unknown as NonNullable<DeploymentRuntimeProbes['deploymentEvidence']>),
        evidence,
        metadata,
        requirements,
        profileRequiredEndpoints,
      )).toThrow(/returned by runDeploymentConformanceProbes/u);
    }
  });

  it('does not issue evidence after a failed or malformed target operation', async () => {
    const failure = new Error('black-box assertion failed');
    const failing = createPassingDeploymentTarget();
    failing.execute = vi.fn(async () => Promise.reject(failure));
    await expect(runDeploymentConformanceProbes(failing, {
      profiles: ['core', 'publication'],
      capabilities: [],
    }))
      .rejects.toBe(failure);

    const target = createPassingDeploymentTarget();
    target.execute = vi.fn(() => undefined) as unknown as DeploymentConformanceTarget['execute'];
    await expect(runDeploymentConformanceProbes(target, {
      profiles: ['core', 'publication'],
      capabilities: [],
    }))
      .rejects.toThrow(/native Promise/u);
  });

  it('rejects malformed targets, scopes, probe IDs, and empty observations', async () => {
    await expect(runDeploymentConformanceProbes(
      null as unknown as DeploymentConformanceTarget,
      { profiles: ['core'], capabilities: [] },
    )).rejects.toThrow(/target must be an object/u);
    await expect(runDeploymentConformanceProbes(
      createPassingDeploymentTarget(),
      null as unknown as DeploymentConformanceScope,
    )).rejects.toThrow(/scope must be an object/u);
    await expect(runDeploymentConformanceProbe(
      createPassingDeploymentTarget(),
      'unknown.probe' as DeploymentConformanceProbeId,
    )).rejects.toThrow(/Unknown deployment conformance probe/u);

    const empty = createPassingDeploymentTarget();
    empty.execute = vi.fn(async () => undefined);
    await expect(runDeploymentConformanceProbe(empty, 'core.id-ledger-persistence'))
      .rejects.toThrow(/observation object/u);
  });

  it.each(deploymentConformanceProbeIds)(
    'rejects an empty successful-looking observation for %s',
    async (probeId) => {
      const target = createPassingDeploymentTarget();
      target.execute = vi.fn(async () => ({}));
      await expect(runDeploymentConformanceProbe(target, probeId)).rejects.toThrow();
    },
  );

  it('rejects a fixed low-entropy random Profile ID', async () => {
    const target = createPassingDeploymentTarget();
    const execute = target.execute;
    target.execute = async (command) => command.kind === 'random-profile-id.get-or-create'
      ? { status: 'found', id: 'x' }
      : execute(command);

    await expect(runDeploymentConformanceProbe(target, 'core.profile-id-persistence'))
      .rejects.toThrow(/canonical prf\.r1/u);
  });

  it('rejects a deployment that rejects every pre-write attempt', async () => {
    const target = createPassingDeploymentTarget();
    const execute = target.execute;
    target.execute = async (command) => command.kind === 'pre-write.write'
      ? { status: 'rejected' }
      : execute(command);

    await expect(runDeploymentConformanceProbe(target, 'core.pre-write-validation'))
      .rejects.toThrow(/valid candidate/u);
  });

  it('rejects an ID ledger scoped by resource type', async () => {
    const target = createPassingDeploymentTarget();
    const reservations = new Map<string, Set<string>>();
    const logical = new Map<string, string>();
    target.execute = async (command) => {
      if (command.kind === 'id-ledger.delete-resource') {
        logical.delete(command.logicalKey);
        return { status: 'deleted' };
      }
      if (command.kind !== 'id-ledger.reserve') return {};
      const replay = logical.get(command.logicalKey);
      if (replay !== undefined) return { status: 'reserved', id: replay };
      const ids = reservations.get(command.resourceType) ?? new Set<string>();
      reservations.set(command.resourceType, ids);
      if (ids.has(command.requestedId)) return { status: 'conflict' };
      ids.add(command.requestedId);
      logical.set(command.logicalKey, command.requestedId);
      return { status: 'reserved', id: command.requestedId };
    };

    await expect(runDeploymentConformanceProbe(target, 'core.id-ledger-persistence'))
      .rejects.toThrow(/duplicate reservation|exactly one winner/u);
  });

  it('rejects a deployment that protects only managed-bookmarks updates', async () => {
    const target = createPassingDeploymentTarget();
    const execute = target.execute;
    target.execute = async (command) => command.kind === 'managed-bookmarks.mutate'
      ? { status: command.mutation === 'update-node' ? 'rejected' : 'stored' }
      : execute(command);

    await expect(runDeploymentConformanceProbe(target, 'core.managed-bookmarks-transaction'))
      .rejects.toThrow(/create-child|move-node|reorder-children|delete/u);
  });

  it('rejects an incomplete subtree deletion even when it reports the expected count', async () => {
    const target = createPassingDeploymentTarget();
    const parents = new Map<string, string | null>();
    const execute = target.execute;
    target.execute = async (command) => {
      if (command.kind === 'node-subtree.seed') {
        for (const node of command.nodes) parents.set(node.id, node.parentId);
        return { status: 'stored' };
      }
      if (command.kind === 'node-subtree.delete') {
        parents.delete(command.nodeId);
        return { status: 'deleted', affectedCount: 3 };
      }
      if (command.kind === 'node-subtree.read') {
        return parents.has(command.nodeId) ? { status: 'found' } : { status: 'missing' };
      }
      return execute(command);
    };

    await expect(runDeploymentConformanceProbe(target, 'core.node-subtree-transaction'))
      .rejects.toThrow(/Deleted subtree member/u);
  });

  it('rejects a subtree deletion receipt with the wrong affectedCount', async () => {
    const target = createPassingDeploymentTarget();
    const execute = target.execute;
    target.execute = async (command) => {
      const result = await execute(command) as Record<string, unknown>;
      return command.kind === 'node-subtree.delete'
        ? { ...result, affectedCount: 4 }
        : result;
    };

    await expect(runDeploymentConformanceProbe(target, 'core.node-subtree-transaction'))
      .rejects.toThrow(/affectedCount/u);
  });

  it('rejects a deployment that trusts caller-asserted AI provenance', async () => {
    const target = createPassingDeploymentTarget();
    const execute = target.execute;
    target.execute = async (command) => command.kind === 'ai-provenance.create'
      ? { status: 'stored' }
      : command.kind === 'ai-provenance.load'
        ? { status: 'found', provenance: { kind: 'ai', generatedAt: '2026-01-01T00:00:00Z' } }
        : execute(command);

    await expect(runDeploymentConformanceProbe(target, 'core.ai-provenance-transaction'))
      .rejects.toThrow(/Caller-forged/u);
  });

  it('rejects secret disclosure and malformed lifecycle methods', async () => {
    const responseLeak = createPassingDeploymentTarget();
    const responseExecute = responseLeak.execute;
    responseLeak.execute = async (command) => {
      const observation = await responseExecute(command) as Record<string, unknown>;
      return command.kind === 'profile-id.configure-key'
        ? { ...observation, secret: command.secret }
        : observation;
    };
    await expect(runDeploymentConformanceProbe(responseLeak, 'core.secret-redaction'))
      .rejects.toThrow(/disclosed/u);

    const leaking = createPassingDeploymentTarget();
    let configuredSecret = '';
    const execute = leaking.execute;
    leaking.execute = async (command) => {
      if (command.kind === 'profile-id.configure-key') configuredSecret = command.secret;
      return execute(command);
    };
    leaking.readDiagnostics = async () => ({ configuredSecret });
    await expect(runDeploymentConformanceProbe(leaking, 'core.secret-redaction'))
      .rejects.toThrow(/disclosed/u);

    for (const encode of [
      (secret: string) => Buffer.from(secret).toString('hex'),
      (secret: string) => Buffer.from(secret).toString('base64'),
      (secret: string) => Buffer.from(secret).toString('base64url'),
    ]) {
      const encodedLeak = createPassingDeploymentTarget();
      let encodedSecret = '';
      const encodedExecute = encodedLeak.execute;
      encodedLeak.execute = async (command) => {
        if (command.kind === 'profile-id.configure-key') encodedSecret = encode(command.secret);
        return encodedExecute(command);
      };
      encodedLeak.readDiagnostics = async () => ({ encodedSecret });
      await expect(runDeploymentConformanceProbe(encodedLeak, 'core.secret-redaction'))
        .rejects.toThrow(/disclosed/u);
    }

    const circularDiagnostics = createPassingDeploymentTarget();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    circularDiagnostics.readDiagnostics = async () => circular;
    await expect(runDeploymentConformanceProbe(circularDiagnostics, 'core.secret-redaction'))
      .rejects.toThrow(/JSON serializable/u);

    const restartValue = createPassingDeploymentTarget();
    restartValue.restart = vi.fn(async () => 'unexpected') as unknown as DeploymentConformanceTarget['restart'];
    await expect(runDeploymentConformanceProbe(restartValue, 'core.id-ledger-persistence'))
      .rejects.toThrow(/without a result/u);

    const restartNonPromise = createPassingDeploymentTarget();
    restartNonPromise.restart = vi.fn(() => undefined) as unknown as DeploymentConformanceTarget['restart'];
    await expect(runDeploymentConformanceProbe(restartNonPromise, 'core.id-ledger-persistence'))
      .rejects.toThrow(/native Promise/u);

    const diagnosticsNonPromise = createPassingDeploymentTarget();
    diagnosticsNonPromise.readDiagnostics = vi.fn(() => undefined) as unknown as DeploymentConformanceTarget['readDiagnostics'];
    await expect(runDeploymentConformanceProbe(diagnosticsNonPromise, 'core.secret-redaction'))
      .rejects.toThrow(/native Promise/u);
  });

  it('rejects targets with extra members or non-function method descriptors', async () => {
    await expect(runDeploymentConformanceProbes({
      ...createPassingDeploymentTarget(),
      extra: true,
    } as unknown as DeploymentConformanceTarget, {
      profiles: ['core'],
      capabilities: [],
    })).rejects.toThrow(/contain only/u);

    await expect(runDeploymentConformanceProbes({
      ...createPassingDeploymentTarget(),
      execute: 1,
    } as unknown as DeploymentConformanceTarget, {
      profiles: ['core'],
      capabilities: [],
    })).rejects.toThrow(/must be an enumerable function/u);
  });
});
