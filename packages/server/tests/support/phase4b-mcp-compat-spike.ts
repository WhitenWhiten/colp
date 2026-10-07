/**
 * Test-only Fastify + official MCP SDK v2 spike for T-00. Not production
 * transport: it never registers `/collections/-/mcp-compat`. T-08 production
 * path matrix uses `phase4b-mcp-compat-matrix-harness.ts` (raw JSON-RPC inject).
 */
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  McpServer,
  legacyStatelessFallback,
  type AuthInfo,
  type LegacyHttpHandler,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import {
  MCP_COMPAT_AUTH_TOKEN_SENTINEL,
  MCP_COMPAT_METHOD_NOT_ALLOWED_BODY,
  MCP_COMPAT_PROTOCOL_VERSIONS,
  redactMcpCompatOnerror,
} from '../../src/modules/mcp/index.js';
import { waitForCondition } from './async-test-helpers.js';

export const MCP_COMPAT_SPIKE_PATH = '/mcp-compat-spike';
export const MCP_COMPAT_CANARY_BEARER = 'canary-taint-T00-KnowN-mcp-compat-NOTASECRET';

export interface McpCompatSpikeCapture {
  readonly counters: { toolCalls: number; resourceReads: number };
  readonly factoryAuth: AuthInfo[];
  readonly toolAuth: Array<AuthInfo | undefined>;
  readonly onerror: Error[];
  readonly parsedBodyProvided: boolean[];
  readonly rawReadableEnded: boolean[];
  readonly hijacked: boolean[];
  readonly logs: string[];
  readonly metrics: Readonly<Record<string, string>>[];
  readonly sessionIds: string[];
  aborted: boolean;
  slowStarted: boolean;
  sawCanaryAuthorization: boolean;
  liveConnectedCount(): number;
}

export interface McpCompatSpikeOptions {
  readonly canaryAuthorization?: boolean;
  readonly factoryError?: string;
  readonly slowTool?: boolean;
  readonly supportedProtocolVersions?: readonly string[];
}

export interface McpCompatSpikeHandle {
  readonly app: FastifyInstance;
  readonly capture: McpCompatSpikeCapture;
  parse(response: { readonly headers: Record<string, unknown>; readonly payload: string }): unknown;
  waitForAbort(): Promise<void>;
  waitForSlowStart(): Promise<void>;
  waitForLiveServers(count: number): Promise<void>;
}

type NodeRequestWithAuth = IncomingMessage & { auth?: AuthInfo };

export function mcpCompatAcceptHeaders(protocolVersion?: string): Record<string, string> {
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(protocolVersion === undefined ? {} : { 'mcp-protocol-version': protocolVersion }),
  };
}

export function mcpCompatInitializeBody(
  protocolVersion: string,
  clientInfo: { readonly name: string; readonly version: string },
  id = 1,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo,
    },
  };
}

export function mcpCompatInitializedBody(): Record<string, unknown> {
  return { jsonrpc: '2.0', method: 'notifications/initialized' };
}

export function mcpCompatToolsListBody(id = 2): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

export function mcpCompatToolsCallBody(
  name: string,
  id = 3,
  args: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

export function mcpCompatResourcesListBody(
  id = 4,
  params: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'resources/list', params };
}

export function mcpCompatResourceTemplatesListBody(id = 5): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'resources/templates/list', params: {} };
}

export function mcpCompatResourcesReadBody(uri: string, id = 4): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'resources/read', params: { uri } };
}

export function parseMcpCompatHttpPayload(contentType: string | undefined, body: string): unknown {
  const media = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (body.length === 0) return undefined;
  const looksLikeSse = media === 'text/event-stream'
    || body.startsWith('event:')
    || body.startsWith('data:');
  if (looksLikeSse) {
    const messages: unknown[] = [];
    for (const block of body.split('\n\n')) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice('data:'.length).trim();
        if (data.length === 0) continue;
        messages.push(JSON.parse(data) as unknown);
      }
    }
    const rpc = messages.find((message) => {
      if (message === null || typeof message !== 'object') return false;
      return 'result' in message || 'error' in message || 'method' in message;
    });
    return rpc ?? messages.at(-1);
  }
  if (media === 'application/json' || media === '') {
    return JSON.parse(body) as unknown;
  }
  throw new Error(`unexpected MCP content type: ${contentType ?? '<missing>'}`);
}

export function asMcpCompatJsonRpc(payload: unknown): {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
} {
  if (payload === null || typeof payload !== 'object') return {};
  const record = payload as {
    readonly result?: Record<string, unknown>;
    readonly error?: { readonly code: number; readonly message: string };
  };
  return { result: record.result, error: record.error };
}

export function readConstructedSupportedProtocolVersions(server: McpServer): readonly string[] {
  const protocol = server.server as unknown as { readonly _supportedProtocolVersions: readonly string[] };
  return Object.freeze([...protocol._supportedProtocolVersions]);
}

export function createSentinelAuthInfo(): AuthInfo {
  return {
    token: MCP_COMPAT_AUTH_TOKEN_SENTINEL,
    clientId: 'spike-client',
    scopes: ['mcp:read:public'],
    extra: { knownBinding: { kind: 'verified-upstream' } },
  };
}

