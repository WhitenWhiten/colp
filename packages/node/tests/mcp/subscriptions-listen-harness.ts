/**
 * Shared harness for the COLP-MCP-11 Modern 2026-07-28 subscriptions/listen
 * contract tests. Extracted from mcp-2026-07-28-subscriptions-listen-contract.test.ts
 * so the contract suites stay under the test-granularity ceiling.
 */
import { expect } from 'vitest';

import {
  MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  Mcp20260728RequestError,
  createMcp20260728RequestContext,
  requireMcp20260728RequestContext,
  type Mcp20260728HeaderField,
  type Mcp20260728RequestContext,
  type Mcp20260728RequestContextInput,
} from '../../src/mcp/2026-07-28/request-context.js';
import {
  createMcp20260728SubscriptionsListenAdapter,
  type Mcp20260728ListenNotification,
  type Mcp20260728SubscriptionsListenAdapter,
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

export const serverInfo = Object.freeze({ name: 'colp-test-server', version: '0.0.0' });

/** Server capabilities that actually declare all four listen opt-in types. */
export const capabilities = Object.freeze({
  resources: Object.freeze({ subscribe: true, listChanged: true }),
  tools: Object.freeze({ listChanged: true }),
  prompts: Object.freeze({ listChanged: true }),
});

export function meta(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...overrides,
  };
}

function header(name: string, value: string): Mcp20260728HeaderField {
  return { name, value };
}

export function createContext(
  method: string,
  params: Readonly<Record<string, unknown>> | undefined,
  overrides: Readonly<Record<string, unknown>> = {},
): Mcp20260728RequestContext {
  return requireMcp20260728RequestContext(createMcp20260728RequestContext({
    headers: [header('mcp-protocol-version', '2026-07-28'), header('mcp-method', method)],
    httpMethod: 'POST',
    body: { method, ...(params !== undefined ? { params } : {}) },
    binding: authenticatedBinding(),
    ...overrides,
  } as Mcp20260728RequestContextInput));
}

export interface InMemorySignalSource {
  readonly source: McpChangeSignalSourcePort;
  readonly publish: (signal: Readonly<Omit<McpChangeSignal, 'sequence' | 'timestamp'>>) => McpChangeSignal;
  readonly listenerCount: () => number;
}

export function createInMemorySignalSource(): InMemorySignalSource {
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
      return full;
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

export interface ListenHarness {
  readonly memory: InMemorySignalSource;
  readonly adapter: Mcp20260728SubscriptionsListenAdapter;
}

export function harness(
  overrides: Readonly<Partial<Mcp20260728SubscriptionsListenAdapterOptions>> = {},
): ListenHarness {
  const memory = createInMemorySignalSource();
  const adapter = createMcp20260728SubscriptionsListenAdapter({
    signalSource: memory.source,
    capabilities,
    ...overrides,
  });
  return { memory, adapter };
}

export function openSession(
  adapter: Mcp20260728SubscriptionsListenAdapter,
  notifications: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
  requestId: string | number = 'listen-1',
): Mcp20260728SubscriptionsListenSession {
  const context = createContext('subscriptions/listen', { _meta: meta(), notifications }, overrides);
  return adapter.listen(context, { notifications }, requestId);
}

export async function readAll(
  session: Mcp20260728SubscriptionsListenSession,
): Promise<Mcp20260728ListenNotification[]> {
  const items: Mcp20260728ListenNotification[] = [];
  for await (const notification of session.notifications) items.push(notification);
  return items;
}

export async function take(
  session: Mcp20260728SubscriptionsListenSession,
  count: number,
): Promise<Mcp20260728ListenNotification[]> {
  const iterator = session.notifications[Symbol.asyncIterator]();
  const items: Mcp20260728ListenNotification[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('listen notification stream timed out')), 2000);
  });
  try {
    for (let index = 0; index < count; index += 1) {
      const result = await Promise.race([iterator.next(), guard]);
      if (result.done) break;
      items.push(result.value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return items;
}

export function expectInvalidParams(error: unknown): void {
  expect(error).toBeInstanceOf(Mcp20260728RequestError);
  expect((error as Mcp20260728RequestError).kind).toBe('invalid_params');
  expect((error as Mcp20260728RequestError).wireCode).toBe(MCP_WIRE_INVALID_PARAMS_ERROR_CODE);
}
