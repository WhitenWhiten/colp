import { Link, useLocation } from 'react-router-dom'
import type { PublicProfileCollectionSummary, PublicProfilePage } from '../../api'
import { followCountLabel, kindLabel } from './helpers'
import { ProfilePersonRow } from './panels'
import type { FollowListState } from './types'

const SIDEBAR_PEOPLE_LIMIT = 6

type Kind = PublicProfileCollectionSummary['kind']

function kindBreakdown(collections: PublicProfilePage['collections']): Array<[Kind, number]> {
  const counts = new Map<Kind, number>()
  for (const collection of collections) {
    counts.set(collection.kind, (counts.get(collection.kind) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function FollowingSummary({
  following,
  canRead,
  isLoggedIn,
  onViewAll,
}: {
  following: FollowListState
  canRead: boolean
  isLoggedIn: boolean
  onViewAll: () => void
}) {
  const location = useLocation()
  if (!canRead) {
    return isLoggedIn ? (
      <p className="journal-sidebar-empty">This list is not available right now.</p>
    ) : (
      <>
        <p className="journal-sidebar-empty">Sign in to see who this curator follows.</p>
        <Link to={`/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`} className="journal-sidebar-link">Sign in</Link>
      </>
    )
  }
  if (following.status === 'loading') {
    return <p className="journal-sidebar-empty" role="status">Loading following…</p>
  }
  if (following.status === 'error') {
    return <p className="journal-sidebar-empty">Couldn't load following.</p>
  }
  if (following.items.length === 0) {
    return <p className="journal-sidebar-empty">Not following anyone yet.</p>
  }
  const shown = following.items.slice(0, SIDEBAR_PEOPLE_LIMIT)
  const truncated = following.nextCursor != null || following.items.length > shown.length
  const followingCount = followCountLabel(following)
  return (
    <>
      <div className="journal-people" role="list" aria-label="Following">
        {shown.map((person) => (
          <ProfilePersonRow key={person.profileId} person={person} />
        ))}
      </div>
      {truncated && (
        <button type="button" className="journal-sidebar-link" onClick={onViewAll}>
          {followingCount == null ? 'View all' : `View all ${followingCount}`}
        </button>
      )}
    </>
  )
}

/* Journal sidebar: only what the nameplate does not already say — the
   shape of what is published, and who the curator reads. The bio lives in
   the nameplate (it used to be repeated here as "About"). */
export function JournalSidebar({
  collections,
  hasMore,
  following,
  canReadFollowGraph,
  isLoggedIn,
  onViewAllFollowing,
}: {
  collections: PublicProfilePage['collections']
  hasMore: boolean
  following: FollowListState
  canReadFollowGraph: boolean
  isLoggedIn: boolean
  onViewAllFollowing: () => void
}) {
  const kinds = kindBreakdown(collections)
  return (
    <aside className="journal-sidebar" aria-label="About this curator">
      <section>
        <h2>Collections</h2>
        {kinds.length === 0 ? (
          <p className="journal-sidebar-empty">Nothing published yet.</p>
        ) : (
          <ul className="journal-kinds">
            {kinds.map(([kind, count]) => (
              <li key={kind}><span>{kindLabel(kind)}</span><strong>{count}</strong></li>
            ))}
          </ul>
        )}
        {hasMore && <p className="journal-sidebar-empty">From the first {collections.length} loaded.</p>}
      </section>
      <section>
        <h2>Following</h2>
        <FollowingSummary
          following={following}
          canRead={canReadFollowGraph}
          isLoggedIn={isLoggedIn}
          onViewAll={onViewAllFollowing}
        />
      </section>
    </aside>
  )
}
