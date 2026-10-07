import { isListenAuthorized } from './subscription-authority.js';
import { validateMcp20260728ListenParams } from './subscription-filter.js';

/**
 * Modern MCP 2026-07-28 subscriptions/listen adapter.
 *
 * Maps the protocol-neutral change-signal port into one long-lived POST:
 *
 * - Opt-in types require declared server capabilities, else Invalid Params.
 * - Results and notifications carry the request id as subscriptionId,
 *   verbatim per the SDK SUBSCRIPTION_ID_META_KEY contract.
 * - Notifications remain on the original response stream as re-read hints;
 *   they contain no resource bodies.
 * - Queue, rate, lifetime and notification budgets bound delivery. Abort and
 *   authorization revocation release each session's subscription and timers.
 *
 * The listen connection state lives only for the POST request lifetime: after
 * a disconnect the client re-listens and re-reads; there is no Last-Event-ID
 * replay contract (migration decision §2/§3/§6).
 */
import { types as nodeTypes } from 'node:util';

import { snapshotMcpData } from '../safe-data.js';
import type { McpChangeSignal, McpChangeSignalSourcePort, McpChangeSignalSubscription } from '../shared/change-signal.js';
import { snapshotMcpChangeSignal } from '../shared/change-signal.js';
import {
  requireMcp20260728RequestContext,
  type Mcp20260728RequestContext,
} from './request-context.js';
import type { Mcp20260728ServerInfo } from './results.js';
import {
  ImplementationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  SERVER_INFO_META_KEY,
  SubscriptionsAcknowledgedNotificationSchema,
  SUBSCRIPTION_ID_META_KEY,
  SubscriptionsListenResultMetaSchema,
  SubscriptionsListenResultSchema,
  ToolListChangedNotificationSchema,
} from '../../shared/mcp-sdk-boundary.js';

/** The four opt-in notification types a client may request on listen. */
export type Mcp20260728ListenOptInType =
  | 'toolsListChanged'
  | 'promptsListChanged'
  | 'resourcesListChanged'
  | 'resourceSubscriptions';

/** Protocol-neutral mirror of the SDK SubscriptionFilter shape. */
export interface Mcp20260728SubscriptionFilter {
  readonly toolsListChanged?: boolean;
  readonly promptsListChanged?: boolean;
  readonly resourcesListChanged?: boolean;
  readonly resourceSubscriptions?: readonly string[];
}

export type Mcp20260728ListenNotificationMethod =
  | 'notifications/subscriptions/acknowledged'
  | 'notifications/resources/updated'
  | 'notifications/resources/list_changed'
  | 'notifications/tools/list_changed'
  | 'notifications/prompts/list_changed';

/** One streamed notification (method + params); the host frames JSON-RPC. */
export interface Mcp20260728ListenNotification {
  readonly method: Mcp20260728ListenNotificationMethod;
  readonly params: Readonly<Record<string, unknown>>;
}

/** Empty listen result carrying _meta.subscriptionId (+ optional serverInfo). */
export interface Mcp20260728ListenResult {
  readonly _meta: Readonly<{
    [SUBSCRIPTION_ID_META_KEY]: string | number;
    [SERVER_INFO_META_KEY]?: Mcp20260728ServerInfo;
  }>;
}

export type Mcp20260728ListenClosedReason =
  | 'closed'
  | 'aborted'
  | 'unauthorized'
  | 'lifetime-expired'
  | 'notification-budget-exhausted';

/** Deterministic teardown summary hosts can log / use to decide the final result. */
export interface Mcp20260728ListenTeardown {
  readonly reason: Mcp20260728ListenClosedReason;
  /** True when the server tore the stream down gracefully (final result allowed). */
  readonly graceful: boolean;
  readonly received: number;
  readonly delivered: number;
  readonly overflow: number;
  readonly rateLimited: number;
}

