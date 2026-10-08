import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import { createMcpWriteExposure } from '../../src/mcp/write-mount.js';
import { createMcpWriteToolGateway } from '../../src/mcp/write-tools.js';
import type { Manifest } from '../../src/types/index.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const manifestFixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

const binding = authenticatedBinding({
  principalId: 'user-h09',
  clientId: 'client-h09',
});

const context = Object.freeze({
  binding,
  scope: Object.freeze(['access:write']),
  budget: Object.freeze({
    maxDepth: 32,
    maxNodes: 10_000,
    maxBytes: 1_048_576,
    maxOperations: 1_000,
  }),
  abortSignal: new AbortController().signal,
  authorization: Object.freeze({
    principalId: binding.principalId,
    scopes: Object.freeze(['access:write']),
  }),
});

async function manifestFixture(): Promise<Manifest> {
  return JSON.parse(await readFile(manifestFixturePath, 'utf8')) as Manifest;
}

function changePlanOptions(rateLimit: unknown) {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const executor = {
    execute: vi.fn(async () => [{
      opId: 'op-h09-1',
      sequence: 1,
      status: 'applied' as const,
      revision: 'revision-h09-1',
      cursor: 'cursor-h09-1',
      warnings: [] as [],
    }]),
  };

  return {
    options: {
      planStore,
      approvalStore,
      impact: {
        assessImpact: vi.fn(async () => ({
          collections: 1,
          nodes: 0,
          annotations: 0,
          attachments: 0,
          relations: 0,
          privateFieldsExcluded: [] as string[],
        })),
      },
      revisions: {
        resolveBaseRevisions: vi.fn(async (operation) => resolveFixtureBaseRevisions(operation)),
        currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
      },
      scopes: { hasScopes: vi.fn(async () => true) },
      authorizationPolicy: { requiredScopesForOperation: vi.fn(async () => []) },
      commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
      rateLimit,
      approvalBaseUri: 'https://host.example/approvals',
      uriPolicy: { allow: () => true },
      ids: { nextPlanId: () => 'plan_h09' },
      clock: { now: () => new Date('2026-07-24T09:00:00.000Z') },
    },
    executor,
  };
}

type CreationSurface = 'gateway' | 'mount';

async function createSurface(
  surface: CreationSurface,
  changePlan: Readonly<Record<string, unknown>>,
) {
  if (surface === 'gateway') {
    return createMcpWriteToolGateway({ changePlan } as never);
  }

  const manifest = await manifestFixture();
  const mount = manifest.mounts[0]!;
  return createMcpWriteExposure(manifest, {
    mountId: mount.id,
    writeTools: { changePlan } as never,
  });
}

async function createGatewaySurface(
  surface: CreationSurface,
  changePlan: Readonly<Record<string, unknown>>,
) {
  const created = await createSurface(surface, changePlan);
  return surface === 'gateway'
    ? created as ReturnType<typeof createMcpWriteToolGateway>
    : (created as Awaited<ReturnType<typeof createMcpWriteExposure>>).tools;
}

function withoutRateLimit(): Readonly<Record<string, unknown>> {
  const { rateLimit: _rateLimit, ...options } = changePlanOptions({ allow: async () => true }).options;
  return options;
}

async function expectCreationRejected(
  surface: CreationSurface,
  changePlan: Readonly<Record<string, unknown>>,
) {
  await expect(createSurface(surface, changePlan)).rejects.toThrow(/rate.?limit|own-data|proxy|allow/iu);
}

async function planAndApprove(gateway: ReturnType<typeof createMcpWriteToolGateway>) {
  const planned = await gateway.callTool('changes.plan', {
    operations: [{
      type: 'set_visibility',
      collectionId: 'collection-h09',
      baseRevision: 'acl-h09-1',
      input: { visibility: 'public' },
    }],
    reason: 'verify explicit host rate-limit decision wiring',
    dryRun: true,
  }, context);
  const planId = (planned.structuredContent as { planId: string }).planId;
  await gateway.recordOutOfBandApproval(planId, context);
  return planId;
}

