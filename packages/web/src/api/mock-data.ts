import {
  aiChatSeed,
  aiOrganizePlan,
  classifySuggestions,
  collections as legacyCollections,
  curators,
  featuredResources,
  feedItems,
  myFolders,
  myLinks,
  socialFeed,
  syncLog,
} from '../legacy-demo/data/mock'
import type { Resource } from '../types/catalog'
import {
  classifyInbox,
  creatorAnalytics,
  notificationsSeed,
  profileActivity,
  profileFollowing,
  readingPathSteps,
  syncConflictsSeed,
  syncFolders,
} from '../legacy-demo/data/demoExtras'
import type {
  CollectionKind,
  CollectionView,
  CreateCollectionResult,
  EditableNodeView,
  EditorSnapshot,
  MeView,
  PublicCollectionNode,
  PublicCollectionSnapshot,
  RootNodeView,
  SessionView,
} from './types'

const CREATED_AT = '2026-01-15T08:00:00.000Z'
const SNAPSHOT_EXPIRES_AT = '2026-07-24T18:00:00.000Z'

export const mockSession: SessionView = {
  authenticated: true,
  idleExpiresAt: '2026-07-24T18:00:00.000Z',
  absoluteExpiresAt: '2026-07-25T12:00:00.000Z',
  csrfToken: 'mock-csrf-token',
}

export const mockMe: MeView = {
  account: { id: 'mock-account-1', email: 'dev@known.local' },
  profile: {
    id: 'mock-profile-1',
    handle: 'dev',
    displayName: 'Dev User',
    avatarUrl: null,
    about: '',
  },
}

const collectionKinds: CollectionKind[] = [
  'mixed',
  'bookmarks',
  'knowledge_collection',
  'reading_path',
  'knowledge_collection',
  'reading_path',
]

function mockUpdatedAt(index: number): string {
  return new Date(Date.UTC(2026, 6, 24, 12 - index)).toISOString()
}

/** Core collection mocks use the frozen Product API contract without extra fields. */
export const mockCollections: CollectionView[] = legacyCollections.map((collection, index) => ({
  id: collection.id,
  kind: collectionKinds[index] ?? 'bookmarks',
  title: collection.title,
  summary: collection.description,
  visibility: collection.public ? 'public' : 'private',
  allowSearchIndexing: collection.public,
  publicationSlug: collection.public ? collection.slug : null,
  publishedAt: collection.public ? CREATED_AT : null,
  rootNodeId: `root-${collection.id}`,
  revision: '1',
  etag: `"collection:${collection.id}:1"`,
  contentRevision: '1',
  contentEtag: `"collection-content:${collection.id}:1"`,
  policyRevision: '1',
  policyEtag: `"collection-policy:${collection.id}:1"`,
  createdAt: CREATED_AT,
  updatedAt: mockUpdatedAt(index),
}))

/** Legacy fields kept outside CollectionView while mock-only pages are migrated. */
export type MockCollectionExtras = {
  slug: string
  curator: string
  curatorHandle: string
  // TODO: Phase 2B - collection tags
  tags: string[]
  // TODO: Phase 5 - follower projections
  followers: number
  links: number
  updated: string
  public: boolean
  resources: Resource[]
}

export const mockCollectionExtras: Record<string, MockCollectionExtras> = Object.fromEntries(
  legacyCollections.map((collection) => [
    collection.id,
    {
      slug: collection.slug,
      curator: collection.curator,
      curatorHandle: collection.curatorHandle,
      tags: collection.tags,
      followers: collection.followers,
      links: collection.links,
      updated: collection.updated,
      public: collection.public,
      resources: collection.resources,
    },
  ]),
)

function createRoot(collection: CollectionView): RootNodeView {
  return {
    id: collection.rootNodeId,
    collectionId: collection.id,
    kind: 'folder',
    folderRole: 'root',
    parentId: null,
    position: null,
    title: collection.title,
    description: collection.summary,
    tags: [],
    visibility: 'inherit',
    revision: '1',
    etag: `"node:${collection.rootNodeId}:1"`,
    readOnly: false,
    readOnlyReason: null,
    childrenRevision: '1',
    childrenEtag: `"children:${collection.rootNodeId}:1"`,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  }
}

function createEditorNodes(collection: CollectionView): EditableNodeView[] {
  const rootFolder = myFolders[0]
  if (!rootFolder) throw new Error('demo seed has no root folder')
  const folders = rootFolder.children.map((folder, index) => ({
    id: `${collection.id}-${folder.id}`,
    collectionId: collection.id,
    kind: 'folder' as const,
    folderRole: null,
    parentId: collection.rootNodeId,
    position: String(index + 1).padStart(4, '0'),
    title: folder.name,
    description: null,
    tags: [],
    visibility: 'inherit' as const,
    revision: '1',
    etag: `"node:${collection.id}-${folder.id}:1"`,
    readOnly: false,
    readOnlyReason: null,
    childrenRevision: '1',
    childrenEtag: `"children:${collection.id}-${folder.id}:1"`,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  }))

  const bookmarks = myLinks.map((link, index) => {
    const parent = folders.find((folder) => folder.title === link.folder) ?? folders[0]
    if (!parent) throw new Error('demo seed has no folders to file bookmarks into')
    return {
      id: `${collection.id}-${link.id}`,
      collectionId: collection.id,
      kind: 'bookmark' as const,
      parentId: parent.id,
      position: String(index + 1).padStart(4, '0'),
      title: link.title,
      url: link.url ?? `https://${link.host}`,
      description: link.seedNote ?? link.seedTldr ?? null,
      tags: [link.folder],
      visibility: 'inherit' as const,
      revision: '1',
      etag: `"node:${collection.id}-${link.id}:1"`,
      readOnly: false,
      readOnlyReason: null,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
    }
  })

  return [...folders, ...bookmarks]
}

