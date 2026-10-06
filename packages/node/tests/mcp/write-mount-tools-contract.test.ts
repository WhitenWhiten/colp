import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Manifest } from '../../src/types/index.js';
import { createMcpReadExposure } from '../../src/mcp/read-mount.js';
import {
  McpWriteMountConfigurationError,
  createMcpWriteExposure,
  createMcpWriteMountAdapter,
  isMcpWriteToolName,
} from '../../src/mcp/write-mount.js';
import {
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

async function fixture(): Promise<Manifest> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Manifest;
}

function emptyImpact() {
  return {
    collections: 1,
    nodes: 0,
    annotations: 0,
    attachments: 0,
    relations: 0,
    privateFieldsExcluded: [] as string[],
  };
}

function changePlanPorts() {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const executor = {
    execute: vi.fn(async () => [] as const),
  };
  return {
    planStore,
    approvalStore,
    impact: {
      assessImpact: vi.fn(async () => emptyImpact()),
    },
    revisions: {
      resolveBaseRevisions: vi.fn(async (operation) => resolveFixtureBaseRevisions(operation)),
      currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
    },
    scopes: {
      hasScopes: vi.fn(async () => true),
    },
    authorizationPolicy: { requiredScopesForOperation: vi.fn(async () => []) },
    commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
    rateLimit: {
      allow: vi.fn(async () => true),
    },
    approvalBaseUri: 'https://alice.example/collections/approvals',
    uriPolicy: { allow: () => true },
    ids: { nextPlanId: () => 'plan_test_0007' },
    clock: { now: () => new Date('2026-07-16T07:00:00.000Z') },
  };
}

function writeOptions() {
  return {
    writeTools: {
      changePlan: changePlanPorts(),
    },
  };
}

describe('MCP-0007 write mount tools [evidence:schema.mcp-write-tools]', () => {
  it('exports createMcpWriteExposure from package and mcp boundaries [evidence:schema.mcp-write-tools]', () => {
    expect(typeof createMcpWriteExposure).toBe('function');
    expect(typeof createMcpWriteMountAdapter).toBe('function');
    expect(createMcpWriteExposure).toBe(createMcpWriteMountAdapter);
  });

  it('exposes write Tools when mount declares mcp-write with mcp-read and publisher [evidence:schema.mcp-write-tools]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    // Fixture already has full profile set including mcp-write + tools=true.
    expect(mount.profiles).toEqual(expect.arrayContaining(['mcp-write', 'mcp-read', 'publisher']));
    expect(mount.features.mcp?.tools).toBe(true);

    const exposure = createMcpWriteExposure(manifest, {
      mountId: mount.id,
      ...writeOptions(),
    });

    expect(exposure.endpoint).toBe(mount.endpoints.mcp);
    expect(exposure.resources).toBe(true);
    expect(exposure.profiles).toEqual(expect.arrayContaining(['mcp-write', 'mcp-read', 'publisher']));
    const toolNames = exposure.tools.listTools().map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining([
      'changes.plan',
      'changes.commit',
      'changes.cancel',
    ]));
    expect(toolNames.every((name) => typeof name === 'string')).toBe(true);
  });

  it('fail-closes when mcp-write omits mcp-read dependency [evidence:schema.mcp-write-tools]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    mount.profiles = ['core', 'publication', 'publisher', 'mcp-write'];
    mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: true };

    expect(() =>
      createMcpWriteExposure(manifest, {
        mountId: mount.id,
        ...writeOptions(),
      }),
    ).toThrow(/mcp-read|dependency|validation|invalid_manifest|missing_profile/i);
  });

  it('fail-closes when mcp-write omits publisher dependency [evidence:schema.mcp-write-tools]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    mount.profiles = ['core', 'mcp-read', 'mcp-write'];
    mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: true };

    expect(() =>
      createMcpWriteExposure(manifest, {
        mountId: mount.id,
        ...writeOptions(),
      }),
    ).toThrow(/publisher|dependency|validation|invalid_manifest|missing_profile/i);
  });

  it('fail-closes when mcp-write sets tools=false [evidence:schema.mcp-write-tools]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: false };

    expect(() =>
      createMcpWriteExposure(manifest, {
        mountId: mount.id,
        ...writeOptions(),
      }),
    ).toThrow(/tools|validation|invalid_manifest/i);
  });

  it('does not expose write Tools on an mcp-read mount [evidence:schema.mcp-write-tools]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    mount.profiles = ['core', 'mcp-read'];
    mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: true };

    // Write mount adapter rejects non-write profiles.
    expect(() =>
      createMcpWriteExposure(manifest, {
        mountId: mount.id,
        ...writeOptions(),
      }),
    ).toThrow(/mcp-write|mismatch|validation|invalid_manifest/i);

    // Read exposure must not advertise write tools.
    const readExposure = createMcpReadExposure(manifest, {
      mountId: mount.id,
      applicationService: {
        getCollection: vi.fn(async () => Object.freeze({ id: 'collection-1' })),
      },
    });
    expect('tools' in readExposure).toBe(true);
    if (!('tools' in readExposure) || readExposure.tools === undefined) {
      throw new Error('expected read tools gateway');
    }
    const names = readExposure.tools.listTools().map((tool: { name: string }) => tool.name);
    expect(names).toEqual(['collections.get']);
    expect(names.some((name: string) => isMcpWriteToolName(name))).toBe(false);
    expect(names).not.toContain('changes.plan');
    expect(names).not.toContain('changes.commit');
    expect(names).not.toContain('keys.create');
  });

  it('fail-closes when selected mountId is missing [evidence:schema.mcp-write-tools]', async () => {
    const manifest = await fixture();
    expect(() =>
      createMcpWriteExposure(manifest, {
        mountId: 'does-not-exist',
        ...writeOptions(),
      }),
    ).toThrow(McpWriteMountConfigurationError);
  });

  it('write Tools gateway can create a typed plan through the mounted surface [evidence:schema.mcp-write-tools]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    const exposure = createMcpWriteExposure(manifest, {
      mountId: mount.id,
      ...writeOptions(),
    });

    const context = Object.freeze({
      binding: authenticatedBinding({
        principalId: 'user-1',
        clientId: 'client-1',
      }),
      scope: Object.freeze(['access:write']),
      budget: Object.freeze({
        maxDepth: 32,
        maxNodes: 10_000,
        maxBytes: 1_048_576,
        maxOperations: 1_000,
      }),
      abortSignal: new AbortController().signal,
      authorization: Object.freeze({
        subjectId: 'user-1',
        scopes: Object.freeze(['access:write']),
      }),
    });

    const result = await exposure.tools.callTool(
      'changes.plan',
      {
        operations: [
          {
            type: 'set_visibility',
            collectionId: 'collection-1',
            baseRevision: 'acl_17',
            input: { visibility: 'public' },
          },
        ],
        reason: 'User asked to publish the collection',
        dryRun: true,
      },
      context,
    );

    expect(result.structuredContent).toEqual(expect.objectContaining({
      planId: 'plan_test_0007',
      risk: 'high',
      requiresApproval: true,
      approvalMethod: 'out_of_band',
    }));
    expect(result.structuredContent).toHaveProperty('approvalUri');
  });
});
