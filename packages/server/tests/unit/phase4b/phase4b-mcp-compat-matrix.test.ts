/**
 * T-08 fixed-client protocol matrix on the production `/collections/-/mcp-compat`
 * route. Speaks raw JSON-RPC; does not use `@modelcontextprotocol/client`.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  MCP_COMPAT_PROTOCOL_VERSIONS,
  MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS,
  MCP_COMPAT_UNSUPPORTED_PROTOCOL_RPC_CODE,
  PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH,
  type McpWellKnownDiscoveryDocument,
} from '../../../src/modules/mcp/index.js';
import { modernBody } from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  createCompatPingCapture,
  injectCompatPost,
  pingMcpApplicationFacade,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import {
  CLAUDE_CLIENT,
  CODEX_CLIENT,
  COMPAT_MATRIX_PATH,
  COMPAT_MATRIX_REVISION,
  FIXED_0618_CLIENT,
  STRICT_MATRIX_PATH,
  assertInitializeSelected1125,
  assertNegotiated1125,
  assertNoSessionId,
  assertOperationalRejected,
  assertPlain405,
  createFixedCompatClient,
} from '../../support/phase4b-mcp-compat-matrix-harness.js';

const OLDER_OFFERS = ['2025-03-26', '2024-11-05', '2024-10-07', '1999-01-01'] as const;
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function startMatrixApp() {
  const capture = createCompatPingCapture();
  const server = startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  });
  apps.push(server.app);
  return { server, capture, client: createFixedCompatClient(server.app) };
}

test('direct 2025-11-25 initialize then initialized, tools/list, and read stay 2025-11-25', async () => {
  const { capture, client } = startMatrixApp();
  const initialize = await client.initialize(COMPAT_MATRIX_REVISION, CLAUDE_CLIENT);
  assert.equal(initialize.request.body && typeof initialize.request.body === 'object'
    && (initialize.request.body as { method?: string }).method, 'initialize');
  assertInitializeSelected1125(initialize);
  assert.deepEqual(MCP_COMPAT_PROTOCOL_VERSIONS, [COMPAT_MATRIX_REVISION]);

  const initialized = await client.initialized();
  assert.equal((initialized.request.body as { method?: string }).method, 'notifications/initialized');
  assertNegotiated1125(initialized, [200, 202]);
  assert.equal(initialized.request.headers['mcp-protocol-version'], COMPAT_MATRIX_REVISION);

  const listed = await client.toolsList();
  assertNegotiated1125(listed);
  assert.equal(listed.request.headers['mcp-protocol-version'], COMPAT_MATRIX_REVISION);
  const tools = listed.rpc.result?.tools as readonly { readonly name: string }[] | undefined;
  assert.ok(tools?.some((tool) => tool.name === 'compat.ping'));
  assert.ok(capture.listCalls >= 1);

  const read = await client.resourcesRead('compat://ping');
  assertNegotiated1125(read);
  assert.equal(read.request.headers['mcp-protocol-version'], COMPAT_MATRIX_REVISION);
  assert.ok(capture.resourceReads >= 1);
  assert.doesNotMatch(read.payload, /"protocolVersion"\s*:\s*"2025-06-18"/u);
});

test('Codex-shaped initialize offer 2025-06-18 is selected as 2025-11-25; operational 11-25 and discovery stay singleton', async () => {
  const { capture, client, server } = startMatrixApp();
  const initialize = await client.initialize('2025-06-18', CODEX_CLIENT);
  assert.equal(
    (initialize.request.body as { params?: { protocolVersion?: string } }).params?.protocolVersion,
    '2025-06-18',
  );
  assertInitializeSelected1125(initialize);
  assert.notEqual(initialize.headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(server.metrics.get('mcp.compat.client.codex'), 1);
  assert.equal(server.metrics.get('mcp.compat.client.unknown'), 0);
  assert.equal(server.metricNames.includes('mcp.compat.client.codex_cli'), false);

  const initialized = await client.initialized();
  assertNegotiated1125(initialized, [200, 202]);
  const listed = await client.toolsList();
  assertNegotiated1125(listed);
  assert.ok((listed.rpc.result?.tools as readonly { name: string }[]).some((tool) => tool.name === 'compat.ping'));
  const read = await client.resourcesRead('compat://ping');
  assertNegotiated1125(read);
  assert.ok(capture.resourceReads >= 1);

  const discovery = await server.app.inject({ method: 'GET', url: PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH });
  assert.equal(discovery.statusCode, 200);
  const body = discovery.json<McpWellKnownDiscoveryDocument>();
  assert.deepEqual(body.endpoints?.compatibility.supportedProtocolVersions, ['2025-11-25']);
  assert.equal(
    (body.endpoints?.compatibility.supportedProtocolVersions as readonly string[]).includes('2025-06-18'),
    false,
  );
  assert.deepEqual(server.config.mcp?.compat?.supportedProtocolVersions, MCP_COMPAT_PROTOCOL_VERSIONS);
});

test('fixed 2025-06-18 client would disconnect after 11-25; wrongly continuing with 06-18 operational header fails tools/read', async () => {
  const { capture, client } = startMatrixApp();
  const initialize = await client.initialize('2025-06-18', FIXED_0618_CLIENT);
  assertInitializeSelected1125(initialize);
  assert.notEqual(initialize.rpc.result?.protocolVersion, '2025-06-18');
  const listsAfterInit = capture.listCalls;
  const readsAfterInit = capture.resourceReads;

  const listed = await client.toolsList('2025-06-18');
  assertOperationalRejected(listed, '2025-06-18');
  assert.equal(capture.listCalls, listsAfterInit);

  const read = await client.resourcesRead('compat://ping', '2025-06-18');
  assertOperationalRejected(read, '2025-06-18');
  assert.equal(capture.resourceReads, readsAfterInit);
  assert.equal(capture.callCalls, 0);
});

test('initialize offers 2025-03-26 / 2024-11-05 / 2024-10-07 / unknown never negotiate those versions; old operational headers cannot call tools/read', async () => {
  for (const offer of OLDER_OFFERS) {
    const { capture, client } = startMatrixApp();
    const initialize = await client.initialize(offer, { name: 'probe', version: '0' });
    assert.notEqual(initialize.rpc.result?.protocolVersion, offer);
    assert.doesNotMatch(initialize.payload, new RegExp(`"protocolVersion"\\s*:\\s*"${offer}"`, 'u'));
    if (initialize.statusCode === 200) {
      assertInitializeSelected1125(initialize);
    } else {
      assert.ok(initialize.statusCode >= 400);
      assert.notEqual(initialize.headers['mcp-protocol-version'], offer);
    }
    const listsAfterInit = capture.listCalls;
    const readsAfterInit = capture.resourceReads;

    const listed = await client.toolsList(offer);
    assertOperationalRejected(listed, offer);
    const read = await client.resourcesRead('compat://ping', offer);
    assertOperationalRejected(read, offer);
    assert.equal(capture.listCalls, listsAfterInit, `listTools must not run for operational ${offer}`);
    assert.equal(capture.resourceReads, readsAfterInit, `resources/read must not run for operational ${offer}`);
    assert.equal(capture.callCalls, 0, `tools/call must not run for operational ${offer}`);
  }
});

test('07-28 modern envelope on compat is rejected and not dispatched as legacy', async () => {
  const capture = createCompatPingCapture();
  const server = startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  });
  apps.push(server.app);
  const response = await injectCompatPost(server.app, JSON.parse(modernBody('tools/list', 7)) as unknown);
  assert.equal(response.statusCode, MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS);
  const rpc = JSON.parse(response.payload) as { error?: { code: number; message: string } };
  assert.equal(rpc.error?.code, MCP_COMPAT_UNSUPPORTED_PROTOCOL_RPC_CODE);
  assert.match(rpc.error?.message ?? '', /\/collections\/-\/mcp/u);
  assert.doesNotMatch(rpc.error?.message ?? '', /codex|claude/iu);
  assert.equal(capture.listCalls, 0);
  assert.equal(COMPAT_MATRIX_PATH, '/collections/-/mcp-compat');
});

test('initialize on strict /collections/-/mcp stays unsupported', async () => {
  const { client } = startMatrixApp();
  const response = await client.injectStrict('initialize', 60, {
    'mcp-method': 'initialize',
  }, JSON.stringify({
    jsonrpc: '2.0',
    id: 60,
    method: 'initialize',
    params: {
      protocolVersion: COMPAT_MATRIX_REVISION,
      capabilities: {},
      clientInfo: CLAUDE_CLIENT,
    },
  }));
  assert.equal(response.statusCode, 400);
  const payload = JSON.parse(response.payload) as { error?: { code: number } };
  assert.equal(payload.error?.code, -32_022);
  assert.equal(STRICT_MATRIX_PATH, '/collections/-/mcp');
});

test('compat GET and DELETE are 405 text/plain Method not allowed. with Allow POST and no JSON-RPC', async () => {
  const { client } = startMatrixApp();
  assertPlain405(await client.get());
  const del = await client.delete();
  assertPlain405(del);
  assert.notEqual(del.statusCode, 400);
});

test('initialize does not emit Mcp-Session-Id; a forged session header does not create session identity', async () => {
  const { client } = startMatrixApp();
  const initialize = await client.initialize(COMPAT_MATRIX_REVISION, CLAUDE_CLIENT, {
    'mcp-session-id': 'forged-session',
  });
  assertInitializeSelected1125(initialize);
  assertNoSessionId(initialize.headers);

  const listed = await client.toolsList(COMPAT_MATRIX_REVISION, { 'mcp-session-id': 'forged-session' });
  assertNegotiated1125(listed);
  assertNoSessionId(listed.headers);
  const tools = listed.rpc.result?.tools as readonly { readonly name: string }[] | undefined;
  assert.ok(tools?.some((tool) => tool.name === 'compat.ping'));
});
