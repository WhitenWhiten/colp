/**
 * COLP-MCP-13: Modern MCP 2026-07-28 Write adapter contracts (tests-first).
 *
 * The adapter maps the COLP-MCP-06 Write Gateway (changes.plan/commit/cancel,
 * keys.* and registered low-risk Tools) onto Modern `2026-07-28` results:
 *
 * - normal results are always `complete` (low-risk Tools, changes.cancel,
 *   approved commit receipts, tools/list);
 * - waiting for approval returns MRTR `input_required` carrying an
 *   `inputRequests` map (empty: COLP never elicits/samples/lists roots) and
 *   a server-minted `requestState` that associates the cross-request plan
 *   business state;
 * - retries echo `requestState` (+ optional `inputResponses`); the adapter
 *   verifies the state (HMAC, expiry, binding, method and input digest) and
 *   resumes the SAME plan instead of creating a new one;
 * - a fresh call without `requestState` always creates new business state;
 * - the core execution and idempotency semantics stay in the gateway
 *   (COLP-MCP-06) / change-plan service — this adapter is a thin result
 *   mapping and never re-implements them.
 */
import { describe, expect, it, vi } from 'vitest';

import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/core';

import { createInMemoryPlanStore } from '../../src/mcp/change-plan.js';
import type { Mcp20260728Result } from '../../src/mcp/2026-07-28/results.js';
import {
  harness,
  lowRiskDescriptor,
  planStatusResolver,
  commitInput,
  firstPlanResult,
  planRequest,
} from './mcp-2026-07-28-write-adapter-fixture.js';

function resultPlan(result: Mcp20260728Result): Readonly<Record<string, unknown>> {
  const plan = result.plan;
  expect(typeof plan).toBe('object');
  expect(plan).not.toBeNull();
  return plan as Readonly<Record<string, unknown>>;
}

describe('MCP 2026-07-28 Modern Write adapter — changes.plan MRTR [evidence:mcp.mrtr-contract]', () => {
  it('returns MRTR input_required with inputRequests, requestState and the plan on the first call', async () => {
    const { adapter, context, planStore } = harness();
    const result = await firstPlanResult(adapter, context);

    expect(result.resultType).toBe('input_required');
    expect(result.inputRequests).toEqual({});
    expect(typeof result.requestState).toBe('string');
    expect((result.requestState as string).length).toBeGreaterThan(0);
    expect(result.ttlMs).toBeUndefined();
    expect(result.cacheScope).toBeUndefined();
    expect(result._meta).toMatchObject({
      'io.modelcontextprotocol/serverInfo': { name: 'colp-write-test-server', version: '0.0.0' },
    });
    const plan = resultPlan(result);
    expect(plan).toMatchObject({
      planId: expect.any(String) as unknown,
      requiresApproval: true,
      risk: 'high',
      approvalMethod: 'out_of_band',
      approvalUri: expect.stringContaining('https://host.example/approvals/') as unknown,
    });
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
    expect(planStore.stats().plans).toBe(1);
  });

  it('same requestState retry while pending is idempotent: same plan, no second plan row', async () => {
    const { adapter, context, planStore } = harness();
    const first = await firstPlanResult(adapter, context);
    const firstPlan = resultPlan(first);
    const state = first.requestState as string;

    const retry = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: state,
    });
    expect(retry.resultType).toBe('input_required');
    expect(resultPlan(retry).planId).toBe(firstPlan.planId);
    expect(typeof retry.requestState).toBe('string');
    expect(planStore.stats().plans).toBe(1);

    const secondRetry = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: retry.requestState as string,
    });
    expect(resultPlan(secondRetry).planId).toBe(firstPlan.planId);
    expect(planStore.stats().plans).toBe(1);
  });

  it('same requestState retry after approval completes with the approved plan', async () => {
    const { adapter, context, planStore } = harness();
    const first = await firstPlanResult(adapter, context);
    const planId = resultPlan(first).planId as string;

    await adapter.recordOutOfBandApproval(planId, context);
    expect((await planStore.get(planId))?.status).toBe('approved');

    const retry = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: first.requestState as string,
    });
    expect(retry.resultType).toBe('complete');
    expect(retry.structuredContent).toMatchObject({ planId, requiresApproval: true });
    expect(retry.structuredContent).not.toHaveProperty('requestState');
    expect(CallToolResultSchema.safeParse(retry).success).toBe(true);
    expect(planStore.stats().plans).toBe(1);
  });

  it('expired plan retry rejects with a stable plan_expired invalid_params error', async () => {
    let nowMs = Date.parse('2026-07-16T07:00:00.000Z');
    const planStore = createInMemoryPlanStore();
    const { adapter, context } = harness({
      planStore,
      // Share one clock between the change-plan service (plan expiresAt) and
      // the plan-status resolver so advancing it makes the stored plan expire.
      changePlanClock: { now: () => new Date(nowMs) },
      resolvePlan: planStatusResolver(planStore, () => nowMs),
    });
    const first = await firstPlanResult(adapter, context);
    const planId = resultPlan(first).planId as string;
    nowMs = Date.parse('2026-07-16T07:30:00.000Z');

    const error = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: first.requestState as string,
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
    expect(error).toMatchObject({ data: { code: 'plan_expired' } });
    void planId;
  });

  it('a fresh changes.plan call without requestState always creates new business state', async () => {
    const { adapter, context, planStore } = harness();
    const first = await firstPlanResult(adapter, context);
    const second = await firstPlanResult(adapter, context);

    expect(resultPlan(first).planId).not.toBe(resultPlan(second).planId);
    expect(planStore.stats().plans).toBe(2);
  });

  it('reusing a requestState with different arguments is rejected (input digest bound)', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const state = first.requestState as string;

    const error = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(Object.freeze({
        type: 'set_visibility' as const,
        collectionId: 'collection-1',
        baseRevision: 'acl_17',
        input: Object.freeze({ visibility: 'private' as const }),
      })),
      requestState: state,
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
    expect(error).toMatchObject({ data: { code: 'request_state_mismatch' } });
  });

  it('a plan in an unknown outcome rejects with plan_not_found', async () => {
    const { adapter, context } = harness({
      resolvePlan: { resolvePlan: async () => Object.freeze({ status: 'unknown' }) },
    });
    const first = await firstPlanResult(adapter, context);
    const state = first.requestState as string;

    const error = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: state,
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
    expect(error).toMatchObject({ data: { code: 'plan_not_found' } });
  });
});

