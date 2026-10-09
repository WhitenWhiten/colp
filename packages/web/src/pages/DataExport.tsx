import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isExportJobsExposureEnabled,
  isProductApiError,
  productClient,
  type ExportJob,
  type ExportJobStatus,
} from '../api'
import { Breadcrumb } from '../components/Breadcrumb'
import { useToast } from '../components/AppToast'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { FilterRail } from '../components/FilterRail'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'

import { RouteState } from '../components/RouteState'
import { useAuth } from '../auth/AuthContext'
import { formatMediumInstant } from '../lib/formatDate'
import { libraryFeatureUnavailable } from '../lib/libraryCopy'
import { isAbort } from '../lib/libraryTree'
import type { ExportFormat } from '../lib/exportLibrary'
import { saveLibraryExport } from '../lib/exportDownload'
import { useRouteData } from '../lib/useRouteData'
// Shared product-loop stylesheet (see main.tsx); ships with this route chunk.
import '../styles/data-export.css'

const EMPTY_JOBS: ExportJob[] = []
const POLL_MS = 2000
const CREATE_INTENT = 'create-export-job'

const formatOptions = [
  { id: 'Markdown' as const, hint: 'Readable outline with links and metadata', ext: '.md' },
  { id: 'JSON' as const, hint: 'Complete structured data for migration', ext: '.json' },
  { id: 'HTML' as const, hint: 'An offline library index with source links', ext: '.html' },
]

const portableItems = [
  'Stable collection and resource IDs',
  'Owned live folder structure',
  'Private collection titles',
  'Original source URLs',
  'Visibility on each collection',
]

function ExportHead() {
  return (
    <PageHead
      as="header"
      variant="workbench"
      breadcrumb={
        <Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'Export' }]} />
      }
      title="Export your library"
      documentTitle="Export"
      lede="Download an archive of the collections you own, including private ones."
    />
  )
}

function statusCopy(job: ExportJob): string {
  switch (job.status) {
    case 'pending':
      return 'Queued'
    case 'running':
      return 'Preparing export'
    case 'ready':
      return 'Ready'
    case 'failed':
      return job.errorClass === 'over_capacity' ? 'Failed: library too large to export' : 'Failed'
    case 'expired':
      return 'Expired'
  }
}

function isInFlight(status: ExportJobStatus): boolean {
  return status === 'pending' || status === 'running'
}

function isDownloadable(job: ExportJob): boolean {
  if (job.status !== 'ready') return false
  if (job.expiresAt == null) return true
  return Date.parse(job.expiresAt) > Date.now()
}

function UnavailableState() {
  return (
    <PageShell variant="grid" className="export-page" data-testid="export-jobs-flag-off">
      <ExportHead />
      <EmptyState
        icon="folder"
        title="Library export is not available yet"
        description={libraryFeatureUnavailable('library export')}
      />
    </PageShell>
  )
}

