/**
 * Test-only MCP 2026-07-28 fixture host / transport bridge.
 *
 * Wraps the official `@modelcontextprotocol/server` `createMcpHandler`
 * modern entry with COLP's Modern-only policy, fault injection, bounded
 * concurrency (backpressure), abort propagation and restart/shutdown
 * semantics. Lives under `tests/fixtures/` only: it is never bundled by
 * tsup, never appears in package exports, and never enters the production
 * tarball (asserted by mcp-2026-07-28-sdk-lock-contract.test.ts).
 */

import {
  createMcpHandler,
  type McpHandlerRequestOptions,
  type McpServerFactory,
  type ServerEventBus,
  type ServerNotifier,
} from '@modelcontextprotocol/server';

import { findLegacySessionHeader } from './legacy-policy.js';
import {
  createFixtureServerFactory,
  FIXTURE_WRITE_APPROVED_STATE_PREFIX,
  FIXTURE_WRITE_TOOL_INPUT_SCHEMA,
  FIXTURE_WRITE_TOOL_NAME,
} from './server.js';

export { FIXTURE_WRITE_APPROVED_STATE_PREFIX, FIXTURE_WRITE_TOOL_INPUT_SCHEMA, FIXTURE_WRITE_TOOL_NAME } from './server.js';

export interface RecordedRequest {
  httpMethod: string;
  path: string;
  /** JSON-RPC method from the request body, when it parsed. */
  method: string | undefined;
  /** `Mcp-Method` header value, when present. */
  headerMethod: string | undefined;
  /** `_meta['io.modelcontextprotocol/protocolVersion']` from the body. */
  envelopeProtocolVersion: string | undefined;
  aborted: boolean;
  held: boolean;
  queued: boolean;
  droppedAsLegacy: boolean;
  startedAt: number;
  /** Millisecond timestamp when the request was actually dispatched to the SDK. */
  dispatchedAt: number | undefined;
  completedAt: number | undefined;
  responseStatus: number | undefined;
  responseContentType: string | undefined;
}

export type FixtureFault =
  | { readonly kind: 'fail'; readonly status: number; readonly body: string }
  | { readonly kind: 'malformed-json' }
  | { readonly kind: 'hold' }
  | { readonly kind: 'delay'; readonly ms: number };

export interface FixtureHostStats {
  readonly requests: readonly RecordedRequest[];
  readonly injectedFaults: number;
  readonly inFlight: number;
  readonly generation: number;
}

export interface FixtureHostOptions {
  readonly serverFactory?: McpServerFactory;
  /** Bounded dispatch concurrency; 0 (default) means unlimited. */
  readonly maxConcurrent?: number;
}

export interface FixtureHost {
  fetch(request: Request, options?: McpHandlerRequestOptions): Promise<Response>;
  close(): Promise<void>;
  restart(): Promise<void>;
  injectFault(fault: FixtureFault): void;
  readonly notify: ServerNotifier;
  readonly bus: ServerEventBus;
  readonly stats: FixtureHostStats;
}

const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const MODERN_ONLY = Object.freeze(['2026-07-28']);

