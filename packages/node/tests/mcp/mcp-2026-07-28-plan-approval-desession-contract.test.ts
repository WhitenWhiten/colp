import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import * as mcpBoundary from '../../src/mcp/index.js';
import type { McpAuthenticatedAuthorizationBinding as McpBoundaryAuthenticatedBinding } from '../../src/mcp/index.js';
import {
  createChangePlanService,
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
  McpChangePlanError,
  type McpChangePlanExecutorPort,
  type McpStoredPlan,
} from '../../src/mcp/change-plan.js';
import {
  createAnonymousPublicBinding,
  type McpAuthenticatedAuthorizationBinding,
} from '../../src/mcp/shared/authorization.js';
import {
  authenticatedBinding,
  bindingA,
  FIXTURE_RESOURCE_AUDIENCE,
  FIXTURE_SECURITY_EPOCH,
} from './authenticated-binding-fixture.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';

function highRiskOp(visibility: 'public' | 'unlisted' | 'private' = 'public') {
  return Object.freeze({
    type: 'set_visibility' as const,
    collectionId: 'collection-1',
    baseRevision: 'acl_17',
    input: Object.freeze({ visibility }),
  });
}

function planRequest(operations = [highRiskOp()]) {
  return {
    operations,
    reason: 'User asked to publish the collection',
    dryRun: true,
  };
}

function sampleImpact(nodes = 48) {
  return {
    collections: 1,
    nodes,
    annotations: 6,
    attachments: 0,
    relations: 12,
    privateFieldsExcluded: ['sourceRefs'] as string[],
  };
}