describe('MCP 2026-07-28 Modern Write adapter — changes.commit/cancel [evidence:mcp.mrtr-contract]', () => {
  it('changes.commit on a pending plan returns input_required with requestState + plan', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const planId = resultPlan(first).planId as string;

    const result = await adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId),
    });
    expect(result.resultType).toBe('input_required');
    expect(result.inputRequests).toEqual({});
    expect(typeof result.requestState).toBe('string');
    expect(resultPlan(result).planId).toBe(planId);
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });

  it('changes.commit after approval completes with the commit receipt', async () => {
    const executor = {
      execute: vi.fn(async () => [Object.freeze({
        opId: 'op-commit-1',
        sequence: 1,
        status: 'applied' as const,
        revision: 'r-commit-1',
        cursor: 'cur-commit-1',
        warnings: Object.freeze([]) as readonly [],
      })]),
    };
    const { adapter, context } = harness({ executor });
    const first = await firstPlanResult(adapter, context);
    const planId = resultPlan(first).planId as string;
    await adapter.recordOutOfBandApproval(planId, context);

    const result = await adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId, 'idem-commit-1'),
    });
    expect(result.resultType).toBe('complete');
    expect(result.structuredContent).toMatchObject({
      planId,
      committedAt: expect.any(String) as unknown,
    });
    expect(Array.isArray((result.structuredContent as Readonly<Record<string, unknown>>).operations)).toBe(true);
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('changes.commit retry with the same requestState replays idempotently after approval', async () => {
    const executor = {
      execute: vi.fn(async () => [Object.freeze({
        opId: 'op-replay-1',
        sequence: 1,
        status: 'applied' as const,
        revision: 'r-replay-1',
        cursor: 'cur-replay-1',
        warnings: Object.freeze([]) as readonly [],
      })]),
    };
    const { adapter, context } = harness({ executor });
    const first = await firstPlanResult(adapter, context);
    const planId = resultPlan(first).planId as string;

    const waiting = await adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId, 'idem-replay-1'),
    });
    expect(waiting.resultType).toBe('input_required');
    const commitState = waiting.requestState as string;

    await adapter.recordOutOfBandApproval(planId, context);

    const completed = await adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId, 'idem-replay-1'),
      requestState: commitState,
    });
    expect(completed.resultType).toBe('complete');
    expect(completed.structuredContent).toMatchObject({ planId });

    const replay = await adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId, 'idem-replay-1'),
      requestState: commitState,
    });
    expect(replay.resultType).toBe('complete');
    expect(replay.structuredContent).toEqual(completed.structuredContent);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('changes.commit with a different idempotency key after consumption is rejected', async () => {
    const executor = {
      execute: vi.fn(async () => [Object.freeze({
        opId: 'op-idem-1',
        sequence: 1,
        status: 'applied' as const,
        revision: 'r-idem-1',
        cursor: 'cur-idem-1',
        warnings: Object.freeze([]) as readonly [],
      })]),
    };
    const { adapter, context } = harness({ executor });
    const first = await firstPlanResult(adapter, context);
    const planId = resultPlan(first).planId as string;
    await adapter.recordOutOfBandApproval(planId, context);

    await adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId, 'idem-first'),
    });
    const error = await adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId, 'idem-second'),
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
    expect(error).toMatchObject({ data: { code: 'plan_already_consumed' } });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('changes.cancel completes with the cancelled status', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const planId = resultPlan(first).planId as string;

    const result = await adapter.callTool(context, {
      name: 'changes.cancel',
      arguments: { planId },
    });
    expect(result.resultType).toBe('complete');
    expect(result.structuredContent).toEqual({ planId, status: 'cancelled' });
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });
});

