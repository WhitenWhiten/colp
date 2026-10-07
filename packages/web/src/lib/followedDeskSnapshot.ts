import type { EditorSnapshot, PublicCollectionSnapshot } from '../api'

/**
 * Adapts the assembled public snapshot of a followed collection to the desk's
 * editor-snapshot shape so `/library/following/:slug` reuses the exact same
 * components as owned and shared collections. Every capability is false, so
 * the placeholder revisions and etags below can never reach a mutation call —
 * public snapshots simply do not carry those fields.
 */
const FOLLOWED_PLACEHOLDER = {
  tags: [] as string[],
  visibility: 'inherit' as const,
  revision: '0',
  etag: '"followed"',
  readOnly: true,
  readOnlyReason: 'Followed collections are read-only in the library.',
  createdAt: '',
  updatedAt: '',
}

export function followedDeskSnapshot(snapshot: PublicCollectionSnapshot): EditorSnapshot {
  const { collection, nodes } = snapshot
  const rootSource = nodes.find((node) => node.id === collection.rootNodeId)
    ?? nodes.find((node) => node.kind === 'root')
  const rootId = rootSource?.id ?? collection.rootNodeId

  const root: EditorSnapshot['root'] = {
    id: rootId,
    collectionId: collection.id,
    kind: 'folder',
    folderRole: 'root',
    parentId: null,
    position: null,
    title: rootSource?.title ?? collection.title,
    description: rootSource?.description ?? null,
    childrenRevision: '0',
    childrenEtag: '"followed-children"',
    ...FOLLOWED_PLACEHOLDER,
  }

  const children: EditorSnapshot['nodes'] = []
  for (const node of nodes) {
    if (node.id === rootId || node.kind === 'root') continue
    if (node.kind === 'folder') {
      children.push({
        id: node.id,
        collectionId: collection.id,
        kind: 'folder',
        folderRole: null,
        parentId: node.parentId ?? rootId,
        position: node.position ?? '',
        title: node.title,
        description: node.description,
        childrenRevision: '0',
        childrenEtag: '"followed-children"',
        ...FOLLOWED_PLACEHOLDER,
      })
      continue
    }
    children.push({
      id: node.id,
      collectionId: collection.id,
      kind: 'bookmark',
      parentId: node.parentId ?? rootId,
      position: node.position ?? '',
      title: node.title,
      url: node.url ?? '',
      iconUrl: node.iconUrl ?? null,
      description: node.description,
      ...FOLLOWED_PLACEHOLDER,
    })
  }

  return {
    collection: {
      id: collection.id,
      kind: collection.kind,
      title: collection.title,
      summary: collection.summary ?? null,
      visibility: 'public',
      allowSearchIndexing: false,
      publicationSlug: collection.slug,
      publishedAt: null,
      rootNodeId: rootId,
      revision: '0',
      etag: '"followed"',
      contentRevision: '0',
      contentEtag: '"followed-content"',
      policyRevision: '0',
      policyEtag: '"followed-policy"',
      createdAt: collection.updatedAt,
      updatedAt: collection.updatedAt,
    },
    root,
    nodes: children,
    capabilities: {
      updateCollection: false,
      managePublication: false,
      createNode: false,
      updateNode: false,
      moveNode: false,
      deleteNode: false,
    },
    page: {
      snapshotId: 'followed-public-snapshot',
      contentRevision: '0',
      policyRevision: '0',
      comparatorVersion: 'public',
      expiresAt: collection.updatedAt,
      returnedCount: children.length,
      hasMore: false,
      nextCursor: null,
    },
  } as EditorSnapshot
}
