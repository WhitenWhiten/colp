import { clearCommandId } from './commandId'
import { shouldRestartCursor } from './editor-session'
import { ProductApiError, wrapProductError, parseProductError } from './errors'
import {
  invalidAnnotationCursor,
  withSameRequestRetry,
  type MutationCall,
  type MutationOptions,
  type ReadOptions,
} from './product-client-shared'
import type { ProductTransport } from './product-transport-types'
import type {
  AnnotationMergePatch,
  AnnotationPage,
  AnnotationSubject,
  AnnotationView,
  BookmarkNodeView,
  CollectionChildrenPage,
  CollectionChildrenSort,
  CollectionKind,
  CollectionMergePatch,
  CollectionVisibility,
  CreateAnnotationRequest,
  CreateCollectionRequest,
  CreateCollectionResult,
  CreateNodeRequest,
  CreateNodeResult,
  CreateRelationRequest,
  DeleteAnnotationResult,
  DeleteNodeResult,
  DeleteRelationResult,
  EditorPage,
  EditorSnapshot,
  MoveNodeRequest,
  MoveNodeResult,
  NodeMergePatch,
  OwnedCollectionListItem,
  OwnedCollectionPage,
  RelationDirection,
  RelationMergePatch,
  RelationPage,
  RelationView,
  UpdateCollectionResult,
  UpdateNodeResult,
} from './types'

const DEFAULT_EDITOR_LIMIT = 200

/**
 * Legal tree capacity is SNAPSHOT_TREE_CAPACITY
 * (Known-Backend/src/modules/collections/domain/snapshot-tree-capacity.ts):
 * 10_000 live nodes, including the root, and 2 MiB of canonical snapshot JSON.
 * Editor pages omit the root from `nodes` and can return one node per page
 * (caller limit 1, or the 4 MiB EDITOR_PAGE_MAX_BYTES cut in get-editor-page.ts).
 * A legal walk is therefore at most 10_000 pages.
 *
 * Byte ceiling: a limit-1 walk repeats the collection shell on every page.
 * Under the write-path caps (title 1_024 bytes, description 16_384 bytes,
 * 64 tags, icon and preview URLs of 2_048 bytes, cursor of 2_048 bytes) the
 * fullest shell still leaves room for 8_943 minimum bookmarks inside 2 MiB,
 * and each editor page is 43_192 bytes: 386_266_056 bytes, about 368 MiB.
 * 512 MiB also covers a 20_000-character description (417_855_016 bytes,
 * about 398 MiB) and JSON escaping. It is not a tighter cap than a legal
 * tree's editor JSON.
 */
export const EDITOR_SNAPSHOT_MAX_NODES = 10_000
export const EDITOR_SNAPSHOT_MAX_PAGES = 10_000
export const EDITOR_SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024

const editorSnapshotEncoder = new TextEncoder()

function editorBudgetLimit(override: number | undefined, legal: number): number {
  if (override === undefined || !Number.isSafeInteger(override) || override < 1) return legal
  return Math.min(override, legal)
}

function invalidEditorPage(message: string): ProductApiError {
  return new ProductApiError({
    status: 400,
    code: 'invalid_cursor',
    message,
    recovery: 'restart_from_first_page',
    sameRequestRetrySafe: false,
  })
}

function editorBudgetExceeded(message: string): ProductApiError {
  return new ProductApiError({
    status: 400,
    code: 'payload_too_large',
    message,
    recovery: 'user_action',
    sameRequestRetrySafe: false,
  })
}

function throwIfEditorAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(',')}}`
}

function editorPageUtf8Bytes(page: EditorPage): number {
  return editorSnapshotEncoder.encode(JSON.stringify(page)).length
}

function editorNodeId(node: unknown): string | null {
  if (!node || typeof node !== 'object' || !('id' in node)) return null
  const id = (node as { id: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

type LooseEditorPage = {
  collection?: unknown
  root?: unknown
  nodes?: unknown
  capabilities?: unknown
  page?: {
    snapshotId?: unknown
    contentRevision?: unknown
    policyRevision?: unknown
    comparatorVersion?: unknown
    expiresAt?: unknown
    returnedCount?: unknown
    hasMore?: unknown
    nextCursor?: unknown
  } | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function editorPageStateIsUsable(state: Record<string, unknown>, nodeCount: number): boolean {
  const returnedCount = state.returnedCount
  return typeof state.snapshotId === 'string' && state.snapshotId.length > 0
    && state.contentRevision !== undefined && state.contentRevision !== null
    && state.policyRevision !== undefined && state.policyRevision !== null
    && typeof state.comparatorVersion === 'string' && state.comparatorVersion.length > 0
    && typeof state.expiresAt === 'string' && state.expiresAt.length > 0
    && typeof state.hasMore === 'boolean'
    && typeof returnedCount === 'number'
    && Number.isInteger(returnedCount)
    && returnedCount === nodeCount
}

/** Reject a page that cannot be one step of a complete editor tree. */
function assertEditorPageShape(page: EditorPage): void {
  // The transport types this as EditorPage, but it is parsed JSON.
  const loose = page as LooseEditorPage
  const nodes = loose.nodes
  const state = isRecord(loose.page) ? loose.page : null
  if (
    !isRecord(loose.collection)
    || !isRecord(loose.root)
    || !isRecord(loose.capabilities)
    || !Array.isArray(nodes)
    || state === null
    || !editorPageStateIsUsable(state, nodes.length)
  ) {
    throw invalidEditorPage('Editor pagination returned an abnormal page.')
  }
  const hasMore = state.hasMore === true
  if (hasMore && nodes.length === 0) {
    throw invalidEditorPage('Editor pagination returned an empty page with hasMore set.')
  }
  const nextCursor = state.nextCursor
  const cursorIsConsistent = hasMore
    ? typeof nextCursor === 'string' && nextCursor.length > 0
    : nextCursor === null
  if (!cursorIsConsistent) {
    throw invalidEditorPage('Editor pagination returned an inconsistent continuation.')
  }
}

function editorPageIdentity(page: EditorPage): string {
  return stableJson({
    snapshotId: page.page.snapshotId,
    contentRevision: page.page.contentRevision,
    policyRevision: page.page.policyRevision,
    collection: page.collection,
    root: page.root,
    capabilities: page.capabilities,
  })
}

/**
 * Assemble pages into one tree. Throws instead of returning when the walk
 * cannot be a complete snapshot. `maxPages` / `maxNodes` / `maxBytes` are
 * already clamped to the legal ceiling.
 */
async function assembleEditorPages(
  first: EditorPage,
  fetchNext: (cursor: string) => Promise<EditorPage>,
  signal: AbortSignal | undefined,
  budget: { maxPages: number; maxNodes: number; maxBytes: number },
): Promise<EditorSnapshot> {
  const nodes: EditorPage['nodes'][number][] = []
  const seenNodeIds = new Set<string>()
  const seenCursors = new Set<string>()
  let current = first
  let identity: string | null = null
  let pages = 0
  let bytes = 0

  for (;;) {
    throwIfEditorAborted(signal)
    assertEditorPageShape(current)
    const nextIdentity = editorPageIdentity(current)
    if (identity === null) identity = nextIdentity
    else if (nextIdentity !== identity) {
      throw invalidEditorPage('Editor pagination changed snapshot.')
    }

    const pageNodeIds = new Set<string>()
    for (const node of current.nodes) {
      const id = editorNodeId(node)
      if (id === null) throw invalidEditorPage('Editor pagination returned an abnormal page.')
      if (seenNodeIds.has(id) || pageNodeIds.has(id)) {
        throw invalidEditorPage('Editor pagination returned an overlapping node.')
      }
      pageNodeIds.add(id)
    }

    const pageBytes = editorPageUtf8Bytes(current)
    if (bytes + pageBytes > budget.maxBytes) {
      throw editorBudgetExceeded('Editor snapshot exceeds the byte budget. The partial tree was not returned.')
    }
    if (nodes.length + current.nodes.length > budget.maxNodes) {
      throw editorBudgetExceeded('Editor snapshot exceeds the node budget. The partial tree was not returned.')
    }
    if (pages + 1 > budget.maxPages) {
      throw editorBudgetExceeded('Editor snapshot exceeds the page budget. The partial tree was not returned.')
    }

    pages += 1
    bytes += pageBytes
    for (const id of pageNodeIds) seenNodeIds.add(id)
    nodes.push(...current.nodes)
    if (!current.page.hasMore) {
      throwIfEditorAborted(signal)
      return {
        collection: current.collection,
        root: current.root,
        nodes,
        capabilities: current.capabilities,
        page: current.page,
      }
    }

    // Another page cannot fit. Fail before requesting it, and do not publish
    // the nodes already held.
    if (pages >= budget.maxPages) {
      throw editorBudgetExceeded('Editor snapshot exceeds the page budget. The partial tree was not returned.')
    }
    if (nodes.length >= budget.maxNodes) {
      throw editorBudgetExceeded('Editor snapshot exceeds the node budget. The partial tree was not returned.')
    }
    const cursor = current.page.nextCursor
    if (typeof cursor !== 'string' || cursor.length === 0 || seenCursors.has(cursor)) {
      throw invalidEditorPage('Editor pagination returned a repeated cursor.')
    }
    seenCursors.add(cursor)
    current = await fetchNext(cursor)
  }
}

export type OwnedCollectionQuery = {
  kind?: CollectionKind
  visibility?: CollectionVisibility
  limit?: number
}

export type CollectionChildrenQuery = {
  parentId?: string
  sort?: CollectionChildrenSort
  limit?: number
}

type AnnotationSubjectQuery = {
  resourceType: AnnotationSubject['type']
  resourceId: string
}

type RelationQuery = { nodeId: string; direction: RelationDirection }

export function createProductCollectionsClient(
  transport: ProductTransport,
  mutationCall: MutationCall,
) {
  async function getOwnedCollectionsPage(
    query: OwnedCollectionQuery & { cursor?: string } = {}, options?: ReadOptions,
  ): Promise<OwnedCollectionPage> {
    return withSameRequestRetry(async () => {
      try { return await transport.listOwnedCollections({ ...query, signal: options?.signal }) }
      catch (error) { throw wrapProductError(error) }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function loadOwnedCollections(
    query: OwnedCollectionQuery = {}, options?: ReadOptions,
  ): Promise<OwnedCollectionListItem[]> {
    const items: OwnedCollectionListItem[] = []
    const cursors = new Set<string>()
    let page = await getOwnedCollectionsPage(query, options)
    for (;;) {
      items.push(...page.items)
      if (!page.page.hasMore) return items
      const cursor = page.page.nextCursor
      if (!cursor || cursors.has(cursor)) throw new ProductApiError({
        status: 400, code: 'invalid_cursor',
        message: 'Owned Collection pagination returned an invalid continuation.',
        recovery: 'restart_from_first_page', sameRequestRetrySafe: false,
      })
      cursors.add(cursor)
      page = await getOwnedCollectionsPage({ cursor }, options)
    }
  }

  async function createCollection(
    body: CreateCollectionRequest,
    options: MutationOptions,
  ): Promise<CreateCollectionResult> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.createCollection(body, {
          commandIntentId,
          csrfToken: csrf,
          signal: options.signal,
        }),
      options,
    )
  }

  async function updateCollection(
    collectionId: string,
    body: CollectionMergePatch,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<UpdateCollectionResult> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.updateCollection(collectionId, body, {
          commandIntentId,
          csrfToken: csrf,
          ifMatch,
          signal: options.signal,
        }),
      options,
    )
  }

  async function getCollectionEditorPage(
    collectionId: string,
    params?: { limit?: number; cursor?: string },
    options?: ReadOptions,
  ): Promise<EditorPage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getEditorPage(collectionId, {
          ...params,
          signal: options?.signal,
        })
      } catch (err) {
        throw wrapProductError(err)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  /**
   * Load the full editor tree. A repeated cursor, an empty hasMore page, an
   * abnormal page, or the tree budget fails the walk. The partial nodes are
   * discarded. snapshot_expired and invalid_cursor restart from the first
   * page up to maxSnapshotRestarts. Budget exhaustion does not restart and
   * is not returned as a complete EditorSnapshot.
   */
  async function loadEditorSnapshot(
    collectionId: string,
    options?: ReadOptions & {
      limit?: number
      maxSnapshotRestarts?: number
      /**
       * Optional ceilings for tests. Values below the legal tree budget are
       * honored; values above it are ignored so a caller cannot raise the cap.
       */
      maxPages?: number
      maxBytes?: number
      onCursorRestart?: (event: {
        reason: 'snapshot_expired' | 'invalid_cursor'
        attempt: number
      }) => void
    },
  ): Promise<EditorSnapshot> {
    const limit = options?.limit ?? DEFAULT_EDITOR_LIMIT
    const maxRestarts = options?.maxSnapshotRestarts ?? 3
    const maxPages = editorBudgetLimit(options?.maxPages, EDITOR_SNAPSHOT_MAX_PAGES)
    const maxNodes = EDITOR_SNAPSHOT_MAX_NODES
    const maxBytes = editorBudgetLimit(options?.maxBytes, EDITOR_SNAPSHOT_MAX_BYTES)
    let restarts = 0

    for (;;) {
      try {
        throwIfEditorAborted(options?.signal)
        const first = await getCollectionEditorPage(collectionId, { limit }, options)
        const snapshot = await assembleEditorPages(first, async (cursor) => {
          throwIfEditorAborted(options?.signal)
          return getCollectionEditorPage(collectionId, { cursor }, options)
        }, options?.signal, { maxPages, maxNodes, maxBytes })
        throwIfEditorAborted(options?.signal)
        return snapshot
      } catch (err) {
        if (isAbortError(err)) throw err
        const apiErr = wrapProductError(err)
        if (shouldRestartCursor(apiErr) && restarts < maxRestarts) {
          restarts += 1
          options?.onCursorRestart?.({
            reason: apiErr.code as 'snapshot_expired' | 'invalid_cursor',
            attempt: restarts,
          })
          continue
        }
        throw apiErr
      }
    }
  }

  async function getAnnotationPage(
    collectionId: string,
    subject: AnnotationSubjectQuery,
    params?: { limit?: number; cursor?: string },
    options?: ReadOptions,
  ): Promise<AnnotationPage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.listAnnotations(collectionId, {
          ...subject,
          ...params,
          signal: options?.signal,
        })
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function loadAnnotations(
    collectionId: string,
    subject: AnnotationSubjectQuery,
    options?: ReadOptions & { limit?: number; maxCursorRestarts?: number },
  ): Promise<AnnotationView[]> {
    const limit = options?.limit ?? 100
    const maxRestarts = options?.maxCursorRestarts ?? 2
    let restarts = 0
    for (;;) {
      try {
        const annotations: AnnotationView[] = []
        const ids = new Set<string>()
        const cursors = new Set<string>()
        let page = await getAnnotationPage(collectionId, subject, { limit }, options)
        for (;;) {
          for (const annotation of page.annotations) {
            if (ids.has(annotation.id)) throw invalidAnnotationCursor('Annotation pagination overlapped an item.')
            ids.add(annotation.id)
            annotations.push(annotation)
          }
          if (!page.page.hasMore) {
            if (page.page.nextCursor !== null) throw invalidAnnotationCursor('Final Annotation page returned a cursor.')
            return annotations
          }
          const cursor = page.page.nextCursor
          if (!cursor || cursors.has(cursor)) throw invalidAnnotationCursor('Annotation pagination returned an invalid continuation.')
          cursors.add(cursor)
          page = await getAnnotationPage(collectionId, subject, { cursor }, options)
        }
      } catch (error) {
        const apiError = wrapProductError(error)
        if (shouldRestartCursor(apiError) && restarts < maxRestarts) {
          restarts += 1
          continue
        }
        throw apiError
      }
    }
  }

  async function getAnnotation(
    collectionId: string,
    annotationId: string,
    options?: ReadOptions,
  ): Promise<AnnotationView> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getAnnotation(collectionId, annotationId, options?.signal)
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  function annotationMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  async function createAnnotation(
    collectionId: string,
    subject: AnnotationSubjectQuery,
    body: CreateAnnotationRequest,
    options: MutationOptions,
  ): Promise<AnnotationView> {
    return mutationCall(
      (csrf, commandIntentId) => transport.createAnnotation(collectionId, subject, body, {
        commandIntentId, csrfToken: csrf, signal: options.signal,
      }),
      annotationMutationOptions(options),
    )
  }

  async function updateAnnotation(
    collectionId: string,
    annotationId: string,
    body: AnnotationMergePatch,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<AnnotationView> {
    return mutationCall(
      (csrf, commandIntentId) => transport.updateAnnotation(collectionId, annotationId, body, {
        commandIntentId, csrfToken: csrf, ifMatch, signal: options.signal,
      }),
      annotationMutationOptions(options),
    )
  }

  async function deleteAnnotation(
    collectionId: string,
    annotationId: string,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<DeleteAnnotationResult> {
    return mutationCall(
      (csrf, commandIntentId) => transport.deleteAnnotation(collectionId, annotationId, {
        commandIntentId, csrfToken: csrf, ifMatch, signal: options.signal,
      }),
      annotationMutationOptions(options),
    )
  }

  function abandonAnnotationIntent(intentId: string): void {
    clearCommandId(intentId)
  }

  async function getRelationPage(collectionId: string, query: RelationQuery, params?: { limit?: number; cursor?: string }, options?: ReadOptions): Promise<RelationPage> {
    return withSameRequestRetry(async () => {
      try { return await transport.listRelations(collectionId, { ...query, ...params, signal: options?.signal }) }
      catch (error) { throw wrapProductError(error) }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function loadRelations(collectionId: string, query: RelationQuery, options?: ReadOptions & { limit?: number; maxCursorRestarts?: number }): Promise<RelationView[]> {
    const limit = options?.limit ?? 100
    const maxRestarts = options?.maxCursorRestarts ?? 2
    let restarts = 0
    for (;;) {
      try {
        const result: RelationView[] = []; const ids = new Set<string>(); const cursors = new Set<string>()
        let page = await getRelationPage(collectionId, query, { limit }, options)
        for (;;) {
          for (const item of page.relations) {
            if (ids.has(item.id)) throw invalidAnnotationCursor('Relation pagination overlapped an item.')
            ids.add(item.id); result.push(item)
          }
          if (!page.page.hasMore) return result
          const cursor = page.page.nextCursor
          if (!cursor || cursors.has(cursor)) throw invalidAnnotationCursor('Relation pagination returned an invalid continuation.')
          cursors.add(cursor); page = await getRelationPage(collectionId, query, { cursor }, options)
        }
      } catch (error) {
        const apiError = wrapProductError(error)
        if (shouldRestartCursor(apiError) && restarts < maxRestarts) { restarts += 1; continue }
        throw apiError
      }
    }
  }

  async function getRelation(collectionId: string, relationId: string, options?: ReadOptions): Promise<RelationView> {
    return withSameRequestRetry(async () => {
      try { return await transport.getRelation(collectionId, relationId, options?.signal) }
      catch (error) { throw wrapProductError(error) }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  const relationMutationOptions = (options: MutationOptions): MutationOptions => ({ ...options, rotateCommandOnConflict: false })
  async function createRelation(collectionId: string, body: CreateRelationRequest, options: MutationOptions): Promise<RelationView> {
    return mutationCall((csrf, commandIntentId) => transport.createRelation(collectionId, body, { commandIntentId, csrfToken: csrf, signal: options.signal }), relationMutationOptions(options))
  }
  async function updateRelation(collectionId: string, relationId: string, body: RelationMergePatch, ifMatch: string, options: MutationOptions): Promise<RelationView> {
    return mutationCall((csrf, commandIntentId) => transport.updateRelation(collectionId, relationId, body, { commandIntentId, csrfToken: csrf, ifMatch, signal: options.signal }), relationMutationOptions(options))
  }
  async function deleteRelation(collectionId: string, relationId: string, ifMatch: string, options: MutationOptions): Promise<DeleteRelationResult> {
    return mutationCall((csrf, commandIntentId) => transport.deleteRelation(collectionId, relationId, { commandIntentId, csrfToken: csrf, ifMatch, signal: options.signal }), relationMutationOptions(options))
  }
  function abandonRelationIntent(intentId: string): void { clearCommandId(intentId) }

  async function createCollectionNode(
    collectionId: string,
    body: CreateNodeRequest,
    options: MutationOptions,
  ): Promise<CreateNodeResult> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.createNode(collectionId, body, {
          commandIntentId,
          csrfToken: csrf,
          signal: options.signal,
        }),
      options,
    )
  }

  async function updateCollectionNode(
    collectionId: string,
    nodeId: string,
    body: NodeMergePatch,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<UpdateNodeResult> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.updateNode(collectionId, nodeId, body, {
          commandIntentId,
          csrfToken: csrf,
          ifMatch,
          signal: options.signal,
        }),
      options,
    )
  }

  async function moveCollectionNode(
    collectionId: string,
    nodeId: string,
    body: MoveNodeRequest,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<MoveNodeResult> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.moveNode(collectionId, nodeId, body, {
          commandIntentId,
          csrfToken: csrf,
          ifMatch,
          signal: options.signal,
        }),
      options,
    )
  }

  async function deleteCollectionNode(
    collectionId: string,
    nodeId: string,
    ifMatch: string,
    options: MutationOptions & {
      recursive?: boolean
      ifContentMatch?: string
    },
  ): Promise<DeleteNodeResult | void> {
    const recursive = options.recursive === true
    if (recursive && !options.ifContentMatch) {
      throw new ProductApiError(
        parseProductError(
          428,
          {
            error: {
              code: 'precondition_required',
              message:
                'Recursive folder delete requires If-Content-Match (collection contentEtag).',
              recovery: 'user_action',
              sameRequestRetrySafe: false,
            },
          },
          {},
        ),
      )
    }
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.deleteNode(collectionId, nodeId, {
          commandIntentId,
          csrfToken: csrf,
          ifMatch,
          recursive,
          ifContentMatch: recursive ? options.ifContentMatch : undefined,
          signal: options.signal,
        }),
      options,
    )
  }

  function bookmarkFaviconMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  async function uploadBookmarkFavicon(
    collectionId: string,
    nodeId: string,
    file: File,
    options: MutationOptions,
  ): Promise<BookmarkNodeView> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.uploadBookmarkFavicon(collectionId, nodeId, file, {
          commandIntentId,
          csrfToken: csrf,
          signal: options.signal,
        }),
      bookmarkFaviconMutationOptions(options),
    )
  }

  async function deleteBookmarkFavicon(
    collectionId: string,
    nodeId: string,
    options: MutationOptions,
  ): Promise<BookmarkNodeView> {
    return mutationCall(
      (csrf, commandIntentId) =>
        transport.deleteBookmarkFavicon(collectionId, nodeId, {
          commandIntentId,
          csrfToken: csrf,
          signal: options.signal,
        }),
      bookmarkFaviconMutationOptions(options),
    )
  }

  async function getCollectionChildrenPage(
    collectionId: string,
    query: CollectionChildrenQuery & { cursor?: string; signal?: AbortSignal } = {}, options?: ReadOptions,
  ): Promise<CollectionChildrenPage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.listCollectionChildren(collectionId, { ...query, signal: query.signal ?? options?.signal })
      } catch (error) { throw wrapProductError(error) }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  return {
    getOwnedCollectionsPage,
    loadOwnedCollections,
    listCollectionChildren: getCollectionChildrenPage,
    createCollection,
    updateCollection,
    getCollectionEditorPage,
    loadEditorSnapshot,
    getAnnotationPage,
    loadAnnotations,
    getAnnotation,
    createAnnotation,
    updateAnnotation,
    deleteAnnotation,
    abandonAnnotationIntent,
    getRelationPage,
    loadRelations,
    getRelation,
    createRelation,
    updateRelation,
    deleteRelation,
    abandonRelationIntent,
    createCollectionNode,
    updateCollectionNode,
    moveCollectionNode,
    deleteCollectionNode,
    uploadBookmarkFavicon,
    deleteBookmarkFavicon,
  }
}
