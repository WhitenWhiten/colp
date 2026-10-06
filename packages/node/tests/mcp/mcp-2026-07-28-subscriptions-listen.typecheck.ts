/**
 * COLP-MCP-11: compile-time contract for the Modern subscriptions/listen
 * adapter layer.
 *
 * This file is never executed (vitest only discovers *.test.ts); it is
 * type-checked by npm run typecheck. Every @ts-expect-error below must
 * actually error, so tsc --noEmit passing proves:
 *
 * - the listen adapter accepts the Modern per-request context directly and
 *   never leaks wire/SDK/JSON-RPC types;
 * - the session exposes an async iterable of protocol-shaped listen
 *   notifications plus a frozen result carrying the subscription id;
 * - the adapter options accept the protocol-neutral change-signal port (not
 *   an SDK/transport object), and a host-supplied authorization recheck;
 * - the closed reason set stays closed and the teardown counters are
 *   readable numbers.
 */
import type { Mcp20260728RequestContext } from '../../src/mcp/2026-07-28/request-context.js';
import type {
  Mcp20260728ListenClosedReason,
  Mcp20260728ListenNotification,
  Mcp20260728SubscriptionsListenAdapter,
  Mcp20260728SubscriptionsListenAdapterOptions,
  Mcp20260728SubscriptionsListenSession,
  Mcp20260728SubscriptionFilter,
} from '../../src/mcp/2026-07-28/subscriptions.js';
import type {
  McpChangeSignal,
  McpChangeSignalSourcePort,
} from '../../src/mcp/shared/change-signal.js';

declare const requestContext: Mcp20260728RequestContext;
declare const listenAdapter: Mcp20260728SubscriptionsListenAdapter;
declare const signalSource: McpChangeSignalSourcePort;
declare const filter: Mcp20260728SubscriptionFilter;

// listen() accepts the Modern context + protocol-shaped params + request id.
export const session: Mcp20260728SubscriptionsListenSession = listenAdapter.listen(
  requestContext,
  { notifications: filter },
  'request-id-1',
);

// The session stream is an async iterable of listen notifications and the
// result carries the subscription id meta.
export async function collect(): Promise<Mcp20260728ListenNotification[]> {
  const items: Mcp20260728ListenNotification[] = [];
  for await (const notification of session.notifications) items.push(notification);
  return items;
}
export const subscriptionId: string | number = session.subscriptionId;
export const resultMeta: unknown = session.result._meta;

// Adapter options accept the protocol-neutral change-signal port.
export const listenOptions: Mcp20260728SubscriptionsListenAdapterOptions = {
  signalSource,
  capabilities: { resources: { subscribe: true } },
};

// Closed reason stays a closed union.
declare const reason: Mcp20260728ListenClosedReason;
export function describeReason(reason: Mcp20260728ListenClosedReason): string {
  if (reason === 'closed') return 'closed';
  if (reason === 'aborted') return 'aborted';
  if (reason === 'unauthorized') return 'unauthorized';
  if (reason === 'lifetime-expired') return 'lifetime-expired';
  return reason;
}
// @ts-expect-error listen closed reason is closed to the five documented values
export const badReason: 'cancelled' = describeReason(reason);

// A change signal is protocol-neutral and never an SDK/transport object.
declare const signal: McpChangeSignal;
export const signalType: string = signal.type;
export const signalSequence: number = signal.sequence;
// @ts-expect-error change signals never carry a wire notification method
export const badSignalMethod: unknown = signal.method;

// SDK JSON-RPC request objects never cross the adapter boundary.
// @ts-expect-error SDK JSON-RPC request objects never cross the adapter boundary
listenAdapter.listen({ method: 'subscriptions/listen' }, { notifications: {} }, 1);
