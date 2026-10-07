import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { prototypeMemberJsonBodies } from '../../support/prototype-member-json.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { SyncSessionHttpError } from '../../../src/transport/colp-sync/sync-session-routes.js';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { SESSION_COOKIE_NAME } from '../../../src/transport/session-cookie.js';
import {
  EXTENSION_ORIGIN,
  SECRET_BINDING,
  SECRET_EXTENSION,
  SECRET_TOKEN,
  closeSyncSessionApps,
  manifest,
  post,
  rawHttp,
  rawWire,
  request,
  result,
  routeDependencies,
  start,
  syncEnv,
  trackSyncSessionApp,
} from '../../support/sync-session-http-harness.js';

afterEach(closeSyncSessionApps);

describe('P3-08 Sync Session HTTP admission', () => {
  test('rejects raw duplicate Authorization and Idempotency-Key before authentication', async () => {
    for (const duplicate of ['Authorization', 'Idempotency-Key']) {
      const server = await start();
      const response = await rawHttp(server.origin, [
        'Authorization', `Bearer ${SECRET_TOKEN}`,
        'Idempotency-Key', 'raw-one',
        duplicate, duplicate === 'Authorization' ? 'Bearer second' : 'raw-two',
        'Content-Type', 'application/json',
        'Origin', EXTENSION_ORIGIN,
      ], JSON.stringify(request()));
      assert.equal(response.status, 400, duplicate);
      if (response.contentType === '') {
        assert.equal(response.body, '', 'Node rejected the duplicate singleton before Fastify');
      } else {
        assert.match(response.contentType, /^application\/problem\+json/u, duplicate);
      }
      assert.deepEqual(server.calls, []);
    }
  });

  test('rejects duplicate singleton headers and missing headers before authentication', async () => {
    for (const duplicate of ['Origin', 'Content-Type']) {
      const server = await start();
      const response = await rawHttp(server.origin, [
        'Authorization', `Bearer ${SECRET_TOKEN}`,
        'Idempotency-Key', 'raw-one', 'Origin', EXTENSION_ORIGIN,
        'Content-Type', 'application/json', duplicate,
        duplicate === 'Origin' ? EXTENSION_ORIGIN : 'application/json',
      ], JSON.stringify(request()));
      assert.equal(response.status, 400, duplicate);
      assert.deepEqual(server.calls, []);
    }
    const cases = [
      { omitted: 'Authorization', status: 401, code: 'authentication_required' },
      { omitted: 'Idempotency-Key', status: 400, code: 'invalid_json' },
      { omitted: 'Origin', status: 403, code: 'origin_not_allowed' },
      { omitted: 'Content-Type', status: 415, code: 'unsupported_media_type' },
    ] as const;
    for (const item of cases) {
      const server = await start();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        'Idempotency-Key': 'required-header', Origin: EXTENSION_ORIGIN,
        'Content-Type': 'application/json',
      };
      delete headers[item.omitted];
      const response = await fetch(`${server.origin}/private-entry/session-negotiation`, {
        method: 'POST', headers, body: JSON.stringify(request()),
      });
      assert.equal(response.status, item.status, item.omitted);
      assert.equal((await response.json() as { code: string }).code, item.code);
      assert.deepEqual(server.calls, []);
    }
  });

  test('prefers a valid session cookie when Authorization is percent-mangled', async () => {
    const cookie = 'baSessionToken.abc+def/ghi==';
    const seen: string[] = [];
    const server = await start({
      verifier: async (authorization) => {
        seen.push(String(authorization));
        return mintVerifiedExtensionCredentialFixture({
          issuer: 'https://issuer.example.test', audience: 'known-sync-api',
          clientId: 'known-extension', subject: 'account-http-1',
          credentialId: 'credential-http-1',
        });
      },
    });
    const response = await fetch(`${server.origin}/private-entry/session-negotiation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${encodeURIComponent(cookie)}-not-the-cookie`,
        Cookie: `__Host-known_session=${encodeURIComponent(cookie)}`,
        'Idempotency-Key': 'cookie-preferred',
        Origin: EXTENSION_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request()),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(seen, [`Bearer ${cookie}`]);
  });

  test('accepts a session cookie when Authorization is omitted', async () => {
    const cookie = 'baSessionToken.abc+def/ghi==';
    const seen: string[] = [];
    const server = await start({
      verifier: async (authorization) => {
        seen.push(String(authorization));
        return mintVerifiedExtensionCredentialFixture({
          issuer: 'https://issuer.example.test', audience: 'known-sync-api',
          clientId: 'known-extension', subject: 'account-http-1',
          credentialId: 'credential-http-1',
        });
      },
    });
    const response = await fetch(`${server.origin}/private-entry/session-negotiation`, {
      method: 'POST',
      headers: {
        Cookie: `__Host-known_session=${encodeURIComponent(cookie)}`,
        'Idempotency-Key': 'cookie-only',
        Origin: EXTENSION_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request()),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(seen, [`Bearer ${cookie}`]);
  });

  test('rejects duplicate or malformed session cookies before authentication', async () => {
    const duplicatePairs = await start();
    const duplicateResponse = await fetch(`${duplicatePairs.origin}/private-entry/session-negotiation`, {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}=b`,
        'Idempotency-Key': 'duplicate-pairs',
        Origin: EXTENSION_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request()),
    });
    assert.equal(duplicateResponse.status, 400);
    assert.equal((await duplicateResponse.json() as { code: string }).code, 'invalid_json');
    assert.deepEqual(duplicatePairs.calls, []);

    const malformed = await start();
    const malformedResponse = await fetch(`${malformed.origin}/private-entry/session-negotiation`, {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=%zz`,
        Authorization: `Bearer ${SECRET_TOKEN}`,
        'Idempotency-Key': 'malformed-cookie',
        Origin: EXTENSION_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request()),
    });
    const malformedBody = await malformedResponse.text();
    assert.equal(malformedResponse.status, 400);
    assert.equal((JSON.parse(malformedBody) as { code: string }).code, 'invalid_json');
    assert.doesNotMatch(malformedBody, /%zz/u);
    assert.deepEqual(malformed.calls, []);

    const twoCookies = await start();
    const twoCookieResponse = await rawHttp(twoCookies.origin, [
      'Cookie', `${SESSION_COOKIE_NAME}=a`,
      'Cookie', `${SESSION_COOKIE_NAME}=b`,
      'Idempotency-Key', 'two-cookie-headers',
      'Origin', EXTENSION_ORIGIN,
      'Content-Type', 'application/json',
    ], JSON.stringify(request()));
    assert.equal(twoCookieResponse.status, 400);
    if (twoCookieResponse.contentType !== '') {
      assert.equal((JSON.parse(twoCookieResponse.body) as { code: string }).code, 'invalid_json');
    }
    assert.deepEqual(twoCookies.calls, []);
  });

  test('composed admission and COLP reject duplicate or malformed session cookies before the verifier', async () => {
    const enabled = loadConfig(syncEnv());
    const calls: string[] = [];
    const seen: string[] = [];
    const route = {
      ...routeDependencies(enabled.syncSession!),
      credentialVerifier: {
        async verify({ authorization }: { authorization: string | readonly string[] | undefined }) {
          calls.push('authenticate');
          seen.push(String(authorization));
          return mintVerifiedExtensionCredentialFixture({
            issuer: 'https://issuer.example.test', audience: 'known-sync-api',
            clientId: 'known-extension', subject: 'account-http-1', credentialId: 'credential-http-1',
          });
        },
      },
      application: {
        async issue() {
          calls.push('issue');
          return { state: 'issued' as const, response: result() };
        },
      },
    };
    const snapshotRoute = {
      path: enabled.syncSession!.snapshot.path,
      credentialVerifier: route.credentialVerifier,
      application: { async query() { throw new Error('not invoked'); } },
      allowedOrigins: enabled.syncSession!.allowedOrigins,
      rateLimit: enabled.syncSession!.snapshot.rateLimit,
      allowInsecureLoopback: true,
    };
    const pushRoute = {
      path: enabled.syncSession!.push.path,
      credentialVerifier: route.credentialVerifier,
      application: {
        runtimeOwnership: { operationIdReservationOwner: 'sequence' as const,
          usesPushCoordinator: false as const, maxBatchOperations: 1 as const,
          evaluator: 'canonical_node_create' as const },
        async admit(): Promise<never> { throw new Error('not invoked'); },
      },
      allowedOrigins: enabled.syncSession!.allowedOrigins,
      rateLimit: enabled.syncSession!.push.rateLimit,
      maxBatchOperations: 1 as const,
      allowInsecureLoopback: true,
    };
    const conflictRoute = {
      pathTemplate: enabled.syncSession!.conflict.path,
      credentialVerifier: route.credentialVerifier,
      application: { async resolve(): Promise<never> { throw new Error('not invoked'); } },
      allowedOrigins: enabled.syncSession!.allowedOrigins,
      rateLimit: enabled.syncSession!.conflict.rateLimit,
      allowInsecureLoopback: true,
    };
    const pullRoute = {
      path: enabled.syncSession!.pull.path,
      credentialVerifier: route.credentialVerifier,
      reader: { async read() { return { events: [], nextCursor: 'test-cursor',
        nextTuple: { commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' },
        hasMore: false, collectionRevision: 'collection-r1' }; } },
      allowedOrigins: enabled.syncSession!.allowedOrigins,
      rateLimit: enabled.syncSession!.pull.rateLimit,
      maxLimit: enabled.syncSession!.pull.maxLimit,
      responseBudgetBytes: enabled.syncSession!.pull.responseBudgetBytes,
      requestTimeoutMs: enabled.syncSession!.pull.requestTimeoutMs,
      recommendedPullAfterSeconds: enabled.syncSession!.pull.recommendedPullAfterSeconds,
      allowInsecureLoopback: true,
    };
    const ackRoute = {
      path: enabled.syncSession!.ack.path,
      credentialVerifier: route.credentialVerifier,
      application: { async acknowledge(): Promise<never> { throw new Error('not invoked'); } },
      allowedOrigins: enabled.syncSession!.allowedOrigins,
      rateLimit: enabled.syncSession!.ack.rateLimit,
      maxBodyBytes: enabled.syncSession!.ack.maxBodyBytes,
      maxWarnings: enabled.syncSession!.ack.maxWarnings,
      maxWarningBytes: enabled.syncSession!.ack.maxWarningBytes,
      allowInsecureLoopback: true,
    };
    const retireRoute = {
      path: enabled.syncSession!.retire.path,
      credentialVerifier: route.credentialVerifier,
      application: { async retireExtension(): Promise<void> {} },
      allowedOrigins: enabled.syncSession!.allowedOrigins,
      rateLimit: enabled.syncSession!.retire.rateLimit,
      allowInsecureLoopback: true,
    };
    const app = buildApiApp({
      config: enabled, syncSessionRoutes: route, syncSnapshotRoutes: snapshotRoute,
      syncPushRoutes: pushRoute, syncConflictRoutes: conflictRoute, syncPullRoutes: pullRoute,
      syncAckRoutes: ackRoute, syncRetireRoutes: retireRoute,
    });
    trackSyncSessionApp(app);
    const path = enabled.syncSession!.path;
    const colpHeaders = {
      origin: EXTENSION_ORIGIN,
      'content-type': 'application/json',
    };
    const duplicatePairs = await app.inject({
      method: 'POST', url: path,
      headers: {
        ...colpHeaders, 'idempotency-key': 'c08-duplicate-pairs',
        cookie: `${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}=b`,
      },
      payload: JSON.stringify(request()),
    });
    assert.equal(duplicatePairs.statusCode, 400);
    assert.deepEqual(calls, []);

    const twoHeaders = await app.inject({
      method: 'POST', url: path,
      headers: {
        ...colpHeaders, 'idempotency-key': 'c08-two-cookie-headers',
        cookie: [`${SESSION_COOKIE_NAME}=a`, `${SESSION_COOKIE_NAME}=b`],
      },
      payload: JSON.stringify(request()),
    });
    assert.equal(twoHeaders.statusCode, 400);
    assert.deepEqual(calls, []);

    const malformed = await app.inject({
      method: 'POST', url: path,
      headers: {
        ...colpHeaders, 'idempotency-key': 'c08-malformed',
        cookie: `${SESSION_COOKIE_NAME}=%zz`,
        authorization: `Bearer ${SECRET_TOKEN}`,
      },
      payload: JSON.stringify(request()),
    });
    assert.equal(malformed.statusCode, 400);
    assert.doesNotMatch(malformed.body, /%zz/u);
    assert.deepEqual(calls, []);

    const cookie = 'baSessionToken.abc+def/ghi==';
    const mangled = await app.inject({
      method: 'POST', url: path,
      headers: {
        ...colpHeaders, 'idempotency-key': 'c08-cookie-wins',
        authorization: `Bearer ${encodeURIComponent(cookie)}-not-the-cookie`,
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookie)}`,
      },
      payload: JSON.stringify(request()),
    });
    assert.equal(mangled.statusCode, 201);
    assert.deepEqual(seen, [`Bearer ${cookie}`]);
    assert.deepEqual(calls, ['authenticate', 'issue']);

    calls.length = 0;
    seen.length = 0;
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    const origin = `http://127.0.0.1:${address.port}`;
    const twoCookieLines = await rawHttp(origin, [
      'Cookie', `${SESSION_COOKIE_NAME}=a`,
      'Cookie', `${SESSION_COOKIE_NAME}=b`,
      'Idempotency-Key', 'c08-composed-two-cookie-lines',
      'Origin', EXTENSION_ORIGIN,
      'Content-Type', 'application/json',
    ], JSON.stringify(request()));
    assert.equal(twoCookieLines.status, 400);
    if (twoCookieLines.contentType !== '') {
      assert.equal((JSON.parse(twoCookieLines.body) as { code: string }).code, 'invalid_json');
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(seen, []);
  });

  test('fails closed on obs-fold and invalid header bytes before authentication', async () => {
    for (const header of [
      Buffer.from(`Authorization: Bearer ${SECRET_TOKEN}\r\n\tfolded-secret`),
      Buffer.concat([Buffer.from('Authorization: Bearer '), Buffer.from([0x80])]),
    ]) {
      const server = await start();
      const response = await rawWire(server.origin, Buffer.concat([
        Buffer.from('POST /private-entry/session-negotiation HTTP/1.1\r\nHost: localhost\r\n'),
        header,
        Buffer.from(`\r\nIdempotency-Key: raw-invalid\r\nOrigin: ${EXTENSION_ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n`),
      ]));
      assert.match(response, /^HTTP\/1\.1 400 /u);
      assert.deepEqual(server.calls, []);
    }
  });

  test('rejects unsupported media, duplicate JSON members and invalid schema before issue', async () => {
    const server = await start();
    const cases = [
      { type: 'text/plain', body: JSON.stringify(request()), status: 415 },
      { type: 'application/problem+json', body: JSON.stringify(request()), status: 415 },
      { type: 'application/json', body: '', status: 400 },
      { type: 'application/json', body: '{"scope":"collection","scope":"collection"}', status: 400 },
      { type: 'application/json', body: '{"unsafe":9007199254740992}', status: 400 },
      { type: 'application/json', body: JSON.stringify(request({ unexpected: true })), status: 422 },
    ];
    for (const item of cases) {
      const response = await fetch(`${server.origin}/private-entry/session-negotiation`, {
        method: 'POST', headers: {
          Authorization: `Bearer ${SECRET_TOKEN}`, 'Idempotency-Key': 'invalid-body',
          Origin: EXTENSION_ORIGIN,
          'Content-Type': item.type,
        }, body: item.body,
      });
      assert.equal(response.status, item.status);
      assert.match(response.headers.get('content-type') ?? '', /^application\/problem\+json/u);
    }
    assert.equal(server.calls.includes('issue'), false);
  });

  test('rejects prototype-shaped members before issuing a session', async () => {
    const server = await start();
    for (const body of prototypeMemberJsonBodies(JSON.stringify(request()))) {
      const response = await fetch(server.origin + '/private-entry/session-negotiation', {
        method: 'POST', headers: {
          Authorization: 'Bearer ' + SECRET_TOKEN, 'Idempotency-Key': 'prototype-member',
          Origin: EXTENSION_ORIGIN, 'Content-Type': 'application/json',
        }, body,
      });
      const text = await response.text();
      assert.equal(response.status, 400, body);
      assert.equal((JSON.parse(text) as { code: string }).code, 'invalid_json');
      assert.doesNotMatch(text, /__proto__|token-SYNC-SECRET/u);
    }
    assert.equal(server.calls.includes('issue'), false);
  });

  test('enforces byte, depth and member budgets before authentication', async () => {
    for (const options of [
      { bodyLimitBytes: 64 },
      { maxJsonDepth: 3 },
      { maxJsonMembers: 5 },
    ]) {
      const server = await start({ ...options, rateLimit: 100 });
      const response = await post(server.origin, `budget-${Object.keys(options)[0]}`);
      assert.equal(response.status, 413, Object.keys(options)[0]);
      const problem = await response.json() as { code: string; retryable: boolean };
      assert.equal(problem.code, 'payload_too_large');
      assert.equal(problem.retryable, false);
      assert.deepEqual(server.calls, []);
    }
  });

  test('rejects insecure direct transport and ignores forged forwarded TLS', async () => {
    const server = await start({ allowInsecureLoopback: false });
    const response = await fetch(`${server.origin}/private-entry/session-negotiation`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`, 'Idempotency-Key': 'tls-fail',
        Origin: EXTENSION_ORIGIN, 'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      }, body: JSON.stringify(request()),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(server.calls, []);
  });

  test('fails closed on schema-valid but semantically invalid responses and unknown thrown errors', async () => {
    const semantic = await start({ issue: async () => ({
      state: 'issued', response: { ...result(), clockSkewMilliseconds: 0 },
    }) });
    const invalid = await post(semantic.origin, 'semantic-invalid');
    assert.equal(invalid.status, 500);
    assert.equal((await invalid.json() as { code: string }).code, 'internal_error');
    const unknown = await start({ issue: async () => {
      throw Object.assign(new Error(SECRET_TOKEN), { code: 'resource_not_found', status: 404 });
    } });
    const hidden = await post(unknown.origin, 'unknown-error');
    assert.equal(hidden.status, 500);
    assert.doesNotMatch(await hidden.text(), /SYNC-SECRET-MARKER/u);
  });

  test('black-box discovery fails closed for missing, cross-origin and invalid endpoint results', async () => {
    const cases = [
      (origin: string) => {
        const value = structuredClone(manifest(origin));
        delete value.mounts[0]!.endpoints.syncSessions;
        return value;
      },
      (origin: string) => {
        const value = structuredClone(manifest(origin));
        value.mounts[0]!.endpoints.syncSessions = 'https://attacker.example/sessions';
        return value;
      },
    ];
    for (const candidate of cases) {
      const server = await start({ manifest: candidate });
      const client = createSyncSessionBlackBoxClient({
        manifestUrl: `${server.origin}/.well-known/collection-protocol`,
        mountId: 'known-sync-entry', authorization: `Bearer ${SECRET_TOKEN}`,
        origin: EXTENSION_ORIGIN,
      });
      await assert.rejects(client.create({ idempotencyKey: 'discovery-fail', request: request() }));
      assert.deepEqual(server.calls, []);
    }
  });

  test('maps authentication, concealment, insufficient scope, reuse and rate limit to COLP Problems', async () => {
    const rejectedCredential = await start({ verifier: async () => { throw new Error(SECRET_TOKEN); } });
    const rejected = await post(rejectedCredential.origin, 'auth-failure');
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json() as { code: string }).code, 'authentication_required');
    assert.deepEqual(rejectedCredential.calls, ['authenticate']);
    const failures = [
      { code: 'authentication_required', status: 401 },
      { code: 'resource_not_found', status: 404 },
      { code: 'insufficient_scope', status: 403 },
      { code: 'idempotency_key_reused', status: 409 },
    ] as const;
    for (const failure of failures) {
      const server = await start({ issue: async () => { throw new SyncSessionHttpError(failure.code); } });
      const response = await post(server.origin, 'failure-key');
      assert.equal(response.status, failure.status);
      assert.equal((await response.json() as { code: string }).code, failure.code);
    }
    const limited = await start({ rateLimit: 1 });
    assert.equal((await post(limited.origin, 'rate-1')).status, 201);
    const denied = await post(limited.origin, 'rate-2');
    assert.equal(denied.status, 429);
    assert.match(denied.headers.get('ratelimit-policy') ?? '', /sync-session/u);
    assert.ok(denied.headers.get('retry-after'));
    const rateProblem = await denied.json() as { code: string; retryable: boolean; retryAfterSeconds: number };
    assert.deepEqual({ code: rateProblem.code, retryable: rateProblem.retryable },
      { code: 'rate_limited', retryable: true });
    assert.equal(rateProblem.retryAfterSeconds >= 1, true);
  });

  test('Problems and serialized output redact credential, binding and extension markers', async () => {
    const server = await start({ issue: async () => {
      void `${SECRET_TOKEN} ${SECRET_BINDING} ${SECRET_EXTENSION}`;
      throw new SyncSessionHttpError('resource_not_found');
    } });
    const response = await post(server.origin, 'secret-key');
    const text = await response.text();
    assert.equal(response.status, 404);
    assert.doesNotMatch(text, /SYNC-SECRET-MARKER/u);
  });
});
