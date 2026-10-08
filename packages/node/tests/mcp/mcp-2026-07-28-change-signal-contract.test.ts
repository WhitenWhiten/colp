/**
 * COLP-MCP-11: protocol-neutral MCP change-signal port contracts.
 *
 * Covers `src/mcp/shared/change-signal.ts`: the live, non-durable change-signal
 * source port and the strict `snapshotMcpChangeSignal` validator. The port
 * never carries wire notification types, JSON-RPC framing or SDK/transport
 * objects; a signal is a re-read hint without a resource body. The validator
 * snapshots and deep-freezes one signal and rejects accessors, Proxies,
 * mutation-prone shapes, missing/extra fields, unsafe sequence/timestamp
 * values and a missing (or misplaced) `resourceUri`.
 */
import { describe, expect, it } from 'vitest';

import {
  MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  Mcp20260728RequestError,
  createMcp20260728RequestContext,
  requireMcp20260728RequestContext,
  type Mcp20260728HeaderField,
  type Mcp20260728RequestContextInput,
} from '../../src/mcp/2026-07-28/request-context.js';
import {
  createMcp20260728SubscriptionsListenAdapter,
  type Mcp20260728SubscriptionsListenAdapter,
} from '../../src/mcp/2026-07-28/subscriptions.js';
import {
  McpChangeSignalError,
  isMcpChangeSignal,
  requireMcpChangeSignal,
  snapshotMcpChangeSignal,
  type McpChangeSignal,
  type McpChangeSignalListener,
  type McpChangeSignalSourcePort,
} from '../../src/mcp/shared/change-signal.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const base = { type: 'tool-list-changed' as const, sequence: 1, timestamp: 1000 };

describe('MCP change-signal port: strict snapshot validation (COLP-MCP-11)', () => {
  it('snapshots a valid resource-updated signal as frozen own data', () => {
    const input = { type: 'resource-updated' as const, sequence: 1, timestamp: 1000, resourceUri: 'urn:res:a' };
    const snapshot = snapshotMcpChangeSignal(input);
    expect(snapshot).toEqual(input);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).not.toBe(input);
    (input as Record<string, unknown>).resourceUri = 'mutated';
    expect(snapshot.resourceUri).toBe('urn:res:a');
  });

  it('accepts the three list-changed kinds without a resourceUri', () => {
    for (const type of ['resource-list-changed', 'tool-list-changed', 'prompt-list-changed']) {
      const signal = { ...base, type };
      expect(snapshotMcpChangeSignal(signal)).toEqual(signal);
    }
  });

  it('accepts a null-prototype signal and rejects foreign prototypes', () => {
    expect(() => snapshotMcpChangeSignal(Object.assign(Object.create(null), base))).not.toThrow();
    const foreign = Object.assign(new (class SignalHost {})() as object, base);
    expect(() => snapshotMcpChangeSignal(foreign)).toThrow(McpChangeSignalError);
  });

  it('rejects a missing or empty resourceUri on resource-updated', () => {
    expect(() => snapshotMcpChangeSignal({ type: 'resource-updated', sequence: 1, timestamp: 1 })).toThrow(McpChangeSignalError);
    expect(() => snapshotMcpChangeSignal({ type: 'resource-updated', sequence: 1, timestamp: 1, resourceUri: '' })).toThrow(McpChangeSignalError);
  });

  it('rejects a resourceUri on list-changed kinds', () => {
    expect(() => snapshotMcpChangeSignal({ ...base, resourceUri: 'urn:res:a' })).toThrow(McpChangeSignalError);
  });

  it('rejects non-object, array and proxy values', () => {
    expect(() => snapshotMcpChangeSignal(null)).toThrow(McpChangeSignalError);
    expect(() => snapshotMcpChangeSignal('tool-list-changed')).toThrow(McpChangeSignalError);
    expect(() => snapshotMcpChangeSignal([{ ...base }])).toThrow(McpChangeSignalError);
    expect(() => snapshotMcpChangeSignal(new Proxy({ ...base }, {}))).toThrow(McpChangeSignalError);
  });

  it('rejects accessor properties, extra fields and symbol keys', () => {
    const accessor = { ...base };
    Object.defineProperty(accessor, 'type', { enumerable: true, get: () => 'tool-list-changed' });
    expect(() => snapshotMcpChangeSignal(accessor)).toThrow(McpChangeSignalError);
    expect(() => snapshotMcpChangeSignal({ ...base, extra: true })).toThrow(McpChangeSignalError);
    expect(() => snapshotMcpChangeSignal({ ...base, [Symbol('extra')]: 1 })).toThrow(McpChangeSignalError);
  });

  it('rejects unsafe sequence and timestamp values', () => {
    for (const sequence of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => snapshotMcpChangeSignal({ ...base, sequence })).toThrow(McpChangeSignalError);
    }
    for (const timestamp of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => snapshotMcpChangeSignal({ ...base, timestamp })).toThrow(McpChangeSignalError);
    }
  });

  it('treats isMcpChangeSignal as a non-throwing predicate and requireMcpChangeSignal as an alias', () => {
    expect(isMcpChangeSignal({ ...base })).toBe(true);
    expect(isMcpChangeSignal(null)).toBe(false);
    expect(requireMcpChangeSignal({ ...base })).toEqual({ ...base });
    expect(() => requireMcpChangeSignal({ ...base, extra: true })).toThrow(McpChangeSignalError);
  });
});

