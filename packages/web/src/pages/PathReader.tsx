import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ABSENCE_CORNERS, AbsenceStage } from '../components/AbsenceStage'
import { Breadcrumb } from '../components/Breadcrumb'
import { useToast } from '../components/AppToast'
import { RouteLoading } from '../components/RouteLoading'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { ProgressBar } from '../components/ProgressBar'
import { SavedResourceButton } from '../components/SavedResourceButton'
import { isLive } from '../api'
import { useAuth } from '../auth/AuthContext'
import { flattenPublicCollection } from '../lib/publicCollectionTree'
import { resourceKindLabel } from '../lib/resourceKind'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { usePublicCollectionSnapshot } from '../lib/usePublicCollectionSnapshot'
import { usePageMeta } from '../lib/usePageMeta'
import { publicCollectionDescription } from '../lib/publicCollectionMeta'
import { useReadingProgress, useReadingProgressList } from '../lib/useReadingProgress'
import { resourceDetailPath } from '../lib/useResourceNode'
// Shared product-loop stylesheet (see main.tsx); ships with this route chunk.
import '../styles/not-found.css'
import '../styles/path-reader.css'

const DONE_KEY = 'known.path.done.v1'
const ACTIVE_KEY = 'known.path.active.v1'

function loadDone(slug: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${DONE_KEY}.${slug}`)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function saveDone(slug: string, ids: Set<string>) {
  try {
    localStorage.setItem(`${DONE_KEY}.${slug}`, JSON.stringify([...ids]))
  } catch {
    /* ignore */
  }
}

/* The last viewed step survives a resource hop: without it a warm remount
   paints steps[0] for a frame, then visibly jumps to the first open step. */
function loadActive(slug: string): string {
  try {
    return localStorage.getItem(`${ACTIVE_KEY}.${slug}`) ?? ''
  } catch {
    return ''
  }
}

function saveActive(slug: string, id: string) {
  try {
    localStorage.setItem(`${ACTIVE_KEY}.${slug}`, id)
  } catch {
    /* ignore */
  }
}

export function PathReader() {
  const { slug = '' } = useParams()
  const { load, retry } = usePublicCollectionSnapshot(slug)
  const { toast, error } = useToast()
  const readingProgressEnabled = isLive('readingProgress')
  const { isLoggedIn } = useAuth()
  // Server progress needs an account; guests keep progress on this device.
  const syncProgress = readingProgressEnabled && isLoggedIn
  const snapshot = load.status === 'ready' ? load.snapshot : null
  const collection = snapshot?.collection ?? null
  // Flattening the whole tree on every render also gave `steps` a new identity
  // each time, which re-ran every effect that depends on it.
  const published = useMemo(() => (snapshot ? flattenPublicCollection(snapshot) : null), [snapshot])
  const steps = useMemo(
    () => (collection?.kind === 'reading_path' && published ? published.resources : []),
    [collection?.kind, published],
  )

  const [done, setDone] = useState(() => loadDone(slug))
  const [active, setActive] = useState(() => loadActive(slug))

  useEffect(() => {
    setDone(loadDone(slug))
    setActive(loadActive(slug))
  }, [slug])

  const selectActive = (id: string) => {
    setActive(id)
    saveActive(slug, id)
  }

  useEffect(() => {
    if (steps.length === 0) return
    if (steps.some((step) => step.node.id === active)) return
    const firstOpen = steps.find((step) => !loadDone(slug).has(step.node.id))
    selectActive(firstOpen?.node.id ?? steps[0]?.node.id ?? '')
    // selectActive is stable enough here: it only forwards to setActive + saveActive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, slug, active])

  const current = steps.find((step) => step.node.id === active) ?? steps[0]
  const progressList = useReadingProgressList()
  const currentProgress = useReadingProgress({
    resourceType: 'node',
    resourceId: current?.node.id ?? 'unavailable',
    enabled: syncProgress && Boolean(current),
  })
  const serverDone = useMemo(
    () => new Set(progressList.items.filter((item) => item.status === 'completed').map((item) => item.resourceId)),
    [progressList.items],
  )
  const currentNodeId = current?.node.id
  const currentStatus = currentProgress.status
  const effectiveDone = useMemo(
    () => (syncProgress
      ? new Set(steps.filter((step) => (
        serverDone.has(step.node.id) || (step.node.id === currentNodeId && currentStatus === 'completed')
      )).map((step) => step.node.id))
      : done),
    [syncProgress, steps, serverDone, currentNodeId, currentStatus, done],
  )
  const idx = steps.findIndex((step) => step.node.id === current?.node.id)
  const progress = useMemo(
    () => Math.round((effectiveDone.size / Math.max(steps.length, 1)) * 100),
    [effectiveDone, steps.length],
  )

  const documentTitle =
    load.status === 'ready' && collection
      ? collection.title
      : load.status === 'unavailable'
        ? 'Collection unavailable'
        : load.status === 'error'
          ? 'Collection error'
          : 'Reading path'
  useDocumentTitle(documentTitle)
  usePageMeta(
    // R15-22: a transient error (429, 503) leaves the head alone; only an
    // unavailable or missing page is noindexed.
    load.status === 'loading' || load.status === 'error'
      ? {}
      : load.status === 'ready' && collection?.kind === 'reading_path' && published
        ? {
            description: publicCollectionDescription(collection),
            canonicalPath: `/c/${encodeURIComponent(collection.slug)}`,
          }
        : { canonicalPath: null, robots: 'noindex' },
    `${documentTitle} — Know-N`,
  )

  const markDone = () => {
    if (!current) return
    const title = current.node.title
    if (syncProgress) {
      /* Advance only once the write lands — otherwise the check would vanish
         with the step change and the failure would leave no trace. */
      void Promise.resolve(currentProgress.toggleComplete()).then((outcome) => {
        if (outcome === 'saved') {
          toast(`Completed · ${title}`)
          const nextStep = steps[idx + 1]
          if (nextStep) selectActive(nextStep.node.id)
        } else if (outcome !== 'skipped') {
          /* 'skipped' means a newer write superseded this one (the write may
             still have landed) — an error toast would misreport it. */
          error(`Could not save progress — still on “${title}”`)
        }
      })
      return
    }
    toast(`Completed · ${title}`)
    const next = new Set(effectiveDone)
    next.add(current.node.id)
    setDone(next); saveDone(slug, next)
    const nextStep = steps[idx + 1]
    if (nextStep) selectActive(nextStep.node.id)
  }

  const markUndone = () => {
    if (!current) return
    if (syncProgress) {
      void Promise.resolve(currentProgress.toggleComplete()).then((outcome) => {
        if (outcome === 'saved') toast('Marked incomplete')
        else if (outcome !== 'skipped') error('Could not save progress — this step stays complete')
      })
      return
    }
    toast('Marked incomplete')
    const next = new Set(effectiveDone)
    next.delete(current.node.id)
    setDone(next); saveDone(slug, next)
  }

  if (load.status === 'loading') {
    return <RouteLoading label={load.restartCount > 0 ? 'Refreshing the collection snapshot…' : 'Loading collection…'} />
  }

  if (load.status === 'unavailable') {
    return (
      <AbsenceStage
        title="Collection unavailable"
        description="This collection was not found, has been withdrawn, or is not available to this account."
        corners={ABSENCE_CORNERS.collection}
        exits={[{ to: '/', label: 'Back home' }]}
      />
    )
  }

  if (load.status === 'error') {
    return (
      <PageShell variant="bare">
        <RouteState kind="error" titleAs="h1" title="Couldn't load this collection" description={load.message} onRetry={retry} />
      </PageShell>
    )
  }

  if (!collection || !published) {
    return (
      <AbsenceStage
        title="Collection unavailable"
        description="This collection is still being published. Try again in a moment."
        corners={ABSENCE_CORNERS.collection}
        exits={[{ label: 'Try again', onClick: retry }, { to: '/', label: 'Back home' }]}
      />
    )
  }

  if (collection.kind !== 'reading_path') {
    return (
      <AbsenceStage
        title="Not a reading path"
        description="This collection is published as a board, not a guided path."
        corners={ABSENCE_CORNERS.path}
        exits={[{ to: `/c/${collection.slug}`, label: 'Open collection' }]}
      />
    )
  }

  return (
    <PageShell variant="narrow" className="reading-shell">
      <PageHead
        className="page-head--editorial"
        breadcrumb={
          <Breadcrumb items={[{ label: 'Explore', to: '/explore' }, { label: collection.title, to: `/c/${collection.slug}` }, { label: 'Reading path' }]} />
        }
        eyebrow="Guided path"
        title={collection.title}
        documentTitle={collection.title}
        lede={`Step through a curated sequence. ${syncProgress ? 'Progress syncs to your account.' : 'Progress stays on this device.'}`}
      />

      <div className="row-between row-between--baseline mt-2">
        <span className="meta">
          {effectiveDone.size} of {steps.length} complete
        </span>
        <span className="meta">{progress}%</span>
      </div>
      <ProgressBar className="path-progress" value={progress} />

      <div className="path-step-list" role="group" aria-label="Path steps">
        {steps.map((step, index) => {
          const isDone = effectiveDone.has(step.node.id)
          const isActive = step.node.id === active
          const stepKind = resourceKindLabel(step.host)
          return (
            <button
              key={step.node.id}
              type="button"
              className={`path-step ${isActive ? 'is-active' : ''} ${isDone ? 'is-done' : ''}`}
              aria-current={isActive ? 'step' : undefined}
              onClick={() => selectActive(step.node.id)}
            >
              <span className="path-step-num">{isDone ? <Icon name="check" /> : index + 1}</span>
              <span>
                <strong className="path-step-title">{step.node.title}</strong>
                <span className="meta">
                  {stepKind !== 'Link' ? `${stepKind} · ` : ''}{step.host}
                </span>
              </span>
              <span className="meta">{isDone ? 'Done' : ''}</span>
            </button>
          )
        })}
      </div>

      {current && (
        <article className="path-stage">
          <p className="section-label">
            Step {idx + 1} of {steps.length}
          </p>
          <h2 className="reading-title reading-title--compact path-stage-title">
            {current.node.title}
          </h2>
          <p className="meta">
            {resourceKindLabel(current.host) !== 'Link' ? `${resourceKindLabel(current.host)} · ` : ''}{current.host}
          </p>
          {current.node.description && (
            <p className="reading-body reading-body--compact path-stage-summary">
              {current.node.description}
            </p>
          )}
          <div className="path-stage-actions" role="group" aria-label="Path step actions">
            {isLive('savedResources') && <SavedResourceButton resourceType="node" resourceId={current.node.id} />}
            <Link
              className="btn btn-primary"
              to={resourceDetailPath(current.node.id, {
                collectionId: collection.id,
                subjectType: 'node',
                slug: collection.slug,
              })}
            >
              Open bookmark
            </Link>
            {effectiveDone.has(current.node.id) ? (
              <button type="button" className="btn btn-secondary" onClick={markUndone}>
                Mark incomplete
              </button>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={markDone}>
                Mark complete
                {idx < steps.length - 1 ? ' · next' : ''}
              </button>
            )}
            <Link to={`/c/${collection.slug}`} className="btn btn-ghost">
              Board view
            </Link>
            <Link to={`/graph/${collection.slug}`} className="btn btn-ghost">
              Graph
            </Link>
          </div>
        </article>
      )}
    </PageShell>
  )
}
