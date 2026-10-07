import { installClassificationExtensionCors, isCreditLedgerPath } from './classification-extension-cors.js';
import { assertSharedProductRateLimiters } from './product-rate-limit-assertion.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type HTTPMethods,
} from 'fastify';
import type { AppConfig } from '../bootstrap/config.js';
import type {
  CollectionsEditorReadUnitOfWork,
  AnnotationMutationUnitOfWork,
  AnnotationReadUnitOfWork,
  RelationMutationUnitOfWork,
  RelationReadUnitOfWork,
  CollectionsUnitOfWork,
  ProductCollectionMutationUnitOfWork,
  CollectionListBookmarkCountsPort,
  GetOwnedCollectionsPagePorts,
  GetSharedCollectionsPagePorts,
  GetMyLinkHealthPagePorts,
  GetMyClassifyInboxPagePorts,
  EnqueueMyLinkHealthChecksPorts,
  SkipClassifyInboxItemPorts,
  AcceptClassifyInboxItemPorts,
  CreateMyExportJobPorts,
  ExportJobReadPort,
  ExportObjectStore,
  BookmarkFaviconObjectStore,
  ApplyCollectionOrganizePlanPorts,
  OrganizePlanReadPort,
  OrganizePlanner,
  CreateCollectionVersionPorts,
  ProductCollectionVersionCursorSignerPort,
  ReadableReplicaEnqueueUnitOfWork,
  ReadableReplicaReadUnitOfWork,
  LibraryOrderCommandPorts,
  LibraryOrderQueryPorts,
} from '../modules/collections/index.js';
import type { IdentityUnitOfWork, AvatarObjectStore, ExploreCreatorsQueryPort } from '../modules/identity/index.js';
import type { BrowserSessionAuthority, AccountLinkingService, AccountRecoveryService, AccountDeletionService, SecurityEpochBridge } from '../modules/auth/index.js';
import type {
  PublicationDirectoryQueryPorts,
  PublicationMetadataQueryPorts,
  ProductPublicCollectionQueryPorts,
  PublicationSnapshotQueryPorts,
  Phase2PublicationProfileClaims,
  Phase2PublicationProfileClaimController,
  ExplorePageReadPort,
} from '../modules/publication/index.js';
import type {
  Phase4bMcpReadOperations,
  Phase4bMcpCollectionResourceProjection,
  Phase4bMcpNodeResourceProjection,
  Phase4bMcpSnapshotResourceProjection,
  Phase4bMcpReadProfileClaimController,
  Phase4bMcpReadProfileClaims,
  Phase4bMcpWriteProfileClaimController,
  Phase4bMcpWriteProfileClaims,
  Phase4bMcpWriteOperations,
} from '../modules/mcp/index.js';
import {
  assertPhase4bMcpReadProfileClaimController,
  assertPhase4bMcpWriteProfileClaimController,
  createPhase4bMcpReadOperations,
} from '../modules/mcp/index.js';
import {
  InMemoryMetrics,
  NoopTracer,
  createLogger,
  createSyncServerTelemetry,
  syncDurationBucket,
  type SyncTelemetryEndpoint,
  type Metrics,
} from '../infrastructure/telemetry/index.js';
import {
  alwaysReady,
  type CacheCapabilityReadiness,
  type CacheReadinessState,
  type ReadinessProbe,
} from '../infrastructure/health.js';
import { registerBrowserAuthRoutes } from './auth/browser-auth-routes.js';
import { registerBookmarkFaviconRoutes } from './product/bookmark-favicon-routes.js';
import { registerBetterAuthRoutes } from './auth/better-auth-routes.js';
import { registerCollectionRoutes } from './product/collection-routes.js';
import {
  mintTestAuthorizationCodeFromChallenge,
  type OidcProviderPort,
} from './auth/oidc-provider.js';
import {
  applySecurityHeaders,
  createFixedWindowRateLimiter,
  installHttpSecurity,
  type ProductAdmissionRateLimiter,
} from './http-security.js';
import type { AuthRateLimiter, EffectPageRateLimiter, McpRateLimiter, SearchRateLimiter, SyncColpRateLimiter } from '../infrastructure/rate-limit/index.js';
import { installProductAdmission, parseStrictQuery } from './product-admission.js';
import { ProductHttpError, sendProductError, type ProductErrorEnvelope } from './product-error.js';
import { DatabaseOperationError } from '../infrastructure/database/errors.js';
import {
  BOOKMARK_FAVICON_DEFERRED_OPERATION_IDS,
  installProductRouteManifestChecks,
  LEGACY_OIDC_OPERATION_IDS,
} from './product-route-manifest.js';
import { mapProductDatabaseError } from './product-command-mapping.js';
import {
  registerPublicationSnapshotRoutes,
  sendPublicationFrameworkError,
  type PublicationSnapshotRouteReader,
} from './product/publication-snapshot-routes.js';
import {
  registerPublicationDirectoryRoutes,
  type PublicationDirectoryRouteReader,
} from './product/publication-directory-routes.js';
import { EXPLORE_OPERATION_IDS, registerExploreRoutes } from './product/explore-routes.js';
import {
  registerPublicationMetadataRoutes,
  type PublicationMetadataRouteReader,
} from './product/publication-metadata-routes.js';
import { registerPublicationManifestRoutes } from './product/publication-manifest-routes.js';
import { registerProductPublicCollectionRoutes } from './product/product-public-collection-routes.js';
import {
  registerProductPublicInsightRoutes,
  type ProductPublicInsightRouteDependencies,
} from './product/product-public-insight-routes.js';
import {
  registerProductPublishingInsightsRoutes,
  type ProductPublishingInsightsRouteDependencies,
} from './product/product-publishing-insights-routes.js';
import {
  registerProductCollaborationRoutes,
  type ProductCollaborationRouteDependencies,
} from './product/product-collaboration-routes.js';
import { registerSharedCollectionRoutes } from './product/shared-collection-routes.js';
import {
  registerSyncSessionRoutes,
  type SyncSessionRouteDependencies,
} from './colp-sync/sync-session-routes.js';
import { registerSyncSnapshotRoutes, type SyncSnapshotRouteDependencies } from './colp-sync/sync-snapshot-routes.js';
import { registerSyncPushRoutes, type SyncPushRouteDependencies } from './colp-sync/sync-push-routes.js';
import { registerSyncConflictRoutes, type SyncConflictRouteDependencies } from './colp-sync/sync-conflict-routes.js';
import { registerSyncPullRoutes, type SyncPullRouteDependencies } from './colp-sync/sync-pull-routes.js';
import { registerSyncEffectPageRoutes, type SyncEffectPageRouteDependencies } from './colp-sync/sync-effect-page-routes.js';
import { registerSyncAckRoutes, type SyncAckRouteDependencies } from './colp-sync/sync-ack-routes.js';
import { registerSyncRetireRoutes, type SyncRetireRouteDependencies } from './colp-sync/sync-retire-routes.js';
import { EXTENSION_COLLECTIONS_PATH, registerExtensionCollectionRoutes, type ExtensionCollectionRouteDependencies } from './colp-sync/extension-collection-routes.js';
import { registerSearchRoutes, type SearchProductQuery } from './product/search-routes.js';
import { registerMcpProtectedResourceRoutes } from './mcp/mcp-protected-resource-routes.js';
import { registerMcpReadRoutes, type McpReadTransportDependencies } from './mcp/mcp-read-routes.js';
import {
  registerMcpWriteApprovalRoutes,
  type McpWriteApprovalRoutesDependencies,
} from './mcp/mcp-write-approval-routes.js';
import { registerProductSyncCenterRoutes } from './product/product-sync-center-routes.js';
import type { ProductSyncCenterUnitOfWork, SyncConflictKeyringReadiness } from '../modules/sync/index.js';
import type {
  Phase3SyncProfileClaims,
  Phase3SyncProfileClaimController,
} from '../modules/sync/index.js';
import { registerEmailCallbackRoutes, type EmailCallbackRoutesDependencies } from './product/email-callback-routes.js';
import { registerEmailOpsRoutes, type EmailOpsRoutesDependencies } from './product/email-ops-routes.js';
import {
  allowedMethods,
  isMalformedUrlError,
  isPublicationUrl,
  isProductUrl,
  mapFrameworkError,
  matchesBookmarkFaviconHelperPath,
  sendBadUrlProductError,
} from './app-error-mapping.js';
import {
  installSyncTelemetry,
  matchesConflictPath,
  matchesEffectPagePath,
  registerColpSync,
} from './colp-sync/register-colp-sync.js';
import { registerProductSurfaces } from './register-product-surfaces.js';
import { registerMcpSurfaces } from './mcp/register-mcp.js';
import type { AppDependencies } from './app-dependencies.js';
export type { AppDependencies } from './app-dependencies.js';
import { registerReadyRoutes } from './app-register-ready.js';
import { registerTestOidcAuthorizeRoute } from './app-test-oidc.js';
export { mapFrameworkError } from './app-error-mapping.js';

