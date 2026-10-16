import { Icon } from '../../components/Icon'
import { LoadMoreButton } from '../../components/LoadMoreButton'
import { ReorderableNavList } from '../../components/ReorderableNavList'
import type { LibraryOrderSectionId } from '../../lib/libraryOrder'
import type { useMyCollaborationInvites } from '../../lib/useMyCollaborationInvites'
import type { useLibrary } from '../../lib/useLibrary'
import type { useSharedCollections } from '../../lib/useSharedCollections'
import { collectionIsExpanded, type LibraryDeskData } from './data'
import { CollectionBranch, LibraryNavMark, LibraryNavSection } from './navTree'
import type { LibraryDeskOrder } from './ordering'
import { LibraryTagSection, type LibraryTagFilter } from './tags'

export function LibrarySidebar({
  folderId,
  collaboratorsLive,
  showInviteNav,
  collections,
  shared,
  invites,
  data,
  order,
  layerReorderActive,
  selectMode,
  onAcceptInvite,
  onDeclineInvite,
  tagFilter,
  onShowAllTags,
  onNewFolder,
}: {
  folderId: string | null
  collaboratorsLive: boolean
  showInviteNav: boolean
  collections: ReturnType<typeof useLibrary>
  shared: ReturnType<typeof useSharedCollections>
  invites: ReturnType<typeof useMyCollaborationInvites>
  data: LibraryDeskData
  order: LibraryDeskOrder
  layerReorderActive: boolean
  selectMode: boolean
  onAcceptInvite: (inviteId: string, collectionId: string) => Promise<void>
  onDeclineInvite: (inviteId: string) => Promise<void>
  /** The open collection's tags; null while no bookmark list is on screen. */
  tagFilter: LibraryTagFilter | null
  onShowAllTags: () => void
  onNewFolder: () => void
}) {
  const {
    trees,
    selectedId,
    toggleExpanded,
  } = data
  const {
    collapsedSections,
    reorderSection,
    orderedSharedItems,
    setSectionIds,
    finishReorder,
    toggleSection,
  } = order

  const isExpanded = (id: string) =>
    collectionIsExpanded(
      id,
      data.expanded,
      reorderSection,
      selectedId,
      data.userCollapsed,
    )

  const beginReorder = (section: LibraryOrderSectionId) => {
    // Bookmark selection, layer reorder and sidebar reorder are mutually
    // exclusive modes.
    if (selectMode || layerReorderActive || document.body.hasAttribute('data-bookmark-drag')) return
    order.beginReorder(section)
  }

  return (
    <aside
      className={reorderSection ? 'library-nav is-reordering' : 'library-nav'}
      aria-label="Your library"
      data-testid="library-nav"
      data-library-reordering={reorderSection || undefined}
    >
      <p className="visually-hidden" aria-live="polite">
        {reorderSection
          ? 'Reordering collections. Drag rows or use arrow keys; press Done or Escape to finish.'
          : ''}
      </p>
      <div className="library-nav-head">
        <LibraryNavMark />
        <div>
          <h3 className="section-label">Library</h3>
        </div>
      </div>

      <div className="library-nav-actions">
        <button type="button" className="library-nav-create" onClick={onNewFolder} disabled={!data.caps?.createNode}>
          <Icon name="plus" />New folder
        </button>
      </div>

      {showInviteNav && (
        <section className="library-nav-section" data-testid="library-nav-invites">
          <h3 className="section-label">Invitations</h3>
          {invites.state === 'error' && invites.items.length === 0 ? (
            <p className="library-nav-hint" role="alert">{invites.message}</p>
          ) : (
            <div className="library-nav-tree" aria-label="Pending invitations">
              {invites.items.map((invite) => (
                <div className="library-nav-group" key={invite.inviteId}>
                  <div className="library-nav-row">
                    <span className="library-nav-label" title={invite.collectionTitle}>{invite.collectionTitle}</span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      aria-label={`Accept invitation to ${invite.collectionTitle}`}
                      disabled={invites.pendingInviteId === invite.inviteId}
                      onClick={() => void onAcceptInvite(invite.inviteId, invite.collectionId)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={`Decline invitation to ${invite.collectionTitle}`}
                      disabled={invites.pendingInviteId === invite.inviteId}
                      onClick={() => void onDeclineInvite(invite.inviteId)}
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <LibraryNavSection
        sectionId="mine"
        title="Bookmarks"
        collapsed={collapsedSections.has('mine')}
        onToggle={() => toggleSection('mine')}
        reordering={reorderSection === 'mine'}
        canReorder={false}
        onBeginReorder={() => beginReorder('mine')}
        onFinishReorder={() => finishReorder()}
      >
        {collections.state === 'error' && !collections.library ? (
          <p className="library-nav-hint" role="alert">{collections.message}</p>
        ) : (
          <div role="list" aria-label="Library folders">
            {collections.library && <CollectionBranch collection={collections.library}
              selectedId={selectedId} folderId={folderId} expanded={isExpanded(collections.library.id)}
              tree={trees[collections.library.id]} onToggle={() => toggleExpanded(collections.library!.id, isExpanded(collections.library!.id))} listItem />}

          </div>
        )}

      </LibraryNavSection>

      {collaboratorsLive && (
        <LibraryNavSection
          sectionId="shared"
          title="Shared with you"
          collapsed={collapsedSections.has('shared')}
          onToggle={() => toggleSection('shared')}
          reordering={reorderSection === 'shared'}
          canReorder={orderedSharedItems.length >= 2}
          onBeginReorder={() => beginReorder('shared')}
          onFinishReorder={() => finishReorder()}
        >
          {shared.state === 'error' && shared.items.length === 0 ? (
            <p className="library-nav-hint" role="alert">{shared.message}</p>
          ) : shared.items.length === 0 ? (
            <p className="library-nav-hint">Nothing is shared with you yet.</p>
          ) : (
            <ReorderableNavList
              ids={orderedSharedItems.map((item) => item.collection.id)}
              items={orderedSharedItems.map((item) => ({
                id: item.collection.id,
                label: item.collection.title,
                node: (
                  <CollectionBranch
                    collection={item.collection}
                    bookmarkCount={item.bookmarkCount}
                    selectedId={selectedId}
                    folderId={folderId}
                    expanded={isExpanded(item.collection.id)}
                    tree={trees[item.collection.id]}
                    onToggle={() => toggleExpanded(item.collection.id, isExpanded(item.collection.id))}
                  />
                ),
              }))}
              active={reorderSection === 'shared'}
              disabled={orderedSharedItems.length < 2}
              ariaLabel="Shared collections"
              onActivate={() => beginReorder('shared')}
              onOrderChange={(ids) => setSectionIds('shared', ids)}
              onDismiss={() => finishReorder()}
            />
          )}
          {shared.items.length > 0 && shared.hasMore && (
            <LoadMoreButton
              className="library-nav-more"
              loading={shared.isLoadingMore}
              onClick={() => void shared.loadMore()}
            />
          )}
        </LibraryNavSection>
      )}

      {tagFilter && (
        <LibraryTagSection
          filter={tagFilter}
          collapsed={collapsedSections.has('tags')}
          onToggle={() => toggleSection('tags')}
          onShowAll={onShowAllTags}
        />
      )}
    </aside>
  )
}
