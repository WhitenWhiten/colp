import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { afterEach, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { endpointContracts } from '@know-n/colp/semantic';
import type { SyncAckResult } from '@know-n/colp/types';
import { createPublicationManifestCandidate } from '../../../src/modules/publication/index.js';
import { SyncAckError, type SyncAckApplicationInput } from '../../../src/modules/sync/index.js';
import { registerSyncAckRoutes } from '../../../src/transport/colp-sync/sync-ack-routes.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { prototypeMemberJsonBodies } from '../../support/prototype-member-json.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION = 'Bearer P3-22-ACK-SECRET';
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function start(options: {
  readonly acknowledge?: (input: SyncAckApplicationInput) => Promise<SyncAckResult>;
  readonly maxBodyBytes?: number;
  readonly maxWarnings?: number;
  readonly maxWarningBytes?: number;
} = {}) {
  const calls: SyncAckApplicationInput[] = [];
  const app = Fastify({ logger: false });
  registerSyncAckRoutes(app, {
    path: '/private-entry/checkpoint', allowedOrigins: [ORIGIN], allowInsecureLoopback: true,
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    maxBodyBytes: options.maxBodyBytes ?? 16_384,
    maxWarnings: options.maxWarnings ?? 8,
    maxWarningBytes: options.maxWarningBytes ?? 2_048,
    credentialVerifier: { async verify({ authorization }) {
      if (authorization !== AUTHORIZATION) throw new Error('denied');
      return mintVerifiedExtensionCredentialFixture({ issuer: 'https://issuer.example', audience: 'known-api',
        clientId: 'known-extension', subject: 'ack-subject', credentialId: 'ack-credential' });
    } },
    application: { async acknowledge(input) {
      calls.push(input);
      return options.acknowledge?.(input) ?? {
        replicaId: 'ack-replica', ackedCursor: input.request.cursor, ackedAt: '2026-07-26T12:00:00.000Z',
      };
    } },
  });
  await app.listen({ host: '127.0.0.1', port: 0 }); apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  return { origin: `http://127.0.0.1:${address.port}`, calls };
}

function ack(origin: string, init: { readonly key?: string; readonly body?: string } = {}) {
  return fetch(`${origin}/private-entry/checkpoint`, { method: 'POST', headers: {
    Accept: 'application/json', Authorization: AUTHORIZATION, Origin: ORIGIN,
    'Content-Type': 'application/json', 'Idempotency-Key': init.key ?? 'ack-key-1',
  }, body: init.body ?? JSON.stringify({ sessionId: 'ack-session', cursor: 'ack-cursor', warnings: [] }) });
}

test('uses the public syncAck contract and advertises only the Manifest endpoint key', () => {
  assert.deepEqual(endpointContracts.syncAck.operations[0], { method: 'POST', profile: 'sync',
    request: 'syncAckRequest', response: 'syncAckResult', successStatuses: [200],
    requiredRequestHeaders: ['Idempotency-Key'] });
  const candidate = createPublicationManifestCandidate({ origin: 'https://known.example', mountPath: '/colp/v0.1/',
    serverUuid: '019f9d33-2211-7111-8111-111111111111', title: 'Known', maxPageSize: 100,
    maxSnapshotNodes: 10_000, endpoints: { directory: 'https://known.example/directory',
      collection: 'https://known.example/collections/{collectionId}',
      snapshot: 'https://known.example/collections/{collectionId}/snapshot',
      syncAck: 'https://known.example/private-entry/checkpoint' } },
  ['directory', 'collection', 'snapshot', 'syncAck']);
  assert.equal(candidate.manifest.mounts[0]?.endpoints.syncAck,
    'https://known.example/private-entry/checkpoint');
  assert.deepEqual(candidate.manifest.mounts[0]?.profiles, ['core']);
});

test('authenticates before parsing attacker JSON and returns strict private syncAckResult', async () => {
  const server = await start();
  const denied = await fetch(`${server.origin}/private-entry/checkpoint`, { method: 'POST', headers: {
    Authorization: 'Bearer invalid', Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': 'bad',
  }, body: '{"secret":"ATTACKER-BOOKMARK-TEXT",' });
  assert.equal(denied.status, 401); assert.deepEqual(server.calls, []);
  const response = await ack(server.origin);
  const body = await response.json() as SyncAckResult;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(createValidatorRegistry().validate('syncAckResult', body).valid, true);
  assert.deepEqual(body, { replicaId: 'ack-replica', ackedCursor: 'ack-cursor',
    ackedAt: '2026-07-26T12:00:00.000Z' });
});

test('requires raw singleton auth/origin/content-type/idempotency headers', async () => {
  for (const duplicate of ['Authorization', 'Origin', 'Content-Type', 'Idempotency-Key']) {
    const server = await start();
    const url = new URL('/private-entry/checkpoint', server.origin);
    const status = await new Promise<number>((resolve, reject) => {
      const headers = ['Authorization', AUTHORIZATION, 'Origin', ORIGIN, 'Content-Type', 'application/json',
        'Idempotency-Key', 'ack-key'];
      headers.push(duplicate, duplicate === 'Authorization' ? 'Bearer other' : duplicate === 'Content-Type'
        ? 'text/plain' : duplicate === 'Idempotency-Key' ? 'other-key' : ORIGIN);
      const request = rawRequest({ hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'POST', headers }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
      request.on('error', reject); request.end('{"sessionId":"ack-session","cursor":"ack-cursor","warnings":[]}');
    });
    assert.equal(status, 400); assert.deepEqual(server.calls, []);
  }
});

test('rejects duplicate JSON members, unknown fields and warning budget abuse', async () => {
  const server = await start({ maxWarnings: 1, maxWarningBytes: 80 });
  const queried = await fetch(`${server.origin}/private-entry/checkpoint?sessionId=attacker`, { method: 'POST',
    headers: { Authorization: AUTHORIZATION, Origin: ORIGIN, 'Content-Type': 'application/json',
      'Idempotency-Key': 'query-key' },
    body: JSON.stringify({ sessionId: 'a', cursor: 'c', warnings: [] }) });
  assert.equal(queried.status, 400);
  for (const [body, expectedStatus] of [
    ['{"sessionId":"a","sessionId":"b","cursor":"c","warnings":[]}', 400],
    ['{"sessionId":"a","cursor":"c","warnings":[],"ordinal":999}', 422],
    [JSON.stringify({ sessionId: 'a', cursor: 'c', warnings: [
      { code: 'one', message: 'ok' }, { code: 'two', message: 'no' },
    ] }), 422],
    [JSON.stringify({ sessionId: 'a', cursor: 'c', warnings: [
      { code: 'private', message: 'https://private.example/bookmark?token=secret' },
    ] }), 422],
  ] as const) {
    const response = await ack(server.origin, { body });
    assert.equal(response.status, expectedStatus);
  }
  assert.deepEqual(server.calls, []);
});

test('rejects prototype-shaped members before acknowledging a cursor', async () => {
  const server = await start();
  const validBody = JSON.stringify({ sessionId: 'ack-session', cursor: 'ack-cursor', warnings: [] });
  for (const body of prototypeMemberJsonBodies(validBody)) {
    const response = await ack(server.origin, { body });
    const text = await response.text();
    assert.equal(response.status, 400, body);
    assert.equal((JSON.parse(text) as { code: string }).code, 'invalid_json');
    assert.doesNotMatch(text, /__proto__|P3-22-ACK-SECRET/u);
  }
  assert.deepEqual(server.calls, []);
});

test('maps application failures to registered Problems without reflecting private input', async () => {
  for (const [code, status] of [['invalid_cursor_scope', 400], ['sync_cursor_expired', 410],
    ['stale_replica', 410], ['replica_retired', 410], ['idempotency_key_reused', 409],
    ['resource_not_found', 404]] as const) {
    const server = await start({ acknowledge: async () => { throw new SyncAckError(code); } });
    const response = await ack(server.origin, { body: JSON.stringify({ sessionId: 'ack-session',
      cursor: 'SECRET-CURSOR-MARKER', warnings: [] }) });
    const text = await response.text();
    assert.equal(response.status, status); assert.doesNotMatch(text, /SECRET-CURSOR-MARKER/u);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(createValidatorRegistry().validate('problem', JSON.parse(text)).valid, true);
  }
});
