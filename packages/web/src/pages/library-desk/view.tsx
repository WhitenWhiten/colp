import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  flattenBookmarks,
  folderTrail,
  hostOf,
  immediateEntries,
  type BookmarkRow,
} from '../../lib/libraryTree'
import { countTags, matchesTags, readTagParams, tagKey, writeTagParams, type TagMatch } from '../../lib/libraryTags'
import { useBookmarkDrag } from '../../lib/useBookmarkDrag'
import { PageShell } from '../../components/PageShell'
import { useUiDensity } from '../../lib/useUiDensity'
import type { useFollowedCollections } from '../../lib/useFollowedCollections'
import type { useFollowedReports } from '../../lib/useFollowedReports'
import type { useMyCollaborationInvites } from '../../lib/useMyCollaborationInvites'
import type { useMyReports } from '../../lib/useMyReports'
import type { useOwnedCollections } from '../../lib/useOwnedCollections'
import type { useSharedCollections } from '../../lib/useSharedCollections'
import { BookmarkArea } from './BookmarkArea'
import { BulkActionBar } from './BulkActionBar'
import type { LibraryDeskData } from './data'
import type { LibraryLayerReorder } from './layerReorder'
import { LibraryHeader } from './LibraryHeader'
import { LibraryOverlays } from './LibraryOverlays'
import { LibrarySidebar } from './LibrarySidebar'
import type { LibraryDeskMutations } from './mutations'
import type { LibraryDeskOrder } from './ordering'
import type { LibraryDeskSelection } from './selection'
import { useLibraryDeskSplit } from './split'
import { LibraryBulkTagDialog, LibraryTagPicker, type LibraryTagFilter } from './tags'

export type LibraryDeskViewProps = {
  reading: boolean
  readingPane: ReactNode
  readingEnabled: boolean
  folderId: string | null
  collaboratorsLive: boolean
  collectionFollowExposed: boolean
  reportsExposed: boolean
  showInviteNav: boolean
  collections: ReturnType<typeof useOwnedCollections>
  shared: ReturnType<typeof useSharedCollections>
  followed: ReturnType<typeof useFollowedCollections>
  digests: ReturnType<typeof useFollowedReports>
  myDigests: ReturnType<typeof useMyReports>
  invites: ReturnType<typeof useMyCollaborationInvites>
  data: LibraryDeskData
  order: LibraryDeskOrder
  layerReorder: LibraryLayerReorder
  selection: LibraryDeskSelection
  mutations: LibraryDeskMutations
  onAcceptInvite: (inviteId: string, collectionId: string) => Promise<void>
  onDeclineInvite: (inviteId: string) => Promise<void>
  /** Opens the FE-04 node edit drawer (owned by LibraryDesk). */
  onEditNode: (nodeId: string) => void
  onEditCollection: () => void
}

