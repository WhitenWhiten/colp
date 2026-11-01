import { createWriteFixture, planArguments } from '../../support/phase4b-mcp-compat-write.js';
import { materializeClosedMcpToolSchema } from '@know-n/colp/mcp';
import { afterEach, expect, test } from 'vitest';
import { PHASE4B_MCP_READ_TOOL_CATALOG, createMcpApplicationContext, withAutomationCatalog, type AutomationProfileAccess, type McpApplicationFacade, type McpOauthVerifier } from '../../../src/modules/mcp/index.js';
import { hostToolSurface, modernBody } from '../../support/phase4b-mcp-transport-scaffold.js';
import { compatJsonRpc, injectCompatLegacyPost, injectStrictPost, startCompatApp } from '../../support/phase4b-mcp-compat-admission.js';
import { mcpCompatToolsCallBody, mcpCompatToolsListBody } from '../../support/phase4b-mcp-compat-spike.js';

let app: ReturnType<typeof startCompatApp>['app'] | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

test('strict and compat requests recheck task selection before core and extension calls', async () => {
  let selection: AutomationProfileAccess['taskToolsets'] = ['recovery'];
  const calls: string[] = [];
  const base: McpApplicationFacade = {
    listTools: async () => ({ tools: [...PHASE4B_MCP_READ_TOOL_CATALOG,{ name: 'changes.plan',description: 'Plan a reviewed change',inputSchema: { type: 'object' },requiredScopes: ['nodes:write','access:write'] }] }),
    callTool: async (_c,name) => { calls.push(name); return { kind: 'complete',content: [{ type: 'text',text: '{}' }],structuredContent: {} }; },
    listResources: async () => ({ resources: [] }), listResourceTemplates: async () => ({ resourceTemplates: [] }), readResource: async () => ({ contents: [] }),
  };
  const facade = withAutomationCatalog(base, {
    access: async () => ({ id: 'profile', revision: '1', automationEnabled: true, catalogs: ['standard','automationManager'], pairedTargets: [], ...(selection === undefined ? {} : { taskToolsets: selection }) }),
    call: async (_c,name) => { calls.push(name); return { kind: 'complete',content: [{ type: 'text',text: '{}' }],structuredContent: {} }; },
  });
  let verifications = 0;
  const verifier: McpOauthVerifier = { verify: async (input) => (verifications++,  ({ binding: { kind: 'authenticated',principalId: 'owner',clientId: 'client',credentialBindingId: 'binding',
    resourceAudience: `https://collections.example.test/collections/-/mcp${input.authorization === 'Bearer compat' ? '-compat' : ''}`,securityEpoch: '1' },accountSubjectId: 'owner',
    scopes: ['mcp:read:own','automation:read','automation:manage','nodes:write','access:write'], expiresAt: new Date(Date.now() + 60_000) } as never)) };
  const tools = hostToolSurface(), write = createWriteFixture();
  const server = startCompatApp({ writeEnabled: true, env: { MCP_OAUTH_SCOPES: 'mcp:read:own,automation:read,automation:manage,nodes:write,access:write' },
    mcpReadTransport: { oauthVerifier: verifier,applicationFacade: facade,readToolAdapter: tools.adapter,readToolParamDeclarations: tools.paramDeclarations,writeToolAdapter: write.bundle.adapter,writeToolParamDeclarations: write.bundle.paramDeclarations } });
  app = server.app;
  const auth = { authorization: 'Bearer test' };
  // Compare actual strict wire catalogs under one synthetic identity and scope set.
  const measurements: Record<string,{ count: number; bytes: number }> = {};
  const directContext = createMcpApplicationContext({ principal: { kind: 'authenticated', principalId: 'owner', clientId: 'client', credentialBindingId: 'binding',resourceAudience: 'https://collections.example.test/collections/-/mcp',securityEpoch: '1' },scopes: ['mcp:read:own','automation:read','automation:manage','nodes:write'],abortSignal: new AbortController().signal,budgets: { maxDepth: 32,maxNodes: 10000,maxBytes: 1000000,maxOperations: 100 },correlationId: 'test',authorization: {} });
  for (const task of [undefined,'recovery','rule-authoring','sync-diagnostics','browser-rules'] as const) {
    selection = task === undefined ? undefined : [task];
    const direct = await facade.listTools(directContext);
    for (const tool of direct.tools) { try { materializeClosedMcpToolSchema(tool.inputSchema); if (tool.outputSchema) materializeClosedMcpToolSchema(tool.outputSchema); } catch (error) { throw new Error(`Schema ${tool.name}: ${String(error)}`); } }
    const response = await injectStrictPost(app,'tools/list',20,auth);
    expect(response.statusCode, response.payload).toBe(200);
    expect(JSON.parse(response.payload).result, response.payload).toBeDefined();
    const definitions = JSON.parse(response.payload).result.tools as { name: string; description: string; inputSchema: unknown }[];
    const directory = definitions.map(({ name,description,inputSchema }) => ({ name,description,inputSchema }));
    measurements[task ?? 'unrestricted'] = { count: directory.length,bytes: Buffer.byteLength(JSON.stringify(directory)) };
  }
  console.log('MC fixture strict catalog UTF-8 bytes',JSON.stringify(measurements));
  expect(measurements.recovery!.bytes).toBeLessThan(measurements.unrestricted!.bytes * 0.3);
  expect(measurements['sync-diagnostics']!.bytes).toBeLessThan(measurements.unrestricted!.bytes * 0.3);
  selection = ['recovery'];
  const strictList = await injectStrictPost(app,'tools/list',1,auth);
  const listed = JSON.parse(strictList.payload).result.tools.map((t: { name: string }) => t.name);
  expect(listed).toContain('collections.get'); expect(listed).toContain('automation.trash.list'); expect(listed).not.toContain('nodes.get');
  const strictDenied = await injectStrictPost(app,'tools/call',2,{ ...auth,'mcp-name': 'nodes.get' },modernBody('tools/call',2,{ name: 'nodes.get',arguments: { collectionId: 'collection-1',nodeId: 'node' } }));
  expect(strictDenied.payload).toMatch(/Unknown tool/i);
  const strictWriteDenied = await injectStrictPost(app,'tools/call',21,{ ...auth,'mcp-name': 'changes.plan' },modernBody('tools/call',21,{ name: 'changes.plan',arguments: planArguments() }));
  expect(strictWriteDenied.payload).toMatch(/Unknown tool/i);
  const strictExtension = await injectStrictPost(app,'tools/call',23,{ ...auth,'mcp-name': 'automation.trash.list' },modernBody('tools/call',23,{ name: 'automation.trash.list',arguments: { collectionId: 'collection-1' } }));
  expect(JSON.parse(strictExtension.payload).result?.resultType).toBe('complete');
  const compatAuth = { authorization: 'Bearer compat' };
  const compatList = await injectCompatLegacyPost(app,mcpCompatToolsListBody(3),'2025-11-25',compatAuth);
  expect(compatJsonRpc(compatList).result?.tools, `${compatList.statusCode} ${compatList.payload} verifications=${verifications} admitted=${server.admissions.length}`).toBeDefined();
  const compatNames = (compatJsonRpc(compatList).result?.tools as { name: string }[]).map(t => t.name);
  expect(compatNames).toContain('automation.trash.list'); expect(compatNames).not.toContain('nodes.get');
  const compatDenied = await injectCompatLegacyPost(app,mcpCompatToolsCallBody('nodes.get',4,{ collectionId: 'collection-1',nodeId: 'node' }),'2025-11-25',compatAuth);
  expect(compatDenied.payload).toMatch(/Unknown tool/i);
  const compatWriteDenied = await injectCompatLegacyPost(app,mcpCompatToolsCallBody('changes.plan',22,planArguments()),'2025-11-25',compatAuth);
  expect(compatWriteDenied.payload).toMatch(/Unknown tool/i);
  const compatAllowed = await injectCompatLegacyPost(app,mcpCompatToolsCallBody('automation.trash.list',5,{ collectionId: 'collection-1' }),'2025-11-25',compatAuth);
  expect(compatJsonRpc(compatAllowed).result?.isError).not.toBe(true);
  selection = [];
  const strictAfter = await injectStrictPost(app,'tools/call',6,{ ...auth,'mcp-name': 'collections.get' },modernBody('tools/call',6,{ name: 'collections.get',arguments: { collectionId: 'collection-1' } }));
  expect(strictAfter.payload).toMatch(/Unknown tool/i);
  const strictExtensionAfter = await injectStrictPost(app,'tools/call',24,{ ...auth,'mcp-name': 'automation.trash.list' },modernBody('tools/call',24,{ name: 'automation.trash.list',arguments: { collectionId: 'collection-1' } }));
  expect(strictExtensionAfter.payload).toMatch(/Unknown tool/i);
  const compatAfter = await injectCompatLegacyPost(app,mcpCompatToolsCallBody('automation.trash.list',7,{ collectionId: 'collection-1' }),'2025-11-25',compatAuth);
  expect(compatAfter.payload).toMatch(/Unknown tool/i);
  expect(calls).toEqual(['automation.trash.list','automation.trash.list']);
});
