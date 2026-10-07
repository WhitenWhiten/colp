/**
 * P4A-P09 PRODUCTION HTTP composition + Publication Redis cache ports (not a
 * vitest test file: matches no vitest test pattern and is never listed in a
 * focused config).
 *
 * - `p09BuildConsumerHttpApp`: the PRODUCTION app composition for the HTTP
 *   exclusion suite — publication snapshot/directory/metadata, public
 *   profile, product search, MCP read resources AND the attachment product
 *   routes over the real PostgreSQL fixture;
 * - `p09BuildSyncHttpApp`: the PRODUCTION Sync session + snapshot HTTP
 *   composition (separate app exactly like the R06 HTTP suite);
 * - `p09SnapshotPorts` + cache policy/key constants for the Publication Redis
 *   warm-cache suite.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from './test-config.js';
import { buildApiApp } from '../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from './memory-product-rate-limiters.js';
import { registerSyncSessionRoutes } from '../../src/transport/colp-sync/sync-session-routes.js';
import { registerSyncSnapshotRoutes } from '../../src/transport/colp-sync/sync-snapshot-routes.js';
import { createPostgresAccessPolicyFactsPort } from '../../src/infrastructure/access-policy/index.js';
import { createPostgresAttachmentsAdmissionSwitchStore, createPostgresAttachmentCanonicalMutationPorts, createPostgresAttachmentsPorts, createUnitOfWork } from '../../src/infrastructure/database/index.js';
import { createPostgresSharedExposureFactsPort, createAttachmentExposurePolicyAdapter } from '../../src/infrastructure/database/index.js';
import { alwaysReady } from '../../src/infrastructure/health.js';
import {
  createGenerationObjectStoreAdapter,
  createR2GenerationStore,
} from '../../src/infrastructure/object-storage/index.js';
import { appendAttachmentsVerificationOutbox } from '../../src/infrastructure/outbox/index.js';
import type { AttachmentRoutesDependencies } from '../../src/transport/product/attachment-routes.js';
import {
  createPostgresPublicationDirectoryReadPort,
} from '../../src/infrastructure/publication/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../src/infrastructure/identity/index.js';
import {
  createPostgresSearchAuthorityPort,
  createPostgresSearchCandidatePort,
} from '../../src/infrastructure/search/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncSessionHttpApplication,
  createPostgresSyncSessionIssuer,
  createSyncPullCursorKeyring,
} from '../../src/infrastructure/sync/index.js';
import { createPostgresPublicationEntrySnapshotQueryPorts } from '../../scripts/evidence/postgres-publication-entry.js';
import { createPublicationCursorKeyring } from '../../src/modules/publication/index.js';
import { createSearchCursorSigner, executeSearchQuery } from '../../src/modules/search/index.js';
import {
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpReadToolAdapter,
} from '../../src/modules/mcp/index.js';
import {
  completeUpload,
  finalizeAttachment,
  issueUploadIntentWithAdmissionGate,
  issueReplacementIntent,
  nodeUploadIntentCrypto,
  readAttachmentStatus,
  retireAttachment,
  type AttachmentsFeatureConfig,
} from '../../src/modules/attachments/index.js';
import { composePublicProfileProjection } from '../../src/bootstrap/public-profile-projection.js';
import type { IdentityUnitOfWork } from '../../src/modules/identity/index.js';
import { mintVerifiedExtensionCredentialFixture } from './extension-credential.js';
import { I12_SUBJECT_OWNER } from './phase4a-i12-test-helpers.js';
import type { I07MigrationRuntime } from './phase4a-i07-test-helpers.js';
import {
  P09_COLLECTION,
  P09_ISSUER,
  P09_MCP_AUDIENCE,
  P09_MCP_OAUTH_ISSUER,
  P09_MCP_SERVER_UUID,
  P09_NOW,
  P09_ORIGIN,
  P09_SYNC_ORIGIN,
  type P09ProductFixture,
} from './phase4a-p09-test-helpers.js';
import {
  buildP09McpProjections,
  p09PublicationOrigin,
  p09PublicationPorts,
} from './phase4a-p09-consumers.js';

export interface P09HttpApp {
  readonly app: FastifyInstance;
  readonly close: () => Promise<void>;
}

export function p09AttachmentRouteDeps(input: {
  readonly runtime: I07MigrationRuntime['runtime'];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly objectServerUrl: string;
  readonly config: AttachmentsFeatureConfig;
  readonly databaseUrl: string;
}): AttachmentRoutesDependencies {
  const { runtime, identityUnitOfWork, objectServerUrl, config, databaseUrl } = input;
  const appConfig = loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: P09_ORIGIN,
    ALLOWED_ORIGINS: P09_ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
  });
  const store = createR2GenerationStore({
    endpoint: objectServerUrl,
    region: 'auto',
    bucket: config.r2.bucket,
    livePrefix: config.r2.livePrefix,
    probePrefix: 'attachments/probe/',
    rwCredential: { accessKeyId: 'p09rwaccesskeyid0000000000000000', secretAccessKey: 'p09-rw-secret-access-key-00000000000000000000' },
    roCredential: { accessKeyId: 'p09roaccesskeyid0000000000000000', secretAccessKey: 'p09-ro-secret-access-key-00000000000000000000' },
    grantTtlSeconds: config.grantTtlSeconds,
    singlePutMaxBytes: config.singlePutMaxBytes,
  });
  const moduleStore = createGenerationObjectStoreAdapter(store);
  const ledger = createPostgresAttachmentsPorts();
  const uow = createUnitOfWork(runtime.db);
  return {
    config: appConfig,
    identityUnitOfWork,
    attachments: {
      issue: (issueInput) => issueUploadIntentWithAdmissionGate({
        ledger,
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        blobStore: store,
        uow,
        crypto: nodeUploadIntentCrypto,
        config,
        admissionState: () => createPostgresAttachmentsAdmissionSwitchStore(runtime).read(),
      }, issueInput),
      complete: (completeInput) => completeUpload({
        ledger,
        blobStore: moduleStore,
        uow,
        enqueueVerification: async (transaction, payload) => {
          await appendAttachmentsVerificationOutbox(transaction, payload);
        },
        config,
      }, completeInput),
      status: (statusInput) => readAttachmentStatus({
        ledger,
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        uow,
      }, statusInput),
      finalize: (finalizeInput) => finalizeAttachment({
        ledger,
        canonical: createPostgresAttachmentCanonicalMutationPorts(),
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        uow: createUnitOfWork(runtime.db),
        recoveryUow: createUnitOfWork(runtime.db),
      }, finalizeInput),
      replacement: (replacementInput) => issueReplacementIntent({
        ledger,
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        blobStore: store,
        uow,
        crypto: nodeUploadIntentCrypto,
        config,
      }, replacementInput),
      retire: (retireInput) => retireAttachment({
        ledger,
        canonical: createPostgresAttachmentCanonicalMutationPorts(),
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        uow: createUnitOfWork(runtime.db),
        recoveryUow: createUnitOfWork(runtime.db),
      }, retireInput),
    },
  };
}

/**
 * The PRODUCTION app composition for the HTTP exclusion suite: publication
 * snapshot/directory/metadata, public profile, product search, MCP read
 * resources AND the attachment product routes over the real PostgreSQL
 * fixture. Sync lives on a separate app (`p09BuildSyncHttpApp`) exactly like
 * the R06 HTTP suite.
 */
