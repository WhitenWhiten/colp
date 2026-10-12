import { expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcp20260728DiscoverResult } from '../../src/mcp/2026-07-28/discovery.js';
import { materializeClosedMcpToolSchema } from '../../src/mcp/schema-ref.js';
import { createContext, harness, planRequest, serverInfo } from './mcp-2026-07-28-write-adapter-fixture.js';

it.each(['approved', 'pending', 'unsupported'] as const)('official SDK handles %s approval without exhausting MRTR rounds', async (mode) => {
  const { adapter, binding, planStore } = harness();
  let prompts = 0;
  let calls = 0;
  const client = new Client({ name: 'approval-client', version: '1' }, {
    capabilities: mode === 'unsupported' ? {} : { elicitation: { url: {} } },
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  });
  if (mode !== 'unsupported') client.setRequestHandler('elicitation/create', async (request) => {
    prompts += 1;
    expect(request.params.mode).toBe('url');
    if (mode === 'approved' && request.params.mode === 'url') {
      const planId = new URL(request.params.url).pathname.split('/').at(-1)!;
      await adapter.recordOutOfBandApproval(planId, createContext(binding));
    }
    return { action: 'accept' };
  });
  const transport = new StreamableHTTPClientTransport(new URL('https://host.example/mcp'), {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const context = createContext(binding, {
        headers: [...new Headers(init?.headers)].map(([name, value]) => ({ name, value })),
        body: { method: body.method, params: body.params },
      });
      let result;
      if (body.method === 'server/discover') {
        result = createMcp20260728DiscoverResult({ serverInfo, capabilities: { tools: {} } });
      } else if (body.method === 'tools/list') {
        const listed = await adapter.listTools(context);
        result = { ...listed, tools: (listed.tools as Record<string, unknown>[]).map((tool) => ({
          ...tool, inputSchema: materializeClosedMcpToolSchema(tool.inputSchema as Record<string, unknown>),
          outputSchema: materializeClosedMcpToolSchema(tool.outputSchema as Record<string, unknown>),
        })) };
      } else {
        calls += 1;
        const { _meta, ...params } = body.params;
        result = await adapter.callTool(context, params);
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  try {
    await client.connect(transport);
    await client.listTools();
    const result = await client.callTool({ name: 'changes.plan', arguments: planRequest() });
    expect(prompts).toBe(mode === 'unsupported' ? 0 : 1);
    expect(calls).toBeLessThanOrEqual(2);
    expect(planStore.stats().plans).toBe(1);
    if (mode !== 'approved') expect(result.structuredContent).toMatchObject({ status: 'awaiting_approval' });
    const commit = await client.callTool({ name: 'changes.commit', arguments: {
      planId: (result.structuredContent as { planId: string }).planId, idempotencyKey: 'sdk-commit-retry',
    } });
    if (mode === 'approved') expect(commit.structuredContent).toHaveProperty('committedAt');
    else expect(commit.structuredContent).toMatchObject({ status: 'awaiting_approval' });
    expect(calls).toBeLessThanOrEqual(4);
    expect(planStore.stats().plans).toBe(1);

  } finally {
    await client.close();
  }
});
