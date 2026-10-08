import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { isLive, isReadableReplicaExposureEnabled } from '../api'
import { useAuth } from '../auth/AuthContext'
import { Breadcrumb } from '../components/Breadcrumb'
import { ABSENCE_CORNERS, AbsenceStage } from '../components/AbsenceStage'
import { useToast } from '../components/AppToast'
import { DomainMark } from '../components/DomainMark'
import { ProgressBar } from '../components/ProgressBar'
import { SavedResourceButton } from '../components/SavedResourceButton'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { useAnnotationWorkflow, type AnnotationSubjectLocator } from '../lib/useAnnotationWorkflow'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { replicaSourceMatchesNodeUrl } from '../lib/bookmarkUrl'
import {
  useReadableReplica,
  type ReadableReplicaFailureCode,
  type ReadableReplicaSectionView,
  type ReadableReplicaUiStatus,
} from '../lib/useReadableReplica'
import { useReadingProgress } from '../lib/useReadingProgress'
import { copyTextToClipboard } from '../lib/clipboard'
import { graphPath } from '../lib/graphNavigation'
import { loginPath } from '../lib/chrome'
import {
  resourceBackPath,
  resourceDetailPath,
  resourceNodeEmptyCopy,
  resourceReaderPath,
  useResourceNode,
} from '../lib/useResourceNode'
import { safeExternalUrl } from '../lib/publicCollectionTree'
import { productName } from '../lib/edition'
// Route-owned stylesheet (see main.tsx); ships with this route chunk.
import '../styles/not-found.css'
import '../styles/reader.css'

function loadNote(id: string) {
  try { return localStorage.getItem(`known.reader.note.${id}`) ?? '' } catch { return '' }
}

function annotationsAcceptanceCandidate(): boolean {
  return String(import.meta.env?.VITE_ANNOTATIONS_ACCEPTANCE ?? '').toLowerCase() === 'true'
}

/* One human sentence per extractor failure code; `empty` doubles as the
   copy for a null code (the server had nothing more specific to say). */
const FAILURE_TITLES: Record<NonNullable<ReadableReplicaFailureCode>, string> = {
  http: 'The site returned an error',
  not_html: "This link isn't an HTML page",
  too_large: 'The page is too large to extract',
  timeout: 'The site took too long to respond',
  dns: 'The site could not be reached',
  denied: "This address can't be fetched",
  invalid_url: "The bookmark URL isn't valid",
  empty: 'No readable article was found on this page',
}

function failureTitle(code: ReadableReplicaFailureCode): string {
  return code ? FAILURE_TITLES[code] : FAILURE_TITLES.empty
}

/* Why no replica can exist for this visit — the reader only asks the API
   for a signed-in member reading a bookmark (not a collection note) that
   was opened from a Collection and actually has a URL. */
type ReplicaUnavailableReason = 'flag-off' | 'signed-out' | 'no-collection' | 'collection-subject' | 'no-url'

type ReplicaPresentation =
  | { kind: 'ready' }
  | { kind: 'loading' }
  | { kind: 'stalled' }
  | { kind: 'failed'; failureCode: ReadableReplicaFailureCode }
  | { kind: 'unsupported' }
  | { kind: 'unavailable'; reason: ReplicaUnavailableReason }

function presentReplica(
  replica: { status: ReadableReplicaUiStatus; sections: ReadableReplicaSectionView[]; failureCode: ReadableReplicaFailureCode; pollExhausted: boolean },
  enabled: boolean,
  unavailable: ReplicaUnavailableReason,
): ReplicaPresentation {
  if (!enabled) return { kind: 'unavailable', reason: unavailable }
  switch (replica.status) {
    case 'ready':
      // A "ready" replica with nothing in it reads as a failed extraction,
      // not as an article with no words.
      return replica.sections.length > 0 ? { kind: 'ready' } : { kind: 'failed', failureCode: 'empty' }
    case 'failed':
      return { kind: 'failed', failureCode: replica.failureCode }
    case 'unsupported':
      return { kind: 'unsupported' }
    case 'pending':
      return replica.pollExhausted ? { kind: 'stalled' } : { kind: 'loading' }
    case 'none':
    case 'flag-off':
      // `flag-off` while enabled is the one frame before the hook's effect
      // switches the snapshot to `none`; both mean "fetching".
      return { kind: 'loading' }
  }
}

