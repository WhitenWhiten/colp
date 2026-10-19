import { registerFaviconPolicyRoutes } from './product/favicon-policy-routes.js';
import { registerFaviconJobRoutes } from './product/favicon-job-routes.js';
import type { FastifyInstance } from 'fastify';
import { InMemoryMetrics } from '../infrastructure/telemetry/index.js';
import {
  createFixedWindowRateLimiter,
  isProductSurfaceRateLimiter,
  type ProductAdmissionRateLimiter,
} from './http-security.js';
import type { ProductSurfaceRateLimitPurpose } from '../infrastructure/rate-limit/index.js';
import { registerBrowserAuthRoutes } from './auth/browser-auth-routes.js';
import { registerBookmarkFaviconRoutes } from './product/bookmark-favicon-routes.js';
import { registerBetterAuthRoutes } from './auth/better-auth-routes.js';
import { registerOauthAuthorizationServerMetadataRoute } from './auth/oauth-authorization-server-routes.js';
import { registerCollectionRoutes } from './product/collection-routes.js';
import { registerPublicationSnapshotRoutes } from './product/publication-snapshot-routes.js';
import { registerPublicationDirectoryRoutes } from './product/publication-directory-routes.js';
import { registerPublicationMetadataRoutes } from './product/publication-metadata-routes.js';
import { registerPublicationManifestRoutes } from './product/publication-manifest-routes.js';
import { registerProductPublicCollectionRoutes } from './product/product-public-collection-routes.js';
import { registerProductCollaborationRoutes } from './product/product-collaboration-routes.js';
import { registerSharedCollectionRoutes } from './product/shared-collection-routes.js';
import { registerProductSyncCenterRoutes } from './product/product-sync-center-routes.js';
import { registerAccountCredentialSurfaces } from './product/register-account-credential-surfaces.js';
import { registerLibraryOrderRoutes } from './product/library-order-routes.js';
import { registerAccountProductSurfaces } from './register-account-product-surfaces.js';
import { registerLinkHealthRoutes } from './product/link-health-routes.js';
import { registerLinkPreviewCommandRoutes } from './product/link-preview-command-routes.js';
import { registerLinkPreviewRoutes } from './product/link-preview-routes.js';
import { registerCollectionExportRoutes } from './product/collection-export-routes.js';
import { registerCollectionVersionRoutes } from './product/collection-version-routes.js';
import { registerSearchRoutes } from './product/search-routes.js';
import type { AppDependencies } from './app-dependencies.js';
import { mcpReadFeatureConfigAssertOptions } from '../modules/mcp/index.js';

