import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  backendRoot,
  assertProductOpenApiVersionMatchesGenerated,
  operations,
  parameterRefs,
  readDocument,
  type UnknownRecord,
} from './openapi-contract-support.js';

test('Product OpenAPI catalog matches the generated route manifest', () => {
  const document = readDocument();
  assertProductOpenApiVersionMatchesGenerated(document);

  const actual = operations(document)
    .filter(({ operation }) => operation['x-known-route-manifest'] !== false)
    .map(({ path, method, operation }) => `${method.toUpperCase()} ${path} ${operation.operationId}`)
    .sort();
  const manifest = JSON.parse(readFileSync(
    join(backendRoot, 'generated/openapi/product-v1.routes.json'),
    'utf8',
  )) as Array<{ method: string; path: string; operationId: string }>;
  const expected = manifest.map(({ method, path, operationId }) =>
    `${method} ${path} ${operationId}`).sort();

  assert.deepEqual(actual, expected);
  assert.equal(actual.some((entry) => /publication/i.test(entry)), false);
  assert.equal(actual.some((entry) => entry === 'GET /api/v1/search searchResources'), true);
  for (const entry of [
    'POST /api/v1/attachments/issue issueAttachmentUpload',
    'POST /api/v1/attachments/complete completeAttachmentUpload',
    'GET /api/v1/attachments/{blobId} getAttachmentStatus',
    'POST /api/v1/attachments/{blobId}/finalize finalizeAttachment',
    'POST /api/v1/attachments/{blobId}/replacement issueAttachmentReplacement',
    'POST /api/v1/attachments/{blobId}/retire retireAttachment',
    'POST /api/v1/attachments/{blobId}/download admitAttachmentDownload',
    'POST /api/v1/public-collections/{slug}/insight-events recordPublicCollectionInsightEvent',
    'GET /api/v1/me/publishing-insights getMyPublishingInsights',
    'GET /api/v1/collections/{collectionId}/members listCollectionMembers',
    'POST /api/v1/collections/{collectionId}/members/invites inviteCollectionMember',
    'DELETE /api/v1/collections/{collectionId}/members/invites/{inviteId} revokeCollectionInvite',
    'PATCH /api/v1/collections/{collectionId}/members/{subjectId} updateCollectionMemberRole',
    'DELETE /api/v1/collections/{collectionId}/members/{subjectId} removeCollectionMember',
    'GET /api/v1/me/collaboration-invites listMyCollaborationInvites',
    'POST /api/v1/me/collaboration-invites/{inviteId}/accept acceptCollaborationInvite',
    'POST /api/v1/me/collaboration-invites/{inviteId}/decline declineCollaborationInvite',
    'GET /api/v1/me/shared-collections listSharedCollections',
    'GET /api/v1/favicon/{faviconId} getBookmarkFavicon',
    'POST /api/v1/collections/{collectionId}/nodes/{nodeId}/favicon uploadBookmarkFavicon',
    'DELETE /api/v1/collections/{collectionId}/nodes/{nodeId}/favicon deleteBookmarkFavicon',
    'GET /api/v1/explore/collections listExploreCollections',
    'HEAD /api/v1/explore/collections headExploreCollections',
    'GET /api/v1/profiles/{handle}/activity listPublicProfileActivity',
    'HEAD /api/v1/profiles/{handle}/activity headPublicProfileActivity',
    'GET /api/v1/me/classify-inbox getMyClassifyInbox',
    'POST /api/v1/me/classify-inbox/{nodeId}/skip skipMyClassifyInboxItem',
    'POST /api/v1/me/classify-inbox/{nodeId}/accept acceptMyClassifyInboxItem',
    'GET /api/v1/me/link-health getMyLinkHealth',
    'POST /api/v1/me/link-health/checks enqueueMyLinkHealthChecks',
    'GET /api/v1/me/export-jobs listMyExportJobs',
    'POST /api/v1/me/export-jobs createMyExportJob',
    'GET /api/v1/me/export-jobs/{jobId} getMyExportJob',
    'GET /api/v1/me/export-jobs/{jobId}/download downloadMyExportJob',
    'POST /api/v1/collections/{collectionId}/organize-plans createCollectionOrganizePlan',
    'GET /api/v1/collections/{collectionId}/organize-plans/{planId} getCollectionOrganizePlan',
    'POST /api/v1/collections/{collectionId}/organize-plans/{planId}/apply applyCollectionOrganizePlan',
    'POST /api/v1/collections/{collectionId}/versions createCollectionVersion',
    'GET /api/v1/collections/{collectionId}/versions listCollectionVersions',
    'GET /api/v1/collections/{collectionId}/versions/{versionId} getCollectionVersion',
    'POST /api/v1/collections/{collectionId}/versions/{versionId}/restore restoreCollectionVersion',
    'GET /api/v1/collections/{collectionId}/nodes/{nodeId}/readable getNodeReadableReplica',
    'POST /api/v1/collections/{collectionId}/nodes/{nodeId}/readable enqueueNodeReadableExtract',
    'PUT /api/v1/collections/{collectionId}/follow followCollection',
    'DELETE /api/v1/collections/{collectionId}/follow unfollowCollection',
    'GET /api/v1/collections/{collectionId}/follow getCollectionFollowState',
    'GET /api/v1/me/followed-collections listFollowedCollections',
    'GET /api/v1/me/library-order getMyLibraryOrder',
    'PUT /api/v1/me/library-order/{section} updateMyLibraryOrder',
  ]) {
    assert.equal(actual.includes(entry), true, `missing catalog operation ${entry}`);
  }

  const activity = document.paths['/api/v1/profiles/{handle}/activity']?.get;
  assert.ok(activity);
  assert.equal(activity.operationId, 'listPublicProfileActivity');
  assert.deepEqual(activity.security, []);
  assert.equal(Object.keys(activity.responses ?? {}).includes('406'), false);
  const activityItem = document.components.schemas.PublicProfileActivityItem as UnknownRecord;
  assert.deepEqual(activityItem.required, ['activityId', 'kind', 'collectionId', 'publishedAt']);
  assert.deepEqual((activityItem.properties as UnknownRecord).kind, {
    type: 'string', enum: ['collection_change'],
  });
  const feedItem = document.components.schemas.FeedItemDto as UnknownRecord;
  assert.deepEqual(feedItem.required, ['feedItemId', 'kind', 'actor', 'collectionId', 'publishedAt']);
  const notificationItem = document.components.schemas.NotificationItem as UnknownRecord;
  assert.deepEqual(notificationItem.required, [
    'notificationId', 'notificationType', 'actorProfileId', 'subject', 'state', 'stateRevision', 'readAt', 'occurredAt',
  ]);
  const exploreGet = document.paths['/api/v1/explore/collections']?.get;
  const exploreHead = document.paths['/api/v1/explore/collections']?.head;
  assert.ok(exploreGet && exploreHead);
  for (const operation of [exploreGet, exploreHead]) {
    assert.equal(parameterRefs(operation).has('#/components/parameters/ExploreSort'), true);
  }
  const exploreItem = document.components.schemas.ExploreCollectionItem as UnknownRecord;
  const exploreProps = exploreItem.properties as UnknownRecord;
  assert.equal((exploreProps.viewCount as UnknownRecord)?.type, 'integer');
  assert.equal((exploreProps.viewCount as UnknownRecord)?.minimum, 0);
  assert.equal(((exploreItem.required as string[]) ?? []).includes('viewCount'), false);
  assert.equal('followers' in exploreProps, false);

  const linkHealth = document.paths['/api/v1/me/link-health']?.get;
  assert.ok(linkHealth);
  assert.equal(linkHealth.operationId, 'getMyLinkHealth');
  assert.deepEqual(linkHealth.tags, ['LinkHealth']);
  assert.deepEqual(linkHealth.security, [{ cookieAuth: [] }]);
  const linkHealthRefs = parameterRefs(linkHealth);
  assert.equal(linkHealthRefs.has('#/components/parameters/CommandId'), false);
  assert.equal(linkHealthRefs.has('#/components/parameters/Origin'), false);
  assert.equal(linkHealthRefs.has('#/components/parameters/CsrfToken'), false);
  assert.equal(linkHealthRefs.has('#/components/parameters/LinkHealthScopeFilter'), true);
  assert.equal(linkHealthRefs.has('#/components/parameters/LinkHealthStatusFilter'), true);
  assert.equal(linkHealthRefs.has('#/components/parameters/LinkHealthCollectionId'), true);
  assert.equal(linkHealthRefs.has('#/components/parameters/LinkHealthDuplicate'), true);
  assert.equal(linkHealthRefs.has('#/components/parameters/LinkHealthLimit'), true);
  assert.equal(linkHealthRefs.has('#/components/parameters/LinkHealthCursor'), true);
  const linkHealthOk = linkHealth.responses?.['200'] as UnknownRecord;
  assert.equal(
    (linkHealthOk.headers as UnknownRecord)?.['Cache-Control']?.$ref,
    '#/components/headers/PrivateNoStore',
  );
  assert.equal(
    ((linkHealthOk.content as UnknownRecord)?.['application/json'] as UnknownRecord)?.schema?.$ref,
    '#/components/schemas/LinkHealthPage',
  );
  assert.ok(Object.keys(linkHealth.responses ?? {}).includes('404'));
  assert.equal(document.paths['/api/v1/me/link-health']?.post, undefined);
  const checks = document.paths['/api/v1/me/link-health/checks']?.post;
  assert.ok(checks);
  assert.equal(checks.operationId, 'enqueueMyLinkHealthChecks');
  assert.deepEqual(checks.tags, ['LinkHealth']);
  assert.deepEqual(checks.security, [{ cookieAuth: [] }]);
  const checksRefs = parameterRefs(checks);
  assert.equal(checksRefs.has('#/components/parameters/CommandId'), true);
  assert.equal(checksRefs.has('#/components/parameters/Origin'), true);
  assert.equal(checksRefs.has('#/components/parameters/CsrfToken'), true);
  const checksOk = checks.responses?.['200'] as UnknownRecord;
  assert.equal(
    (checksOk.headers as UnknownRecord)?.['Cache-Control']?.$ref,
    '#/components/headers/PrivateNoStore',
  );
  assert.equal(
    ((checksOk.content as UnknownRecord)?.['application/json'] as UnknownRecord)?.schema?.$ref,
    '#/components/schemas/LinkHealthChecksReceipt',
  );
  const checksRequest = document.components.schemas.LinkHealthChecksRequest as UnknownRecord;
  assert.equal(checksRequest.additionalProperties, false);
  assert.equal(checksRequest.required, undefined);
  const checksReceipt = document.components.schemas.LinkHealthChecksReceipt as UnknownRecord;
  assert.deepEqual(checksReceipt.required, ['queued']);
  const statusSchema = document.components.schemas.LinkHealthStatus as UnknownRecord;
  assert.deepEqual(statusSchema.enum, ['pending', 'healthy', 'redirect', 'broken']);
  const itemSchema = document.components.schemas.LinkHealthItem as UnknownRecord;
  assert.equal(itemSchema.additionalProperties, false);
  assert.deepEqual(itemSchema.required, [
    'nodeId', 'collectionId', 'collectionTitle', 'title', 'url', 'status', 'duplicateOfNodeId',
  ]);
  const itemProps = itemSchema.properties as UnknownRecord;
  assert.equal(Object.hasOwn(itemProps, 'etag'), true);
  assert.equal(Object.hasOwn(itemProps, 'nodeRevision'), false);
  assert.equal(((itemSchema.required as string[]) ?? []).includes('etag'), false);
  assert.equal(Object.hasOwn(itemProps, 'stale'), false);
  assert.equal((itemProps.membership as UnknownRecord)?.$ref, '#/components/schemas/LinkHealthMembership');
  assert.equal(((itemSchema.required as string[]) ?? []).includes('membership'), false);
  assert.equal((itemProps.errorClass as UnknownRecord)?.$ref, '#/components/schemas/LinkHealthErrorClass');
  assert.equal((itemProps.duplicateRelationId as UnknownRecord)?.$ref, '#/components/schemas/OpaqueId');
  assert.equal((itemProps.duplicateRelationEtag as UnknownRecord)?.$ref, '#/components/schemas/EntityTag');
  assert.equal(((itemSchema.required as string[]) ?? []).includes('errorClass'), false);
  assert.equal(((itemSchema.required as string[]) ?? []).includes('duplicateRelationId'), false);
  assert.equal(((itemSchema.required as string[]) ?? []).includes('duplicateRelationEtag'), false);
  const errorClassSchema = document.components.schemas.LinkHealthErrorClass as UnknownRecord;
  assert.deepEqual(errorClassSchema.enum, ['invalid_url', 'timeout', 'denied', 'dns', 'http']);
  const membershipSchema = document.components.schemas.LinkHealthMembership as UnknownRecord;
  assert.deepEqual(membershipSchema.enum, ['owner', 'editor', 'viewer']);
  const scopeSchema = document.components.schemas.LinkHealthScope as UnknownRecord;
  assert.deepEqual(scopeSchema.enum, ['owned', 'shared', 'all']);
  const scopeParam = document.components.parameters.LinkHealthScopeFilter as UnknownRecord;
  assert.equal(scopeParam.required, false);
  assert.match(String(linkHealth.description), /shared/iu);
  assert.match(String(linkHealth.description), /cursor encodes scope/iu);
  assert.match(String(itemSchema.description), /shared/iu);
  assert.match(String(checks.description), /shared editor/iu);
  const cursorParam = document.components.parameters.LinkHealthCursor as UnknownRecord;
  assert.match(String(cursorParam.description), /scope/iu);


  const exportList = document.paths['/api/v1/me/export-jobs']?.get;
  const exportCreate = document.paths['/api/v1/me/export-jobs']?.post;
  const exportGet = document.paths['/api/v1/me/export-jobs/{jobId}']?.get;
  const exportDownload = document.paths['/api/v1/me/export-jobs/{jobId}/download']?.get;
  assert.ok(exportList && exportCreate && exportGet && exportDownload);
  assert.equal(exportList.operationId, 'listMyExportJobs');
  assert.equal(exportCreate.operationId, 'createMyExportJob');
  assert.equal(exportGet.operationId, 'getMyExportJob');
  assert.equal(exportDownload.operationId, 'downloadMyExportJob');
  assert.deepEqual(exportList.tags, ['Export']);
  assert.deepEqual(exportCreate.security, [{ cookieAuth: [] }]);
  const exportCreateRefs = parameterRefs(exportCreate);
  assert.equal(exportCreateRefs.has('#/components/parameters/CommandId'), true);
  assert.equal(exportCreateRefs.has('#/components/parameters/Origin'), true);
  assert.equal(exportCreateRefs.has('#/components/parameters/CsrfToken'), true);
  assert.equal(exportCreateRefs.has('#/components/parameters/IfMatch'), false);
  const listRefs = parameterRefs(exportList);
  assert.equal(listRefs.has('#/components/parameters/CommandId'), false);
  assert.equal(listRefs.has('#/components/parameters/Origin'), false);
  assert.ok(Object.keys(exportCreate.responses ?? {}).includes('409'));
  assert.ok(Object.keys(exportCreate.responses ?? {}).includes('201'));
  assert.equal(document.paths['/api/v1/me/export-jobs']?.head, undefined);
  assert.equal(document.paths['/api/v1/me/export-jobs/{jobId}']?.head, undefined);
  assert.equal(document.paths['/api/v1/me/export-jobs/{jobId}/download']?.head, undefined);
  const exportJob = document.components.schemas.ExportJob as UnknownRecord;
  assert.deepEqual(exportJob.required, ['jobId', 'status', 'createdAt']);
  const exportJobProps = exportJob.properties as UnknownRecord;
  assert.equal(Object.hasOwn(exportJobProps, 'downloadUrl'), false);
  const exportStatus = document.components.schemas.ExportJobStatus as UnknownRecord;
  assert.deepEqual(exportStatus.enum, ['pending', 'running', 'ready', 'failed', 'expired']);
  const downloadOk = exportDownload.responses?.['200'] as UnknownRecord;
  assert.equal(
    (downloadOk.headers as UnknownRecord)?.['Cache-Control']?.$ref,
    '#/components/headers/PrivateNoStore',
  );
  assert.equal(
    ((downloadOk.content as UnknownRecord)?.['application/json'] as UnknownRecord)?.schema?.$ref,
    '#/components/schemas/ExportLibraryDocument',
  );
  assert.equal(Object.keys((downloadOk.content as UnknownRecord) ?? {}).includes('application/json'), true);
  assert.equal(Object.keys(exportDownload.responses ?? {}).includes('302'), false);

  const ingest = document.paths['/api/v1/public-collections/{slug}/insight-events']?.post;
  assert.ok(ingest);
  assert.equal(ingest.operationId, 'recordPublicCollectionInsightEvent');
  assert.deepEqual(ingest.tags, ['PublishingInsights']);
  assert.deepEqual(ingest.security, [{ cookieAuth: [] }, {}]);
  const ingestRefs = parameterRefs(ingest);
  assert.equal(ingestRefs.has('#/components/parameters/CommandId'), false);
  assert.equal(ingestRefs.has('#/components/parameters/Origin'), true);
  assert.ok(Object.keys(ingest.responses ?? {}).includes('204'));
  assert.equal((ingest.responses as UnknownRecord)['204']?.content, undefined);

  const dashboard = document.paths['/api/v1/me/publishing-insights']?.get;
  assert.ok(dashboard);
  assert.equal(dashboard.operationId, 'getMyPublishingInsights');
  assert.deepEqual(dashboard.tags, ['PublishingInsights']);
  assert.deepEqual(dashboard.security, [{ cookieAuth: [] }]);
  assert.equal(dashboard.parameters, undefined);
  const dashboardRefs = parameterRefs(dashboard);
  assert.equal(dashboardRefs.has('#/components/parameters/CommandId'), false);
  assert.equal(dashboardRefs.has('#/components/parameters/Origin'), false);
  assert.equal(dashboardRefs.has('#/components/parameters/CsrfToken'), false);
  const dashboardOk = dashboard.responses?.['200'] as UnknownRecord;
  assert.equal(
    (dashboardOk.headers as UnknownRecord)?.['Cache-Control']?.$ref,
    '#/components/headers/PrivateNoStore',
  );
  assert.equal(
    ((dashboardOk.content as UnknownRecord)?.['application/json'] as UnknownRecord)?.schema?.$ref,
    '#/components/schemas/PublishingInsights',
  );
  const publishingInsights = document.components.schemas.PublishingInsights as UnknownRecord;
  assert.equal(publishingInsights.additionalProperties, false);
  assert.deepEqual(publishingInsights.required, ['window', 'funnel', 'weekly', 'topResources']);
  const insightsProperties = publishingInsights.properties as UnknownRecord;
  const funnelSchema = insightsProperties.funnel as UnknownRecord;
  const weeklySchema = insightsProperties.weekly as UnknownRecord;
  const topSchema = insightsProperties.topResources as UnknownRecord;
  const windowSchema = insightsProperties.window as UnknownRecord;
  const daysSchema = (windowSchema.properties as UnknownRecord).days as UnknownRecord;
  assert.equal(daysSchema.const, 30);
  assert.match(String(daysSchema.description), /exactly 30 UTC calendar days including today/iu);
  assert.match(String(daysSchema.description), /four 7-day buckets ending today/iu);
  assert.equal(funnelSchema.minItems, 2);
  assert.equal(funnelSchema.maxItems, 2);
  assert.equal(weeklySchema.minItems, 4);
  assert.equal(weeklySchema.maxItems, 4);
  assert.equal(topSchema.maxItems, 3);
});

