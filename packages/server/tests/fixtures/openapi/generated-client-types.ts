import type { components, operations } from '../../../generated/openapi/product-v1.js';

type Schemas = components['schemas'];

export const unauthenticatedSession = {
  authenticated: false,
} satisfies Schemas['SessionView'];

export const publicProfilePage = {
  profile: {
    profileId: 'IiIiIiIiIiIiIiIiIiIiIg',
    handle: 'alice',
    displayName: 'Alice',
    avatarUrl: 'https://cdn.example.test/alice.png',
    about: '',
  },
  collections: [{
    id: 'collection-1',
    slug: 'public-notes',
    title: 'Public notes',
    summary: null,
    kind: 'knowledge_collection',
    updatedAt: '2026-07-24T00:00:00.000Z',
  }],
  page: { cursor: null, hasMore: false },
} satisfies Schemas['PublicProfilePage'];

export const publicCollectionPage = {
  collection: {
    id: 'collection-1', slug: 'public-notes', title: 'Public notes', summary: null,
    kind: 'knowledge_collection', rootNodeId: 'root-1', updatedAt: '2026-07-24T00:00:00.000Z',
    access: 'public',
    owner: {
      profileId: 'IiIiIiIiIiIiIiIiIiIiIg', handle: 'alice', displayName: 'Alice', avatarUrl: null,
    },
  },
  nodes: [],
  page: { cursor: null, hasMore: false, sequence: 1 },
} satisfies Schemas['PublicCollectionPage'];

export const createCollection = {
  kind: 'knowledge_collection',
  title: 'Phase 1 contract',
  summary: null,
} satisfies Schemas['CreateCollectionRequest'];

export const patchCollection = {
  title: 'Updated title',
} satisfies Schemas['CollectionMergePatch'];

export const createNode = {
  parentId: 'root-1',
  afterId: null,
  beforeId: null,
  node: {
    kind: 'bookmark',
    title: 'OpenAPI',
    url: 'https://spec.openapis.org/',
    description: null,
    tags: ['api'],
    visibility: 'inherit',
  },
} satisfies Schemas['CreateNodeRequest'];

export const patchNode = {
  title: 'OpenAPI specification',
  tags: ['api', 'contract'],
} satisfies Schemas['NodeMergePatch'];

export const moveNode = {
  newParentId: 'folder-2',
  afterId: 'node-1',
  beforeId: null,
  baseSourceParentRevision: 'rev-10',
  baseTargetParentRevision: 'rev-11',
} satisfies Schemas['MoveNodeRequest'];

export const createAnnotation = {
  type: 'note',
  format: 'plain',
  value: 'A private note',
  visibility: 'private',
  extensions: {},
} satisfies Schemas['CreateAnnotationRequest'];

export const patchAnnotation = {
  format: 'html',
  value: '<strong>Untrusted annotation HTML</strong>',
} satisfies Schemas['AnnotationMergePatch'];

export type AnnotationPage = Schemas['AnnotationPage'];
export type AnnotationView = Schemas['AnnotationView'];
export type DeleteAnnotationResult = Schemas['DeleteAnnotationResult'];

export const createRelation = {
  fromNodeId: 'node-from', toNodeId: 'node-to', type: 'related',
  label: 'Related', visibility: 'protected', extensions: {},
} satisfies Schemas['CreateRelationRequest'];
export const patchRelation = { label: null, visibility: 'private' } satisfies Schemas['RelationMergePatch'];
export type RelationPage = Schemas['RelationPage'];
export type RelationView = Schemas['RelationView'];
export type DeleteRelationResult = Schemas['DeleteRelationResult'];
export type SavedResourcePage = Schemas['SavedResourcePage'];
export type SavedResourceView = Schemas['SavedResourceView'];
export const savedResourceResult = { resourceType: 'node', resourceId: 'node-1',
  savedAt: '2026-07-25T12:00:00.000Z', changed: true } satisfies Schemas['SaveResourceResult'];
