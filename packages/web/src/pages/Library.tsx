/**
 * Product library desk: `/library` and `/library/:id`.
 *
 * This is not the demo bookmark stack. `/demo/library` renders `LegacyLibrary`
 * (`./LegacyLibrary.tsx`) with seed folders, LibraryLinkRow, and in-row notes.
 */
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { PageShell } from '../components/PageShell'
import { ProgressBar } from '../components/ProgressBar'
import { isLive, isReadableReplicaExposureEnabled, isReportsExposureEnabled } from '../api'
import { ResourcePrimaryLink } from '../components/ResourcePrimaryLink'
import { useSavedResources } from '../lib/useSavedResource'
import { useFollowedReportIssues } from '../lib/useFollowedReportIssues'
import { reportIssuePath } from '../lib/reports'
import { useReadingProgressList } from '../lib/useReadingProgress'
import { isSelfHostedPathEnabled } from '../lib/edition'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { formatDate } from '../lib/formatDate'
import { pluralNoun } from '../lib/plural'
import { LibraryDesk } from './library-desk/LibraryDesk'
// Shared product-loop stylesheet (see main.tsx); ships with this route chunk.
import '../styles/saved-resources.css'
import '../styles/library.css'

type LibraryView = 'collections' | 'reading'

function formatHost(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.hostname || raw
  } catch {
    return raw
  }
}

function LibraryUnavailable() {
  useDocumentTitle('Library')
  /* .empty-state centers itself (34rem measure) — it needs only the page
     padding shell (PageShell bare), not Explore's head container. */
  return (
    <PageShell variant="bare">
      <EmptyState
        illustration="books"
        title="Library is not available"
        description="Your saved bookmarks and reading progress will appear here when they're ready."
        action={isSelfHostedPathEnabled('/explore') ? <Link to="/explore" className="btn btn-secondary btn-sm">Explore collections</Link> : undefined}
      />
    </PageShell>
  )
}

export function Library() {
  const collectionsEnabled = isLive('collectionList')
  const readingEnabled = isLive('savedResources') || isLive('readingProgress')
  if (!collectionsEnabled && !readingEnabled) {
    return <LibraryUnavailable />
  }
  return <LibraryHome collectionsEnabled={collectionsEnabled} readingEnabled={readingEnabled} />
}

function LibraryHome({
  collectionsEnabled,
  readingEnabled,
}: {
  collectionsEnabled: boolean
  readingEnabled: boolean
}) {
  const [searchParams] = useSearchParams()
  const requested = searchParams.get('view')
  const view: LibraryView = requested === 'reading' && readingEnabled
    ? 'reading'
    : collectionsEnabled
      ? 'collections'
      : 'reading'

  return (
    <LibraryDesk
      readingEnabled={readingEnabled}
      readingPane={view === 'reading' ? <ReadingSection /> : null}
    />
  )
}

/**
 * Recent issues from followed digest series — the reading entry for the
 * newspaper surface. Quiet by contract: hidden while the gate is off, while
 * the timeline is empty, or while it cannot be loaded; the saved-resources
 * list below carries the pane on its own then.
 */
