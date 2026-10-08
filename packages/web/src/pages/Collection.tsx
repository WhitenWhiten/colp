import { SubscribeButton } from '../components/bookmark-subscriptions/SubscribeButton'
import { CollectionExportMenu } from '../components/CollectionExportMenu'
import { CollectionTransportNotice, SubscribeInBrowserButton } from '../components/TransportBanner'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  isCollectionFollowExposureEnabled,
  isCommunityExposureEnabled,
  isLive,
  isProductApiError,
  productClient,
} from '../api'
import type {
  CollectionChildrenItem,
  CollectionChildrenSort,
  PublicCollectionNode,
} from '../api'
import { useAuth } from '../auth/AuthContext'
import { Breadcrumb } from '../components/Breadcrumb'
import { CollectionFollowButton } from '../components/CollectionFollowButton'
import { CommunityVoteControl } from '../components/CommunityVoteControl'
import { SocialActions } from '../components/SocialActions'
import { CommunityComments } from '../components/CommunityComments'
import { ReportButton } from '../components/ReportContentDialog'
import { ABSENCE_CORNERS, AbsenceStage } from '../components/AbsenceStage'
import { EmptyState } from '../components/EmptyState'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { AvatarImage } from '../components/AvatarImage'
import { ClampedText } from '../components/ClampedText'
import { CollectionSkeleton, CollectionSkeletonBoard } from '../components/CollectionSkeleton'
import { FilterRail } from '../components/FilterRail'
import { FolderTrail } from '../components/FolderTrail'
import { Icon, type IconName } from '../components/Icon'
import { Modal } from '../components/Modal'
import { ProfileHoverCard } from '../components/ProfileHoverCard'
import { BOOKMARK_FILTER_PLACEHOLDER } from '../lib/searchCopy'
import { observePreview, recordView } from '../lib/recordCollectionInsight'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { usePublicCollectionSnapshot } from '../lib/usePublicCollectionSnapshot'
import { plural, pluralNoun } from '../lib/plural'
import { CollectionFigures } from './collection/figures'
import { usePageMeta, collectionOgImagePath } from '../lib/usePageMeta'
import { useStuckToolbar } from '../lib/useStuckToolbar'
import { publicCollectionDescription } from '../lib/publicCollectionMeta'
import {
  flattenPublicCollection,
  folderAncestors,
  folderPreviews,
  folderTotals,
  hostForUrl,
  immediateEntries,
  safeExternalUrl,
  type PublicCollectionFolderEntry,
  type PublicCollectionResource as CollectionResource,
} from '../lib/publicCollectionTree'
import {
  curatorInitials,
  formatCompactCount,
  formatUpdatedAt,
  isViewMode,
  kindLabel,
  loadView,
  saveView,
  type ViewMode,
} from './collection/format'
import { CollectionResources, SaveResourcePicker } from './collection/resources'
import { CollectionFolderLayer, CollectionOutline, CollectionSection } from './collection/outline'
import { EmbedShareButton } from './share/EmbedShareButton'
import '../styles/library.css'
import '../styles/not-found.css'
import '../styles/share.css'

/* Beside bookmarks, up to this many folders open into preview cards (one
   board row at desktop widths); more keep the compact folder tabs. */
const RICH_FOLDER_LIMIT = 4

const VIEW_ICONS: Record<ViewMode, IconName> = {
  board: 'grid',
  gallery: 'masonry',
  list: 'rows',
  compact: 'rows-dense',
}

