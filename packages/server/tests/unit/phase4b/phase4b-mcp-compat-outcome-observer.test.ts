/**
 * MCP-CQ-05: compat POST must classify outcome/revision from the real route.
 * Failures (version reject, JSON-RPC error, isError, dependency throw) must
 * never increment `outcome.ok` or, for version rejects, `revision.2025_11_25`.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS,
  PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST,
  Phase4bMcpLowRiskNodeCreateError,
} from '../../../src/modules/mcp/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  classifyMcpCompatHijackedBody,
  createMcpCompatExecutionObserver,
  McpCompatUnclassifiedExecutionError,
} from '../../../src/transport/mcp/mcp-compat-execution-observer.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';
import {
  compatJsonRpc,
  createCompatPingCapture,
  injectCompatLegacyPost,
  injectCompatPost,
  pingMcpApplicationFacade,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import {
  mcpCompatInitializeBody,
  mcpCompatInitializedBody,
  mcpCompatResourcesListBody,
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
} from '../../support/phase4b-mcp-compat-spike.js';
import { modernBody } from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  COMPAT_REVISION,
  createWriteFixture,
  nodeCreateArguments,
  signedCompatWriteClient,
  startCompatWriteApp,
} from '../../support/phase4b-mcp-compat-write.js';
import type { McpApplicationFacade } from '../../../src/modules/mcp/index.js';

const apps: FastifyInstance[] = [];
const OUTCOMES = [
  'ok', 'rejected', 'auth_required', 'forbidden', 'rate_limited', 'dependency_error', 'cancelled',
] as const;
const REVISIONS = ['2026_07_28', '2025_11_25', 'unsupported'] as const;
const ALLOWLIST = new Set(PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST);

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
}

function startPing() {
  return track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(createCompatPingCapture()) },
  }));
}

function snapshot(metrics: InMemoryMetrics) {
  return {
    total: metrics.get('mcp.compat.requests.total'),
    outcomes: Object.fromEntries(OUTCOMES.map((name) => [name, metrics.get(`mcp.compat.requests.outcome.${name}`)])),
    revisions: Object.fromEntries(REVISIONS.map((name) => [name, metrics.get(`mcp.compat.requests.revision.${name}`)])),
  };
}

function assertCountedOnce(
  metrics: InMemoryMetrics,
  before: ReturnType<typeof snapshot>,
  expected: {
    readonly outcome: typeof OUTCOMES[number];
    readonly revision: typeof REVISIONS[number];
  },
): void {
  assert.equal(metrics.get('mcp.compat.requests.total'), before.total + 1);
  let outcomeDelta = 0;
  for (const name of OUTCOMES) {
    const delta = metrics.get(`mcp.compat.requests.outcome.${name}`) - before.outcomes[name];
    if (name === expected.outcome) assert.equal(delta, 1, name);
    else assert.equal(delta, 0, name);
    outcomeDelta += delta;
  }
  assert.equal(outcomeDelta, 1);
  let revisionDelta = 0;
  for (const name of REVISIONS) {
    const delta = metrics.get(`mcp.compat.requests.revision.${name}`) - before.revisions[name];
    if (name === expected.revision) assert.equal(delta, 1, name);
    else assert.equal(delta, 0, name);
    revisionDelta += delta;
  }
  assert.equal(revisionDelta, 1);
}

test('unclassified observer throws in test and never defaults to ok', () => {
  const observer = createMcpCompatExecutionObserver();
  assert.equal(process.env.NODE_ENV, 'test');
  assert.throws(
    () => observer.toFinish({
      methodFamily: 'catalog',
      auth: 'anonymous',
      aborted: false,
    }),
    McpCompatUnclassifiedExecutionError,
  );
  observer.observeExecution('ok');
  const ok = observer.toFinish({
    methodFamily: 'catalog',
    auth: 'anonymous',
    aborted: false,
  });
  assert.equal(ok.outcome, 'ok');
  assert.equal(ok.protocolRevision, '2025-11-25');
});

test('hijacked body classifier uses only JSON-RPC enums', () => {
  assert.equal(classifyMcpCompatHijackedBody(''), 'empty');
  assert.equal(classifyMcpCompatHijackedBody(JSON.stringify({
    jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' },
  })), 'result_ok');
  assert.equal(classifyMcpCompatHijackedBody(JSON.stringify({
    jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'denied' }] },
  })), 'result_is_error');
  assert.equal(classifyMcpCompatHijackedBody(JSON.stringify({
    jsonrpc: '2.0', id: 1, error: { code: -32_601, message: 'Method not found' },
  })), 'jsonrpc_error');
  assert.equal(classifyMcpCompatHijackedBody(JSON.stringify({
    jsonrpc: '2.0', id: 1, error: { code: -32_603, message: 'Internal error' },
  })), 'jsonrpc_internal_error');
  assert.equal(classifyMcpCompatHijackedBody('not-json'), 'unparseable');
});

test('dependency_error from the adapter is not overwritten by a later isError body', () => {
  const observer = createMcpCompatExecutionObserver();
  observer.observeExecution('dependency_error');
  observer.observeHijacked({ statusCode: 200, rpc: 'result_is_error' });
  const finish = observer.toFinish({
    methodFamily: 'write_plan',
    auth: 'bearer',
    aborted: false,
  });
  assert.equal(finish.outcome, 'dependency_error');
  assert.equal(finish.protocolRevision, '2025-11-25');
});

test('HTTP 400 protocol-version reject is rejected+unsupported, never ok or 11-25', async () => {
  const server = startPing();
  const missingBefore = snapshot(server.metrics);
  const missing = await injectCompatLegacyPost(server.app, mcpCompatResourcesListBody(12));
  assert.equal(missing.statusCode, 400);
  assertCountedOnce(server.metrics, missingBefore, { outcome: 'rejected', revision: 'unsupported' });
  assert.equal(server.metrics.get('mcp.compat.reject.unsupported'), 1);
  assert.equal(server.metrics.get('mcp.compat.requests.outcome.ok'), 0);
  assert.equal(server.metrics.get('mcp.compat.requests.revision.2025_11_25'), 0);

  const wrongBefore = snapshot(server.metrics);
  const wrong = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializedBody(),
    '2025-06-18',
  );
  assert.equal(wrong.statusCode, 400);
  assertCountedOnce(server.metrics, wrongBefore, { outcome: 'rejected', revision: 'unsupported' });
  assert.equal(server.metrics.get('mcp.compat.requests.outcome.ok'), 0);
  assert.equal(server.metrics.get('mcp.compat.requests.revision.2025_11_25'), 0);
});

test('HTTP 200 JSON-RPC error is not outcome.ok', async () => {
  const server = startPing();
  const before = snapshot(server.metrics);
  const response = await injectCompatLegacyPost(
    server.app,
    { jsonrpc: '2.0', id: 80, method: 'logging/setLevel', params: {} },
    COMPAT_REVISION,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(compatJsonRpc(response).error?.code, -32_601);
  assertCountedOnce(server.metrics, before, { outcome: 'rejected', revision: '2025_11_25' });
  assert.equal(server.metrics.get('mcp.compat.requests.outcome.ok'), 0);
});

test('unknown tool CallToolResult isError is rejected, not ok or dependency_error', async () => {
  const server = startPing();
  const before = snapshot(server.metrics);
  const response = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('not.a.tool', 5),
    COMPAT_REVISION,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(compatJsonRpc(response).result?.isError, true);
  assertCountedOnce(server.metrics, before, { outcome: 'rejected', revision: '2025_11_25' });
  assert.equal(server.metrics.get('mcp.compat.requests.outcome.ok'), 0);
  assert.equal(server.metrics.get('mcp.compat.requests.outcome.dependency_error'), 0);
});

test('business rejected nodes.create isError is rejected, not ok or dependency_error', async () => {
  const denied = new Phase4bMcpLowRiskNodeCreateError('policy_denied', 'Write policy rejected this request.');
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({
    writeFixture: createInMemoryWriteToolFixture({ nodeCreateThrow: () => denied }),
    verifier: auth.verifier,
  }));
  const before = snapshot(server.metrics);
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('nodes.create', 200, nodeCreateArguments()),
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(called.statusCode, 200);
  assert.equal(compatJsonRpc(called).error, undefined);
  assert.equal(compatJsonRpc(called).result?.isError, true);
  assertCountedOnce(server.metrics, before, { outcome: 'rejected', revision: '2025_11_25' });
  assert.equal(server.metrics.get('mcp.compat.requests.outcome.ok'), 0);
  assert.equal(server.metrics.get('mcp.compat.requests.outcome.dependency_error'), 0);
  assert.doesNotMatch(JSON.stringify(server.metricNames), /policy_denied|Bearer /u);
});

test('facade/write adapter dependency throw is dependency_error, not ok', async () => {
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({
    writeFixture: createInMemoryWriteToolFixture({
      nodeCreateThrow: () => new Error('relation "nodes" does not exist'),
    }),
    verifier: auth.verifier,
  }));
  const writeBefore = snapshot(server.metrics);
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('nodes.create', 201, nodeCreateArguments()),
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(called.statusCode, 200);
  assert.equal(compatJsonRpc(called).result?.isError, true);
  assertCountedOnce(server.metrics, writeBefore, { outcome: 'dependency_error', revision: '2025_11_25' });
  assert.equal(server.metrics.get('mcp.compat.requests.outcome.ok'), 0);

  const base = pingMcpApplicationFacade();
  const facade: McpApplicationFacade = Object.freeze({
    ...base,
    async listResources() {
      throw new Error('relation "resource_visibility" does not exist');
    },
  });
  const readServer = track(startCompatApp({ mcpReadTransport: { applicationFacade: facade } }));
  const readBefore = snapshot(readServer.metrics);
  const listed = await injectCompatLegacyPost(
    readServer.app,
    mcpCompatResourcesListBody(5),
    COMPAT_REVISION,
  );
  assert.ok(listed.statusCode === 200 || listed.statusCode >= 400);
  assertCountedOnce(readServer.metrics, readBefore, { outcome: 'dependency_error', revision: '2025_11_25' });
  assert.equal(readServer.metrics.get('mcp.compat.requests.outcome.ok'), 0);
});

test('successful initialize, tools/list, and low-risk create are ok + 11-25', async () => {
  const ping = startPing();
  const initBefore = snapshot(ping.metrics);
  const initialize = await injectCompatLegacyPost(
    ping.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  assert.equal(initialize.statusCode, 200);
  assert.equal(compatJsonRpc(initialize).result?.protocolVersion, COMPAT_REVISION);
  assertCountedOnce(ping.metrics, initBefore, { outcome: 'ok', revision: '2025_11_25' });

  const listBefore = snapshot(ping.metrics);
  const listed = await injectCompatLegacyPost(ping.app, mcpCompatToolsListBody(2), COMPAT_REVISION);
  assert.equal(listed.statusCode, 200);
  assert.ok(Array.isArray(compatJsonRpc(listed).result?.tools));
  assertCountedOnce(ping.metrics, listBefore, { outcome: 'ok', revision: '2025_11_25' });

  const auth = await signedCompatWriteClient();
  const write = track(startCompatWriteApp({
    writeFixture: createWriteFixture(),
    verifier: auth.verifier,
  }));
  const createBefore = snapshot(write.metrics);
  const created = await injectCompatLegacyPost(
    write.app,
    mcpCompatToolsCallBody('nodes.create', 10, nodeCreateArguments()),
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(created.statusCode, 200);
  assert.equal(compatJsonRpc(created).result?.isError === true, false);
  assertCountedOnce(write.metrics, createBefore, { outcome: 'ok', revision: '2025_11_25' });
});

test('request timeout is cancelled, not ok', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: {
      applicationFacade: pingMcpApplicationFacade(capture, { slow: true }),
      requestTimeoutMs: 40,
    },
  }));
  const before = snapshot(server.metrics);
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('compat.ping', 99),
    COMPAT_REVISION,
  );
  assert.equal(capture.aborted, true);
  assert.ok(called.statusCode === 200 || called.statusCode >= 400);
  assertCountedOnce(server.metrics, before, { outcome: 'cancelled', revision: '2025_11_25' });
  assert.equal(server.metrics.get('mcp.compat.requests.outcome.ok'), 0);
});

test('modern-era 07-28 envelope stays unsupported and does not count as 11-25 ok', async () => {
  const server = startPing();
  const before = snapshot(server.metrics);
  const response = await injectCompatPost(server.app, JSON.parse(modernBody('tools/list', 7)) as unknown);
  assert.equal(response.statusCode, MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS);
  assertCountedOnce(server.metrics, before, { outcome: 'rejected', revision: 'unsupported' });
  assert.equal(server.metrics.get('mcp.compat.requests.era.modern'), 1);
  assert.equal(server.metrics.get('mcp.compat.requests.outcome.ok'), 0);
  assert.equal(server.metrics.get('mcp.compat.requests.revision.2025_11_25'), 0);
});

test('compat metric names stay on the frozen allowlist', async () => {
  const server = startPing();
  await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  await injectCompatLegacyPost(server.app, mcpCompatResourcesListBody(12));
  for (const name of server.metricNames) {
    if (!name.startsWith('mcp.compat.')) continue;
    assert.equal(ALLOWLIST.has(name), true, name);
  }
});
