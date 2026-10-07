import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { productClient, type OwnedCollectionListItem } from '../api'
import { getSessionSnapshot, subscribeSession } from '../api/sessionStore'
import { useAuth } from '../auth/AuthContext'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { RouteState } from '../components/RouteState'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { SelectMenu } from '../components/SelectMenu'
import { plural, pluralNoun } from '../lib/plural'
import { resourceDetailPath } from '../lib/useResourceNode'

type PublishingInsights = Awaited<ReturnType<typeof productClient.getMyPublishingInsights>>
type LoadState = 'loading' | 'ready' | 'error'

function privateIdentity() {
  const snapshot = getSessionSnapshot()
  return `${snapshot.me?.account.id ?? 'anonymous'}:${snapshot.sessionEpoch}`
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isPublishedPublic(item: OwnedCollectionListItem): boolean {
  const { visibility, publicationSlug, publishedAt } = item.collection
  return (visibility === 'public' || visibility === 'unlisted') && !!publicationSlug && !!publishedAt
}

function pickLatestPublishedPublicCollection(items: readonly OwnedCollectionListItem[]): OwnedCollectionListItem['collection'] | null {
  let latest: OwnedCollectionListItem | undefined
  for (const item of items) {
    if (!isPublishedPublic(item)) continue
    if (!latest) {
      latest = item
      continue
    }
    const order = item.collection.updatedAt.localeCompare(latest.collection.updatedAt)
    if (order > 0 || (order === 0 && item.collection.id.localeCompare(latest.collection.id) < 0)) {
      latest = item
    }
  }
  return latest?.collection ?? null
}

/** The collection the head's Edit button opens, named so the button never
    edits an anonymous target. */
type EditTarget = { id: string; title: string | null }

function weekSparkline(weeks: Array<{ w: string; views: number }>) {
  const values = weeks.map((week) => week.views)
  const width = 320
  const height = 96
  if (values.length === 0) {
    return { line: '', area: '', width, height, labels: weeks }
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = max === min ? Math.max(1, Math.abs(max) * 0.08 || 1) : (max - min) * 0.18
  const lo = min - pad
  const hi = max + pad
  const span = hi - lo || 1
  const step = values.length === 1 ? 0 : width / (values.length - 1)
  const points = values.map((value, index) => {
    const x = index * step
    const y = height - ((value - lo) / span) * height
    return { x, y }
  })
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')
  const area = `${line} L${width} ${height} L0 ${height} Z`
  return { line, area, width, height, labels: weeks }
}

function WeekSparkline({ weeks }: { weeks: Array<{ w: string; views: number }> }) {
  const spark = weekSparkline(weeks)
  return (
    <div className="week-chart">
      <svg
        className="week-sparkline"
        viewBox={`0 0 ${spark.width} ${spark.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Weekly collection views"
      >
        <path className="week-sparkline-area" d={spark.area} />
        <path className="week-sparkline-line" d={spark.line} fill="none" />
      </svg>
      <ol className="week-sparkline-legend">
        {spark.labels.map((week) => (
          <li key={week.w} className="week-bar" title={`${week.views} views`}>
            <span className="week-bar-value">{week.views.toLocaleString()}</span>
            <span>{week.w}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function CreatorHead({ afterTitle, actions }: { afterTitle?: ReactNode; actions?: ReactNode }) {
  return (
    <PageSection>
      <PageHead
        variant="workbench"
        layout={actions ? 'split' : undefined}
        eyebrow="Account"
        title="Publishing insights"
        documentTitle="Publishing insights"
        lede="Track how people discover and use your public collections."
        afterTitle={afterTitle}
        actions={actions}
      />
    </PageSection>
  )
}

/** Head wayfinding for the collection Edit opens: a "Collection:" pill when
    the account owns more than one published collection, a meta line
    otherwise. */
function CollectionChooser({ target, choices, fallbackTitle, onChange }: {
  target: EditTarget
  choices: readonly EditTarget[]
  fallbackTitle: string | undefined
  onChange: (target: EditTarget) => void
}) {
  const label = (item: EditTarget) => item.title ?? `The collection holding ${fallbackTitle ?? 'your top bookmark'}`
  const options = choices.some((item) => item.id === target.id) ? choices : [target, ...choices]
  if (choices.length > 1) {
    return (
      <SelectMenu
        label="Collection"
        prefix="Collection:"
        testId="creator-collection-select"
        value={target.id}
        options={options.map((item) => ({ value: item.id, label: label(item) }))}
        onChange={(id) => {
          const next = options.find((item) => item.id === id)
          if (next) onChange(next)
        }}
      />
    )
  }
  return (
    <p className="meta" data-testid="creator-edit-target">
      {target.title
        ? <>Collection: <strong>{target.title}</strong></>
        : <>The collection holding <strong>{fallbackTitle}</strong></>}
    </p>
  )
}

export function Creator() {
  const { isLoggedIn, bootstrapping } = useAuth()
  const [identity, setIdentity] = useState(privateIdentity)
  const [state, setState] = useState<LoadState>('loading')
  const [insights, setInsights] = useState<PublishingInsights | null>(null)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [choices, setChoices] = useState<EditTarget[]>([])
  const generation = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => subscribeSession(() => setIdentity(privateIdentity())), [])

  const load = useCallback(async () => {
    const snapshot = getSessionSnapshot()
    controllerRef.current?.abort()
    controllerRef.current = null
    const requestGeneration = ++generation.current
    const requestedIdentity = privateIdentity()
    setInsights(null)
    setEditTarget(null)
    setChoices([])
    if (!snapshot.authenticated || !snapshot.me) {
      setState('ready')
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    setState('loading')
    const stale = () => (
      controller.signal.aborted
      || requestGeneration !== generation.current
      || requestedIdentity !== privateIdentity()
    )
    try {
      const data = await productClient.getMyPublishingInsights({
        signal: controller.signal,
        maxRetries: 0,
      })
      if (stale()) return
      const topCollectionId = data.topResources[0]?.collectionId ?? null
      let target: EditTarget | null = topCollectionId ? { id: topCollectionId, title: null } : null
      let published: EditTarget[] = []
      try {
        const page = await productClient.getOwnedCollectionsPage(
          { limit: 30 },
          { signal: controller.signal, maxRetries: 0 },
        )
        if (stale()) return
        published = page.items.filter(isPublishedPublic).map((item) => ({ id: item.collection.id, title: item.collection.title }))
        if (topCollectionId) {
          const owned = page.items.find((item) => item.collection.id === topCollectionId)
          target = { id: topCollectionId, title: owned?.collection.title ?? null }
        } else {
          const latest = pickLatestPublishedPublicCollection(page.items)
          target = latest ? { id: latest.id, title: latest.title } : null
        }
      } catch (error) {
        if (stale() || isAbort(error)) return
      }
      if (stale()) return
      setInsights(data)
      setEditTarget(target)
      setChoices(published)
      setState('ready')
    } catch (error) {
      if (stale() || isAbort(error)) return
      setInsights(null)
      setEditTarget(null)
      setState('error')
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (bootstrapping || !isLoggedIn) {
      controllerRef.current?.abort()
      return
    }
    void load()
    return () => {
      controllerRef.current?.abort()
      generation.current += 1
    }
  }, [bootstrapping, isLoggedIn, load, identity])

  const totalViews = insights?.funnel[0]?.value ?? 0
  const previewOpens = insights?.funnel[1]?.value ?? 0
  const resourceOpens = insights?.topResources.reduce((total, resource) => total + resource.opens, 0) ?? 0
  const previewRate = totalViews === 0 ? 0 : (previewOpens / totalViews) * 100
  const ready = state === 'ready' && insights !== null && isLoggedIn && !bootstrapping

  return (
    <PageShell variant="grid" data-testid="creator-page" sections>
      <CreatorHead
        afterTitle={ready && editTarget ? (
          <CollectionChooser
            target={editTarget}
            choices={choices}
            fallbackTitle={insights?.topResources[0]?.title}
            onChange={setEditTarget}
          />
        ) : undefined}
        actions={ready && editTarget ? (
          <Link
            to={`/library/${encodeURIComponent(editTarget.id)}?collection=edit`}
            className="btn btn-secondary"
          >
            Edit collection
          </Link>
        ) : undefined}
      />

      {bootstrapping ? (
        <PageSection>
          <LoadingState label="Loading publishing insights…" />
        </PageSection>
      ) : !isLoggedIn ? (
        <PageSection>
          <RouteState
            kind="auth"
            icon="collection"
            title="Sign in to view publishing insights"
            description="Views, the weekly trend, and top bookmarks are private to your account."
            returnTo="/creator"
          />
        </PageSection>
      ) : state === 'error' ? (
        <PageSection>
          <EmptyState
            role="alert"
            icon="collection"
            title="Couldn't load publishing insights"
            description="Check your connection and try again."
            action={
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
                Try again
              </button>
            }
          />
        </PageSection>
      ) : state === 'loading' || !insights ? (
        <PageSection>
          <LoadingState label="Loading publishing insights…" />
        </PageSection>
      ) : (
        <>
          <PageSection className="creator-stats" data-testid="creator-stats">
            <div className="creator-stat">
              <div className="label">Collection views</div>
              <div className="value">{totalViews.toLocaleString()}</div>
              <p className="meta">Last {plural(insights.window.days, 'day')}</p>
            </div>
            <div className="creator-stat">
              <div className="label">Preview opens</div>
              <div className="value">{previewOpens.toLocaleString()}</div>
              <p className="meta">
                {previewRate.toFixed(1)}% of collection views
              </p>
            </div>
            <div className="creator-stat">
              <div className="label">Top bookmark opens</div>
              <div className="value">{resourceOpens.toLocaleString()}</div>
              <p className="meta">Across the three leading bookmarks</p>
            </div>
          </PageSection>

          <PageSection>
            <section className="panel panel-pad creator-trend">
              <div>
                <p className="section-label">Weekly views</p>
                <h2>Discovery trend</h2>
                <WeekSparkline weeks={insights.weekly} />
              </div>
              <div>
                <h3 className="section-label">Top bookmarks</h3>
                {insights.topResources.length === 0 ? (
                  <p className="meta">No bookmark opens yet.</p>
                ) : (
                  <ul className="insight-list" data-testid="creator-insight-list">
                    {insights.topResources.map((resource) => (
                      <li key={resource.id}>
                        <Link to={resourceDetailPath(resource.id, { collectionId: resource.collectionId, subjectType: 'node' })}>{resource.title}</Link>
                        <span className="meta">{resource.opens.toLocaleString()} {pluralNoun(resource.opens, 'open')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </PageSection>
        </>
      )}
    </PageShell>
  )
}
