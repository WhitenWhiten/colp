import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { connect as rawConnect } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  MCP_COMPAT_ENDPOINT_PATH,
} from '../../../src/modules/mcp/index.js';
import { createMemoryMcpRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import {
  createCompatPingCapture,
  compatRpc,
  injectCompatPost,
  injectStrictPost,
  pingMcpApplicationFacade,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import {
  MCP_TEST_REQUEST_HOST,
  mcpTestHostHeader,
} from '../../support/phase4b-mcp-transport-scaffold.js';
import { MCP_HOST_INVALID_MESSAGE } from '../../../src/transport/mcp/mcp-shared-admission.js';
import { MCP_COMPAT_CANARY_BEARER } from '../../support/phase4b-mcp-compat-spike.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
}

const SHARED_HOST_CASES = [
  { name: 'exact host', host: MCP_TEST_REQUEST_HOST, ok: true },
  { name: 'hostname case', host: 'COLLECTIONS.EXAMPLE.TEST', ok: true },
  { name: 'explicit default https port', host: `${MCP_TEST_REQUEST_HOST}:443`, ok: true },
  { name: 'non-default port', host: `${MCP_TEST_REQUEST_HOST}:8443`, ok: false },
  { name: 'attacker host', host: 'attacker.example', ok: false },
  { name: 'suffix lookalike', host: `evil.${MCP_TEST_REQUEST_HOST}`, ok: false },
  { name: 'userinfo', host: `user:pass@${MCP_TEST_REQUEST_HOST}`, ok: false },
  { name: 'illegal port', host: `${MCP_TEST_REQUEST_HOST}:99999`, ok: false },
  { name: 'empty port', host: `${MCP_TEST_REQUEST_HOST}:`, ok: false },
  { name: 'empty Host', host: '', ok: false },
  { name: 'slash in Host', host: `${MCP_TEST_REQUEST_HOST}/`, ok: false },
] as const;

function assertHostRejected(response: {
  readonly statusCode: number;
  readonly payload: string;
  readonly json: () => { readonly error?: { readonly code?: string; readonly message?: string } };
}): void {
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error?.code, 'invalid_request');
  assert.equal(response.json().error?.message, MCP_HOST_INVALID_MESSAGE);
  assert.doesNotMatch(response.payload, /attacker\.example|user:pass/u);
}

test('strict and compat share one Host allowlist for exact, case, port, and attacker values', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  }));
  for (const row of SHARED_HOST_CASES) {
    const compat = await injectCompatPost(server.app, compatRpc('tools/list'), { host: row.host });
    const strict = await injectStrictPost(server.app, 'server/discover', 32, { host: row.host });
    if (row.ok) {
      assert.equal(compat.statusCode, 200, `compat ${row.name}`);
      assert.equal(strict.statusCode, 200, `strict ${row.name}`);
    } else {
      assertHostRejected(compat);
      assertHostRejected(strict);
    }
  }
});

test('IPv6 Host matches the configured origin after bracket and default-port normalization', async () => {
  const ipv6Origin = 'https://[2001:db8::1]';
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    env: { PUBLICATION_ORIGIN: ipv6Origin },
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  }));
  assert.equal(mcpTestHostHeader(ipv6Origin), '[2001:db8::1]');
  const accepted = [
    '[2001:db8::1]',
    '[2001:DB8::1]',
    '[2001:db8::1]:443',
  ];
  for (const host of accepted) {
    const compat = await injectCompatPost(server.app, compatRpc('tools/list'), { host });
    const strict = await injectStrictPost(server.app, 'server/discover', 33, { host });
    assert.equal(compat.statusCode, 200, `compat IPv6 ${host}`);
    assert.equal(strict.statusCode, 200, `strict IPv6 ${host}`);
  }
  const rejected = await injectCompatPost(server.app, compatRpc('tools/list'), {
    host: '2001:db8::1',
  });
  const strictRejected = await injectStrictPost(server.app, 'server/discover', 34, {
    host: '[::1]',
  });
  assertHostRejected(rejected);
  assertHostRejected(strictRejected);
});