export const readingProgressUpdate = { status: 'in_progress', progress: 0.42 } satisfies Schemas['ReadingProgressUpdate'];
export type ReadingProgressPage = Schemas['ReadingProgressPage'];
export type ReadingProgressView = Schemas['ReadingProgressView'];
export type SearchPage = Schemas['SearchPage'];
export type SearchResult = Schemas['SearchResult'];
export type OwnedCollectionPage = Schemas['OwnedCollectionPage'];
export type OwnedCollectionListItem = Schemas['OwnedCollectionListItem'];
export const ownedCollectionRequest = {
  query: { kind: 'bookmarks', visibility: 'private', limit: 30 },
  header: { Accept: 'application/json' },
} satisfies operations['listOwnedCollections']['parameters'];
export type OwnedCollectionSuccess = operations['listOwnedCollections']['responses'][200]['content']['application/json'];
export const sharedCollectionRequest = {
  query: { kind: 'bookmarks', visibility: 'private', limit: 30 },
  header: { Accept: 'application/json' },
} satisfies operations['listSharedCollections']['parameters'];
export type SharedCollectionSuccess = operations['listSharedCollections']['responses'][200]['content']['application/json'];
export const searchPage = {
  query: 'open api',
  types: ['collection', 'node', 'profile', 'annotation'],
  items: [{ resourceType: 'collection', resourceId: 'collection-1', title: 'Open API',
    snippet: 'A bounded plain-text result.', rank: 0.875 }],
  page: { returnedCount: 1, hasMore: false, nextCursor: null },
  consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
} satisfies Schemas['SearchPage'];
export const searchRequest = {
  query: { q: 'open api', type: ['collection', 'node'], limit: 20 },
  header: { Accept: 'application/json', 'If-None-Match': '"sha256-example"' },
} satisfies operations['searchResources']['parameters'];
export type SearchSuccess = operations['searchResources']['responses'][200]['content']['application/json'];
export const followRequest = {
  path: { profileId: 'IiIiIiIiIiIiIiIiIiIiIg' },
  header: { 'Known-Command-Id': '018f0e3d-1111-4111-8111-111111111111',
    Origin: 'https://app.example.test', 'X-CSRF-Token': 'session-bound-token' },
} satisfies operations['followProfile']['parameters'];
export type FollowRelation = operations['followProfile']['responses'][200]['content']['application/json'];
export const followPageRequest = {
  path: { profileId: 'IiIiIiIiIiIiIiIiIiIiIg' },
  query: { limit: 30, cursor: 'opaque-follow-cursor' },
} satisfies operations['listProfileFollowers']['parameters'];
export type FollowPage = operations['listProfileFollowers']['responses'][200]['content']['application/json'];
export const feedPageRequest = {
  query: { kind: 'collection_change', limit: 30 },
} satisfies operations['getProductFeed']['parameters'];
export type FeedPage = operations['getProductFeed']['responses'][200]['content']['application/json'];
export type NotificationInboxPage = operations['listNotifications']['responses'][200]['content']['application/json'];
export type NotificationPreference = operations['getNotificationPreferences']['responses'][200]['content']['application/json'];
export const headSearchRequest = {
  query: { q: 'open api', cursor: 'opaque-search-cursor' },
  header: { Accept: 'application/json', 'If-None-Match': 'W/"sha256-example"' },
} satisfies operations['headSearchResources']['parameters'];

export type DeleteNodeResult = Schemas['DeleteNodeResult'];

