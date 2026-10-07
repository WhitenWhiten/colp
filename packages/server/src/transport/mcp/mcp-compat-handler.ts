/**
 * T-04 official SDK stateless legacy serving for `/collections/-/mcp-compat`.
 * T-05 catalog/result mapping lives in `mcp-compat-read-adapter.ts`.
 * T-06 write schema/result mapping lives in `mcp-compat-write-adapter.ts`.
 *
 * POST after T-03 admission: era-gate with `toWebRequest` + `isLegacyRequest`,
 * then `toNodeHandler({ fetch: legacyStatelessFallback(factory) })`. Protocol
 * version admission is T-03 (`mcp-compat-admission.ts`) and must not use the
 * SDK default negotiated version as the gate. The host still injects the
 * response header `MCP-Protocol-Version: 2025-11-25` because SDK @2.0.0 omits
 * it. GET/DELETE never reach this module.
 */
import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import {
  McpServer,
  isLegacyRequest,
  legacyStatelessFallback,
  type McpRequestContext,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import {
  MCP_COMPAT_INITIALIZE_INSTRUCTIONS,
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  MCP_COMPAT_PROTOCOL_VERSIONS,
  MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS,
  MCP_COMPAT_UNSUPPORTED_PROTOCOL_RPC_CODE,
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  redactMcpCompatOnerror,
  resolvePhase4bMcpServerInfo,
  type McpApplicationContext,
  type McpApplicationFacade,
} from '../../modules/mcp/index.js';
import {
  dropAuthorizationHeader,
  type McpCompatVerifiedAdmission,
} from './mcp-compat-admission.js';
import { installMcpCompatReadCatalog } from './mcp-compat-read-adapter.js';
import {
  attachMcpCompatHijackObserver,
  type McpCompatExecutionObserver,
} from './mcp-compat-execution-observer.js';

export interface McpCompatInflight {
  readonly abort: () => void;
  readonly destroy: () => void;
}

export interface McpCompatLifecycle {
  admitting: boolean;
  readonly inflight: Set<McpCompatInflight>;
}

export function createMcpCompatLifecycle(): McpCompatLifecycle {
  return { admitting: true, inflight: new Set() };
}

/** Stop new admission and abort hijacked in-flight sockets (no session table). */
export function drainMcpCompatLifecycle(lifecycle: McpCompatLifecycle): void {
  lifecycle.admitting = false;
  for (const item of [...lifecycle.inflight]) {
    item.abort();
    item.destroy();
  }
}

export function jsonRpcIdFromBody(body: unknown): string | number | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const id = (body as { readonly id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export function sendMcpCompatUnsupportedModern(reply: FastifyReply, body: unknown): unknown {
  return reply
    .code(MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS)
    .type('application/json; charset=utf-8')
    .send({
      jsonrpc: '2.0',
      id: jsonRpcIdFromBody(body),
      error: {
        code: MCP_COMPAT_UNSUPPORTED_PROTOCOL_RPC_CODE,
        message: `Unsupported protocol version. Use POST ${PHASE4B_MCP_CONFIG_ENDPOINT_PATH} for MCP 2026-07-28.`,
        data: {
          supported: [...MCP_COMPAT_PROTOCOL_VERSIONS],
          strictEndpoint: PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
        },
      },
    });
}

export function sendMcpCompatBatchNotSupported(reply: FastifyReply): unknown {
  return reply
    .code(400)
    .type('application/json; charset=utf-8')
    .send({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32_600,
        message: 'JSON-RPC batches are not supported.',
      },
    });
}

export function attachMcpCompatNegotiatedVersionHeader(
  res: ServerResponse,
  hostHeaders: OutgoingHttpHeaders = {},
): void {
  const originalWriteHead = res.writeHead.bind(res);
  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader('MCP-Protocol-Version', MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION);
  res.removeHeader('mcp-session-id');
  res.setHeader = ((name: string, value: OutgoingHttpHeader) => {
    if (name.toLowerCase() === 'mcp-session-id') return res;
    return originalSetHeader(name, value);
  }) as typeof res.setHeader;
  res.writeHead = ((
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    maybeHeaders?: OutgoingHttpHeaders | OutgoingHttpHeader[],
  ) => {
    if (typeof statusMessageOrHeaders === 'string') {
      return originalWriteHead(
        statusCode,
        statusMessageOrHeaders,
        mergeCompatResponseHeaders(maybeHeaders, hostHeaders),
      );
    }
    return originalWriteHead(
      statusCode,
      mergeCompatResponseHeaders(statusMessageOrHeaders, hostHeaders),
    );
  }) as typeof res.writeHead;
}

function mergeCompatResponseHeaders(
  sdkHeaders: OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined,
  hostHeaders: OutgoingHttpHeaders,
): OutgoingHttpHeaders {
  const next: OutgoingHttpHeaders = { ...hostHeaders };
  if (Array.isArray(sdkHeaders)) {
    for (const entry of sdkHeaders) {
      if (!Array.isArray(entry)) continue;
      next[String(entry[0])] = entry[1] as OutgoingHttpHeader;
    }
  } else if (sdkHeaders !== undefined) {
    Object.assign(next, sdkHeaders);
  }
  for (const key of Object.keys(next)) {
    const lower = key.toLowerCase();
    if (lower === 'mcp-protocol-version' || lower === 'mcp-session-id') delete next[key];
  }
  next['MCP-Protocol-Version'] = MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION;
  return next;
}

function mcpCompatServingOnerror(error: Error): void {
  redactMcpCompatOnerror(error);
}

/**
 * Fail-closed: `toWebRequest` copies `IncomingMessage.headers`. Admission
 * already deleted Authorization; strip again on the Web Request so a missed
 * Node-map delete cannot reach `isLegacyRequest`.
 */
function stripWebRequestAuthorization(request: Request): Request {
  if (!request.headers.has('authorization')) return request;
  request.headers.delete('authorization');
  if (!request.headers.has('authorization')) return request;
  const headers = new Headers();
  for (const [name, value] of request.headers.entries()) {
    if (name.toLowerCase() === 'authorization') continue;
    headers.append(name, value);
  }
  return new Request(request, { headers });
}

function hostHeadersFromReply(reply: FastifyReply): OutgoingHttpHeaders {
  const next: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value === undefined) continue;
    next[name] = typeof value === 'number' ? String(value) : value;
  }
  return next;
}

