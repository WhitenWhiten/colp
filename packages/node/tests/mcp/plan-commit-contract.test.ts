import { describe, expect, it, vi } from 'vitest';

import {
  computeOperationsDigest,
  createChangePlanService,
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
  type McpChangePlanExecutorPort,
} from '../../src/mcp/change-plan.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import {
  canonicalApiKeyCreateResultFixture,
  canonicalApiKeyMetadataFixture,
} from './canonical-api-key-fixture.js';

const bindingA = authenticatedBinding({
  principalId: 'user-a',
  clientId: 'client-a',
});

const bindingB = authenticatedBinding({
  principalId: 'user-b',
  clientId: 'client-a',
});

function highRiskOp() {
  return Object.freeze({
    type: 'set_visibility' as const,
    collectionId: 'collection-1',
    baseRevision: 'acl_17',
    input: Object.freeze({ visibility: 'public' as const }),
  });
}

function planRequest(operations = [highRiskOp()]) {
  return {
    operations,
    reason: 'User asked to publish the collection',
    dryRun: true as const,
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
  const impact = {
    assessImpact: vi.fn(async () => sampleImpact()),
  };
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
  const scopes = {
    hasScopes: vi.fn(async () => true),
  };
  const authorizationPolicy = {
    requiredScopesForOperation: vi.fn(async () => []),
  };
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
  const rateLimit = {
    allow: vi.fn(async () => true),
  };
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

describe('MCP-0004 plan commit [evidence:mcp.plan-commit]', () => {
  it('keeps the change plan service importable from its module [evidence:mcp.plan-commit]', () => {
    expect(typeof createChangePlanService).toBe('function');
    expect(typeof computeOperationsDigest).toBe('function');
  });

  it('creates a typed high-risk plan with out-of-band approval URI [evidence:mcp.plan-commit]', async () => {
    const { service } = createService();
    const plan = await service.plan(planRequest(), bindingA);

    expect(plan.planId).toBe('plan_01JZTEST');
    expect(plan.risk).toBe('high');
    expect(plan.requiresApproval).toBe(true);
    expect(plan.approvalMethod).toBe('out_of_band');
    expect(plan.approvalUri).toBe('https://alice.example/collections/approvals/plan_01JZTEST');
    expect(plan.baseRevisions['access.collection-1']).toBe('acl_17');
    expect(plan.summary).toContain('set_visibility');
  });

  it('applies plan admission before assessment work [evidence:mcp.plan-commit]', async () => {
    const allowPlan = vi.fn(async () => false);
    const { service, impact } = createService({
      rateLimit: { allowPlan, allow: vi.fn(async () => true) },
    });
    await expect(service.plan(planRequest(), bindingA)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(allowPlan).toHaveBeenCalledWith({ binding: bindingA });
    expect(impact.assessImpact).not.toHaveBeenCalled();
  });

  it('rejects open payload operations [evidence:mcp.plan-commit]', async () => {
    const { service } = createService();
    await expect(
      service.plan(
        {
          operations: [
            {
              type: 'custom',
              payload: { do: 'something dangerous' },
            },
          ],
          reason: 'guess',
          dryRun: true,
        },
        bindingA,
      ),
    ).rejects.toMatchObject({ code: 'open_payload_rejected' });
  });

  it('rejects schema-invalid typed operations [evidence:mcp.plan-commit]', async () => {
    const { service } = createService();
    await expect(
      service.plan(
        {
          operations: [{ type: 'set_visibility', collectionId: 'c1' }],
          reason: 'missing fields',
          dryRun: true,
        },
        bindingA,
      ),
    ).rejects.toMatchObject({ code: 'invalid_plan_request' });
  });

  it('rejects commit without out-of-band approval [evidence:mcp.plan-commit]', async () => {
    const { service } = createService();
    const plan = await service.plan(planRequest(), bindingA);
    await expect(service.commit(plan.planId, bindingA, 'idem-1')).rejects.toMatchObject({
      code: 'approval_missing',
    });
  });

  it('rejects cross-principal planId commit [evidence:mcp.plan-commit]', async () => {
    const { service } = createService();
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    await expect(service.commit(plan.planId, bindingB, 'idem-1')).rejects.toMatchObject({
      code: 'plan_binding_mismatch',
    });
  });

  it('rejects commit when the credential binding differs [evidence:mcp.plan-commit]', async () => {
    const { service } = createService();
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    await expect(
      service.commit(
        plan.planId,
        Object.freeze({ ...bindingA, credentialBindingId: 'other-credential' }),
        'idem-1',
      ),
    ).rejects.toMatchObject({ code: 'plan_binding_mismatch' });
  });

  it('commits once after approval and returns the applied result [evidence:mcp.plan-commit]', async () => {
    const { service, executor } = createService();
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    const result = await service.commit(plan.planId, bindingA, 'idem-commit-1');

    expect(result.planId).toBe(plan.planId);
    expect(result.committedAt).toBe('2026-07-16T07:00:00.000Z');
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('replays the first result after execute advances authoritative revision without mutable revalidation [evidence:mcp.plan-commit]', async () => {
    const {
      service,
      executor,
      authoritativeRevisions,
      scopes,
      revisions,
      impact,
      rateLimit,
    } = createService();
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    const first = await service.commit(plan.planId, bindingA, 'idem-same');
    expect(authoritativeRevisions.get('access.collection-1')).toBe('r_1043');

    const mutablePortCallsAfterFirstCommit = {
      scopes: scopes.hasScopes.mock.calls.length,
      revisions: revisions.currentRevisions.mock.calls.length,
      impact: impact.assessImpact.mock.calls.length,
      rateLimit: rateLimit.allow.mock.calls.length,
    };
    const second = await service.commit(plan.planId, bindingA, 'idem-same');

    expect(second).toEqual(first);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(scopes.hasScopes).toHaveBeenCalledTimes(mutablePortCallsAfterFirstCommit.scopes);
    expect(revisions.currentRevisions).toHaveBeenCalledTimes(
      mutablePortCallsAfterFirstCommit.revisions,
    );
    expect(impact.assessImpact).toHaveBeenCalledTimes(mutablePortCallsAfterFirstCommit.impact);
    expect(rateLimit.allow).toHaveBeenCalledTimes(mutablePortCallsAfterFirstCommit.rateLimit);
  });

  it('rejects a different idempotency key after execute advances authoritative revision [evidence:mcp.plan-commit]', async () => {
    const { service, executor, authoritativeRevisions, scopes, revisions, impact, rateLimit } =
      createService();
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    await service.commit(plan.planId, bindingA, 'idem-first');
    expect(authoritativeRevisions.get('access.collection-1')).toBe('r_1043');

    const mutablePortCallsAfterFirstCommit = {
      scopes: scopes.hasScopes.mock.calls.length,
      revisions: revisions.currentRevisions.mock.calls.length,
      impact: impact.assessImpact.mock.calls.length,
      rateLimit: rateLimit.allow.mock.calls.length,
    };
    await expect(service.commit(plan.planId, bindingA, 'idem-second')).rejects.toMatchObject({
      code: 'plan_already_consumed',
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(scopes.hasScopes).toHaveBeenCalledTimes(mutablePortCallsAfterFirstCommit.scopes);
    expect(revisions.currentRevisions).toHaveBeenCalledTimes(
      mutablePortCallsAfterFirstCommit.revisions,
    );
    expect(impact.assessImpact).toHaveBeenCalledTimes(mutablePortCallsAfterFirstCommit.impact);
    expect(rateLimit.allow).toHaveBeenCalledTimes(mutablePortCallsAfterFirstCommit.rateLimit);
  });

  it('rejects commit after plan expiry [evidence:mcp.plan-commit]', async () => {
    const ctx = createService({ planTtlMilliseconds: 1000 });
    const plan = await ctx.service.plan(planRequest(), bindingA);
    await ctx.service.recordOutOfBandApproval(plan.planId, bindingA);
    ctx.advance(5000);
    await expect(ctx.service.commit(plan.planId, bindingA, 'idem-late')).rejects.toMatchObject({
      code: 'plan_expired',
    });
  });

  it('rejects commit on base revision drift [evidence:mcp.plan-commit]', async () => {
    const revisions = {
      resolveBaseRevisions: vi.fn(async (operation) => resolveFixtureBaseRevisions(operation)),
      currentRevisions: vi.fn(async () => ({
        'access.collection-1': 'acl_99',
      })),
    };
    const { service } = createService({ revisions });
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    await expect(service.commit(plan.planId, bindingA, 'idem-drift')).rejects.toMatchObject({
      code: 'revision_drift',
    });
  });

  it('rejects commit when scopes are no longer valid [evidence:mcp.plan-commit]', async () => {
    const scopes = { hasScopes: vi.fn(async () => false) };
    const { service } = createService({ scopes });
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    await expect(service.commit(plan.planId, bindingA, 'idem-scope')).rejects.toMatchObject({
      code: 'scope_invalid',
    });
  });

  it('rejects commit when impact exceeds the plan [evidence:mcp.plan-commit]', async () => {
    let call = 0;
    const impact = {
      assessImpact: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return {
            collections: 1,
            nodes: 10,
            annotations: 0,
            attachments: 0,
            relations: 0,
            privateFieldsExcluded: [] as string[],
          };
        }
        return {
          collections: 1,
          nodes: 999,
          annotations: 0,
          attachments: 0,
          relations: 0,
          privateFieldsExcluded: [] as string[],
        };
      }),
    };
    const { service } = createService({ impact });
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    await expect(service.commit(plan.planId, bindingA, 'idem-impact')).rejects.toMatchObject({
      code: 'impact_exceeded',
    });
  });

  it('rejects commit when live impact drops an approved private-field exclusion', async () => {
    let call = 0;
    const impact = {
      assessImpact: vi.fn(async () => {
        call += 1;
        return {
          collections: 1,
          nodes: 10,
          annotations: 0,
          attachments: 0,
          relations: 0,
          privateFieldsExcluded: call === 1 ? ['sourceRefs'] as string[] : [] as string[],
        };
      }),
    };
    const { service } = createService({ impact });
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    await expect(service.commit(plan.planId, bindingA, 'idem-private-fields')).rejects.toMatchObject({
      code: 'impact_exceeded',
    });
  });

  it('cancels a pending plan for the bound principal [evidence:mcp.plan-commit]', async () => {
    const { service } = createService();
    const plan = await service.plan(planRequest(), bindingA);
    const cancelled = await service.cancel(plan.planId, bindingA);
    expect(cancelled).toEqual({ planId: plan.planId, status: 'cancelled' });
    await expect(service.commit(plan.planId, bindingA, 'idem-x')).rejects.toMatchObject({
      code: 'approval_missing',
    });
  });

  it('computes a stable canonical operations digest [evidence:mcp.plan-commit]', () => {
    const ops = [highRiskOp()];
    expect(computeOperationsDigest(ops)).toBe(computeOperationsDigest(ops));
    expect(computeOperationsDigest(ops)).toMatch(/^sha-256:/);
  });

  it('does not expose model-mintable approve boolean on plan tool path [evidence:mcp.plan-commit]', async () => {
    const { service } = createService();
    // Even if a client tries to smuggle approved:true into the plan request, schema rejects extra props.
    await expect(
      service.plan(
        {
          ...planRequest(),
          approved: true,
          approvalSecret: 'nope',
        },
        bindingA,
      ),
    ).rejects.toMatchObject({ code: 'invalid_plan_request' });
  });

  it('rejects commit when rate limit denies [evidence:mcp.plan-commit]', async () => {
    const rateLimit = { allowPlan: vi.fn(async () => true), allow: vi.fn(async () => false) };
    const { service } = createService({ rateLimit });
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    await expect(service.commit(plan.planId, bindingA, 'idem-rate')).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(rateLimit.allow).toHaveBeenCalled();
  });

  it('does not burn approval when execute fails; retry succeeds [evidence:mcp.plan-commit]', async () => {
    let attempts = 0;
    const executor = {
      execute: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('transient executor failure');
        }
        return [
          {
            opId: 'op-1',
            sequence: 1,
            status: 'applied' as const,
            revision: 'r_1043',
            cursor: 'cur_1',
            warnings: [] as [],
          },
        ];
      }),
    };
    const { service } = createService({ executor });
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);

    await expect(service.commit(plan.planId, bindingA, 'idem-retry')).rejects.toMatchObject({
      code: 'commit_failed',
    });
    // Same approval still valid; same idempotency key can retry after abort.
    const result = await service.commit(plan.planId, bindingA, 'idem-retry');
    expect(result.planId).toBe(plan.planId);
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('concurrent same idempotency key: executor once, both return firstResult [evidence:mcp.plan-commit]', async () => {
    let executes = 0;
    let enteredExecute = 0;
    let releaseExecute!: () => void;
    const executeHold = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    const executor = {
      execute: vi.fn(async () => {
        enteredExecute += 1;
        executes += 1;
        // Hold the leader in execute so a concurrent peer must single-flight join.
        await executeHold;
        return [
          {
            opId: 'op-1',
            sequence: 1,
            status: 'applied' as const,
            revision: 'r_concurrent',
            cursor: 'cur_concurrent',
            warnings: [] as [],
          },
        ];
      }),
    };
    const {
      service,
      authoritativeRevisions,
      scopes,
      revisions,
      impact,
      rateLimit,
    } = createService({ executor });
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);

    const key = 'idem-concurrent-same';
    // Honest concurrent race: both commits start before either finishes execute.
    const raced = Promise.all([
      service.commit(plan.planId, bindingA, key),
      service.commit(plan.planId, bindingA, key),
    ]);

    // Wait until the single leader has entered execute (proves peer is blocked on join).
    const deadline = Date.now() + 2000;
    while (enteredExecute === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(enteredExecute).toBe(1);
    releaseExecute();

    const results = await raced;
    expect(executes).toBe(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.planId).toBe(plan.planId);
    expect(results[0]?.operations[0]).toMatchObject({
      status: 'applied',
      revision: 'r_concurrent',
    });

    // Post-success sequential replay still returns the same firstResult without re-execute.
    expect(authoritativeRevisions.get('access.collection-1')).toBe('r_concurrent');
    const mutablePortCallsAfterRace = {
      scopes: scopes.hasScopes.mock.calls.length,
      revisions: revisions.currentRevisions.mock.calls.length,
      impact: impact.assessImpact.mock.calls.length,
      rateLimit: rateLimit.allow.mock.calls.length,
    };
    const replay = await service.commit(plan.planId, bindingA, key);
    expect(replay).toEqual(results[0]);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(scopes.hasScopes).toHaveBeenCalledTimes(mutablePortCallsAfterRace.scopes);
    expect(revisions.currentRevisions).toHaveBeenCalledTimes(
      mutablePortCallsAfterRace.revisions,
    );
    expect(impact.assessImpact).toHaveBeenCalledTimes(mutablePortCallsAfterRace.impact);
    expect(rateLimit.allow).toHaveBeenCalledTimes(mutablePortCallsAfterRace.rateLimit);
  });

  it('concurrent different idempotency keys: one executes and the loser is rejected [evidence:mcp.plan-commit]', async () => {
    let enteredExecute!: () => void;
    const executeEntered = new Promise<void>((resolve) => {
      enteredExecute = resolve;
    });
    let releaseExecute!: () => void;
    const executeHold = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    const executor = {
      execute: vi.fn(async () => {
        enteredExecute();
        await executeHold;
        return [{
          opId: 'op-different-key-winner',
          sequence: 1,
          status: 'applied' as const,
          revision: 'r_different_key_winner',
          cursor: 'cur_different_key_winner',
          warnings: [] as [],
        }];
      }),
    };
    const { service } = createService({ executor });
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);

    const winner = service.commit(plan.planId, bindingA, 'idem-different-winner');
    await executeEntered;
    const loser = service.commit(plan.planId, bindingA, 'idem-different-loser');

    await expect(loser).rejects.toMatchObject({ code: 'plan_already_consumed' });
    expect(executor.execute).toHaveBeenCalledOnce();
    releaseExecute();
    await expect(winner).resolves.toMatchObject({
      planId: plan.planId,
      operations: [expect.objectContaining({ revision: 'r_different_key_winner' })],
    });
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('redacts secrets from commit results before return and idempotent replay [evidence:mcp.plan-commit]', async () => {
    const canonicalKey = canonicalApiKeyCreateResultFixture(
      canonicalApiKeyMetadataFixture({
        id: 'key_secret_plan',
        name: 'reader',
        type: 'read_key',
        scopes: ['collections:read'],
        collections: [],
        createdAt: '2026-07-16T07:00:00Z',
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        status: 'active',
      }),
      'colp_live_must_not_leak',
    );
    const executor = {
      execute: vi.fn(async () => [
        {
          opId: 'op-key',
          sequence: 1,
          status: 'applied' as const,
          revision: 'r_1',
          cursor: 'c_1',
          warnings: [] as [],
          transform: canonicalKey,
        },
      ]),
    };
    const { service } = createService({
      executor,
      revealUriForKey: (keyId: string) =>
        `https://alice.example/collections/keys/${keyId}/reveal`,
    });
    const plan = await service.plan(
      {
        operations: [
          Object.freeze({
            type: 'create_key' as const,
            input: Object.freeze({
              name: 'reader',
              type: 'read_key' as const,
              scopes: ['collections:read'],
              collections: [] as string[],
              expiresAt: null,
            }),
          }),
        ],
        reason: 'create key with secret in executor result',
        dryRun: true as const,
      },
      bindingA,
    );
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    const first = await service.commit(plan.planId, bindingA, 'idem-secret');
    const second = await service.commit(plan.planId, bindingA, 'idem-secret');

    for (const result of [first, second]) {
      const json = JSON.stringify(result);
      expect(json).not.toContain('colp_live_must_not_leak');
      expect(json).not.toContain('"secret"');
      expect(result.operations[0]?.transform).toEqual({
        keyId: 'key_secret_plan',
        name: 'reader',
        type: 'read_key',
        scopes: ['collections:read'],
        collections: [],
        createdAt: '2026-07-16T07:00:00Z',
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        status: 'active',
        secretAvailable: true,
        revealUri: 'https://alice.example/collections/keys/key_secret_plan/reveal',
      });
    }
    expect(second).toEqual(first);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
