import { useEffect, useMemo, useRef, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { useToast } from '../../components/AppToast'
import { EmptyState, LoadingState } from '../../components/EmptyState'
import { FolderEntries } from '../../components/FolderEntries'
import { Icon, SaveMarkGlyph } from '../../components/Icon'
import { ResourceList, type ResourceListItem } from '../../components/ResourceList'
import { isLive } from '../../api'
import { isSelfHostedPathEnabled } from '../../lib/edition'
import {
  childrenOf,
  flattenBookmarks,
  immediateEntries,
  type BookmarkNode,
  type BookmarkRow,
  type FolderNode,
} from '../../lib/libraryTree'
import { BOOKMARK_FILTER_PLACEHOLDER } from '../../lib/searchCopy'
import { hostOf } from '../../lib/libraryTree'
import { pluralNoun } from '../../lib/plural'
import { useBookmarkAnnotations } from '../../lib/useBookmarkAnnotations'
import { previewCover } from '../../lib/linkPreview'
import { useLinkPreviewRequests } from '../../lib/useLinkPreviewRequests'
import type { useOwnedCollections } from '../../lib/useOwnedCollections'
import type { useSharedCollections } from '../../lib/useSharedCollections'
import { KIND_LABEL, libraryBookmarkItem } from './bookmarkItem'
import { LibraryViewSwitch, useDeskGallery } from './deskGallery'
import type { LibraryDeskData } from './data'
import type { LibraryLayerReorder } from './layerReorder'
import { ReorderableLayerList } from './ReorderableLayerList'
import { LibraryBookmarkMenu, LibraryFolderMenu } from './menus'
import type { LibraryDeskMutations } from './mutations'
import type { LibraryDeskOrder } from './ordering'
import { useSavedMarks } from './savedMarks'
import type { LibraryDeskSelection } from './selection'
import { LibraryTagFilterBar, type LibraryTagFilter } from './tags'
import { toggleTag } from '../../lib/libraryTags'

/** Covers a Gallery folder card's mosaic shows. */
const FOLDER_COVER_LIMIT = 4

export function BookmarkArea({
  query,
  setQuery,
  filtering,
  tagFilter,
  onShowAllTags,
  compact,
  folderId,
  collections,
  shared,
  data,
  order,
  layerReorder,
  selection,
  mutations,
  bookmarks,
  deskTrail,
  dragEnabled,
  rowPointerDown,
  bulkBar,
  onEditNode,
  onEditCollection,
}: {
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  /** A text query or a tag filter is on: rows come flat from `bookmarks`. */
  filtering: boolean
  tagFilter: LibraryTagFilter
  onShowAllTags: () => void
  compact: boolean
  folderId: string | null
  collections: ReturnType<typeof useOwnedCollections>
  shared: ReturnType<typeof useSharedCollections>
  data: LibraryDeskData
  order: LibraryDeskOrder
  layerReorder: LibraryLayerReorder
  selection: LibraryDeskSelection
  mutations: LibraryDeskMutations
  bookmarks: BookmarkRow[]
  deskTrail: FolderNode[]
  dragEnabled: boolean
  rowPointerDown: (node: BookmarkNode) => (event: ReactPointerEvent) => void
  bulkBar: ReactNode
  /** Opens the FE-04 node edit drawer for this row. */
  onEditNode: (nodeId: string) => void
  onEditCollection: () => void
}) {
  const titleRef = useRef<HTMLInputElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const {
    selectedId,
    selectedFollowedSlug,
    snap,
    load,
    loadMessage,
    selectedFolder,
    collection,
    caps,
    loadTree,
    folderPath,
  } = data
  const { reorderSection } = order
  const {
    selectMode,
    selectedIds,
    setPicker,
    enterSelectMode: enterSelect,
    exitSelectMode,
    toggleSelected,
  } = selection
  const {
    compose,
    setCompose,
    busy,
    createTitle,
    setCreateTitle,
    createUrl,
    setCreateUrl,
    createUrlError,
    setCreateUrlError,
    createTitleError,
    setCreateTitleError,
    openCompose,
    onCreate,
    requestDelete,
  } = mutations

  useEffect(() => {
    if (!compose) return
    // Bookmarks lead with the URL (the one required field); folders keep Title.
    if (compose === 'bookmark') urlRef.current?.focus()
    else titleRef.current?.focus()
  }, [compose])

  const layer = useMemo(
    () => (snap ? immediateEntries(snap.root, snap.nodes, folderId) : null),
    [folderId, snap],
  )
  /* LP-07 Gallery: covers for what is on screen. Owners and editors of a
     library collection ask for the missing ones (the consent that lets the
     server fetch private pages); followed collections are public snapshots
     the worker sweeps on its own. */
  const [gallery, setGallery] = useDeskGallery()
  const visibleBookmarks = filtering ? bookmarks.map((row) => row.node) : layer?.bookmarks ?? []
  /* Folder cards on the current layer: subtree bookmark count, direct
     subfolders, and (in Gallery) the first covers filed anywhere inside. */
  const folderCards = useMemo(() => {
    if (!snap || !layer || filtering) return []
    return layer.folders.map(({ node }) => {
      const inside = flattenBookmarks(snap.root, snap.nodes, node.id).map((row) => row.node)
      return {
        node,
        inside,
        folderCount: snap.nodes.filter((child) => child.kind === 'folder' && child.parentId === node.id).length,
        covers: inside.flatMap((bookmark) => previewCover(bookmark.previewImage) ?? []).slice(0, FOLDER_COVER_LIMIT),
      }
    })
  }, [filtering, layer, snap])
  // A folder's mosaic is on screen too: ask for the first few covers inside.
  const folderCoverCandidates = gallery
    ? folderCards.flatMap(({ inside }) => inside.slice(0, FOLDER_COVER_LIMIT))
    : []
  useLinkPreviewRequests({
    collectionId: snap?.collection.id ?? null,
    enabled: gallery && !selectedFollowedSlug && caps?.updateNode === true,
    missingNodeIds: [...visibleBookmarks, ...folderCoverCandidates]
      .filter((node) => !node.previewImage).map((node) => node.id),
    onRefresh: () => {
      if (snap) void loadTree(snap.collection.id, { silent: true })
    },
  })
  // Subtree total stays the headline count. "here" is the layer actually on
  // screen, and only when that layer is smaller (search replaces the layer)
  // and holds bookmarks of its own — "· 0 here" over a folders-only layer
  // read as an error.
  const directBookmarkCount = layer?.bookmarks.length
  const showLayerCount = !filtering
    && directBookmarkCount != null
    && directBookmarkCount > 0
    && directBookmarkCount < bookmarks.length

  /* FO-06 layer reorder: the current folder's canonical entries (folders and
     bookmarks share one position space, so the reorder list interleaves them
     by position token). Only an owner/editor with moveNode may enter it. */
  const reorderParentId = useMemo(() => {
    if (!snap) return null
    return folderId && snap.nodes.some((node) => node.id === folderId && node.kind === 'folder')
      ? folderId
      : snap.root.id
  }, [folderId, snap])
  const layerReorderExposed = isLive('faviconPolicy')
  const canLayerReorder = !selectedFollowedSlug
    && caps?.moveNode === true
    && reorderSection === null
    && layerReorderExposed
    && (layer?.folders.length ?? 0) + (layer?.bookmarks.length ?? 0) >= 2
  const reorderItems = useMemo(() => {
    if (!snap || !reorderParentId) return []
    const byId = new Map(snap.nodes.map((node) => [node.id, node]))
    return layerReorder.ids.map((id) => {
      const node = byId.get(id)
      const label = node
        ? node.kind === 'folder' ? node.title : (node.title || hostOf(node.url))
        : id
      return {
        id,
        kind: node?.kind === 'folder' ? ('folder' as const) : ('bookmark' as const),
        label,
        node: (
          <span className="library-layer-reorder-row">
            <Icon name={node?.kind === 'folder' ? 'folder' : 'bookmark'} />
            <span className="library-layer-reorder-label" title={label}>{label}</span>
          </span>
        ),
      }
    })
  }, [layerReorder.ids, reorderParentId, snap])

  const beginLayerReorder = () => {
    if (!canLayerReorder) return
    exitSelectMode()
    layerReorder.begin()
  }

  /* Note / TL;DR live on annotations (the API has no batch read), so comfort
     rows pull them lazily per visible node. Compact never shows snippets and
     followed snapshots carry no annotation read access — both stay silent. */
  const visibleNodeIds = useMemo(() => (
    filtering
      ? bookmarks.map(({ node }) => node.id)
      : layer?.bookmarks.map((node) => node.id) ?? []
  ), [bookmarks, filtering, layer])
  const annotationMarks = useBookmarkAnnotations(
    snap?.collection.id ?? null,
    visibleNodeIds,
    !compact && !selectedFollowedSlug,
  )

  const canBookmarkActions = !selectedFollowedSlug && caps != null
    && (caps.updateNode || caps.moveNode || caps.deleteNode || caps.createNode)

  /* Folder rows at every depth manage in place (FE-05); the folder node is
     resolved from the current layer so the menu can hand it to the drawer. */
  const folderNodes = useMemo(
    () => new Map((layer?.folders ?? []).map(({ node }) => [node.id, node])),
    [layer],
  )
  const canFolderActions = !selectedFollowedSlug && caps != null
    && (caps.updateNode || caps.moveNode || caps.deleteNode)

  const { error: toastError } = useToast()
  const savedMarks = useSavedMarks(toastError)

  const enterSelectMode = (initialId?: string, source: 'menu' | 'long-press' = 'menu') => {
    if (!canBookmarkActions || reorderSection || layerReorder.active) return
    enterSelect(initialId, source)
  }

  // Same gate as the row menu's Select item, and only when the layer is big enough to bulk-select.
  const showToolbarSelect = !gallery && canBookmarkActions
    && !reorderSection
    && !layerReorder.active
    && !selectMode
    && (layer?.bookmarks.length ?? 0) >= 2

  /* The row's save mark: a real control outside the row link — the old
     decorative trailing bookmark glyph inside the link read as a save button
     but navigated instead. Followed (public) snapshots stay read-only. */
  const savedMark = (node: BookmarkNode): ReactNode => {
    if (selectedFollowedSlug) return null
    const isSaved = savedMarks.isSaved(node.id)
    return (
      <button
        type="button"
        className={isSaved ? 'library-bookmark-save is-saved' : 'library-bookmark-save'}
        aria-pressed={isSaved}
        aria-label={isSaved ? `Remove ${node.title} from saved` : `Save ${node.title}`}
        title={isSaved ? 'Saved — click to remove' : 'Save to your reading list'}
        disabled={savedMarks.isPending(node.id)}
        onClick={() => savedMarks.toggle(node.id)}
      >
        <SaveMarkGlyph />
      </button>
    )
  }

  /** Selection checkbox / row menu for a bookmark row (all outside the link). */
  const bookmarkRowExtras = (node: BookmarkNode, detailsTo: string): Partial<ResourceListItem> => {
    const onDragPointerDown = dragEnabled ? rowPointerDown(node) : undefined
    if (selectMode) {
      return {
        to: undefined,
        href: undefined,
        detailTo: undefined,
        trailing: undefined,
        selectable: true,
        selected: selectedIds.has(node.id),
        onToggleSelect: () => toggleSelected(node.id),
        onDragPointerDown,
      }
    }
    const save = savedMark(node)
    return {
      onDragPointerDown,
      onLongPress: (!canBookmarkActions || reorderSection || layerReorder.active)
        ? undefined : () => enterSelectMode(node.id, 'long-press'),
      actions: (
        <>
          {save}
          <LibraryBookmarkMenu
            title={node.title}
            detailsTo={detailsTo}
            canMove={Boolean(caps?.moveNode)}
            canDelete={Boolean(caps?.deleteNode)}
            onEdit={canBookmarkActions ? () => onEditNode(node.id) : undefined}
            onMove={() => setPicker({ mode: 'move', nodes: [node] })}
            onCopy={canBookmarkActions ? () => setPicker({ mode: 'copy', nodes: [node] }) : undefined}
            onDelete={() => void requestDelete([node])}
            onSelect={!canBookmarkActions || reorderSection || layerReorder.active
              ? undefined
              : () => enterSelectMode(node.id)}
          />
        </>
      ),
    }
  }

  /** Bookmark rows at the current density. Direct layer rows pass an empty
      folder label — their place is named by the breadcrumb above — while
      search rows keep the folder chip that locates each hit. */
  const renderBookmarkRows = (rows: BookmarkRow[]) => (
    <ResourceList
      mode={gallery ? 'gallery' : compact ? 'compact' : 'list'}
      testId="library-bookmarks"
      items={rows.map(({ node, folder }) => {
        const item = libraryBookmarkItem(
          node,
          folder,
          snap!.collection.id,
          snap!.collection.publicationSlug,
          Boolean(selectedFollowedSlug),
        )
        return {
          ...item,
          tags: node.tags,
          // A row tag narrows the desk to that tag; in select mode rows only toggle.
          ...(selectMode ? {} : {
            onTag: (tag: string) => tagFilter.set(toggleTag(tagFilter.selected, tag)),
            isTagActive: tagFilter.isSelected,
          }),
          ...(annotationMarks.get(node.id) ?? {}),
          ...bookmarkRowExtras(node, item.detailTo!),
          cover: gallery ? previewCover(node.previewImage) : null,
        }
      })}
    />
  )

  if (collections.state === 'error' && collections.items.length === 0 && !selectedId) {
    return (
      <EmptyState
        role="alert"
        icon="alert"
        title="Couldn't load your collections"
        description={collections.message}
        action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void collections.reload()}>Try again</button>}
      />
    )
  }
  if (collections.state !== 'loading' && collections.items.length === 0 && shared.items.length === 0 && !selectedId) {
    return (
      <EmptyState
        illustration="books"
        title="No collections yet"
        description="Create a collection, then add bookmarks right from your library."
        action={
          <>
            <Link to="/library/new" className="btn btn-primary btn-sm">New collection</Link>
            {isSelfHostedPathEnabled('/explore') && <Link to="/explore" className="btn btn-ghost btn-sm">Explore public collections</Link>}
          </>
        }
      />
    )
  }
  if (load === 'error' && !snap) {
    return (
      <EmptyState
        role="alert"
        icon="alert"
        title="Couldn't load this collection"
        description={loadMessage}
        action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => selectedId && void loadTree(selectedId)}>Try again</button>}
      />
    )
  }
  if (load === 'loading' && !snap) {
    return <LoadingState label="Loading bookmarks…" />
  }

  return (
    <>
      {load === 'error' && snap && <p className="field-error" role="status">Showing previously loaded bookmarks. {loadMessage}</p>}
      <span className="visually-hidden" role="status" aria-live="polite">{savedMarks.message}</span>
      <div className="library-desk-meta">
        {collection && (
          <p className="library-desk-count" data-testid="library-desk-count">
            {collection.kind !== 'bookmarks' && (
              <span className="chip" data-testid="library-kind-chip">{KIND_LABEL[collection.kind]}</span>
            )}
            <span className="library-desk-count-num">
              <strong>{bookmarks.length}</strong>
              {' '}{pluralNoun(bookmarks.length, 'bookmark')}
              {filtering ? ' match' : ''}
              {showLayerCount ? ` · ${directBookmarkCount} here` : ''}
            </span>
          </p>
        )}
        <label className="search-field library-desk-search mb-hair-85" data-testid="library-desk-search">
          <span className="visually-hidden">Filter bookmarks</span>
          <Icon name="search" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={BOOKMARK_FILTER_PLACEHOLDER}
            autoComplete="off"
          />
        </label>
        {tagFilter.counts.length > 0 && (
          // The sidebar lists tags on wide screens; phones reach them here.
          <button
            type="button"
            className="btn btn-ghost btn-sm library-desk-tags-button"
            data-testid="library-desk-tags-button"
            aria-haspopup="dialog"
            onClick={onShowAllTags}
          >
            <span aria-hidden>#</span> Tags
          </button>
        )}
        <LibraryViewSwitch gallery={gallery} onGallery={setGallery} />
        {showToolbarSelect && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => enterSelectMode()}>
            Select
          </button>
        )}
        {layerReorder.active ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="library-layer-reorder-done"
            disabled={layerReorder.saving}
            onClick={() => void layerReorder.finish()}
          >
            {layerReorder.saving ? 'Saving…' : 'Done'}
          </button>
        ) : (
          canLayerReorder && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="library-layer-reorder"
              onClick={beginLayerReorder}
            >
              Reorder
            </button>
          )
        )}
      </div>

      <LibraryTagFilterBar filter={tagFilter} />

      <p className="visually-hidden" role="status" aria-live="polite">
        {layerReorder.active
          ? 'Reordering this folder. Drag rows or use arrow keys; press Done or Escape to finish.'
          : ''}
      </p>

      {layerReorder.active ? (
        <ReorderableLayerList
          ids={layerReorder.ids}
          items={reorderItems}
          active
          disabled={layerReorder.ids.length < 2}
          ariaLabel={selectedFolder ? `Reorder ${selectedFolder.title}` : `Reorder ${collection?.title ?? 'collection'}`}
          onActivate={beginLayerReorder}
          onOrderChange={layerReorder.change}
          onDismiss={() => void layerReorder.finish()}
        />
      ) : (
        <>
          {compose && (
        <form className="edit-form panel panel-pad library-compose" data-testid="library-compose" onSubmit={(event) => void onCreate(event)}>
          <h2 className="editor-section-title mt-0">{compose === 'folder' ? 'Add folder' : 'Add bookmark'}</h2>
          {compose === 'bookmark' && (
            <div className="field">
              <label htmlFor="lc-url">URL</label>
              <input
                id="lc-url"
                ref={urlRef}
                value={createUrl}
                onChange={(event) => {
                  setCreateUrl(event.target.value)
                  setCreateUrlError(null)
                }}
                disabled={busy}
                maxLength={4096}
                aria-invalid={createUrlError ? true : undefined}
                aria-describedby={createUrlError ? 'lc-url-error' : undefined}
              />
              {createUrlError && (
                <p id="lc-url-error" className="field-error" role="alert">{createUrlError}</p>
              )}
            </div>
          )}
          <div className="field">
            <label htmlFor="lc-title">
              {compose === 'bookmark' ? 'Title (optional)' : 'Title'}
            </label>
            <input
              id="lc-title"
              ref={titleRef}
              value={createTitle}
              onChange={(event) => {
                setCreateTitle(event.target.value)
                setCreateTitleError(null)
              }}
              disabled={busy}
              maxLength={512}
              aria-invalid={createTitleError ? true : undefined}
              aria-describedby={createTitleError ? 'lc-title-error' : undefined}
            />
            {createTitleError && (
              <p id="lc-title-error" className="field-error" role="alert">{createTitleError}</p>
            )}
          </div>
          <div className="row-end">
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setCompose(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      )}

      {filtering ? (
        bookmarks.length === 0 ? (
          <EmptyState
            illustration="books"
            title="No bookmarks match"
            description={tagFilter.selected.length > 1 && tagFilter.match === 'all' && !query.trim()
              ? 'No bookmark has all of these tags. Remove one, or match any tag.'
              : 'Try another filter or clear the search.'}
            action={
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { setQuery(''); tagFilter.set([]) }}
              >
                Clear filter
              </button>
            }
          />
        ) : (
          renderBookmarkRows(bookmarks)
        )
      ) : layer && layer.folders.length === 0 && layer.bookmarks.length === 0 ? (
        selectedFolder ? (
          <EmptyState
            icon="folder"
            title="This folder is empty"
            description={caps?.createNode
              ? 'Save a link here, or add a folder to group what you collect.'
              : 'Nothing has been added to this folder yet.'}
            action={
              <>
                {caps?.createNode && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => openCompose('bookmark')}>
                    Add bookmark
                  </button>
                )}
                <Link className="btn btn-ghost btn-sm" to={folderPath(deskTrail.at(-1)?.id ?? null)}>
                  Back to {deskTrail.at(-1)?.title ?? collection?.title ?? 'collection'}
                </Link>
              </>
            }
          />
        ) : (
          <EmptyState
            illustration="books"
            title="No bookmarks yet"
            description={caps?.createNode
              ? 'Save a link here, or add a folder first to group what you collect.'
              : 'Bookmarks added to this collection will appear here.'}
            action={caps?.createNode ? (
              <>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => openCompose('bookmark')}>
                  Add your first bookmark
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => openCompose('folder')}>
                  Add a folder
                </button>
              </>
            ) : undefined}
          />
        )
      ) : (
        <>
          {/* The current layer, public-page style: subfolder rows
              first, then the bookmarks that live right here. */}
          {folderCards.length > 0 && (
            <FolderEntries
              view={gallery ? 'gallery' : compact ? 'compact' : 'list'}
              className="library-folder-layer"
              countNoun="bookmark"
              items={folderCards.map(({ node, inside, folderCount, covers }) => ({
                id: node.id,
                title: node.title,
                directCount: inside.length,
                to: folderPath(node.id),
                description: node.description,
                folderCount,
                covers: gallery ? covers : undefined,
              }))}
              renderActions={canFolderActions ? (item) => {
                const node = folderNodes.get(item.id)
                if (!node) return null
                return (
                  <LibraryFolderMenu
                    title={node.title}
                    canMove={Boolean(caps?.moveNode)}
                    canDelete={Boolean(caps?.deleteNode)}
                    onEdit={() => onEditNode(node.id)}
                    onMove={() => setPicker({ mode: 'move', nodes: [node] })}
                    onDelete={() => void requestDelete([node])}
                  />
                )
              } : undefined}
            />
          )}
          {layer && layer.bookmarks.length > 0 && (
            renderBookmarkRows(layer.bookmarks.map((node) => ({ node, folder: '' })))
          )}
        </>
      )}
        </>
      )}

      {bulkBar}
    </>
  )
}
