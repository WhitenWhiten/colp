import { describe, expect, it, vi } from 'vitest';

import { createMcp20260728ReadToolAdapter } from '../../src/mcp/2026-07-28/tools.js';
import { createMcpStatelessToolCore } from '../../src/mcp/shared/tools.js';
import { createMcpWriteToolGateway, McpWriteToolScopeDeniedError } from '../../src/mcp/write-tools.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import { readContext } from './read-trusted-context-fixture.js';
import { changePlanOptions, createContext, harness, lowRiskDescriptor, DEFAULT_BUDGET } from './mcp-2026-07-28-write-adapter-fixture.js';

const serverInfo = { name: 'scope-test', version: '0.0.0' };
const binding = authenticatedBinding();
const scopedContext = (scope: readonly string[]) => createContext(binding, { scope });
const trustedWrite = (scope: readonly string[]) => ({
  binding, scope, budget: DEFAULT_BUDGET,
  abortSignal: new AbortController().signal, authorization: {},
});

describe('Tool discovery and invocation use effective scopes', () => {
  it('filters Modern read tools and rejects a hidden tool before invoking the host', async () => {
    const invoke = vi.fn(() => ({ structuredContent: { ok: true } }));
    const core = createMcpStatelessToolCore({ tools: [{
      definition: {
        name: 'audit.inspect', description: 'Read audit', requiredScopes: ['audit:read'],
        inputSchema: { type: 'object', additionalProperties: false },
      }, invoke,
    }] });
    const adapter = createMcp20260728ReadToolAdapter({ toolCore: core, serverInfo });
    expect((await adapter.listTools(scopedContext([]))).tools).toEqual([]);
    expect((await adapter.listTools(scopedContext(['audit:read']))).tools).toEqual([
      expect.objectContaining({ name: 'audit.inspect' }),
    ]);
    await expect(adapter.callTool(scopedContext([]), { name: 'audit.inspect', arguments: {} }))
      .rejects.toMatchObject({ kind: 'invalid_params' });
    expect(invoke).not.toHaveBeenCalled();
    await expect(adapter.callTool(scopedContext(['audit:read']), { name: 'audit.inspect', arguments: {} }))
      .resolves.toMatchObject({ structuredContent: { ok: true } });
    expect(core.listTools(readContext({ scope: [] }))).toEqual([]);
  });

  it('filters gateway and Modern write tools and denies a scoped low-risk call before host execution', async () => {
    const invoke = vi.fn(() => ({ ok: true }));
    const descriptor = lowRiskDescriptor({ requiredScopes: ['collections:write'], invoke });
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(), lowRiskTools: { 'custom.write': descriptor },
    });
    expect(gateway.listTools(trustedWrite([]))).toEqual([]);
    expect(gateway.listTools(trustedWrite(['collections:write'])).map(tool => tool.name)).toEqual(['custom.write']);
    await expect(gateway.callTool('custom.write', { mode: 'private' }, trustedWrite([])))
      .rejects.toBeInstanceOf(McpWriteToolScopeDeniedError);
    expect(invoke).not.toHaveBeenCalled();
    await expect(gateway.callTool('custom.write', { mode: 'private' }, trustedWrite(['collections:write'])))
      .resolves.toMatchObject({ structuredContent: { ok: true } });

    const { adapter } = harness({ lowRiskTools: { 'custom.write': descriptor } });
    expect((await adapter.listTools(scopedContext([]))).tools).toEqual([]);
    expect((await adapter.listTools(scopedContext(['collections:write']))).tools).toEqual([
      expect.objectContaining({ name: 'custom.write' }),
    ]);
    await expect(adapter.callTool(scopedContext([]), { name: 'custom.write', arguments: { mode: 'private' } }))
      .rejects.toMatchObject({ data: { code: 'tool_scope_denied' } });
  });

  it.each([{ scopes: [''] }, { scopes: ['collections:read', 'collections:read'] }])('rejects invalid read Tool scopes %j', ({ scopes }) => {
    expect(() => createMcp20260728ReadToolAdapter({
      serverInfo,
      toolCore: {
        listTools: () => [{ name: 'custom.read', description: 'Read', inputSchema: { type: 'object' }, requiredScopes: scopes }],
        callTool: async () => ({ structuredContent: {} }),
      },
    })).toThrow(TypeError);
  });

  it.each([{ scopes: [''] }, { scopes: ['collections:write', 'collections:write'] }])('rejects invalid write Tool scopes %j', ({ scopes }) => {
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: { 'custom.write': lowRiskDescriptor({ requiredScopes: scopes }) },
    })).toThrow(TypeError);
  });
});
