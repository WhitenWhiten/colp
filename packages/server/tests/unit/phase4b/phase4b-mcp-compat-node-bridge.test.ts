import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { isLegacyRequest } from '@modelcontextprotocol/server';
import {
  MCP_COMPAT_AUTH_TOKEN_SENTINEL,
  MCP_COMPAT_METHOD_NOT_ALLOWED_BODY,
  redactMcpCompatOnerror,
} from '../../../src/modules/mcp/index.js';
import {
  MCP_COMPAT_CANARY_BEARER,
  MCP_COMPAT_SPIKE_PATH,
  asMcpCompatJsonRpc,
  createMcpCompatSpikeFastifyApp,
  mcpCompatAcceptHeaders,
  mcpCompatInitializeBody,
  mcpCompatInitializedBody,
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
  type McpCompatSpikeHandle,
} from '../../support/phase4b-mcp-compat-spike.js';

const COMPAT_REVISION = '2025-11-25';
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

async function startSpike(options?: Parameters<typeof createMcpCompatSpikeFastifyApp>[0]): Promise<McpCompatSpikeHandle> {
  const handle = await createMcpCompatSpikeFastifyApp(options);
  apps.push(handle.app);
  return handle;
}

function collectTaint(value: unknown): string {
  return JSON.stringify(value);
}

function assertPlainMethodNotAllowed(response: {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly payload: string;
}): void {
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, 'POST');
  assert.match(String(response.headers['content-type'] ?? ''), /^text\/plain\b/u);
  assert.equal(response.payload, MCP_COMPAT_METHOD_NOT_ALLOWED_BODY);
  assert.doesNotMatch(response.payload, /jsonrpc/u);
  assert.doesNotMatch(response.payload, /"error"/u);
}

test('Claude sequence: initialize, initialized, GET 405 plain text without JSON-RPC, then tools/list', async () => {
  const spike = await startSpike();
  const initialize = await spike.app.inject({
    method: 'POST',
    url: MCP_COMPAT_SPIKE_PATH,
    headers: mcpCompatAcceptHeaders(),
    payload: mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  });
  assert.equal(initialize.statusCode, 200);
  assert.equal(asMcpCompatJsonRpc(spike.parse(initialize)).result?.protocolVersion, COMPAT_REVISION);

  const initialized = await spike.app.inject({
    method: 'POST',
    url: MCP_COMPAT_SPIKE_PATH,
    headers: mcpCompatAcceptHeaders(COMPAT_REVISION),
    payload: mcpCompatInitializedBody(),
  });
  assert.ok(initialized.statusCode === 202 || initialized.statusCode === 200);

  const get = await spike.app.inject({
    method: 'GET',
    url: MCP_COMPAT_SPIKE_PATH,
    headers: mcpCompatAcceptHeaders(COMPAT_REVISION),
  });
  assertPlainMethodNotAllowed(get);

  const del = await spike.app.inject({
    method: 'DELETE',
    url: MCP_COMPAT_SPIKE_PATH,
    headers: mcpCompatAcceptHeaders(COMPAT_REVISION),
  });
  assertPlainMethodNotAllowed(del);

  const listed = await spike.app.inject({
    method: 'POST',
    url: MCP_COMPAT_SPIKE_PATH,
    headers: mcpCompatAcceptHeaders(COMPAT_REVISION),
    payload: mcpCompatToolsListBody(2),
  });
  assert.equal(listed.statusCode, 200);
  const tools = asMcpCompatJsonRpc(spike.parse(listed)).result?.tools as readonly { readonly name: string }[] | undefined;
  assert.ok(Array.isArray(tools));
  assert.ok(tools.some((tool) => tool.name === 'spike.ping'));
});

test('toNodeHandler consumes Fastify parsed body once and hijacks the raw response', async () => {
  const spike = await startSpike();
  const response = await spike.app.inject({
    method: 'POST',
    url: MCP_COMPAT_SPIKE_PATH,
    headers: mcpCompatAcceptHeaders(),
    payload: mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  });
  assert.equal(response.statusCode, 200);
  assert.ok(spike.capture.rawReadableEnded.includes(true), 'Fastify must have consumed the Node stream before the SDK');
  assert.ok(spike.capture.parsedBodyProvided.includes(true), 'toNodeHandler must pass the already-parsed body');
  assert.ok(spike.capture.hijacked.includes(true), 'route must hijack before writing reply.raw');
  const rpc = asMcpCompatJsonRpc(spike.parse(response));
  assert.equal(rpc.result?.protocolVersion, COMPAT_REVISION);
  assert.ok(response.headers['content-type']);
});

