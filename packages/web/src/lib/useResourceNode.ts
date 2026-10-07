import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  isProductApiError,
  productClient,
  type EditorSnapshot,
  type PublicCollectionSnapshot,
} from '../api'
import { isReadableReplicaExposureEnabled } from '../api/featureFlags'
import { useAuth } from '../auth/AuthContext'
import { readRouteCache, writeRouteCache } from './routeCache'
import { hostForUrl, safeExternalUrl } from './publicCollectionTree'
import type { CollectionKind } from '../api'

export type ResourceWorkspaceQuery = {
  collectionId?: string | null
  subjectType?: string | null
  slug?: string | null
  fromGraph?: boolean
}

export type ResolvedResourceNode = {
  kind?: 'root' | 'folder'
  id: string
  title: string
  description: string | null
  url: string | null
  iconUrl: string | null
  host: string
  tags: string[]
  /** Whether this node may fall back to the third-party favicon CDN. Only
      public projections open it; editor snapshots are private (R15-07). */
  faviconCdnAllowed: boolean
}

export type ResourceNodeLoad =
  | { status: 'loading' }
  | {
      status: 'ready'
      node: ResolvedResourceNode
      collectionTitle: string
      collectionId: string
      collectionKind: CollectionKind
      publicationSlug: string | null
      previous: ResolvedResourceNode | null
      next: ResolvedResourceNode | null
    }
  | { status: 'folder'; title: string }
  | { status: 'auth-required' }
  | { status: 'unavailable' }
  | { status: 'needs-collection' }
  | { status: 'error'; message: string }

