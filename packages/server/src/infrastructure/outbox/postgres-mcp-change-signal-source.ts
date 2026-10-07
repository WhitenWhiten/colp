/**
 * P4B-R11 PostgreSQL-backed non-durable MCP change-signal source.
 *
 * Production API and Worker are separate processes, so a process-local Set is
 * not enough to consume committed Outbox mutations. This adapter uses
 * PostgreSQL LISTEN/NOTIFY as the bounded fan-out transport: the Worker
 * publishes low-sensitivity hint facts after the durable projection has
 * applied, and each API process subscribes on one dedicated pooled client.
 *
 * The source deliberately retains no replay log, no Session registry, and no
 * event payload/Resource body. NOTIFY delivery is non-durable by design; if no
 * API process is listening, the hint is lost and the client re-reads after
 * re-listening.
 */
import type { Pool, PoolClient } from 'pg';
import {
  isMcpChangeSignalType,
  snapshotMcpChangeSignal,
  type McpChangeSignal,
  type McpChangeSignalListener,
  type McpChangeSignalType,
  type Phase4bMcpChangeSignalInput,
  type Phase4bMcpChangeSignalSource,
} from '../../modules/mcp/index.js';

const CHANNEL_RE = /^[A-Za-z0-9_]{1,63}$/u;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 100;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5_000;

export interface PostgresMcpChangeSignalSourceOptions {
  readonly pool: Pool;
  /** Fixed deployment channel; NOTIFY payloads never contain event bodies. */
  readonly channel: string;
  /** Injectable epoch-millisecond clock; defaults to Date.now. */
  readonly now?: () => number;
  /** Receives listener exceptions without interrupting other listeners. */
  readonly onError?: (error: unknown) => void;
  /** Initial reconnect delay after an established LISTEN connection is lost. */
  readonly reconnectInitialDelayMs?: number;
  /** Maximum reconnect delay; exponential backoff never exceeds this value. */
  readonly reconnectMaxDelayMs?: number;
}

