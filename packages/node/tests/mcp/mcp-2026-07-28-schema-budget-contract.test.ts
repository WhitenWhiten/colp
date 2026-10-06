/**
 * COLP-MCP-09: Schema 2020-12 budget guard for Modern Read Tool schemas.
 *
 * `src/mcp/2026-07-28/schema-budget.ts` bounds how much `$ref` / composition
 * vocabulary (allOf/anyOf/oneOf/$defs/items/... plus $ref/$dynamicRef/
 * $recursiveRef) a Tool input/output schema may carry before the Modern
 * adapter emits it. Every parse is own-data only (no getters, no Proxies,
 * no class prototypes), counts depth / nodes / references / bytes, rejects
 * object cycles and ref bombs, and is applied by
 * `createMcp20260728ReadToolAdapter` at factory time.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MCP_SCHEMA_BUDGET,
  McpSchemaBudgetError,
  assertMcpSchemaWithinBudget,
  resolveMcpSchemaBudget,
} from '../../src/mcp/2026-07-28/schema-budget.js';
import { createMcp20260728ReadToolAdapter } from '../../src/mcp/2026-07-28/tools.js';
import { createMcpStatelessToolCore } from '../../src/mcp/shared/tools.js';

function schemaWithRefs(count: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    properties[`field${index}`] = { $ref: '#/$defs/opaqueId' };
  }
  return { type: 'object', properties, $defs: { opaqueId: { type: 'string' } } };
}

function deepObjectSchema(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = { type: 'object' };
  let node: Record<string, unknown> = root;
  for (let level = 0; level < depth; level += 1) {
    const child: Record<string, unknown> = {};
    node.properties = child;
    node = child;
  }
  return root;
}

const serverInfo = Object.freeze({ name: 'colp-test-server', version: '0.0.0' });

describe('MCP 2026-07-28 schema budget: defaults and resolution', () => {
  it('pins safe default limits', () => {
    expect(DEFAULT_MCP_SCHEMA_BUDGET.maxDepth).toBe(32);
    expect(DEFAULT_MCP_SCHEMA_BUDGET.maxNodes).toBe(10_000);
    expect(DEFAULT_MCP_SCHEMA_BUDGET.maxReferences).toBe(1_000);
    expect(DEFAULT_MCP_SCHEMA_BUDGET.maxBytes).toBe(1_048_576);
    expect(Object.isFrozen(DEFAULT_MCP_SCHEMA_BUDGET)).toBe(true);
  });

  it('resolves per-call budgets against safe-integer defaults', () => {
    const resolved = resolveMcpSchemaBudget({ maxReferences: 7 });
    expect(resolved.maxReferences).toBe(7);
    expect(resolved.maxDepth).toBe(DEFAULT_MCP_SCHEMA_BUDGET.maxDepth);
    expect(() => resolveMcpSchemaBudget({ maxNodes: 0 })).toThrow(TypeError);
    expect(() => resolveMcpSchemaBudget({ maxBytes: 1.5 })).toThrow(TypeError);
    expect(() => resolveMcpSchemaBudget({ maxReferences: -1 })).toThrow(TypeError);
    expect(() => resolveMcpSchemaBudget({ maxDepth: 1.5 })).toThrow(TypeError);
  });

  it('rejects accessor budget properties fail-closed instead of silently defaulting', () => {
    const accessor = { maxNodes: 10 } as Record<string, unknown>;
    Object.defineProperty(accessor, 'maxDepth', { get: () => 8 });
    expect(() => resolveMcpSchemaBudget(accessor as never)).toThrow(TypeError);
  });
});

describe('MCP 2026-07-28 schema budget: bounded walk', () => {
  it('accepts a plain 2020-12 schema with $ref and composition keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { $ref: '#/$defs/opaqueId' },
        nested: {
          allOf: [{ $ref: '#/$defs/opaqueId' }, { type: 'string' }],
        },
        choice: {
          oneOf: [{ $ref: '#/$defs/opaqueId' }, { type: 'null' }],
        },
        items: { type: 'array', items: { $ref: '#/$defs/opaqueId' } },
      },
      $defs: { opaqueId: { type: 'string', minLength: 1 } },
    };
    expect(() => assertMcpSchemaWithinBudget(schema)).not.toThrow();
    expect(() => assertMcpSchemaWithinBudget({
      type: 'object',
      anyOf: [{ type: 'string' }, { type: 'number' }],
      not: { type: 'null' },
      if: { type: 'object' },
      then: { type: 'object' },
      else: { type: 'array' },
    })).not.toThrow();
  });

  it('enforces the parse depth budget', () => {
    expect(() => assertMcpSchemaWithinBudget(deepObjectSchema(40), { maxDepth: 8 }))
      .toThrow(McpSchemaBudgetError);
  });

  it('enforces the node budget', () => {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < 500; index += 1) properties[`f${index}`] = { type: 'string' };
    expect(() => assertMcpSchemaWithinBudget(
      { type: 'object', properties },
      { maxNodes: 64 },
    )).toThrow(McpSchemaBudgetError);
  });

  it('rejects a $ref bomb above the reference budget', () => {
    expect(() => assertMcpSchemaWithinBudget(schemaWithRefs(2_000), { maxReferences: 16 }))
      .toThrow(McpSchemaBudgetError);
    expect(() => assertMcpSchemaWithinBudget(schemaWithRefs(4), { maxReferences: 16 }))
      .not.toThrow();
  });

  it('enforces the byte budget', () => {
    const big = { type: 'string', description: 'x'.repeat(2_000) };
    expect(() => assertMcpSchemaWithinBudget(big, { maxBytes: 256 }))
      .toThrow(McpSchemaBudgetError);
  });

  it('rejects object cycles while shared aliasing stays accepted', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { child: a };
    a.child = b;
    expect(() => assertMcpSchemaWithinBudget(a)).toThrow(McpSchemaBudgetError);
    const shared = { type: 'string' };
    expect(() => assertMcpSchemaWithinBudget({ a: shared, b: shared })).not.toThrow();
  });

  it('rejects Proxies, accessors, class prototypes and non-finite numbers', () => {
    expect(() => assertMcpSchemaWithinBudget(new Proxy({ type: 'object' }, {})))
      .toThrow(McpSchemaBudgetError);
    const accessor = { type: 'object' };
    Object.defineProperty(accessor, 'properties', { get: () => ({}) });
    expect(() => assertMcpSchemaWithinBudget(accessor)).toThrow(McpSchemaBudgetError);
    class SchemaLike { readonly type = 'object'; }
    expect(() => assertMcpSchemaWithinBudget(new SchemaLike())).toThrow(McpSchemaBudgetError);
    expect(() => assertMcpSchemaWithinBudget({ type: 'number', minimum: Number.NaN }))
      .toThrow(McpSchemaBudgetError);
  });

  it('rejects symbol keys', () => {
    const sym = Symbol('x');
    expect(() => assertMcpSchemaWithinBudget({ type: 'object', [sym]: 1 }))
      .toThrow(McpSchemaBudgetError);
    expect(() => assertMcpSchemaWithinBudget({ type: 'object', properties: { [sym]: {} } }))
      .toThrow(McpSchemaBudgetError);
  });
});

describe('MCP 2026-07-28 schema budget: applied by the Read Tool adapter', () => {
  it('rejects an over-depth tool schema at factory time', () => {
    const toolCore = createMcpStatelessToolCore({
      tools: [{
        definition: Object.freeze({
          name: 'a.deep',
          description: 'deep schema',
          inputSchema: deepObjectSchema(40),
        }),
        invoke: async () => ({}),
      }],
    });
    expect(() => createMcp20260728ReadToolAdapter({
      toolCore,
      serverInfo,
      schemaBudget: { maxDepth: 8 },
    })).toThrow(McpSchemaBudgetError);
  });

  it('rejects a cyclic tool output schema at factory time', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const toolCore = createMcpStatelessToolCore({
      tools: [{
        definition: Object.freeze({
          name: 'a.cycle',
          description: 'cyclic schema',
          inputSchema: { type: 'object' } as const,
          outputSchema: cycle,
        }),
        invoke: async () => ({}),
      }],
    });
    expect(() => createMcp20260728ReadToolAdapter({
      toolCore,
      serverInfo,
    })).toThrow(McpSchemaBudgetError);
  });
});