function DigestIssuesBlock() {
  const exposed = isReportsExposureEnabled()
  const { items } = useFollowedReportIssues(exposed)
  if (!exposed || items.length === 0) return null
  return (
    <section className="library-digest-issues" data-testid="library-digest-issues" aria-labelledby="library-digest-issues-title">
      <div className="library-digest-issues-head">
        <h3 className="section-label" id="library-digest-issues-title">Digest issues</h3>
        <div className="library-digest-issues-links">
          <Link className="meta" to="/library/digests">My digests</Link>
          <Link className="meta" to="/reports">Browse digests</Link>
        </div>
      </div>
      <div className="lib-link-list" role="list">
        {items.map((issue) => {
          // #21: a moderation-hidden issue keeps its slot as an inert row.
          if (issue.state === 'hidden') {
            return (
              <div role="listitem" key={issue.id} data-digest-issue-hidden>
                <div className="saved-resource-row saved-resource-row--tombstone">
                  <div>
                    <strong>{issue.titleSnapshot}</strong>
                    <span className="host">{issue.series.title}</span>
                  </div>
                  <div className="saved-progress-col">
                    <time className="meta" dateTime={issue.publishedAt}>{formatDate(issue.publishedAt)}</time>
                  </div>
                </div>
              </div>
            )
          }
          const slug = issue.series.slug
          if (!slug) return null
          return (
            <div role="listitem" key={issue.id}>
              <Link className="saved-resource-row" to={reportIssuePath(slug, issue.id)}>
                <div>
                  <strong>{issue.titleSnapshot}</strong>
                  <span className="host">{issue.series.title}</span>
                </div>
                <div className="saved-progress-col">
                  <time className="meta" dateTime={issue.publishedAt}>{formatDate(issue.publishedAt)}</time>
                </div>
              </Link>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ReadingSection() {
  const savedEnabled = isLive('savedResources')
  const progressEnabled = isLive('readingProgress')
  const readerEnabled = isReadableReplicaExposureEnabled()
  const saved = useSavedResources()
  const progress = useReadingProgressList()
  const rows = useMemo(() => {
    const byKey = new Map(progress.items.map((item) => [`${item.resourceType}:${item.resourceId}`, item]))
    const result: Array<{ saved: (typeof saved.items)[number] | null; progress: (typeof progress.items)[number] | undefined }> = saved.items.map((item) => ({ saved: item, progress: byKey.get(`${item.resourceType}:${item.resourceId}`) }))
    const savedKeys = new Set(saved.items.map((item) => `${item.resourceType}:${item.resourceId}`))
    for (const item of progress.items) if (!savedKeys.has(`${item.resourceType}:${item.resourceId}`)) result.push({ saved: null, progress: item })
    return result
    // Hook result identity changes every render; items are the used fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- progress.items / saved.items
  }, [progress.items, saved.items])
  const loading = rows.length === 0 && (
    (savedEnabled && saved.state === 'loading')
    || (progressEnabled && progress.state === 'loading')
  )
  const empty = !loading && rows.length === 0 && saved.state !== 'error' && progress.state !== 'error'

  return (
    <>
      <DigestIssuesBlock />
      {!loading && (
        <p className="explore-count">
          <strong>{rows.length}</strong>
          {' '}{pluralNoun(rows.length, 'bookmark')}
        </p>
      )}
      {savedEnabled && saved.state === 'error' && (
        <EmptyState
          role="alert"
          data-testid="saved-resources-error"
          icon="alert"
          title="Couldn't load saved bookmarks"
          description={saved.message}
          action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => saved.reload()}>Try again</button>}
        />
      )}
      {progressEnabled && progress.state === 'error' && (
        <EmptyState
          role="alert"
          data-testid="reading-progress-error"
          icon="alert"
          title="Couldn't load reading progress"
          description={progress.message}
          action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => progress.reload()}>Try again</button>}
        />
      )}
      {loading ? (
        <LoadingState data-testid="saved-resources-status" label="Loading your reading library…" />
      ) : empty ? (
        <EmptyState
          illustration="books"
          title="Nothing saved yet"
          description={readerEnabled
            ? 'Save a bookmark from a collection or the reader — it will wait here.'
            : 'Save a bookmark from a collection — it will wait here.'}
          action={isSelfHostedPathEnabled('/explore') ? <Link to="/explore" className="btn btn-secondary btn-sm">Explore collections</Link> : undefined}
        />
      ) : (
        <div className="lib-link-list" role="list">
          {rows.map(({ saved: item, progress: state }) => {
            const target = item?.target ?? state!.target
            const resourceType = item?.resourceType ?? state!.resourceType
            const resourceId = item?.resourceId ?? state!.resourceId
            return target.availability === 'available' ? (
              <div role="listitem" key={`${resourceType}:${resourceId}`}>
                <ResourcePrimaryLink
                  className="saved-resource-row"
                  resourceId={resourceId}
                  url={target.url}
                  query={{ collectionId: target.collectionId, subjectType: resourceType }}
                >
                  <div>
                    <strong title={target.title ?? undefined}>{target.title}</strong>
                    <span className="host" title={target.url ?? undefined}>{formatHost(target.url)}</span>
                  </div>
                  <div className="saved-progress-col">
                    <span className="meta">{state ? state.status === 'completed' ? 'Completed' : `${Math.round(state.progress * 100)}% read` : 'Saved'}</span>
                    {state && state.progress > 0 && state.status !== 'completed' && (
                      <ProgressBar value={state.progress * 100} className="saved-progress-bar" />
                    )}
                  </div>
                </ResourcePrimaryLink>
              </div>
            ) : (
              <div role="listitem" className="saved-resource-row" key={`${resourceType}:${resourceId}`}>
                <div>
                  <strong>Unavailable bookmark</strong>
                  <span className="host">Access removed</span>
                </div>
                <span className="meta">{state?.status === 'completed' ? 'Completed' : 'Private'}</span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
