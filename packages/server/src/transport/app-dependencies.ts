import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../bootstrap/config.js';
import type {
  CollectionsEditorReadUnitOfWork,
  CollectionChildrenReadUnitOfWork,
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
import type {
  CreditLedgerReadPort,
  BookmarkPreferencesPorts,
  BookmarkPreferencesStore,
  IdentityUnitOfWork,
  AvatarObjectStore,
  ExploreCreatorsQueryPort,
} from '../modules/identity/index.js';
import type { ExploreCollectionMarksPort } from './product/explore-routes.js';
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
  Phase4bMcpCompatOperations,
} from '../modules/mcp/index.js';
import type { CacheCapabilityReadiness, CacheReadinessState, ReadinessProbe } from '../infrastructure/health.js';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import type { AuthRateLimiter, EffectPageRateLimiter, McpRateLimiter, SearchRateLimiter, SyncAdmissionPolicy, SyncColpRateLimiter } from '../infrastructure/rate-limit/index.js';
import type { CommunityRateLimiters, ProductAdmissionRateLimiter } from './http-security.js';
import type { OidcProviderPort } from './auth/oidc-provider.js';
import type { PublicationSnapshotRouteReader } from './product/publication-snapshot-routes.js';
import type { PublicationDirectoryRouteReader } from './product/publication-directory-routes.js';
import type { PublicationMetadataRouteReader } from './product/publication-metadata-routes.js';
import type { PublicShellRoutePorts } from './public-shell-routes.js';
import type { CollectionOgImageRenderer } from '../infrastructure/http/index.js';
import type { ProfileSitemapQueryPort, PublicationSitemapQueryPort } from './collections-sitemap-routes.js';
import type { ProductPublicInsightRouteDependencies } from './product/product-public-insight-routes.js';
import type { ProductPublishingInsightsRouteDependencies } from './product/product-publishing-insights-routes.js';
import type { ProductCollaborationRouteDependencies } from './product/product-collaboration-routes.js';
import type { PublicProfileProjection } from '../bootstrap/public-profile-projection.js';
import type { SyncSessionRouteDependencies } from './colp-sync/sync-session-routes.js';
import type { SyncSnapshotRouteDependencies } from './colp-sync/sync-snapshot-routes.js';
import type { SyncPushRouteDependencies } from './colp-sync/sync-push-routes.js';
import type { SyncConflictRouteDependencies } from './colp-sync/sync-conflict-routes.js';
import type { SyncPullRouteDependencies } from './colp-sync/sync-pull-routes.js';
import type { SyncEffectPageRouteDependencies } from './colp-sync/sync-effect-page-routes.js';
import type { SyncAckRouteDependencies } from './colp-sync/sync-ack-routes.js';
import type { SyncRetireRouteDependencies } from './colp-sync/sync-retire-routes.js';
import type { ExtensionCollectionRouteDependencies } from './colp-sync/extension-collection-routes.js';
import type { SearchProductQuery } from './product/search-routes.js';
import type { ProductSyncCenterUnitOfWork, SyncConflictKeyringReadiness } from '../modules/sync/index.js';
import type {
  Phase3SyncProfileClaims,
  Phase3SyncProfileClaimController,
} from '../modules/sync/index.js';
import type { EmailCallbackRoutesDependencies } from './product/email-callback-routes.js';
import type { EmailOpsRoutesDependencies } from './product/email-ops-routes.js';
import type { AttachmentRoutesDependencies } from './product/attachment-routes.js';
import type { AttachmentsCapabilityReadiness } from '../modules/attachments/index.js';
import type { McpReadTransportDependencies } from './mcp/mcp-read-routes.js';
import type { McpWriteApprovalRoutesDependencies } from './mcp/mcp-write-approval-routes.js';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly readiness?: ReadinessProbe;
  /** T10 optional cache state for the main /ready fail-closed branch. */
  readonly cacheReadiness?: () => Promise<CacheReadinessState>;
  /** T10 optional /ready/features/cache capability payload provider. */
  readonly cacheCapabilityReadiness?: () => Promise<CacheCapabilityReadiness>;
  readonly identityUnitOfWork?: IdentityUnitOfWork;
  readonly creditLedgerRead?: CreditLedgerReadPort;
  readonly creditsReadRateLimiter?: ProductAdmissionRateLimiter;
  /** Optional public avatar object store. When present registers avatar upload/serve routes. */
  readonly avatarStore?: AvatarObjectStore;
  /**
   * Optional public bookmark favicon object store. When present registers
   * GET /api/v1/favicon/:id independently of identityUnitOfWork.
   */
  readonly faviconStore?: BookmarkFaviconObjectStore;
  /** LP-04 link preview object store; present registers GET /api/v1/link-preview/:previewId. */
  readonly linkPreviewStore?: BookmarkFaviconObjectStore;
  /** Live public attribution for that object route. Absent fails closed. */
  readonly linkPreviewPublicAccess?: { isServable(objectId: string, signal?: AbortSignal): Promise<boolean> };
  readonly faviconPublicAccess?: { isHiddenPublic(objectId: string): Promise<boolean> };
  readonly avatarPublicAccess?: { isPublicationRestricted(objectId: string): Promise<boolean> };
  readonly collectionsUnitOfWork?: CollectionsUnitOfWork;
  readonly productCollectionMutationUnitOfWork?: ProductCollectionMutationUnitOfWork;
  /** Explicitly disable collection create/metadata-update routes in narrow test compositions. */
  readonly collectionMetadataMutationRoutes?: 'enabled' | 'disabled';
  readonly collectionsEditorReadUnitOfWork?: CollectionsEditorReadUnitOfWork;
  /** FO-05 one-layer children reader (REPEATABLE READ + HMAC cursor). */
  readonly collectionChildrenReadUnitOfWork?: CollectionChildrenReadUnitOfWork;
  readonly ownedCollectionsQuery?: GetOwnedCollectionsPagePorts;
  readonly sharedCollectionsQuery?: GetSharedCollectionsPagePorts;
  readonly linkHealthQuery?: GetMyLinkHealthPagePorts;
  readonly classificationSettings?: {
    readonly autoEnabled?:boolean;
    readonly reads: Pick<import('../modules/collections/index.js').ClassificationSettingsStore, 'loadOwned'>;
    readonly commands: import('../modules/collections/index.js').ClassificationSettingsUnitOfWork;
  };
  readonly classificationProfiles?: import('../modules/collections/index.js').ClassificationProfilesRuntime;
  readonly classificationProfilesRateLimiter?: ProductAdmissionRateLimiter;
  readonly classificationRuns?: import('../modules/collections/index.js').ClassificationRunRuntime;
  readonly classificationRunsRateLimiter?: ProductAdmissionRateLimiter;
  readonly classificationSettingsRateLimiter?: ProductAdmissionRateLimiter;
  readonly classificationPreviewRateLimiter?: ProductAdmissionRateLimiter;
  readonly classificationConfirmationRateLimiter?: ProductAdmissionRateLimiter;
  readonly classificationConfirmation?: import('../modules/collections/index.js').ClassificationConfirmationUnitOfWork;
  readonly classificationPreview?: import('../modules/collections/index.js').ClassificationPreviewRuntime;
  readonly classifyInboxQuery?: GetMyClassifyInboxPagePorts;
  readonly classifyInboxSkip?: {
    execute<Result>(
      work: (ports: SkipClassifyInboxItemPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly classifyInboxAccept?: {
    execute<Result>(
      work: (ports: AcceptClassifyInboxItemPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly linkHealthEnqueue?: {
    execute<Result>(
      work: (ports: EnqueueMyLinkHealthChecksPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly exportJobReads?: ExportJobReadPort;
  readonly exportJobEnqueue?: {
    execute<Result>(
      work: (ports: CreateMyExportJobPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly exportJobStore?: ExportObjectStore;
  readonly organizePlanReads?: OrganizePlanReadPort;
  readonly organizePlanMutations?: {
    execute<Result>(
      work: (ports: ApplyCollectionOrganizePlanPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly organizePlanner?: OrganizePlanner;
  readonly collectionVersions?: {
    execute<Result>(
      work: (ports: CreateCollectionVersionPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly collectionVersionCursors?: ProductCollectionVersionCursorSignerPort;
  readonly collectionVersionRateLimiter?: ProductAdmissionRateLimiter;
  readonly readableReplicas?: ReadableReplicaReadUnitOfWork;
  readonly readableReplicaEnqueue?: ReadableReplicaEnqueueUnitOfWork;
  /** LP-05 preview request and owner-mode commands; routes 404 while the feature is off. */
  readonly linkPreviewCommands?: import('../modules/collections/index.js').LinkPreviewCommandUnitOfWork;
  readonly readableReplicaRateLimiter?: ProductAdmissionRateLimiter;
  readonly bookmarkCounts?: CollectionListBookmarkCountsPort;
  readonly annotationMutationUnitOfWork?: AnnotationMutationUnitOfWork;
  readonly annotationReadUnitOfWork?: AnnotationReadUnitOfWork;
  readonly relationMutationUnitOfWork?: RelationMutationUnitOfWork;
  readonly relationReadUnitOfWork?: RelationReadUnitOfWork;
  readonly reportsRateLimiter?: ProductAdmissionRateLimiter;
  readonly oidcProvider?: OidcProviderPort;
  /**
   * A3 BrowserSessionAuthority. When present AND composed, the product
   * session/me/logout routes and every requireSessionActor caller authenticate
   * through Better Auth + known_auth_session_metadata (G1 cutover canary/on).
   * Absent keeps the legacy OIDC session authority serving (shadow/off).
   * Production composition wiring is completed by A4.
   */
  readonly browserSessionAuthority?: BrowserSessionAuthority;
  /**
   * C3 explicit account-linking facade. When present AND composed, the
   * product link start/unlink routes are registered (session + Origin/CSRF +
   * re-auth gate). Absent keeps the linking surface closed.
   */
  readonly accountLinking?: AccountLinkingService;
  /**
   * C3 recovery facade. When present AND composed, the product recovery
   * routes are registered (non-enumerating reset request + verified-email
   * OTP reset). Absent keeps the recovery surface closed.
   */
  readonly accountRecovery?: AccountRecoveryService;
  /**
   * P10 account deletion facade. When present AND composed, the product
   * delete route is registered (session + Origin/CSRF + re-auth + typed
   * confirmation). Absent keeps the deletion surface closed.
   */
  readonly accountDeletion?: AccountDeletionService;
  /**
   * A1 Better Auth runtime boundary. When present AND config.betterAuth.enabled,
   * mounts ONLY the allowlisted /api/v1/auth endpoints through the Fastify
   * bridge (unknown paths 404, wrong methods 405 — never a catch-all) plus the
   * A4 transport contract (Origin pre-check, R9 token stripping, unified error
   * classification). Zero Better Auth registration otherwise. F2 completes the
   * production composition wiring in startApi.
   */
  readonly betterAuthRuntime?: {
    readonly mount: (app: FastifyInstance) => void;
    readonly handle?: (request: Request) => Promise<Response>;
  };
  /**
   * C4 security-epoch bridge (F2 production composition). When present AND
   * composed, transport consumers can raise account security events through
   * the decorated server instance (epoch bump + session revocation + MCP
   * OAuth propagation). Absent keeps the epoch surface closed.
   */
  readonly securityEpochBridge?: SecurityEpochBridge;
  readonly metrics?: Metrics;
  /** Auth/session rate limiter; production multi-replica injects the shared Redis adapter. */
  readonly authRateLimiter?: AuthRateLimiter;
  /**
   * Search admission rate limiter (FIX-M-006). Required whenever Search
   * routes are registered. Production injects the Redis adapter when
   * shared is on and the in-process memory limiter when shared is off.
   */
  readonly searchRateLimiter?: SearchRateLimiter;
  /**
   * Explore / COLP Directory admission limiter (P-04). Required whenever
   * those routes are registered. A second Search-limiter instance with a
   * distinct prefix and HMAC secret so Explore never shares Search counters.
   */
  readonly exploreDirectoryRateLimiter?: SearchRateLimiter;
  /**
   * Public Profile Activity admission limiter (PA-01). Required whenever
   * those routes are registered. Independent Redis prefix and HMAC secret
   * from Explore/Search.
   */
  readonly publicActivityRateLimiter?: SearchRateLimiter;
  /**
   * Sync COLP push/pull admission limiter (P-09). Production multi-replica
   * with Sync Sessions injects the Redis adapter; composition refuses
   * SYNC_RATE_LIMIT_SHARED=true when Sync is mounted without it.
   */
  readonly syncColpRateLimiter?: SyncColpRateLimiter;
  /**
   * PERIPH-P1-c Sync effect-page limiter. Independent family from
   * SYNC_RATE_LIMIT_SHARED. Composition refuses
   * SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED=true when Sync effect-page routes
   * are mounted without it.
   */
  readonly effectPageRateLimiter?: EffectPageRateLimiter;
  /** SYNC-Q-014 unified Sync admission for session/snapshot/conflict/ack/retire/effect-page IP. */
  readonly syncAdmissionPolicy?: SyncAdmissionPolicy;
  /**
   * FIX-M-018 unified MCP rate-limit port (request / approval /
   * commit-distinct-plan). Production multi-replica injects the shared Redis
   * adapter; the composition guard refuses MCP_RATE_LIMIT_SHARED=true
   * without it, and readiness includes its health.
   */
  readonly mcpRateLimiter?: McpRateLimiter;
  readonly searchTimeoutMs?: number;
  readonly publicationSnapshotQuery?: PublicationSnapshotQueryPorts;
  readonly publicationDirectoryQuery?: PublicationDirectoryQueryPorts;
  /** Product Explore page (viewCount + sort keyset). Independent of COLP directory. */
  readonly explorePageQuery?: ExplorePageReadPort;
  /** Identity query port that completes Explore collection creators. */
  readonly exploreCreatorsQuery?: ExploreCreatorsQueryPort;
  /** Batch public collection tldr lookup that completes Explore curator notes. */
  readonly explorePublicMarks?: ExploreCollectionMarksPort;
  readonly publicationMetadataQuery?: PublicationMetadataQueryPorts;
  /** T-10 origin-injected HTML shells for /c|/share|/path. */
  readonly publicShell?: PublicShellRoutePorts;
  /** D1 per-collection OG PNG renderer; defaults to the satori/resvg renderer. Tests inject a spy. */
  readonly collectionOgImageRenderer?: CollectionOgImageRenderer;
  /** T-20 public collections sitemap (always-on; not gated on public-shell meta). */
  readonly publicationSitemapQuery?: PublicationSitemapQueryPort;
  /** M-10 public Profile sitemap (always-on; follows the M-09 indexability authority). */
  readonly profileSitemapQuery?: ProfileSitemapQueryPort;
  /** T10 optional cache-aware Snapshot reader (serve/shadow); defaults to PostgreSQL. */
  readonly publicationSnapshotCacheReader?: PublicationSnapshotRouteReader;
  /** T10 optional cache-aware Directory reader (serve/shadow); defaults to PostgreSQL. */
  readonly publicationDirectoryCacheReader?: PublicationDirectoryRouteReader;
  /** T10 optional cache-aware Metadata reader (serve/shadow); defaults to PostgreSQL. */
  readonly publicationMetadataCacheReader?: PublicationMetadataRouteReader;
  readonly productPublicCollectionQuery?: ProductPublicCollectionQueryPorts;
  readonly productPublicInsight?: ProductPublicInsightRouteDependencies;
  readonly productPublishingInsights?: ProductPublishingInsightsRouteDependencies;
  readonly productCollaboration?: ProductCollaborationRouteDependencies;
  readonly publicProfileQuery?: {
    get(input: { readonly handle: string; readonly limit?: number }): Promise<PublicProfileProjection>;
  };
  readonly searchQuery?: SearchProductQuery;
  /** Only a process-local token issued after P2-16 and official COLP gates pass. */
  readonly publicationProfileClaims?: Phase2PublicationProfileClaims;
  /** Same-process release composition; starts unclaimed and may activate once. */
  readonly publicationProfileClaimController?: Phase2PublicationProfileClaimController;
  /** Process-local P3-39 token; endpoint presence alone never enables Sync. */
  readonly syncProfileClaims?: Phase3SyncProfileClaims;
  /** Same-process P3-39 release composition; starts unclaimed and activates once. */
  readonly syncProfileClaimController?: Phase3SyncProfileClaimController;
  /** Process-local P4B-R14 MCP Read Profile claims; absent means unclaimed. */
  readonly mcpReadProfileClaims?: Phase4bMcpReadProfileClaims;
  /** Same-process P4B-R14 release composition; starts unclaimed and activates once. */
  readonly mcpReadProfileClaimController?: Phase4bMcpReadProfileClaimController;
  /** Process-local MCP-W10 mcp-write Profile claims; absent means unclaimed. */
  readonly mcpWriteProfileClaims?: Phase4bMcpWriteProfileClaims;
  /** Same-process MCP-W10 release composition; starts unclaimed and activates once. */
  readonly mcpWriteProfileClaimController?: Phase4bMcpWriteProfileClaimController;
  readonly syncSessionRoutes?: SyncSessionRouteDependencies;
  readonly syncSnapshotRoutes?: SyncSnapshotRouteDependencies;
  readonly syncPushRoutes?: SyncPushRouteDependencies;
  readonly syncConflictRoutes?: SyncConflictRouteDependencies;
  readonly syncPullRoutes?: SyncPullRouteDependencies;
  readonly syncEffectPageRoutes?: SyncEffectPageRouteDependencies;
  readonly syncAckRoutes?: SyncAckRouteDependencies;
  readonly syncRetireRoutes?: SyncRetireRouteDependencies;
  /** Extension-only "my collections" list surface (bearer + T10 owned-collections query). */
  readonly extensionCollectionRoutes?: ExtensionCollectionRouteDependencies;
  readonly productSyncCenterUnitOfWork?: ProductSyncCenterUnitOfWork;
  /** FIX-M-011 (SYNC-R06): versioned Conflict keyring gate (/ready/features/sync-conflicts). */
  readonly syncConflictsCapabilityReadiness?: () => Promise<SyncConflictKeyringReadiness>;
  readonly followRateLimiter?: ProductAdmissionRateLimiter;
  readonly collectionFollowRateLimiter?: ProductAdmissionRateLimiter;
  /** CS: four sealed contract families (vote/comment/curation/publicReads). */
  readonly communityRateLimiters?: CommunityRateLimiters;
  readonly libraryOrderCommandUnitOfWork?: {
    execute<Result>(
      work: (ports: LibraryOrderCommandPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly libraryOrderQueryUnitOfWork?: {
    execute<Result>(work: (ports: LibraryOrderQueryPorts) => Promise<Result>): Promise<Result>;
  };
  readonly libraryOrderRateLimiter?: ProductAdmissionRateLimiter;
  /** FO-01 favicon policy/source routes admission (KNOWN_FEATURE_FAVICON_POLICY). */
  readonly faviconPolicyRateLimiter?: ProductAdmissionRateLimiter;
  readonly accountCredentialUnitOfWork?: import('../infrastructure/auth/account-credentials-postgres.js').PostgresAccountCredentialUnitOfWork;
  readonly accountCredentialCursors?: import('../modules/auth/index.js').AccountCredentialCursorCodec | null;
  readonly accountCredentialGrantCursors?: import('../modules/auth/index.js').CredentialGrantCursorCodec | null;
  readonly credentialsRateLimiter?: ProductAdmissionRateLimiter;
  readonly credentialIssuanceRateLimiter?: ProductAdmissionRateLimiter;
  readonly automationTokenCredentialRateLimiter?: ProductAdmissionRateLimiter;
  readonly automationTokenClientRateLimiter?: ProductAdmissionRateLimiter;
  readonly bookmarkPreferencesUnitOfWork?: {
    execute<Result>(work: (ports: BookmarkPreferencesPorts) => Promise<Result>): Promise<Result>;
  };
  readonly bookmarkPreferencesQuery?: BookmarkPreferencesStore;
  readonly bookmarkSubscriptionUnitOfWork?: import('../modules/bookmark-subscriptions/index.js').BookmarkSubscriptionUnitOfWork;
  readonly captureRuntime?: import('../modules/collections/index.js').CaptureRuntime;
  readonly captureHistory?: import('../modules/collections/index.js').CaptureHistoryRuntime;
  readonly captureLearning?: import('./product/capture-learning-routes.js').CaptureLearningRuntime;
  readonly governanceReportRateLimiter?: ProductAdmissionRateLimiter;
  readonly governanceActionRateLimiter?: ProductAdmissionRateLimiter;
  readonly governanceAppealRateLimiter?: ProductAdmissionRateLimiter;
  readonly feedRateLimiter?: ProductAdmissionRateLimiter;
  readonly linkHealthRateLimiter?: ProductAdmissionRateLimiter;
  readonly classifyInboxRateLimiter?: ProductAdmissionRateLimiter;
  readonly exportJobRateLimiter?: ProductAdmissionRateLimiter;
  readonly organizePlanRateLimiter?: ProductAdmissionRateLimiter;
  /** Shared family for public avatar and bookmark-favicon origin GETs. */
  readonly publicObjectRateLimiter?: ProductAdmissionRateLimiter;
  readonly notificationRateLimiter?: ProductAdmissionRateLimiter;
  /** P4A-I05 optional attachments capability readiness provider (/ready/features/attachments). */
  readonly attachmentsCapabilityReadiness?: () => Promise<AttachmentsCapabilityReadiness>;
  /** P4A-P03 production issue/complete Attachment composition; absent keeps every Attachment route closed (P01 skeleton). */
  readonly attachmentRoutes?: AttachmentRoutesDependencies;
  /** P5-31 optional email delivery-result callback ingress (disabled when unconfigured). */
  readonly emailCallbackRoutes?: EmailCallbackRoutesDependencies;
  /** P5-31 ops-only suppression surface (disabled when unconfigured). */
  readonly emailOpsRoutes?: EmailOpsRoutesDependencies;
  /** P4B-R06 MCP transport OAuth/timeout seam (anonymous Modern calls need no port). */
  readonly mcpReadTransport?: McpReadTransportDependencies;
  /** P4B-R13 MCP Read operations registry; created from config when absent. */
  readonly mcpReadOperations?: Phase4bMcpReadOperations;
  /** T-07 MCP compat operations registry; created from config when the flag is on. */
  readonly mcpCompatOperations?: Phase4bMcpCompatOperations;
  /** P4B-R08 real MCP Collection Resource projection; required when MCP Read is enabled. */
  readonly mcpReadResourceProjection?: Phase4bMcpCollectionResourceProjection;
  /** P4B-R10 real MCP Node Resource projection; required when MCP Read is enabled. */
  readonly mcpNodeResourceProjection?: Phase4bMcpNodeResourceProjection;
  /** P4B-R09 real MCP Snapshot Resource projection; required when MCP Read is enabled. */
  readonly mcpSnapshotResourceProjection?: Phase4bMcpSnapshotResourceProjection;
  /** MCP-W07 Product approval API dependencies; registered only when composed. */
  readonly mcpWriteApprovalRoutes?: McpWriteApprovalRoutesDependencies;
  /** MCP-W09 bounded Write Plan/Approval/Commit operations; registered only when composed. */
  readonly mcpWriteOperations?: Phase4bMcpWriteOperations;
}
