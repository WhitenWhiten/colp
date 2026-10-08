import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { afterEach, describe, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { Manifest, Problem, SyncPush, SyncPushResult } from '@know-n/colp/types';
import { problemRegistry } from '@know-n/colp/server';
import { prototypeMemberJsonBodies } from '../../support/prototype-member-json.js';
import { createPublicationManifestCandidate } from '../../../src/modules/publication/index.js';
import { loadConfig } from '../../support/test-config.js';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createMemorySyncAdmissionPolicy,
  type SyncAdmissionPolicy,
} from '../../../src/infrastructure/rate-limit/index.js';
import { registerSyncPushRoutes, SyncPushHttpError } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { syncPushAdmissionRequest } from '../../fixtures/phase3/sync-push-admission.js';
import {
  P3_16_FORBIDDEN_METRIC_MARKERS,
  P3_16_PUSH_OUTCOMES,
  P3_16_SEQUENCE_RECOVERY,
} from '../../fixtures/phase3/sync-push-sequence-acceptance.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function problem(body: Problem | SyncPushResult): Problem {
  assert.ok('code' in body, 'expected COLP Problem');
  return body;
}
const TOKEN = 'push-unit-secret-token-marker';
const apps: FastifyInstance[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function manifest(origin: string): Manifest {
  return {
    protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019f97ff-1111-7111-8111-111111111111', title: 'Known',
    mounts: [{
      id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
      endpoints: { syncPush: `${origin}/private-entry/operation-ingress` },
      features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
        minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 },
    }],
  } as Manifest;
}

