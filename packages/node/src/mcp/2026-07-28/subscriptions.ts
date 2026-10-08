import { isListenAuthorized } from './subscription-authority.js';
import { validateMcp20260728ListenParams } from './subscription-filter.js';
import {
  createMcpListenAdmission,
  type McpListenAdmissionFailure,
} from './subscriptions-admission.js';
import { Mcp20260728ListenStream } from './subscriptions-stream.js';

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
import type { McpChangeSignalSourcePort, McpChangeSignalSubscription } from '../shared/change-signal.js';
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
  | 'idle-timeout'
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
  /** Aggregate cap on concurrently open listen streams. */
  readonly maxConcurrentSessions?: number;
  /** Per-principal cap; prevents one authenticated subject monopolizing the adapter. */
  readonly maxConcurrentSessionsPerPrincipal?: number;
  /** Per-forwarded-client-address cap; absent addresses share a conservative bucket. */
  readonly maxConcurrentSessionsPerIp?: number;
  /** Idle stream timeout, refreshed by source activity and consumer reads. */
  readonly idleTimeoutMs?: number;
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
export const DEFAULT_MCP_LISTEN_MAX_CONCURRENT_SESSIONS = 256 as const;
export const DEFAULT_MCP_LISTEN_MAX_CONCURRENT_SESSIONS_PER_PRINCIPAL = 32 as const;
export const DEFAULT_MCP_LISTEN_MAX_CONCURRENT_SESSIONS_PER_IP = 64 as const;
export const DEFAULT_MCP_LISTEN_IDLE_TIMEOUT_MS = 300_000 as const;
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
  const maxConcurrentSessions = readLimit(options, 'maxConcurrentSessions', DEFAULT_MCP_LISTEN_MAX_CONCURRENT_SESSIONS);
  const maxConcurrentSessionsPerPrincipal = readLimit(
    options,
    'maxConcurrentSessionsPerPrincipal',
    DEFAULT_MCP_LISTEN_MAX_CONCURRENT_SESSIONS_PER_PRINCIPAL,
  );
  const maxConcurrentSessionsPerIp = readLimit(
    options,
    'maxConcurrentSessionsPerIp',
    DEFAULT_MCP_LISTEN_MAX_CONCURRENT_SESSIONS_PER_IP,
  );
  const idleTimeoutMs = readLimit(options, 'idleTimeoutMs', DEFAULT_MCP_LISTEN_IDLE_TIMEOUT_MS);
  if (idleTimeoutMs > 2_147_483_647) throw new RangeError('idleTimeoutMs must not exceed 2147483647.');
  // Admission is process-wide for this adapter instance. A per-stream queue
  // limit alone still permits an unbounded number of long-lived listeners.
  const admission = createMcpListenAdmission(
    maxConcurrentSessions,
    maxConcurrentSessionsPerPrincipal,
    maxConcurrentSessionsPerIp,
  );

  const listen = (
    context: Mcp20260728RequestContext,
    input: unknown,
    requestId: string | number,
  ): Mcp20260728SubscriptionsListenSession => {
    const ctx = requireMcp20260728RequestContext(context);
    const subscriptionId = requireRequestId(requestId);
    const admissionResult = admission.acquire(ctx);
    if (typeof admissionResult === 'string') {
      const messages: Readonly<Record<McpListenAdmissionFailure, string>> = {
        aggregate: 'MCP subscriptions/listen aggregate session admission limit reached.',
        principal: 'MCP subscriptions/listen per-principal admission limit reached.',
        client: 'MCP subscriptions/listen per-client admission limit reached.',
      };
      throw new TypeError(messages[admissionResult]);
    }
    const releaseAdmission = admissionResult;
    let filter: Mcp20260728SubscriptionFilter;
    try {
      filter = validateMcp20260728ListenParams(input, capabilities, isMcp20260728ListenTypeSupported);
    } catch (error) {
      releaseAdmission();
      throw error;
    }
    const authorized = (candidate: Mcp20260728RequestContext): boolean =>
      isListenAuthorized(candidate, filter.resourceSubscriptions, authorization);
    if (!authorized(ctx)) {
      releaseAdmission();
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
      idleTimeoutMs,
      buildNotification: buildListenNotification,
    });
    // Build every response value before opening the source subscription. The
    // SDK snapshot boundary is deliberately bounded, so a caller-controlled
    // request id (or another response field) may fail validation here. Doing
    // this after subscribe would leave the source listener and lifetime timer
    // alive when the response construction throws.
    let result: Mcp20260728ListenResult;
    let acknowledged: Mcp20260728ListenNotification;
    try {
      result = buildListenResult(subscriptionId, serverInfo);
      acknowledged = buildAckNotification(subscriptionId, filter);
    } catch (error) {
      releaseAdmission();
      throw error;
    }
    const iterable: AsyncIterable<Mcp20260728ListenNotification> = {
      [Symbol.asyncIterator]: () => ({
        next: () => stream.next(),
        return: () => {
          stream.close();
          return Promise.resolve({ done: true, value: undefined } as const);
        },
      }),
    };
    let subscription: McpChangeSignalSubscription;
    let subscribing = true;
    let synchronousSignalFailure: unknown;
    const onSignal = (raw: unknown): void => {
      try {
        stream.onSignal(raw);
      } catch (error) {
        // A hostile source may publish synchronously from subscribe(). Close
        // the stream even though its handle is not installed yet; start()
        // will immediately unsubscribe the returned handle. Preserve the
        // historical throw for already-open streams so hosts still observe a
        // malformed signal as a source error.
        stream.close();
        if (subscribing) {
          synchronousSignalFailure = error;
          return;
        }
        throw error;
      }
    };
    try {
      subscription = signalSource.subscribe(onSignal);
      subscribing = false;
    } catch (error) {
      subscribing = false;
      releaseAdmission();
      throw error;
    }
    if (synchronousSignalFailure !== undefined) {
      releaseAdmission();
      try { subscription.unsubscribe(); } catch { /* source cleanup is best effort */ }
      throw synchronousSignalFailure;
    }
    stream.closed.then(() => releaseAdmission()).catch(() => releaseAdmission());
    try {
      stream.start(subscription);
    } catch (error) {
      releaseAdmission();
      try { subscription.unsubscribe(); } catch { /* source cleanup is best effort */ }
      throw error;
    }
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
  // Authorization is a security boundary.  A host that does not provide an
  // explicit recheck port must never accidentally turn a listen stream into
  // an anonymous capability.  Fixtures and trusted hosts should pass an
  // explicit port (the test harness does so); production omission is a
  // deterministic deny.
  if (raw === undefined) return Object.freeze({ isAuthorized: () => false });
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
  name: 'maxQueueSize' | 'maxRatePerWindow' | 'rateWindowMs' | 'maxLifetimeMs' | 'maxNotifications'
    | 'maxConcurrentSessions' | 'maxConcurrentSessionsPerPrincipal' | 'maxConcurrentSessionsPerIp' | 'idleTimeoutMs',
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
