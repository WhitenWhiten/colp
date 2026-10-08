/**
 * P4B-R13 MCP Read host operations.
 *
 * This module owns the bounded in-process request/listen registry, the
 * operator snapshot, forced drain/abort controls, stable metric names, and
 * feature-scoped MCP Read readiness. It deliberately never stores request
 * bodies, authorization details, principals, origins, URIs, IDs, Tool
 * arguments, or credential material. The registry is bounded by the MCP Read
 * request/listen capacities; entries that cannot be registered are counted as
 * registry overflow without creating hidden server state.
 *
 * Metrics are flat stable names because the host `Metrics` seam has no label
 * arrays. A single labeled request counter also carries the allowed stable
 * dimensions (version, method, resource kind, result, error, budget bucket)
 * so operators can aggregate without ever adding identity/content labels.
 */
import type { Mcp20260728SubscriptionsListenSession } from '@know-n/colp/mcp';
import {
  IdTokenVerificationError,
  type JwksProvider,
} from '../identity/index.js';
import type { McpOauthRevocationStore } from './oauth-revocation-store.js';

export const PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX = 'mcp.read' as const;
export const PHASE4B_MCP_READ_OPERATIONS_PROTOCOL_VERSION_LABEL = '2026_07_28' as const;

export type Phase4bMcpReadKind = 'request' | 'listen';
export type Phase4bMcpReadMethod =
  | 'server/discover'
  | 'resources/list'
  | 'resources/templates/list'
  | 'resources/read'
  | 'subscriptions/listen'
  | 'tools/list'
  | 'tools/call'
  | 'unknown';
export type Phase4bMcpReadResourceKind =
  | 'none'
  | 'collection_metadata'
  | 'collection_snapshot'
  | 'collection_node';
export type Phase4bMcpReadOutcome = 'success' | 'problem';
export type Phase4bMcpReadFailureCategory =
  | 'transport'
  | 'auth'
  | 'request_context'
  | 'projection'
  | 'listen'
  | 'backpressure'
  | 'budget'
  | 'legacy'
  | 'timeout'
  | 'abort'
  | 'internal';
export type Phase4bMcpLegacyRejectionCategory =
  | 'initialize'
  | 'session_header'
  | 'last_event_id'
  | 'legacy_method'
  | 'protocol_version'
  | 'http_method'
  | 'unknown';
export type Phase4bMcpReadBudgetBucket =
  | 'request_body_bytes'
  | 'header_count'
  | 'header_name_bytes'
  | 'header_value_bytes'
  | 'request_concurrency'
  | 'request_queue'
  | 'listen_connections'
  | 'listen_queue_bytes'
  | 'output_bytes'
  | 'output_items'
  | 'output_depth';

export interface Phase4bMcpReadMetrics {
  readonly increment: (name: string, value?: number) => void;
  readonly gauge: (name: string, value: number) => void;
  readonly observe: (name: string, value: number) => void;
}

export interface Phase4bMcpReadDependencyHealth {
  readonly oauth: 'ready' | 'degraded' | 'unavailable';
  readonly signalSource: 'ready' | 'degraded' | 'unavailable';
  readonly projection: 'ready' | 'degraded' | 'unavailable';
}

export interface Phase4bMcpReadDependencyHealthProviderOptions {
  /** Bounded JWKS provider; the health probe never stores key material. */
  readonly jwks: Pick<JwksProvider, 'getKeySet'>;
  /**
   * FIX-L-042 shared revocation store; a failing epoch read makes MCP OAuth
   * unavailable (readiness never reports the capability while the store is
   * unreachable or not provisioned).
   */
  readonly revocationStore?: Pick<McpOauthRevocationStore, 'securityEpoch'>;
}

export interface Phase4bMcpReadHighWatermarks {
  readonly requestCapacity?: number;
  readonly requestQueue?: number;
  readonly listen?: number;
}

