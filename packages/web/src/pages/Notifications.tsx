import { useMemo, type ReactElement } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { isCommunityExposureEnabled, isEmailNotificationsExposureEnabled, isNotificationExposureEnabled } from '../api'
import type { NotificationItem } from '../api/types'
import { CommunityNotificationsPanel, type CommunityNotificationFilter } from '../components/CommunityNotificationsPanel'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { SelectMenu } from '../components/SelectMenu'
import { InboxItem } from '../components/InboxItem'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { TabList } from '../components/TabList'
import { formatCompactDateTime } from '../lib/formatDate'
import { libraryFeatureUnavailable } from '../lib/libraryCopy'
import { loginPath } from '../lib/chrome'
import { useNotificationCenter } from '../lib/useNotificationCenter'
import { useUnreadBreakdown } from '../lib/unreadBadgeStore'
import { settingsRedirectTo } from '../lib/useSettingsDialog'
import '../styles/collab.css'

const filters = ['All', 'Unread', 'Collection changes', 'Follows'] as const
type Filter = (typeof filters)[number]

const FILTER_QUERY: Record<Filter, string | null> = {
  All: null,
  Unread: 'unread',
  'Collection changes': 'collection',
  Follows: 'follows',
}

function filterFromSearch(params: URLSearchParams): Filter {
  const value = params.get('filter')
  if (value === 'collection') return 'Collection changes'
  if (value === 'unread') return 'Unread'
  if (value === 'follows') return 'Follows'
  return 'All'
}

type InboxTab = 'activity' | 'community'

function tabFromSearch(params: URLSearchParams, communityExposed: boolean): InboxTab {
  return communityExposed && params.get('tab') === 'community' ? 'community' : 'activity'
}

function communityFilterFrom(filter: Filter): CommunityNotificationFilter {
  return filter === 'Unread' ? 'Unread' : 'All'
}

function notificationLabel(item: NotificationItem): string {
  return item.notificationType === 'collection_change' ? 'Collection change' : 'Follows'
}

/** What is new on an unread row; read rows carry no state line (R12-09). */
function unreadState(item: NotificationItem, unreadCount: number): string {
  if (item.notificationType === 'collection_change') return 'New changes'
  return unreadCount === 1 ? 'New follower' : `${unreadCount} new followers`
}

function nonEmptyString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

function notificationSubject(item: NotificationItem): { label: string; href: string | null } {
  if (item.notificationType === 'collection_change') {
    const label = nonEmptyString(item.collectionTitle) ? item.collectionTitle : 'A followed collection changed'
    if (nonEmptyString(item.publicationSlug)) {
      return { label, href: `/c/${encodeURIComponent(item.publicationSlug)}` }
    }
    return { label, href: nonEmptyString(item.actorHandle) ? `/u/${encodeURIComponent(item.actorHandle)}` : null }
  }
  const label = nonEmptyString(item.actorDisplayName) ? `${item.actorDisplayName} followed your work` : 'Someone followed your work'
  if (nonEmptyString(item.actorHandle)) {
    return { label, href: `/u/${encodeURIComponent(item.actorHandle)}` }
  }
  return { label, href: null }
}

type NotificationRow =
  | { kind: 'item'; item: NotificationItem }
  | { kind: 'follows'; items: NotificationItem[] }

function groupNotificationRows(items: NotificationItem[]): NotificationRow[] {
  const rows: NotificationRow[] = []
  for (const item of items) {
    if (item.notificationType !== 'follow_activity') {
      rows.push({ kind: 'item', item })
      continue
    }
    const last = rows[rows.length - 1]
    if (last?.kind === 'follows') last.items.push(item)
    else rows.push({ kind: 'follows', items: [item] })
  }
  return rows
}

function followRowCopy(items: NotificationItem[]): { label: string; href: string | null } {
  const only = items[0]
  if (items.length === 1 && only) return notificationSubject(only)
  return { label: `${items.length} people followed your work`, href: null }
}

/**
 * P5-30 independent email channel control. The email flag only shows/hides this
 * section; in-app delivery is owned by Settings (R11-10) and is never affected.
 * The UI never fakes usability: provider-unavailable and unsubscribed states
 * are read-only and recover via refresh.
 */
