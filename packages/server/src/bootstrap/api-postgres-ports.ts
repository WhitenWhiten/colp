import { createPostgresBookmarkSubscriptionUnitOfWork } from '../infrastructure/bookmark-subscriptions/unit-of-work.js';
import { loadConfig } from './config.js';
import {
  createPostgresMcpWriteOperationsStore,
  createPostgresSharedExposureFactsPort,
  createUnitOfWork,
  type DatabaseRuntime,
} from '../infrastructure/database/index.js';
import { createPostgresCollaborationUnitOfWork } from '../infrastructure/collaboration/index.js';
import {
  createPostgresProductSyncCenterUnitOfWork,
  createPostgresSyncConflictKeyringReadiness,
} from '../infrastructure/sync/index.js';
import {
  createPostgresCollectionsEditorReadUnitOfWork,
  createPostgresCollectionChildrenReadUnitOfWork,
  createPostgresCollectionsUnitOfWork,
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresAnnotationMutationUnitOfWork,
  createPostgresAnnotationReadUnitOfWork,
  createPostgresRelationMutationUnitOfWork,
  createPostgresRelationReadUnitOfWork,
  createPostgresOwnedCollectionsReadPort,
  createPostgresLinkHealthReadPort,
  createPostgresClassificationServices,
  createPostgresClassifyInboxReadPort,
  createPostgresClassifyInboxSkipUnitOfWork,
  createPostgresClassifyInboxAcceptUnitOfWork,
  createPostgresLinkHealthEnqueueUnitOfWork,
  createPostgresExportJobEnqueueUnitOfWork,
  createPostgresExportJobReadPort,
  createPostgresCollectionExportReadPort,
  createPostgresOrganizePlanMutationUnitOfWork,
  createPostgresOrganizePlanReadPort,
  createPostgresCollectionVersionUnitOfWork,
  createPostgresReadableReplicaEnqueueUnitOfWork,
  createPostgresReadableReplicaUnitOfWork,
  createR2ExportStore,
  createPostgresSharedCollectionsReadPort,
  createPostgresCollectionBookmarkCountReadPort,
  createPostgresBookmarkIconReadPort,
  createPostgresLinkPreviewCommandUnitOfWork,
  createPostgresLinkPreviewReadPort,
  createPostgresFaviconSourceModeReadPort,
  createPostgresLibraryOrderCommandUnitOfWork,
  createPostgresLibraryOrderQueryUnitOfWork,
} from '../infrastructure/collections/index.js';
import {
  createPostgresExploreCreatorsQueryPort,
  createPostgresAccountCreditsPort, createPostgresCreditHealthObserver,
  createPostgresBookmarkPreferencesQuery,
  createPostgresBookmarkPreferencesUnitOfWork,
  createPostgresExtensionOwnerSubjectPort,
  createPostgresIdentityUnitOfWork,
  createPostgresCreditLedgerReadPort,
  createPostgresPublicProfileFactsReadPort,
} from '../infrastructure/identity/index.js';
import {
  createProductAnnotationCursorSigner,
  createProductRelationCursorSigner,
  createCollectionChildrenCursorSigner,
  createProductEditorCursorSigner,
  createProductOwnedCollectionsCursorSigner,
  createProductSharedCollectionsCursorSigner,
  createProductLinkHealthCursorSigner,
  createProductClassifyInboxCursorSigner,
  createProductCollectionVersionCursorSigner,
  createNeverCalledExportObjectStore,
  createOrganizePlanner,
} from '../modules/collections/index.js';
import {
  createProductCollaborationMembersCursorSigner,
  createProductMyCollaborationInvitesCursorSigner,
} from '../modules/access-policy/index.js';
import {
  createPublicationCursorKeyring,
  getPublicationSnapshotPage,
  getPublishingInsights,
  PublicationNotFoundError,
  PUBLICATION_SNAPSHOT_MAX_LIMIT,
  recordInsightEvent,
} from '../modules/publication/index.js';
import { createPhase4bMcpWriteOperations } from '../modules/mcp/index.js';
import {
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationSitemapReadPort,
  createPostgresProfileSitemapReadPort,
  createPostgresSearchIndexingExclusionReadPort,
  createPostgresPublicationNodeCountReadPort,
  createPostgresExplorePageReadPort,
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresProductPublicCollectionLocatorReadPort,
  createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicMarksReadPort,
  createPostgresPublicationSnapshotReadPort,
  createPostgresPublicationInsightFactsPort,
  createPostgresPublicationInsightStore,
  createPostgresPublishingInsightsDashboardPort,
  createPostgresSearchCatalogDisplayTargetPort,
  createVisitorHashPort,
} from '../infrastructure/publication/index.js';
import { createPostgresAccessPolicyFactsPort } from '../infrastructure/access-policy/index.js';
import { collectionHidePublicExistsSql } from '../infrastructure/database/collection-control-sql.js';
import { createWebShellCache, toPublicShellMarkdownNode } from '../infrastructure/http/index.js';
import { createPostgresSearchAuthorityPort, createPostgresSearchCandidatePort } from '../infrastructure/search/index.js';
import { createSearchCursorSigner, createSearchFirstPageCache, createSearchTelemetry,
  executeSearchQuery } from '../modules/search/index.js';
