import { SubscribeButton } from '../../components/bookmark-subscriptions/SubscribeButton'
import { useId, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { CollectionVisibility } from '../../api'
import { ClampedText } from '../../components/ClampedText'
import { FolderTrail } from '../../components/FolderTrail'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { PageHead } from '../../components/PageHead'
import { StatusBadge, type StatusTone } from '../../components/StatusBadge'
import type { FolderNode } from '../../lib/libraryTree'
import { plural } from '../../lib/plural'
import type { useMyCollaborationInvites } from '../../lib/useMyCollaborationInvites'
import { collectionIsExpanded, followedKey, type LibraryDeskData } from './data'
import { LibraryMoreMenu } from './menus'
import type { LibraryDeskMutations } from './mutations'
import { CollectionBranch } from './navTree'
import { ReorderableNavList } from '../../components/ReorderableNavList'
import type { LibraryDeskOrder } from './ordering'

/* private | protected | unlisted | public. Anything past public/unlisted
   stays muted; protected and later values use their capitalized name. */
function collectionVisibilityBadge(visibility: CollectionVisibility): { tone: StatusTone; label: string } {
  if (visibility === 'public') return { tone: 'success', label: 'Public' }
  if (visibility === 'unlisted') return { tone: 'accent', label: 'Unlisted' }
  if (visibility === 'private') return { tone: 'muted', label: 'Private' }
  return { tone: 'muted', label: visibility.charAt(0).toUpperCase() + visibility.slice(1) }
}

export function LibraryHeader({
  reading,
  readingEnabled,
  folderId,
  bookmarkCount,
  collaboratorsLive,
  collectionFollowExposed,
  reportsExposed,
  showInviteNav,
  invites,
  data,
  order,
  deskTrail,
  openCompose,
  onEditCollection,
  onAcceptInvite,
  onDeclineInvite,
}: {
  reading: boolean
  readingEnabled: boolean
  folderId: string | null
  bookmarkCount: number
  collaboratorsLive: boolean
  collectionFollowExposed: boolean
  reportsExposed: boolean
  showInviteNav: boolean
  invites: ReturnType<typeof useMyCollaborationInvites>
  data: LibraryDeskData
  order?: LibraryDeskOrder
  deskTrail: FolderNode[]
  openCompose: LibraryDeskMutations['openCompose']
  onEditCollection: () => void
  onAcceptInvite: (inviteId: string, collectionId: string) => Promise<void>
  onDeclineInvite: (inviteId: string) => Promise<void>
}) {
  const navigate = useNavigate()
  const {
    selectedId,
    selectedFollowedSlug,
    selectedFolder,
    collection,
    caps,
    collectionBasePath,
    folderPath,
  } = data

  const heading = reading
    ? 'Reading'
    : selectedFolder?.title ?? collection?.title ?? 'Library'
  const lede = reading
    ? 'Saved bookmarks and reading progress, in one place.'
    : selectedFolder
      ? `${plural(bookmarkCount, 'bookmark')} in ${collection?.title ?? 'this collection'}.`
      : collection?.summary || 'Bookmarks in this collection.'

  const onMobileChange = (value: string) => {
    if (value === 'reading') {
      navigate('/library?view=reading')
      return
    }
    if (value.startsWith('following::')) {
      const rest = value.slice('following::'.length)
      const [slug, nextFolder] = rest.split('::')
      if (!slug) return
      navigate(nextFolder
        ? `/library/following/${encodeURIComponent(slug)}?folder=${encodeURIComponent(nextFolder)}`
        : `/library/following/${encodeURIComponent(slug)}`)
      return
    }
    const [nextCollection, nextFolder] = value.split('::')
    if (!nextCollection) return
    navigate(nextFolder
      ? `/library/${encodeURIComponent(nextCollection)}?folder=${encodeURIComponent(nextFolder)}`
      : `/library/${encodeURIComponent(nextCollection)}`)
  }

  /* Standing inside a folder: the trail rides the page head's breadcrumb
     slot (above the title, the conventional spot) and climbs back level by
     level with the same language as the public collection page. */
  const folderTrail = !reading && selectedFolder && collection
    ? (
      <FolderTrail
        testId="library-folder-trail"
        rootTitle={collection.title}
        rootTo={collectionBasePath}
        crumbs={deskTrail.map((node) => ({ id: node.id, title: node.title, to: folderPath(node.id) }))}
        currentTitle={selectedFolder.title}
        backTo={folderPath(deskTrail.at(-1)?.id ?? null)}
      />
    )
    : undefined

  const publicSlug =
    collection && (collection.visibility === 'public' || collection.visibility === 'unlisted')
      ? collection.publicationSlug
      : null
  const visibilityBadge = !reading && collection && !selectedFollowedSlug
    ? collectionVisibilityBadge(collection.visibility)
    : null

  return (
    <>
      <LibraryMobileNav
        heading={heading}
        reading={reading}
        readingEnabled={readingEnabled}
        folderId={folderId}
        collaboratorsLive={collaboratorsLive}
        collectionFollowExposed={collectionFollowExposed}
        reportsExposed={reportsExposed}
        showInviteNav={showInviteNav}
        invites={invites}
        data={data}
        order={order}
        onChange={onMobileChange}
        onAcceptInvite={onAcceptInvite}
        onDeclineInvite={onDeclineInvite}
      />

      <PageHead
        className="library-desk-head"
        layout="split"
        variant="workbench"
        eyebrow="Library"
        breadcrumb={folderTrail}
        title={heading}
        afterTitle={visibilityBadge ? (
          <StatusBadge tone={visibilityBadge.tone} data-testid="library-visibility">{visibilityBadge.label}</StatusBadge>
        ) : undefined}
        documentTitle={heading}
        actions={
          <>
            {!reading && collection?.id && <SubscribeButton sourceType="collection" sourceId={collection.id} />}
            {!reading && selectedId && (
              <LibraryMoreMenu
                caps={caps}
                selectedId={selectedId}
                followedSlug={selectedFollowedSlug}
                publicSlug={publicSlug}
                collaboratorsLive={collaboratorsLive}
                onCompose={openCompose}
                onEditCollection={onEditCollection}
              />
            )}
            {reading && (
              <Link to="/library/new" className="btn btn-primary btn-sm">New collection</Link>
            )}
          </>
        }
      >
        <ClampedText
          text={lede}
          className="lede"
          wrapperClassName="library-desk-lede"
          toggleClassName="library-desk-lede-toggle"
        />
      </PageHead>
    </>
  )
}

function LibraryMobileNav({
  heading,
  reading,
  readingEnabled,
  folderId,
  collaboratorsLive,
  collectionFollowExposed,
  reportsExposed,
  showInviteNav,
  invites,
  data,
  order,
  onChange,
  onAcceptInvite,
  onDeclineInvite,
}: {
  heading: string
  reading: boolean
  readingEnabled: boolean
  folderId: string | null
  collaboratorsLive: boolean
  collectionFollowExposed: boolean
  reportsExposed: boolean
  showInviteNav: boolean
  invites: ReturnType<typeof useMyCollaborationInvites>
  data: LibraryDeskData
  order?: LibraryDeskOrder
  onChange: (value: string) => void
  onAcceptInvite: (inviteId: string, collectionId: string) => Promise<void>
  onDeclineInvite: (inviteId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const dialogId = useId()
  const {
    selectedId,
    selectedFollowedSlug,
    ownedSidebarItems,
    sharedSidebarItems,
    availableFollowedItems,
    trees,
    expanded,
    userCollapsed,
    toggleExpanded,
  } = data

  const reorderSection = order?.reorderSection ?? null
  const orderedOwned = order ? order.orderedOwnedItems : ownedSidebarItems
  const orderedShared = order ? order.orderedSharedItems : sharedSidebarItems
  const orderedFollowed = order ? order.orderedFollowedItems : availableFollowedItems

  const isExpanded = (id: string) =>
    collectionIsExpanded(id, expanded, reorderSection, selectedId, selectedFollowedSlug, userCollapsed)

  const inviteCount = showInviteNav ? invites.items.length : 0

  const choose = (value: string) => {
    setOpen(false)
    onChange(value)
  }

  return (
    <div className="library-mobile-nav" data-testid="library-mobile-nav">
      <button
        type="button"
        className="library-mobile-switcher"
        data-testid="library-mobile-switcher-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        aria-label={`Collection or folder: ${heading}${inviteCount > 0 ? `, ${plural(inviteCount, 'invitation')} pending` : ''}`}
        onClick={() => setOpen(true)}
      >
        <span className="library-nav-icon" aria-hidden>
          <Icon name={reading ? 'book' : 'folder'} />
        </span>
        <span className="library-mobile-switcher-label">{heading}</span>
        {inviteCount > 0 && (
          <StatusBadge tone="accent" aria-hidden>{inviteCount}</StatusBadge>
        )}
        <Icon name="chevron-down" />
      </button>

      <Modal
        open={open}
        onClose={() => {
          order?.finishReorder()
          setOpen(false)
        }}
        label="Collections"
        title="Collections"
        overlayProps={{ id: dialogId, 'data-testid': 'library-mobile-switcher' }}
      >
        {showInviteNav && invites.state === 'error' && invites.items.length === 0 && (
          <p className="library-nav-hint" role="alert">{invites.message}</p>
        )}
        {showInviteNav && invites.items.length > 0 && (
          <section className="library-mobile-invites" aria-label="Pending invitations">
            <p className="library-nav-sub">Invitations</p>
            {invites.items.map((invite) => (
              <div className="library-mobile-invite" key={invite.inviteId}>
                <span className="library-nav-label" title={invite.collectionTitle}>{invite.collectionTitle}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  aria-label={`Accept invitation to ${invite.collectionTitle}`}
                  disabled={invites.pendingInviteId === invite.inviteId}
                  onClick={() => { setOpen(false); void onAcceptInvite(invite.inviteId, invite.collectionId) }}
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
            ))}
          </section>
        )}
        <div className="library-nav-tree">
            {orderedOwned.length > 0 && (
              <div className="library-mobile-nav-section-head">
                <p className="library-nav-sub">My collections</p>
                {orderedOwned.length >= 2 && order && (
                  reorderSection === 'mine' ? (
                    <button
                      type="button"
                      className="chip chip--rail library-nav-section-action"
                      data-testid="library-nav-mine-done"
                      onClick={() => order.finishReorder()}
                    >
                      Done
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="chip chip--rail library-nav-section-action library-nav-section-action--icon"
                      data-testid="library-nav-mine-reorder"
                      aria-label="Reorder My collections"
                      title="Reorder"
                      onClick={() => order.beginReorder('mine')}
                    >
                      <Icon name="reorder" />
                      <span>Reorder</span>
                    </button>
                  )
                )}
              </div>
            )}
            {reorderSection === 'mine' && order ? (
              <ReorderableNavList
                ids={orderedOwned.map((item) => item.collection.id)}
                items={orderedOwned.map((item) => ({
                  id: item.collection.id,
                  label: item.collection.title,
                  node: (
                    <CollectionBranch
                      collection={item.collection}
                      bookmarkCount={item.bookmarkCount}
                      selectedId={selectedId}
                      folderId={folderId}
                      expanded={false}
                      tree={trees[item.collection.id]}
                      onToggle={() => {}}
                    />
                  ),
                }))}
                active={true}
                disabled={orderedOwned.length < 2}
                ariaLabel="Collection folders"
                onActivate={() => order.beginReorder('mine')}
                onOrderChange={(ids) => order.setSectionIds('mine', ids)}
                onDismiss={() => order.finishReorder()}
              />
            ) : (
              <div role="list" aria-label="My collections">
              {orderedOwned.map((item) => (
                <CollectionBranch
                  listItem
                  key={item.collection.id}
                  collection={item.collection}
                  bookmarkCount={item.bookmarkCount}
                  selectedId={selectedId}
                  folderId={folderId}
                  expanded={isExpanded(item.collection.id)}
                  tree={trees[item.collection.id]}
                  onToggle={() => toggleExpanded(item.collection.id, isExpanded(item.collection.id))}
                  onSelect={choose}
                />
              ))}
              </div>
            )}
            {collaboratorsLive && orderedShared.length > 0 && (
              <>
                <div className="library-mobile-nav-section-head">
                  <p className="library-nav-sub">Shared with you</p>
                  {orderedShared.length >= 2 && order && (
                    reorderSection === 'shared' ? (
                      <button
                        type="button"
                        className="chip chip--rail library-nav-section-action"
                        data-testid="library-nav-shared-done"
                        onClick={() => order.finishReorder()}
                      >
                        Done
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="chip chip--rail library-nav-section-action library-nav-section-action--icon"
                        data-testid="library-nav-shared-reorder"
                        aria-label="Reorder Shared with you"
                        title="Reorder"
                        onClick={() => order.beginReorder('shared')}
                      >
                        <Icon name="reorder" />
                        <span>Reorder</span>
                      </button>
                    )
                  )}
                </div>
                {reorderSection === 'shared' && order ? (
                  <ReorderableNavList
                    ids={orderedShared.map((item) => item.collection.id)}
                    items={orderedShared.map((item) => ({
                      id: item.collection.id,
                      label: item.collection.title,
                      node: (
                        <CollectionBranch
                          collection={item.collection}
                          bookmarkCount={item.bookmarkCount}
                          selectedId={selectedId}
                          folderId={folderId}
                          expanded={false}
                          tree={trees[item.collection.id]}
                          onToggle={() => {}}
                        />
                      ),
                    }))}
                    active={true}
                    disabled={orderedShared.length < 2}
                    ariaLabel="Shared collections"
                    onActivate={() => order.beginReorder('shared')}
                    onOrderChange={(ids) => order.setSectionIds('shared', ids)}
                    onDismiss={() => order.finishReorder()}
                  />
                ) : (
                  <div role="list" aria-label="Shared with you">
                  {orderedShared.map((item) => (
                    <CollectionBranch
                      listItem
                      key={item.collection.id}
                      collection={item.collection}
                      bookmarkCount={item.bookmarkCount}
                      selectedId={selectedId}
                      folderId={folderId}
                      expanded={isExpanded(item.collection.id)}
                      tree={trees[item.collection.id]}
                      onToggle={() => toggleExpanded(item.collection.id, isExpanded(item.collection.id))}
                      onSelect={choose}
                    />
                  ))}
                  </div>
                )}
              </>
            )}
            {collectionFollowExposed && orderedFollowed.length > 0 && (
              <>
                <div className="library-mobile-nav-section-head">
                  <p className="library-nav-sub">Following</p>
                  {orderedFollowed.length >= 2 && order && (
                    reorderSection === 'following' ? (
                      <button
                        type="button"
                        className="chip chip--rail library-nav-section-action"
                        data-testid="library-nav-following-done"
                        onClick={() => order.finishReorder()}
                      >
                        Done
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="chip chip--rail library-nav-section-action library-nav-section-action--icon"
                        data-testid="library-nav-following-reorder"
                        aria-label="Reorder Following"
                        title="Reorder"
                        onClick={() => order.beginReorder('following')}
                      >
                        <Icon name="reorder" />
                        <span>Reorder</span>
                      </button>
                    )
                  )}
                </div>
                {reorderSection === 'following' && order ? (
                  <ReorderableNavList
                    ids={orderedFollowed.map((item) => item.collectionId)}
                    items={orderedFollowed.map((item) => ({
                      id: item.collectionId,
                      label: item.title,
                      node: (
                        <CollectionBranch
                          collection={{ id: followedKey(item.slug), title: item.title }}
                          linkTo={`/library/following/${encodeURIComponent(item.slug)}`}
                          folderLinkTo={(folder) =>
                            `/library/following/${encodeURIComponent(item.slug)}?folder=${encodeURIComponent(folder)}`}
                          selectedId={selectedId}
                          folderId={folderId}
                          expanded={false}
                          tree={trees[followedKey(item.slug)]}
                          onToggle={() => {}}
                        />
                      ),
                    }))}
                    active={true}
                    disabled={orderedFollowed.length < 2}
                    ariaLabel="Followed collections"
                    onActivate={() => order.beginReorder('following')}
                    onOrderChange={(ids) => order.setSectionIds('following', ids)}
                    onDismiss={() => order.finishReorder()}
                  />
                ) : (
                  <div role="list" aria-label="Following">
                  {orderedFollowed.map((item) => (
                    <CollectionBranch
                      listItem
                      key={item.collectionId}
                      collection={{ id: followedKey(item.slug), title: item.title }}
                      linkTo={`/library/following/${encodeURIComponent(item.slug)}`}
                      folderLinkTo={(folder) =>
                        `/library/following/${encodeURIComponent(item.slug)}?folder=${encodeURIComponent(folder)}`}
                      selectedId={selectedId}
                      folderId={folderId}
                      expanded={isExpanded(followedKey(item.slug))}
                      tree={trees[followedKey(item.slug)]}
                      onToggle={() => toggleExpanded(followedKey(item.slug), isExpanded(followedKey(item.slug)))}
                      onSelect={choose}
                      selectValue={(folder) =>
                        folder ? `following::${item.slug}::${folder}` : `following::${item.slug}`}
                    />
                  ))}
                  </div>
                )}
              </>
            )}
            {readingEnabled && (
              <div className="library-nav-group">
                <button
                  type="button"
                  className="library-nav-reading"
                  data-testid="library-mobile-reading"
                  aria-current={reading ? 'page' : undefined}
                  onClick={() => choose('reading')}
                >
                  <Icon name="book" />
                  Reading
                </button>
              </div>
            )}
        </div>
        <div className="library-mobile-foot">
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- react-router Link renders a native anchor; Enter fires onClick (close the sheet) natively */}
          <Link to="/library/new" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>New collection</Link>
          {reportsExposed && (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- react-router Link renders a native anchor; Enter fires onClick (close the sheet) natively
            <Link to="/library/digests" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Your digests</Link>
          )}
        </div>
      </Modal>
    </div>
  )
}
