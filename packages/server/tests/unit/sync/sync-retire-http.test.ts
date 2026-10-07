import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { afterEach, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createValidatorRegistry } from '@know-n/colp/schema';
import {
  SyncRetireError,
  type SyncRetireApplicationInput,
} from '../../../src/modules/sync/index.js';
import { createPublicationManifestCandidate } from '../../../src/modules/publication/index.js';
import { registerSyncRetireRoutes } from '../../../src/transport/colp-sync/sync-retire-routes.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  discoverSyncRetireEndpoint,
  SYNC_RETIRE_NAMESPACE,
} from '../../support/sync-retire-client.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION = 'Bearer P3-25-RETIRE-SECRET';
const SESSION_ID = 'session-p325-retire';
const apps: FastifyInstance[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function start(options: {
  readonly retire?: (input: SyncRetireApplicationInput) => Promise<void>;
  readonly maxRequests?: number;
  readonly allowInsecureLoopback?: boolean;
} = {}) {
  const calls: SyncRetireApplicationInput[] = [];
  const app = Fastify({ logger: false });
  registerSyncRetireRoutes(app, {
    path: '/extension-internal/sync/replica',
    allowedOrigins: [ORIGIN],
    allowInsecureLoopback: options.allowInsecureLoopback ?? true,
    rateLimit: { maxRequests: options.maxRequests ?? 100, windowMs: 60_000 },
    credentialVerifier: { async verify({ authorization }) {
      if (authorization !== AUTHORIZATION) throw new Error('denied');
      return mintVerifiedExtensionCredentialFixture({ issuer: 'https://issuer.example', audience: 'known-api',
        clientId: 'known-extension', subject: 'retire-subject', credentialId: 'retire-credential' });
    } },
    application: { async retireExtension(input) { calls.push(input); await options.retire?.(input); } },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  return { origin: `http://127.0.0.1:${address.port}`, calls };
}

function retire(origin: string, init: {
  readonly key?: string;
  readonly sessionId?: string;
  readonly authorization?: string;
  readonly requestOrigin?: string;
  readonly body?: string;
} = {}) {
  const headers: Record<string, string> = {
    Accept: 'application/problem+json',
    Authorization: init.authorization ?? AUTHORIZATION,
    Origin: init.requestOrigin ?? ORIGIN,
    'Idempotency-Key': init.key ?? 'retire-key-1',
    'Known-Sync-Session': init.sessionId ?? SESSION_ID,
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${origin}/extension-internal/sync/replica`, {
    method: 'DELETE', headers, ...(init.body === undefined ? {} : { body: init.body }),
  });
}

test('publishes one namespaced Manifest extension contract instead of inventing a COLP retire DTO', () => {
  const candidate = createPublicationManifestCandidate({
    origin: 'https://known.example', mountPath: '/colp/v0.1/',
    serverUuid: '019f9d33-2525-7252-8252-252525252525', title: 'Known', maxPageSize: 100,
    maxSnapshotNodes: 10_000, endpoints: {
      directory: 'https://known.example/directory',
      collection: 'https://known.example/collections/{collectionId}',
      snapshot: 'https://known.example/collections/{collectionId}/snapshot',
    }, syncRetire: { href: 'https://known.example/extension-internal/sync/replica' },
  }, ['directory', 'collection', 'snapshot']);
  const mount = candidate.manifest.mounts[0]! as Record<string, unknown>;
  assert.deepEqual(mount[SYNC_RETIRE_NAMESPACE], {
    href: 'https://known.example/extension-internal/sync/replica',
    method: 'DELETE',
    requiredHeaders: ['Authorization', 'Origin', 'Known-Sync-Session', 'Idempotency-Key'],
    requestBody: false,
    successStatus: 204,
  });
  assert.equal(Object.hasOwn(candidate.manifest.mounts[0]!.endpoints, 'syncRetire'), false);
  assert.equal(createValidatorRegistry().validate('manifest', candidate.manifest).valid, true);
  assert.deepEqual(discoverSyncRetireEndpoint(candidate.manifest), {
    href: 'https://known.example/extension-internal/sync/replica', method: 'DELETE',
  });
  const unnamespaced = structuredClone(candidate.manifest) as unknown as Record<string, unknown>;
  ((unnamespaced.mounts as Record<string, unknown>[])[0]!).syncRetire = { href: 'https://attacker.example' };
  assert.equal(createValidatorRegistry().validate('manifest', unnamespaced).valid, false);
});

test('rejects a body before JWKS and has no request or response DTO surface', async () => {
  const server = await start();
  const denied = await retire(server.origin, {
    authorization: 'Bearer RETIRE-ATTACKER-SECRET', body: '{"oldIndexedDb":"PRIVATE-BACKUP"}',
  });
  assert.equal(denied.status, 415);
  assert.deepEqual(server.calls, []);
  assert.doesNotMatch(await denied.text(), /RETIRE-ATTACKER-SECRET|PRIVATE-BACKUP/u);

  const concealedOrigin = await retire(server.origin, {
    authorization: 'Bearer RETIRE-ATTACKER-SECRET',
    requestOrigin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  assert.equal(concealedOrigin.status, 403);

  const bodyRejected = await retire(server.origin, { body: '{}' });
  assert.equal(bodyRejected.status, 415);
  assert.deepEqual(server.calls, []);

  const response = await retire(server.origin);
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0]?.sessionId, SESSION_ID);
  assert.equal(server.calls[0]?.idempotencyKey, 'retire-key-1');
});

test('requires raw singleton authorization, origin, session and idempotency headers', async () => {
  for (const duplicate of ['Authorization', 'Origin', 'Known-Sync-Session', 'Idempotency-Key']) {
    const server = await start();
    const url = new URL('/extension-internal/sync/replica', server.origin);
    const status = await new Promise<number>((resolve, reject) => {
      const headers = ['Authorization', AUTHORIZATION, 'Origin', ORIGIN,
        'Known-Sync-Session', SESSION_ID, 'Idempotency-Key', 'retire-key'];
      headers.push(duplicate, duplicate === 'Authorization' ? 'Bearer other'
        : duplicate === 'Origin' ? ORIGIN : duplicate === 'Known-Sync-Session' ? 'other-session' : 'other-key');
      const request = rawRequest({ hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'DELETE', headers }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode ?? 0));
      });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 400);
    assert.deepEqual(server.calls, []);
  }
});

test('rejects query, wrong Origin, insecure transport, malformed keys and rate-limit overflow', async () => {
  const server = await start({ maxRequests: 1 });
  assert.equal((await fetch(`${server.origin}/extension-internal/sync/replica?replicaId=attacker`, {
    method: 'DELETE', headers: { Authorization: AUTHORIZATION, Origin: ORIGIN,
      'Known-Sync-Session': SESSION_ID, 'Idempotency-Key': 'query-key' },
  })).status, 400);
  assert.equal((await retire(server.origin, { requestOrigin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })).status, 403);
  assert.equal((await retire(server.origin, { key: 'not a key' })).status, 400);
  assert.equal((await retire(server.origin)).status, 204);
  const limited = await retire(server.origin, { key: 'limited-key' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('cache-control'), 'private, no-store');

  const insecure = await start({ allowInsecureLoopback: false });
  assert.equal((await retire(insecure.origin)).status, 401);
  assert.deepEqual(insecure.calls, []);
});

test('maps lifecycle and authority failures to stable redacted Problems', async () => {
  for (const [code, status] of [
    ['replica_retired', 410], ['stale_replica', 410], ['idempotency_key_reused', 409],
    ['resource_not_found', 404], ['insufficient_scope', 403], ['service_unavailable', 503],
  ] as const) {
    const server = await start({ retire: async () => { throw new SyncRetireError(code); } });
    const response = await retire(server.origin, { sessionId: 'SECRET-SESSION-MARKER' });
    const text = await response.text();
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(createValidatorRegistry().validate('problem', JSON.parse(text)).valid, true);
    assert.doesNotMatch(text, /SECRET-SESSION-MARKER|P3-25-RETIRE-SECRET/u);
  }
});
