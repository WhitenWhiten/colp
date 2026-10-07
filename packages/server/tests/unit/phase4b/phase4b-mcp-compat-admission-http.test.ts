import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { connect as rawConnect } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_METHOD_NOT_ALLOWED_BODY,
  McpOauthVerificationError,
} from '../../../src/modules/mcp/index.js';
import type { McpOauthVerifier } from '../../../src/modules/mcp/index.js';
import { createMemoryMcpRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import {
  assertCompatNegotiatedVersionHeader,
  assertCompatProtocolVersionRejected,
  collectTaint,
  compatJsonRpc,
  compatRpc,
  createCompatPingCapture,
  injectCompatLegacyPost,
  injectCompatPost,
  injectStrictPost,
  pingMcpApplicationFacade,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import { MCP_TEST_REQUEST_HOST } from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  MCP_COMPAT_CANARY_BEARER,
  mcpCompatInitializeBody,
  mcpCompatInitializedBody,
  mcpCompatToolsListBody,
} from '../../support/phase4b-mcp-compat-spike.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
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

test('flag off still omits the compat route', async () => {
  const server = track(startCompatApp({ compatEnabled: false }));
  const post = await injectCompatPost(server.app, compatRpc('tools/list'));
  assert.equal(post.statusCode, 404);
});

test('GET and DELETE stay at the method gate: 405 text/plain without OAuth', async () => {
  let verifyCalls = 0;
  const oauthVerifier: McpOauthVerifier = {
    async verify() {
      verifyCalls += 1;
      throw new Error('oauth must not run for GET/DELETE');
    },
  };
  const server = track(startCompatApp({ mcpReadTransport: { oauthVerifier } }));
  const get = await server.app.inject({
    method: 'GET',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: {
      accept: 'text/event-stream, application/json',
      authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}`,
    },
  });
  assertPlainMethodNotAllowed(get);
  const del = await server.app.inject({
    method: 'DELETE',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}`,
    },
    payload: '',
  });
  assertPlainMethodNotAllowed(del);
  assert.notEqual(del.statusCode, 400);
  assert.equal(verifyCalls, 0);
  assert.equal(server.admissions.length, 0);
});

test('anonymous public-read methods succeed admission then complete initialize/initialized/tools/list', async () => {
  const server = track(startCompatApp());
  const initialize = await injectCompatPost(
    server.app,
    mcpCompatInitializeBody('2025-11-25', { name: 'probe', version: '0' }),
  );
  assert.equal(initialize.statusCode, 200);
  assertCompatNegotiatedVersionHeader(initialize.headers);
  assert.equal(compatJsonRpc(initialize).result?.protocolVersion, '2025-11-25');

  const initialized = await injectCompatPost(server.app, mcpCompatInitializedBody());
  assert.ok(initialized.statusCode === 202 || initialized.statusCode === 200);

  const listed = await injectCompatPost(server.app, mcpCompatToolsListBody(2));
  assert.equal(listed.statusCode, 200);
  assertCompatNegotiatedVersionHeader(listed.headers);
  assert.ok(Array.isArray(compatJsonRpc(listed).result?.tools));
  assert.ok(server.admissions.length >= 1);
  assert.equal(server.admissions.at(-1)?.applicationContext.principal.kind, 'anonymous');
});

test('anonymous resources/read is eligible at admission (public read) and is not a 501 stub', async () => {
  const server = track(startCompatApp());
  const response = await injectCompatPost(
    server.app,
    compatRpc('resources/read', 2, { uri: 'colp://example/collections/public' }),
  );
  assert.notEqual(response.statusCode, 501);
  assert.ok(response.statusCode < 500);
  assert.equal(server.admissions.at(-1)?.applicationContext.principal.kind, 'anonymous');
});

