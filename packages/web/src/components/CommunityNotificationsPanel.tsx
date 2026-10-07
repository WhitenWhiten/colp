/* CS-05 community reply-notification inbox — the Community tab of the
   Notifications page. It pages the durable comment_reply inbox with the
   same All/Unread filter rail as the legacy feed and marks rows read through
   the receipted bulk command (optimistic paint, authority refresh).
   Community reply delivery is toggled in Settings (R11-10), not here.
   Rows whose reply was deleted or hidden keep their position with a
   redacted preview; the panel never renders the frozen Phase 5 kinds. */
import { Link, useLocation } from 'react-router-dom'
import type { CommunityNotification } from '@known/product-v1-client'
import { EmptyState, LoadingState } from './EmptyState'
import { FilterRail } from './FilterRail'
import { InboxItem } from './InboxItem'
import { LoadMoreButton } from './LoadMoreButton'
import { formatCompactDateTime } from '../lib/formatDate'
import { useCommunityNotificationCenter } from '../lib/useCommunityNotificationCenter'
import { settingsRedirectTo } from '../lib/useSettingsDialog'
import { loginPath } from '../lib/chrome'

const communityFilters = ['All', 'Unread'] as const
export type CommunityNotificationFilter = (typeof communityFilters)[number]

function nonEmptyString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

function communitySubject(item: CommunityNotification): { label: string; href: string | null } {
  const actor = nonEmptyString(item.actor.displayName) ? item.actor.displayName : 'Someone'
  const preview = item.preview ?? 'Reply no longer visible'
  return {
    label: `${actor} replied: ${preview}`,
    href: nonEmptyString(item.href) ? item.href : null,
  }
}

export function CommunityNotificationsPanel({
  enabled,
  filter,
  onFilterChange,
}: {
  enabled: boolean
  filter: CommunityNotificationFilter
  onFilterChange: (value: CommunityNotificationFilter) => void
}) {
  const location = useLocation()
  const notifications = useCommunityNotificationCenter({
    enabled,
    read: filter === 'Unread' ? 'unread' : 'all',
    limit: 20,
  })

  // CS-05: while the community surface is unexposed the panel renders
  // nothing at all — no chrome, no filters, no preference toggle — and the
  // hook above stays inert (state 'flag-off', zero requests).
  if (!enabled) return null

  const unreadVisible = notifications.items.some((item) => !item.read)
  return (
    <>
      <div className="row-end row--gapped">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!unreadVisible || notifications.pending !== null}
          onClick={() => notifications.markVisibleRead(notifications.items.map((item) => item.id))}
        >
          Mark visible read
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={notifications.state === 'loading'}
          onClick={notifications.refresh}
        >
          Refresh
        </button>
      </div>

      <FilterRail
        className="explore-filters"
        label="Community notification filters"
        value={filter}
        options={communityFilters.map((value) => ({
          value,
          label: value === 'Unread' && notifications.unreadCount > 0
            ? `${value} · ${notifications.unreadCount}`
            : value,
        }))}
        onChange={onFilterChange}
      />

      {notifications.state === 'loading' && notifications.items.length === 0 && (
        <LoadingState aria-live="polite" label="Loading community notifications…" />
      )}
      {notifications.state === 'error' && (
        <EmptyState
          role="alert"
          icon="alert"
          title={notifications.error?.status === 401 ? 'Sign in to continue' : "Couldn't load notifications"}
          description={
            notifications.error?.status === 401
              ? 'Community reply notifications require a signed-in session.'
              : 'Check your connection and try again. Existing notifications have not been replaced.'
          }
          action={
            notifications.error?.status === 401 ? (
              <Link to={loginPath(location.pathname, location.search)} className="btn btn-secondary btn-sm">Sign in</Link>
            ) : (
              <button type="button" className="btn btn-secondary btn-sm" onClick={notifications.retry}>Try again</button>
            )
          }
        />
      )}
      {notifications.mutationError && (
        <EmptyState
          role="alert"
          icon="alert"
          title="Couldn't save your change"
          description="Nothing was changed. Try again."
          action={<button type="button" className="btn btn-secondary btn-sm" onClick={notifications.retryMutation}>Try again</button>}
        />
      )}
      {notifications.state === 'empty' && (
        <EmptyState className="mt-hair-125" icon="bell" title="Nothing here" description="No reply notifications in this filter." />
      )}

      {notifications.items.length > 0 && <div className="notif-list">
        {notifications.items.map((item) => {
          const subject = communitySubject(item)
          return <InboxItem
            key={item.id}
            className="notif-item"
            unread={!item.read}
            kind="Comment reply"
            subject={subject.href ? <Link to={subject.href}>{subject.label}</Link> : subject.label}
            actor={item.read ? undefined : <p className="meta notif-subject">New reply</p>}
            actions={<>
              {!item.read && <button type="button" className="btn btn-ghost btn-sm" data-notification-read aria-label={`Mark read: ${subject.label}`} disabled={notifications.pending !== null} onClick={() => notifications.markOne(item.id)}>Mark read</button>}
            </>}
            time={<time className="meta" dateTime={item.createdAt}>{formatCompactDateTime(item.createdAt)}</time>}
            aria-label={`${item.read ? 'Read' : 'Unread'} notification: ${subject.label}`}
            data-notification-item
            data-community-notification-item
          />
        })}
      </div>}
      {notifications.hasMore && <div className="empty-state-actions">
        <LoadMoreButton loading={notifications.state === 'loading-more'} onClick={notifications.loadMore} status="Loading more notifications" />
      </div>}

      <p className="meta">
        Community reply notifications are managed in{' '}
        <Link to={settingsRedirectTo('notifications')}>Settings</Link>.
      </p>
    </>
  )
}
