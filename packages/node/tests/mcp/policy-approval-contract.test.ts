import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { McpPolicyApprovalError, approveByPolicy } from '../../src/mcp/node-tools.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = '[evidence:mcp.policy-approval]';
const validators = createValidatorRegistry();
const trusted = Object.freeze({ approvalPolicy: 'trusted' as const });

function planFixture(): Record<string, unknown> {
  const path = resolve(import.meta.dirname, '../../fixtures/protocol/examples/change-plan.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function moveOperation(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'move_node',
    collectionId: 'collection-1',
    targetId: 'node-1',
  });
}

describe(`MCP-0026 policy approval ${evidence}`, () => {
  it('records approvedBy policy on the plan object and still accepts a user approval', () => {
    const schema = validators.validate('changePlan', planFixture());
    expect(schema.valid).toBe(true);

    for (const approvedBy of ['policy', 'user'] as const) {
      const plan = planFixture();
      plan.approvedBy = approvedBy;
      expect(validators.validate('changePlan', plan)).toEqual({ valid: true, errors: [] });
    }

    const rejected = planFixture();
    rejected.approvedBy = 'host';
    expect(validators.validate('changePlan', rejected).valid).toBe(false);
    expect(approveByPolicy([moveOperation()], trusted)).toEqual({ approvedBy: 'policy' });
  });

  it('refuses policy approval for exposure and purge, including when the agent is trusted', () => {
    const expose = [
      { type: 'set_visibility', input: { visibility: 'public' } },
      { type: 'set_visibility', input: { visibility: 'unlisted' } },
      { type: 'set_visibility', visibility: 'public' },
      { type: 'access.visibility', visibility: 'unlisted' },
      { type: 'set_visibility' },
    ];
    const purge = [
      { type: 'delete_collection', collectionId: 'collection-1' },
      { type: 'collections.delete' },
      { type: 'empty_trash' },
      { type: 'purge_tombstones' },
    ];
    for (const operation of [...expose, ...purge]) {
      let caught: unknown;
      try {
        approveByPolicy([operation], trusted);
      } catch (error) {
        caught = error;
      }
      expect(caught, String(operation.type)).toBeInstanceOf(McpPolicyApprovalError);
    }

    expect(approveByPolicy([
      { type: 'set_visibility', input: { visibility: 'private' } },
      { type: 'delete_subtree', collectionId: 'collection-1', targetId: 'folder-1' },
    ], trusted)).toEqual({ approvedBy: 'policy' });
    expect(() => approveByPolicy([moveOperation()])).toThrow(McpPolicyApprovalError);
    expect(() => approveByPolicy([moveOperation()], { approvalPolicy: 'manual' })).toThrow(McpPolicyApprovalError);
    expect(approveByPolicy([
      { type: 'set_visibility', input: { visibility: 'protected' } },
    ], trusted)).toEqual({ approvedBy: 'policy' });
  });

  it('fails closed on hostile options and operation lists', () => {
    expect(() => approveByPolicy([{ type: 'trash.empty' }], trusted)).toThrow(McpPolicyApprovalError);
    expect(() => approveByPolicy([{ type: 'tombstones.purge' }], trusted)).toThrow(McpPolicyApprovalError);
    expect(() => approveByPolicy([{ type: 'set_visibility', input: null }], trusted)).toThrow(McpPolicyApprovalError);
    expect(() => approveByPolicy([{ type: 'set_visibility', input: [] }], trusted)).toThrow(McpPolicyApprovalError);
    expect(() => approveByPolicy([{ type: 'access.visibility', input: new Proxy({ visibility: 'private' }, {}) }], trusted))
      .toThrow(McpPolicyApprovalError);

    expect(() => approveByPolicy('nope' as never, trusted)).toThrow(TypeError);
    expect(() => approveByPolicy([], trusted)).toThrow(/non-empty/u);
    expect(() => approveByPolicy([null], trusted)).toThrow(/plain object/u);
    expect(() => approveByPolicy([{}], trusted)).toThrow(/requires a type/u);
    expect(() => approveByPolicy([new Proxy({ type: 'move_node' }, {})], trusted)).toThrow(/plain object/u);
    expect(() => approveByPolicy(Array.from({ length: 1001 }, () => ({ type: 'move_node' })), trusted))
      .toThrow(/write budget/u);

    const hiddenType = {};
    Object.defineProperty(hiddenType, 'type', { enumerable: false, value: 'move_node' });
    expect(() => approveByPolicy([hiddenType], trusted)).toThrow(/requires a type/u);

    const withSymbol = { type: 'move_node' };
    Object.defineProperty(withSymbol, Symbol('hidden'), { enumerable: true, value: 1 });
    expect(approveByPolicy([withSymbol], trusted)).toEqual({ approvedBy: 'policy' });
  });
});
