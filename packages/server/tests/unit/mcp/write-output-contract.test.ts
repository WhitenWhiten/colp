import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { createAuthenticatedBinding, materializeClosedMcpToolSchema } from '@know-n/colp/mcp';
import { createPhase4bMcpRequestContext } from '../../../src/modules/mcp/request-context.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';
import { createMcpToolInputValidator } from '../../support/mcp-tool-schema-validator.js';

test('every direct write receipt conforms to the output schema a strict client discovers', async () => {
  const { bundle } = createInMemoryWriteToolFixture();
  const context = createPhase4bMcpRequestContext({
    headers: [{ name: 'MCP-Protocol-Version', value: '2026-07-28' }, { name: 'Mcp-Method', value: 'tools/call' }],
    body: { method: 'tools/call', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
    } } },
    binding: createAuthenticatedBinding({ credentialKind: 'oauth', principalId: 'owner', clientId: 'client',
      credentialBindingId: 'credential', resourceAudience: 'https://example.test/mcp', securityEpoch: '1' }),
    scope: ['nodes:write', 'annotations:write', 'collections:write', 'collections:create'],
    authorization: { accountSubjectId: 'owner' },
  });
  const tools = (await bundle.adapter.listTools(context)).tools as Record<string, unknown>[];
  const cases: [string, Record<string, unknown>, boolean][] = [
    ['collections.create', { title: 'Notebook', idempotencyKey: randomUUID() }, true],
    ['collections.update', { collectionId: 'collection-1', baseRevision: 'r1', patch: { title: 'Notebook' } }, true],
    ['nodes.create', { collectionId: 'collection-1', node: { kind: 'folder', title: 'Inbox' } }, true],
    ['nodes.create', { collectionId: 'collection-1', node: { kind: 'folder', title: 'Inbox' }, dryRun: true, confirmApply: false }, false],
    ['nodes.update', { collectionId: 'collection-1', nodeId: 'node-1', baseRevision: 'r1', patch: { title: 'Updated' } }, true],
    ['annotations.create', { collectionId: 'collection-1', nodeId: 'node-1', value: 'Note' }, true],
    ['annotations.update', { collectionId: 'collection-1', annotationId: 'annotation-1', baseRevision: 'r1', patch: { value: 'Updated' } }, true],
  ];
  cases.push(
    ['nodes.create', { collectionId: 'collection-1', node: { kind: 'folder', title: 'Inbox' }, dryRun: true }, false],
    ['nodes.create', { collectionId: 'collection-1', node: { kind: 'folder', title: 'Inbox' }, confirmApply: false }, false],
    ['nodes.update', { collectionId: 'collection-1', nodeId: 'node-1', baseRevision: 'r1', patch: { title: 'Preview' }, dryRun: true }, false],
    ['collections.update', { collectionId: 'collection-1', baseRevision: 'r1', patch: { title: 'Preview' }, dryRun: true }, false],
    ['annotations.create', { collectionId: 'collection-1', nodeId: 'node-1', value: 'Preview', dryRun: true }, false],
    ['annotations.update', { collectionId: 'collection-1', annotationId: 'annotation-1', baseRevision: 'r1', patch: { value: 'Preview' }, dryRun: true }, false],
  );
  for (const [name, args, expectedApplied] of cases) {
    const result = await bundle.adapter.callTool(context, { name, arguments: args });
    const schema = tools.find((tool) => tool.name === name)!.outputSchema as Record<string, unknown>;
    const validate = createMcpToolInputValidator(materializeClosedMcpToolSchema(schema));
    assert.doesNotThrow(() => validate(result.structuredContent), name);
    assert.equal((result.structuredContent as { applied: boolean }).applied, expectedApplied);
  }
});