export type { ProductRouteConfig } from './product-admission.js';
export { ProductHttpError } from './product-error.js';
declare module 'fastify' {
  interface FastifyInstance {
    /**
     * C4 security-epoch bridge injected by the composition (F2 production
     * wiring). Absent keeps the account security-event surface closed.
     */
    readonly securityEpochBridge?: SecurityEpochBridge;
  }
}

export function buildApiApp(input: AppDependencies) {
  const {
  config,
  readiness = alwaysReady,
  cacheReadiness,
  cacheCapabilityReadiness,
  identityUnitOfWork,
  avatarStore,
  faviconStore, linkPreviewStore,
  collectionsUnitOfWork,
  productCollectionMutationUnitOfWork,
  collectionMetadataMutationRoutes = 'enabled',
  collectionsEditorReadUnitOfWork,
  collectionChildrenReadUnitOfWork,
  ownedCollectionsQuery,
  sharedCollectionsQuery,
  bookmarkCounts,
  annotationMutationUnitOfWork,
  annotationReadUnitOfWork,
  relationMutationUnitOfWork,
  relationReadUnitOfWork,
  oidcProvider,
  browserSessionAuthority,
  accountLinking,
  accountRecovery,
  accountDeletion,
  betterAuthRuntime,
  securityEpochBridge,
  metrics = new InMemoryMetrics(),
  authRateLimiter,
  searchRateLimiter,
  exploreDirectoryRateLimiter,
  publicActivityRateLimiter,
  syncColpRateLimiter,
  effectPageRateLimiter,
  mcpRateLimiter,
  searchTimeoutMs,
  publicationSnapshotQuery,
  publicationMetadataQuery,
  explorePageQuery,
  exploreCreatorsQuery,
  publicationSnapshotCacheReader,
  publicationDirectoryCacheReader,
  publicationMetadataCacheReader,
  productPublicCollectionQuery,
  productPublicInsight,
  productPublishingInsights,
  productCollaboration,
  publicProfileQuery,
  searchQuery,
  publicationProfileClaims,
  publicationProfileClaimController,
  syncProfileClaims,
  syncProfileClaimController,
  mcpReadProfileClaims,
  mcpReadProfileClaimController,
  mcpWriteProfileClaims,
  mcpWriteProfileClaimController,
  syncSessionRoutes,
  syncSnapshotRoutes,
  syncPushRoutes,
  syncConflictRoutes,
  syncPullRoutes,
  syncEffectPageRoutes,
  syncAckRoutes,
  syncRetireRoutes,
  extensionCollectionRoutes,
  productSyncCenterUnitOfWork,
  syncConflictsCapabilityReadiness,
  followRateLimiter,
  collectionFollowRateLimiter,
  libraryOrderCommandUnitOfWork,
  libraryOrderQueryUnitOfWork,
  libraryOrderRateLimiter,
  governanceReportRateLimiter, governanceActionRateLimiter, governanceAppealRateLimiter,
  bookmarkPreferencesUnitOfWork, bookmarkPreferencesQuery,
  feedRateLimiter,
  linkHealthRateLimiter,
  classifyInboxRateLimiter,
  exportJobRateLimiter,
  organizePlanRateLimiter,
  collectionVersionRateLimiter,
  readableReplicaRateLimiter,
  publicObjectRateLimiter,
  notificationRateLimiter,
  emailCallbackRoutes,
  emailOpsRoutes,
  mcpReadTransport,
  mcpReadOperations,
  mcpReadResourceProjection,
  mcpNodeResourceProjection,
  mcpSnapshotResourceProjection,
  mcpWriteApprovalRoutes,
  mcpWriteOperations,
  } = input;
  if (publicationProfileClaims !== undefined && publicationProfileClaimController !== undefined) {
    throw new TypeError('API composition accepts either fixed Publication claims or a claim controller');
  }
  if (mcpReadProfileClaims !== undefined && mcpReadProfileClaimController !== undefined) {
    throw new TypeError('API composition accepts either fixed MCP Read claims or a claim controller');
  }
  if (mcpReadProfileClaimController !== undefined) {
    assertPhase4bMcpReadProfileClaimController(mcpReadProfileClaimController);
  }
  if ((mcpReadProfileClaims !== undefined || mcpReadProfileClaimController !== undefined)
    && config.mcp === undefined) {
    throw new TypeError('MCP Read Profile claims require the MCP Read feature config');
  }
  if (mcpWriteProfileClaims !== undefined && mcpWriteProfileClaimController !== undefined) {
    throw new TypeError('API composition accepts either fixed MCP Write claims or a claim controller');
  }
  if (mcpWriteProfileClaimController !== undefined) {
    assertPhase4bMcpWriteProfileClaimController(mcpWriteProfileClaimController);
  }
  if ((mcpWriteProfileClaims !== undefined || mcpWriteProfileClaimController !== undefined)
    && config.mcp === undefined) {
    throw new TypeError('MCP Write Profile claims require the MCP Read feature config');
  }
  if (collectionMetadataMutationRoutes === 'disabled' && config.nodeEnv !== 'test') {
    throw new Error('Collection create/update routes may only be disabled in test composition');
  }
  const productRouteRateLimiters = [
    { purpose: 'library-order', limiter: libraryOrderRateLimiter },
    { purpose: 'link-health', limiter: linkHealthRateLimiter },
    { purpose: 'classify-inbox', limiter: classifyInboxRateLimiter },
    { purpose: 'classification-profile', limiter: input.classificationProfilesRateLimiter },
    { purpose: 'classification-run', limiter: input.classificationRunsRateLimiter },
    { purpose: 'classification-settings', limiter: input.classificationSettingsRateLimiter },
    { purpose: 'classification-preview', limiter: input.classificationPreviewRateLimiter },
    { purpose: 'classification-confirmation', limiter: input.classificationConfirmationRateLimiter },
    { purpose: 'export-job', limiter: exportJobRateLimiter },
    { purpose: 'organize-plan', limiter: organizePlanRateLimiter },
    { purpose: 'collection-version', limiter: collectionVersionRateLimiter },
    { purpose: 'readable-replica', limiter: readableReplicaRateLimiter },
    { purpose: 'public-object', limiter: publicObjectRateLimiter },
    { purpose: 'credits-read', limiter: input.creditsReadRateLimiter },
    { purpose: 'reports', limiter: input.reportsRateLimiter },
    // CS: the four contract COMMUNITY_RATE_LIMITS families are sealed
    // product-surface purposes; shared mode requires purpose-matched
    // adapters just like every other product-route family.
    { purpose: 'community-vote', limiter: input.communityRateLimiters?.vote },
    { purpose: 'community-comment', limiter: input.communityRateLimiters?.comment },
    { purpose: 'community-curation', limiter: input.communityRateLimiters?.curation },
    { purpose: 'community-public-reads', limiter: input.communityRateLimiters?.publicReads },
    { purpose: 'governance-report', limiter: governanceReportRateLimiter }, { purpose: 'governance-action', limiter: governanceActionRateLimiter }, { purpose: 'governance-appeal', limiter: governanceAppealRateLimiter },
  ] as const;
  assertSharedProductRateLimiters(config.productRouteRateLimitShared.enabled, productRouteRateLimiters);
  // FIX-M-018 composition guard: the shared MCP limiter must be injected when
  // MCP_RATE_LIMIT_SHARED=true and an MCP feature is enabled (the production
  // composition injects the Redis adapter; a memory adapter keeps the shared
  // config inert in tests). Fail closed BEFORE any MCP route can register.
  if (config.mcpRateLimit.enabled && mcpRateLimiter === undefined
      && (config.mcp !== undefined || config.mcpWriteEnabled)) {
    throw new Error(
      'buildApiApp requires an injected mcpRateLimiter when MCP_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
    );
  }
  // T-EMAIL-004 composition guard: the shared email callback limiter must be
  // injected when EMAIL_CALLBACK_RATE_LIMIT_SHARED=true and the email feature
  // is enabled (the production composition injects the Redis adapter; a
  // memory adapter keeps the shared config inert in tests). Fail closed
  // BEFORE any callback route can silently stay unmounted.
  if (config.email?.enabled === true && config.email.callbackRateLimitShared.enabled === true
      && emailCallbackRoutes === undefined) {
    throw new Error(
      'buildApiApp requires injected emailCallbackRoutes when EMAIL_CALLBACK_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
    );
  }
  if (
    identityUnitOfWork
    && collectionsUnitOfWork
    && !productCollectionMutationUnitOfWork
  ) {
    throw new Error(
      'Collection and node mutation routes require a canonical product mutation unit of work',
    );
  }
  const security = config.httpSecurity;
  const app = Fastify<Server, IncomingMessage, ServerResponse<IncomingMessage>>({
    loggerInstance: createLogger(config.logLevel) as FastifyBaseLogger,
    bodyLimit: security.bodyLimitBytes,
    requestTimeout: security.requestTimeoutMs,
    connectionTimeout: security.connectionTimeoutMs,
    keepAliveTimeout: security.keepAliveTimeoutMs,
    // P4A-P10 graceful shutdown: `false` makes `app.close()` WAIT for
    // in-flight requests to drain (Node 19+ `server.close()` closes idle
    // keep-alive connections by itself). Fastify's default `'idle'` mode
    // falls through to `closeAllConnections()` when no `serverFactory` is
    // configured and destroys ACTIVE requests — the ops runbook promises a
    // drain (in-flight uploads must complete through a shutdown).
    forceCloseConnections: false,
    // FIX-M-006 / SEC-T-04: only a socket peer inside the explicit
    // trusted-ingress allowlist (CIDRs/addresses) can contribute
    // X-Forwarded-For entries to request.ip. An empty allowlist — including
    // an explicit TRUSTED_INGRESS="" peer-only declaration — is never a
    // hop-count trustProxy. Hop-count is a non-production fallback for an
    // *undeclared* allowlist only; production refuses TRUSTED_PROXY_HOPS>0
    // in loadHttpSecurity, so it cannot reach hops>0 here.
    trustProxy: security.trustedIngress.length > 0
      ? [...security.trustedIngress]
      : (config.nodeEnv !== 'production'
        && !security.trustedIngressDeclared
        && security.trustedProxyHops > 0
          ? (_address: string, hop: number) => hop < security.trustedProxyHops
          : false),
    genReqId: () => randomUUID(),
    routerOptions: {
      maxParamLength: 128,
      querystringParser: parseStrictQuery,
      onBadUrl: (path, _request, response) => sendBadUrlProductError(path, response, { enableHsts: security.enableHsts }),
    },
  });
  // P4A-P10 graceful shutdown (bounded): with `forceCloseConnections: false`
  // Node's `server.close()` would otherwise wait for idle keep-alive sockets
  // up to the configured keep-alive timeout (72s default). `preClose` runs
  // BEFORE fastify's built-in close hook (which blocks on `server.close()`),
  // so this sweep closes idle keep-alive sockets immediately and keeps
  // sweeping while in-flight requests drain — shutdown only waits for ACTIVE
  // requests (the drain the ops runbook promises).
  app.addHook('preClose', async () => {
    app.server.closeIdleConnections?.();
    const sweep = setInterval(() => app.server.closeIdleConnections?.(), 500);
    sweep.unref?.();
    app.server.once('close', () => clearInterval(sweep));
  });
  installProductRouteManifestChecks(app, {
    requireComplete: Boolean(
      identityUnitOfWork
      && collectionsUnitOfWork
      && productCollectionMutationUnitOfWork
      && collectionMetadataMutationRoutes === 'enabled'
      && collectionsEditorReadUnitOfWork
      && collectionChildrenReadUnitOfWork
      && ownedCollectionsQuery
      && sharedCollectionsQuery
      && annotationMutationUnitOfWork
      && annotationReadUnitOfWork
      && relationMutationUnitOfWork
      && relationReadUnitOfWork
      && productPublicCollectionQuery
      && publicProfileQuery
      && searchQuery
      && productSyncCenterUnitOfWork
      && libraryOrderCommandUnitOfWork
      && libraryOrderQueryUnitOfWork
      && bookmarkPreferencesUnitOfWork && bookmarkPreferencesQuery && input.captureRuntime && input.captureHistory && input.captureLearning
      && mcpWriteApprovalRoutes !== undefined
    ),
    // F2: Better Auth mode composes zero legacy OIDC routes while the
    // OpenAPI keeps the operations marked deprecated (rollback-safe), so the
    // coverage assertion skips them in BA mode. Legacy mode keeps the full
    // requirement.
    // BF-02: GET is registered when faviconStore is composed. POST/DELETE
    // are always registered (503 when the store is absent). Skip GET coverage
    // so complete apps without R2 still start. Do not stub 503 GET handlers.
    excludeOperationIds: [
      ...(config.betterAuth.enabled ? LEGACY_OIDC_OPERATION_IDS : []),
      ...BOOKMARK_FAVICON_DEFERRED_OPERATION_IDS,
      ...(faviconStore ? [] : ['getBookmarkFavicon']), ...(linkPreviewStore ? [] : ['getLinkPreviewObject']),
      ...(explorePageQuery ? [] : [...EXPLORE_OPERATION_IDS]),
      'listPublicProfileActivity',
      'headPublicProfileActivity',
    ], classificationByokEnabled: config.classification?.enabled === true && config.classification?.byokEnabled === true,
  });
  app.decorate('metrics', metrics);
  app.decorate('tracer', new NoopTracer());
  // A3: the BrowserSessionAuthority is reachable from every route through the
  // decorated server instance (requireSessionActor / optionalSessionActor
  // resolve it per request; absent = legacy OIDC session authority serves).
  if (browserSessionAuthority) {
    app.decorate('browserSessionAuthority', browserSessionAuthority);
  }
  // C4 (F2 production composition): the security-epoch bridge is reachable
  // from every route through the decorated server instance (epoch bump +
  // revoke-all + MCP OAuth propagation); absent keeps the surface closed.
  if (securityEpochBridge) {
    app.decorate('securityEpochBridge', securityEpochBridge);
  }
  installSyncTelemetry(app, metrics, {
    syncSessionRoutes, syncSnapshotRoutes, syncPushRoutes, syncConflictRoutes,
    syncPullRoutes, syncAckRoutes, syncRetireRoutes,
  });
  installHttpSecurity(app, {
    security,
    authRateLimiter,
    metrics,
    // F2: Better Auth mode must not keep the legacy OIDC rate-limit families
    // live (no bucket for /api/v1/auth/oidc/*; the routes are absent anyway).
    ...(config.betterAuth.enabled ? { excludeLegacyOidcFamilies: true } : {}),
  });
  installProductAdmission(app, {
    exposeAutomationIdentity: config.accountCredentials.exposeAutomationIdentity,
  });

  installClassificationExtensionCors(app, config);
  // Precise CORS for same-site browser clients (credentials, no wildcard).
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    const productOrigin = typeof origin === 'string' && config.allowedOrigins.includes(origin);
    const requestPath = request.url.split('?', 1)[0] ?? request.url;
    if (isCreditLedgerPath(requestPath) && reply.hasHeader('Access-Control-Allow-Origin')) return;
    const betterAuthExtensionOrigin = typeof origin === 'string'
      && origin.startsWith('chrome-extension://')
      && config.betterAuth.enabled
      && requestPath.startsWith(config.betterAuth.basePath)
      && config.betterAuth.trustedOrigins.includes(origin);
    const collectionsOrigin = requestPath === EXTENSION_COLLECTIONS_PATH
      && typeof origin === 'string'
      && extensionCollectionRoutes?.allowedOrigins.includes(origin.replace(/\/$/u, '')) === true;
    const syncOrigin = (requestPath === syncSessionRoutes?.path || requestPath === syncSnapshotRoutes?.path
      || requestPath === syncPushRoutes?.path
      || requestPath === syncPullRoutes?.path
      || requestPath === syncAckRoutes?.path
      || requestPath === syncRetireRoutes?.path
      || (syncConflictRoutes !== undefined
        && matchesConflictPath(syncConflictRoutes.pathTemplate, requestPath))
      || (syncEffectPageRoutes !== undefined
        && matchesEffectPagePath(syncEffectPageRoutes.pathTemplate, requestPath)))
      && typeof origin === 'string'
      && (syncSessionRoutes?.allowedOrigins.includes(origin) === true
        || syncSnapshotRoutes?.allowedOrigins.includes(origin) === true
        || syncPushRoutes?.allowedOrigins.includes(origin) === true
        || syncPullRoutes?.allowedOrigins.includes(origin) === true
        || syncEffectPageRoutes?.allowedOrigins.includes(origin) === true
        || syncAckRoutes?.allowedOrigins.includes(origin) === true
        || syncRetireRoutes?.allowedOrigins.includes(origin) === true
        || syncConflictRoutes?.allowedOrigins.includes(origin) === true);
    const bookmarkFaviconHelperOrigin = matchesBookmarkFaviconHelperPath(requestPath)
      && typeof origin === 'string'
      && extensionCollectionRoutes?.allowedOrigins.includes(origin.replace(/\/$/u, '')) === true;
    if (bookmarkFaviconHelperOrigin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      reply.header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Origin, Known-Command-Id, If-Match, Known-Favicon-Policy-Revision',
      );
      reply.header('Access-Control-Expose-Headers', 'ETag, Cache-Control, X-Request-Id, RateLimit-Policy, Retry-After');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (request.method === 'OPTIONS' && bookmarkFaviconHelperOrigin) {
      return reply.code(204).send();
    }
    if (productOrigin || syncOrigin || betterAuthExtensionOrigin || collectionsOrigin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      reply.header(
        'Access-Control-Allow-Headers',
        betterAuthExtensionOrigin
          ? 'Authorization, Content-Type, Cookie, Origin, X-CSRF-Token, X-Known-Auth-Intent'
          : syncOrigin || collectionsOrigin
            ? 'Authorization, Content-Type, Cookie, Origin, Idempotency-Key, If-Match, Known-Sync-Session'
            : 'Content-Type, If-Match, If-None-Match, If-Content-Match, Known-Command-Id, X-CSRF-Token, X-Known-Auth-Intent, Known-Subscription-Exit-Preview',
      );
      reply.header(
        'Access-Control-Expose-Headers',
        syncOrigin || collectionsOrigin ? 'RateLimit-Policy, Retry-After' : 'ETag, Location, Retry-After, X-Request-Id, Known-Subscription-Session, Known-Bookmark-Session',
      );
      reply.header('Access-Control-Allow-Methods', syncOrigin || collectionsOrigin
        ? 'GET, POST, DELETE, OPTIONS' : 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (request.method === 'OPTIONS' && (productOrigin || syncOrigin || betterAuthExtensionOrigin || collectionsOrigin)) {
      return reply.code(204).send();
    }
  });

  registerReadyRoutes(app, input, {
    readiness,
    security,
    cacheReadiness,
    cacheCapabilityReadiness,
    searchRateLimiter,
    exploreDirectoryRateLimiter,
    publicActivityRateLimiter,
    syncColpRateLimiter,
    followRateLimiter,
    collectionFollowRateLimiter,
    feedRateLimiter,
    notificationRateLimiter,
    productRouteRateLimiters,
    effectPageRateLimiter,
    mcpRateLimiter,
    syncConflictsCapabilityReadiness,
    metrics,
  });

  registerProductSurfaces(app, {
    ...input,
    readiness,
    metrics,
    collectionMetadataMutationRoutes,
  }, { registerTestOidcAuthorizeRoute });
  registerColpSync(app, {
    ...input,
    readiness,
    metrics,
    collectionMetadataMutationRoutes,
  });
  const mcpOperations = registerMcpSurfaces(app, {
    ...input,
    readiness,
    metrics,
    collectionMetadataMutationRoutes,
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?', 1)[0] ?? request.url;
    if (config.mcp && pathname === config.mcp.endpointPath && request.method !== 'POST') {
      mcpOperations?.recordLegacyRejection('http_method');
      return sendProductError(request, reply, new ProductHttpError({
        statusCode: 405,
        code: 'method_not_allowed',
        message: 'This method is not allowed for the requested resource.',
        headers: { Allow: 'POST' },
      }));
    }
    const allowed = allowedMethods(app, request.url);
    if (allowed.length > 0) {
      if (isPublicationUrl(request.url)) {
        return sendPublicationFrameworkError(request, reply, {
          statusCode: 405,
          allowedMethods: allowed,
        });
      }
      return sendProductError(request, reply, new ProductHttpError({
        statusCode: 405,
        code: 'method_not_allowed',
        message: 'This method is not allowed for the requested resource.',
        headers: { Allow: allowed.join(', ') },
      }));
    }
    if (isPublicationUrl(request.url)) {
      return sendPublicationFrameworkError(request, reply, { statusCode: 404 });
    }
    return sendProductError(request, reply, new ProductHttpError({
      statusCode: 404,
      code: 'resource_not_found',
      message: 'The requested resource was not found.',
      recovery: 'none',
    }));
  });

  app.setErrorHandler((error: FastifyError | ProductHttpError, request, reply) => {
    // FIX-L-004: a malformed URL on ANY /api/v1/** path maps to the same
    // fixed invalid_request Product envelope (the per-path profile 404 /
    // search invalid_query special cases are gone). Other surfaces keep
    // their own protocols below.
    const productError = isProductUrl(request.url) && isMalformedUrlError(error)
      ? new ProductHttpError({
          statusCode: 400,
          code: 'invalid_request',
          message: 'The request URL is invalid.',
          recovery: 'user_action',
        })
      : mapFrameworkError(error);
    if (isPublicationUrl(request.url)) {
      return sendPublicationFrameworkError(request, reply, productError);
    }
    if (productError.statusCode >= 500) {
      // Database causes can contain SQL, parameters, or connection details.
      // Log only the stable classification at the HTTP boundary.
      if (error instanceof DatabaseOperationError) {
        request.log.error({ databaseFailure: error.kind }, 'request failed');
      } else {
        request.log.error({ err: error }, 'request failed');
      }
    }
    return sendProductError(request, reply, productError);
  });
  return app;
}
