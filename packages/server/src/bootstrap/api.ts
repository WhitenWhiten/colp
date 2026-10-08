import { createPersistentAvatarStore } from '../infrastructure/identity/index.js';
import { createPostgresAccountDeletionStore } from '../infrastructure/auth/business-account-unit-of-work.js';
import { loadConfig, sanitizedRuntimeCapacity, type AppConfig } from './config.js';
import { createApiCacheComposition, composeCollectionBookmarkCountLookup } from './cache-composition.js';
import { composeApiSurfaceRateLimiters } from './api-rate-limit-composition.js';
import { createSyncSessionRuntime } from './sync-session-runtime.js';
export { createSyncSessionRuntime };
import { composeBetterAuthComposition } from './composition.js';
import { buildApiApp } from '../transport/app.js';
import {
  createOidcProvider,
  verifyOidcDiscoveryMetadata,
} from '../transport/auth/oidc-provider.js';
import {
  createDatabaseRuntime,
  createAttachmentExposurePolicyAdapter,
  createPostgresSharedExposureFactsPort,
  type DatabaseRuntime,
} from '../infrastructure/database/index.js';
import {
  createPostgresExtensionOwnerAccountPort,
  createPostgresExtensionOwnerSubjectPort,
} from '../infrastructure/identity/index.js';
import { createPhase4bMcpAgentApprovalApi } from '../infrastructure/collections/index.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  registerFatalProcessHandlers,
  registerGracefulShutdown,
  reportFatalProcessError,
  DEFAULT_GRACEFUL_SHUTDOWN_DEADLINE_MS,
} from './process-lifecycle.js';
import { createLogger, InMemoryMetrics } from '../infrastructure/telemetry/index.js';
import { composeReadinessProbe, type ReadinessProbe } from '../infrastructure/health.js';
import {
  composeCollaborationInviteRateLimiter,
  composePublishingInsightsIngestRateLimiter,
  type PublishingInsightsIngestRateLimiter,
} from '../infrastructure/rate-limit/index.js';
import {
  assertMcpWriteOAuthRequirement,
  createMcpReadOAuthTransportDependencies,
} from './api-mcp-oauth-composition.js';
export {
  assertMcpWriteOAuthRequirement,
  createMcpReadOAuthTransportDependencies,
};
export type {
  McpReadOAuthTransportDependenciesOptions,
  McpReadOAuthDependencyBundle,
} from './api-mcp-oauth-composition.js';
import { registerTestAuthMailboxRoute } from './api-auth-mailbox.js';
import { composeApiPublicObjectStores } from './favicon-object-storage-composition.js';
import { composeApiEmail } from './api-email-composition.js';
import { composeApiAccountServices } from './api-account-services.js';
import { composeApiMcpSurface } from './api-mcp-surface-composition.js';
import { createApiPostgresPorts, createApiPostgresAppDependencies } from './api-postgres-ports.js';
import { createPostgresLinkPreviewPublicAccess } from '../infrastructure/collections/index.js';
import {
  isAvatarPublicationRestricted,
  isFaviconPubliclyAccessible,
} from '../infrastructure/database/index.js';
import { closeApiRuntimeResources } from './api-lifecycle.js';
import { composeLedgerArchiveColdReaders } from './ledger-archive-reader-composition.js';
import { createPostgresAccountCredentialUnitOfWork } from '../infrastructure/auth/account-credentials-postgres.js';
import { issueAgentKey } from '../infrastructure/auth/agent-key-postgres.js';
import { createAccountCredentialCursorCodec, createCredentialGrantCursorCodec } from '../modules/auth/index.js';
import { consumeProductAdmission } from '../transport/http-security.js';

/**
 * F2: Better Auth mode skips the legacy OIDC discovery probe entirely (the
 * legacy OIDC env is non-required, G1 §16). Exported so the isolation tests
 * pin the gate: a BA-mode config MUST return false — the probe is the only
 * path that can produce legacy discovery network traffic at startup.
 */
export function legacyOidcDiscoveryProbeRequired(
  config: ReturnType<typeof loadConfig>,
): boolean {
  return !config.betterAuth.enabled;
}

