import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent, get, type IncomingMessage } from 'node:http';
import { Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { Socket } from 'node:net';
import type { betterAuth } from 'better-auth';
import Fastify from 'fastify';
import pino from 'pino';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { mountBetterAuthAllowlist } from '../../../src/infrastructure/auth/better-auth-fastify-bridge.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';

// Exercise the production HTTP bridge over real sockets. The downstream
// handler is a controlled transport peer; these tests make no auth/DB claim.
for (const status of [200, 500]) {
  test(`completed Better Auth responses release per-request keep-alive listeners (${status})`, async () => {
    const f = await probe(async () => {
      if (status === 500) throw new Error('fixture_handler_failed');
      return new Response('ok');
    });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let index = 0; index < 12; index += 1) {
        assert.equal(await requestStatus(f.url, agent), status);
      }
      await setImmediate();
      assert.equal(new Set(f.observed.map((entry) => entry.socket)).size, 1, 'must reuse one real TCP socket');
      const first = f.observed[0]!;
      assert.ok(first.socket.listenerCount('close') <= first.closeBaseline,
        'only the original server/socket listeners may remain after finish');
      for (const entry of f.observed) {
        assert.equal(entry.closeBaseline, first.closeBaseline, 'completed requests must not accumulate socket listeners');
        assert.equal(entry.raw.listenerCount('aborted'), entry.abortBaseline);
        assert.equal(entry.signal?.aborted, false, 'finish must detach without aborting completed work');
      }
    } finally { agent.destroy(); await f.app.close(); }
  });
}

for (const phase of ['pending handler', 'streaming response'] as const) {
test(`client disconnect aborts the bridge during ${phase}`, async () => {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const f = await probe(async (request) => {
    if (phase === 'pending handler') return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        aborted.resolve(); reject(new Error('fixture_handler_aborted'));
      }, { once: true });
      started.resolve();
    });
    return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial'));
      request.signal.addEventListener('abort', () => {
        controller.error(new Error('fixture_stream_aborted')); aborted.resolve();
      }, { once: true });
      started.resolve();
    },
    }));
  });
  const client = get(f.url);
  client.on('error', () => undefined);
  try {
    await started.promise;
    const entry = f.observed[0]!;
    const closed = once(entry.socket, 'close');
    client.destroy();
    await closed; await aborted.promise; await setImmediate();
    assert.equal(entry.signal?.aborted, true);
    assert.equal(entry.raw.listenerCount('aborted'), entry.abortBaseline);
  } finally { client.destroy(); await f.app.close(); }
});
}

test('a JSON bridge reply is not sent again by the body parser', async () => {
  const warnings: string[] = [];
  const app = Fastify({
    loggerInstance: pino({ level: 'warn' }, new Writable({
      write(chunk, _encoding, callback) {
        warnings.push(String(chunk));
        callback();
      },
    })),
  });
  const config = buildBetterAuthConfig(loadConfig({
    DATABASE_URL: 'postgres://unused.invalid/never', NODE_ENV: 'test', LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: 'https://app.example.test', ALLOWED_ORIGINS: 'https://app.example.test',
    BETTER_AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 'fixture-better-auth-secret-0123456789abcdef',
  }).betterAuth);
  assert.ok(config);
  const auth = {
    handler: async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  } as unknown as ReturnType<typeof betterAuth>;
  mountBetterAuthAllowlist(app, auth, { ...config, oauthIssuer: false });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `${config.basePath}/sign-up/email`,
      headers: { 'content-type': 'application/json', origin: 'https://app.example.test' },
      payload: JSON.stringify({ name: 'Bridge', email: 'bridge@example.test', password: 'bridge-password' }), // secret-scan: allow 'bridge-password'
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"ok":true}');
    assert.equal(warnings.some((line) => line.includes('FST_ERR_REP_ALREADY_SENT')), false);
  } finally {
    await app.close();
  }
});

async function probe(handler: (request: Request) => Promise<Response>) {
  const app = Fastify({ logger: false });
  const observed: Array<{ socket: Socket; raw: IncomingMessage; closeBaseline: number;
    abortBaseline: number; signal?: AbortSignal }> = [];
  app.addHook('onRequest', async (request) => {
    observed.push({ socket: request.raw.socket, raw: request.raw,
      closeBaseline: request.raw.socket.listenerCount('close'), abortBaseline: request.raw.listenerCount('aborted') });
  });
  const config = buildBetterAuthConfig(loadConfig({ DATABASE_URL: 'postgres://unused.invalid/never', NODE_ENV: 'test',
    LOG_LEVEL: 'silent', PRODUCT_ORIGIN: 'https://app.example.test', ALLOWED_ORIGINS: 'https://app.example.test',
    BETTER_AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 'fixture-better-auth-secret-0123456789abcdef',
  }).betterAuth);
  assert.ok(config);
  const auth = { handler: async (request: Request) => {
    observed.at(-1)!.signal = request.signal;
    return handler(request);
  } } as unknown as ReturnType<typeof betterAuth>;
  mountBetterAuthAllowlist(app, auth, { ...config, oauthIssuer: false });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, observed, url: `${address}${config.basePath}/get-session` };
}

function requestStatus(url: string, agent: Agent): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode)); response.once('error', reject);
    });
    request.once('error', reject);
  });
}
