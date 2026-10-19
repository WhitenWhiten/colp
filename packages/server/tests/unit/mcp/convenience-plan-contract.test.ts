import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createMcpHttpSdkTransport } from '../../support/mcp-http-sdk-client.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';
import { signedCompatWriteClient, startCompatWriteApp } from '../../support/phase4b-mcp-compat-write.js';

for (const [name, applied] of [['nodes.move', false], ['nodes.move', true], ['nodes.delete_subtree', false], ['changes.plan', false]] as const) {
  test(`${name} exposes its reason and ${applied ? 'committed' : 'pending'} outcome through the HTTP schema`, async () => {
    const reason = 'Group the research notes before reviewing the library';
    let plannedReason: unknown;
    const fixture = createInMemoryWriteToolFixture({ planCatalog: { async plan(input) {
      plannedReason = (input as { reason: unknown }).reason;
      return {
        planId: 'convenience-plan', expiresAt: '2030-01-01T00:00:00.000Z', risk: name === 'nodes.move' ? 'medium' : 'high',
        requiresApproval: !applied, mode: applied ? 'ready' : 'awaiting_approval',
        ...(applied ? { approvedBy: 'policy', versionId: 'undo-version' } as const
          : { approvalMethod: 'out_of_band', approvalUri: 'https://approve.example/approvals/convenience-plan' }),
        summary: 'Authoritative plan summary', operationsDigest: 'digest', baseRevisions: {}, requiredScopes: [],
        impact: { collections: 1, nodes: 1, annotations: 0, attachments: 0, relations: 0, privateFieldsExcluded: [] },
        operations: name === 'nodes.move'
          ? [{ type: 'move_node', risk: 'medium', collectionId: 'collection-1', nodeId: 'node-1', parentId: 'folder-1', impact: 'Move one bookmark' }]
          : [{ type: 'delete_subtree', risk: 'high', collectionId: 'collection-1', nodeId: 'node-1', subtreeCount: 1, impact: 'Delete one bookmark' }],
        status: applied ? 'consumed' : 'pending',
      };
    } } });
    const auth = await signedCompatWriteClient();
    const server = startCompatWriteApp({ writeFixture: fixture, verifier: auth.verifier });
    const client = new Client({ name: 'plan-http-test', version: '1' }, {
      capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } },
    });
    try {
      await client.connect(createMcpHttpSdkTransport(server.app, auth.strictToken));
      const listed = await client.listTools();
      const definition = listed.tools.find((tool) => tool.name === name)!;
      if (name === 'changes.plan') assert.ok(definition.inputSchema.oneOf);
      else assert.ok((definition.inputSchema.properties as Record<string, unknown>).reason);
      const result = await client.callTool({ name, arguments: {
        ...(name === 'changes.plan' ? { collectionId: 'collection-1', dryRun: true, reason, operations: [
          { type: 'create_node', ref: 'new', parentId: 'folder-1', node: { kind: 'folder', title: 'New folder', visibility: 'private' } },
          { type: 'move_node', nodeId: 'node-1', parentRef: 'new' },
          { type: 'delete_subtree', nodeId: 'node-2' },
        ] } : { collectionId: 'collection-1', nodeId: 'node-1', reason,
          ...(name === 'nodes.move' ? { parentId: 'folder-1' } : {}) }),
      } });
      const output = result.structuredContent as Record<string, unknown>;
      assert.equal(plannedReason, reason);
      if (name !== 'changes.plan') {
        assert.equal(output.applied, applied);
        assert.equal(output.status, applied ? 'consumed' : 'pending');
      }
      assert.equal(output.requiresApproval, !applied);
      assert.equal(output.expiresAt, '2030-01-01T00:00:00.000Z');
      if (!applied) assert.equal(output.approvalUri, 'https://approve.example/approvals/convenience-plan');
    } finally {
      await client.close();
      await server.app.close();
    }
  });
}
