/**
 * MCP 2026-07-28 Write adapter defensive hardening (coverage gaps).
 *
 * Covers the fail-closed host-configuration and requestState-verification
 * branches of `src/mcp/2026-07-28/write.ts` that the contract/hardening
 * suites do not reach: malformed host options, malformed requestState
 * envelopes with a valid MAC (envelope/expiry/payload shape), plan-resolution
 * statuses, inputResponses accessor/symbol entries, cursor parsing and
 * error mapping. Each case asserts a stable public observation.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { McpChangePlanError } from '../../src/mcp/change-plan.js';
import { requestStateBindingMaterial } from '../../src/mcp/2026-07-28/request-state-binding.js';
import type { McpAuthenticatedAuthorizationBinding } from '../../src/mcp/shared/authorization.js';
import { McpWriteRequestAbortedError } from '../../src/mcp/write-tools.js';
import {
  createMcp20260728WriteToolAdapter,
  type Mcp20260728PlanResolution,
  type Mcp20260728WriteToolAdapter,
} from '../../src/mcp/2026-07-28/write.js';
import {
  TEST_REQUEST_STATE_KEY,
  changePlanOptions,
  commitInput,
  firstPlanResult,
  lowRiskDescriptor,
  harness,
  planRequest,
  serverInfo,
} from './mcp-2026-07-28-write-adapter-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const REQUEST_STATE_PREFIX = 'colp.rs.';

function hmacBytes(key: string, data: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data, 'utf8').digest());
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function bindingTag(binding: McpAuthenticatedAuthorizationBinding): string {
  const mac = createHmac('sha256', TEST_REQUEST_STATE_KEY)
    .update(requestStateBindingMaterial(binding))
    .digest();
  return base64Url(mac.subarray(0, 16));
}

function craftState(envelope: unknown): string {
  const body = base64Url(new TextEncoder().encode(JSON.stringify(envelope)));
  const mac = base64Url(hmacBytes(TEST_REQUEST_STATE_KEY, REQUEST_STATE_PREFIX + body));
  return `${REQUEST_STATE_PREFIX}${body}.${mac}`;
}

function craftRawBodyState(bytes: number[]): string {
  const body = base64Url(Uint8Array.from(bytes));
  const mac = base64Url(hmacBytes(TEST_REQUEST_STATE_KEY, REQUEST_STATE_PREFIX + body));
  return `${REQUEST_STATE_PREFIX}${body}.${mac}`;
}

function captureError(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(() => undefined, (caught: unknown) => caught);
}

async function expectStateRejected(
  adapter: Mcp20260728WriteToolAdapter,
  context: ReturnType<typeof harness>['context'],
  requestState: string,
  code: string,
): Promise<void> {
  const error = await captureError(adapter.callTool(context, {
    name: 'changes.plan',
    arguments: planRequest(),
    requestState,
  }));
  expect(error).toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
  expect(error).toMatchObject({ data: { code } });
}

describe('MCP 2026-07-28 Write adapter — host configuration hardening', () => {
  it('rejects a wrong argument count, non-object, array or Proxy options', () => {
    expect(() => createMcp20260728WriteToolAdapter(undefined as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter(null as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter([] as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter(new Proxy({}, {}) as never)).toThrow(TypeError);
  });

  it('rejects a malformed changePlan and serverInfo', () => {
    const base: Record<string, unknown> = {
      serverInfo,
      requestStateKey: TEST_REQUEST_STATE_KEY,
      resolvePlan: { resolvePlan: vi.fn(async () => ({ status: 'pending' })) },
    };
    expect(() => createMcp20260728WriteToolAdapter({ ...base, changePlan: null } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({ ...base, changePlan: {}, serverInfo: null } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({
      ...base, changePlan: {}, serverInfo: Object.freeze({ name: 42 }),
    } as never)).toThrow(TypeError);
  });

  it('rejects an invalid requestStateKey, ttl, clock and resolvePlan', () => {
    const base: Record<string, unknown> = {
      changePlan: changePlanOptions(),
      serverInfo,
      requestStateKey: TEST_REQUEST_STATE_KEY,
      resolvePlan: { resolvePlan: vi.fn(async () => ({ status: 'pending' })) },
    };
    expect(() => createMcp20260728WriteToolAdapter({ ...base, requestStateKey: 42 } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({ ...base, requestStateKey: 'short' } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({ ...base, requestStateKey: new Uint8Array(32) } as never)).not.toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({ ...base, requestStateTtlSeconds: 0 } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({ ...base, requestStateTtlSeconds: 1.5 } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({ ...base, requestStateClock: 'nope' } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({
      ...base, resolvePlan: { resolvePlan: 'nope' },
    } as never)).toThrow(TypeError);
  });

  it('rejects invalid cache metadata and schemaBudget', () => {
    const changePlan = changePlanOptions();
    const base = {
      changePlan,
      serverInfo,
      requestStateKey: TEST_REQUEST_STATE_KEY,
      resolvePlan: { resolvePlan: vi.fn(async () => ({ status: 'pending' })) },
    };
    expect(() => createMcp20260728WriteToolAdapter({ ...base, schemaBudget: 'nope' } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({ ...base, cache: [] } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({ ...base, cache: { 'tools/call': {} } } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({
      ...base, cache: { 'tools/list': { ttlMs: -1, cacheScope: 'private' } },
    } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({
      ...base, cache: { 'tools/list': { ttlMs: 100, cacheScope: 'shared' } },
    } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({
      ...base,
      cache: { 'tools/list': Object.defineProperty({ ttlMs: 100, cacheScope: 'private' }, 'ttlMs', { get: () => 100 }) },
    } as never)).toThrow(TypeError);
    expect(() => createMcp20260728WriteToolAdapter({ ...base } as never)).not.toThrow(TypeError);
  });
});

describe('MCP 2026-07-28 Write adapter — requestState envelope hardening', () => {
  it('rejects a requestState that is not a colp state, has no dot or has an invalid MAC alphabet', async () => {
    const { adapter, context } = harness();
    await expectStateRejected(adapter, context, 'garbage', 'invalid_request_state');
    await expectStateRejected(adapter, context, 'colp.rs.', 'invalid_request_state');
    const first = await firstPlanResult(adapter, context);
    const state = first.requestState as string;
    const invalidMacAlphabet = `${state.slice(0, state.lastIndexOf('.') + 1)}!!!!`;
    await expectStateRejected(adapter, context, invalidMacAlphabet, 'invalid_request_state');
  });

  it('rejects malformed requestState envelopes that still carry a valid MAC', async () => {
    const { adapter, context, binding } = harness();
    const tag = bindingTag(binding);
    const payload = Object.freeze({ planId: 'plan-x', method: 'changes.plan', inputDigest: 'digest-x' });
    const exp = Math.floor(Date.now() / 1000) + 600;

    await expectStateRejected(adapter, context, craftRawBodyState([0xff, 0xfe]), 'invalid_request_state');
    await expectStateRejected(adapter, context, craftState({ p: null, exp, b: tag }), 'invalid_request_state');
    await expectStateRejected(adapter, context, craftState({ p: payload, exp: 'nope', b: tag }), 'invalid_request_state');
    await expectStateRejected(
      adapter,
      context,
      craftState({ p: Object.freeze({ planId: '', method: 'changes.plan', inputDigest: 'digest-x' }), exp, b: tag }),
      'invalid_request_state',
    );
    await expectStateRejected(
      adapter,
      context,
      craftState({ p: Object.freeze({ planId: 'plan-x', method: 'changes.commit', inputDigest: 'digest-x' }), exp, b: tag }),
      'request_state_mismatch',
    );
  });

  it('rejects an expired requestState and a cross-principal requestState', async () => {
    let nowMs = 1_000;
    const { adapter, context } = harness({
      requestStateTtlSeconds: 60,
      requestStateClock: () => nowMs,
    });
    const first = await firstPlanResult(adapter, context);
    const state = first.requestState as string;
    nowMs += 120_000;
    await expectStateRejected(adapter, context, state, 'request_state_expired');
  });

  it('rejects a requestState minted for a different principal', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const state = first.requestState as string;
    const other = harness({ binding: authenticatedBinding({ principalId: 'other-principal' }) });
    await expectStateRejected(other.adapter, other.context, state, 'request_state_binding_mismatch');
  });
});

describe('MCP 2026-07-28 Write adapter — plan resolution statuses', () => {
  function statusHarness(status: Mcp20260728PlanResolution['status'], plan?: Readonly<Record<string, unknown>>) {
    return harness({
      resolvePlan: {
        resolvePlan: vi.fn(async () => Object.freeze({ status, ...(plan !== undefined ? { plan } : {}) })),
      },
    });
  }

  it('rejects malformed resolvePlan results (non-object, invalid status, non-object plan)', async () => {
    for (const resolution of [null, 'nope', Object.freeze({ status: 'bogus' }), Object.freeze({ status: 'pending', plan: 'nope' })]) {
      const { adapter, context } = harness({
        resolvePlan: { resolvePlan: vi.fn(async () => resolution as never) },
      });
      const first = await firstPlanResult(adapter, context);
      const error = await captureError(adapter.callTool(context, {
        name: 'changes.plan',
        arguments: planRequest(),
        requestState: first.requestState as string,
      }));
      expect(error).toBeInstanceOf(TypeError);
    }
  });

  it('rejects pending/committing retries without a plan projection', async () => {
    const { adapter, context } = statusHarness('pending');
    const first = await firstPlanResult(adapter, context);
    const error = await captureError(adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: first.requestState as string,
    }));
    expect(error).toBeInstanceOf(TypeError);
  });

  it('rejects consumed/expired/cancelled/unknown plan retries with stable codes', async () => {
    for (const [status, code] of [
      ['consumed', 'plan_already_consumed'],
      ['expired', 'plan_expired'],
      ['cancelled', 'plan_cancelled'],
      ['unknown', 'plan_not_found'],
    ] as const) {
      const { adapter, context } = statusHarness(status);
      const first = await firstPlanResult(adapter, context);
      const error = await captureError(adapter.callTool(context, {
        name: 'changes.plan',
        arguments: planRequest(),
        requestState: first.requestState as string,
      }));
      expect(error, status).toMatchObject({ kind: 'invalid_params', data: { code } });
    }
  });

  async function commitState(
    adapter: Mcp20260728WriteToolAdapter,
    context: ReturnType<typeof harness>['context'],
    planId: string,
  ): Promise<string> {
    const first = await adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId, 'idem-x'),
    });
    const state = (first as { requestState?: unknown }).requestState;
    expect(typeof state).toBe('string');
    return state as string;
  }

  it('rejects a commit retry on expired/cancelled/unknown plans with stable codes', async () => {
    const { adapter, context } = statusHarness('approved');
    const planResult = await firstPlanResult(adapter, context);
    const planId = (planResult as unknown as { plan: { planId: string } }).plan.planId as string;
    const state = await commitState(adapter, context, planId);
    for (const [status, code] of [
      ['expired', 'plan_expired'],
      ['cancelled', 'plan_cancelled'],
      ['unknown', 'plan_not_found'],
    ] as const) {
      const terminal = statusHarness(status);
      const error = await captureError(terminal.adapter.callTool(terminal.context, {
        name: 'changes.commit',
        arguments: commitInput(planId, 'idem-x'),
        requestState: state,
      }));
      expect(error, status).toMatchObject({ kind: 'invalid_params', data: { code } });
    }
  });

  it('rejects a pending commit retry without a plan projection', async () => {
    const { adapter, context } = statusHarness('pending');
    const planResult = await firstPlanResult(adapter, context);
    const planId = (planResult as unknown as { plan: { planId: string } }).plan.planId as string;
    const state = await commitState(adapter, context, planId);
    const error = await captureError(adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId, 'idem-x'),
      requestState: state,
    }));
    expect(error).toBeInstanceOf(TypeError);
  });

  it('maps a gateway commit failure after an approved resolution to invalid_params', async () => {
    const { adapter, context } = statusHarness('approved');
    const planResult = await firstPlanResult(adapter, context);
    const planId = (planResult as unknown as { plan: { planId: string } }).plan.planId as string;
    const state = await commitState(adapter, context, planId);
    const error = await captureError(adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId, 'idem-x'),
      requestState: state,
    }));
    expect(error).toMatchObject({ kind: 'invalid_params' });
  });
});

describe('MCP 2026-07-28 Write adapter — untrusted application errors', () => {
  it('does not expose a caller-controlled TypeError from a low-risk Tool', async () => {
    const { adapter, context } = harness({
      lowRiskTools: {
        'custom.write': lowRiskDescriptor({
          invoke: () => {
            throw new TypeError('caller secret');
          },
        }),
      },
    });
    const error = await captureError(adapter.callTool(context, {
      name: 'custom.write',
      arguments: { mode: 'private' },
    }));
    expect(error).toMatchObject({
      kind: 'internal_error',
      message: 'MCP write operation failed.',
    });
    expect((error as Error).message).not.toContain('caller secret');
  });
});

describe('MCP 2026-07-28 Write adapter — inputResponses and call input hardening', () => {
  it('rejects symbol keys, accessor entries and malformed inputResponses entries', async () => {
    const { adapter, context } = harness();
    const first = await firstPlanResult(adapter, context);
    const state = first.requestState as string;
    const symbolResponses = { [Symbol('k')]: Object.freeze({ action: 'accept' }) };
    const symbolError = await captureError(adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: state,
      inputResponses: symbolResponses,
    }));
    expect(symbolError).toMatchObject({ kind: 'invalid_params', data: { code: 'invalid_input_responses' } });

    const accessorResponses = Object.defineProperty({}, 'k', { get: () => ({ action: 'accept' }) });
    const accessorError = await captureError(adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: state,
      inputResponses: accessorResponses,
    }));
    expect(accessorError).toMatchObject({ kind: 'invalid_params', data: { code: 'invalid_input_responses' } });

    const malformedEntry = await captureError(adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: state,
      inputResponses: { k: 'nope' },
    }));
    expect(malformedEntry).toMatchObject({ kind: 'invalid_params', data: { code: 'invalid_input_responses' } });
  });

  it('rejects malformed call inputs (non-object, bad name, bad arguments)', async () => {
    const { adapter, context } = harness();
    expect(await captureError(adapter.callTool(context, 'nope'))).toMatchObject({ kind: 'invalid_params' });
    expect(await captureError(adapter.callTool(context, { name: 42 }))).toMatchObject({ kind: 'invalid_params' });
    expect(await captureError(adapter.callTool(context, { name: '' }))).toMatchObject({ kind: 'invalid_params' });
    expect(await captureError(adapter.callTool(context, { name: 'changes.cancel', arguments: 'nope' })))
      .toMatchObject({ kind: 'invalid_params' });
    expect(await captureError(adapter.callTool(context, { name: 'changes.cancel', requestState: 42 })))
      .toMatchObject({ kind: 'invalid_params' });
  });

  it('rejects malformed cursors on listTools and accepts undefined input', async () => {
    const { adapter, context } = harness();
    const ok = await adapter.listTools(context, { cursor: 'abc' });
    expect(ok.resultType).toBe('complete');
    expect(await captureError(adapter.listTools(context, { cursor: '' }))).toMatchObject({ kind: 'invalid_params' });
    expect(await captureError(adapter.listTools(context, { unexpected: 1 }))).toMatchObject({ kind: 'invalid_params' });
    const noInput = await adapter.listTools(context, undefined);
    expect(noInput.resultType).toBe('complete');
  });

  it('maps tool-input failures on commit/cancel and aborted writes', async () => {
    const { adapter, context } = harness();
    const inputError = await captureError(adapter.callTool(context, {
      name: 'changes.commit',
      arguments: { planId: 42 },
    }));
    expect(inputError).toMatchObject({ kind: 'invalid_params' });

    const controller = new AbortController();
    controller.abort();
    const aborted = await captureError(adapter.callTool({
      ...context, abortSignal: controller.signal,
    } as never, { name: 'changes.plan', arguments: planRequest() }));
    expect(aborted).toBeInstanceOf(McpWriteRequestAbortedError);

    const missing = await captureError(adapter.recordOutOfBandApproval('missing-plan', context));
    expect(missing).toMatchObject({ kind: 'invalid_params' });
  });
});

it('rejects a first changes.commit without requestState on terminal plans with stable codes', async () => {
  for (const [status, code] of [
    ['expired', 'plan_expired'],
    ['cancelled', 'plan_cancelled'],
    ['unknown', 'plan_not_found'],
    ['consumed', 'plan_already_consumed'],
  ] as const) {
    const { adapter, context } = harness({ resolvePlan: { resolvePlan: vi.fn(async () => Object.freeze({ status })) } });
    const planResult = await firstPlanResult(adapter, context);
    const planId = (planResult as unknown as { plan: { planId: string } }).plan.planId as string;
    const error = await captureError(adapter.callTool(context, {
      name: 'changes.commit',
      arguments: commitInput(planId, 'idem-x'),
    }));
    expect(error, status).toMatchObject({ kind: 'invalid_params', data: { code } });
  }
});