export async function p09BuildConsumerHttpApp(input: {
  readonly runtime: I07MigrationRuntime;
  readonly databaseUrl: string;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly fixture: P09ProductFixture;
  readonly objectServerUrl: string;
  readonly enableSearch?: boolean;
}): Promise<P09HttpApp> {
  const { runtime, databaseUrl, identityUnitOfWork, fixture, objectServerUrl } = input;
  const enableSearch = input.enableSearch ?? true;
  const origin = p09PublicationOrigin();
  const appConfig = loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: P09_ORIGIN,
    PUBLICATION_ORIGIN: origin,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: P09_MCP_SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: P09_MCP_OAUTH_ISSUER,
    MCP_OAUTH_AUDIENCE: P09_MCP_AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  });
  const publication = p09PublicationPorts(runtime.runtime);
  const mcp = buildP09McpProjections(runtime.runtime, databaseUrl, fixture);
  const searchPorts = {
    candidates: createPostgresSearchCandidatePort(runtime.runtime.db),
    authority: createPostgresSearchAuthorityPort(runtime.runtime.db),
    cursors: createSearchCursorSigner({
      current: { id: `p09-http-search-${randomUUID()}`, key: Buffer.alloc(32, 77).toString('base64') },
    }),
    clock: { now: () => P09_NOW },
    sharedExposure: createPostgresSharedExposureFactsPort(runtime.runtime),
  };
  const readToolBundle = createPhase4bMcpReadToolAdapter({
    collectionProjection: mcp.collectionProjection,
    snapshotProjection: mcp.snapshotProjection,
    nodeProjection: mcp.nodeProjection,
    serverUuid: P09_MCP_SERVER_UUID,
  });
  const app = buildApiApp({
    config: appConfig,
    exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
    readiness: alwaysReady,
    identityUnitOfWork,
    publicationSnapshotQuery: publication.snapshot,
    publicationDirectoryQuery: publication.directory,
    publicationMetadataQuery: publication.metadata,
    publicProfileQuery: composePublicProfileProjection({
      profiles: createPostgresPublicProfileFactsReadPort(runtime.runtime),
      collections: createPostgresPublicationDirectoryReadPort(runtime.runtime),
      cursors: publication.cursors,
      sharedExposure: createPostgresSharedExposureFactsPort(runtime.runtime),
    }),
    ...(enableSearch
      ? {
          searchQuery: { execute: (searchInput) => executeSearchQuery(searchPorts, searchInput) },
          searchRateLimiter: memoryExploreDirectoryLimiter(),
        }
      : {}),
    mcpReadResourceProjection: mcp.collectionProjection,
    mcpNodeResourceProjection: mcp.nodeProjection,
    mcpSnapshotResourceProjection: mcp.snapshotProjection,
    mcpReadTransport: {
      changeSignalSource: createPhase4bMcpChangeSignalSource(),
      readToolAdapter: readToolBundle.adapter,
      readToolParamDeclarations: readToolBundle.paramDeclarations,
      dependencyHealth: async () => Object.freeze({
        oauth: 'ready', signalSource: 'ready', projection: 'ready',
      }),
    },
    attachmentRoutes: p09AttachmentRouteDeps({
      runtime: runtime.runtime,
      identityUnitOfWork,
      objectServerUrl,
      config: fixture.attachmentsConfig,
      databaseUrl,
    }),
  });
  app.addHook('onClose', () => {
    publication.cursors.destroy();
    mcp.destroy();
  });
  return { app, close: () => app.close() };
}