const UNAVAILABLE_COPY: Record<ReplicaUnavailableReason, string> = {
  'flag-off': "In-app reading is not available yet. Read the page at its source.",
  'signed-out': 'Sign in to fetch a readable copy of this page and keep notes on it.',
  'no-collection': 'Open this bookmark from a Collection to read it here.',
  'collection-subject': 'Collection notes have no article to extract. Read the linked page at its source.',
  'no-url': 'This bookmark has no link, so there is nothing to fetch.',
}

function readMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 200))
}

const OUTLINE_WORDS = 6
const OUTLINE_MAX_CHARS = 48

/* Heading-less sections are labelled from their opening words. Scripts
   without spaces (CJK) yield one long token, so the label is also capped
   by characters. */
function firstWords(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'Untitled section'
  let label = words.slice(0, OUTLINE_WORDS).join(' ')
  const truncated = words.length > OUTLINE_WORDS || label.length > OUTLINE_MAX_CHARS
  if (label.length > OUTLINE_MAX_CHARS) label = label.slice(0, OUTLINE_MAX_CHARS - 1).trimEnd()
  return truncated ? `${label}…` : label
}

/* A leading section heading that only repeats the article title (the
   extractor kept the page h1) is dropped; later repeats stay — they can be
   legitimate section titles. */
function sectionHeading(section: ReadableReplicaSectionView, index: number, titles: Set<string>): string | null {
  const heading = section.heading.trim()
  if (!heading) return null
  if (index === 0 && titles.has(heading)) return null
  return heading
}

function ReplicaSkeleton() {
  return (
    <div className="reader-skeleton" aria-hidden data-testid="reader-skeleton">
      {Array.from({ length: 5 }).map((_, index) => (
        <span key={index} className="skeleton-block reader-skeleton-line" />
      ))}
    </div>
  )
}

function ReplicaState({ presentation, status, host, originalHref, onRetry }: {
  presentation: Exclude<ReplicaPresentation, { kind: 'ready' }>
  status: ReadableReplicaUiStatus
  host: string | null
  originalHref: string | null
  onRetry: () => void
}) {
  const location = useLocation()
  const openOriginal = (primary: boolean) => (originalHref
    ? <a href={originalHref} target="_blank" rel="noreferrer" className={primary ? 'btn btn-primary' : 'btn btn-secondary'}>Open original</a>
    : null)
  const retry = <button type="button" className="btn btn-primary" onClick={onRetry}>Retry extract</button>

  let title: string | null = null
  let text = ''
  let actions: ReactNode = null
  let role: 'status' | 'alert' = 'status'
  switch (presentation.kind) {
    case 'loading':
      text = `Fetching a readable copy from ${host ?? 'the source'}…`
      break
    case 'stalled':
      title = 'Still working — this page is taking longer than usual'
      text = 'The site may be slow or blocking automated fetches. Try again, or read the original.'
      actions = <>{retry}{openOriginal(false)}</>
      break
    case 'failed':
      role = 'alert'
      title = failureTitle(presentation.failureCode)
      text = `${productName()} couldn't build a readable copy of this page. Try again, or read it at the source.`
      actions = <>{retry}{openOriginal(false)}</>
      break
    case 'unsupported':
      title = "This isn't an article page"
      text = 'Only HTML article pages get an in-app copy. Read this one at its source.'
      actions = openOriginal(true)
      break
    case 'unavailable':
      title = 'No in-app copy for this bookmark'
      text = UNAVAILABLE_COPY[presentation.reason]
      actions = (
        <>
          {openOriginal(true)}
          {presentation.reason === 'signed-out' && <Link to={loginPath(location.pathname, location.search)} className="btn btn-secondary">Sign in</Link>}
        </>
      )
      break
  }

  return (
    <section
      className={presentation.kind === 'loading' ? 'reader-state reader-state--loading' : 'reader-state'}
      role={role}
      data-testid="reader-replica-state"
      data-replica-status={status}
      data-replica-kind={presentation.kind}
    >
      {presentation.kind === 'loading' && <ReplicaSkeleton />}
      <p className="section-label">Readable copy</p>
      {title && <h2 className="reader-state-title">{title}</h2>}
      <p className="reader-state-text">{text}</p>
      {actions && <div className="reader-state-actions">{actions}</div>}
    </section>
  )
}

