import { Link, useLocation } from 'react-router-dom'
import { AvatarImage } from '../../components/AvatarImage'
import { EmptyState, LoadingState } from '../../components/EmptyState'
import { InboxItem } from '../../components/InboxItem'
import { LoadMoreButton } from '../../components/LoadMoreButton'
import type { ProfileSummary } from '../../api'
import {
  activityItemHref,
  activityItemTitle,
  activityProfileState,
  formatProfileDate,
  profileInitials,
} from './helpers'
import type { ActivityListState, FollowListState } from './types'

export function ProfilePersonRow({ person }: { person: ProfileSummary }) {
  const name = person.displayName.trim() || `@${person.handle}`
  const initials = profileInitials(person.displayName, person.handle)
  return (
    <Link to={`/u/${person.handle}`} className="profile-people-row" role="listitem">
      <span className="profile-public-avatar" aria-hidden="true">
        <AvatarImage url={person.avatarUrl} initials={initials} fallbackClassName="profile-public-avatar-fallback" />
      </span>
      <span className="profile-people-copy">
        <span className="profile-people-name">{name}</span>
        <span className="profile-people-handle">@{person.handle}</span>
      </span>
    </Link>
  )
}

export function FollowGraphPanel({
  kind,
  list,
  canRead,
  isLoggedIn,
  onRetry,
  onLoadMore,
}: {
  kind: 'following' | 'followers'
  list: FollowListState
  canRead: boolean
  isLoggedIn: boolean
  onRetry: () => void
  onLoadMore: () => void
}) {
  const location = useLocation()
  const isFollowing = kind === 'following'
  const title = isFollowing ? 'Following' : 'Followers'
  const headingId = isFollowing ? 'profile-following-heading' : 'profile-followers-heading'
  const emptyTitle = isFollowing ? 'Not following anyone yet' : 'No followers yet'
  const emptyDescription = isFollowing
    ? 'Profiles this curator follows will appear here.'
    : 'Profiles following this curator will appear here.'
  const signInTitle = isFollowing ? 'Sign in to see following' : 'Sign in to see followers'
  const signInDescription = isFollowing
    ? 'People this curator follows are available after you sign in.'
    : 'People who follow this curator are available after you sign in.'
  const unavailableTitle = isFollowing ? 'Following is unavailable' : 'Followers are unavailable'
  const loadingLabel = isFollowing ? 'Loading following…' : 'Loading followers…'
  const errorTitle = isFollowing ? "Couldn't load following" : "Couldn't load followers"
  const moreErrorTitle = isFollowing ? "Couldn't load more followed profiles" : "Couldn't load more followers"

  return (
    <section
      className="profile-panel"
      aria-labelledby={headingId}
      id={isFollowing ? 'profile-following-panel' : 'profile-followers-panel'}
      tabIndex={-1}
    >
      <h2 id={headingId} className="profile-panel-title">{title}</h2>
      {!canRead && (isLoggedIn ? (
        <EmptyState
          icon="collection"
          title={unavailableTitle}
          description="This list is not available right now."
        />
      ) : (
        <EmptyState
          icon="collection"
          title={signInTitle}
          description={signInDescription}
          action={<Link to={`/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`} className="btn btn-primary">Sign in</Link>}
        />
      ))}
      {canRead && list.status === 'loading' && <LoadingState label={loadingLabel} />}
      {canRead && list.status === 'error' && (
        <EmptyState
          className="profile-public-page-error empty-state--compact"
          role="alert"
          icon="alert"
          title={errorTitle}
          description="Check your connection and try again."
          action={<button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>}
        />
      )}
      {canRead && list.status === 'ready' && list.items.length === 0 && (
        <EmptyState
          className="profile-public-empty"
          data-profile-state={isFollowing ? 'empty-following' : 'empty-followers'}
          icon="collection"
          title={emptyTitle}
          description={emptyDescription}
        />
      )}
      {canRead && list.status === 'ready' && list.items.length > 0 && (
        <>
          <div className="profile-people" role="list" aria-label={title}>
            {list.items.map((person) => (
              <ProfilePersonRow key={person.profileId} person={person} />
            ))}
          </div>
          {list.pagination === 'error' && (
            <EmptyState
              className="profile-public-page-error empty-state--compact"
              role="alert"
              icon="alert"
              title={moreErrorTitle}
              description="Your current list is unchanged."
              action={<button type="button" className="btn btn-secondary btn-sm" onClick={onLoadMore}>Try again</button>}
            />
          )}
          {list.nextCursor && list.pagination !== 'error' && (
            <LoadMoreButton
              className="btn btn-secondary btn-sm profile-public-load-more"
              loading={list.pagination === 'loading'}
              onClick={onLoadMore}
              status={isFollowing ? 'Loading more following…' : 'Loading more followers…'}
            />
          )}
        </>
      )}
    </section>
  )
}

export function ActivityPanel({
  list,
  onRetry,
  onLoadMore,
}: {
  list: ActivityListState
  onRetry: () => void
  onLoadMore: () => void
}) {
  return (
    <section
      className="profile-panel"
      aria-labelledby="profile-activity-heading"
      id="profile-activity-panel"
      data-profile-state={activityProfileState(list)}
    >
      <h2 id="profile-activity-heading" className="profile-panel-title">Activity</h2>
      {(list.status === 'idle' || list.status === 'loading') && (
        <LoadingState label="Loading activity…" />
      )}
      {list.status === 'error' && (
        <EmptyState
          className="profile-public-page-error empty-state--compact"
          role="alert"
          icon="alert"
          title="Couldn't load activity"
          description="Check your connection and try again."
          action={<button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>}
        />
      )}
      {list.status === 'ready' && list.items.length === 0 && (
        <EmptyState
          className="profile-public-empty"
          icon="collection"
          title="No public activity yet"
          description="Public collection changes from this curator will appear here."
        />
      )}
      {list.status === 'ready' && list.items.length > 0 && (
        <>
          <div className="feed-stream-container" role="list" aria-label="Public activity">
            {list.items.map((item) => {
              const href = activityItemHref(item)
              const title = activityItemTitle(item)
              return (
                <InboxItem
                  key={item.activityId}
                  className="feed-card"
                  role="listitem"
                  kind="Updated a collection"
                  subject={href ? <Link to={href}>{title}</Link> : title}
                  time={<time className="meta" dateTime={item.publishedAt}>{formatProfileDate(item.publishedAt)}</time>}
                  data-profile-activity-id={item.activityId}
                />
              )
            })}
          </div>
          {list.pagination === 'error' && (
            <EmptyState
              className="profile-public-page-error empty-state--compact"
              role="alert"
              icon="alert"
              title="Couldn't load more activity"
              description="Your current list is unchanged."
              action={<button type="button" className="btn btn-secondary btn-sm" onClick={onLoadMore}>Try again</button>}
            />
          )}
          {list.nextCursor && list.pagination !== 'error' && (
            <LoadMoreButton
              className="btn btn-secondary btn-sm profile-public-load-more"
              loading={list.pagination === 'loading'}
              onClick={onLoadMore}
              status="Loading more activity…"
            />
          )}
        </>
      )}
    </section>
  )
}
