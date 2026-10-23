import { activityApi, type ActivityApi } from '../api/activityClient'
import { useAuth } from '../auth/AuthContext'
import { EmptyState } from '../components/EmptyState'
import { FilterRail } from '../components/FilterRail'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { classifyRouteError } from '../lib/classifyRouteError'
import { ActivityFeed } from './activity/ActivityFeed'
import { useActivityInbox } from './activity/useActivityInbox'
import '../styles/automations.css'
import '../styles/activity.css'

export function Activity({ api = activityApi }: { api?: ActivityApi } = {}) {
  const { isLoggedIn, user, bootstrapping } = useAuth()
  const { inbox, filter, setFilter, marking, more, retry, markAll } = useActivityInbox(api, isLoggedIn ? user?.accountId ?? null : null)

  return (
    <PageShell variant="narrow" data-testid="activity-inbox">
      <PageHead as="header" layout="split" variant="workbench" title="Activity" documentTitle="Activity"
        lede="New bookmarks, finished work, and decisions waiting for you."
        actions={isLoggedIn && inbox.unreadCount > 0 ? (
          <button className="btn btn-secondary btn-sm" type="button" onClick={markAll} disabled={marking}>
            {marking ? 'Marking read…' : 'Mark all read'}
          </button>
        ) : undefined}
      />
      {bootstrapping ? <RouteState kind="loading" loadingLabel="Loading activity…" /> : !isLoggedIn ? (
        <RouteState kind="auth" icon="bell" title="Sign in to see your activity" description="See what your agents added and what your rules finished." />
      ) : (
        <>
          <div className="activity-toolbar">
            <FilterRail label="Show activity" variant="segments" className="view-switch" value={filter}
              options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} onChange={setFilter} />
          </div>
          {inbox.loading && <RouteState kind="loading" loadingLabel="Loading activity…" />}
          {inbox.error !== null && <RouteState kind={classifyRouteError(inbox.error)} icon="bell" feature="Activity" onRetry={retry} />}
          {!inbox.loading && inbox.error === null && inbox.items.length === 0 && (
            <EmptyState icon={filter === 'unread' ? 'check' : 'bell'} title={filter === 'unread' ? 'You’re all caught up' : 'No activity yet'}
              description={filter === 'unread' ? 'New activity from your agents will appear here.' : 'When an agent adds bookmarks or a rule finishes work, you’ll see it here.'} />
          )}
          {inbox.items.length > 0 && <ActivityFeed items={inbox.items} />}
          {inbox.nextCursor && <LoadMoreButton loading={inbox.loadingMore} onClick={() => void more()}>Load more</LoadMoreButton>}
        </>
      )}
    </PageShell>
  )
}