test('invalid bearer on a method that would 401 on strict matches the RFC 6750 challenge', async () => {
  const oauthVerifier: McpOauthVerifier = {
    async verify() {
      throw new McpOauthVerificationError('invalid_token');
    },
  };
  const server = track(startCompatApp({ mcpReadTransport: { oauthVerifier } }));
  const headers = { authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}` };
  const compat = await injectCompatPost(server.app, compatRpc('tools/list'), headers);
  const strict = await injectStrictPost(server.app, 'server/discover', 41, headers);
  assert.equal(compat.statusCode, 401);
  assert.equal(strict.statusCode, 401);
  assert.equal(compat.statusCode, strict.statusCode);
  const origin = server.config.mcp!.origin;
  const compatChallenge = String(compat.headers['www-authenticate'] ?? '');
  const strictChallenge = String(strict.headers['www-authenticate'] ?? '');
  assert.equal(
    strictChallenge,
    `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/collections/-/mcp"`,
  );
  assert.equal(
    compatChallenge,
    `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/collections/-/mcp-compat"`,
  );
  assert.notEqual(compatChallenge, strictChallenge);
  assert.doesNotMatch(compatChallenge, /127\.0\.0\.1/u);
  assert.equal(compat.json().error?.code, 'authentication_required');
  assert.equal(compat.json().error?.code, strict.json().error?.code);
  assert.doesNotMatch(compat.payload, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
  assert.doesNotMatch(strict.payload, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
  assert.equal(server.admissions.length, 0);
});

test('Origin allowlist rejects attackers and allows missing Origin like strict', async () => {
  const server = track(startCompatApp());
  const allowed = await injectCompatPost(server.app, compatRpc('tools/list'), {
    origin: 'https://app.example.test',
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://app.example.test');

  const rejected = await injectCompatPost(server.app, compatRpc('tools/list'), {
    origin: 'https://attacker.example.test',
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.headers['access-control-allow-origin'], undefined);
  assert.equal(rejected.json().error?.code, 'csrf_failed');

  const strictRejected = await injectStrictPost(server.app, 'server/discover', 31, {
    origin: 'https://attacker.example.test',
  });
  assert.equal(strictRejected.statusCode, 403);
  assert.equal(strictRejected.json().error?.code, 'csrf_failed');

  const absent = await injectCompatPost(server.app, compatRpc('tools/list'));
  assert.equal(absent.statusCode, 200);
});

test('header and body over-budget use the same 4xx class as strict', async () => {
  const countServer = track(startCompatApp({ env: { MCP_REQUEST_MAX_HEADER_COUNT: '16' } }));
  const extra: Record<string, string> = {};
  for (let index = 0; index < 20; index += 1) extra[`x-mcp-probe-${index}`] = 'value';
  const compatCount = await injectCompatPost(countServer.app, compatRpc('tools/list'), extra);
  const strictCount = await injectStrictPost(countServer.app, 'server/discover', 81, extra);
  assert.equal(compatCount.statusCode, 431);
  assert.equal(strictCount.statusCode, 431);
  assert.deepEqual(compatCount.json(), { error: 'mcp_header_count_exceeded' });

  const longServer = track(startCompatApp({ env: { MCP_REQUEST_MAX_HEADER_VALUE_BYTES: '32' } }));
  const longHeaders = { 'x-mcp-probe-long': 'v'.repeat(64) };
  const compatLong = await injectCompatPost(longServer.app, compatRpc('tools/list'), longHeaders);
  const strictLong = await injectStrictPost(longServer.app, 'server/discover', 82, longHeaders);
  assert.equal(compatLong.statusCode, 431);
  assert.equal(strictLong.statusCode, 431);

  const bodyServer = track(startCompatApp({ env: { MCP_REQUEST_MAX_BODY_BYTES: '64' } }));
  const oversized = 'x'.repeat(65);
  const compatBody = await bodyServer.app.inject({
    method: 'POST',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: { 'content-type': 'application/json' },
    payload: oversized,
  });
  const strictBody = await bodyServer.app.inject({
    method: 'POST',
    url: '/collections/-/mcp',
    headers: { 'content-type': 'application/json' },
    payload: oversized,
  });
  assert.equal(compatBody.statusCode, 413);
  assert.equal(strictBody.statusCode, 413);
});

test('unsupported content-type is 415 on both surfaces', async () => {
  const server = track(startCompatApp());
  const compat = await server.app.inject({
    method: 'POST',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: { 'content-type': 'text/plain' },
    payload: 'hello',
  });
  const strict = await server.app.inject({
    method: 'POST',
    url: '/collections/-/mcp',
    headers: { 'content-type': 'text/plain' },
    payload: 'hello',
  });
  assert.equal(compat.statusCode, 415);
  assert.equal(strict.statusCode, 415);
});

test('admission order: Origin reject never calls OAuth or the rate limiter', async () => {
  const steps: string[] = [];
  const oauthVerifier: McpOauthVerifier = {
    async verify() {
      steps.push('oauth');
      throw new Error('should not verify');
    },
  };
  const inner = createMemoryMcpRateLimiter({
    request: { maxRequests: 8, windowMs: 60_000 },
    now: () => 1_000,
  });
  const requestRateLimiter = {
    consume: async (subject: Parameters<typeof inner.consume>[0]) => {
      steps.push('rate');
      return inner.consume(subject);
    },
    close: () => inner.close(),
    readiness: () => inner.readiness(),
  };
  const server = track(startCompatApp({
    mcpReadTransport: { oauthVerifier, requestRateLimiter },
    mcpRateLimiter: requestRateLimiter,
  }));
  const rejected = await injectCompatPost(server.app, compatRpc('tools/list'), {
    origin: 'https://attacker.example.test',
  });
  assert.equal(rejected.statusCode, 403);
  assert.deepEqual(steps, []);
});

test('compat POST after admission does not echo Authorization or canary', async () => {
  const server = track(startCompatApp());
  const response = await injectCompatPost(server.app, compatRpc('tools/list'), {
    authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}`,
  });
  assert.notEqual(response.statusCode, 501);
  const blob = collectTaint([
    response.json(),
    response.payload,
    response.headers,
    server.admissions,
    server.metricNames,
  ]);
  assert.doesNotMatch(blob, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
});

test('operational MCP-Protocol-Version missing or illegal is JSON-RPC 400 before OAuth and SDK', async () => {
  let verifyCalls = 0;
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: {
      applicationFacade: pingMcpApplicationFacade(capture),
      oauthVerifier: {
        async verify() {
          verifyCalls += 1;
          throw new Error('oauth must not run after version reject');
        },
      },
    },
  }));
  const missing = await injectCompatLegacyPost(server.app, mcpCompatToolsListBody(2));
  assertCompatProtocolVersionRejected(missing, server, capture);
  assert.equal(verifyCalls, 0);

  const illegal = await injectCompatPost(server.app, mcpCompatToolsListBody(3), {
    'mcp-protocol-version': '2025-06-18',
    authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}`,
  });
  assertCompatProtocolVersionRejected(illegal, server, capture);
  assert.equal(verifyCalls, 0);
  assert.doesNotMatch(illegal.payload, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
});

test('raw duplicate MCP-Protocol-Version is 400 JSON-RPC and does not call OAuth', async () => {
  let verifyCalls = 0;
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: {
      applicationFacade: pingMcpApplicationFacade(capture),
      oauthVerifier: {
        async verify() {
          verifyCalls += 1;
          throw new Error('oauth must not run after version reject');
        },
      },
    },
  }));
  await server.app.ready();
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const url = new URL(typeof address === 'string' ? address : `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`);
  const body = JSON.stringify(compatRpc('tools/list'));
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = rawConnect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.end([
        `POST ${MCP_COMPAT_ENDPOINT_PATH} HTTP/1.1`,
        `Host: ${MCP_TEST_REQUEST_HOST}`,
        'Content-Type: application/json',
        'Accept: application/json, text/event-stream',
        'MCP-Protocol-Version: 2025-11-25',
        'MCP-Protocol-Version: 2025-06-18',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'));
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.once('end', () => resolve(data));
  });
  assert.match(raw, /^HTTP\/1\.1 400 /u);
  assert.match(raw, /Unsupported protocol version/u);
  assert.equal(verifyCalls, 0);
  assert.equal(server.admissions.length, 0);
  assert.equal(server.sdkFactoryCalls.count, 0);
  assert.equal(capture.listCalls, 0);
});