/** Production Sync session + snapshot HTTP composition over the same fixture. */
export async function p09BuildSyncHttpApp(input: {
  readonly runtime: I07MigrationRuntime;
  readonly fixture: P09ProductFixture;
}): Promise<P09HttpApp> {
  const { runtime, fixture } = input;
  const app = Fastify({ logger: false });
  const issuer = createPostgresSyncSessionIssuer(runtime.runtime.db, {
    issuer: P09_ISSUER, audience: 'known-api', clientId: 'known-extension',
    replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
    sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
    tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
    endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    retentionWindow: {
      async load(_transaction, collectionId) {
        return {
          collectionId,
          earliestPull: { cursor: null, commitOrdinal: '0' },
          purgedThrough: { cursor: null, commitOrdinal: '0' },
          snapshotUrl: '/private-entry/snapshot-download',
        };
      },
    },
  });
  const credential = await mintVerifiedExtensionCredentialFixture({
    issuer: P09_ISSUER, audience: 'known-api', clientId: 'known-extension',
    subject: 'i12-sync-oidc', credentialId: `p09-http-credential-${randomUUID()}`,
  });
  const credentialVerifier = {
    async verify({ authorization }: { readonly authorization: string | readonly string[] | undefined }) {
      if (authorization !== 'Bearer p09-http-token') throw new Error('invalid credential');
      return credential;
    },
  };
  const pullCursorKeys = createSyncPullCursorKeyring({
    active: { id: `p09-http-sync-${randomUUID()}`, secret: Buffer.alloc(32, 78).toString('base64') },
    retained: [],
    ttlMs: 300_000,
  });
  registerSyncSessionRoutes(app, {
    path: '/private-entry/session-negotiation', allowedOrigins: [P09_SYNC_ORIGIN],
    credentialVerifier,
    application: createPostgresSyncSessionHttpApplication(runtime.runtime.db, issuer, {
      registerUnknownGenerationOneReplica: true,
      registrationLeaseSeconds: 3_600,
    }),
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    allowInsecureLoopback: true,
  });
  registerSyncSnapshotRoutes(app, {
    path: '/private-entry/snapshot-download', allowedOrigins: [P09_SYNC_ORIGIN], credentialVerifier,
    application: createPostgresSyncBootstrapSnapshotApplication(runtime.runtime, {
      cursorSecret: Buffer.alloc(32, 79), cursorKeyId: 'p09-http-sync-v1', cursorTtlMs: 300_000,
      pullCursorKeyring: pullCursorKeys,
      attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(runtime.runtime)),
    }),
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    allowInsecureLoopback: true,
  });
  app.addHook('onClose', () => { pullCursorKeys.destroy(); });
  return { app, close: () => app.close() };
}

