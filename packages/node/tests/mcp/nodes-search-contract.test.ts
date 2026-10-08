import { describe, expect, it } from 'vitest';

import { McpToolInputError, McpToolOutputError } from '../../src/mcp/tool-input.js';
import {
  nodesSearchToolDefinition,
  validateNodesDeleteSubtreeInput,
  validateNodesMoveInput,
  validateNodesSearchInput,
  validateNodesSearchOutput,
} from '../../src/mcp/node-tools.js';
import { collectionProtocolSchema } from '../../src/schema/index.js';

const evidence = '[evidence:mcp.nodes-search]';

function expectInputError(validate: (input: unknown) => unknown, input: unknown): void {
  expect(() => validate(input)).toThrow(McpToolInputError);
}

describe(`MCP-0025 nodes.search contract ${evidence}`, () => {
  it('publishes an optional risk-none tool scoped to nodes:read', () => {
    expect(nodesSearchToolDefinition.name).toBe('nodes.search');
    expect(nodesSearchToolDefinition.risk).toBe('none');
    expect(nodesSearchToolDefinition.requiredScopes).toEqual(['nodes:read']);
    expect(nodesSearchToolDefinition.inputSchema).toEqual({
      $ref: `${collectionProtocolSchema.$id}#/$defs/nodesSearchInput`,
    });
    expect(nodesSearchToolDefinition.outputSchema).toEqual({
      $ref: `${collectionProtocolSchema.$id}#/$defs/nodesSearchResult`,
    });
    expect(nodesSearchToolDefinition.description).toContain('annotations:read');
  });

  it('accepts query plus optional collectionId, cursor, and limit at most 100', () => {
    expect(validateNodesSearchInput({ query: 'protocols' })).toMatchObject({ query: 'protocols' });
    expect(validateNodesSearchInput({
      query: 'protocols',
      collectionId: 'collection-1',
      cursor: 'page-2',
      limit: 100,
    })).toEqual({
      query: 'protocols',
      collectionId: 'collection-1',
      cursor: 'page-2',
      limit: 100,
    });
    expectInputError(validateNodesSearchInput, {});
    expectInputError(validateNodesSearchInput, { query: '' });
    expectInputError(validateNodesSearchInput, { query: 'protocols', limit: 101 });
    expectInputError(validateNodesSearchInput, { query: 'protocols', limit: 0 });
    expectInputError(validateNodesSearchInput, { query: 'protocols', collectionId: 'not/an-id' });
    expectInputError(validateNodesSearchInput, { query: 'protocols', includeAnnotations: true });
  });

  it('returns nodes with collection id, folder path, link status, and a cursor', () => {
    const hit = {
      id: 'node-1',
      collectionId: 'collection-1',
      folderPath: 'Reading/Protocols',
      linkStatus: 'broken',
    };
    expect(() => validateNodesSearchOutput({ nodes: [hit], cursor: 'page-2' })).not.toThrow();
    expect(() => validateNodesSearchOutput({
      nodes: [{ ...hit, linkStatus: null, folderPath: '' }],
      cursor: null,
    })).not.toThrow();
    expect(() => validateNodesSearchOutput({ nodes: [hit] })).toThrow(McpToolOutputError);
    expect(() => validateNodesSearchOutput({
      nodes: [{ id: 'node-1', folderPath: 'Reading', linkStatus: 'healthy' }],
      cursor: null,
    })).toThrow(McpToolOutputError);
    expect(() => validateNodesSearchOutput({
      nodes: [{ ...hit, linkStatus: 'ok' }],
      cursor: null,
    })).toThrow(McpToolOutputError);
    expect(() => validateNodesSearchOutput({ nodes: [{ ...hit, title: 'hidden' }], cursor: null }))
      .toThrow(McpToolOutputError);
  });
});

describe(`MCP-0025 move and delete_subtree inputs ${evidence}`, () => {
  it('validates nodes.move input, including base revisions', () => {
    const input = {
      collectionId: 'collection-1',
      nodeId: 'node-1',
      baseRevision: 'node-rev',
      newParentId: 'folder-2',
      baseSourceParentRevision: 'source-rev',
      baseTargetParentRevision: 'target-rev',
    };
    expect(validateNodesMoveInput(input)).toEqual(input);
    expect(validateNodesMoveInput({ ...input, afterId: null, beforeId: 'sibling-1' })).toMatchObject({
      afterId: null,
      beforeId: 'sibling-1',
    });
    const { baseRevision: _revision, ...missingRevision } = input;
    expectInputError(validateNodesMoveInput, missingRevision);
    expectInputError(validateNodesMoveInput, { ...input, position: 3 });
  });

  it('validates nodes.delete_subtree input', () => {
    const input = {
      collectionId: 'collection-1',
      targetId: 'folder-1',
      baseRevision: 'folder-rev',
    };
    expect(validateNodesDeleteSubtreeInput(input)).toEqual(input);
    expectInputError(validateNodesDeleteSubtreeInput, {
      collectionId: 'collection-1',
      baseRevision: 'folder-rev',
    });
    expectInputError(validateNodesDeleteSubtreeInput, { ...input, affectedCount: 1 });
  });
});
