/**
 * COLP-MCP-12: minimal MCP Read Tools host example (type-checked).
 *
 * Mirrors the fenced example in `docs/MCP_HOST_GUIDE.md`. The docs version
 * imports from `@know-n/colp/mcp`; this compilable copy uses the
 * internal relative entry so `npm run typecheck` can prove the example
 * surface compiles without a prior `npm run build`.
 *
 * The host owns the Tool execution port and the verified stdio evidence; the
 * package maps that evidence to an authenticated token-free binding
 * (`mapStdioEvidenceToAuthenticatedBinding` — the COLP-MCP-04 replacement for
 * the removed `createMcpStdioCredentialBinding`), builds the stateless Tool
 * core and the Modern `2026-07-28` Read Tool adapter. One frozen adapter
 * serves every request; there is no Session and no per-client instance.
 */
import {
  createMcp20260728ReadToolAdapter,
  createMcp20260728RequestContext,
  createMcpStatelessToolCore,
  mapStdioEvidenceToAuthenticatedBinding,
  type McpToolDefinition,
} from '../../../src/mcp/index.js';

/** Protocol-neutral read-only Tool registration (own-data invoke). */
const collectionsGetDefinition: McpToolDefinition = Object.freeze({
  name: 'collections.get',
  description: 'Read a collection by id.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({ collectionId: { type: 'string' } }),
    required: Object.freeze(['collectionId']),
    additionalProperties: false,
  }),
});

const toolCore = createMcpStatelessToolCore({
  tools: [
    {
      definition: collectionsGetDefinition,
      invoke: async (input) => ({
        structuredContent: { id: input.collectionId },
      }),
    },
  ],
});

/** One frozen adapter instance serves concurrent per-request contexts. */
const readToolAdapter = createMcp20260728ReadToolAdapter({
  toolCore,
  serverInfo: Object.freeze({ name: 'collection-host', version: '0.0.0' }),
});

/**
 * Host transport entry for a Read Tools mount: maps the verified local stdio
 * evidence to a token-free authenticated binding, builds one trusted
 * per-request context and forwards the tool call to the shared adapter.
 */
export async function handleToolCall(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  body: Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>,
): Promise<unknown> {
  const context = createMcp20260728RequestContext({
    headers,
    httpMethod: 'POST',
    body,
    binding: mapStdioEvidenceToAuthenticatedBinding({
      credentialKind: 'stdio',
      principalId: 'local-principal',
      clientId: 'stdio-host-1',
      credentialBindingId: 'local-secret-binding-1',
      resourceAudience: 'urn:colp:resource:public',
      securityEpoch: 'epoch-1',
    }),
  });
  return readToolAdapter.callTool(context, {
    name: 'collections.get',
    arguments: { collectionId: 'collection-1' },
  });
}

export { readToolAdapter, collectionsGetDefinition };
