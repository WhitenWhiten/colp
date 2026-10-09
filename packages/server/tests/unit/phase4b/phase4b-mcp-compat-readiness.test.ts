/**
 * T-07: live `/ready/features/mcp-compat` probe, independent of strict MCP
 * Read, plus admission/handler metric emission. No `vi.mock` of the SUT.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, test } from 'vitest';
import { waitForCondition } from '../../support/async-test-helpers.js';
import type { FastifyInstance } from 'fastify';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  MCP_COMPAT_READINESS_PATH,
  MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS,
  PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST,
  createMcpCompatReadinessDocument,
  createPhase4bMcpCompatOperations,
  createPhase4bMcpReadOperations,
  type McpCompatReadinessDocument,
  type Phase4bMcpCompatOperations,
  type Phase4bMcpReadOperations,
} from '../../../src/modules/mcp/index.js';
import { createMemoryMcpRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  collectTaint,
  createCompatPingCapture,
  injectCompatLegacyPost,
  injectCompatPost,
  injectStrictPost,
  pingMcpApplicationFacade,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import { CODEX_CLIENT } from '../../support/phase4b-mcp-compat-matrix-harness.js';
import {
  MCP_COMPAT_CANARY_BEARER,
  mcpCompatInitializeBody,
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
} from '../../support/phase4b-mcp-compat-spike.js';
import { modernBody, MCP_TEST_REQUEST_HOST } from '../../support/phase4b-mcp-transport-scaffold.js';

const COMPAT_REVISION = MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION;
const apps: FastifyInstance[] = [];
const ALLOWLIST = new Set(PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST);

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
}

function readyOauth() {
  return async () => ({
    oauth: 'ready' as const,
    signalSource: 'ready' as const,
    projection: 'ready' as const,
  });
}

function createReadOperations(metrics = new InMemoryMetrics()): Phase4bMcpReadOperations {
  return createPhase4bMcpReadOperations({
    metrics,
    maxConcurrentRequests: 4,
    maxQueuedRequests: 1,
    maxListeners: 1,
    dependencyHealth: readyOauth(),
  });
}

function createCompatOperations(
  metrics: InMemoryMetrics,
  overrides: Partial<Parameters<typeof createPhase4bMcpCompatOperations>[0]> = {},
): Phase4bMcpCompatOperations {
  return createPhase4bMcpCompatOperations({
    metrics,
    maxConcurrentRequests: 4,
    maxQueuedRequests: 1,
    oauthHealth: readyOauth(),
    limiterHealth: async () => 'ready' as const,
    ...overrides,
  });
}

function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  return waitForCondition(predicate, { timeoutMs: 2_000, description: label });
}

function assertCompatMetricNames(names: readonly string[]): void {
  for (const name of names) {
    if (!name.startsWith('mcp.compat.')) continue;
    assert.equal(ALLOWLIST.has(name), true, name);
    assert.doesNotMatch(name, /mcp\.read\.|mcp\.write\./u, name);
    assert.doesNotMatch(
      name,
      /(?:uri|principal|token|user.?agent|clientinfo|planid|authorization)/iu,
      name,
    );
  }
}

test('flag off leaves the compat probe and POST unregistered; /health and /ready stay 200', async () => {
  const server = track(startCompatApp({ compatEnabled: false }));
  assert.equal((await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH })).statusCode, 404);
  assert.equal((await injectCompatPost(server.app, mcpCompatToolsListBody(1))).statusCode, 404);
  assert.equal((await server.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  assert.equal((await server.app.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
});

test('flag on idle probe is the live identity-free singleton-version document', async () => {
  const server = track(startCompatApp());
  const response = await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH });
  assert.equal(response.statusCode, 200);
  const body = response.json<McpCompatReadinessDocument>();
  assert.deepEqual(body, createMcpCompatReadinessDocument());
  assert.equal(body.capability, 'mcp-compat');
  assert.equal(body.enabled, true);
  assert.equal(body.status, 'ready');
  assert.equal(body.admitting, true);
  assert.deepEqual(body.supportedProtocolVersions, ['2025-11-25']);
  assert.equal(body.counts.activeRequests, 0);
  assert.equal(body.rejectCounts.total, 0);
  const blob = JSON.stringify(body);
  assert.doesNotMatch(blob, /principal|token|clientId|userAgent|authorization|planId/iu);
});

test('compat oauth 503 leaves strict /ready/features/mcp, /health, and /ready green', async () => {
  const metrics = new InMemoryMetrics();
  const read = createReadOperations(metrics);
  const compat = createCompatOperations(metrics, {
    oauthHealth: async () => ({
      oauth: 'unavailable',
      signalSource: 'ready',
      projection: 'ready',
    }),
  });
  const server = track(startCompatApp({
    mcpReadOperations: read,
    mcpCompatOperations: compat,
    mcpReadTransport: { dependencyHealth: readyOauth() },
  }));
  const compatProbe = await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH });
  const strictProbe = await server.app.inject({ method: 'GET', url: '/ready/features/mcp' });
  assert.equal(compatProbe.statusCode, 503);
  assert.equal(compatProbe.json().status, 'not_ready');
  assert.ok(compatProbe.json().reasons.includes('mcp_compat_dependency_unavailable'));
  assert.equal(strictProbe.statusCode, 200);
  assert.equal(strictProbe.json().status, 'ready');
  assert.equal((await server.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  assert.equal((await server.app.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
});

test('limiter unavailability 503s only the compat probe', async () => {
  const metrics = new InMemoryMetrics();
  const server = track(startCompatApp({
    mcpReadOperations: createReadOperations(metrics),
    mcpCompatOperations: createCompatOperations(metrics, {
      limiterHealth: async () => 'unavailable',
    }),
    mcpReadTransport: { dependencyHealth: readyOauth() },
  }));
  assert.equal((await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH })).statusCode, 503);
  assert.equal((await server.app.inject({ method: 'GET', url: '/ready/features/mcp' })).statusCode, 200);
});

test('write-on approval store fault 503s compat and leaves strict read green', async () => {
  const metrics = new InMemoryMetrics();
  const server = track(startCompatApp({
    writeEnabled: true,
    mcpReadOperations: createReadOperations(metrics),
    mcpCompatOperations: createCompatOperations(metrics, {
      writeEnabled: true,
      approvalHealth: async () => 'unavailable',
    }),
    mcpReadTransport: { dependencyHealth: readyOauth() },
  }));
  const probe = await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH });
  assert.equal(probe.statusCode, 503);
  assert.ok(probe.json().reasons.includes('mcp_compat_approval_unavailable'));
  assert.equal((await server.app.inject({ method: 'GET', url: '/ready/features/mcp' })).statusCode, 200);
});

test('live rejectCounts and activeRequests stay identity-free', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture, { slow: true }) },
  }));
  const rejected = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsListBody(2),
    COMPAT_REVISION,
    { origin: 'https://attacker.example.test' },
  );
  assert.equal(rejected.statusCode, 403);
  const afterReject = await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH });
  assert.equal(afterReject.statusCode, 200);
  assert.ok(afterReject.json().rejectCounts.admission >= 1);
  assert.ok(afterReject.json().rejectCounts.total >= 1);
  assert.equal(server.metrics.get('mcp.compat.reject.admission'), 1);

  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const address = server.app.server.address();
  assert.ok(address && typeof address === 'object');
  const inFlight = http.request({
    hostname: '127.0.0.1',
    port: address.port,
    path: MCP_COMPAT_ENDPOINT_PATH,
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25', host: MCP_TEST_REQUEST_HOST },
  });
  inFlight.write(JSON.stringify(mcpCompatToolsCallBody('compat.ping', 99)));
  inFlight.end();
  inFlight.on('error', () => undefined);
  await waitUntil(() => capture.slowStarted, 'slow tool start');
  const live = await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH });
  assert.ok(live.json().counts.activeRequests >= 1);
  assert.doesNotMatch(JSON.stringify(live.json()), /compat\.ping|127\.0\.0\.1|principal|token/iu);
  inFlight.destroy();
  await waitUntil(() => capture.aborted, 'abort after destroy');
});

test('drain stops new admission, ends in-flight, and does not require data cleanup', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture, { slow: true }) },
  }));
  assert.ok(server.operations);
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const address = server.app.server.address();
  assert.ok(address && typeof address === 'object');
  const inFlight = http.request({
    hostname: '127.0.0.1',
    port: address.port,
    path: MCP_COMPAT_ENDPOINT_PATH,
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25', host: MCP_TEST_REQUEST_HOST },
  });
  inFlight.write(JSON.stringify(mcpCompatToolsCallBody('compat.ping', 99)));
  inFlight.end();
  inFlight.on('error', () => undefined);
  await waitUntil(() => capture.slowStarted, 'slow tool start');
  server.operations.drain();
  await waitUntil(() => capture.aborted, 'drain abort');
  const probe = await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH });
  assert.equal(probe.statusCode, 503);
  assert.equal(probe.json().admitting, false);
  assert.ok(probe.json().reasons.includes('mcp_compat_draining'));
  const next = await injectCompatLegacyPost(server.app, mcpCompatToolsListBody(3));
  assert.equal(next.statusCode, 503);
  assert.deepEqual(next.json(), { error: 'mcp_compat_draining' });
  assert.equal((await server.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  assert.equal((await server.app.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
  assert.equal((await server.app.inject({ method: 'GET', url: '/ready/features/mcp' })).statusCode, 200);
  assert.equal(server.metrics.get('mcp.compat.drain.total'), 1);
  assert.ok(server.metrics.get('mcp.compat.requests.outcome.cancelled') >= 1);
});

test('Codex 06-18 offer is handshake-only; negotiated revision stays 2025-11-25', async () => {
  const server = track(startCompatApp());
  const response = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody('2025-06-18', CODEX_CLIENT),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(server.metrics.get('mcp.compat.handshake.offer.2025_06_18'), 1);
  assert.equal(server.metrics.get('mcp.compat.handshake.revision.2025_11_25'), 1);
  assert.equal(server.metrics.get('mcp.compat.client.codex'), 1);
  assert.equal(server.metrics.get('mcp.compat.client.unknown'), 0);
  assert.equal(server.metricNames.includes('mcp.compat.client.codex_cli'), false);
  assert.equal(server.metrics.get('mcp.compat.requests.revision.2025_11_25'), 1);
  assert.equal(server.metricNames.includes('mcp.compat.handshake.revision.2025_06_18'), false);
  assert.equal(server.metricNames.includes('mcp.compat.requests.revision.2025_06_18'), false);
  assertCompatMetricNames(server.metricNames);
});

test('claude-code is allowlisted; unknown names collapse; canary never appears', async () => {
  const server = track(startCompatApp());
  const claude = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  assert.equal(claude.statusCode, 200);
  assert.equal(server.metrics.get('mcp.compat.client.claude_code'), 1);
  const other = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'Cursor', version: '1.0.0' }),
    COMPAT_REVISION,
    { authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}` },
  );
  assert.notEqual(other.statusCode, 500);
  const lookalikes = ['codex-cli', 'my-codex', 'codex-cli-evil', 'codex_cli_evil', 'codexcli'] as const;
  for (const name of lookalikes) {
    const response = await injectCompatLegacyPost(
      server.app,
      mcpCompatInitializeBody(COMPAT_REVISION, { name, version: '0.0.0' }),
    );
    assert.equal(response.statusCode, 200, name);
  }
  assert.equal(server.metrics.get('mcp.compat.client.unknown'), lookalikes.length);
  assert.equal(server.metrics.get('mcp.compat.client.codex'), 0);
  const blob = collectTaint([
    server.metricNames,
    (await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH })).json(),
    other.payload,
  ]);
  assert.doesNotMatch(blob, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
  assert.doesNotMatch(blob, /Cursor|codex_cli/u);
  assertCompatMetricNames(server.metricNames);
});

test('07-28 envelope records era=modern revision=unsupported on the compat prefix only', async () => {
  const server = track(startCompatApp());
  const response = await injectCompatPost(server.app, JSON.parse(modernBody('tools/list', 7)) as unknown);
  assert.equal(response.statusCode, MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS);
  assert.equal(server.metrics.get('mcp.compat.requests.era.modern'), 1);
  assert.equal(server.metrics.get('mcp.compat.requests.revision.unsupported'), 1);
  assert.equal(server.metrics.get('mcp.compat.reject.unsupported'), 1);
  assert.equal(server.metrics.get('mcp.read.requests.total'), 0);
  const probe = await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH });
  assert.ok(probe.json().rejectCounts.unsupported >= 1);
});

test('shared limiter burst 429s both surfaces and counts rate_limited on compat only', async () => {
  const limiter = createMemoryMcpRateLimiter({
    request: { maxRequests: 1, windowMs: 60_000 },
    now: () => 1_000,
  });
  const server = track(startCompatApp({
    mcpReadTransport: { requestRateLimiter: limiter, dependencyHealth: readyOauth() },
    mcpRateLimiter: limiter,
  }));
  const first = await injectCompatPost(server.app, mcpCompatToolsListBody(1));
  assert.ok(first.statusCode < 500);
  const compatLimited = await injectCompatPost(server.app, mcpCompatToolsListBody(2));
  const strictLimited = await injectStrictPost(server.app, 'server/discover', 3);
  assert.equal(compatLimited.statusCode, 429);
  assert.equal(strictLimited.statusCode, 429);
  assert.equal(server.metrics.get('mcp.compat.reject.rate_limited'), 1);
  assert.equal(server.metrics.get('mcp.compat.requests.outcome.rate_limited'), 1);
  assert.equal(server.metrics.get('mcp.read.budget.overflow.request_queue'), 0);
});