export function DataExport() {
  const enabled = isExportJobsExposureEnabled()
  const { isLoggedIn, user } = useAuth()
  const identityKey = isLoggedIn ? user?.accountId ?? null : null
  const identityRef = useRef<string | null>(identityKey)
  identityRef.current = identityKey
  const { toast, error: showError } = useToast()
  const loadFailed = useRef(false)
  // Only jobs seen in flight during this visit may toast when they fail;
  // failures already on record at load belong in Recent archives only.
  const observedInFlight = useRef(new Set<string>())
  const [format, setFormat] = useState<ExportFormat>('JSON')
  const pendingDownload = useRef<{ jobId: string; format: ExportFormat } | null>(null)
  const controllers = useRef(new Set<AbortController>())
  const activeDownload = useRef<AbortController | null>(null)
  const refreshPromise = useRef<Promise<void> | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const route = useRouteData<ExportJob[]>({
    cacheKey: 'export-jobs',
    enabled,
    load: async (signal) => {
      try {
        const page = await productClient.listMyExportJobs({ signal })
        if (!signal.aborted) loadFailed.current = false
        return page.items
      } catch (err) {
        if (!signal.aborted && !isAbort(err) && !loadFailed.current) {
          loadFailed.current = true
          showError("Couldn't refresh your exports. Try again.")
        }
        throw err
      }
    },
    fallbackError: "Couldn't load your exports. Try again.",
  })
  const jobs = route.data ?? EMPTY_JOBS
  const loading = route.status === 'loading'
  const inflightJob = jobs.find((job) => isInFlight(job.status))
  const canCreate = !creating && !inflightJob
  const reload = route.reload
  const setJobs = route.setData
  const hasInflightJob = Boolean(inflightJob)

  // Export responses contain private collection data. Abort every in-flight
  // request and discard pending UI state when the browser session ends or a
  // different account is loaded in the same tab.
  useEffect(() => {
    for (const controller of controllers.current) controller.abort()
    controllers.current.clear()
    activeDownload.current?.abort()
    pendingDownload.current = null
    setDownloading(false)
    setCreating(false)
    setCreateError(null)
    setJobs([])
  }, [identityKey, setJobs])
  const refresh = useCallback(() => {
    if (!refreshPromise.current) {
      refreshPromise.current = reload({ silent: true }).finally(() => { refreshPromise.current = null })
    }
    return refreshPromise.current
  }, [reload])

  useEffect(() => {
    const requests = controllers.current
    return () => {
      for (const controller of requests) controller.abort()
      requests.clear()
      pendingDownload.current = null
    }
  }, [])

  useEffect(() => {
    if (!enabled || route.status === 'unavailable' || !hasInflightJob) return
    let stopped = false
    let timer: number
    const poll = async () => {
      await refresh()
      if (!stopped) timer = window.setTimeout(() => void poll(), POLL_MS)
    }
    timer = window.setTimeout(() => void poll(), POLL_MS)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [enabled, hasInflightJob, refresh, route.status])

  const create = useCallback(async () => {
    if (!canCreate) return
    const identityAtStart = identityKey
    const controller = new AbortController()
    controllers.current.add(controller)
    setCreating(true)
    setCreateError(null)
    try {
      const job = await productClient.createMyExportJob({
        intentId: CREATE_INTENT,
        maxRetries: 0,
        signal: controller.signal,
      })
      if (controller.signal.aborted || identityRef.current !== identityAtStart) return
      pendingDownload.current = { jobId: job.jobId, format }
      setJobs([job, ...jobs.filter((item) => item.jobId !== job.jobId)])
      await refresh()
    } catch (err) {
      if (controller.signal.aborted || identityRef.current !== identityAtStart) return
      if (isProductApiError(err) && (err.isCommandInProgress || err.code === 'command_in_progress')) {
        toast('An export is already in progress')
        await refresh()
        return
      }
      setCreateError("Couldn't create the export. Try again.")
    } finally {
      controllers.current.delete(controller)
      if (!controller.signal.aborted && identityRef.current === identityAtStart) setCreating(false)
    }
  }, [canCreate, format, identityKey, refresh, setJobs, jobs, toast])

  const download = useCallback(async (jobId: string, selectedFormat: ExportFormat) => {
    if (activeDownload.current) return
    const identityAtStart = identityKey
    const controller = new AbortController()
    activeDownload.current = controller
    controllers.current.add(controller)
    setDownloading(true)
    try {
      const doc = await productClient.downloadMyExportJob(jobId, { signal: controller.signal })
      if (controller.signal.aborted || identityRef.current !== identityAtStart) return
      await saveLibraryExport(doc, jobId, selectedFormat, controller.signal)
    } catch {
      if (!controller.signal.aborted && identityRef.current === identityAtStart) showError('Could not download this export. Try Download again.')
    } finally {
      activeDownload.current = null
      controllers.current.delete(controller)
      if (!controller.signal.aborted && identityRef.current === identityAtStart) setDownloading(false)
    }
  }, [identityKey, showError])

  useEffect(() => {
    for (const job of jobs) {
      if (isInFlight(job.status)) {
        observedInFlight.current.add(job.jobId)
        continue
      }
      if (job.status !== 'failed' || !observedInFlight.current.has(job.jobId)) continue
      observedInFlight.current.delete(job.jobId)
      showError(job.errorClass === 'over_capacity'
        ? 'Your library is too large to export. Please contact support.'
        : 'Your export failed. Please create a new export.')
    }
  }, [jobs, showError])

  useEffect(() => {
    const pending = pendingDownload.current
    if (!pending || downloading) return
    const job = jobs.find((item) => item.jobId === pending.jobId)
    if (!job || isInFlight(job.status)) return
    pendingDownload.current = null
    if (isDownloadable(job)) void download(job.jobId, pending.format)
    else if (job.status !== 'failed') showError('Your export expired. Please create a new export.')
  }, [jobs, download, showError, downloading])

  if (!enabled || route.status === 'unavailable') return <UnavailableState />
  if (route.status === 'auth') {
    return (
      <PageShell variant="grid" className="export-page">
        <ExportHead />
        <RouteState
          kind="auth"
          icon="folder"
          title="Sign in to export your bookmarks"
          description="You need to be signed in to export collections you own."
        />
      </PageShell>
    )
  }

  return (
    <PageShell variant="grid" className="export-page">
      <ExportHead />

      {route.status === 'error' && jobs.length === 0 ? (
        <RouteState
          kind="error"
          icon="folder"
          title="Couldn't load your exports"
          description={route.error ?? undefined}
          onRetry={() => void route.reload()}
        />
      ) : loading && jobs.length === 0 ? (
        <LoadingState label="Loading export jobs…" />
      ) : (
        <>
          {createError && (
            <EmptyState
              role="alert"
              icon="folder"
              title="Couldn't create the export"
              description={createError}
              action={
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void create()}>
                  Try again
                </button>
              }
            />
          )}

          {inflightJob && (
            <section className="export-progress" role="status">
              <div>
                <strong>{statusCopy(inflightJob)}</strong>
                <span>
                  {inflightJob.status === 'pending'
                    ? 'Your export is queued.'
                    : 'Preparing an archive of owned live collections.'}
                </span>
              </div>
            </section>
          )}

          <div className="export-layout">
            <div className="export-config">
              <section>
                <div className="section-head section-head--split">
                  <div>
                    <p className="section-label">Format</p>
                    <h2>Choose how the archive opens</h2>
                  </div>
                </div>
                <FilterRail
                  className="export-format-options"
                  variant="segments"
                  label="Export format"
                  value={format}
                  options={formatOptions.map((item) => ({
                    value: item.id,
                    label: (
                      <>
                        <strong>{item.id}</strong>
                        <span>{item.hint}</span>
                        <small>{item.ext}</small>
                      </>
                    ),
                  }))}
                  onChange={(value) => setFormat(value as ExportFormat)}
                />
                <p className="export-format-note">
                  New exports download automatically when ready. You can also download recent archives in the selected format. Linked pages and attachment files are not included.
                </p>
              </section>
              <section>
                <p className="section-label">Scope</p>
                <p className="meta export-scope">
                  Collections you own, including private ones. Collections shared with you are not included.
                </p>
              </section>
              <section className="export-manifest">
                <p className="meta">Your export will include all owned collections in {format} format.</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canCreate || downloading}
                  onClick={() => void create()}
                >
                  Create export
                </button>
              </section>
            </div>

            <aside className="export-rail">
              <section className="export-portability">
                <h3 className="section-label">What stays portable</h3>
                <ul>
                  {portableItems.map((item) => (
                    <li key={item}>
                      <Icon name="check" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <p>Collaborator email addresses are never exported.</p>
              </section>
              <section className="export-history" data-testid="export-history">
                <div className="section-head section-head--split">
                  <div>
                    <p className="section-label">Export history</p>
                    <h2>Recent archives</h2>
                  </div>
                </div>
                {jobs.length === 0 && <p className="meta">No exports yet. Your first export will appear here.</p>}
                {jobs.map((job) => (
                  <article key={job.jobId}>
                    <span className="export-file-mark" aria-hidden><Icon name="file" /></span>
                    <div>
                      <strong>{statusCopy(job)}</strong>
                      <small>{format} · {formatMediumInstant(job.createdAt)}</small>
                    </div>
                    {isDownloadable(job) ? (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={downloading} onClick={() => void download(job.jobId, format)}>Download</button>
                    ) : null}
                  </article>
                ))}
              </section>
            </aside>
          </div>
        </>
      )}
    </PageShell>
  )
}