export interface Mcp20260728SubscriptionsListenSession {
  readonly subscriptionId: string | number;
  /** Frozen listen result for graceful teardown (empty body + subscriptionId). */
  readonly result: Mcp20260728ListenResult;
  /** Frozen leading notifications/subscriptions/acknowledged. */
  readonly acknowledged: Mcp20260728ListenNotification;
  /** Request-scoped notification stream (single-use async iterable). */
  readonly notifications: AsyncIterable<Mcp20260728ListenNotification>;
  /** Initiates graceful teardown (idempotent). */
  readonly close: () => void;
  /** Resolves after local teardown, even if host unsubscribe throws. */
  readonly closed: Promise<Mcp20260728ListenTeardown>;
}

/**
 * Host-supplied authorization recheck. Called before the leading ack and
 * before every notification send; a false answer ends the stream immediately
 * (binding / scope / security-epoch changes revoke in-flight listens).
 */
export interface Mcp20260728AuthorizationRecheckPort {
  readonly isAuthorized: (context: Mcp20260728RequestContext) => boolean;
  /** Required for nonempty resource subscriptions. Rechecked before every send. */
  readonly isResourceAuthorized?: (context: Mcp20260728RequestContext, resourceUri: string) => boolean;
}

export interface Mcp20260728SubscriptionsListenAdapterOptions {
  readonly signalSource: McpChangeSignalSourcePort;
  /** Server capabilities actually declared (from server/discover). */
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly authorization?: Mcp20260728AuthorizationRecheckPort;
  readonly serverInfo?: Mcp20260728ServerInfo;
  readonly maxQueueSize?: number;
  readonly maxRatePerWindow?: number;
  readonly rateWindowMs?: number;
  /** Positive integer, at most 2,147,483,647 ms (the runtime timer limit). */
  readonly maxLifetimeMs?: number;
  readonly maxNotifications?: number;
}

export interface Mcp20260728SubscriptionsListenAdapter {
  /** Opens one self-contained listen session for the given request id. */
  readonly listen: (
    context: Mcp20260728RequestContext,
    input: unknown,
    requestId: string | number,
  ) => Mcp20260728SubscriptionsListenSession;
}

/** Frozen set of listen stream methods (SDK 2026-07-28 vocabulary). */
export const MCP_20260728_LISTEN_NOTIFICATION_METHODS: readonly Mcp20260728ListenNotificationMethod[] = Object.freeze([
  'notifications/subscriptions/acknowledged',
  'notifications/resources/updated',
  'notifications/resources/list_changed',
  'notifications/tools/list_changed',
  'notifications/prompts/list_changed',
]);

export const DEFAULT_MCP_LISTEN_MAX_QUEUE_SIZE = 128 as const;
export const DEFAULT_MCP_LISTEN_MAX_RATE_PER_WINDOW = 1000 as const;
export const DEFAULT_MCP_LISTEN_RATE_WINDOW_MS = 1000 as const;
export const DEFAULT_MCP_LISTEN_MAX_LIFETIME_MS = 1_800_000 as const;
export const DEFAULT_MCP_LISTEN_MAX_NOTIFICATIONS = 10_000 as const;
export const MCP_20260728_MAX_LISTEN_REQUEST_ID_LENGTH = 16_384 as const;

const LISTEN_TYPE_CAPABILITY_PATHS: Readonly<Record<Mcp20260728ListenOptInType, readonly [string, string]>> = Object.freeze({
  toolsListChanged: ['tools', 'listChanged'],
  promptsListChanged: ['prompts', 'listChanged'],
  resourcesListChanged: ['resources', 'listChanged'],
  resourceSubscriptions: ['resources', 'subscribe'],
});

/**
 * Whether the server capabilities actually declare the given opt-in type.
 * Capability values must be exactly true (decision §6.10: only implemented
 * items are declared).
 */
export function isMcp20260728ListenTypeSupported(
  capabilities: Readonly<Record<string, unknown>>,
  type: Mcp20260728ListenOptInType,
): boolean {
  const [group, key] = LISTEN_TYPE_CAPABILITY_PATHS[type];
  const groupValue = capabilities[group];
  if (typeof groupValue !== 'object' || groupValue === null || Array.isArray(groupValue)) return false;
  return (groupValue as Readonly<Record<string, unknown>>)[key] === true;
}

type McpSchemaParseResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false };

interface McpSchemaValidator {
  readonly safeParse: (value: unknown) => McpSchemaParseResult;
}

