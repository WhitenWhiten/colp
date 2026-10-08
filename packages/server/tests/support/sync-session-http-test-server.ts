import { createSyncSessionBlackBoxClient } from './sync-session-black-box-client.js';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Manifest } from '@know-n/colp/types';
import { createPostgresSharedExposureFactsPort, createAttachmentExposurePolicyAdapter } from '../../src/infrastructure/database/index.js';
import {
  createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncSessionHttpApplication,
  createPostgresSyncSessionIssuer,
  createSyncPullCursorKeyring,
} from '../../src/infrastructure/sync/index.js';
import { registerSyncSessionRoutes } from '../../src/transport/colp-sync/sync-session-routes.js';
import { registerSyncSnapshotRoutes } from '../../src/transport/colp-sync/sync-snapshot-routes.js';
import type { IsolatedPostgresRuntime } from './postgres-test-runtime.js';
import type { mintVerifiedExtensionCredentialFixture } from './extension-credential.js';
import { isFetchForbiddenPort } from './fetch-port.js';

export const ISSUER = 'https://issuer.example';
export const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
export const TOKEN = 'postgres-SYNC-HTTP-TOKEN-MARKER';

export function createSyncSessionHttpTestServer(
  isolated: IsolatedPostgresRuntime,
  credential: Awaited<ReturnType<typeof mintVerifiedExtensionCredentialFixture>>,
  apps: FastifyInstance[],
) {
  const start = async (options: {
    readonly responseGate?: Promise<void>;
    readonly acceptedToken?: string;
    readonly evidence?: typeof credential;
    readonly registerUnknownGenerationOneReplica?: boolean;
    readonly registrationLeaseSeconds?: number;
    readonly sessionIssueFault?: 'finalize';
  } = {}) => {
    const app = Fastify({ logger: false });
    if (options.responseGate) {
      app.addHook('onSend', async (request, _reply, payload) => {
        if (request.url === '/private-entry/session-negotiation') await options.responseGate;
        return payload;
      });
    }
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
      retentionWindow: { async load(_transaction, collectionId) { return { collectionId,
        earliestPull: { cursor: null, commitOrdinal: '0' }, purgedThrough: { cursor: null, commitOrdinal: '0' },
        snapshotUrl: '/private-entry/snapshot-download' }; } },
      ...(options.sessionIssueFault ? { faultInjector: { afterPhase(phase) {
        if (phase === options.sessionIssueFault) throw new Error('session issue rollback probe');
      } } } : {}),
    });
    const credentialVerifier = { async verify({ authorization }: { readonly authorization: string | readonly string[] | undefined }) {
      if (authorization !== `Bearer ${options.acceptedToken ?? TOKEN}`) throw new Error('invalid credential');
      return options.evidence ?? credential;
    } };
    registerSyncSessionRoutes(app, {
      path: '/private-entry/session-negotiation', allowedOrigins: [ORIGIN],
      credentialVerifier,
      application: createPostgresSyncSessionHttpApplication(isolated.runtime.db, issuer, {
        registerUnknownGenerationOneReplica: options.registerUnknownGenerationOneReplica,
        registrationLeaseSeconds: options.registrationLeaseSeconds ?? 3_600,
      }),
      rateLimit: { maxRequests: 100, windowMs: 60_000 },
      allowInsecureLoopback: true,
    });
    const pullCursorKeys = createSyncPullCursorKeyring({ active: { id: 'snapshot-bootstrap-v1',
      secret: Buffer.alloc(32, 31).toString('base64') }, retained: [], ttlMs: 300_000 });
    app.addHook('onClose', async () => { pullCursorKeys.destroy(); });
    registerSyncSnapshotRoutes(app, {
      path: '/private-entry/snapshot-download', allowedOrigins: [ORIGIN], credentialVerifier,
      application: createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
        cursorSecret: Buffer.alloc(32, 29), pullCursorKeyring: pullCursorKeys,
        attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)) }),
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, allowInsecureLoopback: true,
    });
    app.get('/.well-known/collection-protocol', async (_request, reply) => {
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('not listening');
      return reply.send(testManifest(`http://127.0.0.1:${address.port}`));
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    if (isFetchForbiddenPort(address.port)) {
      await app.close();
      return start(options);
    }
    apps.push(app);
    return { app, origin: `http://127.0.0.1:${address.port}` };
  };

  return start;
}

function testManifest(origin: string): Manifest {
  return {
    protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019f97ff-1111-7111-8111-111111111111', title: 'Known',
    mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
      endpoints: { syncSessions: `${origin}/private-entry/session-negotiation`, syncSnapshot: `${origin}/private-entry/snapshot-download` },
      features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: {
        anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource`,
      },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10_000, minPollIntervalSeconds: 10,
        recommendedPollIntervalSeconds: 30 } }],
  } as Manifest;
}

export function client(origin: string) {
  return createSyncSessionBlackBoxClient({
    manifestUrl: `${origin}/.well-known/collection-protocol`, mountId: 'known-sync-entry',
    authorization: `Bearer ${TOKEN}`, origin: ORIGIN,
  });
}
