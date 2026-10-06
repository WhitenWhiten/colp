import { describe, expect, it } from 'vitest';

import {
  createDeploymentConformancePlan,
  deploymentCapabilityConformanceProbes,
  deploymentConformanceCapabilityIds,
  profileDeploymentConformanceCapabilities,
  profileDeploymentConformanceProbes,
  type DeploymentConformanceCapabilityId,
  type DeploymentConformanceScope,
} from '../../src/conformance/index.js';

const authoritativeProbes = [
  'core.id-ledger-persistence',
  'core.pre-write-validation',
  'core.parent-cycle-transaction',
  'core.node-subtree-transaction',
] as const;

const managedBookmarkProbes = ['core.managed-bookmarks-transaction'] as const;

describe('deployment conformance scope planning', () => {
  it('keeps core and publication free of unrelated deployment capabilities', () => {
    const plan = createDeploymentConformancePlan({
      profiles: ['core', 'publication'],
      capabilities: [],
    });

    expect(profileDeploymentConformanceCapabilities.core).toEqual([]);
    expect(profileDeploymentConformanceCapabilities.publication).toEqual([]);
    expect(profileDeploymentConformanceProbes.core).toEqual([]);
    expect(plan).toEqual({
      profiles: ['core', 'publication'],
      capabilities: [],
      probeIds: ['publication.http-contracts'],
    });
    expect(plan.probeIds.filter((id) => id.startsWith('core.'))).toEqual([]);
    expect(plan.capabilities).not.toContain('managed-bookmark-writes');
    expect(plan.probeIds).not.toContain('core.managed-bookmarks-transaction');
  });

  it('maps ordinary authoritative writes to exactly four probes without managed bookmarks', () => {
    expect(deploymentCapabilityConformanceProbes['core-authoritative-writes'])
      .toEqual(authoritativeProbes);
    const corePlan = createDeploymentConformancePlan({
      profiles: ['core'],
      capabilities: ['core-authoritative-writes'],
    });
    const publicationPlan = createDeploymentConformancePlan({
      profiles: ['core', 'publication'],
      capabilities: ['core-authoritative-writes'],
    });

    expect(corePlan.probeIds).toEqual(authoritativeProbes);
    expect(corePlan.capabilities).not.toContain('managed-bookmark-writes');
    expect(corePlan.probeIds).not.toContain('core.managed-bookmarks-transaction');
    expect(publicationPlan.capabilities).toEqual(['core-authoritative-writes']);
    expect(publicationPlan.probeIds).toEqual([
      ...authoritativeProbes,
      'publication.http-contracts',
    ]);
    expect(publicationPlan.probeIds).not.toContain('core.managed-bookmarks-transaction');
  });

  it.each([
    ['managed-bookmark-writes', managedBookmarkProbes],
    ['sync-extension-storage', ['core.sync-extension-persistence']],
    ['ai-content-writes', ['core.ai-provenance-transaction']],
    ['local-profile-id-storage', ['core.profile-id-persistence']],
    [
      'server-profile-id-hmac',
      ['core.profile-id-key-rotation', 'core.secret-redaction'],
    ],
  ] as const)('maps %s only to its own probes', (capability, expected) => {
    expect(deploymentCapabilityConformanceProbes[capability]).toEqual(expected);
    expect(createDeploymentConformancePlan({
      profiles: ['core'],
      capabilities: [capability],
    }).probeIds).toEqual(expected);
  });

  it('derives authoritative writes and extension storage from the sync profile', () => {
    const plan = createDeploymentConformancePlan({
      profiles: ['core', 'sync'],
      capabilities: [],
    });

    expect(profileDeploymentConformanceCapabilities.sync).toEqual([
      'core-authoritative-writes',
      'managed-bookmark-writes',
      'sync-extension-storage',
    ]);
    expect(plan.capabilities).toEqual([
      'core-authoritative-writes',
      'managed-bookmark-writes',
      'sync-extension-storage',
    ]);
    expect(new Set(plan.probeIds)).toEqual(new Set([
      ...authoritativeProbes,
      ...managedBookmarkProbes,
      'core.sync-extension-persistence',
      'sync.transaction-contracts',
    ]));
  });

  it('derives ordinary and managed bookmark writes, and no other capability, from publisher', () => {
    const plan = createDeploymentConformancePlan({
      profiles: ['core', 'publication', 'publisher'],
      capabilities: [],
    });

    expect(profileDeploymentConformanceCapabilities.publisher).toEqual([
      'core-authoritative-writes',
      'managed-bookmark-writes',
    ]);
    expect(plan.capabilities).toEqual([
      'core-authoritative-writes',
      'managed-bookmark-writes',
    ]);
    expect(new Set(plan.probeIds)).toEqual(new Set([
      ...authoritativeProbes,
      ...managedBookmarkProbes,
      'publication.http-contracts',
      'publisher.transaction-contracts',
    ]));
  });

  it('inherits managed bookmark writes through the complete mcp-write dependency closure', () => {
    const plan = createDeploymentConformancePlan({
      profiles: ['core', 'publication', 'publisher', 'mcp-read', 'mcp-write'],
      capabilities: [],
    });

    expect(profileDeploymentConformanceCapabilities['mcp-write']).toEqual([]);
    expect(plan.capabilities).toEqual([
      'core-authoritative-writes',
      'managed-bookmark-writes',
    ]);
    expect(plan.probeIds).toContain('core.managed-bookmarks-transaction');
    expect(plan.probeIds).toContain('publisher.transaction-contracts');
    for (const family of [
      'mcp-2026-07-28.transport-header-contracts',
      'mcp-2026-07-28.discovery-contracts',
      'mcp-2026-07-28.subscription-contracts',
      'mcp-2026-07-28.read-schema-contracts',
      'mcp-2026-07-28.write-mrtr-contracts',
      'mcp-2026-07-28.oauth-client-contracts',
    ]) {
      expect(plan.probeIds).toContain(family);
    }
  });

  it('publishes frozen, complete registries in canonical order', () => {
    expect(deploymentConformanceCapabilityIds).toEqual([
      'core-authoritative-writes',
      'managed-bookmark-writes',
      'sync-extension-storage',
      'ai-content-writes',
      'local-profile-id-storage',
      'server-profile-id-hmac',
    ]);
    expect(Object.isFrozen(deploymentConformanceCapabilityIds)).toBe(true);
    expect(Object.isFrozen(deploymentCapabilityConformanceProbes)).toBe(true);
    expect(Object.values(deploymentCapabilityConformanceProbes).every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(profileDeploymentConformanceCapabilities)).toBe(true);
    expect(Object.values(profileDeploymentConformanceCapabilities).every(Object.isFrozen)).toBe(true);
  });

  it.each([
    ['null scope', null, /scope must be an object/u],
    [
      'extra scope member',
      { profiles: ['core'], capabilities: [], probeIds: [] },
      /contain only profiles and capabilities/u,
    ],
    [
      'non-array profiles',
      { profiles: 'core', capabilities: [] },
      /profiles must be an enumerable array/u,
    ],
    ['empty profiles', { profiles: [], capabilities: [] }, /at least one Profile/u],
    ['unknown profile', { profiles: ['core', 'future'], capabilities: [] }, /Unknown.*Profile/u],
    ['duplicate profile', { profiles: ['core', 'core'], capabilities: [] }, /Duplicate.*Profile/u],
    [
      'missing dependency',
      { profiles: ['publication'], capabilities: [] },
      /requires Profile core/u,
    ],
    [
      'non-array capabilities',
      { profiles: ['core'], capabilities: 'none' },
      /capabilities must be an enumerable array/u,
    ],
    [
      'unknown capability',
      { profiles: ['core'], capabilities: ['future-capability'] },
      /Unknown.*capability/u,
    ],
    [
      'duplicate capability',
      { profiles: ['core'], capabilities: ['ai-content-writes', 'ai-content-writes'] },
      /Duplicate.*capability/u,
    ],
  ] as const)('rejects %s', (_label, value, error) => {
    expect(() => createDeploymentConformancePlan(
      value as unknown as DeploymentConformanceScope,
    )).toThrow(error);
  });

  it('copies caller-owned input and deeply freezes the resulting plan', () => {
    const profiles = ['core'] as ('core' | 'sync')[];
    const capabilities: DeploymentConformanceCapabilityId[] = ['ai-content-writes'];
    const scope: DeploymentConformanceScope = { profiles, capabilities };
    const plan = createDeploymentConformancePlan(scope);

    profiles.push('sync');
    capabilities.push('local-profile-id-storage');

    expect(plan.profiles).toEqual(['core']);
    expect(plan.capabilities).toEqual(['ai-content-writes']);
    expect(plan.profiles).not.toBe(profiles);
    expect(plan.capabilities).not.toBe(capabilities);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.profiles)).toBe(true);
    expect(Object.isFrozen(plan.capabilities)).toBe(true);
    expect(Object.isFrozen(plan.probeIds)).toBe(true);
  });
});