export const attachmentIssueRequest = {
  collectionId: 'collection-1',
  declaredSize: 1024,
  declaredSha256: 'a'.repeat(64),
  mediaHint: 'image/png',
  expectedPolicyRevision: null,
} satisfies Schemas['AttachmentIssueRequest'];
export const attachmentCompleteRequest = {
  binding: { intentId: 'intent-1', generationId: 'generation-1', blobId: 'blob-1' },
  declared: { size: 1024, sha256: 'a'.repeat(64), mediaType: 'image/png', etag: '"etag-1"' },
} satisfies Schemas['AttachmentCompleteRequest'];
export const attachmentReplacementRequest = {
  declaredSize: 2048,
  mediaHint: null,
} satisfies Schemas['AttachmentReplacementRequest'];
export const attachmentStatus = {
  blobId: 'blob-1',
  logicalState: 'stored_private',
  verificationStatus: 'verified',
  availability: 'available',
  size: 1024,
  mediaType: 'image/png',
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
  allowedActions: ['download', 'finalize'],
} satisfies Schemas['AttachmentStatusDto'];
export const attachmentIssueResult = {
  kind: 'issued',
  receipt: { blobId: 'blob-1', intentId: 'intent-1', generationId: 'generation-1' },
  grant: {
    url: 'https://provider.example.test/put?signature=opaque',
    method: 'PUT',
    contentType: 'image/png',
    contentLength: 1024,
    expiresAt: '2026-08-08T00:01:00.000Z',
    ttlSeconds: 60,
  },
} satisfies Schemas['AttachmentIssueResult'];
export type AttachmentIssueSuccess = operations['issueAttachmentUpload']['responses'][201]['content']['application/json'];
export type AttachmentStatusSuccess = operations['getAttachmentStatus']['responses'][200]['content']['application/json'];
export type AttachmentProblem = operations['issueAttachmentUpload']['responses'][503]['content']['application/json'];
export type CollectionMembersPage = operations['listCollectionMembers']['responses'][200]['content']['application/json'];
export const collectionMemberItem = {
  subjectId: 'member-1',
  role: 'editor',
  displayName: 'Ada Owner',
  email: null,
  initials: 'AO',
  avatarUrl: 'https://cdn.example.test/ada.png',
  grantedAt: '2026-08-19T12:00:00.000Z',
} satisfies CollectionMembersPage['members'][number];
export const collectionInviteCreated = {
  inviteId: 'invite-1',
  collectionId: 'collection-1',
  role: 'editor',
  expiresAt: '2026-08-26T12:00:00.000Z',
  policyEtag: '"policy-1"',
} satisfies operations['inviteCollectionMember']['responses'][201]['content']['application/json'];
export const myCollaborationInviteItem = {
  inviteId: 'invite-1',
  collectionId: 'collection-1',
  collectionTitle: 'Team notes',
  role: 'viewer',
  email: 'invitee@example.test',
  expiresAt: '2026-08-26T12:00:00.000Z',
  invitedAt: '2026-08-19T12:00:00.000Z',
} satisfies operations['listMyCollaborationInvites']['responses'][200]['content']['application/json']['items'][number];

export type BookmarkFaviconUrl = Schemas['BookmarkFaviconUrl'];
export type BookmarkNodeView = Schemas['BookmarkNodeView'];
export type GetBookmarkFavicon = operations['getBookmarkFavicon'];
export type UploadBookmarkFaviconOk = operations['uploadBookmarkFavicon']['responses'][200]['content']['application/json'];
export type DeleteBookmarkFaviconOk = operations['deleteBookmarkFavicon']['responses'][200]['content']['application/json'];
export type ExploreCollectionsPage = operations['listExploreCollections']['responses'][200]['content']['application/json'];
export const exploreCollectionsPage = {
  items: [{
    id: 'public-one',
    title: 'Public notes',
    summary: 'Summary',
    kind: 'bookmarks',
    tags: ['tag'],
    nodeCount: 3,
    updatedAt: '2026-07-24T00:00:00.000Z',
    publicationSlug: 'public-one',
    visibility: 'public',
    creators: [{
      id: 'account:acct-owner',
      name: 'Ada',
      handle: 'ada',
      avatar: 'https://cdn.example.test/ada.png',
    }],
  }],
  nextCursor: null,
} satisfies Schemas['ExploreCollectionsPage'];

// Classification shape siblings must constrain every anyOf alternative.
// @ts-expect-error requested always requires both folder and tags booleans.
const incompleteClassificationRequested: import('../../../generated/openapi/product-v1.js').components['schemas']['ClassificationRequested'] = {folder:true};
// @ts-expect-error source selectors never waive the required requested/maxItems fields.
const incompleteClassificationRun: import('../../../generated/openapi/product-v1.js').components['schemas']['ClassificationRunCreateRequest'] = {nodeIds:['node']};
void incompleteClassificationRequested;void incompleteClassificationRun;