export function LibraryDeskView({
  reading,
  readingPane,
  readingEnabled,
  folderId,
  collaboratorsLive,
  collectionFollowExposed,
  reportsExposed,
  showInviteNav,
  collections,
  shared,
  followed,
  digests,
  myDigests,
  invites,
  data,
  order,
  layerReorder,
  selection,
  mutations,
  onAcceptInvite,
  onDeclineInvite,
  onEditNode,
  onEditCollection,
}: LibraryDeskViewProps) {
  const [density] = useUiDensity()
  const compact = density === 'compact'
  const [query, setQuery] = useState('')
  const split = useLibraryDeskSplit()

  const { selectedId, snap, selectedFolder, caps } = data
  const { reorderSection } = order
  const { active: layerReorderActive } = layerReorder
  const {
    selectMode,
    selectedIds,
    bulkbarMounted,
    bulkbarClosing,
    setPicker,
    bulk,
    selectAll,
    exitSelectMode,
  } = selection
  const { runMove, runTag, requestDelete } = mutations

  useEffect(() => {
    setQuery('')
  }, [selectedId, folderId, reading])

  /* Tags cut across folders: choosing one leaves the folder for a flat view
     of the whole collection, and the choice lives in the URL (?tag=…). */
  const [searchParams, setSearchParams] = useSearchParams()
  const { tags: selectedTags, match: tagMatch } = useMemo(() => readTagParams(searchParams), [searchParams])
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const [bulkTagging, setBulkTagging] = useState<BookmarkRow['node'][] | null>(null)
  const tagCounts = useMemo(
    () => (snap ? countTags(flattenBookmarks(snap.root, snap.nodes, null).map(({ node }) => node)) : []),
    [snap],
  )
  const setTags = useCallback((tags: string[], match?: TagMatch) => {
    setSearchParams((prev) => {
      const next = writeTagParams(prev, tags, match ?? (prev.get('tagmatch') === 'any' ? 'any' : 'all'))
      if (tags.length > 0) next.delete('folder')
      return next
    })
  }, [setSearchParams])
  const tagFilter = useMemo<LibraryTagFilter>(() => {
    const keys = new Set(selectedTags.map(tagKey))
    return {
      counts: tagCounts,
      selected: selectedTags,
      match: tagMatch,
      set: setTags,
      isSelected: (tag) => keys.has(tagKey(tag)),
    }
  }, [selectedTags, setTags, tagCounts, tagMatch])
  const filtering = Boolean(query.trim()) || selectedTags.length > 0

  /* The whole current subtree, flattened — search scope and totals. A query
     or tag filter renders these rows directly (each labelled with its
     folder); otherwise the desk shows the layered view below instead. */
  const bookmarks = useMemo(() => {
    if (!snap) return [] as BookmarkRow[]
    const rows = flattenBookmarks(snap.root, snap.nodes, folderId)
      .filter(({ node }) => matchesTags(node.tags, selectedTags, tagMatch))
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(({ node, folder }) => {
      return node.title.toLowerCase().includes(q)
        || hostOf(node.url).toLowerCase().includes(q)
        || folder.toLowerCase().includes(q)
        // Comfort cards display the description, and the public collection
        // filter and global search both match it — the desk must agree.
        || (node.description ?? '').toLowerCase().includes(q)
        || (node.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
    })
  }, [folderId, query, selectedTags, snap, tagMatch])

  const deskTrail = useMemo(
    () => (snap && selectedFolder ? folderTrail(snap.root, snap.nodes, selectedFolder.id) : []),
    [snap, selectedFolder],
  )

  const selectedNodes = useMemo(
    () => bookmarks.filter(({ node }) => selectedIds.has(node.id)).map(({ node }) => node),
    [bookmarks, selectedIds],
  )

  // Rows on screen. A search replaces the layer with the filtered subtree,
  // which is also the list selectedNodes can act on — N has to match those ids.
  const layerBookmarkIds = useMemo(() => {
    if (filtering) return bookmarks.map(({ node }) => node.id)
    if (!snap) return []
    return immediateEntries(snap.root, snap.nodes, folderId).bookmarks.map((node) => node.id)
  }, [bookmarks, filtering, folderId, snap])

  const dragEnabled = !reading && !data.selectedFollowedSlug && Boolean(caps?.moveNode)

  // Desktop-only drag of bookmark rows onto sidebar folders / the current
  // collection root. Drops append (afterId/beforeId null) through the same
  // sequential runMove executor as the P0 picker; a dragged row that sits in
  // the current multi-selection carries the whole selection with it. Sidebar
  // reorder and layer reorder are mutually exclusive with each other and
  // with this drag.
  const drag = useBookmarkDrag({
    suppressed: reorderSection !== null || layerReorderActive || bulk !== null,
    nodesForRow: (node) =>
      selectMode && selectedIds.has(node.id) && selectedNodes.length > 0 ? selectedNodes : [node],
    resolveTarget: (element, nodes) => {
      if (!snap) return null
      const anchor = element.closest('a[data-folder-id], a[data-collection-id]')
      if (!anchor) return null
      const dropFolderId = anchor.getAttribute('data-folder-id')
      if (dropFolderId) {
        const ownFolder = snap.nodes.some((n) => n.id === dropFolderId && n.kind === 'folder')
        // Foreign collections and the bookmarks' current folder are inert.
        if (!ownFolder || nodes.every((n) => n.parentId === dropFolderId)) return null
        return { element: anchor.closest('.library-nav-row') ?? anchor, parentId: dropFolderId }
      }
      if (anchor.getAttribute('data-collection-id') !== snap.collection.id) return null
      if (nodes.every((n) => n.parentId === snap.root.id)) return null
      return { element: anchor.closest('.library-nav-row') ?? anchor, parentId: snap.root.id }
    },
    onDrop: (nodes, parentId) => {
      if (!snap) return
      void runMove(nodes, {
        collectionId: snap.collection.id,
        parentId,
        collectionTitle: snap.collection.title,
        parentTitle: parentId === snap.root.id
          ? null
          : snap.nodes.find((node) => node.id === parentId)?.title ?? null,
      })
    },
  })

  return (
    <PageShell
      variant="bare"
      data-testid="library-workspace"
      data-layer-reordering={layerReorderActive || undefined}
    >
      <div className="library-desk" style={split.style}>
        <LibrarySidebar
          folderId={folderId}
          reading={reading}
          readingEnabled={readingEnabled}
          collaboratorsLive={collaboratorsLive}
          collectionFollowExposed={collectionFollowExposed}
          reportsExposed={reportsExposed}
          showInviteNav={showInviteNav}
          collections={collections}
          shared={shared}
          followed={followed}
          digests={digests}
          myDigests={myDigests}
          invites={invites}
          data={data}
          order={order}
          layerReorderActive={layerReorderActive}
          selectMode={selectMode}
          onAcceptInvite={onAcceptInvite}
          onDeclineInvite={onDeclineInvite}
          tagFilter={reading ? null : tagFilter}
          onShowAllTags={() => setTagPickerOpen(true)}
        />
        <div
          {...split.dividerProps}
          ref={split.dividerRef}
          className="library-desk-divider"
          data-dragging={split.dragging || undefined}
          data-testid="library-desk-divider"
        />
        <div className="library-desk-stack" data-testid="library-desk-stack">
          <div className="library-main" data-testid="library-main">
            <LibraryHeader
              reading={reading}
              readingEnabled={readingEnabled}
              folderId={folderId}
              bookmarkCount={bookmarks.length}
              collaboratorsLive={collaboratorsLive}
              collectionFollowExposed={collectionFollowExposed}
              reportsExposed={reportsExposed}
              showInviteNav={showInviteNav}
              invites={invites}
              data={data}
              deskTrail={deskTrail}
              openCompose={mutations.openCompose}
              onEditCollection={onEditCollection}
              order={order}
              onAcceptInvite={onAcceptInvite}
              onDeclineInvite={onDeclineInvite}
            />
            {reading ? readingPane : (
              <BookmarkArea
                query={query}
                setQuery={setQuery}
                filtering={filtering}
                tagFilter={tagFilter}
                onShowAllTags={() => setTagPickerOpen(true)}
                compact={compact}
                folderId={folderId}
                collections={collections}
                shared={shared}
                data={data}
                order={order}
                layerReorder={layerReorder}
                selection={selection}
                mutations={mutations}
                bookmarks={bookmarks}
                deskTrail={deskTrail}
                dragEnabled={dragEnabled}
                rowPointerDown={drag.rowPointerDown}
                onEditNode={onEditNode}
                onEditCollection={onEditCollection}
                bulkBar={(
                  <BulkActionBar
                    mounted={bulkbarMounted}
                    closing={bulkbarClosing}
                    bulk={bulk}
                    selectedNodes={selectedNodes}
                    canMove={Boolean(caps?.moveNode)}
                    canDelete={Boolean(caps?.deleteNode)}
                    canTag={Boolean(caps?.updateNode) && !data.selectedFollowedSlug}
                    onMove={(nodes) => setPicker({ mode: 'move', nodes })}
                    onTag={setBulkTagging}
                    onCopy={(nodes) => setPicker({ mode: 'copy', nodes })}
                    onDelete={(nodes) => void requestDelete(nodes)}
                    onCancel={exitSelectMode}
                    selectAll={selectAll}
                    layerBookmarkIds={layerBookmarkIds}
                  />
                )}
              />
            )}
          </div>
        </div>
      </div>

      {drag.ghost && (
        <div
          className="library-drag-ghost"
          ref={drag.attachGhost}
          data-testid="library-drag-ghost"
          aria-hidden
        >
          <span className="library-drag-ghost-title">{drag.ghost.title}</span>
          {drag.ghost.count > 1 && (
            <span className="library-drag-ghost-count">{drag.ghost.count}</span>
          )}
        </div>
      )}

      <LibraryBulkTagDialog
        nodes={bulkTagging}
        vocabulary={tagCounts}
        onClose={() => setBulkTagging(null)}
        onApply={(change) => {
          const nodes = bulkTagging ?? []
          setBulkTagging(null)
          void runTag(nodes, change)
        }}
      />
      <LibraryTagPicker open={tagPickerOpen && !reading} onClose={() => setTagPickerOpen(false)} filter={tagFilter} />

      <LibraryOverlays
        collections={collections}
        shared={shared}
        snap={snap}
        selection={selection}
        mutations={mutations}
      />
    </PageShell>
  )
}
