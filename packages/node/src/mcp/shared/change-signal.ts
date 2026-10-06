/**
 * protocol-neutral MCP change-signal port.
 *
 * Long-lived subscriptions/listen needs a host-side change source that is
 * deliberately protocol-neutral: it carries no MCP wire notification type, no
 * JSON-RPC framing and no SDK/transport object. The 2026-07-28 listen adapter
 * (src/mcp/2026-07-28/subscriptions.ts) maps these signals to
 * notifications/resources/updated, notifications/resources/list_changed,
 * notifications/tools/list_changed and notifications/prompts/list_changed,
 * so the same port can serve any future transport without learning MCP
 * vocabulary.
 *
 * A signal is a hint that something changed and the client should re-read; it
 * never carries a resource body. Delivery is best-effort and non-durable: a
 * signal published while nobody is subscribed is lost, and a disconnect is
 * followed by re-listen + re-read, never by a Last-Event-ID backfill
 * (migration decision §2/§3/§6).
 */
import { types as nodeTypes } from 'node:util';

/** Protocol-neutral change-signal kinds the listen adapter understands. */
export type McpChangeSignalType =
  | 'resource-updated'
  | 'resource-list-changed'
  | 'tool-list-changed'
  | 'prompt-list-changed';

/**
 * One protocol-neutral change signal. sequence and timestamp are
 * ordering/audit metadata for the host source; they never reach the wire.
 * resourceUri is required for resource-updated and forbidden for the
 * list-changed kinds.
 */
export interface McpChangeSignal {
  readonly type: McpChangeSignalType;
  /** Monotonic per-source ordering/audit sequence (never a wire value). */
  readonly sequence: number;
  /** Host epoch-millisecond timestamp (audit only; never a wire value). */
  readonly timestamp: number;
  /** Resource URI for resource-updated; absent on list-changed signals. */
  readonly resourceUri?: string;
}

/** Listener invoked synchronously for every signal published by the source. */
export interface McpChangeSignalListener {
  (signal: McpChangeSignal): void;
}

/** Cancellation handle returned by subscribe; idempotent to call. */
export interface McpChangeSignalSubscription {
  readonly unsubscribe: () => void;
}

/**
 * Host-supplied live change-signal source (non-durable fan-out). One
 * subscribe call creates exactly one independent subscription; the listen
 * adapter unsubscribes deterministically when its session ends, so no hidden
 * broker/registry outlives a request.
 */
export interface McpChangeSignalSourcePort {
  readonly subscribe: (listener: McpChangeSignalListener) => McpChangeSignalSubscription;
}

const CHANGE_SIGNAL_TYPES: ReadonlySet<string> = new Set([
  'resource-updated',
  'resource-list-changed',
  'tool-list-changed',
  'prompt-list-changed',
]);

/** Whether value is one of the known change-signal kinds. */
export function isMcpChangeSignalType(value: unknown): value is McpChangeSignalType {
  return typeof value === 'string' && CHANGE_SIGNAL_TYPES.has(value);
}

/** Fail-closed error for malformed change signals (host bug). */
export class McpChangeSignalError extends TypeError {
  readonly code = 'invalid_change_signal' as const;

  constructor() {
    super('Invalid MCP change signal.');
    this.name = 'McpChangeSignalError';
  }
}

/**
 * Strict validator: snapshots and deep-freezes one change signal, rejecting
 * accessors, Proxies, mutation-after-call, missing/extra fields, unsafe
 * sequence/timestamp values and a missing resourceUri on
 * resource-updated (or a resourceUri on list-changed kinds).
 */
export function snapshotMcpChangeSignal(value: unknown): McpChangeSignal {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw changeSignalError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw changeSignalError();
  const type = readOwnValue(value, 'type', changeSignalError);
  if (!isMcpChangeSignalType(type)) throw changeSignalError();
  const sequence = readOwnValue(value, 'sequence', changeSignalError);
  const timestamp = readOwnValue(value, 'timestamp', changeSignalError);
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw changeSignalError();
  }
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw changeSignalError();
  }
  const resourceUri = readOwnValue(value, 'resourceUri', changeSignalError);
  if (type === 'resource-updated') {
    if (typeof resourceUri !== 'string' || resourceUri.length === 0) throw changeSignalError();
  } else if (resourceUri !== undefined) {
    throw changeSignalError();
  }
  const allowed = type === 'resource-updated'
    ? new Set(['type', 'sequence', 'timestamp', 'resourceUri'])
    : new Set(['type', 'sequence', 'timestamp']);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw changeSignalError();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) throw changeSignalError();
  }
  return Object.freeze({
    type,
    sequence,
    timestamp,
    ...(resourceUri !== undefined ? { resourceUri } : {}),
  });
}

/** Non-throwing predicate for the whole change-signal shape. */
export function isMcpChangeSignal(value: unknown): value is McpChangeSignal {
  try {
    snapshotMcpChangeSignal(value);
    return true;
  } catch {
    return false;
  }
}

/** Alias of snapshotMcpChangeSignal for call sites that expect a strict require. */
export function requireMcpChangeSignal(value: unknown): McpChangeSignal {
  return snapshotMcpChangeSignal(value);
}

function changeSignalError(): TypeError {
  return new McpChangeSignalError();
}

function readOwnValue(value: object, name: string, fail: () => Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw fail();
  return descriptor.value;
}