function legacyHeaderRejection(header: string): Response {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: UNSUPPORTED_PROTOCOL_VERSION,
      message: `Legacy session header '${header}' is not supported by COLP MCP 2026-07-28 (Modern-only).`,
      data: { supported: MODERN_ONLY, header },
    },
  });
  return new Response(body, {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

export function createFixtureHost(options: FixtureHostOptions = {}): FixtureHost {
  const serverFactory = options.serverFactory ?? createFixtureServerFactory();
  const maxConcurrent = options.maxConcurrent ?? 0;
  let handler = createMcpHandler(serverFactory, { legacy: 'reject' });
  let closed = false;
  let generation = 0;
  let injectedFaults = 0;
  let inFlight = 0;

  const requests: RecordedRequest[] = [];
  const faultQueue: FixtureFault[] = [];
  const queue: Array<() => void> = [];

  function buildRecord(request: Request): RecordedRequest {
    const now = Date.now();
    const record: RecordedRequest = {
      httpMethod: request.method,
      path: new URL(request.url).pathname,
      method: undefined,
      headerMethod: request.headers.get('mcp-method') ?? undefined,
      envelopeProtocolVersion: undefined,
      aborted: false,
      held: false,
      queued: false,
      droppedAsLegacy: false,
      startedAt: now,
      dispatchedAt: undefined,
      completedAt: undefined,
      responseStatus: undefined,
      responseContentType: undefined,
    };
    requests.push(record);
    return record;
  }

  async function fillBodyFacts(record: RecordedRequest, request: Request): Promise<void> {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return;
    let text = '';
    try {
      text = await request.clone().text();
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(text) as {
        method?: unknown;
        params?: { _meta?: Record<string, unknown> };
      };
      if (typeof parsed.method === 'string') record.method = parsed.method;
      const meta = parsed.params?._meta;
      const version = meta?.['io.modelcontextprotocol/protocolVersion'];
      if (typeof version === 'string') record.envelopeProtocolVersion = version;
    } catch {
      // Non-JSON bodies are left unparsed; the SDK classifies them.
    }
  }

  function settle(record: RecordedRequest, response: Response): Response {
    record.responseStatus = response.status;
    record.responseContentType = response.headers.get('content-type') ?? undefined;
    record.completedAt = Date.now();
    return response;
  }

  async function delegate(
    record: RecordedRequest,
    request: Request,
    requestOptions?: McpHandlerRequestOptions,
  ): Promise<Response> {
    const onAbort = (): void => {
      record.aborted = true;
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await handler.fetch(request, requestOptions);
      return settle(record, response);
    } catch (error) {
      if (request.signal.aborted) record.aborted = true;
      throw error;
    } finally {
      request.signal.removeEventListener('abort', onAbort);
    }
  }

  async function dispatch(
    record: RecordedRequest,
    request: Request,
    requestOptions: McpHandlerRequestOptions | undefined,
    delayMs: number | undefined,
  ): Promise<Response> {
    if (maxConcurrent > 0 && inFlight >= maxConcurrent) {
      record.queued = true;
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    record.dispatchedAt = Date.now();
    inFlight++;
    try {
      // The delay happens inside the dispatch slot so a delayed exchange keeps
      // its in-flight occupancy and later arrivals observe bounded backpressure.
      if (delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await delegate(record, request, requestOptions);
    } finally {
      inFlight--;
      queue.shift()?.();
    }
  }

  return {
    async fetch(request, requestOptions) {
      if (closed) throw new Error('Fixture host is closed');
      const record = buildRecord(request);
      await fillBodyFacts(record, request);

      const fault = faultQueue.shift();
      if (fault !== undefined) {
        injectedFaults++;
        if (fault.kind === 'fail') {
          return settle(
            record,
            new Response(fault.body, {
              status: fault.status,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (fault.kind === 'malformed-json') {
          return settle(
            record,
            new Response('{not-valid-json', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (fault.kind === 'hold') {
          record.held = true;
          return new Promise<Response>((_, reject) => {
            const onAbort = (): void => {
              record.aborted = true;
              record.completedAt = Date.now();
              request.signal.removeEventListener('abort', onAbort);
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            };
            if (request.signal.aborted) {
              onAbort();
              return;
            }
            request.signal.addEventListener('abort', onAbort, { once: true });
          });
        }
        // delay faults are applied inside dispatch (in-flight window).
      }

      const legacyHeader = findLegacySessionHeader(request);
      if (legacyHeader !== undefined) {
        record.droppedAsLegacy = true;
        return settle(record, legacyHeaderRejection(legacyHeader));
      }
      if (fault?.kind === 'delay') {
        return dispatch(record, request, requestOptions, fault.ms);
      }
      return dispatch(record, request, requestOptions, undefined);
    },
    async close() {
      if (closed) return;
      closed = true;
      await handler.close();
    },
    async restart() {
      await handler.close();
      closed = false;
      generation++;
      handler = createMcpHandler(serverFactory, { legacy: 'reject' });
    },
    injectFault(fault) {
      faultQueue.push(fault);
    },
    get notify() {
      return handler.notify;
    },
    get bus() {
      return handler.bus;
    },
    get stats() {
      return {
        requests,
        injectedFaults,
        inFlight,
        generation,
      };
    },
  };
}