const NOTIFICATION_SCHEMAS: Readonly<Record<Mcp20260728ListenNotificationMethod, McpSchemaValidator>> = Object.freeze({
  'notifications/subscriptions/acknowledged': SubscriptionsAcknowledgedNotificationSchema,
  'notifications/resources/updated': ResourceUpdatedNotificationSchema,
  'notifications/resources/list_changed': ResourceListChangedNotificationSchema,
  'notifications/tools/list_changed': ToolListChangedNotificationSchema,
  'notifications/prompts/list_changed': PromptListChangedNotificationSchema,
});

/**
 * Creates the reusable Modern listen adapter. Validates host options
 * (fail-closed TypeError on malformed own-data configuration) and returns one
 * frozen instance; every listen call opens an independent session with its
 * own source subscription, queue, rate window, lifetime timer and teardown.
 */
export function createMcp20260728SubscriptionsListenAdapter(
  options: Mcp20260728SubscriptionsListenAdapterOptions,
): Mcp20260728SubscriptionsListenAdapter {
  if (arguments.length !== 1) throw configError();
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) throw configError();
  const signalSource = readSignalSource(options);
  const capabilities = readCapabilities(options);
  const authorization = readAuthorization(options);
  const serverInfo = readServerInfo(options);
  const maxQueueSize = readLimit(options, 'maxQueueSize', DEFAULT_MCP_LISTEN_MAX_QUEUE_SIZE);
  const maxRatePerWindow = readLimit(options, 'maxRatePerWindow', DEFAULT_MCP_LISTEN_MAX_RATE_PER_WINDOW);
  const rateWindowMs = readLimit(options, 'rateWindowMs', DEFAULT_MCP_LISTEN_RATE_WINDOW_MS);
  const maxLifetimeMs = readLimit(options, 'maxLifetimeMs', DEFAULT_MCP_LISTEN_MAX_LIFETIME_MS);
  if (maxLifetimeMs > 2_147_483_647) throw new RangeError('maxLifetimeMs must not exceed 2147483647.');
  const maxNotifications = readLimit(options, 'maxNotifications', DEFAULT_MCP_LISTEN_MAX_NOTIFICATIONS);

  const listen = (
    context: Mcp20260728RequestContext,
    input: unknown,
    requestId: string | number,
  ): Mcp20260728SubscriptionsListenSession => {
    const ctx = requireMcp20260728RequestContext(context);
    const subscriptionId = requireRequestId(requestId);
    const filter = validateMcp20260728ListenParams(input, capabilities, isMcp20260728ListenTypeSupported);
    const authorized = (candidate: Mcp20260728RequestContext): boolean =>
      isListenAuthorized(candidate, filter.resourceSubscriptions, authorization);
    if (!authorized(ctx)) {
      throw new TypeError('MCP listen authorization recheck denied the request at listen start.');
    }
    const stream = new Mcp20260728ListenStream({
      context: ctx,
      subscriptionId,
      filter,
      isAuthorized: authorized,
      maxQueueSize,
      maxRatePerWindow,
      rateWindowMs,
      maxLifetimeMs,
      maxNotifications,
    });
    // Build every response value before opening the source subscription. The
    // SDK snapshot boundary is deliberately bounded, so a caller-controlled
    // request id (or another response field) may fail validation here. Doing
    // this after subscribe would leave the source listener and lifetime timer
    // alive when the response construction throws.
    const result = buildListenResult(subscriptionId, serverInfo);
    const acknowledged = buildAckNotification(subscriptionId, filter);
    const iterable: AsyncIterable<Mcp20260728ListenNotification> = {
      [Symbol.asyncIterator]: () => ({
        next: () => stream.next(),
        return: () => {
          stream.close();
          return Promise.resolve({ done: true, value: undefined } as const);
        },
      }),
    };
    const subscription = signalSource.subscribe((raw) => stream.onSignal(raw));
    stream.start(subscription);
    return Object.freeze({
      subscriptionId,
      result,
      acknowledged,
      notifications: iterable,
      close: () => stream.close(),
      closed: stream.closed,
    });
  };

  return Object.freeze({ listen });
}

