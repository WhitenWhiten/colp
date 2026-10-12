import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createAuthenticatedBinding, materializeClosedMcpToolSchema } from '@know-n/colp/mcp';
import { createPhase4bMcpRequestContext } from '../../../src/modules/mcp/request-context.js';
import { createPhase4bMcpDiscoverResult } from '../../../src/modules/mcp/discovery.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';

for (const mode of ['approved', 'pending', 'unsupported'] as const) {
  test(`the deployed SDK supports ${mode} approvals through an official client`, async () => {
    const { bundle, planStore } = createInMemoryWriteToolFixture();
    const binding = createAuthenticatedBinding({ credentialKind: 'oauth', principalId: 'owner', clientId: 'client',
      credentialBindingId: 'credential', resourceAudience: 'https://example.test/mcp', securityEpoch: '1' });
    let context: ReturnType<typeof createPhase4bMcpRequestContext>;
    let prompts = 0;
    let calls = 0;
    const client = new Client({ name: 'approval-test', version: '1' }, {
      capabilities: mode === 'unsupported' ? {} : { elicitation: { url: {} } },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    });
    if (mode !== 'unsupported') client.setRequestHandler('elicitation/create', async (request) => {
      prompts += 1;
      assert.equal(request.params.mode, 'url');
      if (mode === 'approved' && request.params.mode === 'url') {
        await bundle.adapter.recordOutOfBandApproval(new URL(request.params.url).pathname.split('/').at(-1)!, context);
      }
      return { action: 'accept' };
    });
    const transport = new StreamableHTTPClientTransport(new URL('https://example.test/mcp'), {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        context = createPhase4bMcpRequestContext({ binding, scope: ['nodes:write', 'access:write', 'changes:commit'],
          authorization: { accountSubjectId: 'owner' },
          headers: [...new Headers(init?.headers)].map(([name, value]) => ({ name, value })),
          body: { method: body.method, params: body.params },
        });
        let result;
        if (body.method === 'server/discover') result = createPhase4bMcpDiscoverResult(true);
        else if (body.method === 'tools/list') {
          const listed = await bundle.adapter.listTools(context);
          result = { ...listed, tools: (listed.tools as Record<string, unknown>[]).map((tool) => ({ ...tool,
            inputSchema: materializeClosedMcpToolSchema(tool.inputSchema as Record<string, unknown>),
            outputSchema: materializeClosedMcpToolSchema(tool.outputSchema as Record<string, unknown>),
          })) };
        } else {
          calls += 1;
          const { _meta, ...params } = body.params;
          result = await bundle.adapter.callTool(context, params);
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    try {
      await client.connect(transport);
      await client.listTools();
      const planned = await client.callTool({ name: 'changes.plan', arguments: {
        operations: [{ type: 'set_visibility', collectionId: 'collection-1', baseRevision: 'r1', input: { visibility: 'protected' } }],
        reason: 'Review visibility', dryRun: true,
      } });
      assert.equal(prompts, mode === 'unsupported' ? 0 : 1);
      const result = await client.callTool({ name: 'changes.commit', arguments: {
        planId: (planned.structuredContent as { planId: string }).planId, idempotencyKey: 'commit-once',
      } });
      assert.ok(calls <= 4);
      assert.equal((await planStore.get((planned.structuredContent as { planId: string }).planId))?.status, mode === 'approved' ? 'consumed' : 'pending');
      if (mode !== 'approved') assert.equal((result.structuredContent as { status: string }).status, 'awaiting_approval');
      else assert.ok((result.structuredContent as { committedAt: string }).committedAt);
    } finally {
      await client.close();
    }
  });
}