function jsonRpcMethodFromBody(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const method = (body as { readonly method?: unknown }).method;
  return typeof method === 'string' ? method : undefined;
}

function skipCompatToolList(method: string | undefined): boolean {
  if (method === undefined) return false;
  if (method === 'tools/list') return false;
  return method === 'tools/call'
    || method === 'initialize'
    || method === 'notifications/initialized'
    || method === 'ping'
    || method.startsWith('resources/');
}

function createBareCompatServer(writeEnabled: boolean): McpServer {
  const info = resolvePhase4bMcpServerInfo(writeEnabled);
  return new McpServer(
    { name: info.name, version: info.version },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
      supportedProtocolVersions: [...MCP_COMPAT_PROTOCOL_VERSIONS],
      instructions: MCP_COMPAT_INITIALIZE_INSTRUCTIONS,
    },
  );
}

function createCompatServerFactory(input: {
  readonly facade: McpApplicationFacade;
  readonly applicationContext: McpApplicationContext;
  readonly abortController: AbortController;
  readonly writeEnabled: boolean;
  readonly observer: McpCompatExecutionObserver;
  readonly onSdkFactory?: (ctx: McpRequestContext) => void;
  readonly jsonRpcMethod?: string;
}): McpServerFactory {
  return async (ctx) => {
    input.onSdkFactory?.(ctx);
    const server = createBareCompatServer(input.writeEnabled);
    const method = input.jsonRpcMethod;
    if (
      method === 'initialize'
      || method === 'notifications/initialized'
      || method === 'ping'
    ) {
      return server;
    }
    try {
      await installMcpCompatReadCatalog({
        server,
        facade: input.facade,
        applicationContext: input.applicationContext,
        abortController: input.abortController,
        observer: input.observer,
        skipToolList: skipCompatToolList(method),
      });
    } catch (error) {
      input.observer.observeExecution(
        input.abortController.signal.aborted || isCompatHandlerCancel(error)
          ? 'cancelled'
          : 'dependency_error',
      );
      throw error;
    }
    return server;
  };
}