function requireRequestId(value: unknown): string | number {
  if (typeof value === 'string'
    && value.length > 0
    && value.length <= MCP_20260728_MAX_LISTEN_REQUEST_ID_LENGTH) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new TypeError(`MCP subscriptions/listen request id must be a non-empty string of at most ${MCP_20260728_MAX_LISTEN_REQUEST_ID_LENGTH} characters or a safe integer.`);
}

function buildAckNotification(
  subscriptionId: string | number,
  filter: Mcp20260728SubscriptionFilter,
): Mcp20260728ListenNotification {
  return buildListenNotification('notifications/subscriptions/acknowledged', {
    _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId },
    notifications: filter,
  });
}

function buildListenResult(
  subscriptionId: string | number,
  serverInfo: Mcp20260728ServerInfo | undefined,
): Mcp20260728ListenResult {
  const metaCandidate: Readonly<Record<string, unknown>> = {
    [SUBSCRIPTION_ID_META_KEY]: subscriptionId,
    ...(serverInfo !== undefined ? { [SERVER_INFO_META_KEY]: serverInfo } : {}),
  };
  const metaParsed = SubscriptionsListenResultMetaSchema.safeParse(metaCandidate);
  if (!metaParsed.success) {
    throw new TypeError('MCP listen result _meta failed SDK schema validation.');
  }
  const resultParsed = SubscriptionsListenResultSchema.safeParse({ _meta: metaParsed.data });
  if (!resultParsed.success) {
    throw new TypeError('MCP listen result failed SDK schema validation.');
  }
  const metaSnapshot = snapshotMcpData(resultParsed.data._meta) as Mcp20260728ListenResult['_meta'];
  return Object.freeze({ _meta: Object.freeze(metaSnapshot) });
}

function buildListenNotification(
  method: Mcp20260728ListenNotificationMethod,
  params: Readonly<Record<string, unknown>>,
): Mcp20260728ListenNotification {
  const candidate = { method, params };
  const parsed = NOTIFICATION_SCHEMAS[method].safeParse(candidate);
  if (!parsed.success) {
    throw new TypeError('MCP listen notification failed SDK schema validation.');
  }
  const paramsSnapshot = snapshotMcpData((parsed.data as { params: unknown }).params) as Readonly<Record<string, unknown>>;
  return Object.freeze({
    method,
    params: Object.freeze(paramsSnapshot),
  });
}

interface Mcp20260728ListenStreamOptions {
  readonly context: Mcp20260728RequestContext;
  readonly subscriptionId: string | number;
  readonly filter: Mcp20260728SubscriptionFilter;
  readonly isAuthorized: (context: Mcp20260728RequestContext) => boolean;
  readonly maxQueueSize: number;
  readonly maxRatePerWindow: number;
  readonly rateWindowMs: number;
  readonly maxLifetimeMs: number;
  readonly maxNotifications: number;
}

/**
 * One listen stream: bounded queue + async iterator, rate window, lifetime
 * timer, abort listener, per-send authorization recheck and deterministic
 * teardown. All request-scoped state lives here and is released on end.
 */
class Mcp20260728ListenStream {
  private readonly context: Mcp20260728RequestContext;
  private readonly subscriptionId: string | number;
  private readonly filter: Mcp20260728SubscriptionFilter;
  private readonly resourceUris: ReadonlySet<string>;
  private readonly isAuthorized: (context: Mcp20260728RequestContext) => boolean;
  private readonly maxQueueSize: number;
  private readonly maxRatePerWindow: number;
  private readonly rateWindowMs: number;
  private readonly maxLifetimeMs: number;
  private readonly maxNotifications: number;
  private readonly queue: Mcp20260728ListenNotification[] = [];
  private readonly waiters: Array<() => void> = [];

  private sourceSubscription: McpChangeSignalSubscription | undefined;
  private abortListener: (() => void) | undefined;
  private lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private received = 0;
  private delivered = 0;
  private overflow = 0;
  private rateLimited = 0;
  private rateWindowStart = Date.now();
  private rateWindowCount = 0;
  private closedResolve!: (teardown: Mcp20260728ListenTeardown) => void;