export function Reader() {
  const { resourceId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const { isLoggedIn, bootstrapping } = useAuth()
  const allowWrite = isLoggedIn || bootstrapping
  const resolved = useResourceNode(resourceId)
  useDocumentTitle(resolved.status === 'ready' ? resolved.node.title : 'Reader')
  const [focus, setFocus] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [legacyNote, setLegacyNote] = useState(() => loadNote(resourceId))
  const [legacySaved, setLegacySaved] = useState(true)
  const [legacyComplete, setLegacyComplete] = useState(false)
  const { toast, success, error } = useToast()
  const annotationsEnabled = isLive('annotations') || annotationsAcceptanceCandidate()
  const readingProgressEnabled = isLive('readingProgress') && isLoggedIn
  const collectionId = searchParams.get('collectionId')?.trim() ?? ''
  const resourceType = searchParams.get('subjectType') === 'collection' ? 'collection' : 'node'
  const workspaceQuery = {
    collectionId: searchParams.get('collectionId'),
    subjectType: searchParams.get('subjectType'),
    slug: searchParams.get('slug'),
    fromGraph: searchParams.get('fromGraph') === '1',
  }
  const graphSlug = workspaceQuery.slug?.trim() ?? ''
  const graphReturn = workspaceQuery.fromGraph && graphSlug ? graphPath(graphSlug, resourceId) : null
  const locator = useMemo<AnnotationSubjectLocator | null>(() => (
    allowWrite && annotationsEnabled && collectionId
      ? { collectionId, resourceType, resourceId }
      : null
  ), [allowWrite, annotationsEnabled, collectionId, resourceId, resourceType])
  const annotation = useAnnotationWorkflow(locator, 'private')
  const readingProgress = useReadingProgress({ resourceType, resourceId, enabled: readingProgressEnabled })
  const progress = readingProgressEnabled ? Math.round(readingProgress.progress * 100) : 0
  const complete = readingProgressEnabled ? readingProgress.complete : legacyComplete
  const identityCopy = resourceNodeEmptyCopy(resolved)
  const exposureEnabled = isReadableReplicaExposureEnabled()
  const nodeUrl = resolved.status === 'ready' ? resolved.node.url : null
  const replicaEnabled = exposureEnabled
    && isLoggedIn
    && collectionId !== ''
    && resourceType === 'node'
    && resolved.status === 'ready'
    && Boolean(nodeUrl)
  const replica = useReadableReplica({ collectionId, nodeId: resourceId, enabled: replicaEnabled })
  const replicaUnavailable: ReplicaUnavailableReason = !exposureEnabled ? 'flag-off'
    : !isLoggedIn ? 'signed-out'
      : resourceType === 'collection' ? 'collection-subject'
        : collectionId === '' ? 'no-collection'
          : !nodeUrl ? 'no-url'
            : 'flag-off'
  const presentation = presentReplica(replica, replicaEnabled, replicaUnavailable)
  const replicaReady = presentation.kind === 'ready'

  useEffect(() => {
    if (!replicaReady || !readingProgressEnabled) return
    const onScroll = () => {
      const scrolling = document.documentElement
      const max = scrolling.scrollHeight - scrolling.clientHeight
      readingProgress.setProgress(max <= 0 ? 0 : scrolling.scrollTop / max)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [readingProgress, readingProgressEnabled, replicaReady])

  useEffect(() => {
    if (annotationsEnabled) return
    setLegacyNote(loadNote(resourceId))
    setLegacySaved(true)
    setLegacyComplete(false)
  }, [annotationsEnabled, resourceId])

  useEffect(() => {
    if (annotationsEnabled) return
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(`known.reader.note.${resourceId}`, legacyNote) } catch { /* demo-only storage */ }
      setLegacySaved(true)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [annotationsEnabled, legacyNote, resourceId])

  const savedLabel = annotationsEnabled
    ? !locator ? 'Notes unavailable'
      : annotation.state === 'saved' ? 'Notes saved' : annotation.state === 'saving' ? 'Saving note' : 'Note needs attention'
    : legacySaved ? 'Notes saved' : 'Saving note'

  /* Loading and failure shells keep a way back — a dead end with no back
     control reads as broken, not quiet. */
  const shellBackHref = graphReturn ?? resourceBackPath(workspaceQuery)
  const shellBackLabel = graphReturn ? 'Back to graph' : workspaceQuery.collectionId?.trim() || workspaceQuery.slug?.trim()
    ? 'Back to the collection'
    : 'Back to library'
  const shellTrail = (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <Link to={shellBackHref} className="trail-back" tabIndex={-1} aria-hidden>
        <Icon name="arrow-left" />
      </Link>
      <Link to={shellBackHref}>{shellBackLabel}</Link>
    </nav>
  )

  if (resolved.status === 'loading') {
    return (
      <div className="reader-page" data-testid="reader-page">
        {shellTrail}
        <PageShell>
          <div className="reading-shell">
            <LoadingState label="Loading bookmark" />
          </div>
        </PageShell>
      </div>
    )
  }

  if (resolved.status === 'unavailable' && identityCopy) {
    return (
      <AbsenceStage
        title={identityCopy.title}
        description={identityCopy.description}
        corners={ABSENCE_CORNERS.resource}
        exits={[{ to: shellBackHref, label: shellBackLabel }]}
      />
    )
  }

  if (resolved.status !== 'ready' || identityCopy) {
    return (
      <div className="reader-page" data-testid="reader-page">
        {shellTrail}
        <PageShell>
          <div className="reading-shell">
            <EmptyState
            icon={resolved.status === 'folder' ? 'folder' : resolved.status === 'auth-required' ? 'collection' : 'book'}
            titleAs="h1"
            title={identityCopy?.title ?? 'Bookmark unavailable'}
            description={identityCopy?.description}
            action={identityCopy?.login
              ? <Link to={loginPath(location.pathname, location.search)} className="btn btn-secondary">Sign in</Link>
              : resolved.status === 'needs-collection'
                ? <Link to="/library" className="btn btn-secondary">Open library</Link>
                : undefined}
            />
          </div>
        </PageShell>
      </div>
    )
  }

  const node = resolved.node
  const publicationSlug = resolved.publicationSlug
  const originalHref = safeExternalUrl(node.url)
  const host = node.url ? node.host : null
  const collectionHref = graphReturn ?? resourceBackPath(workspaceQuery, resolved)
  const titles = new Set([replica.title?.trim() ?? '', node.title.trim()].filter(Boolean))
  const headings = replica.sections.map((section, index) => sectionHeading(section, index, titles))
  const outline = replicaReady
    ? replica.sections.map((section, index) => {
      const heading = headings[index] ?? null
      return { id: section.id, label: heading ?? firstWords(section.paragraphs[0]?.text ?? ''), hasHeading: heading !== null }
    })
    : []
  const showOutline = outline.length > 1 || outline.some((entry) => entry.hasHeading)
  const staleSource = replicaReady
    && replica.sourceUrl !== ''
    && !replicaSourceMatchesNodeUrl(replica.sourceUrl, node.url)
  const showProgress = readingProgressEnabled && replicaReady
  const toolbarStatus = readingProgressEnabled ? readingProgress.message : savedLabel

  return (
    <div className={`reader-page ${focus ? 'is-focus' : ''}`} data-testid="reader-page">
      <Breadcrumb
        items={[
          { label: isLoggedIn ? 'Library' : 'Explore', to: isLoggedIn ? '/library' : '/explore' },
          { label: resolved.collectionTitle, to: publicationSlug || collectionId ? collectionHref : undefined },
          { label: node.title },
        ]}
      />
      <header
        className="reader-toolbar"
        role="group"
        aria-label="Reader controls"
        data-testid="reading-progress-state"
        data-progress={readingProgressEnabled ? readingProgress.progress : 0}
        data-progress-save-state={readingProgressEnabled ? readingProgress.saveState : 'saved'}
      >
        <Link to={collectionHref} className="reader-back" title={graphReturn ? 'Back to graph' : resolved.collectionTitle}>
          <Icon name="arrow-left" />
          <span className="reader-back-label">{graphReturn ? 'Back to graph' : resolved.collectionTitle}</span>
        </Link>
        <p className="reader-toolbar-meta">
          {showProgress && <span className="reader-toolbar-progress">{progress}% read</span>}
          <span
            className="reader-toolbar-status"
            data-save-state={readingProgressEnabled ? readingProgress.saveState : undefined}
          >{toolbarStatus}</span>
        </p>
        <div className="reader-toolbar-actions">
          {isLive('savedResources') && <SavedResourceButton resourceType={resourceType} resourceId={resourceId} />}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setDetailsOpen(true)}
          >
            Details
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm reader-focus-toggle"
            aria-pressed={focus}
            onClick={() => setFocus((value) => !value)}
          >Focus mode</button>
          {!isLoggedIn
            ? <Link to={loginPath(location.pathname, location.search)} className="btn btn-secondary btn-sm">Sign in to track reading</Link>
            : <button
              type="button"
              className={`btn btn-sm reader-complete ${complete ? 'btn-secondary' : 'btn-primary'}`}
              disabled={readingProgressEnabled && readingProgress.saveState === 'saving'}
              onClick={() => {
                const message = complete ? 'Marked incomplete' : 'Added to completed reading'
                if (readingProgressEnabled) {
                  void Promise.resolve(readingProgress.toggleComplete()).then((outcome) => { if (outcome === 'saved') toast(message) })
                  return
                }
                setLegacyComplete((value) => !value); toast(message)
              }}
            >{complete ? <><Icon name="check" /> Completed</> : 'Mark complete'}</button>}
          {/* 'unknown' still holds the pending command → retry re-sends it;
              'error' already reloaded authoritative state → retry refetches. */}
          {readingProgressEnabled && (readingProgress.saveState === 'unknown' || readingProgress.saveState === 'error') && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={readingProgress.saveState === 'unknown' ? readingProgress.retry : readingProgress.reload}
            >Retry progress</button>
          )}
        </div>
        {showProgress && <ProgressBar className="reader-progress" value={progress} label="Reading progress" />}
      </header>

      <PageShell sections>
        <PageSection className="reading-shell reader-layout">
        <article className="reader-article rise">
          <PageHead
            as="header"
            className="reader-article-head"
            layout="masthead"
            variant="editorial"
            documentTitle={node.title}
            eyebrow={
              <span className="reading-meta reader-source-line" data-testid="reader-source-line">
                {host && (
                  <>
                    <DomainMark host={host} small pageUrl={originalHref} faviconCdnAllowed={node.faviconCdnAllowed} />
                    <span className="reader-source-host">{host}</span>
                  </>
                )}
                {replica.byline ? <span className="reader-byline" data-testid="reader-byline">{replica.byline}</span> : null}
                {replicaReady && <span className="reader-read-time">{readMinutes(replica.wordCount)} min read</span>}
              </span>
            }
            title={node.title}
          >
            {node.description ? <p className="reading-body reader-standfirst">{node.description}</p> : null}
          </PageHead>

          {/* Below 900px the context rail sits after the whole article, so
              the same outline is offered as a disclosure at the column head
              (reader.css hides it again once the rail returns). */}
          {replicaReady && showOutline && (
            <details className="reader-contents-inline">
              <summary className="section-label">Contents</summary>
              <ol className="reader-outline-list">
                {outline.map((entry) => (
                  <li key={entry.id}>
                    <a className="reader-outline-link" href={`#${entry.id}`}>{entry.label}</a>
                  </li>
                ))}
              </ol>
            </details>
          )}

          {replicaReady ? (
            <div className="reading-body reader-body">
              {staleSource && (
                <div className="reader-notice" role="status">
                  <span className="reader-notice-text">This copy was extracted from a different address than the bookmark now points to.</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => replica.retry(true)}>Retry extract</button>
                </div>
              )}
              {replica.sections.map((section, index) => {
                const heading = headings[index] ?? null
                return (
                  <section key={section.id} id={section.id} className="reader-section">
                    {heading && <h2 className="reader-section-title">{heading}</h2>}
                    {section.paragraphs.map((paragraph) => {
                      const highlighted = annotation.highlighted.has(paragraph.id)
                      return (
                        <div
                          key={paragraph.id}
                          data-testid="reader-paragraph"
                          className={highlighted ? 'reader-paragraph is-highlighted' : 'reader-paragraph'}
                        >
                          <p>{paragraph.text}</p>
                          {locator && (
                            <button
                              type="button"
                              className="reader-mark"
                              aria-pressed={highlighted}
                              aria-label={highlighted ? 'Remove highlight' : 'Highlight paragraph'}
                              title={highlighted ? 'Remove highlight' : 'Highlight paragraph'}
                              onClick={() => annotation.toggleHighlight(paragraph.id)}
                            >
                              <span className="reader-mark-glyph" aria-hidden />
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </section>
                )
              })}
            </div>
          ) : (
            <ReplicaState
              presentation={presentation}
              status={replica.status}
              host={host}
              originalHref={originalHref}
              onRetry={() => replica.retry(true)}
            />
          )}

          {(resolved.previous || resolved.next) && (
            <nav className="reader-next" aria-label="Previous and next bookmarks">
              {resolved.previous
                ? <Link to={resourceReaderPath(resolved.previous.id, workspaceQuery)}><span>Previous</span><strong>{resolved.previous.title}</strong></Link>
                : <span />}
              {resolved.next && <Link to={resourceReaderPath(resolved.next.id, workspaceQuery)}><span>Next</span><strong>{resolved.next.title}</strong></Link>}
            </nav>
          )}
        </article>

        <aside className="reader-context">
          {showOutline && (
            <section className="reader-panel reader-panel--contents" aria-labelledby="reader-contents-heading">
              <h3 className="section-label" id="reader-contents-heading">Contents</h3>
              <ol className="reader-outline-list">
                {outline.map((entry) => (
                  <li key={entry.id}>
                    <a className="reader-outline-link" href={`#${entry.id}`}>{entry.label}</a>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {annotationsEnabled ? (
            <section className="reader-panel reader-note-panel annotation-workspace" data-testid="annotation-workspace" aria-labelledby="private-note-heading">
              <div className="reader-panel-head">
                <h3 className="section-label" id="private-note-heading">Private note</h3>
                {/* Without a locator the workflow never loads, so its initial
                    "Loading annotations" would be a lie — the body explains
                    the missing collection context instead. */}
                {allowWrite && locator && (
                  <span
                    className="reader-panel-status"
                    role="status"
                    aria-live="polite"
                    data-testid="annotation-save-state"
                    data-save-state={annotation.state}
                  >{annotation.message}</span>
                )}
              </div>
              {!allowWrite ? (
                <p className="lede">
                  <Link to={loginPath(location.pathname, location.search)}>Sign in</Link> to save private notes.
                </p>
              ) : !locator ? (
                <p className="annotation-inline-error" role="alert">Open this bookmark from its collection to add notes.</p>
              ) : (
                <>
                  <textarea
                    ref={annotation.noteInputRef}
                    aria-label="Private note"
                    value={annotation.draft}
                    onChange={(event) => annotation.setDraft(event.target.value)}
                    placeholder="Questions, connections, or what to revisit…"
                    rows={8}
                    disabled={['loading', 'saving', 'unknown', 'conflict'].includes(annotation.state)}
                  />
                  <div className="annotation-actions">
                    {annotation.state === 'unknown' ? (
                      <button type="button" className="btn btn-primary btn-sm" onClick={annotation.retry}>
                        {annotation.pending?.kind.startsWith('delete') ? 'Retry delete' : 'Retry save'}
                      </button>
                    ) : annotation.state === 'stale' ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={annotation.startNewPending}
                      >{annotation.pending?.kind?.startsWith('delete')
                          ? annotation.pending.kind === 'delete-note' ? 'Delete current version' : 'Delete current highlight'
                          : annotation.pending?.kind === 'create-highlight' ? 'Apply highlight' : 'Save my version'}</button>
                    ) : annotation.state === 'conflict' ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={annotation.startNewPending}
                      >{annotation.pending?.kind?.includes('highlight')
                          ? 'Start new highlight action'
                          : annotation.pending?.kind === 'delete-note' ? 'Start new delete' : 'Start new save'}</button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={annotation.state === 'loading' || annotation.state === 'saving' || !annotation.dirty}
                        onClick={() => annotation.saveNote()}
                      >Save note</button>
                    )}
                    {annotation.note && annotation.state !== 'unknown' && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={annotation.state === 'saving'} onClick={() => annotation.deleteNote()}>Delete note</button>
                    )}
                    {annotation.state === 'error' && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={annotation.reload}>Retry loading</button>
                    )}
                  </div>
                </>
              )}
            </section>
          ) : (
            <section className="reader-panel reader-note-panel">
              <div className="reader-panel-head">
                <h3 className="section-label">Private note</h3>
                <span className="reader-panel-status">{legacySaved ? 'Saved locally' : 'Saving'}</span>
              </div>
              {/* R9-31: the legacy local-note branch keeps its own
                  .reader-note-panel chrome but still gets the .field wrap and
                  a real (visually hidden) label instead of a bare aria-label. */}
              <div className="field">
                <label className="visually-hidden" htmlFor="reader-legacy-note">Private note</label>
                <textarea id="reader-legacy-note" value={legacyNote} onChange={(event) => { setLegacySaved(false); setLegacyNote(event.target.value) }} placeholder="Questions, connections, or what to revisit…" rows={8} />
              </div>
            </section>
          )}
          <section className="reader-panel" aria-labelledby="reader-source-heading">
            <h3 className="section-label" id="reader-source-heading">Source</h3>
            {host && (
              <p className="reader-citation-origin">
                <DomainMark host={host} small pageUrl={originalHref} faviconCdnAllowed={node.faviconCdnAllowed} />
                <span className="reader-citation-host">{host}</span>
              </p>
            )}
            <strong className="reader-citation-title">{node.title}</strong>
            <div className="reader-citation-actions">
              {originalHref
                ? <a href={originalHref} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">Open original</a>
                : <span className="meta">Written in {productName()}. There is no original page.</span>}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void copyTextToClipboard(originalHref ? `${node.title} — ${originalHref}` : node.title).then(() => success('Citation copied'), () => error("Couldn't copy the citation")) }}>Copy citation</button>
            </div>
          </section>
        </aside>
        </PageSection>
      </PageShell>
      <Modal
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        label="Bookmark details"
        title="Bookmark details"
      >
        <dl className="reader-details">
          <div>
            <dt>Title</dt>
            <dd>{node.title}</dd>
          </div>
          {originalHref && (
            <div>
              <dt>URL</dt>
              <dd>
                <a href={originalHref} target="_blank" rel="noreferrer">{node.url}</a>
              </dd>
            </div>
          )}
          {node.description && (
            <div>
              <dt>Description</dt>
              <dd>{node.description}</dd>
            </div>
          )}
          <div>
            <dt>Collection</dt>
            <dd>
              <Link to={collectionHref}>{resolved.collectionTitle}</Link>
            </dd>
          </div>
        </dl>
        <div className="empty-state-actions">
          <Link
            to={resourceDetailPath(node.id, workspaceQuery)}
            className="btn btn-secondary btn-sm"
          >
            Public page
          </Link>
          {isLoggedIn && collectionId && (
            <Link
              to={`/library/${encodeURIComponent(collectionId)}?node=${encodeURIComponent(node.id)}`}
              className="btn btn-primary btn-sm"
            >
              Edit in library
            </Link>
          )}
        </div>
      </Modal>
    </div>
  )
}
