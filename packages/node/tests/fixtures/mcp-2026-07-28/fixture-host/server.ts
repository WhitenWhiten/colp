/**
 * Harness server factory for the MCP 2026-07-28 fixture host. It builds a
 * fresh `McpServer` per serving unit (one HTTP request / one discover probe)
 * around the official `@modelcontextprotocol/server` SDK — the fixture host
 * does NOT hand-write a JSON-RPC/SSE engine. The server exposes a single
 * static resource so `server/discover` reports real capabilities, plus a
 * write tool that demonstrates the Modern Write / MRTR round trip
 * (COLP-MCP-15): the first `tools/call` leg returns `input_required` with a
 * server-minted `requestState` (Plan created, approval pending out-of-band);
 * the retry echoes the `requestState` (approval granted) and completes.
 */

import {
  acceptedContent,
  fromJsonSchema,
  inputRequired,
  McpServer,
  type McpServerFactory,
} from '@modelcontextprotocol/server';

export const FIXTURE_SERVER_INFO = Object.freeze({
  name: 'colp-fixture-host',
  version: '0.0.0',
});

export const FIXTURE_RESOURCE_URI = 'fixture://ping';

/** Write tool served by the fixture host for the Modern Write/MRTR e2e. */
export const FIXTURE_WRITE_TOOL_NAME = 'fixture.write';

/** The retry marker that proves an out-of-band approval happened. */
export const FIXTURE_WRITE_APPROVED_STATE_PREFIX = 'fixture-approved:';

export const FIXTURE_WRITE_TOOL_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({ note: { type: 'string' } }),
  required: Object.freeze(['note']),
  additionalProperties: false,
});

/** Creates the official-server factory used by the test-only fixture host. */
export function createFixtureServerFactory(): McpServerFactory {
  return () => {
    const server = new McpServer({ ...FIXTURE_SERVER_INFO });
    server.registerResource(
      'ping',
      FIXTURE_RESOURCE_URI,
      { title: 'Fixture ping resource', mimeType: 'text/plain' },
      async (uri) => ({ contents: [{ uri: uri.href, text: 'pong' }] }),
    );
    server.registerTool(
      FIXTURE_WRITE_TOOL_NAME,
      {
        description: 'Write a fixture value after an out-of-band approval.',
        inputSchema: fromJsonSchema(FIXTURE_WRITE_TOOL_INPUT_SCHEMA),
      },
      async (args, ctx) => {
        const note = (args as { note?: string }).note ?? '';
        const state = ctx.mcpReq.requestState();
        if (typeof state !== 'string' || !state.startsWith(FIXTURE_WRITE_APPROVED_STATE_PREFIX)) {
          // First leg: plan pending out-of-band approval. No server-to-client
          // request is initiated; the server-minted requestState correlates
          // the retry with the same plan (COLP Modern Write/MRTR semantics).
          return inputRequired({
            requestState: `${FIXTURE_WRITE_APPROVED_STATE_PREFIX}${note}`,
          });
        }
        // Retry after out-of-band approval: the echoed requestState resumes
        // the same plan and the write completes.
        const confirmed = acceptedContent<{ approved: boolean }>(
          ctx.mcpReq.inputResponses,
          'approval',
        );
        if (confirmed?.approved === false) {
          return { content: [{ type: 'text', text: `declined:${note}` }] };
        }
        return { content: [{ type: 'text', text: `applied:${note}` }] };
      },
    );
    return server;
  };
}