  readonly closed: Promise<Mcp20260728ListenTeardown>;

  constructor(options: Mcp20260728ListenStreamOptions) {
    this.context = options.context;
    this.subscriptionId = options.subscriptionId;
    this.filter = options.filter;
    this.resourceUris = new Set(options.filter.resourceSubscriptions ?? []);
    this.isAuthorized = options.isAuthorized;
    this.maxQueueSize = options.maxQueueSize;
    this.maxRatePerWindow = options.maxRatePerWindow;
    this.rateWindowMs = options.rateWindowMs;
    this.maxLifetimeMs = options.maxLifetimeMs;
    this.maxNotifications = options.maxNotifications;
    this.closed = new Promise<Mcp20260728ListenTeardown>((resolve) => {
      this.closedResolve = resolve;
    });
  }

  start(subscription: McpChangeSignalSubscription): void {
    // A source may synchronously publish enough signals to end this stream
    // before subscribe returns its handle. Do not resurrect closed resources.
    if (this.ended) {
      subscription.unsubscribe();
      return;
    }
    this.sourceSubscription = subscription;
    this.abortListener = () => this.teardown('aborted', true);
    this.context.abortSignal.addEventListener('abort', this.abortListener, { once: true });
    if (this.context.abortSignal.aborted) {
      this.teardown('aborted', true);
      return;
    }
    this.lifetimeTimer = setTimeout(() => {
      this.lifetimeTimer = undefined;
      this.teardown('lifetime-expired', false);
    }, this.maxLifetimeMs);
    if (typeof (this.lifetimeTimer as { unref?: () => void }).unref === 'function') {
      (this.lifetimeTimer as { unref: () => void }).unref();
    }
  }

  close(): void {
    this.teardown('closed', false);
  }

  onSignal(raw: unknown): void {
    if (this.ended) return;
    const signal = snapshotMcpChangeSignal(raw);
    if (!this.isAuthorized(this.context)) {
      this.teardown('unauthorized', true);
      return;
    }
    const mapped = this.mapSignal(signal);
    if (mapped === undefined) return;
    this.received += 1;
    if (this.delivered >= this.maxNotifications) {
      this.teardown('notification-budget-exhausted', false);
      return;
    }
    const now = Date.now();
    if (now - this.rateWindowStart >= this.rateWindowMs) {
      this.rateWindowStart = now;
      this.rateWindowCount = 0;
    }
    if (this.rateWindowCount >= this.maxRatePerWindow) {
      this.rateLimited += 1;
      return;
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.overflow += 1;
      return;
    }
    const notification = buildListenNotification(mapped.method, {
      _meta: { [SUBSCRIPTION_ID_META_KEY]: this.subscriptionId },
      ...mapped.params,
    });
    this.queue.push(notification);
    this.delivered += 1;
    this.rateWindowCount += 1;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter();
  }