function createService(overrides: Record<string, unknown> = {}) {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const authoritativeRevisions = new Map<string, string>();
  const impact = { assessImpact: vi.fn(async () => sampleImpact()) };
  const revisions = {
    resolveBaseRevisions: vi.fn(async (operation) => {
      const resolved = resolveFixtureBaseRevisions(operation);
      for (const [namespace, revision] of Object.entries(resolved)) {
        if (!authoritativeRevisions.has(namespace)) authoritativeRevisions.set(namespace, revision);
      }
      return resolved;
    }),
    currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) =>
      Object.fromEntries(
        Object.keys(base).map((namespace) => [
          namespace,
          authoritativeRevisions.get(namespace) ?? 'missing_authoritative_revision',
        ]),
      )),
  };
  const scopes = { hasScopes: vi.fn(async () => true) };
  const authorizationPolicy = { requiredScopesForOperation: vi.fn(async () => []) };
  const defaultExecutor = {
    execute: vi.fn(async () => [
      {
        opId: 'op-1',
        sequence: 1,
        status: 'applied' as const,
        revision: 'r_1043',
        cursor: 'cur_1',
        warnings: [] as [],
      },
    ]),
  };
  const rateLimit = { allow: vi.fn(async () => true) };
  const executor = (overrides.executor ?? defaultExecutor) as typeof defaultExecutor;
  const statefulExecutor = {
    execute: vi.fn(async (...args: Parameters<McpChangePlanExecutorPort['execute']>) => {
      const operationResults = (await Reflect.apply(executor.execute, executor, args)) as unknown;
      const operations = args[1];
      if (Array.isArray(operationResults)) {
        for (const [index, operationResult] of operationResults.entries()) {
          const operation = operations[index];
          if (
            operation === undefined
            || typeof operationResult !== 'object'
            || operationResult === null
            || !('revision' in operationResult)
            || typeof operationResult.revision !== 'string'
          ) {
            continue;
          }
          for (const namespace of Object.keys(resolveFixtureBaseRevisions(operation))) {
            authoritativeRevisions.set(namespace, operationResult.revision);
          }
        }
      }
      return operationResults as Awaited<ReturnType<McpChangePlanExecutorPort['execute']>>;
    }),
  };
  const commitCoordinator = createCommitCoordinatorFixture(planStore, approvalStore, statefulExecutor);
  let now = new Date('2026-07-16T07:00:00.000Z');
  const { executor: _executorOverride, ...serviceOverrides } = overrides;
  const service = createChangePlanService({
    planStore,
    approvalStore,
    impact,
    revisions,
    scopes,
    authorizationPolicy,
    commitCoordinator,
    rateLimit,
    approvalBaseUri: 'https://alice.example/collections/approvals',
    uriPolicy: { allow: () => true },
    ids: { nextPlanId: () => 'plan_01JZTEST' },
    clock: { now: () => now },
    ...(serviceOverrides as object),
  } as Parameters<typeof createChangePlanService>[0]);
  return {
    service,
    planStore,
    approvalStore,
    impact,
    revisions,
    scopes,
    authorizationPolicy,
    executor,
    rateLimit,
    authoritativeRevisions,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

function otherBinding(
  overrides: Readonly<Partial<Omit<McpAuthenticatedAuthorizationBinding, 'kind'>>>,
): McpAuthenticatedAuthorizationBinding {
  return authenticatedBinding(overrides);
}

describe('MCP 2026-07-28 Plan/Approval desession contract (COLP-MCP-05)', () => {
  it('enforces the aggregate plan admission cap and releases it after failures', async () => {
    const gate: { resolve?: (value: ReturnType<typeof sampleImpact>) => void } = {};
    const pending = new Promise<ReturnType<typeof sampleImpact>>((resolve) => { gate.resolve = resolve; });
    const { service, impact } = createService({ maxConcurrentPlans: 1 });
    impact.assessImpact.mockImplementationOnce(async () => pending);

    const first = service.plan(planRequest(), bindingA);
    await expect(service.plan(planRequest(), bindingA)).rejects.toMatchObject({ code: 'rate_limited' });
    gate.resolve?.(sampleImpact());
    await expect(first).resolves.toMatchObject({ planId: 'plan_01JZTEST' });

    // The finally path must release the slot even when the first request
    // completes through an exceptional validation branch.
    impact.assessImpact.mockRejectedValueOnce(new Error('impact backend unavailable'));
    await expect(service.plan(planRequest(), bindingA)).rejects.toMatchObject({ code: 'invalid_plan_request' });
    await expect(service.plan(planRequest(), bindingA)).resolves.toMatchObject({ planId: 'plan_01JZTEST' });
  });

  describe('binding equality dimensions', () => {
    const mismatchCases = [
      { label: 'principal', overrides: { principalId: 'user-other' } },
      { label: 'client', overrides: { clientId: 'client-other' } },
      { label: 'credential binding', overrides: { credentialBindingId: 'credential-other' } },
      { label: 'resource audience', overrides: { resourceAudience: 'urn:colp:resource:other' } },
      { label: 'security epoch', overrides: { securityEpoch: 'epoch-other' } },
    ] as const;

    for (const { label, overrides } of mismatchCases) {
      it(`rejects commit when the ${label} differs [evidence:mcp.plan-desession]`, async () => {
        const { service } = createService();
        const plan = await service.plan(planRequest(), bindingA);
        await service.recordOutOfBandApproval(plan.planId, bindingA);
        await expect(
          service.commit(plan.planId, otherBinding(overrides), 'idem-desession'),
        ).rejects.toMatchObject({ code: 'plan_binding_mismatch' });
      });

      it(`rejects approval when the stored plan was bound to a different ${label} [evidence:mcp.plan-desession]`, async () => {
        const { service } = createService();
        const plan = await service.plan(planRequest(), bindingA);
        await expect(
          service.recordOutOfBandApproval(plan.planId, otherBinding(overrides)),
        ).rejects.toMatchObject({ code: 'plan_binding_mismatch' });
      });
    }

    it('persists the frozen authenticated binding on the stored plan [evidence:mcp.plan-desession]', async () => {
      const { service, planStore } = createService();
      await service.plan(planRequest(), bindingA);
      const stored = (await planStore.get('plan_01JZTEST')) as McpStoredPlan;
      expect(stored.binding).toEqual(bindingA);
      expect(Object.isFrozen(stored.binding)).toBe(true);
      expect(Object.keys(stored.binding).sort()).toEqual([
        'clientId',
        'credentialBindingId',
        'kind',
        'principalId',
        'resourceAudience',
        'securityEpoch',
      ]);
      expect(stored).not.toHaveProperty('sessionId');
      expect(stored.binding).not.toHaveProperty('sessionId');
    });
  });

  describe('digest and revision binding', () => {
    it('rejects commit when the approval digest differs from the locked plan digest [evidence:mcp.plan-desession]', async () => {
      const { service, planStore, approvalStore, executor } = createService();
      const plan = await service.plan(planRequest(), bindingA);
      const stored = (await planStore.get(plan.planId)) as McpStoredPlan;
      await approvalStore.markApproved({
        planId: stored.planId,
        binding: bindingA,
        operationsDigest: 'sha-256:not-the-plan-digest',
      });
      await planStore.update(Object.freeze({ ...stored, status: 'approved' as const }));
      await expect(service.commit(plan.planId, bindingA, 'idem-digest')).rejects.toMatchObject({
        code: 'digest_mismatch',
      });
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it('rejects commit on base revision drift [evidence:mcp.plan-desession]', async () => {
      const revisions = {
        resolveBaseRevisions: vi.fn(async (operation) => resolveFixtureBaseRevisions(operation)),
        currentRevisions: vi.fn(async () => ({ 'access.collection-1': 'acl_99' })),
      };
      const { service } = createService({ revisions });
      const plan = await service.plan(planRequest(), bindingA);
      await service.recordOutOfBandApproval(plan.planId, bindingA);
      await expect(service.commit(plan.planId, bindingA, 'idem-drift')).rejects.toMatchObject({
        code: 'revision_drift',
      });
    });
  });

  describe('concurrent consume and idempotent replay', () => {
    it('runs the executor once for the same idempotency key and replays the first result [evidence:mcp.plan-desession]', async () => {
      const { service, executor, scopes, revisions, impact, rateLimit } = createService();
      const plan = await service.plan(planRequest(), bindingA);
      await service.recordOutOfBandApproval(plan.planId, bindingA);

      const first = await service.commit(plan.planId, bindingA, 'idem-replay');
      const mutableCalls = {
        scopes: scopes.hasScopes.mock.calls.length,
        revisions: revisions.currentRevisions.mock.calls.length,
        impact: impact.assessImpact.mock.calls.length,
        rateLimit: rateLimit.allow.mock.calls.length,
      };
      const replay = await service.commit(plan.planId, bindingA, 'idem-replay');
      expect(replay).toEqual(first);
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(scopes.hasScopes).toHaveBeenCalledTimes(mutableCalls.scopes);
      expect(revisions.currentRevisions).toHaveBeenCalledTimes(mutableCalls.revisions);
      expect(impact.assessImpact).toHaveBeenCalledTimes(mutableCalls.impact);
      expect(rateLimit.allow).toHaveBeenCalledTimes(mutableCalls.rateLimit);
    });

    it('allows one winner across different idempotency keys and rejects the loser [evidence:mcp.plan-desession]', async () => {
      const { service, executor } = createService();
      const plan = await service.plan(planRequest(), bindingA);
      await service.recordOutOfBandApproval(plan.planId, bindingA);

      const outcomes = await Promise.allSettled([
        service.commit(plan.planId, bindingA, 'idem-winner'),
        service.commit(plan.planId, bindingA, 'idem-loser'),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((o) => o.status === 'rejected');
      expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject({
        code: 'plan_already_consumed',
      });
      expect(executor.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('expiry and retention', () => {
    it('rejects commit after the plan expiry instant [evidence:mcp.plan-desession]', async () => {
      const ctx = createService({ planTtlMilliseconds: 1000 });
      const plan = await ctx.service.plan(planRequest(), bindingA);
      await ctx.service.recordOutOfBandApproval(plan.planId, bindingA);
      ctx.advance(5000);
      await expect(ctx.service.commit(plan.planId, bindingA, 'idem-late')).rejects.toMatchObject({
        code: 'plan_expired',
      });
    });

    it('cleans consumed approvals and retained first results after idempotency retention [evidence:mcp.plan-desession]', async () => {
      let now = new Date('2026-07-16T07:00:00.000Z');
      const clock = { now: () => now };
      const approvalStore = createInMemoryApprovalStore({
        clock,
        idempotencyRetentionMs: 60_000,
      });
      const result = Object.freeze({
        planId: 'plan_retention',
        committedAt: '2026-07-16T07:00:00.000Z',
        operations: Object.freeze([]),
      });
      approvalStore.markApproved({
        planId: 'plan_retention',
        binding: bindingA,
        operationsDigest: 'sha-256:digest-retention',
      });
      await expect(approvalStore.beginCommit({
        planId: 'plan_retention',
        binding: bindingA,
        operationsDigest: 'sha-256:digest-retention',
        idempotencyKey: 'idem-retention',
      })).resolves.toEqual({ status: 'ready' });
      approvalStore.finalizeCommit({
        planId: 'plan_retention',
        idempotencyKey: 'idem-retention',
        result,
      });

      expect(approvalStore.stats()).toEqual({ approvals: 1, commitResults: 1, inflight: 0 });
      now = new Date('2026-07-16T07:02:00.000Z');
      expect(approvalStore.cleanup()).toEqual({
        approvals: 1,
        commitResults: 1,
        inflight: 0,
      });
      expect(approvalStore.stats()).toEqual({ approvals: 0, commitResults: 0, inflight: 0 });
    });
  });

  describe('current authorization recheck', () => {
    it('revalidates the current scope gate with the authenticated binding before execute [evidence:mcp.plan-desession]', async () => {
      const scopes = { hasScopes: vi.fn(async () => false) };
      const { service, executor } = createService({ scopes });
      const plan = await service.plan(planRequest(), bindingA);
      await service.recordOutOfBandApproval(plan.planId, bindingA);
      await expect(service.commit(plan.planId, bindingA, 'idem-scope')).rejects.toMatchObject({
        code: 'scope_invalid',
      });
      expect(scopes.hasScopes).toHaveBeenCalledWith(
        ['access:write'],
        bindingA,
      );
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it('rejects commit when the current rate-limit decision denies [evidence:mcp.plan-desession]', async () => {
      const rateLimit = { allowPlan: vi.fn(async () => true), allow: vi.fn(async () => false) };
      const { service, executor } = createService({ rateLimit });
      const plan = await service.plan(planRequest(), bindingA);
      await service.recordOutOfBandApproval(plan.planId, bindingA);
      await expect(service.commit(plan.planId, bindingA, 'idem-rate')).rejects.toMatchObject({
        code: 'rate_limited',
      });
      expect(rateLimit.allow).toHaveBeenCalledWith({
        planId: plan.planId,
        binding: bindingA,
      });
      expect(executor.execute).not.toHaveBeenCalled();
    });
  });

  describe('old row and old input rejection', () => {
    it('rejects a session-shaped binding input at plan creation [evidence:mcp.plan-desession]', async () => {
      const { service } = createService();
      await expect(
        service.plan(
          planRequest(),
          { subjectId: 'user-old', clientId: 'client-old', sessionId: 'session-old' } as never,
        ),
      ).rejects.toMatchObject({ code: 'plan_binding_mismatch' });
    });

    it('rejects an anonymous public binding from every authenticated entry point [evidence:mcp.plan-desession]', async () => {
      const { service } = createService();
      const anonymous = createAnonymousPublicBinding({
        resourceAudience: FIXTURE_RESOURCE_AUDIENCE,
        securityEpoch: FIXTURE_SECURITY_EPOCH,
      });
      await expect(service.plan(planRequest(), anonymous as never)).rejects.toMatchObject({
        code: 'plan_binding_mismatch',
      });
      const plan = await service.plan(planRequest(), bindingA);
      await expect(service.recordOutOfBandApproval(plan.planId, anonymous as never)).rejects
        .toMatchObject({ code: 'plan_binding_mismatch' });
      await expect(service.commit(plan.planId, anonymous as never, 'idem-anon')).rejects
        .toMatchObject({ code: 'plan_binding_mismatch' });
      await expect(service.cancel(plan.planId, anonymous as never)).rejects
        .toMatchObject({ code: 'plan_binding_mismatch' });
    });

    it('rejects an old session-shaped persisted plan row on approval and commit [evidence:mcp.plan-desession]', async () => {
      const { service, planStore } = createService();
      const now = '2026-07-16T07:00:00.000Z';
      const oldRow: McpStoredPlan = Object.freeze({
        planId: 'plan_old_row',
        expiresAt: '2026-07-16T07:15:00.000Z',
        risk: 'high',
        requiresApproval: true,
        summary: 'old row',
        impact: sampleImpact(),
        requiredScopes: Object.freeze(['access:write'] as const),
        baseRevisions: Object.freeze({ 'access.collection-1': 'acl_17' }),
        operations: Object.freeze([highRiskOp()]),
        operationsDigest: 'sha-256:old-row-digest',
        binding: Object.freeze({
          subjectId: 'user-old',
          clientId: 'client-old',
          sessionId: 'session-old',
        }) as never,
        untrustedNote: 'pre-migration persisted plan',
        createdAt: now,
        status: 'approved',
      });
      await planStore.save(oldRow);

      await expect(
        service.recordOutOfBandApproval('plan_old_row', bindingA),
      ).rejects.toMatchObject({ code: 'plan_binding_mismatch' });
      await expect(
        service.commit('plan_old_row', bindingA, 'idem-old-row'),
      ).rejects.toMatchObject({ code: 'plan_binding_mismatch' });
    });
  });

  describe('public type absence', () => {
    const changePlanSource = readFileSync(
      resolve(import.meta.dirname, '..', '..', 'src', 'mcp', 'change-plan.ts'),
      'utf8',
    );
    const mcpIndexSource = readFileSync(
      resolve(import.meta.dirname, '..', '..', 'src', 'mcp', 'index.ts'),
      'utf8',
    );

    it('removes session identifiers from the Plan/Approval core module [evidence:mcp.plan-desession]', () => {
      expect(changePlanSource).not.toMatch(/\bsessionId\b/u);
      expect(changePlanSource).not.toMatch(/\bMcpSessionBinding\b/u);
      expect(changePlanSource).not.toMatch(/\bMcpPlanBinding\b/u);
      expect(changePlanSource).toMatch(/\bMcpAuthenticatedAuthorizationBinding\b/u);
    });

    it('removes the legacy Plan/Approval surface from the public MCP boundary [evidence:mcp.plan-desession]', () => {
      // COLP-MCP-12: the /mcp entry only exports the completed Modern
      // Read/shared surface. The Plan/Approval core stays an internal module
      // and is never re-exported from the boundary.
      expect(mcpIndexSource).not.toContain("from './change-plan.js';");
      expect(mcpIndexSource).not.toContain("from './write-tools.js';");
      expect(mcpIndexSource).not.toContain("from './write-mount.js';");
      expect(mcpIndexSource).not.toMatch(/\bMcpPlanBinding\b/u);
      expect(mcpIndexSource).not.toMatch(/\bsessionId\b/u);
      expect(mcpIndexSource).not.toMatch(/\bMcpSessionBinding\b/u);
    });

    it('exports the authenticated authorization binding from the MCP boundary [evidence:mcp.plan-desession]', () => {
      expect(mcpBoundary).toHaveProperty('snapshotMcpAuthorizationBinding');
      expect(mcpBoundary).toHaveProperty('requireAuthenticatedWriteBinding');
      // Type-level proof: importing the type from the public MCP boundary only compiles when exported.
      const publicBinding: McpBoundaryAuthenticatedBinding = bindingA;
      expect(publicBinding).toEqual(bindingA);
      expect(mcpBoundary).not.toHaveProperty('McpPlanBinding');
    });

    it('surfaces binding mismatch as a stable McpChangePlanError code [evidence:mcp.plan-desession]', async () => {
      const { service } = createService();
      const plan = await service.plan(planRequest(), bindingA);
      await service.recordOutOfBandApproval(plan.planId, bindingA);
      try {
        await service.commit(plan.planId, otherBinding({ principalId: 'user-other' }), 'idem-x');
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(McpChangePlanError);
        expect((error as McpChangePlanError).code).toBe('plan_binding_mismatch');
      }
    });
  });
});
