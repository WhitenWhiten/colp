import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  MCP_COMPAT_PROTOCOL_VERSIONS,
  MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS,
  MCP_COMPAT_UNSUPPORTED_PROTOCOL_RPC_CODE,
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
} from '../../../src/modules/mcp/index.js';
import {
  assertCompatNegotiatedVersionHeader,
  assertCompatProtocolVersionRejected,
  compatJsonRpc,
  createCompatPingCapture,
  injectCompatLegacyPost,
  injectCompatPost,
  injectStrictPost,
  pingMcpApplicationFacade,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import { modernBody } from '../../support/phase4b-mcp-transport-scaffold.js';
import { CODEX_CLIENT } from '../../support/phase4b-mcp-compat-matrix-harness.js';
import {
  mcpCompatInitializeBody,
  mcpCompatInitializedBody,
  mcpCompatResourcesListBody,
  mcpCompatResourcesReadBody,
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
} from '../../support/phase4b-mcp-compat-spike.js';

const COMPAT_REVISION = MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION;
const REJECTED_OPERATIONAL_VERSIONS = [
  '2025-06-18',
  '2026-07-28',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
  '1999-01-01',
] as const;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
}

function startPingApp() {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  }));
  return { server, capture };
}

function assertNoSessionId(headers: Record<string, unknown>): void {
  assert.equal(headers['mcp-session-id'], undefined);
}

function assertInitializeSelected(response: {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly payload: string;
}): ReturnType<typeof compatJsonRpc> {
  assert.equal(response.statusCode, 200);
  assertCompatNegotiatedVersionHeader(response.headers);
  assertNoSessionId(response.headers);
  const rpc = compatJsonRpc(response);
  assert.equal(rpc.result?.protocolVersion, COMPAT_REVISION);
  assert.notEqual(rpc.result?.protocolVersion, '2025-06-18');
  assert.doesNotMatch(response.payload, /"protocolVersion"\s*:\s*"2025-06-18"/u);
  return rpc;
}

test('initialize offer 2025-11-25 returns that revision in the body and MCP-Protocol-Version header', async () => {
  const { server } = startPingApp();
  const response = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  const rpc = assertInitializeSelected(response);
  const capabilities = rpc.result?.capabilities as {
    readonly tools?: { readonly listChanged?: boolean };
    readonly resources?: { readonly listChanged?: boolean; readonly subscribe?: boolean };
    readonly prompts?: unknown;
    readonly logging?: unknown;
  } | undefined;
  assert.notEqual(capabilities?.tools?.listChanged, true);
  assert.notEqual(capabilities?.resources?.listChanged, true);
  assert.notEqual(capabilities?.resources?.subscribe, true);
  assert.equal(capabilities?.prompts, undefined);
  assert.equal(capabilities?.logging, undefined);
  assert.deepEqual(MCP_COMPAT_PROTOCOL_VERSIONS, [COMPAT_REVISION]);
});

test('initialized and tools/list succeed with the 2025-11-25 operational header after initialize', async () => {
  const { server, capture } = startPingApp();
  const initialize = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  assertInitializeSelected(initialize);

  const initialized = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializedBody(),
    COMPAT_REVISION,
  );
  assert.ok(initialized.statusCode === 202 || initialized.statusCode === 200);
  assertCompatNegotiatedVersionHeader(initialized.headers);

  const listed = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsListBody(2),
    COMPAT_REVISION,
  );
  assert.equal(listed.statusCode, 200);
  assertCompatNegotiatedVersionHeader(listed.headers);
  assertNoSessionId(listed.headers);
  const tools = compatJsonRpc(listed).result?.tools as readonly { readonly name: string }[] | undefined;
  assert.ok(Array.isArray(tools));
  assert.ok(tools.some((tool) => tool.name === 'compat.ping'));
  assert.ok(capture.listCalls >= 1);
  assert.equal(capture.callCalls, 0);
});

test('Codex-shaped initialize offer 2025-06-18 is selected as 2025-11-25; later calls use that header', async () => {
  const { server } = startPingApp();
  const initialize = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody('2025-06-18', CODEX_CLIENT),
  );
  assertInitializeSelected(initialize);
  assert.notEqual(initialize.headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(server.metrics.get('mcp.compat.client.codex'), 1);
  assert.equal(server.metrics.get('mcp.compat.client.unknown'), 0);
  assert.equal(server.metricNames.includes('mcp.compat.client.codex_cli'), false);

  const initialized = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializedBody(),
    COMPAT_REVISION,
  );
  assert.ok(initialized.statusCode === 202 || initialized.statusCode === 200);
  assertCompatNegotiatedVersionHeader(initialized.headers);

  const listed = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsListBody(2),
    COMPAT_REVISION,
  );
  assert.equal(listed.statusCode, 200);
  assertCompatNegotiatedVersionHeader(listed.headers);
  const tools = compatJsonRpc(listed).result?.tools as readonly { readonly name: string }[] | undefined;
  assert.ok(Array.isArray(tools));
  assert.ok(tools.some((tool) => tool.name === 'compat.ping'));
});

