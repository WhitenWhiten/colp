/**
 * SYNC-Q-014: pre-auth denial must not call credential verification on any
 * of the eight Sync HTTP purposes.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SyncAdmissionPolicy } from '../../../src/infrastructure/rate-limit/index.js';
import { registerSyncAckRoutes } from '../../../src/transport/colp-sync/sync-ack-routes.js';
import { registerSyncConflictRoutes } from '../../../src/transport/colp-sync/sync-conflict-routes.js';
import { registerSyncEffectPageRoutes } from '../../../src/transport/colp-sync/sync-effect-page-routes.js';
import { registerSyncPullRoutes } from '../../../src/transport/colp-sync/sync-pull-routes.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { registerSyncRetireRoutes } from '../../../src/transport/colp-sync/sync-retire-routes.js';
import { registerSyncSessionRoutes } from '../../../src/transport/colp-sync/sync-session-routes.js';
import { registerSyncSnapshotRoutes } from '../../../src/transport/colp-sync/sync-snapshot-routes.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function denyAll(): SyncAdmissionPolicy {
  return {
    admitPreAuth: async () => ({ kind: 'denied', retryAfterSeconds: 7 }),
    admitSubject: async () => ({ kind: 'denied', retryAfterSeconds: 7 }),
    readiness: () => ({ status: 'healthy', reason: 'none' }),
    close: async () => undefined,
  };
}

async function credential() {
  return mintVerifiedExtensionCredentialFixture({
    issuer: 'https://issuer.example', audience: 'known-api', clientId: 'known-extension',
    subject: 'q014-subject', credentialId: 'q014-credential',
  });
}

const jsonHeaders = {
  authorization: 'Bearer q014-token',
  origin: ORIGIN,
  'content-type': 'application/json',
  'idempotency-key': 'q014-key',
};
const getHeaders = {
  authorization: 'Bearer q014-token',
  origin: ORIGIN,
  'known-sync-session': 'session-q014',
};
const retireHeaders = {
  authorization: 'Bearer q014-token',
  origin: ORIGIN,
  'idempotency-key': 'q014-key',
  'known-sync-session': 'session-q014',
};

describe('SYNC-Q-014 pre-auth before JWKS', () => {
  test('conflict/ack/retire/snapshot/session/push/pull/effect-page skip verify when denied', async () => {
    let verifyCount = 0;
    const verifier = {
      async verify() {
        verifyCount += 1;
        return credential();
      },
    };
    const admission = denyAll();
    const rateLimit = { maxRequests: 100, windowMs: 60_000 };
    const app = Fastify({ logger: false });
    registerSyncConflictRoutes(app, {
      pathTemplate: '/private-entry/conflicts/{conflictId}/decision',
      credentialVerifier: verifier, admission, rateLimit, allowedOrigins: [ORIGIN],
      allowInsecureLoopback: true,
      application: { async resolve(): Promise<never> { throw new Error('not called'); } },
    });
    registerSyncAckRoutes(app, {
      path: '/private-entry/checkpoint', credentialVerifier: verifier, admission, rateLimit,
      allowedOrigins: [ORIGIN], allowInsecureLoopback: true,
      maxBodyBytes: 16_384, maxWarnings: 8, maxWarningBytes: 2_048,
      application: { async acknowledge(): Promise<never> { throw new Error('not called'); } },
    });
    registerSyncRetireRoutes(app, {
      path: '/extension-internal/sync/replica', credentialVerifier: verifier, admission, rateLimit,
      allowedOrigins: [ORIGIN], allowInsecureLoopback: true,
      application: { async retireExtension(): Promise<never> { throw new Error('not called'); } },
    });
    registerSyncSnapshotRoutes(app, {
      path: '/private-entry/snapshot-download', credentialVerifier: verifier, admission, rateLimit,
      allowedOrigins: [ORIGIN], allowInsecureLoopback: true,
      application: { async query(): Promise<never> { throw new Error('not called'); } },
    });
    registerSyncSessionRoutes(app, {
      path: '/private-entry/session-negotiation', credentialVerifier: verifier, admission, rateLimit,
      allowedOrigins: [ORIGIN], allowInsecureLoopback: true,
      application: { async issue(): Promise<never> { throw new Error('not called'); } },
    });
    registerSyncPushRoutes(app, {
      path: '/private-entry/operation-ingress', credentialVerifier: verifier, admission, rateLimit,
      allowedOrigins: [ORIGIN], allowInsecureLoopback: true, maxBatchOperations: 1,
      application: {
        runtimeOwnership: {
          operationIdReservationOwner: 'sequence', usesPushCoordinator: false,
          maxBatchOperations: 1, evaluator: 'canonical_node_create',
        },
        async admit(): Promise<never> { throw new Error('not called'); },
      },
    });
    registerSyncPullRoutes(app, {
      path: '/private-entry/event-stream', credentialVerifier: verifier, admission, rateLimit,
      allowedOrigins: [ORIGIN], allowInsecureLoopback: true, maxLimit: 100,
      responseBudgetBytes: 65_536, requestTimeoutMs: 5_000, recommendedPullAfterSeconds: 5,
      reader: { async read(): Promise<never> { throw new Error('not called'); } },
    });
    registerSyncEffectPageRoutes(app, {
      pathTemplate: '/private/effects/{effectId}/{pageNumber}', credentialVerifier: verifier,
      admission, allowedOrigins: [ORIGIN], allowInsecureLoopback: true, responseBudgetBytes: 16_384,
      rateLimit: { subjectMaxRequests: 100, effectMaxRequests: 100, ipMaxRequests: 100, windowMs: 60_000 },
      reader: { async read(): Promise<never> { throw new Error('not called'); } },
    });
    await app.ready();
    apps.push(app);

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/private-entry/conflicts/conflict-1/decision?sessionId=session-1&replicaId=replica-1&collectionId=collection-1',
        headers: { ...jsonHeaders, 'if-match': '"conflict-r1"' },
        payload: { resolution: 'custom', value: 'x', baseConflictRevision: 'conflict-r1' },
      }),
      app.inject({
        method: 'POST', url: '/private-entry/checkpoint', headers: jsonHeaders,
        payload: { sessionId: 'session-q014', cursor: 'cursor-1', warnings: [] },
      }),
      app.inject({ method: 'DELETE', url: '/extension-internal/sync/replica', headers: retireHeaders }),
      app.inject({
        method: 'GET',
        url: '/private-entry/snapshot-download?sessionId=session-q014&limit=10',
        headers: getHeaders,
      }),
      app.inject({
        method: 'POST', url: '/private-entry/session-negotiation', headers: jsonHeaders,
        payload: {
          protocolVersion: '0.1',
          replica: {
            replicaId: 'replica-http-1', name: 'Chrome', kind: 'browser_extension',
            adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
            capabilities: {
              read: true, write: true, events: true, separator: true, alias: false,
              annotations: 'sidecar', maxBatchOperations: 1,
            },
            binding: {
              browserProfileId: 'profile-http-1', mountMode: 'mounted-folder',
              mountNativeId: 'mount-1', generation: 'browser-generation-1',
            },
          },
          scope: 'collection',
          collection: {
            collectionId: 'collection-http-1', lastCursor: null, lastRevision: null,
            bootstrapMode: 'download',
          },
          clientTime: '2026-07-25T10:00:00Z',
        },
      }),
      app.inject({
        method: 'POST', url: '/private-entry/operation-ingress', headers: jsonHeaders,
        payload: { operations: [] },
      }),
      app.inject({
        method: 'GET',
        url: '/private-entry/event-stream?sessionId=session-q014&limit=10',
        headers: getHeaders,
      }),
      app.inject({ method: 'GET', url: '/private/effects/effect-a/1', headers: getHeaders }),
    ]);

    for (const response of responses) {
      assert.equal(response.statusCode, 429, response.body);
      assert.equal(response.json().code, 'rate_limited');
    }
    assert.equal(verifyCount, 0);
  });
});