describe('MCP change-signal port: adapter integration (COLP-MCP-11)', () => {
  const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
  const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

  const capabilities = Object.freeze({
    resources: Object.freeze({ subscribe: true, listChanged: true }),
    tools: Object.freeze({ listChanged: true }),
    prompts: Object.freeze({ listChanged: true }),
  });
  const trustedAuthorization = Object.freeze({ isAuthorized: () => true, isResourceAuthorized: () => true });

  function createSignalSource(): {
    readonly source: McpChangeSignalSourcePort;
    readonly publish: (signal: Readonly<Omit<McpChangeSignal, 'sequence' | 'timestamp'>>) => void;
    readonly listenerCount: () => number;
  } {
    const listeners = new Set<McpChangeSignalListener>();
    let nextSequence = 0;
    return {
      source: {
        subscribe(listener) {
          listeners.add(listener);
          let unsubscribed = false;
          return {
            unsubscribe() {
              if (unsubscribed) return;
              unsubscribed = true;
              listeners.delete(listener);
            },
          };
        },
      },
      publish(signal) {
        const full: McpChangeSignal = { ...signal, sequence: ++nextSequence, timestamp: Date.now() };
        for (const listener of [...listeners]) listener(full);
      },
      listenerCount() {
        return listeners.size;
      },
    };
  }

  function createHarness(): {
    readonly memory: ReturnType<typeof createSignalSource>;
    readonly adapter: Mcp20260728SubscriptionsListenAdapter;
  } {
    const memory = createSignalSource();
    const adapter = createMcp20260728SubscriptionsListenAdapter({
      signalSource: memory.source,
      capabilities,
      authorization: trustedAuthorization,
    });
    return { memory, adapter };
  }

  function openSession(
    adapter: Mcp20260728SubscriptionsListenAdapter,
    notifications: Readonly<Record<string, unknown>>,
  ): void {
    const context = requireMcp20260728RequestContext(createMcp20260728RequestContext({
      headers: [
        { name: 'mcp-protocol-version', value: '2026-07-28' } satisfies Mcp20260728HeaderField,
        { name: 'mcp-method', value: 'subscriptions/listen' } satisfies Mcp20260728HeaderField,
      ],
      httpMethod: 'POST',
      body: { method: 'subscriptions/listen', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} }, notifications } },
      binding: authenticatedBinding(),
    } as Mcp20260728RequestContextInput));
    void adapter.listen(context, { notifications }, 'listen-1');
  }

  it('fails closed when the host source publishes a malformed signal', () => {
    const { memory, adapter } = createHarness();
    openSession(adapter, { toolsListChanged: true });
    expect(memory.listenerCount()).toBe(1);
    expect(() => memory.publish({ type: 'resource-updated' } as never)).toThrow(McpChangeSignalError);
  });

  it('rejects a malformed listen request with Invalid Params (-32602) before subscribing', () => {
    const { memory, adapter } = createHarness();
    const context = requireMcp20260728RequestContext(createMcp20260728RequestContext({
      headers: [
        { name: 'mcp-protocol-version', value: '2026-07-28' } satisfies Mcp20260728HeaderField,
        { name: 'mcp-method', value: 'subscriptions/listen' } satisfies Mcp20260728HeaderField,
      ],
      httpMethod: 'POST',
      body: { method: 'subscriptions/listen', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} } } },
      binding: authenticatedBinding(),
    } as Mcp20260728RequestContextInput));
    let caught: unknown;
    try {
      adapter.listen(context, {}, 'listen-1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Mcp20260728RequestError);
    expect((caught as Mcp20260728RequestError).kind).toBe('invalid_params');
    expect((caught as Mcp20260728RequestError).wireCode).toBe(MCP_WIRE_INVALID_PARAMS_ERROR_CODE);
    expect(memory.listenerCount()).toBe(0);
  });
});