export interface PostgresMcpChangeSignalSource extends Phase4bMcpChangeSignalSource {
  readonly start: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Stable bounded channel name derived from the host serverUuid. */
export function createPostgresMcpChangeSignalChannel(serverUuid: string): string {
  if (typeof serverUuid !== 'string') {
    throw new TypeError('MCP change signal channel requires a serverUuid string.');
  }
  const compact = serverUuid.replaceAll('-', '');
  const channel = `mcp_sig_${compact}`;
  if (!CHANNEL_RE.test(channel)) {
    throw new TypeError('MCP change signal channel is invalid.');
  }
  return channel;
}

/**
 * Creates one independent PostgreSQL-backed non-durable source. Callers that
 * need to receive notifications must await `start()` before accepting listen
 * sessions; Worker-only publishers never need to call `start()`.
 */
export function createPostgresMcpChangeSignalSource(
  options: PostgresMcpChangeSignalSourceOptions,
): PostgresMcpChangeSignalSource {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('MCP change signal source options must be an object.');
  }
  const pool = readOwnData(options, 'pool');
  const channel = readOwnData(options, 'channel');
  const nowValue = readOptionalOwnData(options, 'now');
  const now = nowValue === undefined ? () => Date.now() : nowValue as () => number;
  const onErrorValue = readOptionalOwnData(options, 'onError');
  const onError = onErrorValue === undefined
    ? undefined
    : onErrorValue as (error: unknown) => void;
  const reconnectInitialDelayMs = readDelay(
    readOptionalOwnData(options, 'reconnectInitialDelayMs'),
    DEFAULT_RECONNECT_INITIAL_DELAY_MS,
    'reconnectInitialDelayMs',
  );
  const reconnectMaxDelayMs = readDelay(
    readOptionalOwnData(options, 'reconnectMaxDelayMs'),
    DEFAULT_RECONNECT_MAX_DELAY_MS,
    'reconnectMaxDelayMs',
  );
  if (typeof pool !== 'object' || pool === null || typeof (pool as { query?: unknown }).query !== 'function') {
    throw new TypeError('MCP change signal source requires a PostgreSQL pool.');
  }
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) {
    throw new TypeError('MCP change signal source channel is invalid.');
  }
  if (typeof now !== 'function') {
    throw new TypeError('MCP change signal source now must be a function.');
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('MCP change signal source onError must be a function.');
  }
  if (reconnectMaxDelayMs < reconnectInitialDelayMs) {
    throw new TypeError('MCP change signal reconnect maximum must not be below its initial delay.');
  }
  const pgPool = pool as Pool;

  const listeners = new Set<McpChangeSignalListener>();
  let nextSequence = 0;
  let client: PoolClient | undefined;
  let startPromise: Promise<void> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let shouldListen = false;
  let connectedOnce = false;
  let stopped = false;
  const failedClients = new WeakSet<PoolClient>();
  const handlers = new WeakMap<PoolClient, Readonly<{
    notification: (notification: { channel?: string; payload?: string }) => void;
    error: (error: Error) => void;
  }>>();

  function signal(input: Phase4bMcpChangeSignalInput): McpChangeSignal {
    const type = validateType(input.type);
    const resourceUri = validateResourceUri(type, input.resourceUri);
    const sequence = ++nextSequence;
    const timestamp = now();
    return snapshotMcpChangeSignal(Object.freeze({
      type,
      sequence,
      timestamp,
      ...(resourceUri === undefined ? {} : { resourceUri }),
    }) as McpChangeSignal);
  }

  function fanOut(raw: string | undefined): void {
    if (raw === undefined || raw.length === 0 || raw.length > 8_000) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      report(new Error('MCP change signal notification is not valid JSON.'));
      return;
    }
    let type: McpChangeSignalType;
    try {
      type = validateType(readOptionalString(parsed, 'type'));
      const resourceUri = validateResourceUri(type, readOptionalString(parsed, 'resourceUri'));
      const candidate = Object.freeze({
        type,
        sequence: ++nextSequence,
        timestamp: now(),
        ...(resourceUri === undefined ? {} : { resourceUri }),
      });
      const signal = snapshotMcpChangeSignal(candidate as McpChangeSignal);
      for (const listener of [...listeners]) {
        try {
          listener(signal);
        } catch (error) {
          report(error);
        }
      }
    } catch (error) {
      report(error);
    }
  }

  function report(error: unknown): void {
    try {
      onError?.(error);
    } catch {
      // Observability callbacks cannot disable signal delivery or recovery.
    }
  }

  function detach(acquired: PoolClient): void {
    const attached = handlers.get(acquired);
    if (attached === undefined) return;
    acquired.removeListener('notification', attached.notification);
    acquired.removeListener('error', attached.error);
    handlers.delete(acquired);
  }

  function release(acquired: PoolClient, destroy: boolean): void {
    detach(acquired);
    try {
      acquired.release(destroy);
    } catch {
      // pg may already have evicted a broken client after its error event.
    }
  }

  function scheduleReconnect(): void {
    if (stopped || !shouldListen || reconnectTimer !== undefined) return;
    const exponent = Math.min(reconnectAttempt, 30);
    const delay = Math.min(reconnectMaxDelayMs, reconnectInitialDelayMs * (2 ** exponent));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void beginConnect(true).catch(report);
    }, delay);
    reconnectTimer.unref();
  }

  async function connect(reconnecting: boolean): Promise<void> {
    let acquired: PoolClient;
    try {
      acquired = await pgPool.connect();
    } catch (error) {
      if (reconnecting) scheduleReconnect();
      throw error;
    }
    try {
        if (stopped) {
          release(acquired, true);
          throw new Error('MCP change signal source closed while starting.');
        }
        const notification = (event: { channel?: string; payload?: string }) => {
          if (event.channel === channel) fanOut(event.payload);
        };
        const connectionError = (error: Error) => {
          failedClients.add(acquired);
          if (client === acquired) client = undefined;
          release(acquired, true);
          if (connectedOnce) scheduleReconnect();
          report(error);
        };
        handlers.set(acquired, Object.freeze({ notification, error: connectionError }));
        acquired.on('notification', notification);
        acquired.on('error', connectionError);
        await acquired.query(`LISTEN ${channel}`);
        if (failedClients.has(acquired) || stopped) {
          release(acquired, true);
          throw new Error('MCP change signal connection failed while starting.');
        }
        client = acquired;
        connectedOnce = true;
        reconnectAttempt = 0;
    } catch (error) {
      if (!failedClients.has(acquired)) release(acquired, true);
      if (reconnecting) scheduleReconnect();
      throw error;
    }
  }

  function beginConnect(reconnecting: boolean): Promise<void> {
    if (client !== undefined) return Promise.resolve();
    if (startPromise !== undefined) return startPromise;
    const attempt = connect(reconnecting);
    startPromise = attempt;
    void attempt.then(
      () => {
        if (startPromise === attempt) startPromise = undefined;
      },
      () => {
        if (startPromise === attempt) startPromise = undefined;
      },
    );
    return attempt;
  }

  async function start(): Promise<void> {
    if (stopped) throw new Error('MCP change signal source is closed.');
    shouldListen = true;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    return beginConnect(false);
  }

  async function publish(input: Phase4bMcpChangeSignalInput): Promise<void> {
    if (stopped) throw new Error('MCP change signal source is closed.');
    const frozen = signal(input);
    const payload = JSON.stringify({
      type: frozen.type,
      ...(frozen.resourceUri === undefined ? {} : { resourceUri: frozen.resourceUri }),
    });
    await pgPool.query('select pg_notify($1, $2)', [channel, payload]);
  }

  async function close(): Promise<void> {
    stopped = true;
    shouldListen = false;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    const acquired = client;
    client = undefined;
    listeners.clear();
    if (acquired !== undefined) {
      try {
        await acquired.query(`UNLISTEN ${channel}`);
        release(acquired, false);
      } catch {
        release(acquired, true);
      }
    }
  }

  return Object.freeze({
    subscribe(listener: McpChangeSignalListener): { readonly unsubscribe: () => void } {
      if (typeof listener !== 'function') {
        throw new TypeError('MCP change signal source listener must be a function.');
      }
      listeners.add(listener);
      void start().catch(report);
      let unsubscribed = false;
      return Object.freeze({
        unsubscribe() {
          if (unsubscribed) return;
          unsubscribed = true;
          listeners.delete(listener);
        },
      });
    },
    publish,
    listenerCount() {
      return listeners.size;
    },
    start,
    close,
  });
}

function validateType(value: unknown): McpChangeSignalType {
  if (!isMcpChangeSignalType(value)) {
    throw new TypeError('MCP change signal source type is invalid.');
  }
  return value;
}

function validateResourceUri(
  type: McpChangeSignalType,
  value: unknown,
): string | undefined {
  if (type === 'resource-updated') {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('MCP resource-updated signal requires a resourceUri.');
    }
    return value;
  }
  if (value !== undefined) {
    throw new TypeError('MCP list-changed signal must not include a resourceUri.');
  }
  return undefined;
}

function readOptionalString(value: unknown, name: 'type' | 'resourceUri'): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) return undefined;
  return descriptor.value;
}

function readOwnData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError('MCP change signal source options must use own data properties.');
  }
  return descriptor.value;
}

function readOptionalOwnData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new TypeError('MCP change signal source options must use own data properties.');
  }
  return descriptor.value;
}

function readDelay(value: unknown, fallback: number, name: string): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 1 || (resolved as number) > 60_000) {
    throw new TypeError(`MCP change signal source ${name} must be a positive bounded integer.`);
  }
  return resolved as number;
}