import { composeProfileSitemapQuery, composePublicProfileProjection } from './public-profile-projection.js';
import { createApiPostgresProductCursors } from './api-postgres-product-cursors.js';
import { createLogger, type Metrics } from '../infrastructure/telemetry/index.js';
import type {
  CollaborationInviteRateLimiter,
  PublishingInsightsIngestRateLimiter,
} from '../infrastructure/rate-limit/index.js';
import type { IdentityUnitOfWork } from '../modules/identity/index.js';

export interface ApiPostgresPorts {
  readonly reportSourceInvalidation?: import('../infrastructure/outbox/index.js').ReportSourceInvalidationOutboxPort;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly collectionsUnitOfWork: ReturnType<typeof createPostgresCollectionsUnitOfWork>;
  readonly productCollectionMutationUnitOfWork: ReturnType<typeof createPostgresCanonicalMutationUnitOfWork>;
  readonly collectionsEditorReadUnitOfWork: ReturnType<typeof createPostgresCollectionsEditorReadUnitOfWork>;
  /** FO-05 one-layer children reader (always composed; cursor routes gate on the flag). */
  readonly collectionChildrenReadUnitOfWork: ReturnType<typeof createPostgresCollectionChildrenReadUnitOfWork>;
  readonly ownedCollectionsCursorSigner: ReturnType<typeof createProductOwnedCollectionsCursorSigner>;
  readonly sharedCollectionsCursorSigner: ReturnType<typeof createProductSharedCollectionsCursorSigner>;
  readonly collaborationMembersCursorSigner: ReturnType<typeof createProductCollaborationMembersCursorSigner>;
  readonly myCollaborationInvitesCursorSigner: ReturnType<typeof createProductMyCollaborationInvitesCursorSigner>;
  readonly linkHealthCursorSigner: ReturnType<typeof createProductLinkHealthCursorSigner>;
  readonly classifyInboxCursorSigner: ReturnType<typeof createProductClassifyInboxCursorSigner>;
  readonly collectionVersionCursorSigner: ReturnType<typeof createProductCollectionVersionCursorSigner>;
  readonly annotationMutationUnitOfWork: ReturnType<typeof createPostgresAnnotationMutationUnitOfWork>;
  readonly annotationReadUnitOfWork: ReturnType<typeof createPostgresAnnotationReadUnitOfWork>;
  readonly relationMutationUnitOfWork: ReturnType<typeof createPostgresRelationMutationUnitOfWork>;
  readonly relationReadUnitOfWork: ReturnType<typeof createPostgresRelationReadUnitOfWork>;
  readonly searchPorts: {
    readonly candidates: ReturnType<typeof createPostgresSearchCandidatePort>;
    readonly authority: ReturnType<typeof createPostgresSearchAuthorityPort>;
    readonly cursors: ReturnType<typeof createSearchCursorSigner>;
    readonly clock: { now: () => Date };
    readonly telemetry: ReturnType<typeof createSearchTelemetry>;
    readonly sharedExposure: ReturnType<typeof createPostgresSharedExposureFactsPort>;
    readonly firstPageCache: ReturnType<typeof createSearchFirstPageCache>;
  };
  readonly publicationCursorKeys: ReturnType<typeof createPublicationCursorKeyring>;
  readonly accessPolicyFacts: ReturnType<typeof createPostgresAccessPolicyFactsPort>;
  readonly publicationDirectoryReads: ReturnType<typeof createPostgresPublicationDirectoryReadPort>;
  readonly publicationMetadataReads: ReturnType<typeof createPostgresPublicationMetadataReadPort>;
  readonly publicationCollectionControl: {
    readonly collectionControl: (collectionId: string) => Promise<{ readonly hidePublic: boolean }>;
  };
  readonly publicationSnapshotQuery: {
    readonly reads: ReturnType<typeof createPostgresPublicationSnapshotReadPort>;
    readonly annotations: ReturnType<typeof createPostgresPublicationAnnotationReadPort>;
    readonly relations: ReturnType<typeof createPostgresPublicationRelationReadPort>;
    readonly accessPolicy: ReturnType<typeof createPostgresAccessPolicyFactsPort>;
    readonly cursors: ReturnType<typeof createPublicationCursorKeyring>;
    readonly origin: string;
    readonly sharedExposure: ReturnType<typeof createPostgresSharedExposureFactsPort>;
  };
  readonly ownedCollectionsQueryPorts: {
    readonly reads: ReturnType<typeof createPostgresOwnedCollectionsReadPort>;
    readonly cursors: ReturnType<typeof createProductOwnedCollectionsCursorSigner>;
    readonly clock: { now: () => Promise<Date> };
  };
  readonly sharedCollectionsQueryPorts: {
    readonly reads: ReturnType<typeof createPostgresSharedCollectionsReadPort>;
    readonly cursors: ReturnType<typeof createProductSharedCollectionsCursorSigner>;
    readonly clock: { now: () => Promise<Date> };
  };
  readonly linkHealthQueryPorts: {
    readonly reads: ReturnType<typeof createPostgresLinkHealthReadPort>;
    readonly cursors: ReturnType<typeof createProductLinkHealthCursorSigner>;
    readonly clock: { now: () => Promise<Date> };
  };
  readonly classifyInboxQueryPorts: {
    readonly reads: ReturnType<typeof createPostgresClassifyInboxReadPort>;
    readonly cursors: ReturnType<typeof createProductClassifyInboxCursorSigner>;
    readonly clock: { now: () => Promise<Date> };
  };
  readonly collectionBookmarkCountOrigin: ReturnType<typeof createPostgresCollectionBookmarkCountReadPort>;
  readonly publishingInsightsVisitorHash: ReturnType<typeof createVisitorHashPort>;
  readonly creditLedgerRead: ReturnType<typeof createPostgresCreditLedgerReadPort>;
}
export function createApiPostgresPorts(input: {
  readonly database: DatabaseRuntime;
  readonly config: ReturnType<typeof loadConfig>;
  readonly metrics: Metrics;
  readonly metricsLogger: ReturnType<typeof createLogger>;
}): ApiPostgresPorts {
  const { database, config, metrics, metricsLogger } = input;
  const reportSourceInvalidation = undefined;
  const identityUnitOfWork = createPostgresIdentityUnitOfWork(database.db, {
    // F2: Better Auth mode omits legacy transaction secrets; legacy mode keeps
    // the production config-backed material exactly as before.
    ...(config.betterAuth.enabled ? {} : { oidcTransactionSecrets: config.oidcTransactionSecrets }),
    ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }),
  });
  const collectionsUnitOfWork = createPostgresCollectionsUnitOfWork(database.db, {
    metrics, cancelBackend: database.cancelBackend,
  });
  const productCollectionMutationUnitOfWork = createPostgresCanonicalMutationUnitOfWork(
    database.db,
    { metrics, productOrigin: config.productOrigin, ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }) },
  );
  const cursorSigner = createProductEditorCursorSigner({
    current: config.productEditorCursor.current,
    previous: config.productEditorCursor.previous,
    issuanceFormat: config.productEditorCursor.issuanceFormat,
    ...(config.productEditorCursor.legacyAcceptUntil
      ? { legacyAcceptUntil: config.productEditorCursor.legacyAcceptUntil }
      : {}),
  }, {
    observe(metric) {
      metrics.increment(`editor.cursor.${metric}`);
    },
  });
  const collectionsEditorReadUnitOfWork = createPostgresCollectionsEditorReadUnitOfWork(
    database.db,
    {
      cursorSigner,
      cursorTtlMs: config.productEditorCursor.ttlMs,
      metrics,
      productOrigin: config.productOrigin,
      linkPreviews: config.linkPreview.enabled,
    },
  );
  const collectionChildrenReadUnitOfWork = createPostgresCollectionChildrenReadUnitOfWork(
    database.db,
    {
      cursorSigner: createCollectionChildrenCursorSigner(config.faviconPolicy.cursorHmacKey),
      metrics,
      productOrigin: config.productOrigin,
      cancelBackend: database.cancelBackend,
      linkPreviews: config.linkPreview.enabled,
    },
  );
  const { ownedCollectionsCursorSigner, sharedCollectionsCursorSigner, collaborationMembersCursorSigner,
    myCollaborationInvitesCursorSigner, linkHealthCursorSigner, classifyInboxCursorSigner,
    collectionVersionCursorSigner } = createApiPostgresProductCursors(config);
  const annotationMutationUnitOfWork = createPostgresAnnotationMutationUnitOfWork(database.db, { ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }) });
  const annotationReadUnitOfWork = createPostgresAnnotationReadUnitOfWork(database.db, {
    cursorSigner: createProductAnnotationCursorSigner({
      current: config.productEditorCursor.current,
      previous: config.productEditorCursor.previous,
    }),
    cursorTtlMs: config.productEditorCursor.ttlMs,
    metrics,
  });
  const relationMutationUnitOfWork = createPostgresRelationMutationUnitOfWork(database.db, { ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }) });
  const relationReadUnitOfWork = createPostgresRelationReadUnitOfWork(database.db, {
    cursorSigner: createProductRelationCursorSigner({
      current: config.productEditorCursor.current,
      previous: config.productEditorCursor.previous,
    }),
    cursorTtlMs: config.productEditorCursor.ttlMs,
    metrics,
  });
  const searchPorts = {
    candidates: createPostgresSearchCandidatePort(database.db),
    authority: createPostgresSearchAuthorityPort(database.db),
    cursors: createSearchCursorSigner({ current: config.productEditorCursor.current,
      previous: config.productEditorCursor.previous }),
    clock: { now: () => new Date() },
    telemetry: createSearchTelemetry({ metrics, logger: metricsLogger }),
    sharedExposure: createPostgresSharedExposureFactsPort(database),
    firstPageCache: createSearchFirstPageCache(),
  };
  const publicationCursorKeys = createPublicationCursorKeyring(config.publication.cursorKeys);
  const accessPolicyFacts = createPostgresAccessPolicyFactsPort(database.db);
  const publicationDirectoryReads = createPostgresPublicationDirectoryReadPort(database);
  const publicationMetadataReads = createPostgresPublicationMetadataReadPort(database);
  // Keep the collection-level moderation gate in the production composition.
  // The application queries intentionally accept an optional control port so
  // small hosts can omit moderation, but the Postgres server must never do so:
  // otherwise public metadata/snapshots can survive an active hide_public.
  const publicationCollectionControl = Object.freeze({
    async collectionControl(collectionId: string): Promise<{ readonly hidePublic: boolean }> {
      const result = await database.pool.query<{ hide_public: boolean }>(
        `select ${collectionHidePublicExistsSql('c.id')} as hide_public
           from collections c where c.id = $1`,
        [collectionId],
      );
      return Object.freeze({ hidePublic: result.rows[0]?.hide_public === true });
    },
  });
  const publicationSnapshotQuery = {
    reads: createPostgresPublicationSnapshotReadPort(database),
    annotations: createPostgresPublicationAnnotationReadPort(database, {
      origin: config.productOrigin,
    }),
    relations: createPostgresPublicationRelationReadPort(database),
    accessPolicy: accessPolicyFacts,
    cursors: publicationCursorKeys,
    origin: config.publication.origin,
    sharedExposure: createPostgresSharedExposureFactsPort(database),
    collectionControl: publicationCollectionControl,
  };
  const ownedCollectionsQueryPorts = {
    reads: createPostgresOwnedCollectionsReadPort(database.db),
    cursors: ownedCollectionsCursorSigner,
    clock: { now: async () => new Date() },
  };
  const sharedCollectionsQueryPorts = {
    reads: createPostgresSharedCollectionsReadPort(database.db),
    cursors: sharedCollectionsCursorSigner,
    clock: { now: async () => new Date() },
  };
  const linkHealthQueryPorts = {
    reads: createPostgresLinkHealthReadPort(database.db),
    cursors: linkHealthCursorSigner,
    clock: { now: async () => new Date() },
  };
  const classifyInboxQueryPorts = {
    reads: createPostgresClassifyInboxReadPort(database.db),
    cursors: classifyInboxCursorSigner,
    clock: { now: async () => new Date() },
  };
  const collectionBookmarkCountOrigin = createPostgresCollectionBookmarkCountReadPort(database.db);
  const publishingInsightsVisitorHash = createVisitorHashPort(config.publishingInsights.visitorHmacKey);
  const creditLedgerRead = createPostgresCreditLedgerReadPort(database.db);
  return {
    ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }),
    identityUnitOfWork,
    collectionsUnitOfWork,
    productCollectionMutationUnitOfWork,
    collectionsEditorReadUnitOfWork,
    collectionChildrenReadUnitOfWork,
    ownedCollectionsCursorSigner,
    sharedCollectionsCursorSigner,
    collaborationMembersCursorSigner,
    myCollaborationInvitesCursorSigner,
    linkHealthCursorSigner,
    classifyInboxCursorSigner,
    collectionVersionCursorSigner,
    annotationMutationUnitOfWork,
    annotationReadUnitOfWork,
    relationMutationUnitOfWork,
    relationReadUnitOfWork,
    searchPorts,
    publicationCursorKeys,
    accessPolicyFacts,
    publicationDirectoryReads,
    publicationMetadataReads,
    publicationCollectionControl,
    publicationSnapshotQuery,
    ownedCollectionsQueryPorts,
    sharedCollectionsQueryPorts,
    linkHealthQueryPorts,
    classifyInboxQueryPorts,
    collectionBookmarkCountOrigin,
    publishingInsightsVisitorHash,
    creditLedgerRead,
  };
}
export function createApiPostgresAppDependencies(input: {
  readonly database: DatabaseRuntime;
  readonly config: ReturnType<typeof loadConfig>;
  readonly metrics: Metrics;
  readonly ports: ApiPostgresPorts;
  readonly collaborationInviteRateLimiter: CollaborationInviteRateLimiter;
  readonly publishingInsightsRateLimiter: PublishingInsightsIngestRateLimiter;
  readonly identityUnitOfWork: IdentityUnitOfWork;
}) {
  const { database, config, metrics, ports, collaborationInviteRateLimiter,
    publishingInsightsRateLimiter, identityUnitOfWork } = input;
  const reportSourceInvalidation = ports.reportSourceInvalidation;
  const { publicationSnapshotQuery, publicationCursorKeys, publicationDirectoryReads,
    collaborationMembersCursorSigner, myCollaborationInvitesCursorSigner,
    collectionVersionCursorSigner, publishingInsightsVisitorHash, searchPorts } = ports;
  const publicProfileFacts = createPostgresPublicProfileFactsReadPort(database);
  const searchIndexingExclusion = createPostgresSearchIndexingExclusionReadPort(database);
  const publicationNodeCount = createPostgresPublicationNodeCountReadPort(database);
  return {
    ...(config.syncSession ? {
      productSyncCenterUnitOfWork: createPostgresProductSyncCenterUnitOfWork(database.db, {
        cursorSecret: config.productEditorCursor.current.key,
        conflictPayloadKeyring: config.syncSession.conflictPayloadKeyring,
        metrics,
        ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }),
      }),
      syncConflictsCapabilityReadiness: createPostgresSyncConflictKeyringReadiness(
        database.db, config.syncSession.conflictPayloadKeyring,
      ),
    } : {}),
    ...createPostgresClassificationServices(database,config.classification,metrics,reportSourceInvalidation,createPostgresAccountCreditsPort,createPostgresCreditHealthObserver(database.db,metrics)),
    classifyInboxSkip: createPostgresClassifyInboxSkipUnitOfWork(database.db),
    classifyInboxAccept: createPostgresClassifyInboxAcceptUnitOfWork(database.db, { ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }) }),
    linkHealthEnqueue: createPostgresLinkHealthEnqueueUnitOfWork(database.db),
    exportJobReads: createPostgresExportJobReadPort(database.db),
    collectionExportReads: createPostgresCollectionExportReadPort(database.db),
    exportJobEnqueue: createPostgresExportJobEnqueueUnitOfWork(database.db),
    exportJobStore: config.exportJobs.enabled && config.exportJobs.r2
      ? createR2ExportStore(config.exportJobs.r2)
      : createNeverCalledExportObjectStore(),
    organizePlanReads: createPostgresOrganizePlanReadPort(database.db),
    organizePlanMutations: createPostgresOrganizePlanMutationUnitOfWork(database.db, { productOrigin: config.productOrigin, metrics, collectionHistoryEnabled: config.collectionHistory.enabled, ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }) }),
    organizePlanner: createOrganizePlanner(config.organizePlans.plannerId),
    collectionVersions: createPostgresCollectionVersionUnitOfWork(database.db, { ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }) }),
    collectionVersionCursors: collectionVersionCursorSigner,
    readableReplicas: createPostgresReadableReplicaUnitOfWork(database.db),
    readableReplicaEnqueue: createPostgresReadableReplicaEnqueueUnitOfWork(database.db),
    linkPreviewCommands: createPostgresLinkPreviewCommandUnitOfWork(database.db, { productOrigin: config.productOrigin }),
    publicationSnapshotQuery,
    publicationDirectoryQuery: {
      reads: publicationDirectoryReads,
      cursors: publicationCursorKeys,
      origin: config.publication.origin,
      maxPageSize: config.publication.maxPageSize,
    },
    explorePageQuery: createPostgresExplorePageReadPort(database),
    exploreCreatorsQuery: createPostgresExploreCreatorsQueryPort(database.db),
    publicationMetadataQuery: {
      reads: ports.publicationMetadataReads,
      origin: config.publication.origin,
      collectionControl: ports.publicationCollectionControl,
    },
    publicationSitemapQuery: createPostgresPublicationSitemapReadPort(database),
    profileSitemapQuery: composeProfileSitemapQuery({
      candidates: createPostgresProfileSitemapReadPort(database),
    }),
    ...((config.publicShellMeta.enabled || config.publicProfileShell.enabled)
      && (config.publicShellMeta.webShellOrigin ?? config.publicProfileShell.webShellOrigin) !== null
      ? {
          publicShell: {
            cache: createWebShellCache({
              origin: (config.publicShellMeta.webShellOrigin ?? config.publicProfileShell.webShellOrigin)!,
            }),
            loadNodeCountBySlug: (slug: string) => publicationNodeCount.loadByPublicationSlug(slug),
            loadOwnerDisplayName: async (ownerSubjectId: string) => {
              const owner = await publicProfileFacts.findByOwnerSubjectId(ownerSubjectId);
              return owner?.displayName ?? null;
            },
            loadOwnerPublicProfile: async (ownerSubjectId: string) => {
              const owner = await publicProfileFacts.findByOwnerSubjectId(ownerSubjectId);
              return owner === null ? null : { displayName: owner.displayName, handle: owner.handle };
            },
            excludedCollectionIds: (collectionIds: readonly string[], signal?: AbortSignal) =>
              searchIndexingExclusion.excludedCollectionIds(collectionIds, signal),
            loadSnapshotNodes: async (collectionId: string, signal?: AbortSignal) => {
              try {
                const page = await getPublicationSnapshotPage(publicationSnapshotQuery, {
                  collectionId,
                  principal: { kind: 'anonymous' },
                  query: { limit: PUBLICATION_SNAPSHOT_MAX_LIMIT },
                }, signal);
                return page.snapshot.nodes
                  .map(toPublicShellMarkdownNode)
                  .filter((node): node is NonNullable<typeof node> => node !== null);
              } catch (error) {
                if (error instanceof PublicationNotFoundError) return null;
                throw error;
              }
            },
          },
        }
      : {}),
    productPublicCollectionQuery: {
      locators: createPostgresProductPublicCollectionLocatorReadPort(database),
      viewCounts: createPostgresProductPublicCollectionViewCountReadPort(database),
      snapshot: publicationSnapshotQuery,
      cursors: publicationCursorKeys,
      owners: publicProfileFacts,
      productOrigin: config.productOrigin,
      bookmarkIcons: createPostgresBookmarkIconReadPort(database.db),
      faviconSources: createPostgresFaviconSourceModeReadPort(database.db),
      publicMarks: createPostgresPublicMarksReadPort(database),
      ...(config.linkPreview.enabled ? { linkPreviews: createPostgresLinkPreviewReadPort(database.db) } : {}),
    },
    explorePublicMarks: createPostgresPublicMarksReadPort(database),
    productPublicInsight: {
      allowedOrigins: config.allowedOrigins,
      identityUnitOfWork,
      visitorHash: publishingInsightsVisitorHash,
      rateLimiter: publishingInsightsRateLimiter,
      rateLimitKeySecret: config.publishingInsights.rateLimitHmacKey,
      insightCookieSigningKey: config.publishingInsights.visitorHmacKey,
      record: (insightInput: Parameters<typeof recordInsightEvent>[1]) => createUnitOfWork(database.db).execute(async ({ transaction }) => (
        recordInsightEvent({
          facts: createPostgresPublicationInsightFactsPort(transaction),
          store: createPostgresPublicationInsightStore(transaction),
          visitorHash: publishingInsightsVisitorHash,
        }, insightInput)
      )),
    },
    productPublishingInsights: {
      identityUnitOfWork,
      getInsights: (actor: Parameters<typeof getPublishingInsights>[1], now: Parameters<typeof getPublishingInsights>[2]) => getPublishingInsights({
        dashboard: createPostgresPublishingInsightsDashboardPort(database.db),
      }, actor, now),
    },
    productCollaboration: {
      identityUnitOfWork,
      allowedOrigins: config.allowedOrigins,
        unitOfWork: createPostgresCollaborationUnitOfWork(database.db, {
          inviteEmailEnabled: config.collaborationInviteEmail.enabled,
          ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }),
        }),
      rateLimiter: collaborationInviteRateLimiter,
      cursors: {
        members: collaborationMembersCursorSigner,
        myInvites: myCollaborationInvitesCursorSigner,
      },
    },
    publicProfileQuery: composePublicProfileProjection({
      profiles: publicProfileFacts,
      collections: createPostgresPublicationDirectoryReadPort(database),
      cursors: publicationCursorKeys,
      sharedExposure: createPostgresSharedExposureFactsPort(database),
      // Keep the projection-level gate wired even though the profile facts
      // reader also applies the SQL predicate.  This makes the account
      // restriction an explicit production dependency and protects alternate
      // facts ports from silently omitting the owner control.
      accountControl: publicProfileFacts,
    }),
    searchQuery: { execute: (searchInput: Parameters<typeof executeSearchQuery>[1]) => executeSearchQuery(searchPorts, searchInput),
      loadCatalogDisplayTargets: createPostgresSearchCatalogDisplayTargetPort(database).load },
    mcpWriteOperations: createPhase4bMcpWriteOperations({
      metrics,
      store: createPostgresMcpWriteOperationsStore(database.db),
      enabled: config.mcpWriteEnabled,
    }),
    libraryOrderCommandUnitOfWork: createPostgresLibraryOrderCommandUnitOfWork(database.db),
    libraryOrderQueryUnitOfWork: createPostgresLibraryOrderQueryUnitOfWork(database.db),
    bookmarkSubscriptionUnitOfWork: createPostgresBookmarkSubscriptionUnitOfWork(database.db, { origin: config.productOrigin, reportsEnabled: false, metrics }),
    bookmarkPreferencesUnitOfWork: createPostgresBookmarkPreferencesUnitOfWork(database.db), bookmarkPreferencesQuery: createPostgresBookmarkPreferencesQuery(database.db),
  };
}