export function resourceWorkspaceQuery(query: ResourceWorkspaceQuery): string {
  const params = new URLSearchParams()
  const collectionId = query.collectionId?.trim()
  const subjectType = query.subjectType?.trim()
  const slug = query.slug?.trim()
  if (collectionId) params.set('collectionId', collectionId)
  if (subjectType) params.set('subjectType', subjectType)
  if (slug) params.set('slug', slug)
  if (query.fromGraph && slug) params.set('fromGraph', '1')
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

function nodeCacheKey(nodeId: string, collectionId: string, slug: string, allowContainers = false) {
  return `resource-node:${collectionId || slug}:${nodeId}${allowContainers ? ':containers' : ''}`
}

function restoredNode(nodeId: string, collectionId: string, slug: string, allowContainers = false): ResourceNodeLoad {
  if (!nodeId.trim() || (!collectionId && !slug)) return { status: 'loading' }
  return readRouteCache<ResourceNodeLoad>(nodeCacheKey(nodeId, collectionId, slug, allowContainers)) ?? { status: 'loading' }
}

export function resourceDetailPath(
  nodeId: string,
  query: ResourceWorkspaceQuery,
): string {
  return `/r/${encodeURIComponent(nodeId)}${resourceWorkspaceQuery(query)}`
}

/**
 * Where a resource page's back control leads. The desk context (collectionId)
 * wins over the public board — desk links carry both when the collection is
 * published, and the desk is where that visitor came from. A slug-only visit
 * from a reading path returns to the path, not the board. Before the snapshot
 * resolves (loading/error shells) the kind is unknown, so a slug falls back
 * to the board.
 */
export function resourceBackPath(
  query: { collectionId?: string | null; slug?: string | null },
  ready?: { collectionKind: CollectionKind; publicationSlug: string | null },
): string {
  const collectionId = query.collectionId?.trim()
  if (collectionId) return `/library/${encodeURIComponent(collectionId)}`
  const slug = ready?.publicationSlug ?? query.slug?.trim() ?? ''
  if (slug) return ready?.collectionKind === 'reading_path' ? `/path/${slug}` : `/c/${slug}`
  return '/library'
}

export function resourceReaderPath(
  nodeId: string,
  query: ResourceWorkspaceQuery,
): string {
  return `/read/${encodeURIComponent(nodeId)}${resourceWorkspaceQuery(query)}`
}

export type ResourcePrimaryTarget =
  | { kind: 'internal'; to: string }
  | { kind: 'external'; href: string }

/**
 * One release gate for every bookmark's primary action. Reader-on restores the
 * in-app reading route. Reader-off opens the source itself and falls back to
 * the durable detail page when the bookmark has no safe HTTP(S) URL.
 */
export function resourcePrimaryTarget(
  nodeId: string,
  url: string | null | undefined,
  query: ResourceWorkspaceQuery,
  readerEnabled = isReadableReplicaExposureEnabled(),
): ResourcePrimaryTarget {
  if (readerEnabled) return { kind: 'internal', to: resourceReaderPath(nodeId, query) }
  const href = safeExternalUrl(url ?? null)
  return href
    ? { kind: 'external', href }
    : { kind: 'internal', to: resourceDetailPath(nodeId, query) }
}

export function resourceNodeEmptyCopy(load: ResourceNodeLoad): {
  title: string
  description: string
  login: boolean
} | null {
  switch (load.status) {
    case 'loading':
    case 'ready':
      return null
    case 'folder':
      return {
        title: 'This is a folder, not a bookmark',
        description: 'Open a bookmark from the collection instead.',
        login: false,
      }
    case 'auth-required':
      return {
        title: 'Sign in to open this resource',
        description: 'This resource is in a collection that needs a signed-in member.',
        login: true,
      }
    case 'unavailable':
      return {
        title: 'Bookmark unavailable',
        description: 'It was not found, has been withdrawn, or is not available to this account.',
        login: false,
      }
    case 'needs-collection':
      return {
        title: 'Open this bookmark from its collection',
        description: 'Bookmarks open from the collection they belong to.',
        login: false,
      }
    case 'error':
      return { title: "Couldn't load this bookmark", description: load.message, login: false }
  }
}

function comparePosition(
  left: { id: string; position: string | null },
  right: { id: string; position: string | null },
): number {
  const leftPosition = left.position ?? ''
  const rightPosition = right.position ?? ''
  if (leftPosition < rightPosition) return -1
  if (leftPosition > rightPosition) return 1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

type ResourceSnapshotNode = {
  kind?: 'bookmark' | 'root' | 'folder'
  id: string
  title: string
  description: string | null
  url?: string | null
  iconUrl?: string | null
  tags?: string[]
  faviconCdnAllowed?: boolean
  position: string | null
}

function toResolved(node: ResourceSnapshotNode, cdnAllowed: boolean): ResolvedResourceNode {
  const url = node.url ?? null
  return {
    ...(node.kind && node.kind !== 'bookmark' ? { kind: node.kind } : {}),
    id: node.id,
    title: node.title,
    description: node.description,
    url,
    iconUrl: node.iconUrl ?? null,
    host: node.kind === 'root' ? 'Collection' : node.kind === 'folder' ? 'Folder' : hostForUrl(url),
    tags: node.tags ?? [],
    faviconCdnAllowed: cdnAllowed && node.faviconCdnAllowed !== false,
  }
}

function neighbors(
  bookmarks: ResourceSnapshotNode[],
  nodeId: string,
  cdnAllowed: boolean,
): { previous: ResolvedResourceNode | null; next: ResolvedResourceNode | null } {
  const ordered = bookmarks.slice().sort(comparePosition)
  const index = ordered.findIndex((node) => node.id === nodeId)
  return {
    previous: index > 0 ? toResolved(ordered[index - 1]!, cdnAllowed) : null,
    next: index >= 0 && index < ordered.length - 1 ? toResolved(ordered[index + 1]!, cdnAllowed) : null,
  }
}

function fromEditor(snapshot: EditorSnapshot, nodeId: string, allowContainers: boolean): ResourceNodeLoad {
  const found = snapshot.nodes.find((node) => node.id === nodeId)
    ?? (snapshot.root.id === nodeId ? snapshot.root : undefined)
  if (!found) return { status: 'unavailable' }
  if (found.kind !== 'bookmark' && !allowContainers) return { status: 'folder', title: found.title }
  const bookmarks = snapshot.nodes.filter((node) => node.kind === 'bookmark')
  return {
    status: 'ready',
    // Editor snapshots are private projections: never hotlink the CDN.
    node: toResolved(found.id === snapshot.collection.rootNodeId ? { ...found, kind: 'root' } : found, false),
    collectionTitle: snapshot.collection.title,
    collectionId: snapshot.collection.id,
    collectionKind: snapshot.collection.kind,
    publicationSlug: snapshot.collection.publicationSlug,
    ...neighbors(bookmarks, nodeId, false),
  }
}

function fromPublic(snapshot: PublicCollectionSnapshot, nodeId: string, allowContainers: boolean): ResourceNodeLoad {
  const found = snapshot.nodes.find((node) => node.id === nodeId)
  if (!found) return { status: 'unavailable' }
  if (found.kind !== 'bookmark' && !allowContainers) return { status: 'folder', title: found.title }
  const bookmarks = snapshot.nodes.filter((node) => node.kind === 'bookmark')
  const cdnAllowed = snapshot.collection.faviconCdnAllowed === true
  return {
    status: 'ready',
    node: toResolved(found.id === snapshot.collection.rootNodeId ? { ...found, kind: 'root' } : found, cdnAllowed),
    collectionTitle: snapshot.collection.title,
    collectionId: snapshot.collection.id,
    collectionKind: snapshot.collection.kind,
    publicationSlug: snapshot.collection.slug,
    ...neighbors(bookmarks, nodeId, cdnAllowed),
  }
}

export function useResourceNode(nodeId: string, allowContainers = false) {
  const [searchParams] = useSearchParams()
  const { isLoggedIn, bootstrapping } = useAuth()
  const collectionId = searchParams.get('collectionId')?.trim() ?? ''
  const slug = searchParams.get('slug')?.trim() ?? ''
  const [load, setLoad] = useState<ResourceNodeLoad>(() => restoredNode(nodeId, collectionId, slug, allowContainers))

  useEffect(() => {
    if (!nodeId.trim()) {
      setLoad({ status: 'needs-collection' })
      return
    }
    const canLoadEditor = Boolean(collectionId) && (isLoggedIn || bootstrapping)
    const canLoadPublic = Boolean(slug)
    if (!canLoadEditor && !canLoadPublic) {
      setLoad(collectionId ? { status: 'auth-required' } : { status: 'needs-collection' })
      return
    }

    const controller = new AbortController()
    // Paint the resolved node we already have and revalidate behind it, so
    // opening the reader and coming back does not replay "Loading resource".
    const cached = restoredNode(nodeId, collectionId, slug, allowContainers)
    setLoad(cached)
    const revalidating = cached.status === 'ready'
    void (async () => {
      try {
        if (canLoadEditor) {
          const snapshot = await productClient.loadEditorSnapshot(collectionId, {
            signal: controller.signal,
            maxRetries: 0,
          })
          if (controller.signal.aborted) return
          const next = fromEditor(snapshot, nodeId, allowContainers)
          if (next.status === 'ready') writeRouteCache(nodeCacheKey(nodeId, collectionId, slug, allowContainers), next)
          setLoad(next)
          return
        }
        const snapshot = await productClient.loadPublicCollectionSnapshot(slug, {
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        const next = fromPublic(snapshot, nodeId, allowContainers)
        if (next.status === 'ready') writeRouteCache(nodeCacheKey(nodeId, collectionId, slug, allowContainers), next)
        setLoad(next)
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
        if (isProductApiError(error) && error.isAuthRequired) {
          setLoad({ status: 'auth-required' })
          return
        }
        if (
          isProductApiError(error)
          && (error.status === 403 || error.status === 404 || error.code === 'resource_not_found')
        ) {
          setLoad({ status: 'unavailable' })
          return
        }
        // A failed revalidation keeps the node already on screen.
        if (revalidating) return
        setLoad({
          status: 'error',
          message: isProductApiError(error)
            ? error.recoveryHint
            : 'Check your connection and try again.',
        })
      }
    })()

    return () => controller.abort()
  }, [bootstrapping, collectionId, isLoggedIn, nodeId, slug, allowContainers])

  return load
}