test('non-default origin port requires that port on Host', async () => {
  const origin = `https://${MCP_TEST_REQUEST_HOST}:8443`;
  const server = track(startCompatApp({ env: { PUBLICATION_ORIGIN: origin } }));
  const allowed = await injectCompatPost(server.app, compatRpc('tools/list'), {
    host: `${MCP_TEST_REQUEST_HOST}:8443`,
  });
  const strictAllowed = await injectStrictPost(server.app, 'server/discover', 35, {
    host: `${MCP_TEST_REQUEST_HOST}:8443`,
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(strictAllowed.statusCode, 200);
  const omitted = await injectCompatPost(server.app, compatRpc('tools/list'), {
    host: MCP_TEST_REQUEST_HOST,
  });
  const defaultPort = await injectStrictPost(server.app, 'server/discover', 36, {
    host: `${MCP_TEST_REQUEST_HOST}:443`,
  });
  assertHostRejected(omitted);
  assertHostRejected(defaultPort);
});

test('X-Forwarded-Host cannot override an invalid Host on strict or compat', async () => {
  let verifyCalls = 0;
  const inner = createMemoryMcpRateLimiter({
    request: { maxRequests: 8, windowMs: 60_000 },
    now: () => 1_000,
  });
  let rateCalls = 0;
  const requestRateLimiter = {
    consume: async (subject: Parameters<typeof inner.consume>[0]) => {
      rateCalls += 1;
      return inner.consume(subject);
    },
    close: () => inner.close(),
    readiness: () => inner.readiness(),
  };
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: {
      applicationFacade: pingMcpApplicationFacade(capture),
      oauthVerifier: {
        async verify() {
          verifyCalls += 1;
          throw new Error('oauth must not run after Host reject');
        },
      },
      requestRateLimiter,
    },
    mcpRateLimiter: requestRateLimiter,
  }));
  const headers = {
    host: 'attacker.example',
    'x-forwarded-host': MCP_TEST_REQUEST_HOST,
    authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}`,
  };
  const compat = await injectCompatPost(server.app, compatRpc('tools/list'), headers);
  const strict = await injectStrictPost(server.app, 'server/discover', 37, headers);
  assertHostRejected(compat);
  assertHostRejected(strict);
  assert.equal(verifyCalls, 0);
  assert.equal(rateCalls, 0);
  assert.equal(server.admissions.length, 0);
  assert.equal(server.sdkFactoryCalls.count, 0);
  assert.equal(capture.listCalls, 0);
});

test('Host reject is before OAuth, rate limit, SDK factory, and facade', async () => {
  let verifyCalls = 0;
  const inner = createMemoryMcpRateLimiter({
    request: { maxRequests: 8, windowMs: 60_000 },
    now: () => 1_000,
  });
  let rateCalls = 0;
  const requestRateLimiter = {
    consume: async (subject: Parameters<typeof inner.consume>[0]) => {
      rateCalls += 1;
      return inner.consume(subject);
    },
    close: () => inner.close(),
    readiness: () => inner.readiness(),
  };
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: {
      applicationFacade: pingMcpApplicationFacade(capture),
      oauthVerifier: {
        async verify() {
          verifyCalls += 1;
          throw new Error('oauth must not run after Host reject');
        },
      },
      requestRateLimiter,
    },
    mcpRateLimiter: requestRateLimiter,
  }));
  const compat = await injectCompatPost(server.app, compatRpc('tools/list'), {
    host: 'attacker.example',
    authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}`,
  });
  const strict = await injectStrictPost(server.app, 'server/discover', 38, {
    host: 'attacker.example',
    authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}`,
  });
  assertHostRejected(compat);
  assertHostRejected(strict);
  assert.equal(verifyCalls, 0);
  assert.equal(rateCalls, 0);
  assert.equal(server.admissions.length, 0);
  assert.equal(server.sdkFactoryCalls.count, 0);
  assert.equal(capture.listCalls, 0);
});

test('missing Host fails closed on compat and strict', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade(capture) },
  }));
  await server.app.ready();
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const url = new URL(typeof address === 'string' ? address : `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`);
  async function rawMissingHost(path: string, extra: readonly string[]): Promise<string> {
    const body = JSON.stringify(compatRpc('tools/list'));
    return new Promise<string>((resolve, reject) => {
      const socket = rawConnect({ host: url.hostname, port: Number(url.port) }, () => {
        socket.end([
          `POST ${path} HTTP/1.1`,
          'Content-Type: application/json',
          'Accept: application/json, text/event-stream',
          ...extra,
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
  }
  const compat = await rawMissingHost(MCP_COMPAT_ENDPOINT_PATH, [
    'MCP-Protocol-Version: 2025-11-25',
  ]);
  const strict = await rawMissingHost('/collections/-/mcp', [
    'MCP-Protocol-Version: 2026-07-28',
    'Mcp-Method: server/discover',
  ]);
  assert.match(compat, /^HTTP\/1\.1 400 /u);
  assert.match(strict, /^HTTP\/1\.1 400 /u);
  assert.doesNotMatch(compat, /jsonrpc/u);
  assert.doesNotMatch(strict, /jsonrpc/u);
  assert.equal(server.admissions.length, 0);
  assert.equal(server.sdkFactoryCalls.count, 0);
  assert.equal(capture.listCalls, 0);
});

test('duplicate Host fails closed on compat like product admission on strict', async () => {
  const server = track(startCompatApp());
  await server.app.ready();
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const url = new URL(typeof address === 'string' ? address : `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`);
  const body = JSON.stringify(compatRpc('tools/list'));
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = rawConnect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.end([
        `POST ${MCP_COMPAT_ENDPOINT_PATH} HTTP/1.1`,
        `Host: ${MCP_TEST_REQUEST_HOST}`,
        `Host: attacker.example`,
        'Content-Type: application/json',
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
  assert.match(raw, /invalid_request/u);
});