export function registerProductSurfaces(
  app: FastifyInstance,
  deps: AppDependencies,
  extras: {
    registerTestOidcAuthorizeRoute: (
      app: FastifyInstance,
      config: AppDependencies['config'],
      betterAuthEnabled: boolean,
    ) => void;
  },
): void {
  const {
    config,
    identityUnitOfWork,
    avatarStore,
    faviconStore,
    libraryCollectionUnitOfWork,
    collectionsUnitOfWork,
    productCollectionMutationUnitOfWork,
    collectionMetadataMutationRoutes = 'enabled',
    collectionsEditorReadUnitOfWork,
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
    metrics = new InMemoryMetrics(),
    searchRateLimiter,
    exploreDirectoryRateLimiter,
    publicActivityRateLimiter,
    searchTimeoutMs,
    publicationSnapshotQuery,
    publicationDirectoryQuery,
    publicationMetadataQuery,
    publicationSnapshotCacheReader,
    publicationDirectoryCacheReader,
    publicationMetadataCacheReader,
    productPublicCollectionQuery,
    productCollaboration,
    searchQuery,
    publicationProfileClaims,
    publicationProfileClaimController,
    syncProfileClaims,
    syncProfileClaimController,
    mcpReadProfileClaims,
    mcpReadProfileClaimController,
    mcpWriteProfileClaims,
    mcpWriteProfileClaimController,
    extensionCollectionRoutes,
    productSyncCenterUnitOfWork,
    accountCredentialUnitOfWork, accountCredentialCursors, accountCredentialGrantCursors, credentialsRateLimiter, credentialIssuanceRateLimiter, automationTokenCredentialRateLimiter, automationTokenClientRateLimiter,
    libraryOrderCommandUnitOfWork,
    libraryOrderQueryUnitOfWork,
    libraryOrderRateLimiter,
    faviconPolicyRateLimiter,
    linkHealthQuery,
    linkHealthEnqueue,
    linkHealthRateLimiter,
    collectionExportReads,
    collectionVersions,
    collectionVersionCursors,
    collectionVersionRateLimiter,
    publicObjectRateLimiter,
  } = deps;
  const registerTestOidcAuthorizeRoute = extras.registerTestOidcAuthorizeRoute;
  const security = config.httpSecurity;
  const resolveProductRouteRateLimiter = (
    purpose: ProductSurfaceRateLimitPurpose,
    limiter: ProductAdmissionRateLimiter | undefined,
    budget: { readonly maxRequests: number; readonly windowMs: number },
  ): ProductAdmissionRateLimiter => {
    if (config.productRouteRateLimitShared.enabled) {
      if (!limiter || !isProductSurfaceRateLimiter(limiter) || limiter.purpose !== purpose) {
        throw new Error(
          `buildApiApp requires an injected ${purpose} shared rate limiter when PRODUCT_ROUTE_RATE_LIMIT_SHARED=true`,
        );
      }
      return limiter;
    }
    return limiter ?? createFixedWindowRateLimiter(budget);
  };
  const defaultProductRouteBudget = Object.freeze({ maxRequests: 120, windowMs: 60_000 });
  const publicObjectAdmissionRateLimiter = resolveProductRouteRateLimiter(
    'public-object', publicObjectRateLimiter, defaultProductRouteBudget,
  );
  const requireExploreDirectoryLimiter = (): NonNullable<AppDependencies['exploreDirectoryRateLimiter']> => {
    if (exploreDirectoryRateLimiter === undefined) {
      if (config.exploreDirectoryRateLimit.shared.enabled) {
        throw new Error(
          'buildApiApp requires an injected exploreDirectoryRateLimiter when EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
        );
      }
      throw new Error(
        'buildApiApp requires an injected exploreDirectoryRateLimiter whenever Explore/Directory routes are registered',
      );
    }
    return exploreDirectoryRateLimiter;
  };
  const requireSearchRateLimiter = (): NonNullable<AppDependencies['searchRateLimiter']> => {
    if (searchRateLimiter === undefined) {
      if (security.searchRateLimit.shared.enabled) {
        throw new Error(
          'buildApiApp requires an injected searchRateLimiter when SEARCH_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
        );
      }
      throw new Error(
        'buildApiApp requires an injected searchRateLimiter whenever Search routes are registered',
      );
    }
    return searchRateLimiter;
  };
  if (identityUnitOfWork) {
    registerBrowserAuthRoutes(app, {
      config,
      identityUnitOfWork,
      oidcProvider,
      metrics,
      avatarStore, ...(deps.avatarPublicAccess ? { avatarPublicAccess: deps.avatarPublicAccess } : {}),
      publicObjectRateLimiter: publicObjectAdmissionRateLimiter,
      ...(browserSessionAuthority ? { browserSessionAuthority } : {}),
      ...(accountLinking ? { accountLinking } : {}),
      ...(accountRecovery ? { accountRecovery } : {}),
      ...(accountDeletion ? { accountDeletion } : {}),
    });
  }
  registerBookmarkFaviconRoutes(app, {
    config,
    ...(faviconStore ? { faviconStore } : {}), ...(deps.faviconPublicAccess ? { faviconPublicAccess: deps.faviconPublicAccess } : {}),
    ...(identityUnitOfWork ? { identityUnitOfWork } : {}),
    ...(collectionsUnitOfWork ? { collectionsUnitOfWork } : {}),
    ...(extensionCollectionRoutes ? { extensionCollectionRoutes } : {}),
    ...(metrics ? { metrics } : {}),
    publicObjectRateLimiter: publicObjectAdmissionRateLimiter,
  });
  if (deps.linkPreview) {
    registerLinkPreviewRoutes(app, {
      store: deps.linkPreview.store,
      publicAccess: deps.linkPreview.publicAccess,
      publicObjectRateLimiter: publicObjectAdmissionRateLimiter,
      requestTimeoutMs: config.httpSecurity.requestTimeoutMs,
      ...(identityUnitOfWork ? { identityUnitOfWork } : {}),
    });
    if (identityUnitOfWork) {
      registerLinkPreviewCommandRoutes(app, {
        enabled: true,
        allowedOrigins: config.allowedOrigins,
        identityUnitOfWork,
        unitOfWork: deps.linkPreview.commands,
        rateLimiter: createFixedWindowRateLimiter(defaultProductRouteBudget),
      });
    }
  }
  if (identityUnitOfWork && productSyncCenterUnitOfWork) {
    registerProductSyncCenterRoutes(app, { config, identityUnitOfWork, unitOfWork: productSyncCenterUnitOfWork });
  }
  registerTestOidcAuthorizeRoute(app, config, config.betterAuth.enabled);
  // A4: the flag-off path mounts no Better Auth surface; enabled mode mounts
  // only allowlisted /api/v1/auth routes through the A1 bridge and standard
  // Product error/Origin/raw-token handling.
  if (config.betterAuth.enabled && betterAuthRuntime) {
    registerBetterAuthRoutes(app, {
      betterAuthRuntime,
      allowedOrigins: config.betterAuth.trustedOrigins,
      ...(browserSessionAuthority ? { browserSessionAuthority } : {}),
    });
  }
  // T-05 / ADR D6: issuer-inserted AS metadata is independent of MCP Read.
  if (config.betterAuth.oauthIssuerEnabled) {
    if (betterAuthRuntime?.handle === undefined) {
      throw new Error(
        'BETTER_AUTH_OAUTH_ISSUER_ENABLED=true requires a Better Auth runtime handler',
      );
    }
    registerOauthAuthorizationServerMetadataRoute(app, {
      basePath: config.betterAuth.basePath,
      handle: betterAuthRuntime.handle,
    });
  }
  if (publicationSnapshotQuery) {
    registerPublicationSnapshotRoutes(app, {
      config: config.publication,
      query: publicationSnapshotQuery,
      ...(identityUnitOfWork ? { identityUnitOfWork } : {}),
      ...(config.contentGovernance.enabled || publicationSnapshotCacheReader === undefined ? {} : { reader: publicationSnapshotCacheReader }),
      rateLimiter: requireExploreDirectoryLimiter(),
    });
  }
  if (publicationDirectoryQuery) {
    registerPublicationDirectoryRoutes(app, {
      config: config.publication,
      query: publicationDirectoryQuery,
      ...(identityUnitOfWork ? { identityUnitOfWork } : {}),
      ...(config.contentGovernance.enabled || publicationDirectoryCacheReader === undefined ? {} : { reader: publicationDirectoryCacheReader }),
      rateLimiter: requireExploreDirectoryLimiter(),
    });
  }
  if (publicationMetadataQuery) {
    registerPublicationMetadataRoutes(app, {
      config: config.publication,
      query: publicationMetadataQuery,
      ...(identityUnitOfWork ? { identityUnitOfWork } : {}),
      ...(config.contentGovernance.enabled || publicationMetadataCacheReader === undefined ? {} : { reader: publicationMetadataCacheReader }),
      rateLimiter: requireExploreDirectoryLimiter(),
      contentGovernanceEnabled: config.contentGovernance.enabled,
    });
  }
  if (publicationSnapshotQuery && publicationDirectoryQuery && publicationMetadataQuery) {
    registerPublicationManifestRoutes(
      app,
      config.publication,
      publicationProfileClaims,
      publicationProfileClaimController,
      syncProfileClaims,
      syncProfileClaimController,
      config.mcp,
      mcpReadProfileClaims,
      mcpReadProfileClaimController,
      mcpWriteProfileClaims,
      mcpWriteProfileClaimController,
      {
        ...mcpReadFeatureConfigAssertOptions({
          nodeEnv: config.nodeEnv,
          oauthIssuerEnabled: config.betterAuth.oauthIssuerEnabled,
        }),
        advertiseRead: config.mcp !== undefined,
        advertiseWrite: config.mcpWriteEnabled === true,
      },
    );
  }
  if (productPublicCollectionQuery) {
    registerProductPublicCollectionRoutes(app, {
      query: productPublicCollectionQuery,
      ...(identityUnitOfWork ? { identityUnitOfWork } : {}),
      rateLimiter: requireExploreDirectoryLimiter(), contentGovernanceEnabled: config.contentGovernance.enabled,
    });
  }
  if (identityUnitOfWork && sharedCollectionsQuery) {
    if (!bookmarkCounts) {
      throw new Error('shared Collection list requires CollectionBookmarkCountReadPort');
    }
    registerSharedCollectionRoutes(app, {
      identityUnitOfWork,
      sharedCollectionsQuery,
      bookmarkCounts,
    });
  }
  if (productCollaboration) {
    registerProductCollaborationRoutes(app, productCollaboration);
  }
  if ((libraryOrderCommandUnitOfWork === undefined) !== (libraryOrderQueryUnitOfWork === undefined)) {
    throw new TypeError('Library order command and query production ports must be configured together');
  }
  if (identityUnitOfWork && libraryOrderCommandUnitOfWork && libraryOrderQueryUnitOfWork) {
    registerLibraryOrderRoutes(app, {
      allowedOrigins: config.allowedOrigins,
      identityUnitOfWork,
      commandUnitOfWork: libraryOrderCommandUnitOfWork,
      queryUnitOfWork: libraryOrderQueryUnitOfWork,
      rateLimiter: resolveProductRouteRateLimiter('library-order', libraryOrderRateLimiter, config.libraryOrder.rateLimit),
      timeoutMs: config.libraryOrder.timeoutMs,
    });
  }
  if (identityUnitOfWork && collectionsUnitOfWork) {
    registerFaviconPolicyRoutes(app, {
      enabled: config.faviconPolicy.enabled,
      allowedOrigins: config.allowedOrigins,
      identityUnitOfWork,
      collectionsUnitOfWork,
      rateLimiter: resolveProductRouteRateLimiter('favicon-policy', faviconPolicyRateLimiter, defaultProductRouteBudget),
      timeoutMs: config.faviconPolicy.timeoutMs,
      productOrigin: config.productOrigin,
      retentionSeconds: config.faviconPolicy.historyRetentionSeconds,
    });
    registerFaviconJobRoutes(app, {
      enabled: config.faviconPolicy.enabled, allowedOrigins: config.allowedOrigins,
      identityUnitOfWork, collectionsUnitOfWork,
      rateLimiter: resolveProductRouteRateLimiter('favicon-policy', faviconPolicyRateLimiter, defaultProductRouteBudget),
      timeoutMs: config.faviconPolicy.timeoutMs,
    });
  }
  registerAccountProductSurfaces(app, deps);
  if ((linkHealthQuery === undefined) !== (linkHealthEnqueue === undefined)) {
    throw new TypeError('Link-health query and enqueue production ports must be configured together');
  }
  if (identityUnitOfWork && linkHealthQuery && linkHealthEnqueue) {
    registerLinkHealthRoutes(app, {
      enabled: config.linkHealth?.enabled ?? false,
      allowedOrigins: config.allowedOrigins,
      identityUnitOfWork,
      query: linkHealthQuery,
      enqueue: linkHealthEnqueue,
      rateLimiter: resolveProductRouteRateLimiter('link-health', linkHealthRateLimiter, config.linkHealth.rateLimit),
      timeoutMs: config.linkHealth?.timeoutMs ?? 2_000,
    });
  }
  if (identityUnitOfWork && collectionExportReads) {
    registerCollectionExportRoutes(app, {
      identityUnitOfWork,
      origin: config.publication.origin,
      reads: collectionExportReads,
      rateLimiter: createFixedWindowRateLimiter(defaultProductRouteBudget),
      timeoutMs: 2_000,
    });
  }
  const collectionVersionPorts = [collectionVersions, collectionVersionCursors];
  if (collectionVersionPorts.some(Boolean) && collectionVersionPorts.some((port) => port === undefined)) {
    throw new TypeError('Collection-version unit of work and cursor signer must be configured together');
  }
  if (identityUnitOfWork && collectionVersions && collectionVersionCursors) {
    registerCollectionVersionRoutes(app, {
      enabled: config.collectionHistory?.enabled ?? false,
      allowedOrigins: config.allowedOrigins,
      identityUnitOfWork,
      unitOfWork: collectionVersions,
      cursors: collectionVersionCursors,
      rateLimiter: resolveProductRouteRateLimiter(
        'collection-version', collectionVersionRateLimiter, defaultProductRouteBudget,
      ),
      timeoutMs: 2_000,
    });
  }
  if (searchQuery) {
    registerSearchRoutes(app, { query: searchQuery, ...(identityUnitOfWork ? { identityUnitOfWork } : {}),
      rateLimiter: requireSearchRateLimiter(), contentGovernanceEnabled: config.contentGovernance.enabled, config,
      ...(searchTimeoutMs === undefined ? {} : { timeoutMs: searchTimeoutMs }) });
  }
  // Collection product routes need session auth (identity) + collections write/read UoWs.
  if (identityUnitOfWork && accountCredentialUnitOfWork && config.accountCredentials.enabled) registerAccountCredentialSurfaces(app, { enabled: config.accountCredentials.enabled, identityUnitOfWork, unitOfWork: accountCredentialUnitOfWork, cursors: accountCredentialCursors ?? null, grantCursors: accountCredentialGrantCursors ?? null, rateLimiter: credentialsRateLimiter ?? createFixedWindowRateLimiter({ maxRequests: 120, windowMs: 60_000 }), timeoutMs: config.accountCredentials.timeoutMs, config, credentialTokenRateLimiter: automationTokenCredentialRateLimiter ?? null, clientTokenRateLimiter: automationTokenClientRateLimiter ?? null });
  if (identityUnitOfWork && collectionsUnitOfWork) {
    registerCollectionRoutes(app, {
      libraryCollectionUnitOfWork,
      folderShares: deps.folderShares,
      config,
      identityUnitOfWork,
      collectionsUnitOfWork,
      productCollectionMutationUnitOfWork,
      collectionMetadataMutationsEnabled: collectionMetadataMutationRoutes === 'enabled',
      collectionsEditorReadUnitOfWork,
      ownedCollectionsQuery,
      bookmarkCounts,
      annotationMutationUnitOfWork, annotationReadUnitOfWork,
      relationMutationUnitOfWork, relationReadUnitOfWork,
    });
  }
}
