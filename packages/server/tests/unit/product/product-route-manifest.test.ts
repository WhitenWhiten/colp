import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { test } from 'vitest';
import { PRODUCT_ROUTE_MANIFEST } from '../../../generated/openapi/product-v1.routes.js';
import { backendRoot } from '../openapi/openapi-contract-support.js';
import {
  assertProductRouteCoverage,
  BOOKMARK_FAVICON_DEFERRED_OPERATION_IDS,
  CLASSIFICATION_BYOK_OPERATION_IDS,
  CLASSIFICATION_BYOK_PROFILE_PATH_PREFIX,
  installProductRouteManifestChecks,
  productRouteMetadata,
} from '../../../src/transport/product-route-manifest.js';
import { publishingInsightsIngestRateLimitFamilyForPath, collaborationInviteRateLimitFamilyForPath } from '../../../src/transport/http-security.js';

test('generated Product route manifest contains owned Collections, public Profile, Sidecar, private state, Search, Write Approval, Attachment, Publishing Insights, and Collaboration operations', () => {
  const routesJson = JSON.parse(readFileSync(
    join(backendRoot, 'generated/openapi/product-v1.routes.json'),
    'utf8',
  )) as Array<{ method: string; path: string; operationId: string }>;
  const manifestKeys = PRODUCT_ROUTE_MANIFEST.map((route) =>
    `${route.method} ${route.path} ${route.operationId}`).sort();
  const generatedKeys = routesJson.map((route) =>
    `${route.method} ${route.path} ${route.operationId}`).sort();
  assert.deepEqual(manifestKeys, generatedKeys);
  assert.equal(
    new Set(PRODUCT_ROUTE_MANIFEST.map((route) => route.operationId)).size,
    PRODUCT_ROUTE_MANIFEST.length,
  );
  assert.equal(
    new Set(PRODUCT_ROUTE_MANIFEST.map((route) => `${route.method} ${route.path}`)).size,
    PRODUCT_ROUTE_MANIFEST.length,
  );
  assert.deepEqual(PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me'), [
    { method: 'GET', path: '/api/v1/me', operationId: 'getMe' },
    { method: 'PATCH', path: '/api/v1/me', operationId: 'updateMe' },
  ]);
  // FIX-H-004: the frozen Phase 5 /me Notification compatibility paths are
  // explicitly INCLUDED in the route manifest (x-known-route-manifest: true);
  // the Product Feed /me alias is excluded with the successor Feed surface.
  assert.deepEqual(PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/notifications'
    || route.path === '/api/v1/me/notifications/read'
    || route.path === '/api/v1/me/notification-preferences'), [
    { method: 'GET', path: '/api/v1/me/notification-preferences', operationId: 'getMyNotificationPreferences' },
    { method: 'PUT', path: '/api/v1/me/notification-preferences', operationId: 'updateMyNotificationPreferences' },
    { method: 'GET', path: '/api/v1/me/notifications', operationId: 'listMyNotifications' },
    { method: 'POST', path: '/api/v1/me/notifications/read', operationId: 'markMyNotificationsRead' },
  ]);
  assert.deepEqual(PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/collections'), [
    { method: 'GET', path: '/api/v1/collections', operationId: 'listOwnedCollections' },
    { method: 'POST', path: '/api/v1/collections', operationId: 'createCollection' },
  ]);
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/profiles/{handle}'),
    [
      { method: 'GET', path: '/api/v1/profiles/{handle}', operationId: 'getPublicProfile' },
      { method: 'HEAD', path: '/api/v1/profiles/{handle}', operationId: 'headPublicProfile' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.includes('/annotations')),
    [
      { method: 'GET', path: '/api/v1/collections/{collectionId}/annotations', operationId: 'listAnnotations' },
      { method: 'POST', path: '/api/v1/collections/{collectionId}/annotations', operationId: 'createAnnotation' },
      { method: 'DELETE', path: '/api/v1/collections/{collectionId}/annotations/{annotationId}', operationId: 'deleteAnnotation' },
      { method: 'GET', path: '/api/v1/collections/{collectionId}/annotations/{annotationId}', operationId: 'getAnnotation' },
      { method: 'PATCH', path: '/api/v1/collections/{collectionId}/annotations/{annotationId}', operationId: 'updateAnnotation' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.includes('/relations')),
    [
      { method: 'GET', path: '/api/v1/collections/{collectionId}/relations', operationId: 'listRelations' },
      { method: 'POST', path: '/api/v1/collections/{collectionId}/relations', operationId: 'createRelation' },
      { method: 'DELETE', path: '/api/v1/collections/{collectionId}/relations/{relationId}', operationId: 'deleteRelation' },
      { method: 'GET', path: '/api/v1/collections/{collectionId}/relations/{relationId}', operationId: 'getRelation' },
      { method: 'PATCH', path: '/api/v1/collections/{collectionId}/relations/{relationId}', operationId: 'updateRelation' },
    ],
  );
  assert.deepEqual(PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.includes('/saved-resources')), [
    { method: 'GET', path: '/api/v1/saved-resources', operationId: 'listSavedResources' },
    { method: 'DELETE', path: '/api/v1/saved-resources/{resourceType}/{resourceId}', operationId: 'unsaveResource' },
    { method: 'PUT', path: '/api/v1/saved-resources/{resourceType}/{resourceId}', operationId: 'saveResource' },
  ]);
  assert.deepEqual(PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.includes('/reading-progress')), [
    { method: 'GET', path: '/api/v1/reading-progress', operationId: 'listReadingProgress' },
    { method: 'DELETE', path: '/api/v1/reading-progress/{resourceType}/{resourceId}', operationId: 'resetReadingProgress' },
    { method: 'GET', path: '/api/v1/reading-progress/{resourceType}/{resourceId}', operationId: 'getReadingProgress' },
    { method: 'PUT', path: '/api/v1/reading-progress/{resourceType}/{resourceId}', operationId: 'putReadingProgress' },
  ]);
  assert.deepEqual(PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/search'), [
    { method: 'GET', path: '/api/v1/search', operationId: 'searchResources' },
    { method: 'HEAD', path: '/api/v1/search', operationId: 'headSearchResources' },
  ]);
  assert.deepEqual(PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.startsWith('/api/v1/mcp/approvals')), [
    { method: 'GET', path: '/api/v1/mcp/approvals', operationId: 'listWriteApprovals' },
    { method: 'GET', path: '/api/v1/mcp/approvals/{planId}', operationId: 'getWriteApproval' },
    { method: 'POST', path: '/api/v1/mcp/approvals/{planId}/decision', operationId: 'decideWriteApproval' },
  ]);
  // routes.json is sorted by path, then method, then operationId (see
  // scripts/generate-openapi.mjs); the pin below is the canonical manifest
  // order, not the YAML declaration order.
  assert.deepEqual(PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.startsWith('/api/v1/attachments')), [
    { method: 'POST', path: '/api/v1/attachments/complete', operationId: 'completeAttachmentUpload' },
    { method: 'POST', path: '/api/v1/attachments/issue', operationId: 'issueAttachmentUpload' },
    { method: 'GET', path: '/api/v1/attachments/{blobId}', operationId: 'getAttachmentStatus' },
    { method: 'POST', path: '/api/v1/attachments/{blobId}/download', operationId: 'admitAttachmentDownload' },
    { method: 'POST', path: '/api/v1/attachments/{blobId}/finalize', operationId: 'finalizeAttachment' },
    { method: 'POST', path: '/api/v1/attachments/{blobId}/replacement', operationId: 'issueAttachmentReplacement' },
    { method: 'POST', path: '/api/v1/attachments/{blobId}/retire', operationId: 'retireAttachment' },
  ]);
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.includes('/insight-events')),
    [{
      method: 'POST',
      path: '/api/v1/public-collections/{slug}/insight-events',
      operationId: 'recordPublicCollectionInsightEvent',
    }],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/publishing-insights'),
    [{
      method: 'GET',
      path: '/api/v1/me/publishing-insights',
      operationId: 'getMyPublishingInsights',
    }],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/classify-inbox'),
    [{
      method: 'GET',
      path: '/api/v1/me/classify-inbox',
      operationId: 'getMyClassifyInbox',
    }],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/classify-inbox/{nodeId}/skip'),
    [{
      method: 'POST',
      path: '/api/v1/me/classify-inbox/{nodeId}/skip',
      operationId: 'skipMyClassifyInboxItem',
    }],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/classify-inbox/{nodeId}/accept'),
    [{
      method: 'POST',
      path: '/api/v1/me/classify-inbox/{nodeId}/accept',
      operationId: 'acceptMyClassifyInboxItem',
    }],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/link-health'),
    [{
      method: 'GET',
      path: '/api/v1/me/link-health',
      operationId: 'getMyLinkHealth',
    }],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/link-health/checks'),
    [{
      method: 'POST',
      path: '/api/v1/me/link-health/checks',
      operationId: 'enqueueMyLinkHealthChecks',
    }],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/export-jobs'
      || route.path === '/api/v1/me/export-jobs/{jobId}'
      || route.path === '/api/v1/me/export-jobs/{jobId}/download'),
    [
      { method: 'GET', path: '/api/v1/me/export-jobs', operationId: 'listMyExportJobs' },
      { method: 'POST', path: '/api/v1/me/export-jobs', operationId: 'createMyExportJob' },
      { method: 'GET', path: '/api/v1/me/export-jobs/{jobId}', operationId: 'getMyExportJob' },
      { method: 'GET', path: '/api/v1/me/export-jobs/{jobId}/download', operationId: 'downloadMyExportJob' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.includes('/organize-plans')),
    [
      { method: 'POST', path: '/api/v1/collections/{collectionId}/organize-plans', operationId: 'createCollectionOrganizePlan' },
      { method: 'GET', path: '/api/v1/collections/{collectionId}/organize-plans/{planId}', operationId: 'getCollectionOrganizePlan' },
      { method: 'POST', path: '/api/v1/collections/{collectionId}/organize-plans/{planId}/apply', operationId: 'applyCollectionOrganizePlan' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.includes('/versions')),
    [
      { method: 'GET', path: '/api/v1/collections/{collectionId}/versions', operationId: 'listCollectionVersions' },
      { method: 'POST', path: '/api/v1/collections/{collectionId}/versions', operationId: 'createCollectionVersion' },
      { method: 'GET', path: '/api/v1/collections/{collectionId}/versions/{versionId}', operationId: 'getCollectionVersion' },
      { method: 'POST', path: '/api/v1/collections/{collectionId}/versions/{versionId}/restore', operationId: 'restoreCollectionVersion' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/collections/{collectionId}/follow'),
    [
      { method: 'DELETE', path: '/api/v1/collections/{collectionId}/follow', operationId: 'unfollowCollection' },
      { method: 'GET', path: '/api/v1/collections/{collectionId}/follow', operationId: 'getCollectionFollowState' },
      { method: 'PUT', path: '/api/v1/collections/{collectionId}/follow', operationId: 'followCollection' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/collections/{collectionId}/nodes/{nodeId}/readable'),
    [
      { method: 'GET', path: '/api/v1/collections/{collectionId}/nodes/{nodeId}/readable', operationId: 'getNodeReadableReplica' },
      { method: 'POST', path: '/api/v1/collections/{collectionId}/nodes/{nodeId}/readable', operationId: 'enqueueNodeReadableExtract' },
    ],
  );
  assert.equal(
    publishingInsightsIngestRateLimitFamilyForPath('/api/v1/public-collections/:slug/insight-events'),
    'publishing-insights-ingest',
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.includes('/members') || route.path.includes('collaboration-invites')),
    [
      { method: 'GET', path: '/api/v1/collections/{collectionId}/members', operationId: 'listCollectionMembers' },
      { method: 'POST', path: '/api/v1/collections/{collectionId}/members/invites', operationId: 'inviteCollectionMember' },
      { method: 'DELETE', path: '/api/v1/collections/{collectionId}/members/invites/{inviteId}', operationId: 'revokeCollectionInvite' },
      { method: 'DELETE', path: '/api/v1/collections/{collectionId}/members/{subjectId}', operationId: 'removeCollectionMember' },
      { method: 'PATCH', path: '/api/v1/collections/{collectionId}/members/{subjectId}', operationId: 'updateCollectionMemberRole' },
      { method: 'GET', path: '/api/v1/me/collaboration-invites', operationId: 'listMyCollaborationInvites' },
      { method: 'POST', path: '/api/v1/me/collaboration-invites/{inviteId}/accept', operationId: 'acceptCollaborationInvite' },
      { method: 'POST', path: '/api/v1/me/collaboration-invites/{inviteId}/decline', operationId: 'declineCollaborationInvite' },
      { method: 'GET', path: '/api/v1/reports/{reportId}/members', operationId: 'listReportMembers' },
      { method: 'DELETE', path: '/api/v1/reports/{reportId}/members/{subjectId}', operationId: 'removeReportMember' },
      { method: 'PUT', path: '/api/v1/reports/{reportId}/members/{subjectId}', operationId: 'updateReportMember' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/shared-collections'),
    [{
      method: 'GET',
      path: '/api/v1/me/shared-collections',
      operationId: 'listSharedCollections',
    }],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/followed-collections'),
    [{
      method: 'GET',
      path: '/api/v1/me/followed-collections',
      operationId: 'listFollowedCollections',
    }],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/bookmark-preferences'),
    [
      { method: 'GET', path: '/api/v1/me/bookmark-preferences', operationId: 'getMyBookmarkPreferences' },
      { method: 'PATCH', path: '/api/v1/me/bookmark-preferences', operationId: 'updateMyBookmarkPreferences' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/me/catalog-preferences'),
    [
      { method: 'GET', path: '/api/v1/me/catalog-preferences', operationId: 'getMyCatalogPreferences' },
      { method: 'PATCH', path: '/api/v1/me/catalog-preferences', operationId: 'updateMyCatalogPreferences' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.includes('moderation')),
    [
      { method: 'GET', path: '/api/v1/me/moderation-actions', operationId: 'listActionsAffectingMe' },
      { method: 'GET', path: '/api/v1/me/moderation-appeals', operationId: 'listMyModerationAppeals' },
      { method: 'GET', path: '/api/v1/me/moderation-reports', operationId: 'listMyModerationReports' },
      { method: 'GET', path: '/api/v1/me/moderation-reports/{caseId}', operationId: 'getMyModerationReport' },
      { method: 'POST', path: '/api/v1/moderation/actions', operationId: 'createModerationAction' },
      { method: 'GET', path: '/api/v1/moderation/actions/{actionId}', operationId: 'getModerationAction' },
      { method: 'POST', path: '/api/v1/moderation/actions/{actionId}/revoke', operationId: 'revokeModerationAction' },
      { method: 'GET', path: '/api/v1/moderation/appeals', operationId: 'listModerationAppeals' },
      { method: 'POST', path: '/api/v1/moderation/appeals', operationId: 'createModerationAppeal' },
      { method: 'GET', path: '/api/v1/moderation/appeals/{appealId}', operationId: 'getModerationAppeal' },
      { method: 'POST', path: '/api/v1/moderation/appeals/{appealId}/decision', operationId: 'decideModerationAppeal' },
      { method: 'GET', path: '/api/v1/moderation/cases', operationId: 'listModerationCases' },
      { method: 'GET', path: '/api/v1/moderation/cases/{caseId}', operationId: 'getModerationCase' },
      { method: 'PATCH', path: '/api/v1/moderation/cases/{caseId}', operationId: 'updateModerationCase' },
      { method: 'GET', path: '/api/v1/moderation/cases/{caseId}/evidence/{evidenceId}', operationId: 'getModerationEvidence' },
      { method: 'POST', path: '/api/v1/moderation/reports', operationId: 'submitModerationReport' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.startsWith('/api/v1/me/library-order')),
    [
      { method: 'GET', path: '/api/v1/me/library-order', operationId: 'getMyLibraryOrder' },
      { method: 'PUT', path: '/api/v1/me/library-order/{section}', operationId: 'updateMyLibraryOrder' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.includes('public-reports')),
    [
      { method: 'GET', path: '/api/v1/public-reports', operationId: 'listPublicReports' },
      { method: 'GET', path: '/api/v1/public-reports/{slug}', operationId: 'getPublicReport' },
      { method: 'GET', path: '/api/v1/public-reports/{slug}/issues', operationId: 'listPublicReportIssues' },
      { method: 'GET', path: '/api/v1/public-reports/{slug}/issues/{editionId}', operationId: 'getPublicReportIssue' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.startsWith('/api/v1/reports/')),
    [
      { method: 'DELETE', path: '/api/v1/reports/{reportId}', operationId: 'archiveReport' },
      { method: 'GET', path: '/api/v1/reports/{reportId}', operationId: 'getReport' },
      { method: 'PATCH', path: '/api/v1/reports/{reportId}', operationId: 'updateReport' },
      { method: 'GET', path: '/api/v1/reports/{reportId}/catalog', operationId: 'getReportCatalog' },
      { method: 'PATCH', path: '/api/v1/reports/{reportId}/catalog', operationId: 'updateReportCatalog' },
      { method: 'DELETE', path: '/api/v1/reports/{reportId}/follow', operationId: 'unfollowReport' },
      { method: 'GET', path: '/api/v1/reports/{reportId}/follow', operationId: 'getReportFollowState' },
      { method: 'PUT', path: '/api/v1/reports/{reportId}/follow', operationId: 'followReport' },
      { method: 'GET', path: '/api/v1/reports/{reportId}/issues', operationId: 'listReportIssues' },
      { method: 'POST', path: '/api/v1/reports/{reportId}/issues', operationId: 'attachReportIssue' },
      { method: 'DELETE', path: '/api/v1/reports/{reportId}/issues/{editionId}', operationId: 'detachReportIssue' },
      { method: 'GET', path: '/api/v1/reports/{reportId}/issues/{editionId}', operationId: 'getReportIssue' },
      { method: 'PATCH', path: '/api/v1/reports/{reportId}/issues/{editionId}', operationId: 'updateReportIssue' },
      { method: 'POST', path: '/api/v1/reports/{reportId}/issues/{editionId}/publish', operationId: 'publishReportIssue' },
      { method: 'POST', path: '/api/v1/reports/{reportId}/issues/{editionId}/withdraw', operationId: 'withdrawReportIssue' },
      { method: 'GET', path: '/api/v1/reports/{reportId}/members', operationId: 'listReportMembers' },
      { method: 'DELETE', path: '/api/v1/reports/{reportId}/members/{subjectId}', operationId: 'removeReportMember' },
      { method: 'PUT', path: '/api/v1/reports/{reportId}/members/{subjectId}', operationId: 'updateReportMember' },
      { method: 'DELETE', path: '/api/v1/reports/{reportId}/schedule', operationId: 'deleteReportSchedule' },
      { method: 'GET', path: '/api/v1/reports/{reportId}/schedule', operationId: 'getReportSchedule' },
      { method: 'PUT', path: '/api/v1/reports/{reportId}/schedule', operationId: 'putReportSchedule' },
    ],
  );
  assert.equal(
    PRODUCT_ROUTE_MANIFEST.some((route) => route.operationId === 'listSharedCollections'),
    true,
  );
  assert.equal(
    collaborationInviteRateLimitFamilyForPath('/api/v1/collections/:collectionId/members/invites'),
    'collaboration-invite',
  );
  assert.equal(
    collaborationInviteRateLimitFamilyForPath('/api/v1/me/collaboration-invites/:inviteId/accept'),
    'collaboration-invite',
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.includes('/favicon')),
    [
      { method: 'DELETE', path: '/api/v1/collections/{collectionId}/nodes/{nodeId}/favicon', operationId: 'deleteBookmarkFavicon' },
      { method: 'POST', path: '/api/v1/collections/{collectionId}/nodes/{nodeId}/favicon', operationId: 'uploadBookmarkFavicon' },
      { method: 'POST', path: '/api/v1/collections/{collectionId}/nodes/{nodeId}/favicon-refresh', operationId: 'refreshBookmarkFavicon' },
      { method: 'GET', path: '/api/v1/collections/{collectionId}/nodes/{nodeId}/favicon-source', operationId: 'getBookmarkFaviconSource' },
      { method: 'PUT', path: '/api/v1/collections/{collectionId}/nodes/{nodeId}/favicon-source', operationId: 'setBookmarkFaviconSource' },
      { method: 'GET', path: '/api/v1/favicon/{faviconId}', operationId: 'getBookmarkFavicon' },
      { method: 'POST', path: '/api/v1/me/favicon-jobs', operationId: 'createMyFaviconJob' },
      { method: 'GET', path: '/api/v1/me/favicon-jobs/{jobId}', operationId: 'getMyFaviconJob' },
      { method: 'POST', path: '/api/v1/me/favicon-jobs/{jobId}/retry', operationId: 'retryMyFaviconJob' },
      { method: 'GET', path: '/api/v1/me/favicon-policy', operationId: 'getMyFaviconPolicy' },
      { method: 'PATCH', path: '/api/v1/me/favicon-policy', operationId: 'updateMyFaviconPolicy' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/explore/collections'),
    [
      { method: 'GET', path: '/api/v1/explore/collections', operationId: 'listExploreCollections' },
      { method: 'HEAD', path: '/api/v1/explore/collections', operationId: 'headExploreCollections' },
    ],
  );
  assert.deepEqual(
    PRODUCT_ROUTE_MANIFEST.filter((route) => route.path === '/api/v1/profiles/{handle}/activity'),
    [
      { method: 'GET', path: '/api/v1/profiles/{handle}/activity', operationId: 'listPublicProfileActivity' },
      { method: 'HEAD', path: '/api/v1/profiles/{handle}/activity', operationId: 'headPublicProfileActivity' },
    ],
  );
  assert.deepEqual([...BOOKMARK_FAVICON_DEFERRED_OPERATION_IDS], []);
  assert.equal(BOOKMARK_FAVICON_DEFERRED_OPERATION_IDS.includes('getBookmarkFavicon'), false);
  for (const route of PRODUCT_ROUTE_MANIFEST) {
    assert.deepEqual(productRouteMetadata(route.method, route.path), {
      productOperationId: route.operationId,
    });
  }
});

test('route coverage rejects a missing generated operation', () => {
  const registered = new Set(PRODUCT_ROUTE_MANIFEST.slice(1).map((route) =>
    `${route.method} ${route.path}`));
  assert.throws(() => assertProductRouteCoverage(registered), /missing from registration/);
});

test('bookmark favicon GET/POST/DELETE are registered Product operations', () => {
  const withoutDeferred = new Set(
    PRODUCT_ROUTE_MANIFEST
      .filter((route) => !BOOKMARK_FAVICON_DEFERRED_OPERATION_IDS.includes(route.operationId))
      .map((route) => `${route.method} ${route.path}`),
  );
  assert.equal(withoutDeferred.has('GET /api/v1/favicon/{faviconId}'), true);
  assert.equal(withoutDeferred.has('POST /api/v1/collections/{collectionId}/nodes/{nodeId}/favicon'), true);
  assert.equal(withoutDeferred.has('DELETE /api/v1/collections/{collectionId}/nodes/{nodeId}/favicon'), true);
  assert.doesNotThrow(() =>
    assertProductRouteCoverage(withoutDeferred, BOOKMARK_FAVICON_DEFERRED_OPERATION_IDS));
});

test('complete route registration passes the readiness coverage check', async () => {
  const app = Fastify({ exposeHeadRoutes: false });
  installProductRouteManifestChecks(app, { requireComplete: true });
  for (const route of PRODUCT_ROUTE_MANIFEST) {
    app.route({
      method: route.method,
      url: route.path,
      config: productRouteMetadata(route.method, route.path),
      handler: async () => ({}),
    });
  }

  await app.ready();
  await app.close();
});

test('route metadata rejects method/path drift', () => {
  assert.throws(
    () => productRouteMetadata('GET', '/api/v1/collections/:collectionId/does-not-exist'),
    /not in the OpenAPI manifest/,
  );
});

test('the BYOK profile operations are derived from the manifest and cover the whole gated surface', () => {
  const profileRoutes = PRODUCT_ROUTE_MANIFEST.filter((route) =>
    route.path === CLASSIFICATION_BYOK_PROFILE_PATH_PREFIX
    || route.path.startsWith(`${CLASSIFICATION_BYOK_PROFILE_PATH_PREFIX}/`));
  assert.deepEqual(
    [...CLASSIFICATION_BYOK_OPERATION_IDS].sort(),
    profileRoutes.map((route) => route.operationId).sort(),
  );
  assert.deepEqual([...CLASSIFICATION_BYOK_OPERATION_IDS].sort(), [
    'createMyClassificationProviderProfile',
    'deleteMyClassificationProviderProfile',
    'listMyClassificationProviderProfiles',
    'testMyClassificationProviderProfile',
    'updateMyClassificationProviderProfile',
  ]);
});

test('a BYOK-off composition reaches readiness because the gated operations leave the coverage requirement', async () => {
  const excluded = new Set(CLASSIFICATION_BYOK_OPERATION_IDS);
  const registerApp = async (options: { classificationByokEnabled: boolean; registerGatedRoutes: boolean }) => {
    const app = Fastify({ exposeHeadRoutes: false });
    installProductRouteManifestChecks(app, { requireComplete: true, classificationByokEnabled: options.classificationByokEnabled });
    for (const route of PRODUCT_ROUTE_MANIFEST) {
      if (!options.registerGatedRoutes && excluded.has(route.operationId)) continue; // D4: unregistered while the gate is off
      app.route({
        method: route.method,
        url: route.path,
        config: productRouteMetadata(route.method, route.path),
        handler: async () => ({}),
      });
    }
    return app;
  };

  // The gate is off and its routes are absent: readiness holds.
  const off = await registerApp({ classificationByokEnabled: false, registerGatedRoutes: false });
  await off.ready();
  assert.equal(off.findRoute({ method: 'GET', url: CLASSIFICATION_BYOK_PROFILE_PATH_PREFIX }), null);
  await off.close();

  // The gate is on, so the same absence fails readiness — the exclusion is not a blanket amnesty.
  const onMissing = await registerApp({ classificationByokEnabled: true, registerGatedRoutes: false });
  await assert.rejects(() => onMissing.ready(), /Product routes missing from registration/);
  await onMissing.close();

  // The gate on with its routes registered is unchanged.
  const on = await registerApp({ classificationByokEnabled: true, registerGatedRoutes: true });
  await on.ready();
  await on.close();
});

test('route checks ignore Fastify implicit HEAD while retaining GET coverage', async () => {
  const app = Fastify();
  installProductRouteManifestChecks(app, { requireComplete: false });
  const route = PRODUCT_ROUTE_MANIFEST.find((item) => item.method === 'GET');
  assert.ok(route);

  app.get(route.path, { config: productRouteMetadata(route.method, route.path) }, async () => ({}));
  await app.ready();
  assert.notEqual(app.findRoute({ method: 'HEAD', url: route.path }), null);
  await app.close();
});

test('route checks still reject an explicit unsupported HEAD route', async () => {
  const app = Fastify({ exposeHeadRoutes: false });
  installProductRouteManifestChecks(app, { requireComplete: false });
  const route = PRODUCT_ROUTE_MANIFEST.find((item) => item.method === 'GET');
  assert.ok(route);

  assert.throws(
    () => app.head(route.path, {
      config: { productOperationId: route.operationId },
    }, async () => ({})),
    /HEAD .*not in the OpenAPI manifest|not in the OpenAPI manifest: HEAD/,
  );
  await app.close();
});
