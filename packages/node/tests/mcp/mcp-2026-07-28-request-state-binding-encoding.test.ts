/**
 * P1-10: requestState binding tags must not use an ambiguous `|` join.
 * A matching tag is not authorization; the host-style resolver still compares
 * fields, and commit/approval/cancel stay rejected on a field mismatch.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryPlanStore,
  type McpChangePlanExecutorPort,
} from '../../src/mcp/change-plan.js';
import {
  REQUEST_STATE_BINDING_DOMAIN,
  requestStateBindingMaterial,
} from '../../src/mcp/2026-07-28/request-state-binding.js';
import type { Mcp20260728Result } from '../../src/mcp/2026-07-28/results.js';
import type { Mcp20260728PlanResolution } from '../../src/mcp/2026-07-28/write.js';
import type { McpAuthenticatedAuthorizationBinding } from '../../src/mcp/shared/authorization.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import {
  TEST_REQUEST_STATE_KEY,
  commitInput,
  firstPlanResult,
  harness,
  planRequest,
  projectPlan,
} from './mcp-2026-07-28-write-adapter-fixture.js';

const V0_BIND_LABEL = 'mcp.requestState.bind:';

type Fields = readonly [string, string, string, string, string, string];

function material(fields: Fields): Uint8Array {
  return requestStateBindingMaterial({
    kind: fields[0] as 'authenticated',
    principalId: fields[1],
    clientId: fields[2],
    credentialBindingId: fields[3],
    resourceAudience: fields[4],
    securityEpoch: fields[5],
  });
}

function v0Join(binding: McpAuthenticatedAuthorizationBinding): string {
  return [
    binding.kind,
    binding.principalId,
    binding.clientId,
    binding.credentialBindingId,
    binding.resourceAudience,
    binding.securityEpoch,
  ].join('|');
}

function v0Tag(binding: McpAuthenticatedAuthorizationBinding): string {
  const mac = createHmac('sha256', TEST_REQUEST_STATE_KEY)
    .update(`${V0_BIND_LABEL}${v0Join(binding)}`, 'utf8')
    .digest();
  return Buffer.from(mac.subarray(0, 16)).toString('base64url');
}

function stateTag(state: string): string {
  const body = state.slice('colp.rs.'.length, state.lastIndexOf('.'));
  const envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { readonly b: string };
  return envelope.b;
}

function replaceTag(state: string, tag: string): string {
  const prefix = 'colp.rs.';
  const body = state.slice(prefix.length, state.lastIndexOf('.'));
  const envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
    p: unknown;
    exp: number;
    b: string;
  };
  const nextBody = Buffer.from(JSON.stringify({ ...envelope, b: tag }), 'utf8').toString('base64url');
  const mac = createHmac('sha256', TEST_REQUEST_STATE_KEY).update(`${prefix}${nextBody}`, 'utf8').digest();
  return `${prefix}${nextBody}.${Buffer.from(mac).toString('base64url')}`;
}

function capture(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(() => undefined, (caught: unknown) => caught);
}

function planIdOf(result: Mcp20260728Result): string {
  const plan = result.plan as { readonly planId?: unknown };
  expect(typeof plan.planId).toBe('string');
  return plan.planId as string;
}

function sameBinding(
  left: McpAuthenticatedAuthorizationBinding,
  right: McpAuthenticatedAuthorizationBinding,
): boolean {
  return left.kind === right.kind
    && left.principalId === right.principalId
    && left.clientId === right.clientId
    && left.credentialBindingId === right.credentialBindingId
    && left.resourceAudience === right.resourceAudience
    && left.securityEpoch === right.securityEpoch;
}

async function hostResolve(
  planStore: ReturnType<typeof createInMemoryPlanStore>,
  planId: string,
  binding: McpAuthenticatedAuthorizationBinding,
): Promise<Mcp20260728PlanResolution> {
  const plan = await planStore.get(planId);
  if (plan === undefined || !sameBinding(plan.binding, binding)) {
    return Object.freeze({ status: 'unknown' });
  }
  return Object.freeze({ status: plan.status, plan: projectPlan(plan) });
}

describe('requestState binding material v1', () => {
  it('pins the domain and length-prefixed UTF-16BE layout', () => {
    expect(REQUEST_STATE_BINDING_DOMAIN).toBe('mcp.requestState.bind.v1');
    const domain = Buffer.from(REQUEST_STATE_BINDING_DOMAIN, 'ascii');
    const empty = Buffer.from(material(['', '', '', '', '', '']));
    expect(empty.subarray(0, domain.length)).toEqual(domain);
    expect(empty.subarray(domain.length)).toEqual(Buffer.alloc(24));

    const letter = Buffer.from(material(['A', '', '', '', '', '']));
    expect([...letter.subarray(domain.length, domain.length + 6)]).toEqual([0, 0, 0, 1, 0, 0x41]);

    const emoji = Buffer.from(material(['😀', '', '', '', '', '']));
    expect([...emoji.subarray(domain.length, domain.length + 8)]).toEqual([
      0, 0, 0, 2, 0xd8, 0x3d, 0xde, 0x00,
    ]);
  });

  it('separates a|b/c from a/b|c at every field boundary', () => {
    for (let index = 0; index < 5; index += 1) {
      const left = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'];
      const right = [...left];
      left[index] = 'a|b';
      left[index + 1] = 'c';
      right[index] = 'a';
      right[index + 1] = 'b|c';
      expect(left.join('|'), `v0 boundary ${index}`).toBe(right.join('|'));
      const leftFields = left as unknown as Fields;
      const rightFields = right as unknown as Fields;
      expect(Buffer.from(material(leftFields)), `v1 boundary ${index}`).not.toEqual(
        Buffer.from(material(rightFields)),
      );
      expect(Buffer.from(material(leftFields))).not.toEqual(
        Buffer.from(`${V0_BIND_LABEL}${left.join('|')}`, 'utf8'),
      );
    }
  });

  it('keeps controls, unicode, and empty fields unambiguous', () => {
    const distinct: readonly (readonly [Fields, Fields])[] = [
      [['', 'ab', '', '', '', ''], ['a', 'b', '', '', '', '']],
      [['ab', '', '', '', '', ''], ['a', 'b', '', '', '', '']],
      [['a|', 'b', '', '', '', ''], ['a', '|b', '', '', '', '']],
      [['a\nb', 'c', '', '', '', ''], ['a', '\nbc', '', '', '', '']],
      [['a\\nb', 'c', '', '', '', ''], ['a\nb', 'c', '', '', '', '']],
      [['a\u0000b', 'c', '', '', '', ''], ['a', '\u0000bc', '', '', '', '']],
      [['\u0000', '', '', '', '', ''], ['', '', '', '', '', '']],
      [['café', '', '', '', '', ''], ['cafe\u0301', '', '', '', '', '']],
      [['雪', '', '', '', '', ''], ['⻘', '', '', '', '', '']],
      [['\uD800', '', '', '', '', ''], ['\uFFFD', '', '', '', '', '']],
      [['\uD800\uDC00', '', '', '', '', ''], ['\uD800', '\uDC00', '', '', '', '']],
    ];
    for (const [left, right] of distinct) {
      expect(Buffer.from(material(left))).not.toEqual(Buffer.from(material(right)));
    }
  });
});

describe('requestState binding tag v1', () => {
  const pairs = [
    {
      label: 'principal/client',
      left: authenticatedBinding({ principalId: 'a|b', clientId: 'c' }),
      right: authenticatedBinding({ principalId: 'a', clientId: 'b|c' }),
    },
    {
      label: 'client/credential',
      left: authenticatedBinding({ clientId: 'a|b', credentialBindingId: 'c' }),
      right: authenticatedBinding({ clientId: 'a', credentialBindingId: 'b|c' }),
    },
  ] as const;

  it.each(pairs)(
    'rejects $label cross-binding read and commit without replanning',
    async ({ left, right }) => {
      expect(v0Join(left)).toBe(v0Join(right));
      expect(v0Tag(left)).toBe(v0Tag(right));
      expect(Buffer.from(requestStateBindingMaterial(left))).not.toEqual(
        Buffer.from(requestStateBindingMaterial(right)),
      );

      const planStore = createInMemoryPlanStore();
      const executor = { execute: vi.fn(async () => []) } as McpChangePlanExecutorPort;
      const attackerLooks: string[] = [];
      const owner = harness({
        planStore,
        executor,
        binding: left,
        resolvePlan: {
          resolvePlan: (planId, binding) => hostResolve(planStore, planId, binding),
        },
      });
      const attacker = harness({
        planStore,
        executor,
        binding: right,
        resolvePlan: {
          resolvePlan: (planId, binding) => {
            attackerLooks.push(planId);
            return hostResolve(planStore, planId, binding);
          },
        },
      });

      const first = await firstPlanResult(owner.adapter, owner.context);
      const state = first.requestState as string;
      const planId = planIdOf(first);
      const summary = (first.plan as { readonly summary?: unknown }).summary;
      expect(typeof summary).toBe('string');
      expect((summary as string).length).toBeGreaterThan(0);
      expect(stateTag(state)).not.toBe(v0Tag(left));

      const crossed = await capture(attacker.adapter.callTool(attacker.context, {
        name: 'changes.plan',
        arguments: planRequest(),
        requestState: state,
      }));
      expect(crossed).toMatchObject({
        kind: 'invalid_params',
        data: { code: 'request_state_binding_mismatch' },
      });
      expect(JSON.stringify(crossed)).not.toContain(summary as string);
      expect(attackerLooks).toEqual([]);

      const resolved = await hostResolve(planStore, planId, right);
      expect(resolved).toEqual({ status: 'unknown' });
      expect(resolved).not.toHaveProperty('plan');

      const attempts = [
        attacker.adapter.callTool(attacker.context, {
          name: 'changes.commit',
          arguments: commitInput(planId, 'idem-cross'),
        }),
        attacker.adapter.recordOutOfBandApproval(planId, attacker.context),
        attacker.adapter.callTool(attacker.context, {
          name: 'changes.cancel',
          arguments: { planId },
        }),
      ];
      for (const attempt of attempts) {
        const error = await capture(attempt);
        expect(error).toMatchObject({
          kind: 'invalid_params',
          data: { code: 'plan_binding_mismatch' },
        });
        expect(JSON.stringify(error)).not.toContain(summary as string);
      }
      expect(executor.execute).not.toHaveBeenCalled();
      expect(planStore.stats().plans).toBe(1);
      expect((await planStore.get(planId))?.status).toBe('pending');

      const retry = await owner.adapter.callTool(owner.context, {
        name: 'changes.plan',
        arguments: planRequest(),
        requestState: state,
      });
      expect(retry.resultType).toBe('input_required');
      expect(planIdOf(retry)).toBe(planId);
      expect(planStore.stats().plans).toBe(1);

      const legacy = replaceTag(state, v0Tag(left));
      const legacyError = await capture(owner.adapter.callTool(owner.context, {
        name: 'changes.plan',
        arguments: planRequest(),
        requestState: legacy,
      }));
      expect(legacyError).toMatchObject({
        kind: 'invalid_params',
        data: { code: 'request_state_binding_mismatch' },
      });
      expect(planStore.stats().plans).toBe(1);
      expect((await planStore.get(planId))?.status).toBe('pending');
      const still = await owner.adapter.callTool(owner.context, {
        name: 'changes.plan',
        arguments: planRequest(),
        requestState: state,
      });
      expect(planIdOf(still)).toBe(planId);

      const denied = harness({
        planStore,
        binding: left,
        resolvePlan: { resolvePlan: async () => Object.freeze({ status: 'unknown' }) },
      });
      const deniedError = await capture(denied.adapter.callTool(denied.context, {
        name: 'changes.plan',
        arguments: planRequest(),
        requestState: state,
      }));
      expect(deniedError).toMatchObject({
        kind: 'invalid_params',
        data: { code: 'plan_not_found' },
      });
      expect(JSON.stringify(deniedError)).not.toContain(summary as string);
      expect(planStore.stats().plans).toBe(1);
    },
  );

  it('retries a binding that contains controls and non-BMP text as the same plan', async () => {
    const planStore = createInMemoryPlanStore();
    const binding = authenticatedBinding({
      principalId: '雪\n😀',
      clientId: 'c|\u0000',
    });
    const { adapter, context } = harness({
      planStore,
      binding,
      resolvePlan: {
        resolvePlan: (planId, caller) => hostResolve(planStore, planId, caller),
      },
    });
    const first = await firstPlanResult(adapter, context);
    const retry = await adapter.callTool(context, {
      name: 'changes.plan',
      arguments: planRequest(),
      requestState: first.requestState as string,
    });
    expect(planIdOf(retry)).toBe(planIdOf(first));
    expect(planStore.stats().plans).toBe(1);
  });
});