function renderEmailPreference(notifications: ReturnType<typeof useNotificationCenter>): ReactElement {
  const email = notifications.preference!.email!
  const blocked = !email.emailAvailable || email.emailSuppressed
  return (
    <div className="toggle-row" data-testid="email-preference">
      <div>
        <strong>Email notifications</strong>
        <span className="meta">
          {email.emailAvailable && email.verifiedSender ? `From ${email.verifiedSender}.` : 'Optional email delivery channel.'}
          {email.emailSuppressed ? ' You unsubscribed from email notifications.' : ''}
        </span>
      </div>
      <div className="row">
        {blocked ? (
          <>
            <span className="meta" role="status">
              {!email.emailAvailable ? 'Email notifications are unavailable.' : 'Email notifications are paused after you unsubscribed.'}
            </span>
            {!email.emailAvailable && <button type="button" className="btn btn-ghost btn-sm" onClick={notifications.refresh}>Retry</button>}
          </>
        ) : (
          <>
            <button type="button" className="toggle" role="switch" aria-label="Email notifications" aria-checked={email.enabled} disabled={notifications.pending !== null} onClick={() => notifications.setEmailPreference(!email.enabled)} />
            <button type="button" className="btn btn-ghost btn-sm" disabled={notifications.pending !== null} onClick={notifications.resetEmailPreference}>Use default</button>
          </>
        )}
      </div>
    </div>
  )
}

function withCount(label: string, count: number): string {
  return count > 0 ? `${label} · ${count}` : label
}

