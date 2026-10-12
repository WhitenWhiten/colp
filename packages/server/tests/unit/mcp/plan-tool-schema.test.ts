import assert from 'node:assert/strict';
import { test } from 'vitest';
import { materializeClosedMcpToolSchema, createAuthenticatedBinding } from '@know-n/colp/mcp';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';
import { createPhase4bMcpRequestContext } from '../../../src/modules/mcp/request-context.js';
import { assertHostPlanOperations } from '../../../src/modules/mcp/plan-tool-schema.js';

test('the host plan catalog excludes unsupported operations and stays within its byte budget', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const listed = await fixture.bundle.adapter.listTools(createPhase4bMcpRequestContext({
    headers: [{ name: 'MCP-Protocol-Version', value: '2026-07-28' }, { name: 'Mcp-Method', value: 'tools/list' }],
    body: { method: 'tools/list', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
    } } },
    binding: createAuthenticatedBinding({ credentialKind: 'oauth', principalId: 'owner', clientId: 'client',
      credentialBindingId: 'credential', resourceAudience: 'https://example.test/mcp', securityEpoch: '1' }),
    scope: ['nodes:write', 'access:write'], authorization: { accountSubjectId: 'owner' },
  }));
  const tool = (listed.tools as Record<string, unknown>[]).find((tool) => tool.name === 'changes.plan')!;
  assert.ok(tool);
  const schema = materializeClosedMcpToolSchema(tool.inputSchema as Record<string, unknown>);
  const json = JSON.stringify(schema);
  assert.doesNotMatch(json, /create_key|rotate_key|set_rate_limit|publish_release|sync_mirror/);
  assert.ok(Buffer.byteLength(json) < 4_000);
  assert.doesNotThrow(() => assertHostPlanOperations({ operations: [{ type: 'set_visibility' }] }));
  assert.throws(() => assertHostPlanOperations({ operations: [{ type: 'create_key' }] }), { wireCode: -32602 });
});