test('1.21.0 occupancy verificationRequired and frozen 1.20.0 bookmarkCount', () => {
  const document = readDocument();
  assertProductOpenApiVersionMatchesGenerated(document);
  const unauthenticated = document.components.schemas.UnauthenticatedSessionView as UnknownRecord;
  assert.equal(unauthenticated.additionalProperties, false);
  assert.deepEqual(unauthenticated.required, ['authenticated']);
  const unauthProps = unauthenticated.properties as UnknownRecord;
  assert.equal((unauthProps.authenticated as UnknownRecord)?.const, false);
  assert.equal((unauthProps.verificationRequired as UnknownRecord)?.type, 'boolean');
  const getMe = document.paths['/api/v1/me']?.get;
  assert.ok(getMe);
  assert.ok(Object.keys(getMe.responses ?? {}).includes('403'));
  const shared = document.paths['/api/v1/me/shared-collections']?.get;
  assert.ok(shared);
  assert.equal(shared.operationId, 'listSharedCollections');
  assert.deepEqual(shared.tags, ['Collaboration']);
  assert.deepEqual(shared.security, [{ cookieAuth: [] }]);
  const sharedRefs = parameterRefs(shared);
  assert.equal(sharedRefs.has('#/components/parameters/CommandId'), false);
  assert.equal(sharedRefs.has('#/components/parameters/Origin'), false);
  assert.equal(sharedRefs.has('#/components/parameters/CsrfToken'), false);
  assert.equal(sharedRefs.has('#/components/parameters/OwnedCollectionKind'), true);
  assert.equal(sharedRefs.has('#/components/parameters/OwnedCollectionVisibility'), true);
  assert.equal(sharedRefs.has('#/components/parameters/OwnedCollectionLimit'), true);
  assert.equal(sharedRefs.has('#/components/parameters/OwnedCollectionCursor'), true);
  const sharedOk = shared.responses?.['200'] as UnknownRecord;
  assert.equal(
    (sharedOk.headers as UnknownRecord)?.['Cache-Control']?.$ref,
    '#/components/headers/PrivateNoStore',
  );
  assert.equal(
    ((sharedOk.content as UnknownRecord)?.['application/json'] as UnknownRecord)?.schema?.$ref,
    '#/components/schemas/OwnedCollectionPage',
  );

  const membersGet = document.paths['/api/v1/collections/{collectionId}/members']?.get;
  assert.ok(membersGet);
  assert.equal(membersGet.operationId, 'listCollectionMembers');
  assert.deepEqual(membersGet.tags, ['Collaboration']);
  assert.deepEqual(membersGet.security, [{ cookieAuth: [] }]);
  const membersRefs = parameterRefs(membersGet);
  assert.equal(membersRefs.has('#/components/parameters/CommandId'), false);
  assert.equal(membersRefs.has('#/components/parameters/Origin'), false);
  assert.equal(membersRefs.has('#/components/parameters/CsrfToken'), false);
  assert.equal(membersRefs.has('#/components/parameters/IfMatch'), false);
  assert.equal(membersRefs.has('#/components/parameters/CollaborationListCursor'), true);
  const membersOk = membersGet.responses?.['200'] as UnknownRecord;
  assert.equal(
    (membersOk.headers as UnknownRecord)?.['Cache-Control']?.$ref,
    '#/components/headers/PrivateNoStore',
  );
  const membersPage = document.components.schemas.CollectionMembersPage as UnknownRecord;
  const memberItem = (membersPage.properties as UnknownRecord).members as {
    items: { properties: UnknownRecord; required: readonly string[] };
  };
  assert.equal(Object.hasOwn(memberItem.items.properties, 'avatarUrl'), true);
  assert.equal(memberItem.items.required.includes('avatarUrl'), false);
  assert.deepEqual(memberItem.items.required, [
    'subjectId', 'role', 'displayName', 'email', 'initials', 'grantedAt',
  ]);

  const invite = document.paths['/api/v1/collections/{collectionId}/members/invites']?.post;
  assert.ok(invite);
  assert.equal(invite.operationId, 'inviteCollectionMember');
  const inviteRefs = parameterRefs(invite);
  assert.equal(inviteRefs.has('#/components/parameters/CommandId'), true);
  assert.equal(inviteRefs.has('#/components/parameters/Origin'), true);
  assert.equal(inviteRefs.has('#/components/parameters/CsrfToken'), true);
  assert.equal(inviteRefs.has('#/components/parameters/IfMatch'), true);
  assert.ok(Object.keys(invite.responses ?? {}).includes('201'));
  assert.ok(Object.keys(invite.responses ?? {}).includes('428'));
  assert.ok(Object.keys(invite.responses ?? {}).includes('412'));
  const created = document.components.schemas.CollectionInviteCreated as UnknownRecord;
  assert.equal(created.additionalProperties, false);
  assert.deepEqual(created.required, ['inviteId', 'collectionId', 'role', 'expiresAt', 'policyEtag']);
  const createdProps = Object.keys(created.properties as UnknownRecord).sort();
  assert.deepEqual(createdProps, ['collectionId', 'expiresAt', 'inviteId', 'policyEtag', 'role']);
  for (const forbidden of ['accountFound', 'emailQueued', 'found', 'queued', 'deliveryId', 'emailStatus']) {
    assert.equal(forbidden in (created.properties as UnknownRecord), false);
  }

  const patch = document.paths['/api/v1/collections/{collectionId}/members/{subjectId}']?.patch;
  assert.ok(patch);
  const patchBody = (patch as UnknownRecord).requestBody as UnknownRecord;
  assert.ok((patchBody.content as UnknownRecord)['application/merge-patch+json']);

  const accept = document.paths['/api/v1/me/collaboration-invites/{inviteId}/accept']?.post;
  assert.ok(accept);
  const acceptRefs = parameterRefs(accept);
  assert.equal(acceptRefs.has('#/components/parameters/IfMatch'), false);
  assert.equal(acceptRefs.has('#/components/parameters/CommandId'), true);

  const myInvites = document.components.schemas.MyCollaborationInviteItem as UnknownRecord;
  assert.equal(myInvites.additionalProperties, false);
  assert.deepEqual(myInvites.required, [
    'inviteId', 'collectionId', 'collectionTitle', 'role', 'email', 'expiresAt', 'invitedAt',
  ]);

  const capabilities = document.components.schemas.CollectionCapabilities as UnknownRecord;
  assert.equal(capabilities.additionalProperties, false);
  assert.deepEqual(capabilities.required, [
    'updateCollection', 'managePublication', 'createNode', 'updateNode', 'moveNode', 'deleteNode',
  ]);
  assert.equal('manageMembers' in (capabilities.properties as UnknownRecord), false);

  const readableExtract = document.paths[
    '/api/v1/collections/{collectionId}/nodes/{nodeId}/readable'
  ]?.post;
  assert.ok(readableExtract);
  assert.equal(readableExtract.operationId, 'enqueueNodeReadableExtract');
  for (const status of ['410', '413', '415', '422']) {
    assert.equal(
      Object.keys(readableExtract.responses ?? {}).includes(status),
      true,
      `enqueueNodeReadableExtract missing ${status}`,
    );
  }
});
