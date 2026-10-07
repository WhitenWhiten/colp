import { describe, expect, it } from 'vitest';

import {
  isPrivateOrLocalAddress,
  isPrivateOrLocalLiteralHostname,
} from '../../src/shared/private-or-local-literal-host.js';
import {
  createMcpStatelessToolCore,
  McpToolScopeDeniedError,
} from '../../src/mcp/shared/tools.js';
import { normalizeMcp20260728Error } from '../../src/mcp/2026-07-28/results.js';
import { authenticatedBinding } from '../mcp/authenticated-binding-fixture.js';

const context = (scope: readonly string[]) => ({
  binding: authenticatedBinding({ principalId: 'scope-test' }),
  scope,
  budget: { maxDepth: 32, maxNodes: 100, maxBytes: 16_384, maxOperations: 10 },
  abortSignal: new AbortController().signal,
  authorization: {},
});

describe('Security Cloud 2026-10 MCP/SSRF boundaries', () => {
  it.each([
    '224.0.0.1',
    '240.0.0.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    'ff02::1',
    '2001:db8::1',
    '2001:2::1',
    'fec0::1',
    '64:ff9b:1::a00:1',
    '64:ff9b::a00:1',
    '::ffff:0:a00:1',
  ])('rejects non-global literal %s', (host) => {
    expect(isPrivateOrLocalLiteralHostname(host)).toBe(true);
    expect(isPrivateOrLocalAddress(host)).toBe(true);
  });

  it('filters scoped tools and denies an invocation outside the effective scope', async () => {
    const core = createMcpStatelessToolCore({
      tools: [{
        definition: {
          name: 'admin.inspect',
          description: 'Requires an admin scope.',
          inputSchema: { type: 'object', additionalProperties: false },
          requiredScopes: ['audit:read'],
        },
        invoke: () => ({ structuredContent: { ok: true } }),
      }],
    });
    expect(core.listTools(context([]))).toHaveLength(0);
    expect(core.listTools(context(['audit:read']))).toHaveLength(1);
    await expect(core.callTool(context([]), 'admin.inspect', {})).rejects.toBeInstanceOf(McpToolScopeDeniedError);
  });

  it('normalizes SDK-shaped errors without returning caller-controlled message/data', () => {
    expect(normalizeMcp20260728Error({
      code: -32602,
      message: 'secret supplied by caller',
      data: { token: 'plaintext-secret' },
    })).toEqual({ code: -32602, message: 'Invalid params.' });
  });
});