export interface Phase4bMcpReadOperationsOptions {
  readonly metrics: Phase4bMcpReadMetrics;
  readonly maxConcurrentRequests: number;
  readonly maxQueuedRequests: number;
  readonly maxListeners: number;
  readonly dependencyHealth?: () => Promise<Phase4bMcpReadDependencyHealth>;
  readonly highWatermarks?: Phase4bMcpReadHighWatermarks;
  /** Injectable epoch-millisecond clock; defaults to performance.now. */
  readonly now?: () => number;
}

export interface Phase4bMcpReadRequestFinish {
  readonly outcome: Phase4bMcpReadOutcome;
  readonly category?: Phase4bMcpReadFailureCategory;
  readonly legacyCategory?: Phase4bMcpLegacyRejectionCategory;
  readonly budgetBucket?: Phase4bMcpReadBudgetBucket;
  readonly listenOverflow?: number;
  readonly listenRateLimited?: number;
}

export interface Phase4bMcpReadOperationHandle {
  readonly registered: boolean;
  setResourceKind(kind: Phase4bMcpReadResourceKind): void;
  attachListenSession(session: Pick<Mcp20260728SubscriptionsListenSession, 'close'>): void;
  finish(input: Phase4bMcpReadRequestFinish): void;
}

export interface Phase4bMcpReadBeginRequestInput {
  readonly kind: Phase4bMcpReadKind;
  readonly method: string;
  readonly controller: AbortController;
}

export interface Phase4bMcpReadEntrySnapshot {
  readonly kind: Phase4bMcpReadKind;
  readonly method: Phase4bMcpReadMethod;
  readonly resourceKind: Phase4bMcpReadResourceKind;
  readonly elapsedMs: number;
}

export interface Phase4bMcpReadOperationsSnapshot {
  readonly activeRequests: readonly Phase4bMcpReadEntrySnapshot[];
  readonly activeListeners: readonly Phase4bMcpReadEntrySnapshot[];
  readonly counts: {
    readonly activeRequests: number;
    readonly queuedRequests: number;
    readonly activeListeners: number;
    readonly registryUsed: number;
    readonly registryLimit: number;
  };
  readonly limits: {
    readonly maxConcurrentRequests: number;
    readonly maxQueuedRequests: number;
    readonly maxListeners: number;
  };
  readonly listenLag: {
    readonly overflowTotal: number;
    readonly rateLimitedTotal: number;
  };
}

export type Phase4bMcpReadReadinessStatus = 'ready' | 'degraded' | 'not_ready';

export interface Phase4bMcpReadReadiness {
  readonly status: Phase4bMcpReadReadinessStatus;
  readonly reasons: readonly string[];
  readonly counts: {
    readonly activeRequests: number;
    readonly queuedRequests: number;
    readonly activeListeners: number;
    readonly registryUsed: number;
    readonly registryLimit: number;
  };
  readonly limits: {
    readonly maxConcurrentRequests: number;
    readonly maxQueuedRequests: number;
    readonly maxListeners: number;
  };
  readonly listenLag: {
    readonly overflowTotal: number;
    readonly rateLimitedTotal: number;
  };
}

export interface Phase4bMcpReadListenTeardownInput {
  readonly overflow: number;
  readonly rateLimited: number;
  readonly reason: string;
}

export interface Phase4bMcpReadOperations {
  beginRequest(input: Phase4bMcpReadBeginRequestInput): Phase4bMcpReadOperationHandle;
  drain(): void;
  inspect(): Phase4bMcpReadOperationsSnapshot;
  readiness(): Promise<Phase4bMcpReadReadiness>;
  setRequestBacklog(active: number, queued: number): void;
  setListenBacklog(active: number): void;
  recordBudgetOverflow(bucket: Phase4bMcpReadBudgetBucket): void;
  recordLegacyRejection(category: Phase4bMcpLegacyRejectionCategory): void;
  recordListenTeardown(input: Phase4bMcpReadListenTeardownInput): void;
}

