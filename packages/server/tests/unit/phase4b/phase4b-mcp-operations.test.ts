import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Metrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createPhase4bMcpReadDependencyHealthProvider,
  createPhase4bMcpReadOperations,
  normalizePhase4bMcpReadMethod,
  phase4bMcpReadDurationBucket,
  type Phase4bMcpReadOperationHandle,
  type Phase4bMcpReadOperations,
} from '../../../src/modules/mcp/index.js';
import { IdTokenVerificationError } from '../../../src/modules/identity/index.js';

class RecordingMetrics implements Metrics {
  readonly names: string[] = [];
  private readonly values = new Map<string, number>();
  private readonly samples = new Map<string, number[]>();

  increment(name: string, value = 1): void {
    this.names.push(name);
    this.values.set(name, (this.values.get(name) ?? 0) + value);
  }

  gauge(name: string, value: number): void {
    this.names.push(name);
    this.values.set(name, value);
  }

  observe(name: string, value: number): void {
    this.names.push(name);
    const samples = this.samples.get(name) ?? [];
    samples.push(value);
    this.samples.set(name, samples);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  observations(name: string): readonly number[] {
    return [...(this.samples.get(name) ?? [])];
  }
}

function createOperations(overrides: Partial<Parameters<typeof createPhase4bMcpReadOperations>[0]> = {}): {
  readonly operations: Phase4bMcpReadOperations;
  readonly metrics: RecordingMetrics;
} {
  const metrics = new RecordingMetrics();
  const operations = createPhase4bMcpReadOperations({
    metrics,
    maxConcurrentRequests: 2,
    maxQueuedRequests: 1,
    maxListeners: 2,
    dependencyHealth: async () => ({
      oauth: 'ready',
      signalSource: 'ready',
      projection: 'ready',
    }),
    ...overrides,
  });
  return { operations, metrics };
}

test('operation registry exposes only low-sensitivity active request and listener snapshots', () => {
  const { operations } = createOperations();
  const requestController = new AbortController();
  const listenController = new AbortController();
  const request = operations.beginRequest({
    kind: 'request',
    method: 'resources/read',
    controller: requestController,
  });
  request.setResourceKind('collection_node');
  const listen = operations.beginRequest({
    kind: 'listen',
    method: 'subscriptions/listen',
    controller: listenController,
  });
  let sessionClosed = false;
  listen.attachListenSession({
    close() {
      sessionClosed = true;
    },
  });

  const snapshot = operations.inspect();
  assert.equal(snapshot.activeRequests.length, 1);
  assert.equal(snapshot.activeRequests[0]?.method, 'resources/read');
  assert.equal(snapshot.activeRequests[0]?.resourceKind, 'collection_node');
  assert.equal(typeof snapshot.activeRequests[0]?.elapsedMs, 'number');
  assert.deepEqual(
    Object.keys(snapshot.activeRequests[0] ?? {}).sort(),
    ['elapsedMs', 'kind', 'method', 'resourceKind'],
  );
  assert.equal(snapshot.activeListeners.length, 1);
  assert.equal(snapshot.activeListeners[0]?.method, 'subscriptions/listen');
  assert.deepEqual(
    Object.keys(snapshot.activeListeners[0] ?? {}).sort(),
    ['elapsedMs', 'kind', 'method', 'resourceKind'],
  );
  assert.equal(snapshot.counts.activeRequests, 1);
  assert.equal(snapshot.counts.activeListeners, 1);

  operations.drain();
  assert.equal(requestController.signal.aborted, true);
  assert.equal(listenController.signal.aborted, true);
  assert.equal(sessionClosed, true);

  request.finish({ outcome: 'problem', category: 'abort' });
  listen.finish({ outcome: 'problem', category: 'abort' });
  assert.equal(operations.inspect().activeRequests.length, 0);
  assert.equal(operations.inspect().activeListeners.length, 0);
});

test('forced drain aborts only registered MCP controls and is bounded by configured capacity', () => {
  const { operations } = createOperations({
    maxConcurrentRequests: 1,
    maxQueuedRequests: 0,
    maxListeners: 1,
  });
  const unrelated = new AbortController();
  const first = operations.beginRequest({
    kind: 'request',
    method: 'server/discover',
    controller: new AbortController(),
  });
  const listener = operations.beginRequest({
    kind: 'listen',
    method: 'subscriptions/listen',
    controller: new AbortController(),
  });
  const overflow = operations.beginRequest({
    kind: 'request',
    method: 'resources/list',
    controller: new AbortController(),
  });
  assert.equal(first.registered, true);
  assert.equal(listener.registered, true);
  assert.equal(overflow.registered, false);

  operations.drain();
  assert.equal(unrelated.signal.aborted, false);
  first.finish({ outcome: 'problem', category: 'abort' });
  listener.finish({ outcome: 'problem', category: 'abort' });
  assert.equal(operations.inspect().counts.registryUsed, 0);
});

test('outcome metrics stay low cardinality and never carry identity or content labels', () => {
  const { operations, metrics } = createOperations();
  const cases: ReadonlyArray<{
    readonly kind: 'request' | 'listen';
    readonly method: string;
    readonly outcome: 'success' | 'problem';
    readonly category?: 'transport' | 'auth' | 'request_context' | 'projection'
      | 'listen' | 'backpressure' | 'budget' | 'legacy' | 'timeout' | 'abort' | 'internal';
    readonly legacyCategory?: 'initialize' | 'session_header' | 'last_event_id'
      | 'legacy_method' | 'protocol_version' | 'http_method' | 'unknown';
  }> = [
    { kind: 'request', method: 'server/discover', outcome: 'success' },
    { kind: 'request', method: 'resources/list', outcome: 'problem', category: 'projection' },
    { kind: 'request', method: 'resources/read', outcome: 'problem', category: 'budget' },
    { kind: 'request', method: 'tools/call', outcome: 'problem', category: 'auth' },
    { kind: 'request', method: 'unknown', outcome: 'problem', category: 'request_context' },
    { kind: 'listen', method: 'subscriptions/listen', outcome: 'problem', category: 'listen' },
    { kind: 'request', method: 'server/discover', outcome: 'problem', category: 'transport' },
    { kind: 'request', method: 'resources/read', outcome: 'problem', category: 'legacy',
      legacyCategory: 'initialize' },
  ];
  for (const item of cases) {
    const handle = operations.beginRequest({
      kind: item.kind,
      method: item.method,
      controller: new AbortController(),
    });
    handle.finish({
      outcome: item.outcome,
      category: item.category,
      legacyCategory: item.legacyCategory,
    });
  }
  operations.recordBudgetOverflow('request_queue');
  operations.recordBudgetOverflow('output_bytes');
  operations.recordListenTeardown({ overflow: 3, rateLimited: 1, reason: 'slow_consumer' });

  assert.equal(metrics.get('mcp.read.requests.total'), 8);
  assert.equal(metrics.get('mcp.read.requests.success'), 1);
  assert.equal(metrics.get('mcp.read.requests.error.projection'), 1);
  assert.equal(metrics.get('mcp.read.requests.error.budget'), 1);
  assert.equal(metrics.get('mcp.read.requests.error.auth'), 1);
  assert.equal(metrics.get('mcp.read.requests.error.request_context'), 1);
  assert.equal(metrics.get('mcp.read.requests.error.listen'), 1);
  assert.equal(metrics.get('mcp.read.requests.error.transport'), 1);
  assert.equal(metrics.get('mcp.read.requests.error.legacy'), 1);
  assert.equal(metrics.get('mcp.read.legacy.rejected.initialize'), 1);
  assert.equal(metrics.get('mcp.read.budget.overflow.request_queue'), 1);
  assert.equal(metrics.get('mcp.read.budget.overflow.output_bytes'), 1);
  assert.equal(metrics.get('mcp.read.listen.overflow'), 3);
  assert.equal(metrics.get('mcp.read.listen.rate_limited'), 1);

  const metricPattern = /^mcp\.read\.[a-z0-9_.]+$/u;
  assert.ok(metrics.names.length > 20);
  for (const name of metrics.names) {
    assert.match(name, metricPattern, `unstable metric name ${name}`);
    assert.doesNotMatch(
      name,
      /(?:uri|collection|node|principal|subject|origin|token|secret|content|argument|request_id|authorization)/iu,
      `secret or identity label leaked into ${name}`,
    );
  }
  assert.deepEqual(metrics.observations('mcp.read.requests.duration_ms').filter(Number.isFinite).length, 8);
});

test('method normalization, duration buckets, and budget names are bounded', () => {
  assert.equal(normalizePhase4bMcpReadMethod('server/discover'), 'server/discover');
  assert.equal(normalizePhase4bMcpReadMethod('resources/list'), 'resources/list');
  assert.equal(normalizePhase4bMcpReadMethod('resources/templates/list'), 'resources/templates/list');
  assert.equal(normalizePhase4bMcpReadMethod('resources/read'), 'resources/read');
  assert.equal(normalizePhase4bMcpReadMethod('subscriptions/listen'), 'subscriptions/listen');
  assert.equal(normalizePhase4bMcpReadMethod('tools/list'), 'tools/list');
  assert.equal(normalizePhase4bMcpReadMethod('tools/call'), 'tools/call');
  assert.equal(normalizePhase4bMcpReadMethod('anything'), 'unknown');

  assert.equal(phase4bMcpReadDurationBucket(0), '0_10');
  assert.equal(phase4bMcpReadDurationBucket(10), '10_25');
  assert.equal(phase4bMcpReadDurationBucket(99), '50_100');
  assert.equal(phase4bMcpReadDurationBucket(1_001), '1000_5000');
  assert.equal(phase4bMcpReadDurationBucket(60_001), 'above_60000');
});

test('OAuth dependency health provider maps bounded JWKS statuses without exposing details', async () => {
  const healthy = createPhase4bMcpReadDependencyHealthProvider({
    jwks: {
      async getKeySet() {
        return { keys: [] };
      },
    },
  });
  assert.deepEqual(await healthy(), {
    oauth: 'ready',
    signalSource: 'ready',
    projection: 'ready',
  });

  const degraded = createPhase4bMcpReadDependencyHealthProvider({
    jwks: {
      async getKeySet() {
        throw new IdTokenVerificationError('jwks_fetch_failed');
      },
    },
  });
  assert.equal((await degraded()).oauth, 'degraded');

  const unavailable = createPhase4bMcpReadDependencyHealthProvider({
    jwks: {
      async getKeySet() {
        throw new Error('unexpected provider failure');
      },
    },
  });
  assert.equal((await unavailable()).oauth, 'unavailable');

  const storeUnavailable = createPhase4bMcpReadDependencyHealthProvider({
    jwks: {
      async getKeySet() {
        return { keys: [] };
      },
    },
    revocationStore: {
      async securityEpoch() {
        throw new Error('epoch store offline');
      },
    },
  });
  assert.equal(
    (await storeUnavailable()).oauth,
    'unavailable',
    'a failing revocation store must fail the MCP readiness closed',
  );

  const storeHealthy = createPhase4bMcpReadDependencyHealthProvider({
    jwks: {
      async getKeySet() {
        return { keys: [] };
      },
    },
    revocationStore: {
      async securityEpoch() {
        return 'epoch-1';
      },
    },
  });
  assert.deepEqual(await storeHealthy(), {
    oauth: 'ready',
    signalSource: 'ready',
    projection: 'ready',
  });
});

test('drain marks MCP Read not ready until a new registered operation restarts it', async () => {
  const { operations } = createOperations();
  operations.drain();
  assert.equal((await operations.readiness()).status, 'not_ready');
  assert.ok((await operations.readiness()).reasons.includes('mcp_read_draining'));

  const handle = operations.beginRequest({
    kind: 'request',
    method: 'server/discover',
    controller: new AbortController(),
  });
  assert.equal((await operations.readiness()).status, 'ready');
  handle.finish({ outcome: 'success' });
});

test('readiness fails closed when no OAuth dependency health provider is wired', async () => {
  const { operations } = createOperations({ dependencyHealth: undefined });
  const readiness = await operations.readiness();
  assert.equal(readiness.status, 'not_ready');
  assert.ok(readiness.reasons.includes('mcp_read_dependency_unavailable'));
});

test('readiness reflects dependency health, active/queue/listener bounds, and listener lag', async () => {
  const ready = await createOperations().operations.readiness();
  assert.equal(ready.status, 'ready');

  const degradedDependency = createOperations({
    dependencyHealth: async () => ({
      oauth: 'degraded',
      signalSource: 'ready',
      projection: 'ready',
    }),
  });
  assert.equal((await degradedDependency.operations.readiness()).status, 'degraded');

  const unavailableDependency = createOperations({
    dependencyHealth: async () => ({
      oauth: 'unavailable',
      signalSource: 'ready',
      projection: 'ready',
    }),
  });
  assert.equal((await unavailableDependency.operations.readiness()).status, 'not_ready');

  const bounded = createOperations({
    maxConcurrentRequests: 2,
    maxQueuedRequests: 2,
    maxListeners: 2,
  });
  bounded.operations.setRequestBacklog(2, 1);
  assert.equal((await bounded.operations.readiness()).status, 'degraded');
  bounded.operations.setRequestBacklog(2, 2);
  assert.equal((await bounded.operations.readiness()).status, 'not_ready');

  const lag = createOperations();
  lag.operations.recordListenTeardown({ overflow: 1, rateLimited: 0, reason: 'overflow' });
  assert.equal((await lag.operations.readiness()).status, 'degraded');
});

test('finish is idempotent and reports active gauges to zero', () => {
  const { operations, metrics } = createOperations();
  const handle: Phase4bMcpReadOperationHandle = operations.beginRequest({
    kind: 'request',
    method: 'tools/list',
    controller: new AbortController(),
  });
  assert.equal(metrics.get('mcp.read.requests.active'), 1);
  handle.finish({ outcome: 'success' });
  handle.finish({ outcome: 'success' });
  assert.equal(metrics.get('mcp.read.requests.active'), 0);
  assert.equal(metrics.get('mcp.read.requests.total'), 1);
});
