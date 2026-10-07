import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  PHASE4B_MCP_SERVER_INFO,
  PHASE4B_MCP_WRITE_SERVER_INFO,
  createPhase4bMcpDiscoverResult,
  createPhase4bMcpResult,
  resolvePhase4bMcpServerInfo,
} from '../../../src/modules/mcp/index.js';

test('server/discover identity switches with write-enabled', () => {
  assert.deepEqual(PHASE4B_MCP_SERVER_INFO, { name: 'Known MCP Read', version: '0.1.0' });
  assert.deepEqual(PHASE4B_MCP_WRITE_SERVER_INFO, { name: 'Known MCP', version: '0.1.0' });
  assert.equal(resolvePhase4bMcpServerInfo(false), PHASE4B_MCP_SERVER_INFO);
  assert.equal(resolvePhase4bMcpServerInfo(true), PHASE4B_MCP_WRITE_SERVER_INFO);

  const read = createPhase4bMcpDiscoverResult();
  assert.deepEqual(
    (read._meta as { readonly 'io.modelcontextprotocol/serverInfo'?: unknown })
      ?.['io.modelcontextprotocol/serverInfo'],
    PHASE4B_MCP_SERVER_INFO,
  );
  const write = createPhase4bMcpDiscoverResult(true);
  assert.deepEqual(
    (write._meta as { readonly 'io.modelcontextprotocol/serverInfo'?: unknown })
      ?.['io.modelcontextprotocol/serverInfo'],
    PHASE4B_MCP_WRITE_SERVER_INFO,
  );
  assert.deepEqual(
    createPhase4bMcpResult({ method: 'tools/list', fields: { tools: [] } }, true)._meta
      ?.['io.modelcontextprotocol/serverInfo'],
    PHASE4B_MCP_WRITE_SERVER_INFO,
  );
});
