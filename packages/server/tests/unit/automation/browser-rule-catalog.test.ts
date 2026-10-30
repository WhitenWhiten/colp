import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { createAutomationToolPort, createMcpApplicationContext, withAutomationCatalog, type McpApplicationFacade } from '../../../src/modules/mcp/index.js';
import type { WorkPrincipal, DeviceBridgeOperation } from '../../../src/modules/automation/index.js';

test('browser rule tools validate inputs, enforce scopes and use the durable device bridge', async () => {
  const request = vi.fn(async (_actor: WorkPrincipal, operation: DeviceBridgeOperation, args: Readonly<Record<string, unknown>>) => ({
    requestId: String(args.commandId), replicaId: String(args.replicaId), operation, state: 'pending' as const,
    expiresAt: new Date(Date.now() + 86400000).toISOString(), result: null,
  }));
  const base: McpApplicationFacade = { listTools: async () => ({ tools: [] }), callTool: async () => { throw Error('unexpected standard call'); },
    listResources: async () => ({ resources: [] }), listResourceTemplates: async () => ({ resourceTemplates: [] }), readResource: async () => ({ contents: [] }) };
  const api = withAutomationCatalog(base, createAutomationToolPort({
    access: async () => ({ id: 'profile', revision: '1', automationEnabled: true, catalogs: ['automationManager'], pairedTargets: [] }),
    configurations: { execute: async () => { throw Error('unexpected manager call'); } },
    pairing: { pair: async () => { throw Error('unexpected pair'); }, mine: async () => ({ items: [], nextCursor: null }) },
    cursorKey: 'browser-rule-catalog-cursor-key-at-least-32', deviceBridge: { request, get: async () => { throw Error('unused'); } },
  }));
  const context = createMcpApplicationContext({ principal: { kind: 'authenticated', principalId: 'owner', clientId: 'agent', credentialBindingId: 'binding',
    resourceAudience: 'https://example.test/collections/-/mcp', securityEpoch: '1' }, scopes: ['automation:read', 'automation:manage', 'nodes:write'],
    abortSignal: new AbortController().signal, budgets: { maxDepth: 32, maxNodes: 10000, maxBytes: 1000000, maxOperations: 100 },
    correlationId: randomUUID(), authorization: { accountSubjectId: 'subject' } });
  const args = { replicaId: 'replica', commandId: randomUUID(), baseRevision: 1, request: {
    operation: 'save', draft: { name: 'Papers', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }], action: { kind: 'file', folderNativeId: '30' } },
  } };
  expect(await api.callTool(context, 'automation.browser_rules.configure', args)).toMatchObject({ kind: 'complete', structuredContent: { state: 'pending' } });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'owner' }), 'browser_rules.configure', args);
  expect(await api.callTool(context, 'automation.browser_rules.configure', { ...args, baseRevision: undefined }))
    .toMatchObject({ kind: 'rejected', stableCode: 'invalid_arguments' });
  expect(await api.callTool(context, 'automation.browser_rules.configure', { ...args, request: { operation: 'eval', code: 'arbitrary' } }))
    .toMatchObject({ kind: 'rejected', stableCode: 'invalid_arguments' });
  expect(await api.callTool({ ...context, scopes: ['automation:manage'] }, 'automation.browser_rules.run_apply', {
    replicaId: 'replica', commandId: randomUUID(), previewId: 'preview',
  })).toMatchObject({ kind: 'rejected', stableCode: 'unknown_tool' });
  expect(request).toHaveBeenCalledTimes(1);
});