export function Notifications() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const communityExposed = isCommunityExposureEnabled()
  const tab = tabFromSearch(searchParams, communityExposed)
  const filter = filterFromSearch(searchParams)
  const setFilter = (value: Filter) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      const query = FILTER_QUERY[value]
      if (query) next.set('filter', query)
      else next.delete('filter')
      return next
    }, { replace: true })
  }
  const setTab = (value: InboxTab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value === 'community') next.set('tab', 'community')
      else next.delete('tab')
      return next
    }, { replace: true })
  }
  const enabled = isNotificationExposureEnabled()
  const emailExposure = isEmailNotificationsExposureEnabled()
  const notifications = useNotificationCenter({
    enabled,
    state: filter === 'Unread' ? 'unread' : 'all',
    limit: 20,
    includePreference: true,
  })
  // The account menu's "Notifications (N)" is Activity + Community unread;
  // the tab counts show that split so the two numbers reconcile at a glance.
  const inboxUnread = useUnreadBreakdown()
  const visible = useMemo(() => notifications.items.filter((item) => {
    if (filter === 'Collection changes') return item.notificationType === 'collection_change'
    if (filter === 'Follows') return item.notificationType === 'follow_activity'
    return true
  }), [filter, notifications.items])

  if (!enabled) {
    return (
      <PageShell variant="grid" data-testid="notifications-flag-off">
        <EmptyState illustration="network" title="Notifications are not available yet" description={libraryFeatureUnavailable('Notification access')} />
      </PageShell>
    )
  }

  const unreadVisible = visible.some((item) => item.state === 'unread')
  return (
    <PageShell variant="grid" data-testid="notification-center" sections>
      <PageSection>
        <PageHead
          className="page-head--editorial"
          layout="split"
          eyebrow="Inbox"
          title="Notifications"
          documentTitle="Notifications"
          lede="Follows and public collection changes."
          actions={tab === 'activity' ? (
            <>
              <button type="button" className="btn btn-secondary btn-sm" disabled={!unreadVisible || notifications.pending !== null} onClick={() => notifications.markVisibleRead(visible.map((item) => item.notificationId))}>Mark visible read</button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={notifications.state === 'loading'} onClick={notifications.refresh}>Refresh</button>
            </>
          ) : undefined}
        />
      </PageSection>

      <PageSection className="notif-panel">
        {communityExposed && (
          <TabList
            label="Notification inboxes"
            value={tab}
            onChange={setTab}
            className="tab-rail"
            panelIdFor={(id) => `notifications-panel-${id}`}
            tabIdFor={(id) => `notifications-tab-${id}`}
            options={[
              { id: 'activity', label: withCount('Activity', notifications.unreadCount) },
              { id: 'community', label: withCount('Community', inboxUnread.community) },
            ]}
          />
        )}

        {tab === 'community' ? (
          <section
            id="notifications-panel-community"
            role="tabpanel"
            aria-labelledby="notifications-tab-community"
            data-testid="community-notifications-panel"
          >
            <CommunityNotificationsPanel
              enabled={communityExposed}
              filter={communityFilterFrom(filter)}
              onFilterChange={(value) => setFilter(value === 'Unread' ? 'Unread' : 'All')}
            />
          </section>
        ) : (
        <section
          id="notifications-panel-activity"
          role="tabpanel"
          aria-labelledby="notifications-tab-activity"
        >
        <div className="notif-toolbar">
          <SelectMenu
            label="Notification filters"
            prefix="Show:"
            testId="notification-filter"
            value={filter}
            options={filters.map((value) => ({
              value,
              label: value === 'Unread' && notifications.unreadCount > 0
                ? `${value} · ${notifications.unreadCount}`
                : value,
            }))}
            onChange={setFilter}
          />
        </div>

        {notifications.state === 'loading' && notifications.items.length === 0 && <LoadingState aria-live="polite" label="Loading notifications…" />}
        {notifications.state === 'error' && (
          <EmptyState
            role="alert"
            icon="alert"
            title={notifications.error?.status === 401 ? 'Sign in to continue' : "Couldn't load notifications"}
            description={
              notifications.error?.status === 401
                ? 'Follows and collection changes require a signed-in session.'
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
        {notifications.state === 'empty' && <EmptyState className="mt-hair-125" icon="bell" title="Nothing here" description="You are caught up in this filter." />}
        {notifications.state !== 'loading' && notifications.state !== 'empty' && visible.length === 0 && !notifications.error && <EmptyState icon="bell" title="Nothing here" description="You are caught up in this filter." />}

        {visible.length > 0 && <div className="notif-list">
          {groupNotificationRows(visible).map((row) => {
            const items = row.kind === 'follows' ? row.items : [row.item]
            const lead = row.kind === 'follows' ? row.items[0] : row.item
            if (!lead) return null
            const subject = row.kind === 'follows' ? followRowCopy(items) : notificationSubject(lead)
            const unread = items.filter((item) => item.state === 'unread')
            const stamp = items.reduce((latest, item) => item.occurredAt > latest ? item.occurredAt : latest, lead.occurredAt)
            return <InboxItem
              key={lead.notificationId}
              className="notif-item"
              unread={unread.length > 0}
              kind={notificationLabel(lead)}
              subject={subject.href ? <Link to={subject.href}>{subject.label}</Link> : subject.label}
              actor={unread.length > 0 ? <p className="meta notif-subject">{unreadState(lead, unread.length)}</p> : undefined}
              actions={<>
                {unread.length === 1 && <button type="button" className="btn btn-ghost btn-sm" data-notification-read aria-label={`Mark read: ${subject.label}`} disabled={notifications.pending !== null} onClick={() => { const first = unread[0]; if (first) notifications.markOne(first.notificationId) }}>Mark read</button>}
                {unread.length > 1 && <button type="button" className="btn btn-ghost btn-sm" data-notification-read aria-label={`Mark read: ${subject.label}`} disabled={notifications.pending !== null} onClick={() => notifications.markVisibleRead(unread.map((item) => item.notificationId))}>Mark read</button>}
              </>}
              time={<time className="meta" dateTime={stamp}>{formatCompactDateTime(stamp)}</time>}
              aria-label={`${unread.length > 0 ? 'Unread' : 'Read'} notification: ${subject.label}`}
              data-notification-item
            />
          })}
        </div>}
        {notifications.hasMore && <div className="empty-state-actions">
          <LoadMoreButton loading={notifications.state === 'loading-more'} onClick={notifications.loadMore} status="Loading more notifications" />
        </div>}

        <p className="meta">
          In-app notifications are managed in{' '}
          <Link to={settingsRedirectTo('notifications')}>Settings</Link>.
        </p>
        {emailExposure && notifications.preference?.email && renderEmailPreference(notifications)}
        </section>
        )}
      </PageSection>
    </PageShell>
  )
}