test('toWebRequest + isLegacyRequest classifies initialize as legacy and a modern envelope as not legacy', async () => {
  const initialize = await toWebRequest(
    {
      method: 'POST',
      url: MCP_COMPAT_SPIKE_PATH,
      headers: { host: 'spike.test', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {},
    },
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  assert.equal(await isLegacyRequest(initialize, mcpCompatInitializeBody(COMPAT_REVISION, {
    name: 'claude-code',
    version: '2.1.250',
  })), true);

  const modern = await toWebRequest(
    {
      method: 'POST',
      url: '/collections/-/mcp',
      headers: { host: 'spike.test', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {},
    },
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
    },
  );
  assert.equal(await isLegacyRequest(modern, {
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    },
  }), false);
});

test('toNodeHandler onerror only observes a redacted classifier and never the canary token', async () => {
  const spike = await startSpike({ factoryError: `failed for ${MCP_COMPAT_CANARY_BEARER}` });
  const response = await spike.app.inject({
    method: 'POST',
    url: MCP_COMPAT_SPIKE_PATH,
    headers: {
      ...mcpCompatAcceptHeaders(),
      authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}`,
    },
    payload: mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  });
  assert.ok(response.statusCode >= 500);
  assert.ok(spike.capture.onerror.length >= 1);
  for (const error of spike.capture.onerror) {
    assert.doesNotMatch(error.message, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
    assert.equal(error.message, redactMcpCompatOnerror(new Error('factory')).message);
  }
  assert.doesNotMatch(response.payload, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
});

test('canary Authorization token never appears in SDK AuthInfo, logs, metrics, errors, or the response', async () => {
  const spike = await startSpike({ canaryAuthorization: true });
  const response = await spike.app.inject({
    method: 'POST',
    url: MCP_COMPAT_SPIKE_PATH,
    headers: {
      ...mcpCompatAcceptHeaders(),
      authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}`,
    },
    payload: mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(spike.capture.sawCanaryAuthorization, true);
  assert.ok(spike.capture.factoryAuth.length >= 1);
  for (const auth of spike.capture.factoryAuth) {
    assert.equal(auth.token, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
  }
  for (const auth of spike.capture.toolAuth) {
    if (auth !== undefined) assert.equal(auth.token, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
  }
  const blob = [
    collectTaint(spike.capture.factoryAuth),
    collectTaint(spike.capture.toolAuth),
    collectTaint(spike.capture.onerror.map((error) => error.message)),
    collectTaint(spike.capture.logs),
    collectTaint(spike.capture.metrics),
    response.payload,
    JSON.stringify(response.headers),
  ].join('\n');
  assert.doesNotMatch(blob, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
  assert.match(blob, new RegExp(MCP_COMPAT_AUTH_TOKEN_SENTINEL, 'u'));
});

test('client disconnect aborts the in-flight SDK exchange', async () => {
  const spike = await startSpike({ slowTool: true });
  await spike.app.listen({ port: 0, host: '127.0.0.1' });
  const address = spike.app.server.address();
  assert.ok(address && typeof address === 'object');
  const aborted = await new Promise<boolean>((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: MCP_COMPAT_SPIKE_PATH,
      method: 'POST',
      headers: {
        ...mcpCompatAcceptHeaders(COMPAT_REVISION),
        'content-type': 'application/json',
      },
    }, () => {
      reject(new Error('slow tool returned before the client disconnected'));
    });
    request.on('error', () => {
      resolve(true);
    });
    request.write(JSON.stringify(mcpCompatToolsCallBody('spike.slow', 99)));
    request.end();
    request.on('socket', (socket) => {
      socket.once('connect', () => {
        setTimeout(() => {
          request.destroy();
        }, 25);
      });
    });
  });
  assert.equal(aborted, true);
  await spike.waitForAbort();
  assert.equal(spike.capture.aborted, true);
});

test('Fastify close stops admission, ends in-flight stateless exchanges, and leaves no session map', async () => {
  const spike = await startSpike({ slowTool: true });
  const finished = await spike.app.inject({
    method: 'POST',
    url: MCP_COMPAT_SPIKE_PATH,
    headers: mcpCompatAcceptHeaders(),
    payload: mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  });
  assert.equal(finished.statusCode, 200);
  assert.equal(finished.headers['mcp-session-id'], undefined);
  await spike.waitForLiveServers(0);
  assert.equal(spike.capture.liveConnectedCount(), 0);
  assert.deepEqual(spike.capture.sessionIds, []);

  await spike.app.listen({ port: 0, host: '127.0.0.1' });
  const address = spike.app.server.address();
  assert.ok(address && typeof address === 'object');
  const inFlight = http.request({
    hostname: '127.0.0.1',
    port: address.port,
    path: MCP_COMPAT_SPIKE_PATH,
    method: 'POST',
    headers: {
      ...mcpCompatAcceptHeaders(COMPAT_REVISION),
      'content-type': 'application/json',
    },
  });
  inFlight.write(JSON.stringify(mcpCompatToolsCallBody('spike.slow', 99)));
  inFlight.end();
  inFlight.on('error', () => undefined);
  await spike.waitForSlowStart();
  assert.ok(spike.capture.liveConnectedCount() >= 1);

  const closed = spike.app.close();
  const closeWatch = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      spike.app.server.closeAllConnections();
      resolve();
    }, 1_000);
    void closed.then(() => {
      clearTimeout(timer);
      resolve();
    }, reject);
  });
  await closeWatch;
  await closed;
  await spike.waitForAbort();
  await spike.waitForLiveServers(0);
  assert.equal(spike.capture.aborted, true);
  assert.equal(spike.capture.liveConnectedCount(), 0);
  assert.deepEqual(spike.capture.sessionIds, []);

  await new Promise<void>((resolve, reject) => {
    const retry = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: MCP_COMPAT_SPIKE_PATH,
      method: 'POST',
    }, () => {
      reject(new Error('new admission succeeded after close'));
    });
    retry.on('error', () => resolve());
    retry.end();
  });
});

test('toNodeHandler is a function exported by the official Node adapter (not a custom fetch bridge)', () => {
  assert.equal(typeof toNodeHandler, 'function');
  assert.equal(typeof toWebRequest, 'function');
});