function createEditorSnapshot(collection: CollectionView): EditorSnapshot {
  const nodes = createEditorNodes(collection)
  return {
    collection,
    root: createRoot(collection),
    nodes,
    capabilities: {
      updateCollection: true,
      managePublication: true,
      createNode: true,
      updateNode: true,
      moveNode: true,
      deleteNode: true,
    },
    page: {
      snapshotId: `editor-snapshot-${collection.id}`,
      contentRevision: collection.contentRevision,
      policyRevision: collection.policyRevision,
      comparatorVersion: 'mock-v1',
      expiresAt: SNAPSHOT_EXPIRES_AT,
      returnedCount: nodes.length,
      hasMore: false,
      nextCursor: null,
    },
  }
}

export const mockEditorSnapshots: Record<string, EditorSnapshot> = Object.fromEntries(
  mockCollections.slice(0, 3).map((collection) => [
    collection.id,
    createEditorSnapshot(collection),
  ]),
)

function toPublicNode(node: RootNodeView | EditableNodeView): PublicCollectionNode {
  if (node.kind === 'folder' && node.folderRole === 'root') {
    return {
      id: node.id,
      parentId: null,
      kind: 'root',
      title: node.title,
      description: node.description,
      url: null,
      position: null,
      iconUrl: null,
    }
  }
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    title: node.title,
    description: node.description,
    url: node.kind === 'bookmark' ? node.url : null,
    position: node.position,
    iconUrl: node.kind === 'bookmark' ? node.iconUrl ?? null : null,
  }
}

function createPublicSnapshot(collection: CollectionView): PublicCollectionSnapshot {
  const extras = mockCollectionExtras[collection.id]
  const editor = mockEditorSnapshots[collection.id]
  if (!extras || !editor) throw new Error(`demo seed is missing extras or editor snapshot for ${collection.id}`)
  const nodes = [editor.root, ...editor.nodes].map(toPublicNode)
  return {
    collection: {
      id: collection.id,
      slug: extras.slug,
      title: collection.title,
      summary: collection.summary,
      kind: collection.kind,
      rootNodeId: collection.rootNodeId,
      updatedAt: collection.updatedAt,
      access: 'public',
    },
    nodes,
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

export const mockPublicSnapshots: Record<string, PublicCollectionSnapshot> = Object.fromEntries(
  mockCollections.slice(0, 3).map((collection) => {
    const snapshot = createPublicSnapshot(collection)
    return [snapshot.collection.slug, snapshot]
  }),
)

const firstMockCollection = mockCollections[0]
const firstMockEditor = firstMockCollection ? mockEditorSnapshots[firstMockCollection.id] : undefined
if (!firstMockCollection || !firstMockEditor) throw new Error('demo seed has no collections')

export const mockCreateCollectionResult: CreateCollectionResult = {
  collection: firstMockCollection,
  root: firstMockEditor.root,
}

// TODO: Phase 3 - replace with real contract types when these APIs are defined.
export const legacySyncFolders = syncFolders
export const legacySyncConflicts = syncConflictsSeed
export const legacySyncLog = syncLog
export const legacyClassifyInbox = classifyInbox
export const legacyClassifySuggestions = classifySuggestions

// TODO: Phase 5 - replace with real contract types when these APIs are defined.
export const legacyFeedItems = feedItems
export const legacySocialFeed = socialFeed
export const legacyNotifications = notificationsSeed
export const legacyCreatorAnalytics = creatorAnalytics
export const legacyProfileActivity = profileActivity
export const legacyProfileFollowing = profileFollowing
export const legacyReadingPathSteps = readingPathSteps
export const legacyCurators = curators
export const legacyFeaturedResources = featuredResources
export const legacyAiOrganizePlan = aiOrganizePlan
export const legacyAiChatSeed = aiChatSeed

// Client-only layout data intentionally remains owned by legacy-demo/data.
export { dashboardModules } from '../legacy-demo/data/mock'
export { deskModuleCatalog } from '../legacy-demo/data/demoExtras'

export {
  collections,
  featuredCollection,
  featuredResources,
  resourceGraphEdges,
  myFolders,
  myLinks,
  aiChatSeed,
  aiOrganizePlan,
  curators,
} from '../legacy-demo/data/mock'
export type {
  BookmarkResource,
  BookmarkType,
  CardLayout,
  Collection,
  Curator,
  MyLink,
  Resource,
  SourceType,
  WidgetResource,
  WidgetType,
} from '../types/catalog'

export { sourceLabel, videoSources, dottedSources } from '../lib/sources'

export {
  todayTasks,
  collectionVersions,
  readerSections,
  healthResourcesSeed,
} from '../legacy-demo/data/p0'
export type {
  TodayTask,
  CollectionVersion,
  HealthResource,
  HealthStatus,
} from '../legacy-demo/data/p0'

export {
  classifyInbox,
  readingPathSteps,
  editableResourcesSeed,
} from '../legacy-demo/data/demoExtras'
export type { ClassifyInboxItem, EditableResource } from '../legacy-demo/data/demoExtras'

export { exportHistorySeed } from '../legacy-demo/data/p1'
export type { ExportJob } from '../legacy-demo/data/p1'