  async next(): Promise<IteratorResult<Mcp20260728ListenNotification>> {
    for (;;) {
      if (!this.isAuthorized(this.context)) {
        this.teardown('unauthorized', true);
        return { done: true, value: undefined };
      }
      const item = this.queue.shift();
      if (item !== undefined) return { value: item, done: false };
      if (this.ended) return { done: true, value: undefined };
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  private mapSignal(
    signal: McpChangeSignal,
  ): { readonly method: Mcp20260728ListenNotificationMethod; readonly params: Readonly<Record<string, unknown>> } | undefined {
    switch (signal.type) {
      case 'resource-updated': {
        if (!this.resourceUris.has(signal.resourceUri as string)) return undefined;
        return { method: 'notifications/resources/updated', params: { uri: signal.resourceUri as string } };
      }
      case 'resource-list-changed':
        return this.filter.resourcesListChanged === true
          ? { method: 'notifications/resources/list_changed', params: {} }
          : undefined;
      case 'tool-list-changed':
        return this.filter.toolsListChanged === true
          ? { method: 'notifications/tools/list_changed', params: {} }
          : undefined;
      case 'prompt-list-changed':
        return this.filter.promptsListChanged === true
          ? { method: 'notifications/prompts/list_changed', params: {} }
          : undefined;
    }
  }

  private teardown(reason: Mcp20260728ListenClosedReason, abrupt: boolean): void {
    if (this.ended) return;
    this.ended = true;
    const subscription = this.sourceSubscription;
    this.sourceSubscription = undefined;
    if (this.lifetimeTimer !== undefined) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = undefined;
    }
    if (this.abortListener !== undefined) {
      this.context.abortSignal.removeEventListener('abort', this.abortListener);
      this.abortListener = undefined;
    }
    if (abrupt) this.queue.length = 0;
    while (this.waiters.length > 0) {
      this.waiters.shift()!();
    }
    this.closedResolve(Object.freeze({
      reason,
      graceful: !abrupt,
      received: this.received,
      delivered: this.delivered,
      overflow: this.overflow,
      rateLimited: this.rateLimited,
    }));
    // Settle local resources before invoking host code, which may throw or
    // reenter close. The host error still reaches the initiating caller.
    subscription?.unsubscribe();
  }
}

function readSignalSource(options: Mcp20260728SubscriptionsListenAdapterOptions): McpChangeSignalSourcePort {
  const raw = readOwnValue(options, 'signalSource', configError);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || nodeTypes.isProxy(raw)) throw configError();
  const subscribe = readOwnData(raw as object, 'subscribe', configError);
  if (typeof subscribe !== 'function') throw configError();
  return Object.freeze<McpChangeSignalSourcePort>({ subscribe: listener => Reflect.apply(subscribe, raw, [listener]) });
}

function readCapabilities(options: Mcp20260728SubscriptionsListenAdapterOptions): Readonly<Record<string, unknown>> {
  const raw = readOwnValue(options, 'capabilities', configError);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || nodeTypes.isProxy(raw)) throw configError();
  return snapshotMcpData(raw) as Readonly<Record<string, unknown>>;
}

function readAuthorization(options: Mcp20260728SubscriptionsListenAdapterOptions): Mcp20260728AuthorizationRecheckPort {
  const raw = readOptionalOwnData(options, 'authorization');
  if (raw === undefined) return Object.freeze({ isAuthorized: () => true });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || nodeTypes.isProxy(raw)) throw configError();
  const isAuthorized = readOwnData(raw as object, 'isAuthorized', configError);
  if (typeof isAuthorized !== 'function') throw configError();
  const resourceCheck = readOptionalOwnData(raw, 'isResourceAuthorized');
  if (resourceCheck !== undefined && (typeof resourceCheck !== 'function' || nodeTypes.isProxy(resourceCheck))) throw configError();
  return Object.freeze<Mcp20260728AuthorizationRecheckPort>({
    isAuthorized: context => Reflect.apply(isAuthorized, raw, [context]) === true,
    ...(resourceCheck === undefined ? {} : {
      isResourceAuthorized: (context: Mcp20260728RequestContext, uri: string) =>
        Reflect.apply(resourceCheck as Function, raw, [context, uri]) === true,
    }),
  });
}

function readServerInfo(options: Mcp20260728SubscriptionsListenAdapterOptions): Mcp20260728ServerInfo | undefined {
  const raw = readOptionalOwnData(options, 'serverInfo');
  if (raw === undefined) return undefined;
  const parsed = ImplementationSchema.safeParse(raw);
  if (!parsed.success) throw configError();
  return Object.freeze(snapshotMcpData(parsed.data)) as Mcp20260728ServerInfo;
}

function readLimit(
  options: Mcp20260728SubscriptionsListenAdapterOptions,
  name: 'maxQueueSize' | 'maxRatePerWindow' | 'rateWindowMs' | 'maxLifetimeMs' | 'maxNotifications',
  fallback: number,
): number {
  const raw = readOptionalOwnData(options, name);
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) throw configError();
  return raw;
}

function configError(): TypeError {
  return new TypeError('Invalid Modern MCP subscriptions/listen adapter configuration.');
}

function readOwnValue(value: object, name: string, fail: () => Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOwnData(value: object, name: string, fail: () => Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOptionalOwnData(value: object, name: string): unknown {
  return readOwnValue(value, name, configError);
}