const READ_METHODS: ReadonlySet<string> = new Set([
  'server/discover',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'subscriptions/listen',
  'tools/list',
  'tools/call',
]);

const BUDGET_BUCKETS: ReadonlySet<string> = new Set([
  'request_body_bytes',
  'header_count',
  'header_name_bytes',
  'header_value_bytes',
  'request_concurrency',
  'request_queue',
  'listen_connections',
  'listen_queue_bytes',
  'output_bytes',
  'output_items',
  'output_depth',
]);

const LEGACY_CATEGORIES: ReadonlySet<string> = new Set([
  'initialize',
  'session_header',
  'last_event_id',
  'legacy_method',
  'protocol_version',
  'http_method',
  'unknown',
]);

const DEFAULT_HIGH_WATERMARKS: Required<Phase4bMcpReadHighWatermarks> = Object.freeze({
  requestCapacity: 0.75,
  requestQueue: 0.5,
  listen: 0.75,
});

interface RegistryEntry {
  readonly kind: Phase4bMcpReadKind;
  readonly method: Phase4bMcpReadMethod;
  resourceKind: Phase4bMcpReadResourceKind;
  readonly controller: AbortController;
  readonly startedAt: number;
  sessionClose: (() => void) | undefined;
  finished: boolean;
}

interface FinishMetrics {
  readonly method: Phase4bMcpReadMethod;
  resourceKind: Phase4bMcpReadResourceKind;
  readonly startedAt: number;
}

export function normalizePhase4bMcpReadMethod(method: string): Phase4bMcpReadMethod {
  return READ_METHODS.has(method) ? method as Phase4bMcpReadMethod : 'unknown';
}

export function phase4bMcpReadDurationBucket(durationMs: number): string {
  if (durationMs < 10) return '0_10';
  if (durationMs < 25) return '10_25';
  if (durationMs < 50) return '25_50';
  if (durationMs < 100) return '50_100';
  if (durationMs < 250) return '100_250';
  if (durationMs < 500) return '250_500';
  if (durationMs < 1_000) return '500_1000';
  if (durationMs < 5_000) return '1000_5000';
  if (durationMs < 15_000) return '5000_15000';
  if (durationMs < 60_000) return '15000_60000';
  return 'above_60000';
}

function methodLabel(method: Phase4bMcpReadMethod): string {
  return method.replaceAll('/', '_');
}

