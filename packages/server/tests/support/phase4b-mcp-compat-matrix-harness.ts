/**
 * T-08 fixed client harness: raw JSON-RPC + HTTP headers on the production
 * `/collections/-/mcp-compat` route. Speaks raw inject JSON-RPC only; the
 * TypeScript MCP client package is not imported (no auto-negotiation).
 */
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_METHOD_NOT_ALLOWED_BODY,
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
} from '../../src/modules/mcp/index.js';
import {
  assertCompatNegotiatedVersionHeader,
  asMcpCompatJsonRpc,
  compatJsonRpc,
  injectCompatLegacyPost,
  injectStrictPost,
  parseCompatHttp,
} from './phase4b-mcp-compat-admission.js';
import {
  mcpCompatAcceptHeaders,
  mcpCompatInitializeBody,
  mcpCompatInitializedBody,
  mcpCompatResourcesReadBody,
  mcpCompatToolsListBody,
} from './phase4b-mcp-compat-spike.js';

export const COMPAT_MATRIX_REVISION = MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION;
export const COMPAT_MATRIX_PATH = MCP_COMPAT_ENDPOINT_PATH;
export const STRICT_MATRIX_PATH = PHASE4B_MCP_CONFIG_ENDPOINT_PATH;

export const CLAUDE_CLIENT = Object.freeze({ name: 'claude-code', version: '2.1.250' });
export const CODEX_CLIENT = Object.freeze({ name: 'codex_cli', version: '0.150.1' });
export const FIXED_0618_CLIENT = Object.freeze({ name: 'legacy-fixed-0618', version: '0.0.0-t08' });

export interface FixedCompatRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface FixedCompatStep {
  readonly name: string;
  readonly request: FixedCompatRequest;
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly payload: string;
  readonly rpc: ReturnType<typeof compatJsonRpc>;
}

export function protocolVersionHeader(headers: Record<string, unknown>): string | undefined {
  const value = headers['mcp-protocol-version'];
  if (Array.isArray(value)) return String(value[0]);
  return value === undefined ? undefined : String(value);
}

export function assertNoSessionId(headers: Record<string, unknown>): void {
  assert.equal(headers['mcp-session-id'], undefined);
}

export function assertNegotiated1125(step: FixedCompatStep, allowedStatus: readonly number[] = [200]): void {
  assert.equal(step.request.url, MCP_COMPAT_ENDPOINT_PATH);
  assert.equal(step.request.method, 'POST');
  assert.equal(allowedStatus.includes(step.statusCode), true, `${step.name} status ${step.statusCode}`);
  assertCompatNegotiatedVersionHeader(step.headers);
  assert.equal(protocolVersionHeader(step.headers), COMPAT_MATRIX_REVISION);
  assert.notEqual(protocolVersionHeader(step.headers), '2025-06-18');
  assertNoSessionId(step.headers);
}

export function assertInitializeSelected1125(step: FixedCompatStep): void {
  assertNegotiated1125(step);
  assert.equal(step.rpc.result?.protocolVersion, COMPAT_MATRIX_REVISION);
  assert.notEqual(step.rpc.result?.protocolVersion, '2025-06-18');
  assert.doesNotMatch(step.payload, /"protocolVersion"\s*:\s*"2025-06-18"/u);
  assert.doesNotMatch(step.payload, /"protocolVersion"\s*:\s*"2025-03-26"/u);
  assert.doesNotMatch(step.payload, /"protocolVersion"\s*:\s*"2024-11-05"/u);
  assert.doesNotMatch(step.payload, /"protocolVersion"\s*:\s*"2024-10-07"/u);
}

export function assertOperationalRejected(step: FixedCompatStep, offeredVersion: string): void {
  assert.equal(step.request.headers['mcp-protocol-version'], offeredVersion);
  assert.ok(step.statusCode >= 400, `${step.name} must fail for ${offeredVersion}`);
  assert.notEqual(step.statusCode, 200);
  assert.notEqual(protocolVersionHeader(step.headers), offeredVersion);
}

