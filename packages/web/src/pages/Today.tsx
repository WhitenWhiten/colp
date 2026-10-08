import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import {
  isFeedExposureEnabled,
  isLive,
  isProductApiError,
  isReportsExposureEnabled,
  productClient,
  type ReadingProgressView,
  type SavedResourceView,
  type SyncConflictSummary,
} from '../api'
import { AvatarImage } from '../components/AvatarImage'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { useToast } from '../components/AppToast'
import { Icon } from '../components/Icon'
import { ProgressBar } from '../components/ProgressBar'
import { InboxItem } from '../components/InboxItem'
import { plural } from '../lib/plural'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { useReadingProgress } from '../lib/useReadingProgress'
import { useAuth } from '../auth/AuthContext'
import { displayInitials } from '../lib/displayInitials'
import { feedItemCanonicalPath, itemTitle } from '../lib/feedItemCopy'
import { formatCompactDateTime, formatWeekdayDate } from '../lib/formatDate'
import { hostOf } from '../lib/libraryTree'
import { ResourcePrimaryLink } from '../components/ResourcePrimaryLink'
import { readRouteCache, writeRouteCache } from '../lib/routeCache'
import { useFollowedReportIssues } from '../lib/useFollowedReportIssues'
import { useProductFeed } from '../lib/useProductFeed'
import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'
// Shared product-loop stylesheet (see main.tsx); ships with this route chunk.
import '../styles/today.css'

type FocusItem = {
  resourceType: ReadingProgressView['resourceType']
  resourceId: string
  title: string
  url: string | null
  collectionId: string | null
  caption: string
  progress: number | null
}

type FocusStatus = 'loading' | 'progress' | 'saved' | 'empty' | 'auth' | 'flag-off' | 'error'

type CachedFocus = { items: FocusItem[]; status: Extract<FocusStatus, 'progress' | 'saved' | 'empty'> }

const FOCUS_CACHE_KEY = 'today:focus-queue'

const SYNC_NOTICE_DISMISSED_KEY = 'known.today.sync-notice-dismissed'

function fromProgress(item: ReadingProgressView): FocusItem {
  return {
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    title: item.target.title ?? 'Untitled',
    url: item.target.url,
    collectionId: item.target.collectionId,
    caption: `${Math.round(item.progress * 100)}% read`,
    progress: item.progress,
  }
}

function fromSaved(item: SavedResourceView): FocusItem {
  return {
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    title: item.target.title ?? 'Untitled',
    url: item.target.url,
    collectionId: item.target.collectionId,
    caption: 'Saved',
    progress: null,
  }
}

/* The check medallion is a real complete toggle (the reading-progress
   workflow owns the mutation), not a decorative glyph — the CSS always had
   the pressed/done treatment waiting for it. */
function TodayFocusRow({ item, progressEnabled }: { item: FocusItem; progressEnabled: boolean }) {
  const { toast } = useToast()
  const progress = useReadingProgress({
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    enabled: progressEnabled,
  })
  const host = item.url ? hostOf(item.url) : ''
  const complete = progressEnabled && progress.complete
  const pct = Math.round((item.progress ?? 0) * 100)
  return (
    <article className={`today-task${complete ? ' is-done' : ''}`}>
      <div className="today-task-ring-wrap">
        {item.progress != null && !complete && (
          <ProgressBar
            value={pct}
            className="today-task-ring"
            label={`${item.title} ${pct}% read`}
          />
        )}
        <button
          type="button"
          className="today-check"
          aria-pressed={complete}
          aria-label={complete ? `Mark ${item.title} as not finished` : `Mark ${item.title} as finished`}
          title={complete ? 'Mark as not finished' : 'Mark as finished'}
          disabled={!progressEnabled || progress.saveState === 'saving'}
          onClick={() => {
            void Promise.resolve(progress.toggleComplete()).then((outcome) => {
              if (outcome === 'saved') toast(complete ? 'Marked incomplete' : 'Added to completed reading')
            })
          }}
        >
          <Icon name="check" />
        </button>
      </div>
      <div>
        <ResourcePrimaryLink
          resourceId={item.resourceId}
          url={item.url}
          query={{ collectionId: item.collectionId, subjectType: item.resourceType }}
        >
          {item.title}
        </ResourcePrimaryLink>
        <p>
          {complete ? 'Completed' : item.caption}
          {host ? <span className="today-task-host-inline"> · {host}</span> : null}
        </p>
      </div>
      <span>{host}</span>
    </article>
  )
}

