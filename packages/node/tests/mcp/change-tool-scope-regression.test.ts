import { describe, expect, it, vi } from 'vitest';

import { createMcpWriteToolGateway, McpWriteToolScopeDeniedError } from '../../src/mcp/write-tools.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import {
  changePlanOptions, createContext, DEFAULT_BUDGET, harness, planRequest,
} from './mcp-2026-07-28-write-adapter-fixture.js';

const binding = authenticatedBinding();
const context = (scope: readonly string[]) => ({
  binding, scope, budget: DEFAULT_BUDGET,
  authorization: {}, abortSignal: new AbortController().signal,
});
const writeContext = context(['access:write']);
const executor = () => ({ execute: vi.fn(async () => [{
  opId: 'op-1', sequence: 1, status: 'applied' as const,
  revision: 'r2', cursor: 'cur-1', warnings: [],
}]) });

describe('changes.* require their advertised scope on every invocation', () => {
  it.each([{ scope: [] }, { scope: ['access:read'] }, { scope: ['collections:delete'] }])(
    'rejects plan, approved commit and cancel in the gateway with scopes %j', async ({ scope }) => {
      const execute = executor();
      const options = changePlanOptions({ executor: execute });
      const gateway = createMcpWriteToolGateway({ changePlan: options });
      const denied = context(scope);
      expect(gateway.listTools(denied)).toEqual([]);
      await expect(gateway.callTool('changes.plan', planRequest(), denied))
        .rejects.toBeInstanceOf(McpWriteToolScopeDeniedError);
      expect(options.impact.assessImpact).not.toHaveBeenCalled();

      const plan = await gateway.callTool('changes.plan', planRequest(), writeContext);
      const planId = (plan.structuredContent as { planId: string }).planId;
      await gateway.recordOutOfBandApproval(planId, writeContext);
      await expect(gateway.callTool('changes.commit', { planId, idempotencyKey: 'commit' }, denied))
        .rejects.toBeInstanceOf(McpWriteToolScopeDeniedError);
      await expect(gateway.callTool('changes.cancel', { planId }, denied))
        .rejects.toBeInstanceOf(McpWriteToolScopeDeniedError);
      expect(execute.execute).not.toHaveBeenCalled();
      expect(options.scopes.hasScopes).not.toHaveBeenCalled();
      expect((await options.planStore.get(planId))?.status).toBe('approved');
      await expect(gateway.callTool('changes.commit', { planId, idempotencyKey: 'commit' }, writeContext))
        .resolves.toMatchObject({ structuredContent: { planId } });
      expect(execute.execute).toHaveBeenCalledOnce();
    },
  );

  it('denies Modern fresh calls and MRTR retries before querying plan status', async () => {
    const execute = executor();
    const resolvePlan = vi.fn(async () => ({ status: 'unknown' as const }));
    const { adapter, planStore } = harness({ binding, executor: execute, resolvePlan: { resolvePlan } });
    const allowed = createContext(binding, { scope: ['access:write'] });
    const denied = createContext(binding, { scope: ['access:read'] });
    const plan = await adapter.callTool(allowed, { name: 'changes.plan', arguments: planRequest() });
    const planId = (plan.plan as { planId: string }).planId;
    await adapter.recordOutOfBandApproval(planId, allowed);
    const calls = [
      { name: 'changes.plan', arguments: planRequest() },
      { name: 'changes.plan', arguments: planRequest(), requestState: plan.requestState },
      { name: 'changes.commit', arguments: { planId, idempotencyKey: 'commit' } },
      { name: 'changes.cancel', arguments: { planId } },
    ];
    expect((await adapter.listTools(denied)).tools).toEqual([]);
    for (const call of calls) {
      await expect(adapter.callTool(denied, call))
        .rejects.toMatchObject({ data: { code: 'tool_scope_denied' } });
    }
    expect(resolvePlan).not.toHaveBeenCalled();
    expect(execute.execute).not.toHaveBeenCalled();
    expect((await planStore.get(planId))?.status).toBe('approved');
  });
});
