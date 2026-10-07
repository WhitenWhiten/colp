import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { afterEach, describe, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { ConflictResolutionRequest, Problem } from '@know-n/colp/types';
import { registerSyncConflictRoutes } from '../../../src/transport/colp-sync/sync-conflict-routes.js';
import { SyncConflictResolutionError } from '../../../src/modules/sync/index.js';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { isFetchForbiddenPort } from '../../support/fetch-port.js';
import { prototypeMemberJsonBodies } from '../../support/prototype-member-json.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const TOKEN = 'conflict-http-secret-token';
const PATH = '/private-entry/conflicts/:conflictId/decision';
const apps: FastifyInstance[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function start(options: {
  readonly maxRequests?: number;
  readonly bodyLimitBytes?: number;
  readonly maxJsonDepth?: number;
  readonly maxJsonMembers?: number;
  readonly allowInsecureLoopback?: boolean;
} = {}) {
  const calls: unknown[] = [];
  const app = Fastify({ logger: false });
  registerSyncConflictRoutes(app, {
    pathTemplate: '/private-entry/conflicts/{conflictId}/decision',
    credentialVerifier: { async verify({ authorization }) {
      assert.equal(authorization, `Bearer ${TOKEN}`);
      return mintVerifiedExtensionCredentialFixture({
        issuer: 'https://issuer.example', audience: 'known-api', clientId: 'known-extension',
        subject: 'conflict-subject', credentialId: 'conflict-credential',
      });
    } },
    application: { async resolve(input) {
      calls.push(input);
      throw new SyncConflictResolutionError('precondition_failed', 'conflict-current-r2');
    } },
    allowedOrigins: [ORIGIN],
    rateLimit: { maxRequests: options.maxRequests ?? 100, windowMs: 60_000 },
    allowInsecureLoopback: options.allowInsecureLoopback ?? true,
    ...(options.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: options.bodyLimitBytes }),
    ...(options.maxJsonDepth === undefined ? {} : { maxJsonDepth: options.maxJsonDepth }),
    ...(options.maxJsonMembers === undefined ? {} : { maxJsonMembers: options.maxJsonMembers }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  if (isFetchForbiddenPort(address.port)) {
    await app.close();
    return start(options);
  }
  apps.push(app);
  return { origin: `http://127.0.0.1:${address.port}`, calls };
}

function url(origin: string, conflictId = 'conflict-path-id') {
  const target = new URL(PATH.replace(':conflictId', encodeURIComponent(conflictId)), origin);
  target.searchParams.set('sessionId', 'session-1');
  target.searchParams.set('replicaId', 'replica-1');
  target.searchParams.set('collectionId', 'collection-1');
  return target;
}

function request(): ConflictResolutionRequest {
  return { resolution: 'custom', value: 'Merged title', baseConflictRevision: 'conflict-r1' };
}

async function post(origin: string, body: unknown = request(), headers: Record<string, string> = {}) {
  return fetch(url(origin), { method: 'POST', headers: {
    Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'Content-Type': 'application/json',
    'Idempotency-Key': 'resolve-key-1', 'If-Match': '"conflict-r1"', ...headers,
  }, body: JSON.stringify(body) });
}

function problem(value: unknown): Problem {
  assert.equal(createValidatorRegistry().validate('problem', value).valid, true);
  return value as Problem;
}

describe('P3-19 Sync Conflict HTTP admission', () => {
  test('maps the URI Template identity and stable P3-18 precondition Problem', async () => {
    const server = await start();
    const response = await post(server.origin);
    assert.equal(response.status, 412);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('etag'), '"conflict-current-r2"');
    assert.equal(problem(await response.json()).code, 'precondition_failed');
    const call = server.calls[0] as Record<string, unknown>;
    assert.equal(call.conflictId, 'conflict-path-id');
    assert.equal(call.sessionId, 'session-1');
    assert.equal(call.replicaId, 'replica-1');
    assert.equal(call.collectionId, 'collection-1');
    assert.deepEqual(call.ifMatch, ['"conflict-r1"']);
  });

  test('never lets a body member override path identity', async () => {
    const server = await start();
    const response = await post(server.origin, { ...request(), conflictId: 'body-attacker-id' });
    assert.equal(response.status, 422);
    assert.equal(problem(await response.json()).code, 'invalid_document');
    assert.deepEqual(server.calls, []);
  });

  test('rejects missing, repeated, list, weak, wildcard and malformed singleton headers before auth', async () => {
    for (const duplicate of ['Authorization', 'Origin', 'Content-Type', 'Idempotency-Key', 'If-Match']) {
      const server = await start();
      const target = url(server.origin);
      const status = await new Promise<number>((resolve, reject) => {
        const headers = ['Authorization', `Bearer ${TOKEN}`, 'Origin', ORIGIN,
          'Content-Type', 'application/json', 'Idempotency-Key', 'resolve-key-1', 'If-Match', '"conflict-r1"'];
        headers.push(duplicate, duplicate === 'If-Match' ? '"other"' : 'duplicate');
        const req = rawRequest({ hostname: target.hostname, port: target.port,
          path: `${target.pathname}${target.search}`, method: 'POST', headers }, (res) => {
          res.resume(); res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject); req.end(JSON.stringify(request()));
      });
      assert.equal(status, 400);
      assert.deepEqual(server.calls, []);
    }
    for (const ifMatch of ['', 'W/"conflict-r1"', '*', '"one", "two"']) {
      const server = await start();
      const response = await post(server.origin, request(), { 'If-Match': ifMatch });
      assert.ok([400, 428].includes(response.status));
      assert.deepEqual(server.calls, []);
    }
  });

  test('enforces exact query identity, Origin, TLS, media type, I-JSON and rate limits', async () => {
    const plain = await start();
    const unknown = new URL(url(plain.origin)); unknown.searchParams.set('unexpected', 'x');
    const invalidQuery = await fetch(unknown, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`,
      Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': 'q', 'If-Match': '"conflict-r1"' },
    body: JSON.stringify(request()) });
    assert.equal(invalidQuery.status, 400);
    assert.equal((await post(plain.origin, request(), { Origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })).status, 403);
    assert.equal((await post(plain.origin, request(), { 'Content-Type': 'text/plain' })).status, 415);
    const insecure = await start({ allowInsecureLoopback: false });
    assert.equal((await post(insecure.origin, request(), { 'X-Forwarded-Proto': 'https' })).status, 401);
    for (const item of [
      { options: { bodyLimitBytes: 32 }, body: request() },
      { options: { maxJsonDepth: 2 }, body: { ...request(), value: { nested: { value: 'x' } } } },
      { options: { maxJsonMembers: 2 }, body: request() },
    ]) {
      const limited = await start(item.options);
      assert.equal((await post(limited.origin, item.body)).status, 413);
    }
    const rate = await start({ maxRequests: 1 });
    await post(rate.origin);
    const denied = await post(rate.origin);
    assert.equal(denied.status, 429);
    assert.equal(problem(await denied.json()).code, 'rate_limited');
  });

  test('rejects prototype-shaped members before conflict resolution', async () => {
    const server = await start();
    for (const body of prototypeMemberJsonBodies(JSON.stringify(request()))) {
      const response = await fetch(url(server.origin), { method: 'POST', headers: {
        Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN, 'Content-Type': 'application/json',
        'Idempotency-Key': 'prototype-member', 'If-Match': '"conflict-r1"',
      }, body });
      const text = await response.text();
      assert.equal(response.status, 400, body);
      assert.equal(problem(JSON.parse(text)).code, 'invalid_json');
      assert.doesNotMatch(text, /__proto__|conflict-http-secret/u);
    }
    assert.deepEqual(server.calls, []);
  });

  test('conceals credential failures and never reflects sensitive values', async () => {
    const app = Fastify({ logger: false }); apps.push(app);
    registerSyncConflictRoutes(app, {
      pathTemplate: '/private-entry/conflicts/{conflictId}/decision',
      credentialVerifier: { async verify() { throw new Error('SECRET-CREDENTIAL'); } },
      application: { async resolve(): Promise<never> { throw new Error('not called'); } },
      allowedOrigins: [ORIGIN], rateLimit: { maxRequests: 10, windowMs: 60_000 },
      allowInsecureLoopback: true,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('not listening');
    const response = await post(`http://127.0.0.1:${address.port}`, {
      resolution: 'custom', value: 'SECRET-BODY', baseConflictRevision: 'conflict-r1',
    });
    const text = await response.text();
    assert.equal(response.status, 401);
    assert.doesNotMatch(text, /SECRET/u);
    const malformed = await fetch(url(`http://127.0.0.1:${address.port}`), {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid', Origin: ORIGIN, 'Content-Type': 'application/json',
        'Idempotency-Key': 'concealed-malformed', 'If-Match': '"conflict-r1"' },
      body: '{"resolution":',
    });
    assert.equal(malformed.status, 401);
    assert.equal(problem(await malformed.json()).code, 'authentication_required');
  });

  test('maps retryable and unknown database outcomes without leaking their causes', async () => {
    for (const kind of ['unavailable', 'commit_outcome_unknown'] as const) {
      const app = Fastify({ logger: false }); apps.push(app);
      registerSyncConflictRoutes(app, {
        pathTemplate: '/private-entry/conflicts/{conflictId}/decision',
        credentialVerifier: { async verify() {
          return mintVerifiedExtensionCredentialFixture({
            issuer: 'https://issuer.example', audience: 'known-api', clientId: 'known-extension',
            subject: 'conflict-subject', credentialId: 'conflict-credential',
          });
        } },
        application: { async resolve(): Promise<never> {
          throw new DatabaseOperationError(kind, new Error('SECRET-SQL-DETAIL'));
        } },
        allowedOrigins: [ORIGIN], rateLimit: { maxRequests: 10, windowMs: 60_000 },
        allowInsecureLoopback: true,
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('not listening');
      const response = await post(`http://127.0.0.1:${address.port}`);
      const text = await response.text();
      assert.equal(response.status, 503);
      assert.equal(problem(JSON.parse(text)).code, 'service_unavailable');
      assert.doesNotMatch(text, /SECRET|SQL/iu);
    }
  });
});