export function Today() {
  const { isLoggedIn, bootstrapping } = useAuth()
  const sessionIdentity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const [dismissedCount, setDismissedCount] = useState<number | null>(() => {
    try {
      const stored = sessionStorage.getItem(SYNC_NOTICE_DISMISSED_KEY)
      return stored == null ? null : Number(stored)
    } catch {
      return null
    }
  })
  const [syncConflicts, setSyncConflicts] = useState<SyncConflictSummary[] | null>(null)
  const restoredFocus = readRouteCache<CachedFocus>(FOCUS_CACHE_KEY)
  const focusCacheItems = restoredFocus?.items
  const focusCacheStatus = restoredFocus?.status
  const [focusStatus, setFocusStatus] = useState<FocusStatus>(restoredFocus?.status ?? 'loading')
  const [focusItems, setFocusItems] = useState<FocusItem[]>(restoredFocus?.items ?? [])
  const focusItemsRef = useRef<FocusItem[]>(restoredFocus?.items ?? [])

  const publishFocus = useCallback((items: FocusItem[], status: CachedFocus['status']) => {
    focusItemsRef.current = items
    setFocusItems(items)
    setFocusStatus(status)
    writeRouteCache<CachedFocus>(FOCUS_CACHE_KEY, { items, status })
  }, [])
  const [focusNonce, setFocusNonce] = useState(0)
  const todayLabel = formatWeekdayDate()
  const conflictCount = syncConflicts?.length ?? 0
  // Dismissed for this session until the conflict count changes.
  const syncDismissed = dismissedCount === conflictCount
  const dismissSyncNotice = () => {
    setDismissedCount(conflictCount)
    try {
      sessionStorage.setItem(SYNC_NOTICE_DISMISSED_KEY, String(conflictCount))
    } catch { /* private mode: dismissal lasts until reload */ }
  }
  const feedEnabled = isFeedExposureEnabled()
  const progressEnabled = isLive('readingProgress')
  const savedEnabled = isLive('savedResources')
  const reportsExposed = isReportsExposureEnabled() && isLoggedIn
  const digestIssues = useFollowedReportIssues(reportsExposed)
  // #21: tombstones keep their Library slot but are not an unread reminder.
  const readableDigestIssues = digestIssues.items.filter((issue) => issue.state !== 'hidden')
  const feed = useProductFeed({ enabled: feedEnabled, kind: 'collection_change', limit: 3 })
  const feedPreview = feed.items.filter((item) => item.kind === 'collection_change').slice(0, 3)

  useEffect(() => {
    const requestIdentity = sessionIdentity
    setSyncConflicts([])
    // Sync conflicts belong to a signed-in account; don't ask for them first.
    if (!isLoggedIn || bootstrapping) {
      setSyncConflicts([])
      return
    }
    const controller = new AbortController()
    void productClient.loadSyncConflicts({ signal: controller.signal, maxRetries: 0, limit: 25 })
      .then((items) => {
        if (!controller.signal.aborted && privateSessionIdentity() === requestIdentity) setSyncConflicts(items)
      })
      .catch(() => {
        if (!controller.signal.aborted && privateSessionIdentity() === requestIdentity) setSyncConflicts([])
      })
    return () => controller.abort()
  }, [isLoggedIn, bootstrapping, sessionIdentity])

  useEffect(() => {
    const requestIdentity = sessionIdentity
    focusItemsRef.current = focusCacheItems ?? []
    setFocusItems(focusCacheItems ?? [])
    setFocusStatus(focusCacheStatus ?? 'loading')
    if (bootstrapping) {
      setFocusStatus('loading')
      setFocusItems([])
      return
    }
    if (!isLoggedIn) {
      setFocusStatus('auth')
      setFocusItems([])
      return
    }
    if (!progressEnabled) {
      setFocusStatus('flag-off')
      setFocusItems([])
      return
    }

    const controller = new AbortController()
    // The queue is already on screen after a route round trip; revalidate
    // behind it instead of replaying "Loading your queue…".
    if (focusItemsRef.current.length === 0) setFocusStatus('loading')
    void (async () => {
      try {
        const page = await productClient.getReadingProgressPage(
          { status: 'in_progress', limit: 5 },
          { signal: controller.signal, maxRetries: 0 },
        )
        if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return
        const inProgress = page.items
          .filter((item) => item.target.availability === 'available')
          .map(fromProgress)
        if (inProgress.length > 0) {
          publishFocus(inProgress, 'progress')
          return
        }
        if (!savedEnabled) {
          publishFocus([], 'empty')
          return
        }
        const saved = await productClient.loadSavedResources(
          { resourceType: 'node', limit: 5 },
          { signal: controller.signal, maxRetries: 0 },
        )
        if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return
        const savedItems = saved
          .filter((item) => item.target.availability === 'available')
          .slice(0, 5)
          .map(fromSaved)
        publishFocus(savedItems, savedItems.length > 0 ? 'saved' : 'empty')
      } catch (reason) {
        if (controller.signal.aborted) return
        // A failed revalidation keeps the queue already on screen.
        if (focusItemsRef.current.length > 0) return
        setFocusItems([])
        setFocusStatus(isProductApiError(reason) && reason.isAuthRequired ? 'auth' : 'error')
      }
    })()
    return () => controller.abort()
  }, [bootstrapping, focusCacheItems, focusCacheStatus, focusNonce, isLoggedIn, progressEnabled, publishFocus, savedEnabled, sessionIdentity])

  /* R9-15: grid (96rem) is deliberate — /today is a two-column dashboard
     (today-layout: main + rail). /feed and /notifications stay on the
     default 90rem shell: they are single-column streams, a different family. */
  return (
    <PageShell variant="grid">
      <PageHead
        className="page-head--editorial today-head"
        as="header"
        layout="split"
        eyebrow={todayLabel}
        title="Today"
        documentTitle="Today"
        lede="What you were reading, and what changed in the collections you follow."
      />

      <div className="today-layout">
        <div className="today-main">
          {!syncDismissed && conflictCount > 0 && (
            <section className="today-attention" data-testid="today-attention">
              <div className="today-attention-head"><span>Needs attention</span><button type="button" className="btn btn-ghost btn-sm" onClick={dismissSyncNotice} aria-label="Dismiss sync notice"><Icon name="cross" /></button></div>
              <strong>{plural(conflictCount, 'sync conflict')}</strong>
              <p>
                {conflictCount === 1
                  ? 'A bookmark changed in both the browser and Know-N.'
                  : 'Bookmarks changed in both the browser and Know-N.'}
              </p>
              <Link to="/sync">Resolve conflicts <Icon name="arrow-right" /></Link>
            </section>
          )}
          <div className="section-head section-head--split">
            <div><p className="section-label">Focus queue</p><h2>Continue where your attention already is</h2></div>
            {focusStatus === 'progress' && <span>{focusItems.length} in progress</span>}
            {focusStatus === 'saved' && <span>{focusItems.length} saved</span>}
          </div>
          <div className="today-task-list">
            {focusStatus === 'loading' && <LoadingState label="Loading your queue…" />}
            {focusStatus === 'auth' && (
              <RouteState
                kind="auth"
                icon="book"
                title="Sign in to see your reading"
                description="Your reading progress appears here after you sign in."
                returnTo="/today"
              />
            )}
            {focusStatus === 'flag-off' && (
              <EmptyState
                icon="book"
                title="Nothing in progress"
                description="Your reading library keeps what you save to read later."
                action={<Link to="/library?view=reading" className="btn btn-secondary btn-sm">Open reading library</Link>}
              />
            )}
            {focusStatus === 'error' && (
              <EmptyState
                role="alert"
                icon="alert"
                title="Couldn't load your reading progress"
                description="Check your connection and try again."
                action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => setFocusNonce((value) => value + 1)}>Try again</button>}
              />
            )}
            {(focusStatus === 'empty') && (
              <EmptyState
                icon="book"
                title="Nothing in progress"
                description="Save a bookmark or start reading — it will wait here."
                action={<Link to="/library?view=reading" className="btn btn-secondary btn-sm">Open reading library</Link>}
              />
            )}
            {(focusStatus === 'progress' || focusStatus === 'saved') && focusItems.map((item) => (
              <TodayFocusRow
                key={`${item.resourceType}:${item.resourceId}`}
                item={item}
                progressEnabled={progressEnabled}
              />
            ))}
          </div>

          <section className="today-updates">
            <div className="section-head section-head--split">
              <div><p className="section-label">Following</p><h2>Changes worth noticing</h2></div>
              <Link to="/feed">Open feed</Link>
            </div>
            {!feedEnabled && (
              <EmptyState
                icon="bell"
                title="Feed is not available yet"
                description="Updates from people and collections you follow will appear here."
              />
            )}
            {feedEnabled && feed.state === 'loading' && feed.items.length === 0 && <LoadingState label="Loading your feed…" />}
            {/* Signed out, the focus-queue prompt is the one sign-in ask. */}
            {feedEnabled && isLoggedIn && feed.state === 'error' && (
              <EmptyState
                role="alert"
                icon="alert"
                title={feed.error?.status === 401 ? 'Sign in to see your feed' : "Couldn't load your feed"}
                description={
                  feed.error?.status === 401
                    ? 'Public follow activity is available after you sign in.'
                    : 'Check your connection and try again.'
                }
                action={
                  feed.error?.status === 401 ? (
                    <Link to={`/login?returnTo=${encodeURIComponent('/today')}`} className="btn btn-secondary btn-sm">Sign in</Link>
                  ) : (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={feed.retry}>Try again</button>
                  )
                }
              />
            )}
            {feedEnabled && feed.state === 'empty' && (
              <EmptyState
                icon="compass"
                title="Your feed is quiet"
                description="Follow people to see their public collection changes here."
                action={<Link to="/explore" className="btn btn-primary btn-sm">Explore collections</Link>}
              />
            )}
            {feedEnabled && feedPreview.map((item) => (
              <InboxItem
                key={item.feedItemId}
                className="today-update-row result-row--byline"
                to={feedItemCanonicalPath(item)}
                mark={
                  <span className="avatar avatar-sm" aria-hidden>
                    <AvatarImage url={item.actor.avatarUrl} initials={displayInitials(item.actor.displayName)} />
                  </span>
                }
                subject={itemTitle(item)}
                actor={<small className="meta handle-text">{item.actor.handle ? `@${item.actor.handle}` : item.actor.displayName}</small>}
                time={<time className="meta" dateTime={item.publishedAt}>{formatCompactDateTime(item.publishedAt)}</time>}
              />
            ))}
          </section>
        </div>

        <aside className="today-rail">
          <section className="today-quick-actions">
            {reportsExposed && readableDigestIssues.length > 0 && (
              <Link
                to="/library?view=reading"
                title="Open the digest reading list"
                data-testid="today-digest-reminder"
              >
                <span className="today-quick-mark" aria-hidden><Icon name="file" /></span>
                <span>Latest from digests you follow</span>
                <Icon name="chevron-right" className="today-quick-go" />
              </Link>
            )}
            <Link to="/extension">
              <span className="today-quick-mark" aria-hidden><Icon name="bookmark" /></span>
              <span>Capture a source</span>
              <Icon name="chevron-right" className="today-quick-go" />
            </Link>
            <Link to="/library?view=reading">
              <span className="today-quick-mark" aria-hidden><Icon name="library" /></span>
              <span>Reading library</span>
              <Icon name="chevron-right" className="today-quick-go" />
            </Link>
          </section>
        </aside>
      </div>
    </PageShell>
  )
}
