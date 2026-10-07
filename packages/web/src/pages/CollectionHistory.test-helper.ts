/**
 * Pure fixtures shared by the collection-history suites. Kept out of
 * CollectionHistory.test.tsx so that suite stays under the 600-line test gate.
 */
import type { CollectionVersion } from '../api'

export function changeCounts(overrides: Partial<CollectionVersion['changeCounts']> = {}) {
  return { added: 0, removed: 0, moved: 0, renamed: 0, retargeted: 0, ...overrides }
}

export function version(overrides: Partial<CollectionVersion> = {}): CollectionVersion {
  return {
    versionId: 'ver-1',
    etag: '"version-etag-1"',
    collectionId: 'col-1',
    contentRevision: 'rev-1',
    kind: 'manual',
    label: 'Live snapshot A',
    nodeCount: 4,
    createdAt: '2026-08-01T00:00:00.000Z',
    changeCounts: changeCounts(),
    ...overrides,
  }
}

export function editorPage(
  id: string,
  extras: { title?: string; slug?: string | null; contentEtag?: string; etag?: string } = {},
) {
  return {
    collection: {
      id,
      kind: 'bookmarks' as const,
      title: extras.title ?? `Collection ${id}`,
      summary: null,
      visibility: 'private' as const,
      allowSearchIndexing: false,
      publicationSlug: extras.slug === undefined ? null : extras.slug,
      publishedAt: extras.slug ? '2026-08-01T00:00:00.000Z' : null,
      rootNodeId: `root-${id}`,
      revision: '1',
      etag: extras.etag ?? '"collection-etag-1"',
      contentRevision: '1',
      contentEtag: extras.contentEtag ?? '"content-1"',
      policyRevision: '1',
      policyEtag: '"p"',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
    },
    root: { id: `root-${id}` },
    nodes: [],
    capabilities: {
      updateCollection: true,
      managePublication: true,
      createNode: true,
      updateNode: true,
      moveNode: true,
      deleteNode: true,
    },
    page: { returnedCount: 0, hasMore: false, nextCursor: null },
  }
}