async function start(options: {
  readonly maxRequests?: number;
  readonly bodyLimitBytes?: number;
  readonly maxJsonDepth?: number;
  readonly maxJsonMembers?: number;
  readonly allowInsecureLoopback?: boolean;
  readonly admitResult?: SyncPushResult;
  readonly admission?: SyncAdmissionPolicy;
} = {}) {
  const calls: string[] = [];
  const app = Fastify({ logger: false });
  registerSyncPushRoutes(app, {
    path: '/private-entry/operation-ingress', allowedOrigins: [ORIGIN],
    credentialVerifier: { async verify() {
      calls.push('credential');
      return mintVerifiedExtensionCredentialFixture({
        issuer: 'https://issuer.example', audience: 'known-api', clientId: 'known-extension',
        subject: 'push-subject', credentialId: 'push-credential',
      });
    } },
    application: {
      runtimeOwnership: { operationIdReservationOwner: 'sequence', usesPushCoordinator: false,
        maxBatchOperations: 1, evaluator: 'canonical_node_create' },
      async admit() {
        calls.push('admission');
        if (options.admitResult !== undefined) return options.admitResult;
        throw new SyncPushHttpError('unsupported_operation');
      },
    },
    rateLimit: { maxRequests: options.maxRequests ?? 100, windowMs: 60_000 },
    maxBatchOperations: 1,
    allowInsecureLoopback: options.allowInsecureLoopback ?? true,
    ...(options.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: options.bodyLimitBytes }),
    ...(options.maxJsonDepth === undefined ? {} : { maxJsonDepth: options.maxJsonDepth }),
    ...(options.maxJsonMembers === undefined ? {} : { maxJsonMembers: options.maxJsonMembers }),
    ...(options.admission === undefined ? {} : { admission: options.admission }),
  });
  app.get('/.well-known/collection-protocol', async () => {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    return manifest(`http://127.0.0.1:${address.port}`);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  return { origin: `http://127.0.0.1:${address.port}`, calls };
}

async function post(origin: string, request: SyncPush = syncPushAdmissionRequest()) {
  return fetch(`${origin}/private-entry/operation-ingress`, {
    method: 'POST', headers: {
      Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'Content-Type': 'application/json',
      'Idempotency-Key': 'push-key-1',
    }, body: JSON.stringify(request),
  });
}

describe('P3-11 single-operation Sync Push HTTP admission', () => {
  test('registers unsupported_operation as a non-retryable COLP Problem', () => {
    assert.deepEqual(problemRegistry.unsupported_operation, { status: 422, retryable: false });
    assert.equal(createValidatorRegistry().validate('problem', {
      type: 'https://know-n.com/colp/problems/unsupported_operation',
      title: 'Unsupported operation', status: 422, code: 'unsupported_operation', retryable: false,
    }).valid, true);
  });

  test('publishes only the configured syncPush candidate without claiming sync', () => {
    const candidate = createPublicationManifestCandidate({
      origin: 'https://known.example', mountPath: '/colp/v0.1/',
      serverUuid: '019f97ff-1111-7111-8111-111111111111', title: 'Known',
      maxPageSize: 100, maxSnapshotNodes: 10_000,
      endpoints: {
        directory: 'https://known.example/colp/v0.1/directory',
        collection: 'https://known.example/colp/v0.1/collections/{collectionId}',
        snapshot: 'https://known.example/colp/v0.1/collections/{collectionId}/snapshot',
        syncPush: 'https://known.example/private-entry/operation-ingress',
      },
    }, ['directory', 'collection', 'snapshot', 'syncPush']);
    assert.deepEqual(candidate.manifest.mounts[0]?.profiles, ['core']);
    assert.equal(candidate.manifest.mounts[0]?.endpoints.syncPush,
      'https://known.example/private-entry/operation-ingress');
  });

  test('loads a distinct config-backed syncPush path and fails closed on invalid configuration', () => {
    const loaded = loadConfig(syncEnv());
    assert.equal(loaded.syncSession?.push.path, '/colp/v0.1/sync/push');
    assert.equal(loaded.syncSession?.push.maxBatchOperations, 1);
    assert.equal(loaded.syncSession?.push.managedBookmarkWrites, false);
    assert.equal(loadConfig(syncEnv({ SYNC_MANAGED_BOOKMARK_WRITES: 'true' }))
      .syncSession?.push.managedBookmarkWrites, true);
    assert.equal(loaded.publication.endpoints.syncPush, 'https://known.example/colp/v0.1/sync/push');
    assert.equal(loaded.syncSession?.conflict.path,
      '/colp/v0.1/sync/conflicts/{conflictId}/resolve');
    assert.equal(loaded.publication.endpoints.syncConflict,
      'https://known.example/colp/v0.1/sync/conflicts/{conflictId}/resolve');
    assert.throws(() => loadConfig(syncEnv({ SYNC_CONFLICT_PATH:
      '/colp/v0.1/sync/conflicts/{wrongId}/resolve' })), /SYNC_CONFLICT_PATH/u);
    assert.throws(() => loadConfig(syncEnv({ SYNC_CONFLICT_RATE_LIMIT_MAX: '0' })),
      /SYNC_CONFLICT_RATE_LIMIT_MAX/u);
    assert.throws(() => loadConfig(syncEnv({ SYNC_PUSH_PATH: loaded.syncSession?.path })), /SYNC_PUSH_PATH/u);
    assert.throws(() => loadConfig(syncEnv({ SYNC_PUSH_RATE_LIMIT_MAX: '0' })), /SYNC_PUSH_RATE_LIMIT_MAX/u);
    assert.throws(() => loadConfig(syncEnv({ SYNC_MAX_BATCH_OPERATIONS: '2' })), /SYNC_MAX_BATCH_OPERATIONS/u);
    assert.throws(() => loadConfig(syncEnv({ SYNC_MANAGED_BOOKMARK_WRITES: 'yes' })),
      /SYNC_MANAGED_BOOKMARK_WRITES/u);
    const app = Fastify({ logger: false });
    apps.push(app);
    assert.throws(() => registerSyncPushRoutes(app, {
      path: '/private-entry/operation-ingress', allowedOrigins: [ORIGIN],
      credentialVerifier: { async verify() { throw new Error('not invoked'); } },
      application: { runtimeOwnership: { operationIdReservationOwner: 'sequence',
        usesPushCoordinator: true as never, maxBatchOperations: 1,
        evaluator: 'canonical_node_create' }, async admit(): Promise<never> { throw new Error('not invoked'); } },
      rateLimit: { maxRequests: 1, windowMs: 1_000 }, maxBatchOperations: 1,
    }), /runtime ownership probe/u);
  });

  test('black-box client discovers the endpoint and receives explicit fail-closed denial', async () => {
    const server = await start();
    const client = createSyncSessionBlackBoxClient({
      manifestUrl: `${server.origin}/.well-known/collection-protocol`, mountId: 'known-sync-entry',
      authorization: `Bearer ${TOKEN}`, origin: ORIGIN,
    });
    const response = await client.push({ idempotencyKey: 'push-key-1', request: syncPushAdmissionRequest() });
    assert.equal(response.status, 422);
    assert.equal(problem(response.body).code, 'unsupported_operation');
    assert.equal(problem(response.body).retryable, false);
    assert.deepEqual(server.calls, ['credential', 'admission']);
  });

  test('returns 200 with a schema-valid SyncPushResult, private no-store headers and no reflected secrets', async () => {
    const request = syncPushAdmissionRequest({ replicaId: 'replica-secret-marker' });
    const result: SyncPushResult = {
      batchId: request.batchId,
      results: [{
        opId: request.operations[0]!.opId,
        sequence: request.operations[0]!.sequence,
        status: 'applied',
        targetId: request.operations[0]!.targetId,
        revision: 'push-node-r2',
        cursor: 'sync-100',
        warnings: [],
      }],
      serverCursor: 'sync-100',
    };
    const server = await start({ admitResult: result });
    const response = await post(server.origin, request);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/u);
    const body = JSON.parse(text) as SyncPushResult;
    assert.equal(createValidatorRegistry().validate('syncPushResult', body).valid, true);
    assert.deepEqual(body, result);
    assert.deepEqual(server.calls, ['credential', 'admission']);
    assert.doesNotMatch(text, /push-unit-secret|replica-secret/u);
  });

  test('requires exactly one operation at runtime before authentication or Sequence admission', async () => {
    for (const operations of [[], [
      syncPushAdmissionRequest().operations[0]!, syncPushAdmissionRequest({ opId: 'push-operation-2', sequence: 2 }).operations[0]!,
    ]]) {
      const server = await start();
      const response = await post(server.origin, { ...syncPushAdmissionRequest(), operations } as SyncPush);
      assert.equal(response.status, 422);
      assert.equal((await response.json() as { code: string }).code, 'invalid_document');
      assert.deepEqual(server.calls, []);
    }
  });

  test('rejects every Session-unbound batchId form with a 4xx problem before credential verification', async () => {
    const sessionId = 'push-session-1';
    const unbound: readonly string[] = [
      `${sessionId}:opaque-1`, // retired colon segment form
      `${sessionId}/opaque-1`, // retired slash segment form
      `${sessionId}.`, // empty dot suffix
      `other-session.${'opaque-1'}`, // cross-session prefix
      'client-selected-unbound-batch', // arbitrary opaque id
    ];
    for (const batchId of unbound) {
      const server = await start();
      const request = syncPushAdmissionRequest({ sessionId, batchId });
      const response = await post(server.origin, request);
      assert.equal(response.status, 422, batchId);
      assert.equal(problem(await response.json() as Problem).code, 'invalid_document', batchId);
      assert.deepEqual(server.calls, [], batchId);
    }
    const bound = await start();
    const accepted = await post(bound.origin, syncPushAdmissionRequest({
      sessionId, batchId: `${sessionId}.opaque-1`,
    }));
    assert.equal(accepted.status, 422);
    assert.equal(problem(await accepted.json() as Problem).code, 'unsupported_operation');
    assert.deepEqual(bound.calls, ['credential', 'admission']);
  });

  test('rejects unsafe sequence, opId and operation kind through strict COLP validation', async () => {
    const operation = syncPushAdmissionRequest().operations[0]!;
    const invalid: readonly { readonly body: unknown; readonly status: number; readonly code: string }[] = [
      { body: { ...syncPushAdmissionRequest(), operations: [{ ...operation, sequence: 0 }] },
        status: 422, code: 'invalid_document' },
      { body: { ...syncPushAdmissionRequest(), operations: [{ ...operation, sequence: 9007199254740992 }] },
        status: 400, code: 'invalid_json' },
      { body: { ...syncPushAdmissionRequest(), operations: [{ ...operation, opId: '' }] },
        status: 422, code: 'invalid_document' },
      { body: { ...syncPushAdmissionRequest(), operations: [{ ...operation, type: 'set_access_policy' }] },
        status: 422, code: 'invalid_document' },
    ];
    for (const invalidCase of invalid) {
      const server = await start();
      const response = await fetch(`${server.origin}/private-entry/operation-ingress`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN,
          'Content-Type': 'application/json', 'Idempotency-Key': 'invalid-operation' },
        body: JSON.stringify(invalidCase.body),
      });
      assert.equal(response.status, invalidCase.status);
      assert.equal((await response.json() as { code: string }).code, invalidCase.code);
      assert.deepEqual(server.calls, []);
    }
  });

  test('rejects every duplicate singleton header before credential verification', async () => {
    for (const duplicate of ['Authorization', 'Idempotency-Key', 'Origin', 'Content-Type']) {
      const server = await start();
      const url = new URL('/private-entry/operation-ingress', server.origin);
      const response = await new Promise<{ status: number }>((resolve, reject) => {
        const headers = [
          'Authorization', `Bearer ${TOKEN}`, 'Idempotency-Key', 'push-key-1',
          'Origin', ORIGIN, 'Content-Type', 'application/json',
        ];
        headers.push(duplicate, duplicate === 'Authorization' ? 'Bearer other'
          : duplicate === 'Idempotency-Key' ? 'push-key-2'
            : duplicate === 'Origin' ? ORIGIN : 'application/json');
        const req = rawRequest({ hostname: url.hostname, port: url.port, path: url.pathname,
          method: 'POST', headers }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 })); });
        req.on('error', reject); req.end(JSON.stringify(syncPushAdmissionRequest()));
      });
      assert.equal(response.status, 400);
      assert.deepEqual(server.calls, []);
    }
  });

  test('rejects forged forwarded TLS and never reflects credential, client batch or payload markers', async () => {
    const insecure = await start({ allowInsecureLoopback: false });
    const denied = await fetch(`${insecure.origin}/private-entry/operation-ingress`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN,
        'Content-Type': 'application/json', 'Idempotency-Key': 'tls-denial',
        'X-Forwarded-Proto': 'https' }, body: JSON.stringify(syncPushAdmissionRequest()),
    });
    assert.equal(denied.status, 401);
    assert.deepEqual(insecure.calls, []);
    const server = await start();
    const request = syncPushAdmissionRequest({ batchId: 'CLIENT-BATCH-SECRET-MARKER' });
    const operation = request.operations[0]!;
    const response = await post(server.origin, {
      ...request, operations: [{ ...operation, payload: {
        base: { title: 'PAYLOAD-SECRET-MARKER' }, value: { title: 'Changed' },
      } }],
    } as SyncPush);
    const text = await response.text();
    assert.equal(response.status, 422);
    assert.doesNotMatch(text, /push-unit-secret|CLIENT-BATCH|PAYLOAD-SECRET/u);
  });

  test('enforces media type, I-JSON budgets and rate limit before application admission', async () => {
    const plain = await start();
    const media = await fetch(`${plain.origin}/private-entry/operation-ingress`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN,
        'Content-Type': 'text/plain', 'Idempotency-Key': 'media' }, body: '{}',
    });
    assert.equal(media.status, 415);
    assert.deepEqual(plain.calls, []);
    for (const options of [{ bodyLimitBytes: 32 }, { maxJsonDepth: 3 }, { maxJsonMembers: 5 }]) {
      const server = await start(options);
      const response = await post(server.origin);
      assert.equal(response.status, 413);
      assert.deepEqual(server.calls, []);
    }
    const limited = await start({ maxRequests: 1 });
    assert.equal((await post(limited.origin)).status, 422);
    const denied = await post(limited.origin);
    assert.equal(denied.status, 429);
    assert.equal((await denied.json() as { code: string }).code, 'rate_limited');
  });

  test('rejects prototype-shaped members before application admission', async () => {
    const server = await start();
    for (const body of prototypeMemberJsonBodies(JSON.stringify(syncPushAdmissionRequest()))) {
      const response = await fetch(server.origin + '/private-entry/operation-ingress', {
        method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN,
          'Content-Type': 'application/json', 'Idempotency-Key': 'prototype-member' }, body,
      });
      const text = await response.text();
      assert.equal(response.status, 400, body);
      assert.equal((JSON.parse(text) as { code: string }).code, 'invalid_json');
      assert.doesNotMatch(text, /__proto__|push-unit-secret/u);
    }
    assert.equal(server.calls.includes('admission'), false);
  });

  test('rejects duplicate JSON members and invalid UTF-8 bytes before credential verification', async () => {
    for (const body of [
      Buffer.from(JSON.stringify(syncPushAdmissionRequest()).replace(
        '"atomic":false', '"atomic":false,"atomic":false'), 'utf8'),
      Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]),
    ]) {
      const server = await start();
      const url = new URL('/private-entry/operation-ingress', server.origin);
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = rawRequest({ hostname: url.hostname, port: url.port, path: url.pathname,
          method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN,
            'Content-Type': 'application/json', 'Idempotency-Key': 'invalid-ijson',
            'Content-Length': String(body.length) } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(body);
      });
      assert.equal(response.status, 400);
      assert.match(response.body, /invalid_json/u);
      assert.deepEqual(server.calls, []);
    }
  });

  test('maps retryable database and unknown-commit failures to redacted service unavailable Problems', async () => {
    for (const kind of ['lock_timeout', 'deadlock', 'serialization_failure', 'unavailable',
      'commit_outcome_unknown'] as const) {
      const app = Fastify({ logger: false });
      registerSyncPushRoutes(app, {
        path: '/private-entry/operation-ingress', allowedOrigins: [ORIGIN],
        credentialVerifier: { async verify() {
          return mintVerifiedExtensionCredentialFixture({
            issuer: 'https://issuer.example', audience: 'known-api', clientId: 'known-extension',
            subject: 'push-subject', credentialId: 'push-credential',
          });
        } },
        application: {
          runtimeOwnership: { operationIdReservationOwner: 'sequence', usesPushCoordinator: false,
            maxBatchOperations: 1, evaluator: 'canonical_node_create' },
          async admit(): Promise<never> {
            throw new DatabaseOperationError(kind, new Error(`DATABASE-SECRET-${kind}`));
          },
        },
        rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxBatchOperations: 1,
        allowInsecureLoopback: true,
      });
      apps.push(app);
      const response = await app.inject({
        method: 'POST',
        url: '/private-entry/operation-ingress',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          origin: ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': 'push-key-1',
        },
        payload: syncPushAdmissionRequest(),
      });
      const body = response.body;
      assert.equal(response.statusCode, 503);
      assert.match(body, /service_unavailable/u);
      assert.doesNotMatch(body, /DATABASE-SECRET/u);
    }
  });

  test('publishes bounded P3-16 Push metrics without request identity or content labels', async () => {
    const observedNames: string[] = [];
    const metrics = new InMemoryMetrics({ onIncrement: (name) => observedNames.push(name) });
    const app = Fastify({ logger: false });
    registerSyncPushRoutes(app, {
      path: '/private-entry/operation-ingress', allowedOrigins: [ORIGIN], metrics,
      credentialVerifier: { async verify() {
        return mintVerifiedExtensionCredentialFixture({
          issuer: 'https://issuer.example', audience: 'known-api', clientId: 'known-extension',
          subject: 'push-subject', credentialId: 'push-credential',
        });
      } },
      application: {
        runtimeOwnership: { operationIdReservationOwner: 'sequence', usesPushCoordinator: false,
          maxBatchOperations: 1, evaluator: 'canonical_node_create' },
        async admit() { throw new SyncPushHttpError('sequence_gap', undefined, 1); },
      },
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxBatchOperations: 1,
      allowInsecureLoopback: true,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/private-entry/operation-ingress',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': 'push-key-1',
      },
      payload: syncPushAdmissionRequest({
        replicaId: 'replica-secret-marker', opId: 'operation-secret-marker',
      }),
    });
    assert.equal(response.statusCode, P3_16_SEQUENCE_RECOVERY.sequence_gap.status);
    const body = response.json<Problem>();
    assert.equal(body.code, 'sequence_gap');
    assert.equal(body.expectedSequence, P3_16_SEQUENCE_RECOVERY.sequence_gap.expectedSequence);
    assert.equal(body.retryable, true);
    assert.equal(metrics.get('sync.push.requests_total'), 1);
    assert.equal(metrics.get('sync.push.outcome.sequence_gap'), 1);
    assert.equal(metrics.observations('sync.push.duration_ms').length, 1);
    assert.ok(observedNames.every((name) => P3_16_PUSH_OUTCOMES.some((outcome) =>
      name === 'sync.push.requests_total' || name === `sync.push.outcome.${outcome}`)));
    const serializedNames = observedNames.join(' ').toLowerCase();
    for (const marker of P3_16_FORBIDDEN_METRIC_MARKERS) {
      assert.equal(serializedNames.includes(marker), false);
    }
  });

  test('injected memory limiter max=1 returns rate_limited on the second push', async () => {
    const limited = await start({
      admission: createMemorySyncAdmissionPolicy({
        budgets: { push: { maxRequests: 1, windowMs: 60_000 } },
      }),
    });
    assert.equal((await post(limited.origin)).status, 422);
    const denied = await post(limited.origin);
    assert.equal(denied.status, 429);
    assert.equal((await denied.json() as { code: string }).code, 'rate_limited');
  });

  test('two Fastify apps sharing one admission policy exhaust push together', async () => {
    const admission = createMemorySyncAdmissionPolicy({
      budgets: { push: { maxRequests: 1, windowMs: 60_000 } },
    });
    const left = await start({ admission });
    const right = await start({ admission });
    assert.equal((await post(left.origin)).status, 422);
    const denied = await post(right.origin);
    assert.equal(denied.status, 429);
    assert.equal((await denied.json() as { code: string }).code, 'rate_limited');
    assert.deepEqual(right.calls, []);
  });

  test('injected failing limiter returns service_unavailable and never admits', async () => {
    const failing: SyncAdmissionPolicy = {
      admitPreAuth: async () => ({ kind: 'failed', reason: 'limiter_unavailable' }),
      admitSubject: async () => ({ kind: 'failed', reason: 'limiter_unavailable' }),
      readiness: () => ({ status: 'degraded', reason: 'last_command_failed' }),
      close: async () => undefined,
    };
    const server = await start({ admission: failing });
    const response = await post(server.origin);
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { code: string }).code, 'service_unavailable');
    assert.deepEqual(server.calls, []);
  });
});

function syncEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test', DATABASE_URL: 'postgres://unused/known', LOG_LEVEL: 'silent',
    // FIX-H-001: OIDC_ALLOW_TEST_PROVIDER now defaults to false everywhere, so a
    // real-provider shape-only JWKS placeholder is required for loadConfig to
    // succeed (never fetched).
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    PRODUCT_ORIGIN: 'https://known.example', PUBLICATION_ORIGIN: 'https://known.example',
    SYNC_SESSION_ENABLED: 'true', SYNC_EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop',
    SYNC_OAUTH_ISSUER: 'https://issuer.example.test', SYNC_OAUTH_CLIENT_ID: 'known-extension',
    SYNC_OAUTH_AUDIENCE: 'known-sync-api',
    SYNC_OAUTH_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/oauth2/authorize',
    SYNC_OAUTH_TOKEN_ENDPOINT: 'https://issuer.example.test/oauth2/token',
    SYNC_OAUTH_JWKS_URI: 'https://issuer.example.test/.well-known/jwks.json',
    SYNC_OAUTH_REDIRECT_URI: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback',
    SYNC_OAUTH_SCOPES: 'openid known.sync', SYNC_OAUTH_ALGORITHMS: 'RS256',
    SYNC_SESSION_REPLAY_KEY: Buffer.alloc(32, 23).toString('base64'),
    SYNC_SNAPSHOT_CURSOR_KEY: Buffer.alloc(32, 29).toString('base64'),
    SYNC_SNAPSHOT_CURSOR_KEY_ID: 'test-sync-snapshot-v1',
    SYNC_PULL_CURSOR_KEY_ID: 'test-sync-pull-v1',
    SYNC_PULL_CURSOR_KEY: Buffer.alloc(32, 41).toString('base64'),
    SYNC_RECOVERY_CAPABILITY_KEY_ID: 'recovery-v1',
    SYNC_RECOVERY_CAPABILITY_KEY: Buffer.alloc(32, 44).toString('base64'),
    SYNC_PULL_LINEAGE_KEY_ID: 'lineage-v1',
    SYNC_PULL_LINEAGE_KEY: Buffer.alloc(32, 47).toString('base64'),
    ...overrides,
  };
}