describe('MCP 2026-07-28 Modern Write adapter — low-risk Tools and risk [evidence:mcp.mrtr-contract]', () => {
  it('low-risk write Tool returns a complete result', async () => {
    const invoke = vi.fn(() => ({ ok: true, mode: 'private' }));
    const { adapter, context } = harness({
      lowRiskTools: { 'custom.write': lowRiskDescriptor({ invoke }) },
    });

    const result = await adapter.callTool(context, {
      name: 'custom.write',
      arguments: { mode: 'private' },
    });
    expect(result.resultType).toBe('complete');
    expect(result.structuredContent).toEqual({ ok: true, mode: 'private' });
    expect(result.inputRequests).toBeUndefined();
    expect(result.requestState).toBeUndefined();
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('high-risk one-shot low-risk Tool fails closed with a complete isError result', async () => {
    const invoke = vi.fn(() => ({ ok: true }));
    const { adapter, context } = harness({
      lowRiskTools: {
        'custom.write': lowRiskDescriptor({
          invoke,
          toCanonicalOperations: () => [{
            type: 'delete_collection',
            collectionId: 'collection-1',
            baseRevision: 'r1',
          }],
        }),
      },
    });

    const result = await adapter.callTool(context, {
      name: 'custom.write',
      arguments: { mode: 'private' },
    });
    expect(result.resultType).toBe('complete');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: 'high_risk_requires_plan',
      assessment: { level: 'high', requiresPlan: true },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('unknown write Tool maps to a stable invalid_params error', async () => {
    const { adapter, context } = harness();
    const error = await adapter.callTool(context, {
      name: 'changes.missing',
      arguments: {},
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
  });
});

describe('MCP 2026-07-28 Modern Write adapter — tools/list [evidence:mcp.mrtr-contract]', () => {
  it('listTools returns a deterministically ordered complete tools result', async () => {
    const { adapter, context: baseContext } = harness();
    const context = Object.freeze({ ...baseContext, scope: Object.freeze(['access:write']) });
    const result = await adapter.listTools(context, {});

    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe('private');
    const names = (result.tools as ReadonlyArray<{ readonly name: string }>).map((tool) => tool.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(['changes.plan', 'changes.commit', 'changes.cancel']));
    expect(ListToolsResultSchema.safeParse(result).success).toBe(true);
  });

  it('listTools rejects a malformed cursor as invalid_params', async () => {
    const { adapter, context } = harness();
    const error = await adapter.listTools(context, { cursor: 42 })
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
  });
});


