/**
 * P4B-R11 narrow host change-signal source.
 *
 * The source implements the COLP `McpChangeSignalSourcePort` used by the
 * Modern subscriptions/listen adapter and adds a narrow `publish` method that
 * accepts only the low-sensitivity host facts needed to locate invalidated
 * Resources. It assigns monotonic sequence and timestamp values, snapshots
 * every signal, and fans out best-effort to active listen sessions. Delivery
 * is intentionally non-durable and request-lifetime only: signals published
 * while nobody is listening are lost, and no replay state is retained.
 */
import {
  isMcpChangeSignalType,
  snapshotMcpChangeSignal,
  type McpChangeSignal,
  type McpChangeSignalListener,
  type McpChangeSignalSourcePort,
  type McpChangeSignalSubscription,
  type McpChangeSignalType,
} from '@know-n/colp/mcp';

export {
  isMcpChangeSignalType,
  snapshotMcpChangeSignal,
} from '@know-n/colp/mcp';
export type {
  McpChangeSignal,
  McpChangeSignalListener,
  McpChangeSignalType,
} from '@know-n/colp/mcp';

/** Host input for one protocol-neutral re-read hint. */
export interface Phase4bMcpChangeSignalInput {
  readonly type: McpChangeSignalType;
  /** Required only for `resource-updated`; forbidden on list-changed kinds. */
  readonly resourceUri?: string;
}

export interface Phase4bMcpChangeSignalSourceOptions {
  /** Injectable epoch-millisecond clock; defaults to Date.now. */
  readonly now?: () => number;
  /** Receives listener exceptions without interrupting other listeners. */
  readonly onError?: (error: unknown) => void;
}

export interface Phase4bMcpChangeSignalSource extends McpChangeSignalSourcePort {
  /** Publishes a frozen, sequence-stamped signal to current listeners. */
  readonly publish: (input: Phase4bMcpChangeSignalInput) => void | Promise<void>;
  /** Current active listener count, for tests and bounded teardown assertions. */
  readonly listenerCount: () => number;
  /** Optional lifecycle hook for infrastructure-backed sources. */
  readonly start?: () => Promise<void>;
  /** Optional lifecycle hook for infrastructure-backed sources. */
  readonly close?: () => Promise<void>;
}

/**
 * Creates one independent host signal source. Each subscription is released
 * by its own idempotent unsubscribe handle; no request state outlives a
 * session and no registry retains closed listeners.
 */
export function createPhase4bMcpChangeSignalSource(
  options: Phase4bMcpChangeSignalSourceOptions = {},
): Phase4bMcpChangeSignalSource {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('MCP change signal source options must be an object.');
  }
  const nowValue = readOptionalOwnData(options, 'now');
  const clock = nowValue === undefined ? () => Date.now() : nowValue as () => number;
  if (typeof clock !== 'function') {
    throw new TypeError('MCP change signal source now must be a function.');
  }
  const onErrorValue = readOptionalOwnData(options, 'onError');
  const onError = onErrorValue === undefined
    ? undefined
    : onErrorValue as (error: unknown) => void;
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('MCP change signal source onError must be a function.');
  }

  const listeners = new Set<McpChangeSignalListener>();
  let nextSequence = 0;

  const source: Phase4bMcpChangeSignalSource = Object.freeze({
    subscribe(listener: McpChangeSignalListener): McpChangeSignalSubscription {
      if (typeof listener !== 'function') {
        throw new TypeError('MCP change signal source listener must be a function.');
      }
      listeners.add(listener);
      let unsubscribed = false;
      return Object.freeze({
        unsubscribe() {
          if (unsubscribed) return;
          unsubscribed = true;
          listeners.delete(listener);
        },
      });
    },
    publish(input: Phase4bMcpChangeSignalInput): void {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new TypeError('MCP change signal source publish input must be an object.');
      }
      const type = readOwnData(input, 'type');
      if (!isMcpChangeSignalType(type)) {
        throw new TypeError('MCP change signal source publish type is invalid.');
      }
      const resourceUri = readOptionalOwnData(input, 'resourceUri');
      if (resourceUri !== undefined && typeof resourceUri !== 'string') {
        throw new TypeError('MCP change signal source resourceUri must be a string.');
      }
      const sequence = ++nextSequence;
      const timestamp = clock();
      const signal = snapshotMcpChangeSignal(Object.freeze({
        type,
        sequence,
        timestamp,
        ...(resourceUri === undefined ? {} : { resourceUri }),
      }) as McpChangeSignal);
      for (const listener of [...listeners]) {
        try {
          listener(signal);
        } catch (error) {
          if (onError !== undefined) onError(error);
        }
      }
    },
    listenerCount() {
      return listeners.size;
    },
  });
  return source;
}

function readOwnData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError('MCP change signal source option must use own data properties.');
  }
  return descriptor.value;
}

function readOptionalOwnData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new TypeError('MCP change signal source option must use own data properties.');
  }
  return descriptor.value;
}
