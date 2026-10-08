import type { AnnotationView, EditorSnapshot, ReadableReplicaView } from '../api/types'

export const NODE_ID = 'nd-col-u01-01-001'
export const COLLECTION_ID = 'collection-1'
export const SOURCE_URL = 'https://www.youtube.com/@3blue1brown'

export function replica(overrides: Partial<ReadableReplicaView> = {}): ReadableReplicaView {
  return {
    nodeId: NODE_ID,
    collectionId: COLLECTION_ID,
    status: 'ready',
    sourceUrl: SOURCE_URL,
    title: 'Extracted title',
    byline: 'Ada',
    wordCount: 400,
    extractedAt: '2026-08-25T00:00:00.000Z',
    failureCode: null,
    sections: [{
      id: 'sec-1',
      heading: 'Opening',
      paragraphs: [{ id: 'p-1', text: '<script>alert(1)</script>Hello reader.' }],
    }],
    etag: '"rr-1"',
    ...overrides,
  }
}

export function highlightAnnotation(paragraphId: string): AnnotationView {
  return {
    id: `highlight-${paragraphId}`,
    collectionId: COLLECTION_ID,
    subject: { type: 'node', id: NODE_ID },
    type: 'highlight',
    format: 'json',
    value: { quote: paragraphId },
    visibility: 'private',
    creator: { id: 'https://known.test/profiles/mira', name: 'Mira' },
    provenance: { kind: 'human' },
    revision: 'revision-h1',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    extensions: {},
  }
}

export function editor(url: string | null = SOURCE_URL): EditorSnapshot {
  return {
    collection: {
      id: COLLECTION_ID, title: 'Reader collection', kind: 'bookmarks', summary: '',
      visibility: 'private', allowSearchIndexing: false, rootNodeId: 'root', publicationSlug: 'reader-notes',
      publishedAt: null, revision: 'c1', etag: '"c1"', contentRevision: 'cc1', contentEtag: '"cc1"',
      policyRevision: 'p1', policyEtag: '"p1"', createdAt: '', updatedAt: '',
    },
    root: {
      id: 'root', collectionId: COLLECTION_ID, kind: 'folder', folderRole: 'root', parentId: null,
      position: null, title: 'Root', description: null, tags: [], visibility: 'inherit', revision: 'rr',
      etag: '"rr"', readOnly: false, readOnlyReason: null, childrenRevision: 'cr', childrenEtag: '"cr"',
      createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
    },
    nodes: [{
      id: NODE_ID, collectionId: COLLECTION_ID, kind: 'bookmark', title: '3Blue1Brown · 神经网络可视化',
      url, description: 'Course entry', tags: ['youtube'],
      visibility: 'inherit', revision: 'n1', etag: '"n1"', parentId: 'root', position: 'a',
      readOnly: false, readOnlyReason: null, createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    }],
    capabilities: {
      updateCollection: true, managePublication: true, createNode: true,
      updateNode: true, moveNode: true, deleteNode: true,
    },
    page: {
      snapshotId: 's', contentRevision: 'cc1', policyRevision: 'p1', comparatorVersion: 'v1',
      expiresAt: '', returnedCount: 1, hasMore: false, nextCursor: null,
    },
  } as EditorSnapshot
}

/* A published board carrying the same bookmark: the route a signed-out or
   collection-less visit resolves through. */
export function publicSnapshot(url = SOURCE_URL) {
  return {
    collection: {
      id: COLLECTION_ID,
      slug: 'reader-notes',
      title: 'Reader collection',
      summary: 'Public notes.',
      kind: 'bookmarks',
      rootNodeId: 'root',
      owner: { profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'lin', displayName: 'Lin Yichen', avatarUrl: null },
      updatedAt: '2026-07-24T12:00:00.000Z',
      access: 'public',
    },
    nodes: [
      { id: 'root', parentId: null, kind: 'root', title: 'Published contents', description: null, url: null, position: null },
      { id: NODE_ID, parentId: 'root', kind: 'bookmark', title: '3Blue1Brown · 神经网络可视化', description: 'Course entry', url, position: '00000000000000000000' },
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