export interface StartApiOptions {
  readonly config?: AppConfig;
  readonly database?: DatabaseRuntime;
  /** When false, API shutdown leaves the database open for a shared pool. */
  readonly closeDatabase?: boolean;
  /** When false, build the app but do not listen or install signal handlers. */
  readonly listen?: boolean;
  /** When false, the caller owns process signals. */
  readonly registerShutdown?: boolean;
  /** Extra readiness probe. Self-hosted passes the migration-currency gate. */
  readonly readiness?: ReadinessProbe;
}

export interface StartedApi {
  readonly app: ReturnType<typeof buildApiApp>;
  readonly database: DatabaseRuntime;
  listen(): Promise<void>;
  stop(): Promise<void>;
}

/** Named agent keys use the same secret HMAC key as account-credential exchange. */
function agentKeyIssuer(db: DatabaseRuntime['db'], config: AppConfig) {
  const secretHmacKey = config.accountCredentials.cursorHmacKey?.toString('utf8');
  if (!secretHmacKey) return {};
  return {
    issueAgentKey: (accountId: string, name: string, commandId: string) =>
      issueAgentKey(db, secretHmacKey, accountId, name, commandId),
  };
}

export async function startApi(options: StartApiOptions = {}): Promise<StartedApi> {
  const config = options.config ?? loadConfig();
  assertMcpWriteOAuthRequirement(config);
  // G1 §6/§16: Better Auth mode makes the legacy OIDC env non-required, so the
  // legacy discovery probe is skipped (production can start without OIDC env).
  // Legacy mode keeps the existing startup verification exactly as before.
  if (legacyOidcDiscoveryProbeRequired(config)) {
    await verifyOidcDiscoveryMetadata(config.oidc);
  }
  const capacity = sanitizedRuntimeCapacity(config);
  const database = options.database ?? createDatabaseRuntime(config.databaseUrl, {
    maxConnections: config.database.maxConnections,
    connectionTimeoutMs: config.database.connectionTimeoutMs,
    idleTimeoutMs: config.database.idleTimeoutMs,
    statementTimeoutMs: config.database.statementTimeoutMs,
    lockTimeoutMs: config.database.lockTimeoutMs,
    idleTransactionTimeoutMs: config.database.idleTransactionTimeoutMs,
    applicationName: 'known-api',
    production: config.nodeEnv === 'production',
    ssl: config.databaseSsl,
  });
  const releaseDatabaseOnApiClose = options.closeDatabase !== false;
  const metricsLogger = createLogger(config.logLevel);
  const archiveColdReaders = composeLedgerArchiveColdReaders({
    config: config.ledgerArchiveReader,
    database,
  });
  const metrics = new InMemoryMetrics({
    onIncrement(name, value) {
      if (name === 'resource_authority_mismatch_total') {
        metricsLogger.warn(
          { metric: name, delta: value },
          'resource authority mismatch observed during canonical payload dual-read',
        );
      }
    },
  });
  const email = composeApiEmail({ config, database, metrics, metricsLogger });
  const ports = createApiPostgresPorts({ database, config, metrics, metricsLogger });
  // F2 (legacy isolation): production composition never constructs the legacy
  // OIDC provider in Better Auth mode (the routes are absent and the legacy
  // discovery probe is skipped). Legacy mode keeps the verifying HTTP
  // provider built from config-backed issuer/client/JWKS as before.
  const oidcProvider = config.betterAuth.enabled
    ? undefined
    : createOidcProvider(config.oidc);
  const surfaceLimiters = composeApiSurfaceRateLimiters(config);
  const mcp = await composeApiMcpSurface({
    config,
    database,
    identityUnitOfWork: ports.identityUnitOfWork,
    metrics,
    publicationDirectoryReads: ports.publicationDirectoryReads,
    publicationMetadataReads: ports.publicationMetadataReads,
    publicationCursorKeys: ports.publicationCursorKeys,
    accessPolicyFacts: ports.accessPolicyFacts,
    publicationSnapshotQuery: ports.publicationSnapshotQuery,
    ownedCollectionsQuery: ports.ownedCollectionsQueryPorts,
    governanceReportRateLimiter: surfaceLimiters.governanceReportRateLimiter,
    governanceActionRateLimiter: surfaceLimiters.governanceActionRateLimiter,
    governanceAppealRateLimiter: surfaceLimiters.governanceAppealRateLimiter,
    ...(ports.reportSourceInvalidation === undefined
      ? {} : { reportSourceInvalidation: ports.reportSourceInvalidation }),
  });
  const {
    mcpCollectionResourceCursorKeys,
    mcpChangeSignalSource,
    mcpReadResourceProjection,
    mcpSnapshotResourceProjection,
    mcpNodeResourceProjection,
    mcpReadToolAdapter,
    mcpOauthRevocationStore,
    mcpReadOAuthDependencies,
    mcpRateLimiter,
    mcpWriteComposition,
    mcpApplicationFacade,
    accountCredentialGrantRuntime,
  } = mcp;
  const cacheComposition = createApiCacheComposition({
    config: config.cache,
    reportsEnabled: config.reports.enabled,
    metrics,
    environment: config.nodeEnv,
    clock: () => Date.now(),
  });
  const publicObjects = await composeApiPublicObjectStores(config);
  const {
    authRateLimiter,
    searchRateLimiter,
    exploreDirectoryRateLimiter,
    publicActivityRateLimiter,
    syncColpRateLimiter,
    followRateLimiter,
    collectionFollowRateLimiter,
    feedRateLimiter,
    notificationRateLimiter,
    creditsReadRateLimiter,
    libraryOrderRateLimiter,
    faviconPolicyRateLimiter,
    linkHealthRateLimiter,
    classificationSettingsRateLimiter, classificationPreviewRateLimiter, classificationConfirmationRateLimiter, classificationProfilesRateLimiter, classificationRunsRateLimiter,
    classifyInboxRateLimiter,
    exportJobRateLimiter,
    organizePlanRateLimiter,
    collectionVersionRateLimiter,
    readableReplicaRateLimiter,
    publicObjectRateLimiter,
    reportsRateLimiter,
    communityRateLimiters,
    credentialsRateLimiter,
    credentialIssuanceRateLimiter,
    automationTokenCredentialRateLimiter,
    automationTokenClientRateLimiter,
    governanceReportRateLimiter,
    governanceActionRateLimiter,
    governanceAppealRateLimiter,
    effectPageRateLimiter,
    syncAdmissionPolicy,
  } = surfaceLimiters;
  const publishingInsightsRateLimiter: PublishingInsightsIngestRateLimiter =
    composePublishingInsightsIngestRateLimiter({
      environment: config.nodeEnv,
      keySecret: config.publishingInsights.rateLimitHmacKey,
      shared: config.publishingInsights.rateLimitShared,
    });
  const collaborationInviteRateLimiter = composeCollaborationInviteRateLimiter({
    environment: config.nodeEnv,
    keySecret: config.collaborationInviteRateLimit.keySecret,
    shared: config.collaborationInviteRateLimit,
  });
  const collectionBookmarkCounts = composeCollectionBookmarkCountLookup(
    cacheComposition,
    ports.collectionBookmarkCountOrigin,
    metrics,
  );
  const {
    browserSessionAuthority,
    betterAuthRuntime,
    securityEpochBridge,
    betterAuth: recoveryLinkingAuth,
  } = composeBetterAuthComposition({
    config,
    db: database.db,
    authEmail: email.authEmailComposition.sender,
    logger: metricsLogger,
    ...(mcpOauthRevocationStore === undefined
      ? {}
      : { mcpOauthRevocationStore }),
    metrics,
  });
  const syncRuntime = config.syncSession
    ? createSyncSessionRuntime(database, config.syncSession, metrics,
      config.publication.endpoints.syncSnapshot, {
        telemetryLogger: metricsLogger,
        effectPageOrigin: config.publication.origin,
        attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(database)),
        ...(archiveColdReaders === undefined
          ? {}
          : { auditPayloadColdSource: archiveColdReaders.auditPayloadColdSource }),
        ...(ports.reportSourceInvalidation === undefined
          ? {}
          : { reportSourceInvalidation: ports.reportSourceInvalidation }),
        ...(syncColpRateLimiter === undefined ? {} : { rateLimiter: syncColpRateLimiter }),
        ...(effectPageRateLimiter === undefined ? {} : { effectPageRateLimiter }),
        ...(browserSessionAuthority === undefined || !config.betterAuth.enabled
          ? {}
          : (() => {
              const authority = browserSessionAuthority;
              return {
                browserSession: {
                  authenticate: async (cookieHeader: string) => {
                    const actor = await authority.authenticate(
                      { cookie: cookieHeader },
                      { touch: false },
                    );
                    if (!actor) return null;
                    const expiresAt = actor.session.idleExpiresAt.getTime()
                      <= actor.session.absoluteExpiresAt.getTime()
                      ? actor.session.idleExpiresAt
                      : actor.session.absoluteExpiresAt;
                    return {
                      accountId: actor.account.id,
                      subjectId: actor.account.subjectId,
                      sessionId: actor.session.id,
                      issuedAt: actor.session.createdAt,
                      expiresAt,
                    };
                  },
                  identityIssuer: config.productOrigin,
                },
              };
            })()),
      }, config.httpSecurity.trustedIngress)
    : undefined;
  const accounts = composeApiAccountServices({
    accountDeletionStore: createPostgresAccountDeletionStore(database.db, {
      ...(ports.reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation: ports.reportSourceInvalidation }),
    }),
    config,
    identityUnitOfWork: ports.identityUnitOfWork,
    browserSessionAuthority,
    recoveryLinkingAuth,
  });
  const postgresApp = createApiPostgresAppDependencies({
    database,
    config,
    metrics,
    ports,
    collaborationInviteRateLimiter,
    publishingInsightsRateLimiter,
    identityUnitOfWork: ports.identityUnitOfWork,
  });
  const accountCredentialCursors = config.accountCredentials.enabled && config.accountCredentials.cursorHmacKey
    ? createAccountCredentialCursorCodec(config.accountCredentials.cursorHmacKey.toString('base64url'))
    : null;
  const accountCredentialGrantCursors = config.accountCredentials.enabled && config.accountCredentials.cursorHmacKey
    ? createCredentialGrantCursorCodec(config.accountCredentials.cursorHmacKey.toString('base64url'))
    : null;
  const accountCredentialUnitOfWork = createPostgresAccountCredentialUnitOfWork(
    database.db,
    credentialIssuanceRateLimiter
      ? {
          async consume(parentKey) {
            const decision = await consumeProductAdmission(
              credentialIssuanceRateLimiter,
              `credential-issuance:${parentKey}`,
            );
            if (decision.kind === 'denied') {
              return { allowed: false as const, retryAfterSeconds: decision.retryAfterSeconds };
            }
            if (decision.kind === 'failed') {
              return { allowed: false as const, retryAfterSeconds: 1 };
            }
            return { allowed: true as const };
          },
        }
      : undefined,
    accountCredentialGrantRuntime,
    // AC-F003: reuse the deployment HMAC secret to key stored credential
    // hashes (bare SHA-256 fallback only when unconfigured).
    { secretHmacKey: config.accountCredentials.cursorHmacKey?.toString('utf8') },
  );
  const avatarStore = publicObjects.avatarStore ? createPersistentAvatarStore(database.db, publicObjects.avatarStore) : undefined;
  const lifecycle = {
    accountCredentialCursors: accountCredentialCursors ?? { destroy() { /* feature off */ } },
    accountCredentialGrantCursors: accountCredentialGrantCursors ?? { destroy() { /* feature off */ } },
    ownedCollectionsCursorSigner: ports.ownedCollectionsCursorSigner,
    sharedCollectionsCursorSigner: ports.sharedCollectionsCursorSigner,
    collaborationMembersCursorSigner: ports.collaborationMembersCursorSigner,
    myCollaborationInvitesCursorSigner: ports.myCollaborationInvitesCursorSigner,
    linkHealthCursorSigner: ports.linkHealthCursorSigner,
    classifyInboxCursorSigner: ports.classifyInboxCursorSigner,
    collectionVersionCursorSigner: ports.collectionVersionCursorSigner,
    syncRuntime,
    emailProvider: email.emailProvider,
    authEmailComposition: email.authEmailComposition,
    mcpCollectionResourceCursorKeys,
    publicationCursorKeys: ports.publicationCursorKeys,
    mcpChangeSignalSource,
    authRateLimiter,
    searchRateLimiter,
    exploreDirectoryRateLimiter,
    publicActivityRateLimiter,
    syncColpRateLimiter,
    followRateLimiter,
    collectionFollowRateLimiter,
    feedRateLimiter,
    notificationRateLimiter,
    creditsReadRateLimiter,
    productRouteRateLimiters: [
      libraryOrderRateLimiter,
      faviconPolicyRateLimiter,
      creditsReadRateLimiter,
      linkHealthRateLimiter,
      classificationSettingsRateLimiter, classificationPreviewRateLimiter, classificationConfirmationRateLimiter, classificationProfilesRateLimiter, classificationRunsRateLimiter,
      classifyInboxRateLimiter,
      exportJobRateLimiter,
      organizePlanRateLimiter,
      collectionVersionRateLimiter,
      readableReplicaRateLimiter,
      publicObjectRateLimiter,
      reportsRateLimiter,
      communityRateLimiters.vote,
      communityRateLimiters.comment,
      communityRateLimiters.curation,
      communityRateLimiters.publicReads,
      ...(credentialsRateLimiter ? [credentialsRateLimiter] : []),
      ...(credentialIssuanceRateLimiter ? [credentialIssuanceRateLimiter] : []),
      ...(automationTokenCredentialRateLimiter ? [automationTokenCredentialRateLimiter] : []),
      ...(automationTokenClientRateLimiter ? [automationTokenClientRateLimiter] : []),
      governanceReportRateLimiter,
      governanceActionRateLimiter,
      governanceAppealRateLimiter,
    ],
    effectPageRateLimiter,
    syncAdmissionPolicy,
    publishingInsightsRateLimiter,
    collaborationInviteRateLimiter,
    mcpRateLimiter,
    emailCallbackRateLimiter: email.emailCallbackRateLimiter,
    avatarStore,
    ...publicObjects.publicObjectStores,
    cacheComposition,
    database: releaseDatabaseOnApiClose ? database : { async close() {} },
  };
  let app: ReturnType<typeof buildApiApp>;
  try {
    app = buildApiApp({
    config,
    creditLedgerRead: ports.creditLedgerRead,
    // F2: readiness reflects only enabled dependencies. Legacy OIDC is never one.
    readiness: composeReadinessProbe([options.readiness, database]),
    identityUnitOfWork: ports.identityUnitOfWork,
    avatarStore,
    ...publicObjects.publicObjectStores,
    faviconPublicAccess: { isPubliclyAccessible: (objectId) => isFaviconPubliclyAccessible(database.db, objectId) },
    linkPreviewPublicAccess: { isServable: (objectId, signal) => createPostgresLinkPreviewPublicAccess(database.db, { cancelBackend: database.cancelBackend }).isServable(objectId, signal) },
    avatarPublicAccess: { isPublicationRestricted: (objectId) => isAvatarPublicationRestricted(database.db, objectId) },
    authRateLimiter,
    mcpRateLimiter,
    collectionsUnitOfWork: ports.collectionsUnitOfWork,
    productCollectionMutationUnitOfWork: ports.productCollectionMutationUnitOfWork,
    collectionsEditorReadUnitOfWork: ports.collectionsEditorReadUnitOfWork,
    // FO-05: without this port the /children route is never registered, so
    // every created/created sort silently fell back to curated.
    collectionChildrenReadUnitOfWork: ports.collectionChildrenReadUnitOfWork,
    ownedCollectionsQuery: ports.ownedCollectionsQueryPorts,
    sharedCollectionsQuery: ports.sharedCollectionsQueryPorts,
    linkHealthQuery: ports.linkHealthQueryPorts,
    classifyInboxQuery: ports.classifyInboxQueryPorts,
    bookmarkCounts: collectionBookmarkCounts,
    annotationMutationUnitOfWork: ports.annotationMutationUnitOfWork,
    annotationReadUnitOfWork: ports.annotationReadUnitOfWork,
    relationMutationUnitOfWork: ports.relationMutationUnitOfWork,
    relationReadUnitOfWork: ports.relationReadUnitOfWork,
    reportsRateLimiter,
    governanceReportRateLimiter,
    governanceActionRateLimiter,
    governanceAppealRateLimiter,
    oidcProvider,
    ...(browserSessionAuthority === undefined ? {} : { browserSessionAuthority }),
    ...(securityEpochBridge === undefined ? {} : { securityEpochBridge }),
    ...(betterAuthRuntime === undefined ? {} : { betterAuthRuntime }),
    ...(accounts.accountLinking === undefined ? {} : { accountLinking: accounts.accountLinking }),
    ...(accounts.accountRecovery === undefined ? {} : { accountRecovery: accounts.accountRecovery }),
    ...(accounts.accountDeletion === undefined ? {} : { accountDeletion: accounts.accountDeletion }),
    metrics,
    ...(cacheComposition.snapshotReader === undefined
      ? {}
      : { publicationSnapshotCacheReader: cacheComposition.snapshotReader }),
    ...(cacheComposition.directoryReader === undefined
      ? {}
      : { publicationDirectoryCacheReader: cacheComposition.directoryReader }),
    ...(cacheComposition.metadataReader === undefined
      ? {}
      : { publicationMetadataCacheReader: cacheComposition.metadataReader }),
    cacheReadiness: () => cacheComposition.readiness(),
    cacheCapabilityReadiness: () => cacheComposition.capabilityReadiness(),
    ...(mcpReadResourceProjection === undefined ? {} : { mcpReadResourceProjection }),
    ...(mcpNodeResourceProjection === undefined ? {} : { mcpNodeResourceProjection }),
    ...(mcpSnapshotResourceProjection === undefined ? {} : { mcpSnapshotResourceProjection }),
    ...(mcpChangeSignalSource === undefined || mcpReadToolAdapter === undefined
      ? {}
      : {
          mcpReadTransport: {
            changeSignalSource: mcpChangeSignalSource,
            ...(mcpRateLimiter === undefined
              ? {}
              : { requestRateLimiter: mcpRateLimiter }),
            readToolAdapter: mcpReadToolAdapter.adapter,
            readToolParamDeclarations: mcpReadToolAdapter.paramDeclarations,
            ...(mcpApplicationFacade === undefined
              ? {}
              : { applicationFacade: mcpApplicationFacade }),
            ...(mcpWriteComposition === undefined
              ? {}
              : {
                  writeToolAdapter: mcpWriteComposition.adapter,
                  writeToolParamDeclarations: mcpWriteComposition.paramDeclarations,
                }),
            ...(mcpReadOAuthDependencies.oauthVerifier === undefined
              ? {}
              : { oauthVerifier: mcpReadOAuthDependencies.oauthVerifier }),
            ...(mcpReadOAuthDependencies.dependencyHealth === undefined
              ? {}
              : { dependencyHealth: mcpReadOAuthDependencies.dependencyHealth }),
          },
        }),
    ...(syncRuntime ? {
      syncSessionRoutes: syncRuntime.session,
      syncSnapshotRoutes: syncRuntime.snapshot,
      syncPushRoutes: syncRuntime.push,
      syncConflictRoutes: syncRuntime.conflict,
      syncPullRoutes: syncRuntime.pull,
      syncEffectPageRoutes: syncRuntime.effectPages,
      syncAckRoutes: syncRuntime.ack,
      syncRetireRoutes: syncRuntime.retire,
      extensionCollectionRoutes: {
        credentialVerifier: syncRuntime.session.credentialVerifier,
        ownedCollectionsQuery: ports.ownedCollectionsQueryPorts,
        ownerSubject: createPostgresExtensionOwnerSubjectPort(database.db),
        ownerAccount: createPostgresExtensionOwnerAccountPort(database.db),
        collectionMutation: ports.productCollectionMutationUnitOfWork,
        allowedOrigins: syncRuntime.session.allowedOrigins,
      },
    } : {}),
    searchRateLimiter,
    exploreDirectoryRateLimiter,
    publicActivityRateLimiter,
    ...(syncColpRateLimiter === undefined ? {} : { syncColpRateLimiter }),
    ...(effectPageRateLimiter === undefined ? {} : { effectPageRateLimiter }),
    ...(syncAdmissionPolicy === undefined ? {} : { syncAdmissionPolicy }),
    ...(config.mcpWriteEnabled
      ? {
          mcpWriteApprovalRoutes: {
            enabled: true,
            allowedOrigins: config.allowedOrigins,
            identityUnitOfWork: ports.identityUnitOfWork,
            api: createPhase4bMcpAgentApprovalApi(database.db, agentKeyIssuer(database.db, config)),
            // FIX-M-018: approval policy of the unified MCP limiter (shared
            // across replicas; mcpWriteEnabled implies the limiter exists).
            rateLimiter: mcpRateLimiter!,
            timeoutMs: 5_000,
          },
        }
      : {}),
    followRateLimiter,
    collectionFollowRateLimiter,
    feedRateLimiter,
    notificationRateLimiter,
    creditsReadRateLimiter,
    libraryOrderRateLimiter,
    faviconPolicyRateLimiter,
    linkHealthRateLimiter,
    classificationSettingsRateLimiter, classificationPreviewRateLimiter, classificationConfirmationRateLimiter, classificationProfilesRateLimiter, classificationRunsRateLimiter,
    classifyInboxRateLimiter,
    exportJobRateLimiter,
    organizePlanRateLimiter,
    collectionVersionRateLimiter,
    readableReplicaRateLimiter,
    publicObjectRateLimiter,
    communityRateLimiters,
    ...(email.emailCallbackRoutes === undefined ? {} : { emailCallbackRoutes: email.emailCallbackRoutes }),
    ...(email.emailOpsRoutes === undefined ? {} : { emailOpsRoutes: email.emailOpsRoutes }),
    ...postgresApp,
    accountCredentialUnitOfWork,
    accountCredentialCursors,
    accountCredentialGrantCursors,
    ...(credentialsRateLimiter === undefined ? {} : { credentialsRateLimiter }),
    ...(credentialIssuanceRateLimiter === undefined ? {} : { credentialIssuanceRateLimiter }),
    ...(automationTokenCredentialRateLimiter === undefined ? {} : { automationTokenCredentialRateLimiter }),
    ...(automationTokenClientRateLimiter === undefined ? {} : { automationTokenClientRateLimiter }),
  });
  registerTestAuthMailboxRoute(app, config, email.authMailboxSink);
  } catch (error: unknown) {
    await closeApiRuntimeResources(lifecycle);
    throw error;
  }
  app.addHook('onClose', async () => {
    await closeApiRuntimeResources(lifecycle);
  });
  const stop = async (): Promise<void> => {
    await app.close();
  };
  const listen = async (): Promise<void> => {
    await database.verifyReady();
    await app.listen({ host: config.host, port: config.port });
    avatarStore?.startCleanup(error => app.log.error({ error }, 'Avatar cleanup will retry from its durable lease'));
    // Sanitized capacity only — never log DATABASE_URL or credentials.
    app.log.info({ service: 'api', capacity }, 'api started');
  };
  let removeSignalHandlers: (() => void) | undefined;
  if (options.registerShutdown !== false && options.listen !== false) {
    removeSignalHandlers = registerGracefulShutdown(
      { stop },
      {
        onError: (error) => app.log.error({ error }, 'API graceful shutdown failed'),
        deadlineMs: DEFAULT_GRACEFUL_SHUTDOWN_DEADLINE_MS,
      },
    );
  }
  if (options.listen !== false) {
    try {
      await listen();
    } catch (error: unknown) {
      removeSignalHandlers?.();
      await stop();
      throw error;
    }
  }
  return { app, database, listen, stop };
}


if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const processLogger = createLogger(process.env.LOG_LEVEL?.trim() || 'info');
  registerFatalProcessHandlers({ logger: processLogger });
  startApi().catch((error: unknown) => {
    reportFatalProcessError(processLogger, 'startup_failure', error);
    process.exitCode = 1;
  });
}