describe('H-09 required host rate-limit decision port', () => {
  it.each<CreationSurface>(['gateway', 'mount'])(
    '%s fails closed at creation when rateLimit is missing, undefined, or null',
    async (surface) => {
      await expectCreationRejected(surface, withoutRateLimit());
      await expectCreationRejected(surface, changePlanOptions(undefined).options);
      await expectCreationRejected(surface, changePlanOptions(null).options);
    },
  );

  it.each<CreationSurface>(['gateway', 'mount'])(
    '%s rejects an accessor-backed rateLimit without invoking its getter',
    async (surface) => {
      const getter = vi.fn(() => ({ allow: async () => true }));
      const changePlan = withoutRateLimit();
      Object.defineProperty(changePlan, 'rateLimit', {
        configurable: true,
        enumerable: true,
        get: getter,
      });

      await expectCreationRejected(surface, changePlan);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each<CreationSurface>(['gateway', 'mount'])(
    '%s rejects a Proxy rateLimit port before any trap runs',
    async (surface) => {
      const trap = vi.fn(() => {
        throw new Error('rateLimit Proxy trap must not run');
      });
      const proxyPort = new Proxy({ allow: async () => true }, {
        get: trap,
        getOwnPropertyDescriptor: trap,
        ownKeys: trap,
        getPrototypeOf: trap,
      });

      await expectCreationRejected(surface, changePlanOptions(proxyPort).options);
      expect(trap).not.toHaveBeenCalled();
    },
  );

  it.each<CreationSurface>(['gateway', 'mount'])(
    '%s rejects a Proxy allow function before its apply trap runs',
    async (surface) => {
      const apply = vi.fn(async () => true);
      const proxyAllow = new Proxy(async () => true, { apply });

      await expectCreationRejected(surface, changePlanOptions({ allow: proxyAllow }).options);
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it.each<CreationSurface>(['gateway', 'mount'])(
    '%s uses an explicit allowing host decision port during Commit',
    async (surface) => {
      const allow = vi.fn(async () => true);
      const { options, executor } = changePlanOptions({ allowPlan: async () => true, allow });
      const gateway = await createGatewaySurface(surface, options);
      const planId = await planAndApprove(gateway);

      await expect(gateway.callTool(
        'changes.commit',
        { planId, idempotencyKey: `idem-h09-allow-${surface}` },
        context,
      )).resolves.toMatchObject({ structuredContent: { planId } });

      expect(allow).toHaveBeenCalledOnce();
      expect(allow).toHaveBeenCalledWith({ planId, binding });
      expect(executor.execute).toHaveBeenCalledOnce();
    },
  );

  it.each<CreationSurface>(['gateway', 'mount'])(
    '%s uses an explicit denying host decision port and does not execute Commit operations',
    async (surface) => {
      const allow = vi.fn(async () => false);
      const { options, executor } = changePlanOptions({ allowPlan: async () => true, allow });
      const gateway = await createGatewaySurface(surface, options);
      const planId = await planAndApprove(gateway);

      await expect(gateway.callTool(
        'changes.commit',
        { planId, idempotencyKey: `idem-h09-deny-${surface}` },
        context,
      )).rejects.toMatchObject({ code: 'rate_limited' });

      expect(allow).toHaveBeenCalledOnce();
      expect(allow).toHaveBeenCalledWith({ planId, binding });
      expect(executor.execute).not.toHaveBeenCalled();
    },
  );

  it('does not let JavaScript-shaped type escapes recover an implicit allow-all decision', async () => {
    const escapedGatewayOptions: unknown = { changePlan: withoutRateLimit() };
    expect(() => createMcpWriteToolGateway(
      escapedGatewayOptions as Parameters<typeof createMcpWriteToolGateway>[0],
    )).toThrow(/rate.?limit|own-data|allow/iu);

    const manifest = await manifestFixture();
    const mount = manifest.mounts[0]!;
    const escapedMountOptions: unknown = {
      mountId: mount.id,
      writeTools: { changePlan: withoutRateLimit() },
    };
    expect(() => createMcpWriteExposure(
      manifest,
      escapedMountOptions as Parameters<typeof createMcpWriteExposure>[1],
    )).toThrow(/rate.?limit|own-data|allow/iu);
  });
});
