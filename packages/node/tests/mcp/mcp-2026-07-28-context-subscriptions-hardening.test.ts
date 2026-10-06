/**
 * MCP 2026-07-28 request-context and subscriptions/listen hardening
 * (coverage gaps).
 *
 * Covers the fail-closed branches of `src/mcp/2026-07-28/request-context.ts`
 * (budgets, body/header validation, trusted re-validation, capability leaf
 * checks, x-mcp-header scanning) and `src/mcp/2026-07-28/subscriptions.ts`
 * (host configuration, listen param validation, request id, stream waiter and
 * teardown paths). Each case asserts a stable public observation.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  Mcp20260728RequestError,
  createMcp20260728RequestContext,
  decodeMcp20260728ParamValue,
  encodeMcp20260728ParamValue,
  needsMcp20260728Base64Encoding,
  requireMcp20260728ClientCapability,
  requireMcp20260728RequestContext,
  scanMcp20260728XMcpHeaderDeclarations,
  validateMcp20260728ParamHeaders,
  type Mcp20260728HeaderField,
  type Mcp20260728RequestContextInput,
} from '../../src/mcp/2026-07-28/request-context.js';
import {
  createMcp20260728SubscriptionsListenAdapter,
  type Mcp20260728SubscriptionsListenAdapterOptions,
  type Mcp20260728SubscriptionsListenSession,
} from '../../src/mcp/2026-07-28/subscriptions.js';
import type {
  McpChangeSignal,
  McpChangeSignalListener,
  McpChangeSignalSourcePort,
} from '../../src/mcp/shared/change-signal.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const serverInfo = Object.freeze({ name: 'colp-hardening-server', version: '0.0.0' });

function meta(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...overrides,
  };
}

function header(name: string, value: string): Mcp20260728HeaderField {
  return { name, value };
}

function contextInput(
  method: string,
  params: Readonly<Record<string, unknown>> | undefined,
  overrides: Readonly<Record<string, unknown>> = {},
): Mcp20260728RequestContextInput {
  return {
    headers: [header('mcp-protocol-version', '2026-07-28'), header('mcp-method', method)],
    httpMethod: 'POST',
    body: { method, ...(params !== undefined ? { params } : {}) },
    binding: authenticatedBinding(),
    ...overrides,
  } as Mcp20260728RequestContextInput;
}

function expectWireError(error: unknown, kind: string, wireCode: number): void {
  expect(error).toBeInstanceOf(Mcp20260728RequestError);
  expect((error as Mcp20260728RequestError).kind).toBe(kind);
  expect((error as Mcp20260728RequestError).wireCode).toBe(wireCode);
}

describe('MCP 2026-07-28 request context — base64 sentinel and budget hardening', () => {
  it('treats empty strings as needing encoding and rejects invalid UTF-8 sentinels', () => {
    expect(needsMcp20260728Base64Encoding('')).toBe(true);
    expect(needsMcp20260728Base64Encoding('plain')).toBe(false);
    expect(encodeMcp20260728ParamValue('plain')).toBe('plain');
    expect(decodeMcp20260728ParamValue('=?base64?//4=?=')).toBeUndefined();
    expect(decodeMcp20260728ParamValue('=?base64?8J+YgA==?=')).toBe('😀');
  });

  it('rejects malformed headers, body and params evidence', () => {
    expect(() => createMcp20260728RequestContext(contextInput('x', {}, { headers: 'nope' }))).toThrow(TypeError);
    expect(() => createMcp20260728RequestContext(contextInput('x', {}, { body: 'nope' }))).toThrow(TypeError);
    expect(() => createMcp20260728RequestContext({
      headers: [header('mcp-method', 'x')], httpMethod: 'POST', body: {}, binding: authenticatedBinding(),
    } as never)).toThrowError(expect.objectContaining({ kind: 'invalid_request' }));
    expect(() => createMcp20260728RequestContext({
      headers: [header('mcp-method', 'x')], httpMethod: 'POST', body: { method: 'x', params: 'nope' }, binding: authenticatedBinding(),
    } as never)).toThrowError(expect.objectContaining({ kind: 'invalid_request' }));
  });

  it('rejects non-object input and non-object budgets', () => {
    expect(() => createMcp20260728RequestContext('nope' as never)).toThrow(TypeError);
    expect(() => createMcp20260728RequestContext(contextInput('x', {}, { traceBudget: 'nope' }))).toThrow(TypeError);
    expect(() => createMcp20260728RequestContext(contextInput('x', {}, { extensionBudget: 'nope' }))).toThrow(TypeError);
    expect(() => createMcp20260728RequestContext(contextInput('x', {}, { extensionBudget: { maxKeys: 0 } }))).toThrow(TypeError);
    expect(() => createMcp20260728RequestContext(contextInput('x', { _meta: meta() }, { extensionBudget: { maxKeys: 5 } }))).not.toThrow();
    expect(() => createMcp20260728RequestContext(contextInput('x', { _meta: meta() }, { traceBudget: { maxValueBytes: 64 } }))).not.toThrow();
  });

  it('rejects over-budget clientCapabilities and extension keys/values', () => {
    const hugeCapabilities = { tools: { listChanged: true }, padding: 'x'.repeat(2000) };
    expect(() => createMcp20260728RequestContext(
      contextInput('x', { _meta: meta({ [CLIENT_CAPABILITIES_META_KEY]: hugeCapabilities }) }, { budget: { maxBytes: 512 } }),
    )).toThrowError(expect.objectContaining({ kind: 'invalid_params' }));
    expect(() => createMcp20260728RequestContext(
      contextInput('x', { _meta: meta({ ['x'.repeat(100)]: 1 }) }, { extensionBudget: { maxKeyBytes: 16 } }),
    )).toThrowError(expect.objectContaining({ kind: 'invalid_params' }));
    expect(() => createMcp20260728RequestContext(
      contextInput('x', { _meta: meta({ extension: 'y'.repeat(1000) }) }, { extensionBudget: { maxValueBytes: 64 } }),
    )).toThrowError(expect.objectContaining({ kind: 'invalid_params' }));
  });

  it('rejects malformed trusted evidence, capability leaves and re-validation fields', () => {
    expect(() => requireMcp20260728RequestContext('nope')).toThrowError(expect.objectContaining({ kind: 'invalid_request' }));
    const valid = requireMcp20260728RequestContext(createMcp20260728RequestContext(
      contextInput('server/discover', { _meta: meta() }),
    ));
    expect(() => requireMcp20260728RequestContext({ ...valid, binding: null }))
      .toThrowError(expect.objectContaining({ kind: 'invalid_request' }));
    expect(() => requireMcp20260728RequestContext({ ...valid, clientCapabilities: 'nope' }))
      .toThrowError(expect.objectContaining({ kind: 'invalid_params' }));
    expect(() => requireMcp20260728RequestContext({ ...valid, clientInfo: { name: 42 } }))
      .toThrowError(expect.objectContaining({ kind: 'invalid_params' }));
    expect(() => requireMcp20260728RequestContext({ ...valid, logLevel: 'bogus' }))
      .toThrowError(expect.objectContaining({ kind: 'invalid_params' }));
    expect(() => requireMcp20260728RequestContext({ ...valid, trace: 'nope' }))
      .toThrowError(expect.objectContaining({ kind: 'invalid_params' }));
    expect(() => requireMcp20260728RequestContext({ ...valid, extensions: 'nope' }))
      .toThrowError(expect.objectContaining({ kind: 'invalid_params' }));
  });

  it('rejects a missing client capability leaf and requires declared capabilities', () => {
    const withGroup = requireMcp20260728RequestContext(createMcp20260728RequestContext(
      contextInput('subscriptions/listen', {
        notifications: {},
        _meta: meta({ [CLIENT_CAPABILITIES_META_KEY]: { resources: {} } }),
      }),
    ));
    expect(() => requireMcp20260728ClientCapability(withGroup, ['resources', 'subscribe']))
      .toThrowError(expect.objectContaining({ kind: 'missing_required_client_capability', wireCode: -32021 }));
    const declared = requireMcp20260728RequestContext(createMcp20260728RequestContext(
      contextInput('subscriptions/listen', {
        notifications: {},
        _meta: meta({ [CLIENT_CAPABILITIES_META_KEY]: { resources: { subscribe: true } } }),
      }),
    ));
    expect(() => requireMcp20260728ClientCapability(declared, ['resources', 'subscribe'])).not.toThrow();
  });
});

describe('MCP 2026-07-28 request context — x-mcp-header scan hardening', () => {
  it('scans non-object nodes, non-string headers, wrong types and duplicates', () => {
    expect(scanMcp20260728XMcpHeaderDeclarations({
      type: 'object',
      properties: { requestId: { type: 'string', 'x-mcp-header': 'X-Request-Id' }, nested: 'not-an-object' },
    }).valid).toBe(true);
    const nonString = scanMcp20260728XMcpHeaderDeclarations({
      type: 'object',
      properties: { requestId: { type: 'string', 'x-mcp-header': 42 } },
    });
    expect(nonString.valid).toBe(false);
    const wrongType = scanMcp20260728XMcpHeaderDeclarations({
      type: 'object',
      properties: { requestId: { type: 'object', 'x-mcp-header': 'X-Request-Id' } },
    });
    expect(wrongType.valid).toBe(false);
    const duplicate = scanMcp20260728XMcpHeaderDeclarations({
      type: 'object',
      properties: {
        a: { type: 'string', 'x-mcp-header': 'X-Id' },
        b: { type: 'string', 'x-mcp-header': 'x-id' },
      },
    });
    expect(duplicate.valid).toBe(false);
  });

  it('compares boolean and non-primitive Mcp-Param values', () => {
    const declarations = [
      { path: ['flag'], headerName: 'X-Flag', type: 'boolean' },
      { path: ['nested', 'value'], headerName: 'X-Nested', type: 'string' },
    ] as const;
    expect(() => validateMcp20260728ParamHeaders(
      declarations as never,
      { flag: true },
      new Map([['x-flag', 'true']]),
    )).not.toThrow();
    expect(() => validateMcp20260728ParamHeaders(
      declarations as never,
      { flag: true },
      new Map([['x-flag', 'false']]),
    )).toThrowError(expect.objectContaining({ kind: 'header_mismatch', wireCode: -32020 }));
    expect(() => validateMcp20260728ParamHeaders(
      declarations as never,
      { flag: 'not-a-boolean' },
      new Map([['x-flag', 'true']]),
    )).toThrowError(expect.objectContaining({ kind: 'header_mismatch', wireCode: -32020 }));
  });
});

describe('MCP 2026-07-28 subscriptions/listen — host configuration hardening', () => {
  const capabilities = Object.freeze({
    resources: Object.freeze({ subscribe: true, listChanged: true }),
    tools: Object.freeze({ listChanged: true }),
    prompts: Object.freeze({ listChanged: true }),
  });

  function listenContext(overrides: Readonly<Record<string, unknown>> = {}) {
    return requireMcp20260728RequestContext(createMcp20260728RequestContext(
      contextInput('subscriptions/listen', { _meta: meta(), notifications: { toolsListChanged: true } }, overrides),
    ));
  }

  function signalSource(): { source: McpChangeSignalSourcePort; publish: (s: McpChangeSignal) => void } {
    const listeners = new Set<McpChangeSignalListener>();
    let next = 0;
    return {
      source: {
        subscribe(listener) {
          listeners.add(listener);
          return {
            unsubscribe() {
              listeners.delete(listener);
            },
          };
        },
      },
      publish(signal) {
        for (const listener of [...listeners]) listener({ ...signal, sequence: ++next, timestamp: Date.now() });
      },
    };
  }

  it('rejects a wrong argument count, non-object, array or Proxy options', () => {
    expect(() => createMcp20260728SubscriptionsListenAdapter(undefined as never)).toThrow(TypeError);
    expect(() => createMcp20260728SubscriptionsListenAdapter(null as never)).toThrow(TypeError);
    expect(() => createMcp20260728SubscriptionsListenAdapter([] as never)).toThrow(TypeError);
    expect(() => createMcp20260728SubscriptionsListenAdapter(new Proxy({}, {}) as never)).toThrow(TypeError);
  });

  it('rejects malformed signalSource, capabilities, authorization, serverInfo and limits', () => {
    const base: Mcp20260728SubscriptionsListenAdapterOptions = {
      signalSource: { subscribe: vi.fn() } as never,
      capabilities,
    };
    expect(() => createMcp20260728SubscriptionsListenAdapter({ ...base, signalSource: null } as never)).toThrow(TypeError);
    expect(() => createMcp20260728SubscriptionsListenAdapter({ ...base, signalSource: {} } as never)).toThrow(TypeError);
    expect(() => createMcp20260728SubscriptionsListenAdapter({ ...base, capabilities: null } as never)).toThrow(TypeError);
    expect(() => createMcp20260728SubscriptionsListenAdapter({ ...base, authorization: 'nope' } as never)).toThrow(TypeError);
    expect(() => createMcp20260728SubscriptionsListenAdapter({ ...base, authorization: { isAuthorized: 'nope' } } as never)).toThrow(TypeError);
    expect(() => createMcp20260728SubscriptionsListenAdapter({ ...base, serverInfo: { name: 42 } } as never)).toThrow(TypeError);
    for (const name of ['maxQueueSize', 'maxRatePerWindow', 'rateWindowMs', 'maxLifetimeMs', 'maxNotifications'] as const) {
      expect(() => createMcp20260728SubscriptionsListenAdapter({ ...base, [name]: 0 } as never), name).toThrow(TypeError);
    }
    expect(() => createMcp20260728SubscriptionsListenAdapter({ ...base, authorization: undefined } as never)).not.toThrow(TypeError);
  });

  it('rejects malformed listen params, missing notifications and bad request ids', () => {
    const memory = signalSource();
    const adapter = createMcp20260728SubscriptionsListenAdapter({ signalSource: memory.source, capabilities });
    const context = listenContext();
    expect(() => adapter.listen(context, 'nope', 'listen-1')).toThrowError(expect.objectContaining({ kind: 'invalid_params' }));
    expect(() => adapter.listen(context, [], 'listen-1')).toThrowError(expect.objectContaining({ kind: 'invalid_params' }));
    expect(() => adapter.listen(context, { notifications: undefined }, 'listen-1'))
      .toThrowError(expect.objectContaining({ kind: 'invalid_params' }));
    expect(() => adapter.listen(context, { notifications: { toolsListChanged: true } }, ''))
      .toThrow(TypeError);
    expect(() => adapter.listen(context, { notifications: { toolsListChanged: true } }, 1.5))
      .toThrow(TypeError);
    const session = adapter.listen(context, { notifications: { toolsListChanged: true } }, 'listen-ok');
    expect(session.subscriptionId).toBe('listen-ok');
  });

  it('ends the stream immediately when the request is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const memory = signalSource();
    const adapter = createMcp20260728SubscriptionsListenAdapter({ signalSource: memory.source, capabilities });
    const context = listenContext({ abortSignal: controller.signal });
    const session = adapter.listen(context, { notifications: { toolsListChanged: true } }, 'listen-abort');
    const items: unknown[] = [];
    for await (const item of session.notifications) items.push(item);
    const teardown = await session.closed;
    expect(teardown.reason).toBe('aborted');
    expect(items).toEqual([]);
  });

  it('wakes a waiting next() consumer when a signal arrives and on teardown', async () => {
    const memory = signalSource();
    const adapter = createMcp20260728SubscriptionsListenAdapter({ signalSource: memory.source, capabilities });
    const session = adapter.listen(listenContext(), { notifications: { toolsListChanged: true } }, 'listen-wait');
    const iterator = session.notifications[Symbol.asyncIterator]();
    const pending = iterator.next();
    memory.publish({ type: 'tool-list-changed' } as never);
    const first = await pending;
    expect(first.done).toBe(false);
    expect((first.value as { method: string }).method).toBe('notifications/tools/list_changed');

    const pendingClose = iterator.next();
    session.close();
    const closed = await pendingClose;
    expect(closed.done).toBe(true);
  });

  it('ignores signals published after the stream ended and returns early from iterator.return()', async () => {
    const memory = signalSource();
    const adapter = createMcp20260728SubscriptionsListenAdapter({ signalSource: memory.source, capabilities });
    const session = adapter.listen(listenContext(), { notifications: { toolsListChanged: true } }, 'listen-end');
    const iterator = session.notifications[Symbol.asyncIterator]();
    const returnResult = await iterator.return?.();
    expect(returnResult).toMatchObject({ done: true });
    memory.publish({ type: 'tool-list-changed' } as never);
    const next = await iterator.next();
    expect(next.done).toBe(true);
  });
});
