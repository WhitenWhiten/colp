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
  createPostgresCollectionsUnitOfWork,
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresAnnotationMutationUnitOfWork,
  createPostgresAnnotationReadUnitOfWork,
  createPostgresRelationMutationUnitOfWork,
  createPostgresRelationReadUnitOfWork,
  createPostgresOwnedCollectionsReadPort,
  createPostgresLinkHealthReadPort,
  createPostgresLinkHealthEnqueueUnitOfWork,
  createPostgresCollectionExportReadPort,
  createPostgresCollectionVersionUnitOfWork,
  createPostgresSharedCollectionsReadPort,
  createPostgresCollectionBookmarkCountReadPort,
  createPostgresBookmarkIconReadPort,
  createPostgresFaviconSourceModeReadPort,
  createPostgresLibraryOrderCommandUnitOfWork,
  createPostgresLibraryOrderQueryUnitOfWork,
} from '../infrastructure/collections/index.js';
import {
  createPostgresBookmarkPreferencesQuery,
  createPostgresBookmarkPreferencesUnitOfWork,
  createPostgresExtensionOwnerSubjectPort,
  createPostgresIdentityUnitOfWork,
  createPostgresPublicProfileFactsReadPort,
} from '../infrastructure/identity/index.js';
import {
  createProductAnnotationCursorSigner,
  createProductRelationCursorSigner,
  createProductEditorCursorSigner,
  createProductOwnedCollectionsCursorSigner,
  createProductSharedCollectionsCursorSigner,
  createProductLinkHealthCursorSigner,
  createProductCollectionVersionCursorSigner,
} from '../modules/collections/index.js';
import {
  createProductCollaborationMembersCursorSigner,
  createProductMyCollaborationInvitesCursorSigner,
} from '../modules/access-policy/index.js';
import {
  createPublicationCursorKeyring,
} from '../modules/publication/index.js';
import { createPhase4bMcpWriteOperations } from '../modules/mcp/index.js';
import {
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresProductPublicCollectionLocatorReadPort,
  createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicMarksReadPort,
  createPostgresPublicationSnapshotReadPort,
  createPostgresSearchCatalogDisplayTargetPort,
  createPostgresPublicationCollectionControlPort,
} from '../infrastructure/publication/index.js';
import { createPostgresAccessPolicyFactsPort } from '../infrastructure/access-policy/index.js';
import { createPostgresSearchAuthorityPort, createPostgresSearchCandidatePort } from '../infrastructure/search/index.js';
import { createSearchCursorSigner, createSearchFirstPageCache, createSearchTelemetry,
  executeSearchQuery } from '../modules/search/index.js';
import { createApiPostgresProductCursors } from './api-postgres-product-cursors.js';
import { createLogger, type Metrics } from '../infrastructure/telemetry/index.js';
import type {
  CollaborationInviteRateLimiter,
} from '../infrastructure/rate-limit/index.js';
import type { IdentityUnitOfWork } from '../modules/identity/index.js';

export interface ApiPostgresPorts {
  readonly reportSourceInvalidation?: import('../infrastructure/outbox/index.js').ReportSourceInvalidationOutboxPort;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly collectionsUnitOfWork: ReturnType<typeof createPostgresCollectionsUnitOfWork>;
  readonly productCollectionMutationUnitOfWork: ReturnType<typeof createPostgresCanonicalMutationUnitOfWork>;
  readonly collectionsEditorReadUnitOfWork: ReturnType<typeof createPostgresCollectionsEditorReadUnitOfWork>;
  readonly ownedCollectionsCursorSigner: ReturnType<typeof createProductOwnedCollectionsCursorSigner>;
  readonly sharedCollectionsCursorSigner: ReturnType<typeof createProductSharedCollectionsCursorSigner>;
  readonly collaborationMembersCursorSigner: ReturnType<typeof createProductCollaborationMembersCursorSigner>;
  readonly myCollaborationInvitesCursorSigner: ReturnType<typeof createProductMyCollaborationInvitesCursorSigner>;
  readonly linkHealthCursorSigner: ReturnType<typeof createProductLinkHealthCursorSigner>;
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
  readonly collectionBookmarkCountOrigin: ReturnType<typeof createPostgresCollectionBookmarkCountReadPort>;
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
    { metrics, productOrigin: config.productOrigin, faviconPolicyEnabled: config.faviconPolicy.enabled, ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }) },
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
    },
  );
  const { ownedCollectionsCursorSigner, sharedCollectionsCursorSigner, collaborationMembersCursorSigner,
    myCollaborationInvitesCursorSigner, linkHealthCursorSigner,
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
  const publicationCollectionControl = createPostgresPublicationCollectionControlPort(database);
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
  const collectionBookmarkCountOrigin = createPostgresCollectionBookmarkCountReadPort(database.db);
  return {
    ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }),
    identityUnitOfWork,
    collectionsUnitOfWork,
    productCollectionMutationUnitOfWork,
    collectionsEditorReadUnitOfWork,
    ownedCollectionsCursorSigner,
    sharedCollectionsCursorSigner,
    collaborationMembersCursorSigner,
    myCollaborationInvitesCursorSigner,
    linkHealthCursorSigner,
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
    collectionBookmarkCountOrigin,
  };
}
export function createApiPostgresAppDependencies(input: {
  readonly database: DatabaseRuntime;
  readonly config: ReturnType<typeof loadConfig>;
  readonly metrics: Metrics;
  readonly ports: ApiPostgresPorts;
  readonly collaborationInviteRateLimiter: CollaborationInviteRateLimiter;
  readonly identityUnitOfWork: IdentityUnitOfWork;
}) {
  const { database, config, metrics, ports, collaborationInviteRateLimiter,
    identityUnitOfWork } = input;
  const reportSourceInvalidation = ports.reportSourceInvalidation;
  const { publicationSnapshotQuery, publicationCursorKeys, publicationDirectoryReads,
    collaborationMembersCursorSigner, myCollaborationInvitesCursorSigner,
    collectionVersionCursorSigner, searchPorts } = ports;
  const publicProfileFacts = createPostgresPublicProfileFactsReadPort(database);
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
    linkHealthEnqueue: createPostgresLinkHealthEnqueueUnitOfWork(database.db),
    collectionExportReads: createPostgresCollectionExportReadPort(database.db),
    collectionVersions: createPostgresCollectionVersionUnitOfWork(database.db, { ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }) }),
    collectionVersionCursors: collectionVersionCursorSigner,
    publicationSnapshotQuery,
    publicationDirectoryQuery: {
      reads: publicationDirectoryReads,
      cursors: publicationCursorKeys,
      origin: config.publication.origin,
      maxPageSize: config.publication.maxPageSize,
    },
    publicationMetadataQuery: {
      reads: ports.publicationMetadataReads,
      origin: config.publication.origin,
      collectionControl: ports.publicationCollectionControl,
    },
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
