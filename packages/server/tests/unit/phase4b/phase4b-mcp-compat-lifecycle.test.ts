import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, test } from 'vitest';
import { waitForCondition } from '../../support/async-test-helpers.js';
import type { FastifyInstance } from 'fastify';
import {
  MCP_COMPAT_AUTH_TOKEN_SENTINEL,
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_METHOD_NOT_ALLOWED_BODY,
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  MCP_COMPAT_ONERROR_CLASSIFIER,
} from '../../../src/modules/mcp/index.js';
import {
  assertCompatNegotiatedVersionHeader,
  collectTaint,
  compatRpc,
  createCompatPingCapture,
  injectCompatLegacyPost,
  injectCompatPost,
  pingMcpApplicationFacade,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import { MCP_COMPAT_CANARY_BEARER } from '../../support/phase4b-mcp-compat-spike.js';
import { MCP_TEST_REQUEST_HOST } from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  mcpCompatAcceptHeaders,
  mcpCompatInitializeBody,
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
} from '../../support/phase4b-mcp-compat-spike.js';

const COMPAT_REVISION = MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION;
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
}

function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  return waitForCondition(predicate, { timeoutMs: 2_000, description: label });
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
}

test('GET and DELETE stay text/plain 405 without JSON-RPC, including empty JSON DELETE', async () => {
  const server = track(startCompatApp());
  const get = await server.app.inject({
    method: 'GET',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: { accept: 'text/event-stream, application/json' },
  });
  assertPlainMethodNotAllowed(get);
  const del = await server.app.inject({
    method: 'DELETE',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: '',
  });
  assertPlainMethodNotAllowed(del);
  assert.notEqual(del.statusCode, 400);
  assert.equal(server.admissions.length, 0);
});

test('bad content-type, empty, malformed, oversized, and batch bodies are fixed 4xx without crash', async () => {
  const server = track(startCompatApp());
  const wrongType = await server.app.inject({
    method: 'POST',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: { 'content-type': 'text/plain' },
    payload: 'hello',
  });
  assert.equal(wrongType.statusCode, 415);

  const empty = await server.app.inject({
    method: 'POST',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: { 'content-type': 'application/json' },
    payload: '',
  });
  assert.equal(empty.statusCode, 400);

  const malformed = await server.app.inject({
    method: 'POST',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: { 'content-type': 'application/json' },
    payload: '{not-json',
  });
  assert.equal(malformed.statusCode, 400);

  const oversized = track(startCompatApp({ env: { MCP_REQUEST_MAX_BODY_BYTES: '64' } }));
  const tooLarge = await oversized.app.inject({
    method: 'POST',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: { 'content-type': 'application/json' },
    payload: 'x'.repeat(65),
  });
  assert.equal(tooLarge.statusCode, 413);

  const batch = await injectCompatPost(server.app, [
    compatRpc('tools/list', 1),
    compatRpc('tools/list', 2),
  ]);
  assert.equal(batch.statusCode, 400);
  assert.match(batch.payload, /batch/iu);
  assert.ok(batch.statusCode < 500);
});

test('canary token stays absent after SDK dispatch; AuthInfo token is the sentinel', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  }));
  const response = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  assert.equal(response.statusCode, 200);
  assertCompatNegotiatedVersionHeader(response.headers);
  const blob = collectTaint([
    response.payload,
    response.headers,
    server.admissions,
    server.metricNames,
    MCP_COMPAT_ONERROR_CLASSIFIER,
  ]);
  assert.doesNotMatch(blob, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
  for (const admission of server.admissions) {
    assert.equal(admission.authInfo.token, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
  }
});

test('client disconnect aborts an in-flight tools/call', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture, { slow: true }) },
  }));
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const address = server.app.server.address();
  assert.ok(address && typeof address === 'object');
  const aborted = await new Promise<boolean>((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: MCP_COMPAT_ENDPOINT_PATH,
      method: 'POST',
      headers: {
        ...mcpCompatAcceptHeaders(COMPAT_REVISION),
        'content-type': 'application/json',
        host: MCP_TEST_REQUEST_HOST,
      },
    }, () => {
      reject(new Error('slow tool returned before the client disconnected'));
    });
    request.on('error', () => {
      resolve(true);
    });
    request.write(JSON.stringify(mcpCompatToolsCallBody('compat.ping', 99)));
    request.end();
    request.on('socket', (socket) => {
      socket.once('connect', () => {
        setTimeout(() => {
          request.destroy();
        }, 40);
      });
    });
  });
  assert.equal(aborted, true);
  await waitUntil(() => capture.aborted, 'abort');
  assert.equal(capture.aborted, true);
});

test('Fastify close stops new admission, drains hijacked in-flight, and leaves no session map', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture, { slow: true }) },
  }));
  const finished = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  assert.equal(finished.statusCode, 200);
  assert.equal(finished.headers['mcp-session-id'], undefined);

  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const address = server.app.server.address();
  assert.ok(address && typeof address === 'object');
  const inFlight = http.request({
    hostname: '127.0.0.1',
    port: address.port,
    path: MCP_COMPAT_ENDPOINT_PATH,
    method: 'POST',
    headers: {
      ...mcpCompatAcceptHeaders(COMPAT_REVISION),
      'content-type': 'application/json',
      host: MCP_TEST_REQUEST_HOST,
    },
  });
  inFlight.write(JSON.stringify(mcpCompatToolsCallBody('compat.ping', 99)));
  inFlight.end();
  inFlight.on('error', () => undefined);
  await waitUntil(() => capture.slowStarted, 'slow tool start');

  const closed = server.app.close();
  await closed;
  await waitUntil(() => capture.aborted, 'shutdown abort');
  assert.equal(capture.aborted, true);
  assert.equal(finished.headers['mcp-session-id'], undefined);

  await new Promise<void>((resolve, reject) => {
    const retry = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: MCP_COMPAT_ENDPOINT_PATH,
      method: 'POST',
      headers: {
        ...mcpCompatAcceptHeaders(),
        host: MCP_TEST_REQUEST_HOST,
      },
    }, (response) => {
      if (response.statusCode === 503) {
        resolve();
        return;
      }
      reject(new Error(`new admission succeeded after close: ${String(response.statusCode)}`));
    });
    retry.on('error', () => resolve());
    retry.end();
  });
});

test('admission still runs before SDK: Origin reject never lists tools', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  }));
  const rejected = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsListBody(2),
    COMPAT_REVISION,
    { origin: 'https://attacker.example.test' },
  );
  assert.equal(rejected.statusCode, 403);
  assert.equal(server.admissions.length, 0);
  assert.equal(capture.listCalls, 0);
});
