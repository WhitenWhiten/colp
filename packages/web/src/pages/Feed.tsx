import { Fragment, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { isFeedExposureEnabled } from '../api'
import type { FeedItem } from '../api/types'
import { AvatarImage } from '../components/AvatarImage'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { FilterRail } from '../components/FilterRail'
import { InboxItem } from '../components/InboxItem'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { displayInitials } from '../lib/displayInitials'
import { feedItemCanonicalPath, itemBody, itemTitle } from '../lib/feedItemCopy'
import { loginPath } from '../lib/chrome'
import { formatDate, formatCompactDateTime } from '../lib/formatDate'
import { plural } from '../lib/plural'
import { libraryFeatureUnavailable } from '../lib/libraryCopy'
import { useProductFeed } from '../lib/useProductFeed'

export { feedItemCanonicalPath, itemTitle, itemBody }

const filters: { label: string; value?: FeedItem['kind'] }[] = [
  { label: 'All' },
  { label: 'Collection changes', value: 'collection_change' },
  { label: 'Follows', value: 'follow_activity' },
]

export function Feed() {
  const location = useLocation()
  const [kind, setKind] = useState<FeedItem['kind'] | undefined>()
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const enabled = isFeedExposureEnabled()
  const feed = useProductFeed({ enabled, kind, limit: 20 })
  const loadMoreTargetRef = useRef<HTMLDivElement>(null)
  const loadMoreStateRef = useRef({ loadMore: feed.loadMore, state: feed.state })
  loadMoreStateRef.current = { loadMore: feed.loadMore, state: feed.state }

  /* A feed is not a fixed-size page: loading the next cursor page as the end
     of the stream approaches. The manual button stays as the accessible
     fallback; the state guard keeps refresh/check cycles from re-triggering. */
  useEffect(() => {
    const target = loadMoreTargetRef.current
    if (!target || !feed.hasMore || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const { loadMore, state } = loadMoreStateRef.current
        if (state === 'ready' && entries.some((entry) => entry.isIntersecting)) loadMore()
      },
      { rootMargin: '320px 0px 0px 0px' },
    )
    io.observe(target)
    return () => io.disconnect()
  }, [feed.hasMore, feed.state])

  const copyCanonicalLink = async (item: FeedItem) => {
    const path = feedItemCanonicalPath(item)
    const url = new URL(path, window.location.origin).href
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(item.feedItemId)
    } catch {
      setCopiedId(null)
    }
  }

  if (!enabled) {
    return (
      <PageShell variant="grid" data-testid="feed-flag-off">
        <EmptyState illustration="network" title="Feed is not available yet" description={libraryFeatureUnavailable('Feed access')} />
      </PageShell>
    )
  }

  const showControls = feed.state !== 'error' && (feed.items.length > 0 || feed.state === 'empty')

  return (
    <PageShell variant="grid" data-testid="product-feed" sections>
      <PageSection>
        <PageHead
          className="page-head--editorial"
          eyebrow="Following"
          title="Feed"
          documentTitle="Feed"
          lede="Public updates from people you follow."
        />
      </PageSection>

      {showControls && (
      <PageSection className="feed-controls" data-testid="feed-controls">
        <FilterRail
          className="explore-filters"
          label="Feed filters"
          value={kind}
          options={filters.map((filter) => ({ value: filter.value, label: filter.label }))}
          onChange={setKind}
        />
        {feed.items.length > 0 && <p className="meta feed-count">{plural(feed.items.length, 'update')}</p>}
        <div className="empty-state-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={feed.checkForNewItems} disabled={feed.state === 'checking'}>
            {feed.state === 'checking' ? 'Checking…' : 'Check for new items'}
          </button>
        </div>
      </PageSection>
      )}

      <PageSection className="feed-stream">
        {feed.state === 'loading' && feed.items.length === 0 && <LoadingState data-feed-state="loading" label="Loading your feed…" />}
        {feed.state === 'error' && (
          <EmptyState
            role="alert"
            data-feed-state="error"
            icon="alert"
            title={feed.error?.status === 401 ? 'Sign in to continue' : "Couldn't load your feed"}
            description={
              feed.error?.status === 401
                ? 'Public follow activity is available after you sign in.'
                : 'Check your connection and try again.'
            }
            action={
              feed.error?.status === 401 ? (
                <Link to={loginPath(location.pathname, location.search)} className="btn btn-secondary btn-sm">Sign in</Link>
              ) : (
                <button type="button" className="btn btn-secondary btn-sm" onClick={feed.retry}>Try again</button>
              )
            }
          />
        )}
        {feed.newItems.length > 0 && (
          <div role="status">
            <button type="button" className="btn btn-secondary btn-sm" onClick={feed.showNewItems}>
              Show {plural(feed.newItems.length, 'new item')}
            </button>
          </div>
        )}
        {feed.state === 'empty' && (
          <EmptyState
            illustration="network"
            title="Your feed is quiet"
            description="Follow people to see their public collection changes here."
            action={<Link to="/explore" className="btn btn-primary btn-sm">Explore collections</Link>}
          />
        )}
        {feed.items.length > 0 && (
          <div className="feed-stream-container">
            {feed.items.map((item, index) => {
              const href = feedItemCanonicalPath(item)
              const body = itemBody(item)
              // #21: hide_public moderation keeps the row as an inert tombstone —
              // actor and time stay real, the collection link and actions go away.
              const hidden = item.hiddenPublic === true
              /* Stream de-noising: a day separator opens each calendar day.
                 Rows carry no kind chip — the headline already says what
                 happened; each card keeps its full timestamp. */
              const prev = index > 0 ? feed.items[index - 1] ?? null : null
              const day = formatDate(item.publishedAt)
              const newDay = prev === null || formatDate(prev.publishedAt) !== day
              return (
                <Fragment key={item.feedItemId}>
                  {newDay && <p className="feed-day-sep" aria-hidden>{day}</p>}
                  <InboxItem
                    className={hidden ? 'feed-card result-row--byline feed-card--tombstone' : 'feed-card result-row--byline'}
                    data-feed-item
                    data-feed-collection-id={item.collectionId ?? undefined}
                    data-collection-hidden={hidden ? '' : undefined}
                    mark={
                      <Link to={`/u/${encodeURIComponent(item.actor.handle)}`} aria-label={`${item.actor.displayName} (@${item.actor.handle})`}>
                        <span className="avatar" aria-hidden>
                          <AvatarImage url={item.actor.avatarUrl} initials={displayInitials(item.actor.displayName)} />
                        </span>
                      </Link>
                    }
                    subject={hidden ? itemTitle(item) : <Link to={href}>{itemTitle(item)}</Link>}
                    actor={
                      /* The title already opens with the actor's name (R12-22). */
                      <Link to={`/u/${encodeURIComponent(item.actor.handle)}`} className="meta">
                        @{item.actor.handle}
                      </Link>
                    }
                    body={body ? <p className="feed-card-body" data-testid="feed-card-body">{body}</p> : undefined}
                    actions={
                      <div className="feed-card-foot">
                        {!hidden && (
                          <div className="feed-card-actions" data-testid="feed-card-actions">
                            <Link to={href} className="btn btn-ghost btn-sm">Open</Link>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyCanonicalLink(item)}>Copy public link</button>
                            {copiedId === item.feedItemId && <span role="status" className="meta">Copied public link</span>}
                          </div>
                        )}
                      </div>
                    }
                    time={<time className="meta" dateTime={item.publishedAt}>{formatCompactDateTime(item.publishedAt)}</time>}
                  />
                </Fragment>
              )
            })}
          </div>
        )}
        {feed.hasMore && (
          <div className="empty-state-actions" ref={loadMoreTargetRef}>
            <LoadMoreButton loading={feed.state === 'loading-more'} onClick={feed.loadMore} status="Loading more updates" />
          </div>
        )}
      </PageSection>
    </PageShell>
  )
}
