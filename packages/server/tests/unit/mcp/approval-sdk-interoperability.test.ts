import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createMcpHttpSdkTransport } from '../../support/mcp-http-sdk-client.js';
import {
  createWriteFixture, signedCompatWriteClient, startCompatWriteApp,
  verifiedWriteBinding, writeApprovalContext, planArguments, commitArguments,
} from '../../support/phase4b-mcp-compat-write.js';

for (const mode of ['approved', 'pending', 'declined', 'cancelled', 'unsupported'] as const) {
  test(`the official SDK handles ${mode} approvals through the production HTTP routes`, async () => {
    const fixture = createWriteFixture();
    const auth = await signedCompatWriteClient();
    const server = startCompatWriteApp({ writeFixture: fixture, verifier: auth.verifier });
    const binding = await verifiedWriteBinding({ verifier: auth.verifier, token: auth.strictToken });
    let prompts = 0;
    let calls = 0;
    const client = new Client({ name: 'approval-http-test', version: '1' }, {
      capabilities: mode === 'unsupported' ? {} : { elicitation: { url: {} } },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    });
    if (mode !== 'unsupported') client.setRequestHandler('elicitation/create', async (request) => {
      prompts += 1;
      assert.equal(request.params.mode, 'url');
      if (mode === 'approved' && request.params.mode === 'url') {
        await fixture.bundle.adapter.recordOutOfBandApproval(
          new URL(request.params.url).pathname.split('/').at(-1)!, writeApprovalContext(binding),
        );
      }
      return { action: mode === 'declined' ? 'decline' : mode === 'cancelled' ? 'cancel' : 'accept' };
    });
    const transport = createMcpHttpSdkTransport(server.app, auth.strictToken, (body) => {
      if (body.method === 'tools/call') calls += 1;
    });
    try {
      await client.connect(transport);
      await client.listTools();
      const planned = await client.callTool({ name: 'changes.plan', arguments: planArguments() });
      assert.equal(prompts, mode === 'unsupported' ? 0 : 1);
      const planId = (planned.structuredContent as { planId: string }).planId;
      const result = await client.callTool({ name: 'changes.commit', arguments: commitArguments(planId) });
      assert.ok(calls <= 4);
      assert.equal((await fixture.planStore.get(planId))?.status, mode === 'approved' ? 'consumed' : 'pending');
      if (mode !== 'approved') assert.equal((result.structuredContent as { status: string }).status, 'awaiting_approval');
      else assert.ok((result.structuredContent as { committedAt: string }).committedAt);
    } finally {
      await client.close();
      await server.app.close();
    }
  });
}