export async function postCompatLegacyFetch(
  fetchHandler: LegacyHttpHandler,
  body: unknown,
  headers: Record<string, string> = mcpCompatAcceptHeaders(),
  authInfo?: AuthInfo,
): Promise<{ status: number; headers: Headers; text: string; payload: unknown }> {
  const request = new Request('http://spike.test/mcp-compat-spike', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await fetchHandler(request, {
    parsedBody: body,
    ...(authInfo === undefined ? {} : { authInfo }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    payload: parseMcpCompatHttpPayload(response.headers.get('content-type') ?? undefined, text),
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  await waitForCondition(predicate, {
    timeoutMs: 2_000,
    description: label,
  });
}

function createSpikeFactory(
  capture: McpCompatSpikeCapture,
  options: McpCompatSpikeOptions,
  liveServers: McpServer[],
): McpServerFactory {
  const versions = options.supportedProtocolVersions ?? MCP_COMPAT_PROTOCOL_VERSIONS;
  return (ctx) => {
    if (options.factoryError !== undefined) {
      throw new Error(options.factoryError);
    }
    if (ctx.authInfo !== undefined) capture.factoryAuth.push(ctx.authInfo);
    const server = new McpServer(
      { name: 'known-mcp-compat-spike', version: '0.0.0-t00' },
      {
        capabilities: { tools: {}, resources: {} },
        supportedProtocolVersions: [...versions],
      },
    );
    liveServers.push(server);
    server.registerTool(
      'spike.ping',
      { description: 'T-00 spike ping tool' },
      async (toolCtx) => {
        capture.counters.toolCalls += 1;
        capture.toolAuth.push(toolCtx.http?.authInfo);
        return { content: [{ type: 'text', text: 'pong' }] };
      },
    );
    if (options.slowTool === true) {
      server.registerTool(
        'spike.slow',
        { description: 'T-00 abort probe' },
        async (toolCtx) => {
          capture.slowStarted = true;
          await new Promise<void>((_resolve, reject) => {
            const abort = () => {
              capture.aborted = true;
              reject(new Error('aborted'));
            };
            if (toolCtx.mcpReq.signal.aborted) {
              abort();
              return;
            }
            toolCtx.mcpReq.signal.addEventListener('abort', abort, { once: true });
          });
          return { content: [{ type: 'text', text: 'never' }] };
        },
      );
    }
    server.registerResource(
      'spike-item',
      'spike://item',
      { description: 'T-00 spike resource' },
      async (uri) => {
        capture.counters.resourceReads += 1;
        return { contents: [{ uri: uri.href, text: 'spike-body', mimeType: 'text/plain' }] };
      },
    );
    return server;
  };
}

export async function createMcpCompatSpikeFastifyApp(
  options: McpCompatSpikeOptions = {},
): Promise<McpCompatSpikeHandle> {
  const liveServers: McpServer[] = [];
  const capture: McpCompatSpikeCapture = {
    counters: { toolCalls: 0, resourceReads: 0 },
    factoryAuth: [],
    toolAuth: [],
    onerror: [],
    parsedBodyProvided: [],
    rawReadableEnded: [],
    hijacked: [],
    logs: [],
    metrics: [],
    sessionIds: [],
    aborted: false,
    slowStarted: false,
    sawCanaryAuthorization: false,
    liveConnectedCount() {
      return liveServers.filter((server) => server.isConnected()).length;
    },
  };
  const inner = legacyStatelessFallback(createSpikeFactory(capture, options, liveServers), (error) => {
    capture.onerror.push(redactMcpCompatOnerror(error));
  });
  const fetch: LegacyHttpHandler = async (request, requestOptions) => {
    capture.parsedBodyProvided.push(requestOptions?.parsedBody !== undefined);
    const response = await inner(request, requestOptions);
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId !== null && sessionId.length > 0) capture.sessionIds.push(sessionId);
    return response;
  };
  const nodeHandler = toNodeHandler({ fetch }, {
    onerror: (error) => {
      capture.onerror.push(redactMcpCompatOnerror(error));
    },
  });
  const app = Fastify({ logger: false });
  app.route({
    method: ['GET', 'DELETE'],
    url: MCP_COMPAT_SPIKE_PATH,
    onRequest: async (request) => {
      delete request.headers['content-type'];
    },
    handler: async (_request, reply) => reply
      .code(405)
      .header('Allow', 'POST')
      .type('text/plain')
      .send(MCP_COMPAT_METHOD_NOT_ALLOWED_BODY),
  });
  app.post(MCP_COMPAT_SPIKE_PATH, async (request, reply) => {
    if (options.canaryAuthorization === true) {
      const authorization = String(request.headers.authorization ?? '');
      capture.sawCanaryAuthorization = authorization === `Bearer ${MCP_COMPAT_CANARY_BEARER}`;
      if (!capture.sawCanaryAuthorization) {
        return reply.code(401).type('text/plain').send('Unauthorized');
      }
    }
    capture.rawReadableEnded.push(request.raw.readableEnded === true || request.raw.complete === true);
    const raw = request.raw as NodeRequestWithAuth;
    raw.auth = createSentinelAuthInfo();
    capture.metrics.push({ surface: 'compat', auth: 'bearer' });
    capture.logs.push('mcp_compat_spike_dispatch');
    reply.hijack();
    capture.hijacked.push(true);
    await nodeHandler(raw, reply.raw, request.body);
  });
  await app.ready();
  return {
    app,
    capture,
    parse(response) {
      return parseMcpCompatHttpPayload(
        String(response.headers['content-type'] ?? ''),
        response.payload,
      );
    },
    waitForAbort() {
      return waitUntil(() => capture.aborted, 'abort');
    },
    waitForSlowStart() {
      return waitUntil(() => capture.slowStarted, 'slow tool start');
    },
    waitForLiveServers(count) {
      return waitUntil(() => capture.liveConnectedCount() === count, `live servers === ${String(count)}`);
    },
  };
}