function assertSafePositive(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${name} must be a safe integer in 1..${max}`);
  }
}

function assertSafeNonNegative(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new TypeError(`${name} must be a safe integer in 0..${max}`);
  }
}

/**
 * Bounded production readiness provider for MCP Read OAuth/JWKS dependency
 * health. It returns only low-sensitivity status values; JWKS documents and
 * fetch failures are never retained or exposed through the readiness result.
 */
export function createPhase4bMcpReadDependencyHealthProvider(
  options: Phase4bMcpReadDependencyHealthProviderOptions,
): () => Promise<Phase4bMcpReadDependencyHealth> {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('MCP Read dependency health provider options must be an object.');
  }
  const jwks = options.jwks;
  if (typeof jwks !== 'object' || jwks === null || typeof jwks.getKeySet !== 'function') {
    throw new TypeError('MCP Read dependency health provider requires a JWKS provider.');
  }
  const revocationStore = options.revocationStore;
  return async () => {
    let oauth: Phase4bMcpReadDependencyHealth['oauth'] = 'ready';
    try {
      await jwks.getKeySet({ forceRefresh: false });
    } catch (error) {
      const degraded = error instanceof IdTokenVerificationError
        && (error.reason === 'jwks_timeout'
          || error.reason === 'jwks_fetch_failed'
          || error.reason === 'jwks_malformed');
      oauth = degraded ? 'degraded' : 'unavailable';
    }
    if (oauth === 'ready' && revocationStore !== undefined) {
      try {
        const epoch = await revocationStore.securityEpoch();
        if (typeof epoch !== 'string' || epoch.trim() === '') {
          oauth = 'unavailable';
        }
      } catch {
        // FIX-L-042: an unreadable revocation store fails the MCP readiness closed.
        oauth = 'unavailable';
      }
    }
    return Object.freeze({
      oauth,
      signalSource: 'ready',
      projection: 'ready',
    });
  };
}

function assertWatermark(
  value: number | undefined,
  name: keyof Phase4bMcpReadHighWatermarks,
): number {
  const resolved = value ?? DEFAULT_HIGH_WATERMARKS[name];
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new TypeError(`${name} high watermark must be a number in 0..1`);
  }
  return resolved;
}

interface MutableSnapshot {
  activeRequests: readonly Phase4bMcpReadEntrySnapshot[];
  activeListeners: readonly Phase4bMcpReadEntrySnapshot[];
  counts: {
    activeRequests: number;
    queuedRequests: number;
    activeListeners: number;
    registryUsed: number;
    registryLimit: number;
  };
  limits: {
    maxConcurrentRequests: number;
    maxQueuedRequests: number;
    maxListeners: number;
  };
  listenLag: {
    overflowTotal: number;
    rateLimitedTotal: number;
  };
}

function cloneSnapshot(): MutableSnapshot {
  return {
    activeRequests: [],
    activeListeners: [],
    counts: {
      activeRequests: 0,
      queuedRequests: 0,
      activeListeners: 0,
      registryUsed: 0,
      registryLimit: 0,
    },
    limits: { maxConcurrentRequests: 0, maxQueuedRequests: 0, maxListeners: 0 },
    listenLag: { overflowTotal: 0, rateLimitedTotal: 0 },
  };
}

export function createPhase4bMcpReadOperations(
  options: Phase4bMcpReadOperationsOptions,
): Phase4bMcpReadOperations {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('MCP Read operations options must be an object.');
  }
  const metrics = options.metrics;
  if (typeof metrics !== 'object' || metrics === null
    || typeof metrics.increment !== 'function'
    || typeof metrics.gauge !== 'function'
    || typeof metrics.observe !== 'function') {
    throw new TypeError('MCP Read operations require a Metrics seam.');
  }
  const maxConcurrentRequests = options.maxConcurrentRequests;
  const maxQueuedRequests = options.maxQueuedRequests;
  const maxListeners = options.maxListeners;
  assertSafePositive(maxConcurrentRequests, 'MCP Read maxConcurrentRequests', 100_000);
  assertSafeNonNegative(maxQueuedRequests, 'MCP Read maxQueuedRequests', 100_000);
  assertSafePositive(maxListeners, 'MCP Read maxListeners', 100_000);
  const registryLimit = maxConcurrentRequests + maxQueuedRequests + maxListeners;
  const dependencyHealth = options.dependencyHealth;
  if (dependencyHealth !== undefined && typeof dependencyHealth !== 'function') {
    throw new TypeError('MCP Read dependencyHealth must be a function.');
  }
  const nowValue = options.now;
  const now = nowValue === undefined ? () => performance.now() : nowValue;
  if (typeof now !== 'function') {
    throw new TypeError('MCP Read operations now must be a function.');
  }
  const highWatermarks: Required<Phase4bMcpReadHighWatermarks> = {
    requestCapacity: assertWatermark(options.highWatermarks?.requestCapacity, 'requestCapacity'),
    requestQueue: assertWatermark(options.highWatermarks?.requestQueue, 'requestQueue'),
    listen: assertWatermark(options.highWatermarks?.listen, 'listen'),
  };

  const entries = new Map<object, RegistryEntry>();
  let queuedRequests = 0;
  let listenOverflowTotal = 0;
  let listenRateLimitedTotal = 0;
  let draining = false;

  const updateGauges = (): void => {
    let requestCount = 0;
    let listenCount = 0;
    for (const entry of entries.values()) {
      if (entry.kind === 'request') requestCount += 1;
      else listenCount += 1;
    }
    metrics.gauge(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.requests.active`, requestCount);
    metrics.gauge(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.requests.queued`, queuedRequests);
    metrics.gauge(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.listen.active`, listenCount);
    metrics.gauge(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.registry.used`, entries.size);
    metrics.gauge(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.registry.limit`, registryLimit);
  };

  const finishRequest = (
    finishMetrics: FinishMetrics,
    input: Phase4bMcpReadRequestFinish,
  ): void => {
    const durationMs = Math.max(0, now() - finishMetrics.startedAt);
    const result = input.outcome === 'success' ? 'success' : 'problem';
    const error = input.category ?? (result === 'success' ? 'none' : 'internal');
    const budgetBucket = input.budgetBucket ?? 'none';
    metrics.increment(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.requests.total`);
    if (result === 'success') {
      metrics.increment(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.requests.success`);
    } else {
      metrics.increment(
        `${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.requests.error.${error}`,
      );
    }
    metrics.observe(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.requests.duration_ms`, durationMs);
    const bucket = phase4bMcpReadDurationBucket(durationMs);
    metrics.observe(
      `${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.requests.duration.bucket.${bucket}`,
      durationMs,
    );
    metrics.increment(
      `${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.`
        + `v${PHASE4B_MCP_READ_OPERATIONS_PROTOCOL_VERSION_LABEL}.`
        + `method.${methodLabel(finishMetrics.method)}.`
        + `resource.${finishMetrics.resourceKind}.`
        + `result.${result}.`
        + `error.${error}.`
        + `bucket.${budgetBucket}`,
    );
    if (input.legacyCategory !== undefined) {
      metrics.increment(
        `${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.legacy.rejected.${input.legacyCategory}`,
      );
    }
    if (input.listenOverflow !== undefined && input.listenOverflow > 0) {
      metrics.increment(
        `${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.listen.overflow`,
        input.listenOverflow,
      );
    }
    if (input.listenRateLimited !== undefined && input.listenRateLimited > 0) {
      metrics.increment(
        `${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.listen.rate_limited`,
        input.listenRateLimited,
      );
    }
  };

  const operations: Phase4bMcpReadOperations = Object.freeze({
    beginRequest(input: Phase4bMcpReadBeginRequestInput) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new TypeError('MCP Read beginRequest input must be an object.');
      }
      if (!(input.controller instanceof AbortController)) {
        throw new TypeError('MCP Read beginRequest requires an AbortController.');
      }
      const kind: Phase4bMcpReadKind = input.kind === 'listen' ? 'listen' : 'request';
      const method = normalizePhase4bMcpReadMethod(String(input.method));
      const resourceKind: Phase4bMcpReadResourceKind = 'none';
      const startedAt = now();
      const finishMetrics: FinishMetrics = { method, resourceKind, startedAt };
      let registered = false;
      let key: object | undefined;
      let handleFinished = false;

      if (entries.size < registryLimit) {
        key = Object.freeze({});
        entries.set(key, {
          kind,
          method,
          resourceKind,
          controller: input.controller,
          startedAt,
          sessionClose: undefined,
          finished: false,
        } as RegistryEntry);
        registered = true;
        draining = false;
        updateGauges();
      } else {
        metrics.increment(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.registry.overflow`);
      }

      return Object.freeze({
        registered,
        setResourceKind(nextKind: Phase4bMcpReadResourceKind) {
          if (key === undefined) return;
          const entry = entries.get(key);
          if (entry !== undefined && !entry.finished) {
            entry.resourceKind = nextKind;
            finishMetrics.resourceKind = nextKind;
          }
        },
        attachListenSession(session: Pick<Mcp20260728SubscriptionsListenSession, 'close'>) {
          if (key === undefined || typeof session.close !== 'function') return;
          const entry = entries.get(key);
          if (entry !== undefined && !entry.finished) entry.sessionClose = session.close;
        },
        finish(finishInput: Phase4bMcpReadRequestFinish) {
          if (handleFinished) return;
          handleFinished = true;
          if (key !== undefined) {
            const entry = entries.get(key);
            if (entry !== undefined && !entry.finished) {
              entry.finished = true;
              entries.delete(key);
              updateGauges();
            }
          }
          finishRequest(finishMetrics, finishInput);
        },
      });
    },
    drain() {
      metrics.increment(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.drain.total`);
      draining = true;
      for (const entry of entries.values()) {
        entry.controller.abort(new DOMException('MCP Read drained', 'AbortError'));
        entry.sessionClose?.();
      }
    },
    inspect() {
      const snapshot = cloneSnapshot();
      snapshot.counts.queuedRequests = queuedRequests;
      snapshot.counts.registryLimit = registryLimit;
      snapshot.limits.maxConcurrentRequests = maxConcurrentRequests;
      snapshot.limits.maxQueuedRequests = maxQueuedRequests;
      snapshot.limits.maxListeners = maxListeners;
      snapshot.listenLag.overflowTotal = listenOverflowTotal;
      snapshot.listenLag.rateLimitedTotal = listenRateLimitedTotal;
      const requestEntries: Phase4bMcpReadEntrySnapshot[] = [];
      const listenEntries: Phase4bMcpReadEntrySnapshot[] = [];
      for (const entry of entries.values()) {
        const item: Phase4bMcpReadEntrySnapshot = Object.freeze({
          kind: entry.kind,
          method: entry.method,
          resourceKind: entry.resourceKind,
          elapsedMs: Math.max(0, now() - entry.startedAt),
        });
        if (entry.kind === 'request') requestEntries.push(item);
        else listenEntries.push(item);
      }
      snapshot.activeRequests = Object.freeze(requestEntries);
      snapshot.activeListeners = Object.freeze(listenEntries);
      snapshot.counts.activeRequests = requestEntries.length;
      snapshot.counts.activeListeners = listenEntries.length;
      snapshot.counts.registryUsed = entries.size;
      return Object.freeze(snapshot);
    },
    async readiness() {
      let dependency: Phase4bMcpReadDependencyHealth = Object.freeze({
        oauth: 'unavailable',
        signalSource: 'unavailable',
        projection: 'unavailable',
      });
      let dependencyUnavailable = dependencyHealth === undefined;
      if (dependencyHealth !== undefined) {
        try {
          dependency = await dependencyHealth();
        } catch {
          dependencyUnavailable = true;
        }
      }
      const requestCapacity = maxConcurrentRequests + maxQueuedRequests;
      const activeRequests = [...entries.values()].filter((entry) => entry.kind === 'request').length;
      const activeListeners = [...entries.values()].filter((entry) => entry.kind === 'listen').length;
      const requestCapacityRatio = requestCapacity > 0 ? activeRequests / requestCapacity : 1;
      const queueRatio = maxQueuedRequests > 0 ? queuedRequests / maxQueuedRequests : 0;
      const listenRatio = maxListeners > 0 ? activeListeners / maxListeners : 1;
      const reasons: string[] = [];
      let status: Phase4bMcpReadReadinessStatus = 'ready';

      if (draining) {
        status = 'not_ready';
        reasons.push('mcp_read_draining');
      }

      if (dependencyUnavailable || dependency.oauth === 'unavailable'
        || dependency.signalSource === 'unavailable' || dependency.projection === 'unavailable') {
        status = 'not_ready';
        reasons.push('mcp_read_dependency_unavailable');
      } else if (dependency.oauth === 'degraded' || dependency.signalSource === 'degraded'
        || dependency.projection === 'degraded') {
        status = 'degraded';
        reasons.push('mcp_read_dependency_degraded');
      }
      const queueExhausted = maxQueuedRequests === 0
        ? queuedRequests > 0
        : queuedRequests >= maxQueuedRequests;
      if (activeRequests >= requestCapacity || queueExhausted
        || activeListeners >= maxListeners || entries.size >= registryLimit) {
        status = 'not_ready';
        reasons.push('mcp_read_capacity_exhausted');
      } else if (requestCapacityRatio >= highWatermarks.requestCapacity
        || queueRatio >= highWatermarks.requestQueue
        || listenRatio >= highWatermarks.listen) {
        status = status === 'ready' ? 'degraded' : status;
        reasons.push('mcp_read_near_capacity');
      }
      if (listenOverflowTotal > 0 || listenRateLimitedTotal > 0) {
        status = status === 'ready' ? 'degraded' : status;
        reasons.push('mcp_read_listener_lag');
      }
      return Object.freeze({
        status,
        reasons: Object.freeze(reasons),
        counts: Object.freeze({
          activeRequests,
          queuedRequests,
          activeListeners,
          registryUsed: entries.size,
          registryLimit,
        }),
        limits: Object.freeze({
          maxConcurrentRequests,
          maxQueuedRequests,
          maxListeners,
        }),
        listenLag: Object.freeze({
          overflowTotal: listenOverflowTotal,
          rateLimitedTotal: listenRateLimitedTotal,
        }),
      });
    },
    setRequestBacklog(active: number, queued: number) {
      if (!Number.isSafeInteger(active) || active < 0 || !Number.isSafeInteger(queued) || queued < 0) {
        throw new TypeError('MCP Read request backlog counts must be non-negative safe integers.');
      }
      queuedRequests = queued;
      metrics.gauge(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.requests.active`, active);
      metrics.gauge(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.requests.queued`, queued);
    },
    setListenBacklog(active: number) {
      if (!Number.isSafeInteger(active) || active < 0) {
        throw new TypeError('MCP Read listen backlog must be a non-negative safe integer.');
      }
      metrics.gauge(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.listen.active`, active);
    },
    recordBudgetOverflow(bucket: Phase4bMcpReadBudgetBucket) {
      if (!BUDGET_BUCKETS.has(bucket)) {
        throw new TypeError(`Unknown MCP Read budget bucket: ${String(bucket)}`);
      }
      metrics.increment(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.budget.overflow.${bucket}`);
      if (bucket === 'request_queue') {
        metrics.increment(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.queue.overflow`);
      }
    },
    recordLegacyRejection(category: Phase4bMcpLegacyRejectionCategory) {
      if (!LEGACY_CATEGORIES.has(category)) {
        throw new TypeError(`Unknown MCP Read legacy rejection category: ${String(category)}`);
      }
      metrics.increment(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.legacy.rejected.${category}`);
    },
    recordListenTeardown(input: Phase4bMcpReadListenTeardownInput) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new TypeError('MCP Read listen teardown input must be an object.');
      }
      const overflow = input.overflow;
      const rateLimited = input.rateLimited;
      if (!Number.isSafeInteger(overflow) || overflow < 0
        || !Number.isSafeInteger(rateLimited) || rateLimited < 0) {
        throw new TypeError('MCP Read listen teardown counts must be non-negative safe integers.');
      }
      listenOverflowTotal += overflow;
      listenRateLimitedTotal += rateLimited;
      if (overflow > 0) {
        metrics.increment(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.listen.overflow`, overflow);
      }
      if (rateLimited > 0) {
        metrics.increment(
          `${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.listen.rate_limited`,
          rateLimited,
        );
      }
      metrics.increment(`${PHASE4B_MCP_READ_OPERATIONS_METRIC_PREFIX}.listen.teardown_total`);
    },
  });
  updateGauges();
  return operations;
}
