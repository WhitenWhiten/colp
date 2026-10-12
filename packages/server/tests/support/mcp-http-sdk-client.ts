import type { FastifyInstance, HTTPMethods } from 'fastify';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AUDIENCE, MCP_TEST_REQUEST_HOST } from './phase4b-mcp-transport-scaffold.js';

/** The official SDK traverses the real Fastify routes, admission and wire adapters. */
export function createMcpHttpSdkTransport(
  app: FastifyInstance,
  token: string,
  observe?: (body: { method: string; params?: Record<string, unknown> }, headers: Headers) => void,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(AUDIENCE), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('host', MCP_TEST_REQUEST_HOST);
      const payload = init?.body === undefined ? undefined : String(init.body);
      if (payload) observe?.(JSON.parse(payload), headers);
      const response = await app.inject({
        method: method as HTTPMethods, url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(headers), payload,
      });
      return new Response(response.payload, {
        status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : String(value)]])),
      });
    },
  });
}
