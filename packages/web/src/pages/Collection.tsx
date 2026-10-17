import { SubscribeButton } from '../components/bookmark-subscriptions/SubscribeButton'
import { CollectionExportMenu } from '../components/CollectionExportMenu'
import { SubscribeInBrowserButton } from '../components/TransportWarning'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Breadcrumb } from '../components/Breadcrumb'
import { SocialActions } from '../components/SocialActions'
import { ABSENCE_CORNERS, AbsenceStage } from '../components/AbsenceStage'
import { EmptyState } from '../components/EmptyState'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { AvatarImage } from '../components/AvatarImage'
import { ClampedText } from '../components/ClampedText'
import { CollectionSkeleton } from '../components/CollectionSkeleton'
import { FilterRail } from '../components/FilterRail'
import { FolderTrail } from '../components/FolderTrail'
import { Icon, type IconName } from '../components/Icon'
import { Modal } from '../components/Modal'
import { BOOKMARK_FILTER_PLACEHOLDER } from '../lib/searchCopy'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { usePublicCollectionSnapshot } from '../lib/usePublicCollectionSnapshot'
import { plural } from '../lib/plural'
import { CollectionFigures } from './collection/figures'
import { usePageMeta, collectionOgImagePath } from '../lib/usePageMeta'
import { useStuckToolbar } from '../lib/useStuckToolbar'
import { publicCollectionDescription } from '../lib/publicCollectionMeta'
import {
  flattenPublicCollection,
  folderAncestors,
  folderPreviews,
  folderTotals,
  immediateEntries,
  type PublicCollectionResource as CollectionResource,
} from '../lib/publicCollectionTree'
import {
  curatorInitials,
  formatUpdatedAt,
  isViewMode,
  kindLabel,
  loadView,
  saveView,
  type ViewMode,
} from './collection/format'
import { CollectionResources, SaveResourcePicker } from './collection/resources'
import { CollectionFolderLayer, CollectionOutline, CollectionSection } from './collection/outline'
import { brandedTitle } from '../lib/edition'
import '../styles/library.css'
import '../styles/not-found.css'

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
  const { bootstrapping, isLoggedIn, user } = useAuth()
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
  /* R7-07: the bookmark a signed-in visitor is filing into their library. */
  const [saveTarget, setSaveTarget] = useState<CollectionResource | null>(null)
  /* Below 900px the Contents tree opens as a sheet instead of a sidebar. */
  const [contentsOpen, setContentsOpen] = useState(false)
  const contentsDialogId = useId()

  const urlView = searchParams.get('view')
  const view: ViewMode = isViewMode(urlView) ? urlView : loadView(slug)
  const query = searchParams.get('q') ?? ''
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const folderId = searchParams.get('folder') ?? ''
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
            canonicalPath: readyCollection.folderShare ? null : `/c/${encodeURIComponent(readyCollection.slug)}`,
            ...(readyCollection.folderShare ? { robots: 'noindex' as const }
              : { ogImagePath: collectionOgImagePath(readyCollection.slug, readyCollection.updatedAt) }),
          }
        : { canonicalPath: null, robots: 'noindex' },
    brandedTitle(documentTitle),
  )

  /* react-router hands back a new setSearchParams on every URL change. Read
     it through a ref so patchParams only changes with the slug. */
  const setSearchParamsRef = useRef(setSearchParams)
  setSearchParamsRef.current = setSearchParams
  const patchParams = useCallback((patch: {
    view?: ViewMode; q?: string; folder?: string;
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
  // A shared folder of the owner's own library is already in it; copying would duplicate it.
  const ownFolder = collection.folderShare && Boolean(user && collection.owner?.handle === user.handle)
  const onSaveResource = isLoggedIn && !bootstrapping && !ownFolder ? setSaveTarget : undefined
  const socialActions = collection.folderShare ? undefined : (
    <SocialActions
      links={
        <>
          <SubscribeButton sourceType="collection" sourceId={collection.id} />
          <SubscribeInBrowserButton />
          {isLoggedIn ? (
            <CollectionExportMenu collectionId={collection.id} slug={collection.slug} />
          ) : null}
          <Link to={`/graph/${slug}`} className="btn btn-secondary btn-sm">Graph</Link>
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
     matched. */
  const countLabel = normalizedQuery
    ? `${searchResults.length} of ${plural(scoped.length, 'bookmark')}`
    : null
  const parentCrumb = trail.at(-1)
  const hasOutline = content.folders.length > 0
  const activeTotals = activeFolder ? totals.get(activeFolder.node.id) : undefined
  const layerIsEmpty = entries.folders.length === 0 && entries.resources.length === 0
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
      data-in-folder={activeFolder ? true : undefined}
      data-testid="public-collection-page"
    >
      <PageHead
        as="header"
        className="collection-masthead page-head--editorial"
        style={{ viewTransitionName: `collection-${collection.id}` }}
        documentTitle={documentTitle}
        breadcrumb={isLoggedIn ? (
          <Breadcrumb items={[
            { label: 'Library', to: '/library' },
            { label: collection.title },
          ]} />
        ) : undefined}
        eyebrow={
          <span className="collection-kicker">
            <span>{collection.folderShare ? 'Shared folder' : kindLabel(collection.kind)}</span>
            {/* The member projection is also what the owner reads. */}
            {collection.access === 'member' && !(user && collection.owner?.handle === user.handle)
              ? <span className="chip chip--kind">Shared with you</span>
              : null}
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
              <span className="avatar collection-curator-avatar" aria-hidden data-collection-curator-avatar>
                <AvatarImage
                  url={collection.owner.avatarUrl}
                  initials={curatorInitials(collection.owner.displayName, collection.owner.handle)}
                />
              </span>
              <strong data-collection-field="curator">{collection.owner.displayName}</strong>
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
          {normalizedQuery ? (
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
                          faviconCdnAllowed={collection.faviconCdnAllowed === true}
                      showPath={false}
                      onSave={onSaveResource}
                    />
                  </CollectionSection>
                )}
              </>
            )
          }
          </div>
        </div>
      </div>

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