export function Collection() {
  const { slug = '' } = useParams<{ slug: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { bootstrapping, isLoggedIn } = useAuth()
  const { load, retry } = usePublicCollectionSnapshot(slug)
  const content = useMemo(
    () => load.status === 'ready' ? flattenPublicCollection(load.snapshot) : null,
    [load],
  )
  /* Subtree totals per folder: the Contents counts, folder cards and the
     in-folder head all read the same numbers. */
  const totals = useMemo(
    () => folderTotals(content?.folders ?? [], content?.resources ?? []),
    [content],
  )
  const [followerCount, setFollowerCount] = useState<number | null>(null)
  /* R7-07: the bookmark a signed-in visitor is filing into their library. */
  const [saveTarget, setSaveTarget] = useState<CollectionResource | null>(null)
  /* Below 900px the Contents tree opens as a sheet instead of a sidebar. */
  const [contentsOpen, setContentsOpen] = useState(false)
  const contentsDialogId = useId()
  const readyCollectionId = load.status === 'ready' ? load.snapshot.collection.id : ''

  useEffect(() => {
    setFollowerCount(null)
  }, [readyCollectionId])
  const urlView = searchParams.get('view')
  const view: ViewMode = isViewMode(urlView) ? urlView : loadView(slug)
  const query = searchParams.get('q') ?? ''
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const folderId = searchParams.get('folder') ?? ''
  /* FO-05 time sorts: curated is the default (no param); created sorts render
     the current folder layer from GET /api/v1/collections/{id}/children. */
  const urlSort = searchParams.get('sort')
  const sort: CollectionChildrenSort =
    urlSort === 'created_asc' || urlSort === 'created_desc' || urlSort === 'curated' ? urlSort : 'curated'
  const sortExposed = isLive('faviconPolicy')
  const documentTitle =
    load.status === 'ready'
      ? load.snapshot.collection.title
      : load.status === 'unavailable'
        ? 'Collection unavailable'
        : load.status === 'error'
          ? 'Collection error'
          : 'Collection'
  useDocumentTitle(documentTitle)
  const readyCollection = load.status === 'ready' ? load.snapshot.collection : null
  usePageMeta(
    // R15-22: a transient error (429, 503) leaves the head alone; only an
    // unavailable or missing page is noindexed.
    load.status === 'loading' || load.status === 'error'
      ? {}
      : readyCollection && content
        ? {
            description: publicCollectionDescription(readyCollection),
            canonicalPath: `/c/${encodeURIComponent(readyCollection.slug)}`,
            ogImagePath: collectionOgImagePath(readyCollection.slug, readyCollection.updatedAt),
          }
        : { canonicalPath: null, robots: 'noindex' },
    `${documentTitle} — Know-N`,
  )

  /* react-router hands back a new setSearchParams on every URL change. The
     sorted-layer fetch effect depends on patchParams, so an unstable identity
     re-ran it — and flashed "Sorting bookmarks…" plus a skeleton, dropping any
     loaded pages — whenever view or q changed. Read it through a ref so
     patchParams only changes with the slug. */
  const setSearchParamsRef = useRef(setSearchParams)
  setSearchParamsRef.current = setSearchParams
  const patchParams = useCallback((patch: {
    view?: ViewMode; q?: string; folder?: string; sort?: CollectionChildrenSort;
  }) => {
    if (patch.view !== undefined) saveView(slug, patch.view)
    setSearchParamsRef.current((prev) => {
      const next = new URLSearchParams(prev)
      if (patch.view !== undefined) {
        // Board is the default: omit it from the URL. Persist first so that
        // falling back to localStorage does not restore list/compact.
        if (patch.view === 'board') next.delete('view')
        else next.set('view', patch.view)
      }
      if (patch.q !== undefined) {
        if (!patch.q) next.delete('q')
        else next.set('q', patch.q)
      }
      if (patch.folder !== undefined) {
        if (!patch.folder) next.delete('folder')
        else next.set('folder', patch.folder)
      }
      if (patch.sort !== undefined) {
        // Curated is the default: omit it from the URL.
        if (patch.sort === 'curated') next.delete('sort')
        else next.set('sort', patch.sort)
      }
      return next
    }, { replace: true })
  }, [slug])

  useEffect(() => {
    saveView(slug, view)
  }, [slug, view])

  /* The folder param is the folder the visitor is standing IN (drill-down),
     not a subtree filter. A stale/foreign id is ignored — root view. */
  const activeFolder = folderId
    ? content?.folders.find((folder) => folder.node.id === folderId)
    : undefined
  const activeFolderId = activeFolder?.node.id ?? null
  const entries = useMemo(
    () => (load.status === 'ready' ? immediateEntries(load.snapshot, activeFolderId) : null),
    [load, activeFolderId],
  )
  const trail = useMemo(
    () => (load.status === 'ready' && activeFolderId ? folderAncestors(load.snapshot, activeFolderId) : []),
    [load, activeFolderId],
  )
  /* Folder cards preview their first bookmarks when the folders are the
     layer's whole content (typically a root that files everything into
     folders) or when only a few sit beside bookmarks. A long run of folders
     over bookmarks keeps the compact tabs so the bookmarks stay near the top.
     Gallery always reads them: its folder cards lead with the covers inside. */
  const layerFolderPreviews = useMemo(
    () => (load.status === 'ready' && entries && entries.folders.length > 0
      && (view === 'gallery' || entries.resources.length === 0 || entries.folders.length <= RICH_FOLDER_LIMIT)
      ? folderPreviews(load.snapshot, entries.folders.map(({ node }) => node.id))
      : null),
    [load, entries, view],
  )

  /* FO-05 time-sorted layer: one folder layer fetched from the real children
     endpoint, paged by nextCursor. The snapshot still drives the masthead,
     outline and stats; only the current layer's order comes from the API.
     A non-curated ?sort= is only rendered while the flag is exposed and the
     collection kind supports the one-layer children fetch; otherwise the
     curated view is shown (a reading_path stays curated-only) and the stale
     param is dropped instead of blanking the page. */
  const sortEligible = sort !== 'curated' && sortExposed
    && readyCollection?.kind !== 'reading_path'
  type ChildrenLayer =
    | { readonly status: 'idle' }
    | { readonly status: 'loading' }
    | { readonly status: 'error'; readonly message: string }
    | { readonly status: 'ready'; readonly items: readonly CollectionChildrenItem[]; readonly nextCursor: string | null; readonly loadingMore: boolean }
  /* Sorted visits start in the loading state: initializing to 'idle' would
     paint one frame of the wrong empty state before the fetch effect runs. */
  const [childrenLayer, setChildrenLayer] = useState<ChildrenLayer>(
    () => (sortEligible ? { status: 'loading' } : { status: 'idle' }),
  )
  const [childrenNotice, setChildrenNotice] = useState<string | null>(null)
  const childrenLoadRef = useRef<number>(0)

  const fetchFirstPage = useCallback((signal?: AbortSignal) => {
    if (load.status !== 'ready' || !load.snapshot.collection.id) return
    const collectionId = load.snapshot.collection.id
    const requestId = childrenLoadRef.current + 1
    childrenLoadRef.current = requestId
    setChildrenLayer({ status: 'loading' })
    productClient.listCollectionChildren(collectionId, {
      parentId: activeFolderId ?? undefined,
      sort,
      limit: 50,
      signal,
    })
      .then((page) => {
        if (signal?.aborted || childrenLoadRef.current !== requestId) return
        setChildrenLayer({ status: 'ready', items: page.items, nextCursor: page.nextCursor, loadingMore: false })
      })
      .catch((error: unknown) => {
        if (signal?.aborted || childrenLoadRef.current !== requestId) return
        // Backend flag off / unseen route: fall back to the curated layer.
        if (isProductApiError(error) && error.status === 404) {
          patchParams({ sort: 'curated' })
          return
        }
        setChildrenLayer({
          status: 'error',
          message: isProductApiError(error) ? error.recoveryHint : "Couldn't load this folder. Try again.",
        })
      })
  }, [activeFolderId, sort, load, patchParams])

  useEffect(() => {
    if (sort === 'curated' || !sortExposed || readyCollection?.kind === 'reading_path') {
      setChildrenLayer({ status: 'idle' })
      setChildrenNotice(null)
      /* F1-a: a ?sort= that can never be fetched must not linger in the URL —
         the render ignores it (curated view) and the param is dropped so the
         address stops advertising an order the page does not show. */
      if (sort !== 'curated') patchParams({ sort: 'curated' })
      return
    }
    if (load.status !== 'ready' || !load.snapshot.collection.id) return
    // A user-driven re-entry (sort/folder change) clears the recovery notice.
    setChildrenNotice(null)
    const controller = new AbortController()
    fetchFirstPage(controller.signal)
    return () => controller.abort()
  }, [sort, sortExposed, activeFolderId, readyCollection?.kind, load, patchParams, fetchFirstPage])

  /* F3-a: load-more shares the childrenLoadRef request-id guard with the
     initial load, so a continuation that resolves after the user switched
     sort/folder is dropped instead of appended into the new layer. */
  const loadMoreChildren = useCallback(() => {
    if (childrenLayer.status !== 'ready' || childrenLayer.nextCursor === null
      || childrenLayer.loadingMore || load.status !== 'ready') return
    if (!sortEligible) return
    const collectionId = load.snapshot.collection.id
    const requestId = childrenLoadRef.current + 1
    childrenLoadRef.current = requestId
    setChildrenLayer((current) => current.status === 'ready'
      ? { ...current, loadingMore: true } : current)
    productClient.listCollectionChildren(collectionId, {
      parentId: activeFolderId ?? undefined,
      sort,
      cursor: childrenLayer.nextCursor,
    })
      .then((page) => {
        if (childrenLoadRef.current !== requestId) return
        setChildrenLayer((current) => current.status === 'ready'
          ? { ...current, items: [...current.items, ...page.items], nextCursor: page.nextCursor, loadingMore: false }
          : current)
      })
      .catch((error: unknown) => {
        if (childrenLoadRef.current !== requestId) return
        // Children cursors expire server-side (invalid_cursor/snapshot_expired):
        // restart the layer from the first page instead of leaving the button
        // stuck on 'Loading…'.
        if (isProductApiError(error) && error.isSnapshotExpired) {
          setChildrenNotice('The page list expired — reloaded from the first page.')
          fetchFirstPage()
          return
        }
        setChildrenLayer((current) => current.status === 'ready'
          ? { ...current, loadingMore: false } : current)
      })
  }, [childrenLayer, activeFolderId, sort, load, sortEligible, fetchFirstPage])

  /* Folder navigation pushes history (unlike view/q) so Back retraces the
     drill-down trail instead of leaving the page. */
  const openFolder = useCallback((id: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id) next.set('folder', id)
      else next.delete('folder')
      return next
    })
  }, [setSearchParams])

  /* Search string for folder links: same layer semantics as openFolder,
     preserving view and q. */
  const folderSearchFor = useCallback((id: string | null) => {
    const next = new URLSearchParams(searchParams)
    if (id) next.set('folder', id)
    else next.delete('folder')
    const value = next.toString()
    return value ? `?${value}` : ''
  }, [searchParams])

  /* Sticky toolbar gains elevation once its sentinel scrolls under the header */
  const { sentinelRef: toolbarSentinelRef, isStuck } = useStuckToolbar([content])
  const previewDisconnectRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (load.status !== 'ready') return
    if (load.snapshot.collection.slug !== slug) return
    const controller = new AbortController()
    recordView(slug, { signal: controller.signal })
    return () => controller.abort()
  }, [slug, load])

  const bindResources = useCallback((node: HTMLDivElement | null) => {
    previewDisconnectRef.current?.()
    previewDisconnectRef.current = null
    if (!node) return
    if (load.status !== 'ready' || load.snapshot.collection.slug !== slug) return
    previewDisconnectRef.current = observePreview(node, slug)
  }, [slug, load])

  useEffect(() => () => {
    previewDisconnectRef.current?.()
    previewDisconnectRef.current = null
  }, [slug])

  /* FO-05: children-layer entries mapped to the snapshot's rendering shapes
     (folder cards + bookmark resources). directCount is not available on the
     one-layer endpoint, so folder cards show no count in time-sorted mode. */
  const sortedEntries = useMemo<{ folders: PublicCollectionFolderEntry[]; resources: CollectionResource[] } | null>(() => {
    if (childrenLayer.status !== 'ready') return null
    const path = activeFolder ? [...trail.map((node) => node.title), activeFolder.node.title] : []
    const pathIds = activeFolder ? [...trail.map((node) => node.id), activeFolder.node.id] : []
    const folders: PublicCollectionFolderEntry[] = []
    const resources: CollectionResource[] = []
    for (const item of childrenLayer.items) {
      const node: PublicCollectionNode = {
        id: item.id,
        parentId: item.parentId,
        kind: item.kind,
        title: item.title,
        description: item.description,
        url: item.url,
        position: item.position,
        iconUrl: item.iconUrl ?? null,
        // FO-08: the server sends the per-node CDN opt-out on bookmarks (false
        // for explicit none); dropping it here would let the collection-level
        // fact hotlink the CDN for a node the owner explicitly turned off.
        ...(item.faviconCdnAllowed === undefined ? {} : { faviconCdnAllowed: item.faviconCdnAllowed }),
        // LP-06: Gallery covers in time-sorted layers too.
        ...(item.previewImage === undefined ? {} : { previewImage: item.previewImage }),
        // The owner's pin marks the row in time-sorted layers too, though it no longer leads them.
        ...(item.pinned ? { pinned: true as const } : {}),
        // S1c: hide_public tombstones pass through — the row stays in
        // position, inert (FO-05 children layer).
        ...(item.state === undefined ? {} : { state: item.state }),
      }
      if (item.kind === 'folder') {
        folders.push({ node, directCount: null })
      } else if (item.kind === 'bookmark') {
        /* F5: url-null bookmarks are real titled rows (curated mode renders
           them the same way) — they simply have a null iconUrl here. */
        resources.push({
          node,
          depth: path.length,
          path,
          pathIds,
          href: safeExternalUrl(item.url),
          host: hostForUrl(item.url),
        })
      }
    }
    return { folders, resources }
  }, [childrenLayer, activeFolder, trail])

  const filteredSortedEntries = useMemo(() => {
    if (sortedEntries === null) return null
    if (!normalizedQuery) return sortedEntries
    const hit = (node: PublicCollectionNode) =>
      [node.title, node.description ?? '', node.url ?? '', hostForUrl(node.url)]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
    return {
      folders: sortedEntries.folders.filter(({ node }) => hit(node)),
      resources: sortedEntries.resources.filter(({ node }) => hit(node)),
    }
  }, [sortedEntries, normalizedQuery])

  if (load.status === 'loading') {
    /* Page-shaped skeleton shared with the /c/:slug route fallback, so the
       lazy chunk landing and the snapshot resolving never jump the layout. */
    return (
      <CollectionSkeleton
        data-testid="public-collection-loading"
        label={`Public collection: ${load.restartCount > 0 ? 'Refreshing the collection snapshot...' : 'Assembling the complete collection...'}`}
      />
    )
  }

  if (load.status === 'unavailable') {
    return (
      <AbsenceStage
        title="Collection unavailable"
        description="This collection was not found, has been withdrawn, or is not available to this account."
        corners={ABSENCE_CORNERS.collection}
        exits={[{ to: '/', label: 'Back home' }]}
      />
    )
  }

  if (load.status === 'error') {
    return (
      <PageShell variant="bare">
        <RouteState kind="error" titleAs="h1" title="Couldn't load this collection" description={load.message} onRetry={retry} />
      </PageShell>
    )
  }

  if (!content || !entries) {
    return (
      <AbsenceStage
        title="Collection unavailable"
        description="This collection is still being published. Try again in a moment."
        corners={ABSENCE_CORNERS.collection}
        exits={[{ label: 'Try again', onClick: retry }, { to: '/', label: 'Back home' }]}
      />
    )
  }

  const { collection } = load.snapshot
  // Anonymous visitors still get the button: it renders a sign-in CTA itself.
  const showCollectionFollow = isCollectionFollowExposureEnabled()
    && !bootstrapping
    && Boolean(collection.id)
  // CS-01: same gating — the control conceals itself when the target does
  // not resolve and shows a sign-in CTA to anonymous visitors.
  const showCommunityVote = isCommunityExposureEnabled()
    && !bootstrapping
    && Boolean(collection.id)
  const onSaveResource = isLoggedIn && !bootstrapping ? setSaveTarget : undefined
  const socialActions = (
    /* Follow, then the CS-01 vote pill, then the quiet links — the
       same cluster the digest series and issue mastheads render. */
    <SocialActions
      follow={showCollectionFollow ? (
        <CollectionFollowButton
          collectionId={collection.id}
          ownerHandle={collection.owner?.handle}
          onState={(state) => setFollowerCount(state?.followerCount ?? null)}
        />
      ) : null}
      vote={showCommunityVote ? (
        <CommunityVoteControl query={{ kind: 'collection', id: collection.id }} />
      ) : null}
      links={
        <>
          <SubscribeButton sourceType="collection" sourceId={collection.id} />
          <SubscribeInBrowserButton />
          {isLoggedIn ? (
            <CollectionExportMenu collectionId={collection.id} slug={collection.slug} />
          ) : null}
          {collection.kind === 'reading_path' && (
            <Link to={`/path/${slug}`} className="btn btn-ghost btn-sm">Path</Link>
          )}
          <Link to={`/graph/${slug}`} className="btn btn-ghost btn-sm">Graph</Link>
          {/* The embed card loads the snapshot anonymously, so a member-only
              projection has nothing to embed. */}
          {collection.access === 'public' && (
            <EmbedShareButton
              path={`/share/${encodeURIComponent(collection.slug)}`}
              title={collection.title}
              rowCount={content.resources.length}
              label="Embed this collection"
            />
          )}
          <ReportButton
            target={{ kind: 'collection', id: collection.id }}
            label="this collection"
            testId="report-collection"
          />
        </>
      }
    />
  )
  /* q searches the whole current subtree (descendants included, strict
     node-id membership via pathIds), not just the visible layer. Result
     rows show their path relative to the folder the visitor stands in. */
  const scoped = activeFolder
    ? content.resources.filter((resource) => resource.pathIds.includes(activeFolder.node.id))
    : content.resources
  const searchResults = normalizedQuery
    ? scoped
      .filter((resource) => [
        resource.node.title,
        resource.node.description ?? '',
        resource.host,
        ...resource.path,
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
      .map((resource) => {
        if (!activeFolder) return resource
        const anchor = resource.pathIds.indexOf(activeFolder.node.id)
        const relative = resource.path.slice(anchor + 1)
        return {
          ...resource,
          // Direct hits label their location with the current folder name.
          path: relative.length > 0 ? relative : [activeFolder.node.title],
          depth: relative.length,
        }
      })
    : []
  /* The masthead states the collection total and the folder head a folder's,
     so the chip only answers a search: how many of the bookmarks in scope it
     matched. Sorted mode counts bookmark items on the loaded layer and stays
     blank until that layer is ready — folders are never part of the number. */
  let countLabel: string | null = null
  if (normalizedQuery) {
    if (sort === 'curated' || !sortEligible) {
      countLabel = `${searchResults.length} of ${plural(scoped.length, 'bookmark')}`
    } else if (sortedEntries != null && filteredSortedEntries != null) {
      countLabel = `${filteredSortedEntries.resources.length} of ${plural(sortedEntries.resources.length, 'bookmark')}`
    }
  }
  const parentCrumb = trail.at(-1)
  const hasOutline = content.folders.length > 0
  const activeTotals = activeFolder ? totals.get(activeFolder.node.id) : undefined
  const layerIsEmpty = entries.folders.length === 0 && entries.resources.length === 0
  /* F4: the same Load-more affordance serves the non-empty layer and the
     filtered-empty layer — matches on later pages stay reachable under q. */
  const canLoadMoreChildren = sort !== 'curated' && sortEligible
    && childrenLayer.status === 'ready' && childrenLayer.nextCursor !== null
  const loadMoreRow = canLoadMoreChildren
    ? (
      <div className="row">
        <LoadMoreButton
          loading={childrenLayer.loadingMore}
          onClick={loadMoreChildren}
          status="Loading more items"
          data-collection-children-load-more
        />
      </div>
    )
    : null
  /* R13-07: Newest/Oldest search only the pages already loaded. Curated
     search walks the subtree, so it never gets this note. */
  const searchScopeNotice = normalizedQuery && canLoadMoreChildren ? (
    <p className="meta collection-children-notice" role="status">Searching the items loaded so far. Load more to search further.</p>
  ) : null
  const noMatchDescription = activeFolder
    ? `Nothing in this folder matches “${query}”.`
    : `Nothing in this collection matches “${query}”.`

  /* Drill-down trail: heads the folder layer under the toolbar; on phones it
     is the page's one pinned row (collection.css). */
  const folderTrail = activeFolder ? (
    <FolderTrail
      className="collection-trail"
      collectionData
      rootTitle={collection.title}
      rootTo={{ search: folderSearchFor(null) }}
      crumbs={trail.map((node) => ({
        id: node.id,
        title: node.title,
        to: { search: folderSearchFor(node.id) },
      }))}
      currentTitle={activeFolder.node.title}
      backTo={{ search: folderSearchFor(parentCrumb?.id ?? null) }}
    />
  ) : null

  return (
    <article
      className="collection-page"
      data-view={view}
      data-sort={sort}
      data-in-folder={activeFolder ? true : undefined}
      data-testid="public-collection-page"
    >
      <CollectionTransportNotice />
      <PageHead
        as="header"
        className="collection-masthead page-head--editorial"
        style={{ viewTransitionName: `collection-${collection.id}` }}
        documentTitle={documentTitle}
        breadcrumb={
          <Breadcrumb items={[{ label: 'Explore', to: '/explore' }, { label: collection.title }]} />
        }
        eyebrow={
          <span className="collection-kicker">
            <span>{kindLabel(collection.kind)}</span>
            {collection.access === 'member' ? <span className="chip chip--kind">Shared with you</span> : null}
          </span>
        }
        title={collection.title}
        actions={socialActions}
        stats={
          /* Figures, not a caption strip: the counts read as the
             collection's vital signs — a numeral over its noun, beside
             the head on wide screens and as one ruled row on phones. */
          <CollectionFigures
            bookmarks={content?.resources.length ?? 0}
            folders={content?.folders.length ?? 0}
            views={collection.viewCount ?? 0}
            followers={followerCount}
          />
        }
      >
        {/* R9-31: no summary → no lede at all (matches resources.tsx);
            a bare '-' used to stand in for missing content. */}
        {collection.summary && (
          <ClampedText
            text={collection.summary}
            className="lede collection-masthead-lede"
            wrapperClassName="collection-masthead-summary"
            toggleClassName="collection-masthead-summary-toggle"
          />
        )}
        {/* Byline: who curates it and how fresh it is, under the summary. */}
        <div className="collection-byline">
          {collection.owner ? (
            <span className="collection-byline-curator">
              <span>Curated by</span>
              <ProfileHoverCard
                handle={collection.owner.handle}
                displayName={collection.owner.displayName}
                avatarUrl={collection.owner.avatarUrl}
                profileId={collection.owner.profileId}
              >
                <span className="avatar collection-curator-avatar" aria-hidden data-collection-curator-avatar>
                  <AvatarImage
                    url={collection.owner.avatarUrl}
                    initials={curatorInitials(collection.owner.displayName, collection.owner.handle)}
                  />
                </span>
                <strong data-collection-field="curator">{collection.owner.displayName}</strong>
              </ProfileHoverCard>
            </span>
          ) : null}
          <span className="collection-byline-date">Updated {formatUpdatedAt(collection.updatedAt)}</span>
        </div>
      </PageHead>

      <div className="collection-body" data-has-outline={hasOutline || undefined}>
        {/* ≥900px: the Contents sidebar. Below that the same tree opens as a
            sheet from the toolbar's Contents button. */}
        <CollectionOutline
          folders={content.folders}
          totals={totals}
          rootTitle={collection.title}
          rootCount={content.resources.length}
          activeFolderId={activeFolderId}
          trail={trail}
          openFolder={openFolder}
        />

        <div className="collection-main">
          <div ref={toolbarSentinelRef} className="toolbar-sentinel" aria-hidden />
          <div className={`collection-toolbar is-sticky${isStuck ? ' is-stuck' : ''}`} data-testid="collection-toolbar">
            {hasOutline ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm collection-contents-trigger"
                aria-haspopup="dialog"
                aria-expanded={contentsOpen}
                aria-controls={contentsDialogId}
                onClick={() => setContentsOpen(true)}
              >
                <Icon name="lines" />
                Contents
              </button>
            ) : null}
            <label className="search-field search-field--compact collection-inline-search">
              <span className="visually-hidden">Filter bookmarks</span>
              <Icon name="search" />
              <input aria-label="Filter bookmarks" value={query} onChange={(event) => patchParams({ q: event.target.value })} placeholder={BOOKMARK_FILTER_PLACEHOLDER} autoComplete="off" />
              {query && <button type="button" className="btn btn-ghost btn-sm" onClick={() => patchParams({ q: '' })}>Clear</button>}
            </label>
            {countLabel ? <span className="chip collection-count-chip">{countLabel}</span> : null}
            <div className="collection-toolbar-controls">
              {sortExposed && readyCollection?.kind !== 'reading_path' && (
                <FilterRail<CollectionChildrenSort>
                  className="view-switch"
                  variant="segments"
                  label="Order"
                  value={sort}
                  options={([
                    /* A narrow column keeps "Curator's" — the tail is visually
                       hidden there so both rails keep one row. */
                    { value: 'curated', label: <>Curator's<span className="collection-sort-tail"> order</span></> },
                    { value: 'created_desc', label: 'Newest' },
                    { value: 'created_asc', label: 'Oldest' },
                  ] as const).map(({ value: sortValue, label }) => ({ value: sortValue, label }))}
                  onChange={(id) => patchParams({ sort: id })}
                />
              )}
              <FilterRail<ViewMode>
                className="view-switch collection-view-switch"
                variant="segments"
                label="View mode"
                value={view}
                options={(['board', 'gallery', 'list', 'compact'] as const).map((id) => {
                  const name = `${id[0]?.toLocaleUpperCase()}${id.slice(1)}`
                  return {
                    value: id,
                    title: name,
                    label: <><Icon name={VIEW_ICONS[id]} /><span className="collection-view-name">{name}</span></>,
                  }
                })}
                onChange={(id) => patchParams({ view: id })}
              />
            </div>
          </div>

          {folderTrail}
          {activeFolder ? (
            /* The folder the visitor stands in, named like a chapter head:
               title, the curator's description, and what is filed below. */
            <header className="collection-layer-head" data-collection-layer-head>
              <h2 className="collection-layer-title">{activeFolder.node.title}</h2>
              {activeFolder.node.description ? (
                <p className="collection-layer-desc">{activeFolder.node.description}</p>
              ) : null}
              <p className="meta-row collection-layer-meta">
                <span>{plural(activeTotals?.bookmarks ?? 0, 'bookmark')}</span>
                {activeTotals && activeTotals.folders > 0 ? <span>{plural(activeTotals.folders, 'folder')}</span> : null}
              </p>
            </header>
          ) : null}

          <div className="collection-content">
          {sort === 'curated' || !sortEligible ? (
            normalizedQuery ? (
              searchResults.length === 0 ? (
                <EmptyState
                  className="collection-filter-empty"
                  icon="search"
                  title="No bookmarks match"
                  description={noMatchDescription}
                  action={
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => patchParams({ q: '' })}>Clear search</button>
                  }
                />
              ) : (
                <CollectionResources
                  resources={searchResults}
                  view={view}
                  slug={slug}
                  resourcesRef={bindResources}
                  faviconCdnAllowed={collection.faviconCdnAllowed === true}
                  showPath
                  onSave={onSaveResource}
                />
              )
            ) : layerIsEmpty ? (
              activeFolder ? (
                <EmptyState
                  className="collection-filter-empty"
                  icon="folder"
                  title="This folder is empty"
                  description="Nothing has been published inside this folder yet."
                  action={
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openFolder(parentCrumb?.id ?? null)}>
                      Back to {parentCrumb?.title ?? collection.title}
                    </button>
                  }
                />
              ) : (
                <EmptyState
                  className="public-collection-empty"
                  icon="collection"
                  kicker="Collection contents"
                  title="Nothing published yet"
                  description="This collection is available, but it does not contain any visible items."
                />
              )
            ) : (
              <>
                {entries.folders.length > 0 && (
                  <CollectionSection label="Folders" count={entries.folders.length}>
                    <CollectionFolderLayer
                      folders={entries.folders}
                      view={view}
                      searchFor={folderSearchFor}
                      previews={layerFolderPreviews}
                      totals={totals}
                      faviconCdnAllowed={collection.faviconCdnAllowed === true}
                    />
                  </CollectionSection>
                )}
                {entries.resources.length > 0 && (
                  <CollectionSection label="Bookmarks" count={entries.resources.length}>
                    <CollectionResources
                      resources={entries.resources}
                      view={view}
                      slug={slug}
                      resourcesRef={bindResources}
                      faviconCdnAllowed={collection.faviconCdnAllowed === true}
                      showPath={false}
                      onSave={onSaveResource}
                    />
                  </CollectionSection>
                )}
              </>
            )
          ) : childrenLayer.status === 'loading' || childrenLayer.status === 'idle' ? (
            <>
              {childrenNotice && (
                <p className="meta collection-children-notice" role="status" data-testid="collection-children-notice">{childrenNotice}</p>
              )}
              {/* The skeleton is aria-hidden, so this line is the announcement;
                  sighted visitors already see the skeleton, not bare text. */}
              <p className="visually-hidden" role="status">Sorting bookmarks…</p>
              <CollectionSkeletonBoard />
            </>
          ) : childrenLayer.status === 'error' ? (
            <EmptyState
              className="collection-filter-empty"
              icon="alert"
              kicker="Collection contents"
              title="Couldn't sort this folder"
              description={childrenLayer.message}
              action={
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => patchParams({ sort: 'curated' })}>Show curator's order</button>
              }
            />
          ) : filteredSortedEntries ? (
            filteredSortedEntries.folders.length === 0 && filteredSortedEntries.resources.length === 0 ? (
              normalizedQuery ? (
                /* F4: matches can sit on later pages — the filtered-empty state
                   keeps the Load-more affordance while nextCursor remains. */
                <>
                  {childrenNotice && (
                    <p className="meta collection-children-notice" role="status" data-testid="collection-children-notice">{childrenNotice}</p>
                  )}
                  {searchScopeNotice}
                  <EmptyState
                    className="collection-filter-empty"
                    icon="search"
                    title="No bookmarks match"
                    description={noMatchDescription}
                    action={
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => patchParams({ q: '' })}>Clear search</button>
                    }
                  />
                  {loadMoreRow}
                </>
              ) : activeFolder ? (
                <EmptyState
                  className="collection-filter-empty"
                  icon="folder"
                  title="This folder is empty"
                  description="Nothing has been published inside this folder yet."
                  action={
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openFolder(parentCrumb?.id ?? null)}>
                      Back to {parentCrumb?.title ?? collection.title}
                    </button>
                  }
                />
              ) : (
                <EmptyState
                  className="public-collection-empty"
                  icon="collection"
                  kicker="Collection contents"
                  title="Nothing published yet"
                  description="This collection is available, but it does not contain any visible items."
                />
              )
            ) : (
              <>
                {childrenNotice && (
                  <p className="meta collection-children-notice" role="status" data-testid="collection-children-notice">{childrenNotice}</p>
                )}
                {searchScopeNotice}
                {/* A paged layer only counts once its last page is in. */}
                {filteredSortedEntries.folders.length > 0 && (
                  <CollectionSection label="Folders" count={canLoadMoreChildren ? null : filteredSortedEntries.folders.length}>
                    <CollectionFolderLayer
                      folders={filteredSortedEntries.folders}
                      view={view}
                      searchFor={folderSearchFor}
                      previews={layerFolderPreviews}
                      totals={totals}
                      faviconCdnAllowed={collection.faviconCdnAllowed === true}
                    />
                  </CollectionSection>
                )}
                {filteredSortedEntries.resources.length > 0 && (
                  <CollectionSection label="Bookmarks" count={canLoadMoreChildren ? null : filteredSortedEntries.resources.length}>
                    <CollectionResources
                      resources={filteredSortedEntries.resources}
                      view={view}
                      slug={slug}
                      resourcesRef={bindResources}
                      faviconCdnAllowed={collection.faviconCdnAllowed === true}
                      showPath={false}
                      onSave={onSaveResource}
                    />
                  </CollectionSection>
                )}
                {loadMoreRow}
              </>
            )
          ) : (
            <EmptyState
              className="public-collection-empty"
              icon="collection"
              kicker="Collection contents"
              title="This order isn't available"
              description="Show this collection in the curator's order instead."
              action={
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => patchParams({ sort: 'curated' })}>Show curator's order</button>
              }
            />
          )}
          </div>
        </div>
      </div>

      {/* CS-03: collection comments resolve the same target identity as
          the vote control; the panel conceals itself when unresolved. */}
      {showCommunityVote ? (
        <CommunityComments query={{ kind: 'collection', id: collection.id }} />
      ) : null}

      {saveTarget && (
        <SaveResourcePicker resource={saveTarget} onClose={() => setSaveTarget(null)} />
      )}
      {hasOutline ? (
        <Modal
          open={contentsOpen}
          onClose={() => setContentsOpen(false)}
          label="Contents"
          title="Contents"
          size="sm"
          overlayProps={{ id: contentsDialogId }}
        >
          <CollectionOutline
            variant="sheet"
            folders={content.folders}
            totals={totals}
            rootTitle={collection.title}
            rootCount={content.resources.length}
            activeFolderId={activeFolderId}
            trail={trail}
            openFolder={openFolder}
            onPick={() => setContentsOpen(false)}
          />
        </Modal>
      ) : null}
    </article>
  )
}
