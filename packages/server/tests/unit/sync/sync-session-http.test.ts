import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { createPublicationManifestCandidate } from '../../../src/modules/publication/index.js';
import { REPLICA_LEASE_BOUNDS } from '../../../src/modules/sync/index.js';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  EXTENSION_ORIGIN,
  SECRET_TOKEN,
  closeSyncSessionApps,
  request,
  result,
  routeDependencies,
  start,
  syncEnv,
  syncProductionEnv,
  trackSyncSessionApp,
} from '../../support/sync-session-http-harness.js';

afterEach(closeSyncSessionApps);

describe('P3-08 Sync Session HTTP surface', () => {
  test('production Manifest publishes only the syncSessions candidate without claiming sync', () => {
    const candidate = createPublicationManifestCandidate({
      origin: 'https://known.example', mountPath: '/colp/v0.1/',
      serverUuid: '019f97ff-1111-7111-8111-111111111111', title: 'Known',
      maxPageSize: 100, maxSnapshotNodes: 10_000,
      endpoints: {
        directory: 'https://known.example/colp/v0.1/directory',
        collection: 'https://known.example/colp/v0.1/collections/{collectionId}',
        snapshot: 'https://known.example/colp/v0.1/collections/{collectionId}/snapshot',
        syncSessions: 'https://known.example/private-entry/session-negotiation',
      },
    }, ['directory', 'collection', 'snapshot', 'syncSessions']);
    assert.deepEqual(candidate.manifest.mounts[0]?.profiles, ['core']);
    assert.equal(candidate.manifest.mounts[0]?.endpoints.syncSessions,
      'https://known.example/private-entry/session-negotiation');
    assert.equal(candidate.manifest.mounts[0]?.endpoints.syncSnapshot, undefined);
    assert.equal(candidate.manifest.mounts[0]?.auth.protectedResourceMetadata,
      'https://known.example/.well-known/oauth-protected-resource');
  });

  test('configuration and build composition fail closed instead of advertising a half-route', async () => {
    const enabled = loadConfig(syncEnv());
    assert.equal(enabled.syncSession?.apiInstanceCount, 1);
    assert.equal(enabled.syncSession?.allowInsecureLoopback, true);
    assert.equal(enabled.publication.endpoints.syncSessions,
      'https://known.example/colp/v0.1/sync/sessions');
    assert.equal(enabled.publication.endpoints.syncSnapshot,
      'https://known.example/colp/v0.1/sync/snapshot');
    assert.equal(enabled.publication.endpoints.syncPush,
      'https://known.example/colp/v0.1/sync/push');
    assert.equal(enabled.publication.endpoints.syncConflict,
      'https://known.example/colp/v0.1/sync/conflicts/{conflictId}/resolve');
    assert.throws(() => buildApiApp({ config: enabled }), /enabled together/u);
    assert.throws(() => loadConfig(syncEnv({ SYNC_API_INSTANCE_COUNT: '2' })),
      /SYNC_API_INSTANCE_COUNT/u);
    assert.throws(() => loadConfig(syncEnv({ SYNC_SESSION_ENABLED: 'truthy' })),
      /SYNC_SESSION_ENABLED/u);
    assert.throws(() => loadConfig(syncEnv({ SYNC_SESSION_REPLAY_KEY: '!!!!!!!!!!!!!!!!' })),
      /canonical base64/u);
    for (const key of [
      'DATABASE_URL', 'SYNC_EXTENSION_IDS', 'SYNC_OAUTH_ISSUER', 'SYNC_OAUTH_CLIENT_ID',
      'SYNC_OAUTH_AUDIENCE', 'SYNC_OAUTH_JWKS_URI', 'SYNC_SESSION_REPLAY_KEY',
      'SYNC_SNAPSHOT_CURSOR_KEY',
      'SYNC_SNAPSHOT_CURSOR_KEY_ID',
    ] as const) {
      assert.throws(() => loadConfig(syncEnv({ [key]: undefined })), key);
    }
    assert.throws(() => loadConfig(syncEnv({ SYNC_SESSION_RATE_LIMIT_MAX: '0' })),
      /SYNC_SESSION_RATE_LIMIT_MAX/u);
    assert.throws(() => loadConfig(syncProductionEnv({ TRUSTED_INGRESS: undefined })),
      /TRUSTED_INGRESS/u);
    assert.throws(
      () => loadConfig(syncProductionEnv({ TRUSTED_INGRESS: '', TRUSTED_PROXY_HOPS: '1' })),
      /TRUSTED_PROXY_HOPS/,
    );
    assert.equal(loadConfig(syncProductionEnv()).syncSession?.allowInsecureLoopback, false);
    assert.deepEqual(loadConfig(syncProductionEnv()).httpSecurity.trustedIngress, ['127.0.0.1']);
    assert.throws(
      () => loadConfig(syncProductionEnv({
        SYNC_OAUTH_JWKS_URI: 'https://169.254.169.254/jwks',
      })),
      /SYNC_OAUTH_JWKS_URI/,
    );
    assert.throws(
      () => loadConfig(syncProductionEnv({
        SYNC_OAUTH_JWKS_URI: 'https://10.0.0.5/jwks',
      })),
      /SYNC_OAUTH_JWKS_URI/,
    );
    assert.throws(
      () => loadConfig(syncEnv({
        SYNC_OAUTH_JWKS_URI: 'https://metadata.google.internal/jwks',
      })),
      /SYNC_OAUTH_JWKS_URI/,
    );

    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const runtimeSource = readFileSync(
      resolve(import.meta.dirname, '../../../src/bootstrap/sync-session-runtime.ts'),
      'utf8',
    );
    assert.match(runtimeSource, /createHardenedEgressFetch\(\{\s*label:\s*'Sync OAuth JWKS'\s*\}\)/);
    assert.match(runtimeSource, /AbortSignal\.timeout\(5_000\)/);

    const disabled = loadConfig({ DATABASE_URL: 'postgres://unused/known', LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' });
    const route = routeDependencies(enabled.syncSession!);
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
    assert.throws(() => buildApiApp({ config: disabled, syncSessionRoutes: route }), /enabled together/u);
    const mismatched = { ...route, path: '/different' };
    assert.throws(() => buildApiApp({ config: enabled, syncSessionRoutes: mismatched }),
      /advertised configuration/u);
    assert.throws(() => buildApiApp({ config: enabled, syncSessionRoutes: route,
      syncSnapshotRoutes: snapshotRoute }), /Sync Push config/u);

    const app = buildApiApp({ config: enabled, syncSessionRoutes: route,
      syncSnapshotRoutes: snapshotRoute, syncPushRoutes: pushRoute,
      syncConflictRoutes: conflictRoute, syncPullRoutes: pullRoute, syncAckRoutes: ackRoute,
      syncRetireRoutes: retireRoute });
    trackSyncSessionApp(app);
    const preflight = await app.inject({
      method: 'OPTIONS', url: enabled.syncSession!.path,
      headers: {
        origin: EXTENSION_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,idempotency-key',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], EXTENSION_ORIGIN);
    assert.equal(preflight.headers['access-control-allow-credentials'], 'true');
    assert.doesNotMatch(preflight.headers['access-control-allow-origin'] ?? '', /\*/u);
    const pushPreflight = await app.inject({
      method: 'OPTIONS', url: enabled.syncSession!.push.path,
      headers: { origin: EXTENSION_ORIGIN, 'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,idempotency-key' },
    });
    assert.equal(pushPreflight.statusCode, 204);
    assert.equal(pushPreflight.headers['access-control-allow-origin'], EXTENSION_ORIGIN);
    const conflictPreflight = await app.inject({
      method: 'OPTIONS', url: enabled.syncSession!.conflict.path.replace('{conflictId}', 'conflict-1'),
      headers: { origin: EXTENSION_ORIGIN, 'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,idempotency-key,if-match' },
    });
    assert.equal(conflictPreflight.statusCode, 204);
    assert.match(conflictPreflight.headers['access-control-allow-headers'] ?? '', /If-Match/u);
    const unrelated = await app.inject({
      method: 'GET', url: '/health', headers: { origin: EXTENSION_ORIGIN },
    });
    assert.equal(unrelated.statusCode, 200);
    assert.equal(unrelated.headers['access-control-allow-origin'], undefined);
    const denied = await app.inject({
      method: 'OPTIONS', url: enabled.syncSession!.path,
      headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST' },
    });
    assert.notEqual(denied.statusCode, 204);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  });

  test('FIX-L-036 startup validation applies the shared Replica lease bounds to SYNC_REPLICA_LEASE_EXTENSION_SECONDS', () => {
    assert.equal(loadConfig(syncEnv({ SYNC_REPLICA_LEASE_EXTENSION_SECONDS: '86400' }))
      .syncSession?.replicaLeaseExtensionSeconds, 86_400);
    assert.equal(loadConfig(syncEnv({ SYNC_REPLICA_LEASE_EXTENSION_SECONDS: '86401' }))
      .syncSession?.replicaLeaseExtensionSeconds, 86_401);
    assert.equal(loadConfig(syncEnv({
      SYNC_REPLICA_LEASE_EXTENSION_SECONDS: String(REPLICA_LEASE_BOUNDS.maxSeconds),
    })).syncSession?.replicaLeaseExtensionSeconds, REPLICA_LEASE_BOUNDS.maxSeconds);
    assert.throws(() => loadConfig(syncEnv({
      SYNC_REPLICA_LEASE_EXTENSION_SECONDS: String(REPLICA_LEASE_BOUNDS.maxSeconds + 1),
    })), /SYNC_REPLICA_LEASE_EXTENSION_SECONDS/u);
    assert.throws(() => loadConfig(syncEnv({
      SYNC_REPLICA_LEASE_EXTENSION_SECONDS: String(REPLICA_LEASE_BOUNDS.minSeconds - 1),
    })), /SYNC_REPLICA_LEASE_EXTENSION_SECONDS/u);
  });

  test('independent client discovers an unclaimed syncSessions endpoint and receives schema-valid 201', async () => {
    const server = await start();
    const client = createSyncSessionBlackBoxClient({
      manifestUrl: `${server.origin}/.well-known/collection-protocol`,
      mountId: 'known-sync-entry', authorization: `Bearer ${SECRET_TOKEN}`,
      origin: EXTENSION_ORIGIN,
    });
    const response = await client.create({ idempotencyKey: 'session-command-1', request: request() });
    assert.equal(response.status, 201);
    assert.equal(response.body.sessionId, 'session-http-1');
    assert.equal(createValidatorRegistry().validate('syncSessionResult', response.body).valid, true);
    assert.deepEqual(server.calls, ['authenticate', 'issue']);
  });

  test('exact replay is byte-stable and never includes request IDs or Date in its body', async () => {
    const stable = JSON.stringify(result());
    const server = await start({ issue: async () => ({ state: 'replayed', response: result() }) });
    const send = () => fetch(`${server.origin}/private-entry/session-negotiation`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`, 'Idempotency-Key': 'replay-key',
        Origin: EXTENSION_ORIGIN,
        'Content-Type': 'application/json',
      }, body: JSON.stringify(request()),
    });
    const first = await send();
    const second = await send();
    assert.equal(first.status, 201);
    assert.equal(await first.text(), stable);
    assert.equal(await second.text(), stable);
  });
});
