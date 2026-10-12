import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAnonymousPublicBinding, encodeMcp20260728ParamValue } from '@know-n/colp/mcp';
import { createPhase4bMcpRequestContext } from '../../../src/modules/mcp/request-context.js';
import { NODES_SEARCH_TOOL_DESCRIPTOR } from '../../../src/modules/mcp/application-catalog.js';
import type { McpApplicationFacade } from '../../../src/modules/mcp/application-facade.js';
import { validateStrictToolParamHeaders } from '../../../src/transport/mcp/mcp-strict-application-adapter.js';

test('search validates headers derived from its advertised schema, including optional collection scope', async () => {
  const context = createPhase4bMcpRequestContext({
    headers: [
      { name: 'MCP-Protocol-Version', value: '2026-07-28' },
      { name: 'Mcp-Method', value: 'tools/call' },
      { name: 'Mcp-Name', value: 'nodes.search' },
    ],
    body: { method: 'tools/call', params: {
      name: 'nodes.search',
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
    } },
    binding: createAnonymousPublicBinding({ resourceAudience: 'https://example.test/mcp', securityEpoch: '1' }),
    scope: ['mcp:read:public', 'nodes:read'],
    abortSignal: new AbortController().signal,
  });
  const facade = { listTools: async () => ({ tools: [NODES_SEARCH_TOOL_DESCRIPTOR] }) } as unknown as McpApplicationFacade;
  const params = { name: 'nodes.search', arguments: { query: 'test', collectionId: '集合' } };
  const headers = [{ name: 'Mcp-Param-X-Collection-Id', value: encodeMcp20260728ParamValue('集合') }];
  await validateStrictToolParamHeaders(context, params, headers, facade);
  await validateStrictToolParamHeaders(context, { name: 'nodes.search', arguments: { query: 'test' } }, [], facade);
  await assert.rejects(validateStrictToolParamHeaders(context, params, [], facade), { wireCode: -32020 });
  await assert.rejects(validateStrictToolParamHeaders(context, params, [{ ...headers[0]!, value: 'other' }], facade), { wireCode: -32020 });
});