export function assertPlain405(step: FixedCompatStep): void {
  assert.equal(step.statusCode, 405);
  assert.equal(step.headers.allow, 'POST');
  assert.match(String(step.headers['content-type'] ?? ''), /^text\/plain\b/u);
  assert.equal(step.payload, MCP_COMPAT_METHOD_NOT_ALLOWED_BODY);
  assert.doesNotMatch(step.payload, /jsonrpc/u);
  assert.doesNotMatch(step.payload, /"error"/u);
}

export function assertNoEndpointRetarget(step: FixedCompatStep): void {
  assert.equal(step.headers.location, undefined);
  assert.equal(step.headers['content-location'], undefined);
  assert.ok(step.statusCode < 300 || step.statusCode >= 400, `${step.name} must not 3xx to the other endpoint`);
  assert.doesNotMatch(step.payload, /retry the (strict|compat)|automatic fallback|retarget/iu);
}

export function createFixedCompatClient(app: FastifyInstance) {
  async function post(
    name: string,
    body: unknown,
    protocolVersion?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<FixedCompatStep> {
    const headers = {
      ...mcpCompatAcceptHeaders(protocolVersion),
      ...extraHeaders,
    };
    const response = await injectCompatLegacyPost(app, body, protocolVersion, extraHeaders);
    return stepFromInject(name, {
      method: 'POST',
      url: MCP_COMPAT_ENDPOINT_PATH,
      headers,
      body,
    }, response);
  }

  async function method(
    name: string,
    httpMethod: 'GET' | 'DELETE',
    headers: Record<string, string> = {},
    payload = '',
  ): Promise<FixedCompatStep> {
    const response = await app.inject({
      method: httpMethod,
      url: MCP_COMPAT_ENDPOINT_PATH,
      headers,
      payload,
    });
    return stepFromInject(name, {
      method: httpMethod,
      url: MCP_COMPAT_ENDPOINT_PATH,
      headers,
      body: payload.length === 0 ? undefined : payload,
    }, response);
  }

  return {
    initialize(protocolVersion: string, clientInfo: { readonly name: string; readonly version: string }, extra: Record<string, string> = {}) {
      return post(
        `initialize offer ${protocolVersion}`,
        mcpCompatInitializeBody(protocolVersion, clientInfo),
        undefined,
        extra,
      );
    },
    initialized(protocolVersion = COMPAT_MATRIX_REVISION) {
      return post('notifications/initialized', mcpCompatInitializedBody(), protocolVersion);
    },
    toolsList(protocolVersion = COMPAT_MATRIX_REVISION, extra: Record<string, string> = {}, id = 2) {
      return post('tools/list', mcpCompatToolsListBody(id), protocolVersion, extra);
    },
    resourcesRead(uri: string, protocolVersion = COMPAT_MATRIX_REVISION, id = 4) {
      return post('resources/read', mcpCompatResourcesReadBody(uri, id), protocolVersion);
    },
    get(headers: Record<string, string> = { accept: 'text/event-stream, application/json' }) {
      return method('GET', 'GET', headers);
    },
    delete(headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }) {
      return method('DELETE', 'DELETE', headers, '');
    },
    post,
    injectStrict(
      method: string,
      id: number | string | null,
      headers: Record<string, string> = {},
      body?: string,
    ) {
      return injectStrictPost(app, method, id, headers, body);
    },
  };
}

function stepFromInject(
  name: string,
  request: FixedCompatRequest,
  response: { readonly statusCode: number; readonly headers: Record<string, unknown>; readonly payload: string },
): FixedCompatStep {
  return {
    name,
    request,
    statusCode: response.statusCode,
    headers: response.headers,
    payload: response.payload,
    rpc: parseRpcSafely(response),
  };
}

function parseRpcSafely(response: {
  readonly headers: Record<string, unknown>;
  readonly payload: string;
}): ReturnType<typeof compatJsonRpc> {
  const media = String(response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (media === 'text/plain') return asMcpCompatJsonRpc(undefined);
  try {
    return asMcpCompatJsonRpc(parseCompatHttp(response));
  } catch {
    return asMcpCompatJsonRpc(undefined);
  }
}