export type McpCompatDispatchResult =
  | { readonly kind: 'batch' }
  | { readonly kind: 'unsupported_modern' }
  | { readonly kind: 'hijacked'; readonly servingError: boolean };

export async function dispatchMcpCompatLegacyPost(input: {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly admitted: McpCompatVerifiedAdmission;
  readonly facade: McpApplicationFacade;
  readonly writeEnabled: boolean;
  readonly abortController: AbortController;
  readonly lifecycle: McpCompatLifecycle;
  readonly observer: McpCompatExecutionObserver;
  readonly onSdkFactory?: (ctx: McpRequestContext) => void;
}): Promise<McpCompatDispatchResult> {
  if (Array.isArray(input.request.body)) {
    sendMcpCompatBatchNotSupported(input.reply);
    input.observer.observeBatchRejected();
    return { kind: 'batch' };
  }
  dropAuthorizationHeader(input.request);
  const probe = stripWebRequestAuthorization(
    await toWebRequest(input.request.raw, input.request.body),
  );
  if (!(await isLegacyRequest(probe, input.request.body))) {
    sendMcpCompatUnsupportedModern(input.reply, input.request.body);
    input.observer.observeUnsupportedModern();
    return { kind: 'unsupported_modern' };
  }
  const factory = createCompatServerFactory({
    facade: input.facade,
    applicationContext: input.admitted.applicationContext,
    abortController: input.abortController,
    writeEnabled: input.writeEnabled,
    observer: input.observer,
    onSdkFactory: input.onSdkFactory,
    jsonRpcMethod: jsonRpcMethodFromBody(input.request.body),
  });
  const fetch = legacyStatelessFallback(factory, mcpCompatServingOnerror);
  const nodeHandler = toNodeHandler({ fetch }, { onerror: mcpCompatServingOnerror });
  input.reply.hijack();
  attachMcpCompatNegotiatedVersionHeader(input.reply.raw, hostHeadersFromReply(input.reply));
  const hijackObserver = attachMcpCompatHijackObserver(input.reply.raw, input.observer);
  const raw = input.request.raw as IncomingMessage;
  const inflight: McpCompatInflight = {
    abort: () => {
      if (!input.abortController.signal.aborted) {
        input.abortController.abort(new DOMException('MCP compat drained', 'AbortError'));
      }
    },
    destroy: () => {
      raw.destroy();
    },
  };
  input.lifecycle.inflight.add(inflight);
  let servingError = false;
  try {
    await nodeHandler(raw, input.reply.raw, input.request.body);
  } catch (error) {
    servingError = true;
    mcpCompatServingOnerror(error instanceof Error ? error : new Error(String(error)));
    if (!input.reply.raw.headersSent) {
      input.reply.raw.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      input.reply.raw.end(JSON.stringify({
        jsonrpc: '2.0',
        id: jsonRpcIdFromBody(input.request.body),
        error: { code: -32_603, message: 'Internal error' },
      }));
    }
  } finally {
    input.lifecycle.inflight.delete(inflight);
  }
  hijackObserver.flush();
  if (servingError) input.observer.observeExecution('dependency_error');
  return { kind: 'hijacked', servingError };
}

function isCompatHandlerCancel(error: unknown): boolean {
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  return error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.message === 'aborted');
}
