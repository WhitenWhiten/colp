import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  isProductApiError,
  productClient,
  type ReadingProgressView,
  type SavedResourceView,
} from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { loadReadIds, toggleReadId } from '../../lib/libraryMarks'
import { loginPath } from '../../lib/chrome'
import { hostOf, isAbort } from '../../lib/libraryTree'
import { ResourcePrimaryLink } from '../ResourcePrimaryLink'
import { EmptyState, LoadingState } from '../EmptyState'
import { Icon } from '../Icon'

type Props = { resourceId: string }

type QueueItem = {
  resourceType: ReadingProgressView['resourceType']
  resourceId: string
  title: string
  url: string | null
  collectionId: string | null
  caption: string
}

type QueueStatus = 'loading' | 'ready' | 'auth' | 'error'

function fromProgress(item: ReadingProgressView): QueueItem {
  return {
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    title: item.target.title ?? 'Untitled',
    url: item.target.url,
    collectionId: item.target.collectionId,
    caption: `${Math.round(item.progress * 100)}% read`,
  }
}

function fromSaved(item: SavedResourceView): QueueItem {
  return {
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    title: item.target.title ?? 'Untitled',
    url: item.target.url,
    collectionId: item.target.collectionId,
    caption: 'Saved',
  }
}

function itemMeta(item: QueueItem): string {
  const host = item.url ? hostOf(item.url) : ''
  return [host, item.caption].filter(Boolean).join(' · ')
}

/** Desktop reading queue from progress and saved resources — mark read without leaving the board. */
export function ReadingQueueWidget({ resourceId }: Props) {
  const location = useLocation()
  const { isLoggedIn, bootstrapping } = useAuth()
  const [readIds, setReadIds] = useState(() => loadReadIds())
  const [filter, setFilter] = useState<'open' | 'all'>('open')
  const [status, setStatus] = useState<QueueStatus>('loading')
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    const sync = () => setReadIds(loadReadIds())
    window.addEventListener('storage', sync)
    window.addEventListener('known-library-marks', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('known-library-marks', sync)
    }
  }, [])

  useEffect(() => {
    if (bootstrapping) {
      setStatus('loading')
      setQueue([])
      return
    }
    if (!isLoggedIn) {
      setStatus('auth')
      setQueue([])
      return
    }

    const controller = new AbortController()
    setStatus('loading')
    setQueue([])
    void (async () => {
      try {
        const page = await productClient.getReadingProgressPage(
          { status: 'in_progress', limit: 5 },
          { signal: controller.signal, maxRetries: 0 },
        )
        if (controller.signal.aborted) return
        const inProgress = page.items
          .filter((item) => item.target.availability === 'available')
          .map(fromProgress)
        if (inProgress.length > 0) {
          setQueue(inProgress)
          setStatus('ready')
          return
        }
        const saved = await productClient.loadSavedResources(
          { resourceType: 'node', limit: 5 },
          { signal: controller.signal, maxRetries: 0 },
        )
        if (controller.signal.aborted) return
        const savedItems = saved
          .filter((item) => item.target.availability === 'available')
          .slice(0, 5)
          .map(fromSaved)
        setQueue(savedItems)
        setStatus('ready')
      } catch (reason) {
        if (controller.signal.aborted || isAbort(reason)) return
        setQueue([])
        setStatus(isProductApiError(reason) && reason.isAuthRequired ? 'auth' : 'error')
      }
    })()
    return () => controller.abort()
  }, [bootstrapping, isLoggedIn, reloadNonce])

  const items = useMemo(() => {
    if (filter === 'all') return queue
    return queue.filter((item) => !readIds.has(item.resourceId))
  }, [filter, queue, readIds])

  const openCount = useMemo(
    () => queue.filter((item) => !readIds.has(item.resourceId)).length,
    [queue, readIds],
  )

  const mark = useCallback((id: string) => {
    const next = toggleReadId(id)
    setReadIds(new Set(next))
  }, [])

  return (
    <div className="desk-widget desk-reading" data-resource={resourceId}>
      <div className="desk-widget-head">
        <div>
          <span className="desk-widget-title">Reading queue</span>
          <p className="meta">
            {openCount} open from library
          </p>
        </div>
        <div className="desk-reading-filters" role="group" aria-label="Queue filter">
          <button
            type="button"
            className="desk-reading-filter"
            aria-pressed={filter === 'open'}
            onClick={() => setFilter('open')}
          >
            Open
          </button>
          <button
            type="button"
            className="desk-reading-filter"
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All
          </button>
        </div>
      </div>

      {status === 'loading' ? (
        <LoadingState label="Loading your queue…" />
      ) : status === 'auth' ? (
        <EmptyState
          icon="book"
          title="Sign in to see your queue"
          description="Progress and saved bookmarks show here after you sign in."
          action={<Link to={loginPath(location.pathname, location.search)} className="btn btn-secondary btn-sm">Log in</Link>}
        />
      ) : status === 'error' ? (
        <EmptyState
          role="alert"
          icon="alert"
          title="Couldn't load your reading queue"
          description="Check your connection and try again."
          action={(
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setReloadNonce((value) => value + 1)}
            >
              Try again
            </button>
          )}
        />
      ) : items.length === 0 ? (
        <div className="desk-reading-empty meta">
          Queue clear. <Link to="/library">Open library</Link> or capture a tab.
        </div>
      ) : (
        <ul className="desk-reading-list">
          {items.map((item) => {
            const isRead = readIds.has(item.resourceId)
            return (
              <li key={`${item.resourceType}:${item.resourceId}`} className={isRead ? 'is-read' : ''}>
                <ResourcePrimaryLink
                  className="desk-reading-main"
                  resourceId={item.resourceId}
                  url={item.url}
                  query={{ collectionId: item.collectionId, subjectType: item.resourceType }}
                >
                  <strong>{item.title}</strong>
                  <span className="meta">{itemMeta(item)}</span>
                </ResourcePrimaryLink>
                <button
                  type="button"
                  className={`desk-reading-mark ${isRead ? 'is-active' : ''}`}
                  aria-pressed={isRead}
                  aria-label={isRead ? `Mark ${item.title} as unread` : `Mark ${item.title} as read`}
                  onClick={() => mark(item.resourceId)}
                >
                  {isRead ? <Icon name="check" /> : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="desk-reading-foot">
        <Link to="/library" className="meta">
          Full library <Icon name="arrow-right" />
        </Link>
      </div>
    </div>
  )
}