/** The sync account (subject I12_SUBJECT_OWNER) plus an HTTP-negotiable replica.
 * Returns the exact binding the negotiation wire must echo (the session
 * `sameBinding` fence compares stored browser_generation/profile with the
 * request binding). */
export async function p09SeedSyncHttpReplica(
  runtime: I07MigrationRuntime,
  collectionId: string,
): Promise<{ readonly replicaId: string; readonly binding: { readonly browserProfileId: string; readonly generation: string } }> {
  await runtime.runtime.pool.query(
    `insert into accounts (id, subject_id, status) values ($1, $2, 'active')
       on conflict (subject_id) do nothing`,
    ['p09-http-sync-account', I12_SUBJECT_OWNER],
  );
  // The subject may already be owned by another fixture account (the product
  // fixture seeds `i12-sync-account` with the same subject); the upsert above
  // is then a no-op, so resolve the REAL account id for the subject.
  const account = await runtime.runtime.pool.query<{ id: string }>(
    `select id from accounts where subject_id = $1`,
    [I12_SUBJECT_OWNER],
  );
  assert.equal(account.rowCount, 1, 'the sync subject must resolve to exactly one account');
  const browserProfileId = `p09-http-profile-${randomUUID()}`;
  const generation = `p09-http-generation-${randomUUID()}`;
  const replicaId = `p09-http-replica-${randomUUID()}`;
  const replica = await createPostgresReplicaStore(runtime.runtime.db, { ids: {
    deviceId: () => `p09-http-device-${randomUUID()}`,
    replicaId: () => replicaId,
    leaseId: () => `p09-http-lease-${randomUUID()}`,
  } }).create({
    accountId: account.rows[0]!.id,
    collectionId,
    deviceName: 'P09 device', replicaName: 'P09 replica', kind: 'browser_extension',
    adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
    capabilities: { read: true, write: true, events: true, separator: true, alias: false,
      annotations: 'sidecar', maxBatchOperations: 1 },
    binding: { browserProfileId, mountMode: 'whole-profile',
      browserGeneration: generation },
    leaseDurationSeconds: 3_600,
  }, { actorAccountId: account.rows[0]!.id });
  return { replicaId: replica.replicaId, binding: { browserProfileId, generation } };
}

// ---------------------------------------------------------------------------
// Publication snapshot query ports + cache constants (Redis warm-cache suite)
// ---------------------------------------------------------------------------

export interface P09SnapshotPorts {
  readonly key: ReturnType<typeof createPublicationCursorKeyring>;
  readonly ports: ReturnType<typeof createPostgresPublicationEntrySnapshotQueryPorts>;
}

export function p09SnapshotPorts(runtime: I07MigrationRuntime['runtime']): P09SnapshotPorts {
  const key = createPublicationCursorKeyring({
    active: { id: `p09-snap-${randomUUID()}`, secret: Buffer.alloc(32, 80).toString('base64') },
    retained: [],
  });
  return { key, ports: createPostgresPublicationEntrySnapshotQueryPorts(runtime, key) };
}

export const P09_CACHE_POLICY = Object.freeze({
  domain: 'publication-snapshot',
  softTtlMs: 10_000,
  hardTtlMs: 30_000,
  jitterMs: 0,
  serveStale: false,
  maxEntryBytes: 512 * 1024,
  lockTtlMs: 1_500,
  lockWaitCount: 3,
});

export const P09_CACHE_KEY = Object.freeze({
  environment: 'p09-test-env',
  keyPrefix: 'p09redis',
});
