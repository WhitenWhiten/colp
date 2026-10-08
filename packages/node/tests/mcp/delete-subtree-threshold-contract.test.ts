import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MCP_DELETE_SUBTREE_THRESHOLD,
  classifyDeleteSubtreeRisk,
  resolveNodeWriteToolOptions,
} from '../../src/mcp/node-tools.js';

const evidence = '[evidence:mcp.delete-subtree-threshold]';

describe(`MCP-0027 nodes.delete_subtree threshold ${evidence}`, () => {
  it('defaults the host threshold to 20', () => {
    expect(DEFAULT_MCP_DELETE_SUBTREE_THRESHOLD).toBe(20);
    expect(resolveNodeWriteToolOptions()).toEqual({
      deleteSubtreeThreshold: 20,
      approvalPolicy: 'manual',
    });
    expect(resolveNodeWriteToolOptions({})).toEqual({
      deleteSubtreeThreshold: 20,
      approvalPolicy: 'manual',
    });
  });

  it('is medium at or below the threshold and high above it', () => {
    expect(classifyDeleteSubtreeRisk(1)).toBe('medium');
    expect(classifyDeleteSubtreeRisk(20)).toBe('medium');
    expect(classifyDeleteSubtreeRisk(21)).toBe('high');
    expect(classifyDeleteSubtreeRisk(5, { deleteSubtreeThreshold: 5 })).toBe('medium');
    expect(classifyDeleteSubtreeRisk(6, { deleteSubtreeThreshold: 5 })).toBe('high');
    expect(classifyDeleteSubtreeRisk(20, { deleteSubtreeThreshold: 0 })).toBe('high');
  });

  it('rejects a non-configurable or non-integer threshold and an unusable count', () => {
    expect(() => classifyDeleteSubtreeRisk(0)).toThrow(TypeError);
    expect(() => classifyDeleteSubtreeRisk(1.5)).toThrow(TypeError);
    expect(() => resolveNodeWriteToolOptions({ deleteSubtreeThreshold: -1 })).toThrow(TypeError);
    expect(() => resolveNodeWriteToolOptions({ deleteSubtreeThreshold: 1.5 })).toThrow(TypeError);
    const accessor = {};
    Object.defineProperty(accessor, 'deleteSubtreeThreshold', { enumerable: true, get: () => 1 });
    expect(() => resolveNodeWriteToolOptions(accessor)).toThrow(/own enumerable data property/u);
    expect(() => resolveNodeWriteToolOptions(null as never)).toThrow(/plain object/u);
    expect(() => resolveNodeWriteToolOptions([] as never)).toThrow(/plain object/u);
    expect(() => resolveNodeWriteToolOptions(new Proxy({}, {}) as never)).toThrow(/plain object/u);
    expect(() => resolveNodeWriteToolOptions({ extra: true } as never)).toThrow(/unknown property/u);
    expect(() => resolveNodeWriteToolOptions({ approvalPolicy: 'auto' } as never)).toThrow(/approvalPolicy/u);
    const symbolOptions = {};
    Object.defineProperty(symbolOptions, Symbol('extra'), { enumerable: false, value: 1 });
    expect(() => resolveNodeWriteToolOptions(symbolOptions)).toThrow(/unknown property/u);
  });
});
