#!/usr/bin/env node
/** Isolated ChatGPT file-materialization probe: no COLP data, auth, or resources. */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { fromJsonSchema, legacyStatelessFallback, McpServer } from '@modelcontextprotocol/server';

export function createMcpJsonProbeHandler({ textOnly = false, onToolCall = () => {} } = {}) {
  return legacyStatelessFallback(() => {
    const server = new McpServer({ name: 'colp-json-probe', version: '1.0.0' }, {
      capabilities: { tools: {} },
      supportedProtocolVersions: ['2025-11-25'],
      instructions: 'Call diagnostics.ping to test delivery of a fixed inline JSON result.',
    });
    server.registerTool('diagnostics.ping', {
      description: 'Return the fixed object {"ok":true}. No data access, files, or side effects.',
      inputSchema: fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
      ...(!textOnly ? { outputSchema: fromJsonSchema({
        type: 'object', properties: { ok: { type: 'boolean', const: true } },
        required: ['ok'], additionalProperties: false,
      }) } : {}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    }, async () => {
      onToolCall();
      return {
        content: [{ type: 'text', text: '{"ok":true}' }],
        ...(!textOnly ? { structuredContent: { ok: true } } : {}),
      };
    });
    return server;
  });
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--text-only')) {
    throw new Error('Usage: node scripts/mcp-json-probe.mjs [--text-only]');
  }
  const port = Number(process.env.MCP_JSON_PROBE_PORT ?? 3133);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid MCP_JSON_PROBE_PORT');
  const textOnly = process.argv.includes('--text-only');
  const handler = toNodeHandler({ fetch: createMcpJsonProbeHandler({ textOnly,
    onToolCall: () => process.stderr.write(`${JSON.stringify({
      time: new Date().toISOString(), event: 'tool_called', tool: 'diagnostics.ping',
    })}\n`),
  }) });
  let sequence = 0;
  const server = createServer((request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    const requestNumber = ++sequence;
    const log = (event, extra = {}) => process.stderr.write(`${JSON.stringify({
      time: new Date().toISOString(), requestNumber, event, ...extra,
    })}\n`);
    log('request_received', { method: request.method });
    response.once('finish', () => log('response_finished', { status: response.statusCode }));
    handler(request, response);
  });
  server.on('error', error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`JSON probe (${textOnly ? 'text only' : 'text + structuredContent'}): http://127.0.0.1:${server.address().port}/mcp\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
