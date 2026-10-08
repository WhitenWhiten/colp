/**
 * COLP schema-budget failures for Modern read-tool adapter construction.
 * Companion to phase4b-mcp-read-tools.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  McpSchemaBudgetError,
  createMcp20260728ReadToolAdapter,
  createMcpStatelessToolCore,
  type McpToolDefinition,
} from '@know-n/colp/mcp';

test('schema cycles are rejected by the COLP schema budget before they reach a Modern result', () => {
  const cyclicSchema: Record<string, unknown> = {
    type: 'object',
    properties: {},
  };
  cyclicSchema.properties = { self: cyclicSchema };
  const definition: McpToolDefinition = Object.freeze({
    name: 'bad.cycle',
    description: 'Cycle.',
    inputSchema: cyclicSchema,
  });
  const core = createMcpStatelessToolCore({
    tools: [Object.freeze({ definition, invoke: async () => Object.freeze({}) })],
  });
  assert.throws(
    () => createMcp20260728ReadToolAdapter({
      toolCore: core,
      serverInfo: Object.freeze({ name: 'schema-budget-test', version: '0.0.0' }),
    }),
    McpSchemaBudgetError,
  );
});

test('schema reference and composition budgets fail closed before Modern emission', () => {
  const referenceHeavySchema = Object.freeze({
    type: 'object',
    properties: Object.freeze({
      first: Object.freeze({ $ref: '#/$defs/id' }),
      second: Object.freeze({ $ref: '#/$defs/id' }),
    }),
    $defs: Object.freeze({ id: Object.freeze({ type: 'string' }) }),
  });
  assert.throws(
    () => createMcp20260728ReadToolAdapter({
      toolCore: createMcpStatelessToolCore({
        tools: [Object.freeze({
          definition: Object.freeze({
            name: 'ref.budget',
            description: 'Reference budget.',
            inputSchema: referenceHeavySchema,
          }),
          invoke: async () => Object.freeze({}),
        })],
      }),
      serverInfo: Object.freeze({ name: 'schema-budget-test', version: '0.0.0' }),
      schemaBudget: Object.freeze({ maxReferences: 1 }),
    }),
    McpSchemaBudgetError,
  );

  const compositionHeavySchema = Object.freeze({
    type: 'object',
    allOf: Object.freeze(Array.from({ length: 4 }, () => Object.freeze({ type: 'object' }))),
  });
  assert.throws(
    () => createMcp20260728ReadToolAdapter({
      toolCore: createMcpStatelessToolCore({
        tools: [Object.freeze({
          definition: Object.freeze({
            name: 'composition.budget',
            description: 'Composition budget.',
            inputSchema: compositionHeavySchema,
          }),
          invoke: async () => Object.freeze({}),
        })],
      }),
      serverInfo: Object.freeze({ name: 'schema-budget-test', version: '0.0.0' }),
      schemaBudget: Object.freeze({ maxNodes: 5 }),
    }),
    McpSchemaBudgetError,
  );
});

