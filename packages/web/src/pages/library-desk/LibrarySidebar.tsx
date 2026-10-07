import { Link } from 'react-router-dom'
import { LoadingState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { LoadMoreButton } from '../../components/LoadMoreButton'
import { ReorderableNavList } from '../../components/ReorderableNavList'
import type { LibraryOrderSectionId } from '../../lib/libraryOrder'
import type { useFollowedCollections } from '../../lib/useFollowedCollections'
import type { useFollowedReports } from '../../lib/useFollowedReports'
import type { useMyCollaborationInvites } from '../../lib/useMyCollaborationInvites'
import type { useMyReports } from '../../lib/useMyReports'
import type { useOwnedCollections } from '../../lib/useOwnedCollections'
import type { useSharedCollections } from '../../lib/useSharedCollections'
import { collectionIsExpanded, followedKey, type LibraryDeskData } from './data'
import {
  CollectionBranch,
  FollowedUnavailableRow,
  LibraryNavMark,
  LibraryNavSection,
} from './navTree'
import type { LibraryDeskOrder } from './ordering'
import { LibraryTagSection, type LibraryTagFilter } from './tags'

export function LibrarySidebar({
  folderId,
  reading,
  readingEnabled,
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
  layerReorderActive,
  selectMode,
  onAcceptInvite,
  onDeclineInvite,
  tagFilter,
  onShowAllTags,
}: {
  folderId: string | null
  reading: boolean
  readingEnabled: boolean
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
  layerReorderActive: boolean
  selectMode: boolean
  onAcceptInvite: (inviteId: string, collectionId: string) => Promise<void>
  onDeclineInvite: (inviteId: string) => Promise<void>
  /** The open collection's tags; null while no bookmark list is on screen. */
  tagFilter: LibraryTagFilter | null
  onShowAllTags: () => void
}) {
  const {
    trees,
    selectedId,
    selectedFollowedSlug,
    toggleExpanded,
  } = data
  const {
    collapsedSections,
    reorderSection,
    orderedOwnedItems,
    orderedSharedItems,
    orderedFollowedItems,
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
      selectedFollowedSlug,
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
      aria-label="Your collections"
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
          <h3 className="section-label">Collections</h3>
        </div>
      </div>

      {/* Create and Reading sit under the heading, not at the foot of the
          tree: with a few sections open the foot fell below the fold, and
          "New collection" is the first thing a new library needs. */}
      <div className="library-nav-actions">
        <Link to="/library/new" className="library-nav-create">
          <Icon name="plus" />
          New collection
        </Link>
        {readingEnabled && (
          <Link
            to="/library?view=reading"
            className="library-nav-reading"
            aria-current={reading ? 'page' : undefined}
          >
            <Icon name="book" />
            Reading
          </Link>
        )}
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
        title="My collections"
        collapsed={collapsedSections.has('mine')}
        onToggle={() => toggleSection('mine')}
        reordering={reorderSection === 'mine'}
        canReorder={orderedOwnedItems.length >= 2}
        onBeginReorder={() => beginReorder('mine')}
        onFinishReorder={() => finishReorder()}
      >
        {collections.state === 'error' && collections.items.length === 0 ? (
          <p className="library-nav-hint" role="alert">{collections.message}</p>
        ) : (
          <ReorderableNavList
            ids={orderedOwnedItems.map((item) => item.collection.id)}
            items={orderedOwnedItems.map((item) => ({
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
            active={reorderSection === 'mine'}
            disabled={orderedOwnedItems.length < 2}
            ariaLabel="Collection folders"
            onActivate={() => beginReorder('mine')}
            onOrderChange={(ids) => setSectionIds('mine', ids)}
            onDismiss={() => finishReorder()}
          />
        )}
        {collections.items.length > 0 && collections.hasMore && (
          <LoadMoreButton
            className="library-nav-more"
            loading={collections.isLoadingMore}
            onClick={() => void collections.loadMore()}
          />
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

      {collectionFollowExposed && (
        <LibraryNavSection
          sectionId="following"
          title="Following"
          collapsed={collapsedSections.has('following')}
          onToggle={() => toggleSection('following')}
          reordering={reorderSection === 'following'}
          canReorder={orderedFollowedItems.length >= 2}
          onBeginReorder={() => beginReorder('following')}
          onFinishReorder={() => finishReorder()}
        >
          {followed.status === 'unavailable' ? (
            <p className="library-nav-hint">Following isn&apos;t available yet.</p>
          ) : followed.status === 'error' && followed.items.length === 0 ? (
            <div className="library-nav-hint" role="alert">
              Couldn&apos;t load collections you follow.
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void followed.loadFirstPage()}
              >
                Try again
              </button>
            </div>
          ) : followed.status === 'loading' && followed.items.length === 0 ? (
            <LoadingState label="Loading following…" />
          ) : followed.items.length === 0 ? (
            <p className="library-nav-hint">You aren&apos;t following any collections yet.</p>
          ) : (
            <ReorderableNavList
              ids={orderedFollowedItems.map((item) => item.collectionId)}
              items={orderedFollowedItems.map((item) => ({
                id: item.collectionId,
                label: item.title,
                node: item.availability === 'unavailable' ? (
                  <FollowedUnavailableRow title={item.title} />
                ) : (
                  <CollectionBranch
                    collection={{ id: followedKey(item.slug), title: item.title }}
                    linkTo={`/library/following/${encodeURIComponent(item.slug)}`}
                    folderLinkTo={(folder) =>
                      `/library/following/${encodeURIComponent(item.slug)}?folder=${encodeURIComponent(folder)}`}
                    selectedId={selectedId}
                    folderId={folderId}
                    expanded={isExpanded(followedKey(item.slug))}
                    tree={trees[followedKey(item.slug)]}
                    onToggle={() => toggleExpanded(followedKey(item.slug), isExpanded(followedKey(item.slug)))}
                  />
                ),
              }))}
              active={reorderSection === 'following'}
              disabled={orderedFollowedItems.length < 2}
              ariaLabel="Followed collections"
              onActivate={() => beginReorder('following')}
              onOrderChange={(ids) => setSectionIds('following', ids)}
              onDismiss={() => finishReorder()}
            />
          )}
          {followed.nextCursor && !followed.moreError && (
            <LoadMoreButton
              className="library-nav-more"
              loading={followed.loadingMore}
              onClick={() => void followed.loadMore()}
            />
          )}
          {followed.moreError && (
            <div className="library-nav-hint" role="alert">
              Couldn't load more followed collections.
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void followed.loadMore()}
              >
                Try again
              </button>
            </div>
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

      {/* Digests — two sub-groups (R10-05/36): Mine lists the curator's own
          series (each opens its manage page) plus the New digest entry, so
          the section is always present once reports are exposed; Following
          keeps the reader-facing rows, only when the reader actually
          follows at least one — no empty-state advertising there. The
          section head and rows share the collection sections' anatomy
          (R12-14); the void toggle keeps the book and New digest icons on
          the folder icon column. */}
      {reportsExposed && (
        <LibraryNavSection
          sectionId="digests"
          title="Digests"
          collapsed={collapsedSections.has('digests')}
          onToggle={() => toggleSection('digests')}
        >
          <p className="library-nav-sub">Mine</p>
          <div className="library-nav-tree" role="list" aria-label="My digests">
            {myDigests.items.map((series) => (
              <div className="library-nav-group" role="listitem" key={series.id}>
                <div className="library-nav-row">
                  <span className="library-nav-toggle library-nav-toggle--void" aria-hidden />
                  <Link
                    className="library-nav-link"
                    to={`/library/digests/${encodeURIComponent(series.id)}`}
                  >
                    <span className="library-nav-icon" aria-hidden>
                      <Icon name="book" />
                    </span>
                    <span className="library-nav-label" title={series.title}>{series.title}</span>
                  </Link>
                </div>
              </div>
            ))}
          </div>
          <div className="library-nav-row">
            <span className="library-nav-toggle library-nav-toggle--void" aria-hidden />
            <Link to="/library/digests?new=1" className="library-nav-link">
              <span className="library-nav-icon" aria-hidden>
                <Icon name="plus" />
              </span>
              <span className="library-nav-label">New digest</span>
            </Link>
          </div>
          {digests.items.some((series) => series.hiddenPublic === true || series.slug != null) && (
            <>
              <p className="library-nav-sub">Following</p>
              <div className="library-nav-tree" role="list" aria-label="Followed digests">
                {digests.items.map((series) => {
                  // #21: a moderation-hidden digest keeps its sidebar slot as
                  // an inert row instead of vanishing from Following.
                  if (series.hiddenPublic === true) {
                    return (
                      <div className="library-nav-group" role="listitem" key={series.id} data-digest-hidden>
                        <div className="library-nav-row library-nav-row--tombstone">
                          <span className="library-nav-toggle library-nav-toggle--void" aria-hidden />
                          <span className="library-nav-link" title={series.title}>
                            <span className="library-nav-icon" aria-hidden>
                              <Icon name="book" />
                            </span>
                            <span className="library-nav-label">{series.title}</span>
                          </span>
                        </div>
                      </div>
                    )
                  }
                  // A followed series without a public slug (private membership)
                  // has no public page to open — skip the row.
                  const slug = series.slug
                  if (!slug) return null
                  return (
                    <div className="library-nav-group" role="listitem" key={series.id}>
                      <div className="library-nav-row">
                        <span className="library-nav-toggle library-nav-toggle--void" aria-hidden />
                        <Link
                          className="library-nav-link"
                          to={`/reports/${encodeURIComponent(slug)}`}
                        >
                          <span className="library-nav-icon" aria-hidden>
                            <Icon name="book" />
                          </span>
                          <span className="library-nav-label" title={series.title}>{series.title}</span>
                        </Link>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </LibraryNavSection>
      )}

    </aside>
  )
}