test('operational MCP-Protocol-Version for 06-18, earlier revisions, and unknown must not run tools or resources', async () => {
  for (const version of REJECTED_OPERATIONAL_VERSIONS) {
    const capture = createCompatPingCapture();
    const server = track(startCompatApp({
      mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
    }));
    const listed = await injectCompatLegacyPost(server.app, mcpCompatToolsListBody(10), version);
    assertCompatProtocolVersionRejected(listed, server, capture);
    assert.notEqual(listed.headers['mcp-protocol-version'], version);

    const called = await injectCompatLegacyPost(server.app, mcpCompatToolsCallBody('compat.ping', 11), version);
    assertCompatProtocolVersionRejected(called, server, capture);

    const read = await injectCompatLegacyPost(server.app, mcpCompatResourcesReadBody('compat://ping', 12), version);
    assertCompatProtocolVersionRejected(read, server, capture);
  }
});

test('operational requests without MCP-Protocol-Version never create an SDK server or call the facade', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  }));
  for (const body of [
    mcpCompatToolsListBody(20),
    mcpCompatToolsCallBody('compat.ping', 21),
    mcpCompatResourcesListBody(22),
    mcpCompatResourcesReadBody('compat://ping', 23),
    mcpCompatInitializedBody(),
  ]) {
    server.admissions.splice(0);
    server.sdkFactoryCalls.count = 0;
    capture.listCalls = 0;
    capture.callCalls = 0;
    capture.resourceLists = 0;
    capture.resourceReads = 0;
    const rejected = await injectCompatLegacyPost(server.app, body);
    assertCompatProtocolVersionRejected(rejected, server, capture);
  }
});

test('initialize with a wrong MCP-Protocol-Version is 400 and does not create an SDK server', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  }));
  const rejected = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
    '2025-06-18',
  );
  assertCompatProtocolVersionRejected(rejected, server, capture);
  assert.equal(server.sdkFactoryCalls.count, 0);
});

test('07-28 envelope on compat is unsupported and does not dispatch as legacy tools/list', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  }));
  const response = await injectCompatPost(server.app, JSON.parse(modernBody('tools/list', 7)) as unknown);
  assert.equal(response.statusCode, MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS);
  const rpc = compatJsonRpc(response);
  assert.equal(rpc.error?.code, MCP_COMPAT_UNSUPPORTED_PROTOCOL_RPC_CODE);
  assert.match(rpc.error?.message ?? '', /\/collections\/-\/mcp/u);
  assert.doesNotMatch(rpc.error?.message ?? '', /codex|claude/iu);
  assert.equal(capture.listCalls, 0);
  assert.equal(capture.callCalls, 0);
  const tools = rpc.result?.tools;
  assert.equal(tools, undefined);
});

test('initialize on the strict endpoint stays rejected', async () => {
  const server = track(startCompatApp());
  const response = await injectStrictPost(server.app, 'initialize', 60, {
    'mcp-method': 'initialize',
  }, JSON.stringify({
    jsonrpc: '2.0',
    id: 60,
    method: 'initialize',
    params: { protocolVersion: COMPAT_REVISION, capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
  }));
  assert.equal(response.statusCode, 400);
  assert.equal(compatJsonRpc(response).error?.code, -32_022);
  assert.notEqual(response.statusCode, 200);
});

test('initialize does not emit Mcp-Session-Id; a forged session header does not change identity', async () => {
  const { server } = startPingApp();
  const initialize = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
    undefined,
    { 'mcp-session-id': 'forged-session' },
  );
  assertInitializeSelected(initialize);

  const listed = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsListBody(2),
    COMPAT_REVISION,
    { 'mcp-session-id': 'forged-session' },
  );
  assert.equal(listed.statusCode, 200);
  assertNoSessionId(listed.headers);
  const tools = compatJsonRpc(listed).result?.tools as readonly { readonly name: string }[] | undefined;
  assert.ok(Array.isArray(tools));
  assert.ok(tools.some((tool) => tool.name === 'compat.ping'));
});

test('tools/call ping succeeds through the shared facade after initialize', async () => {
  const { server, capture } = startPingApp();
  await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('compat.ping', 3),
    COMPAT_REVISION,
  );
  assert.equal(called.statusCode, 200);
  assertCompatNegotiatedVersionHeader(called.headers);
  assert.equal(compatJsonRpc(called).error, undefined);
  assert.equal(capture.callCalls, 1);
  assert.match(called.payload, /pong/u);
});

test('Claude sequence on the production path: initialize, initialized, GET 405, tools/list', async () => {
  const { server } = startPingApp();
  const initialize = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  assertInitializeSelected(initialize);
  const initialized = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializedBody(),
    COMPAT_REVISION,
  );
  assert.ok(initialized.statusCode === 202 || initialized.statusCode === 200);
  const get = await server.app.inject({
    method: 'GET',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: { accept: 'text/event-stream, application/json' },
  });
  assert.equal(get.statusCode, 405);
  assert.match(String(get.headers['content-type'] ?? ''), /^text\/plain\b/u);
  assert.doesNotMatch(get.payload, /jsonrpc/u);
  const listed = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsListBody(2),
    COMPAT_REVISION,
  );
  assert.equal(listed.statusCode, 200);
  assertCompatNegotiatedVersionHeader(listed.headers);
  assert.equal(PHASE4B_MCP_CONFIG_ENDPOINT_PATH, '/collections/-/mcp');
});
