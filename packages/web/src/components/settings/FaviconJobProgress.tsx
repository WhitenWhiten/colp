import { useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient } from '../../api'
import { Icon } from '../Icon'
import { isFaviconJobTerminal, useFaviconJobActivity } from './useFaviconJobActivity'

/** Settings-wide strip matching the extension popup: count, thin bar, details. */
export function FaviconJobProgress({ startedJobId, onJobStarted, onDetails }: {
  startedJobId: string | null
  onJobStarted: (jobId: string) => void
  onDetails?: () => void
}) {
  const { job, activeJobs, error, checking } = useFaviconJobActivity(startedJobId)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const retryRequest = useRef<AbortController | null>(null)
  useEffect(() => () => { retryRequest.current?.abort() }, [])

  const retry = async () => {
    if (job === null || retryRequest.current !== null) return
    const controller = new AbortController()
    retryRequest.current = controller
    setRetrying(true)
    setRetryError(null)
    try {
      const accepted = await productClient.retryMyFaviconJob(job.id, {
        intentId: productClient.mutationIntentKey(`retry-favicon-job:${job.id}`, productClient.newCommandId()),
        signal: controller.signal,
        maxRetries: 0,
      })
      if (!controller.signal.aborted) onJobStarted(accepted.jobId)
    } catch (cause) {
      if (!controller.signal.aborted) setRetryError(isProductApiError(cause) ? cause.recoveryHint : 'The favicon job could not be retried.')
    } finally {
      if (!controller.signal.aborted) setRetrying(false)
      retryRequest.current = null
    }
  }

  if (job === null && error === null && (!checking || startedJobId === null)) return null
  const terminal = job !== null && isFaviconJobTerminal(job.status)
  const total = job?.total ?? 0
  const completed = job === null ? 0 : job.succeeded + job.failed + job.skipped
  const determinate = job !== null && total > 0 && (job.operation !== 'refresh_one' || terminal)
  const percent = total === 0 ? 0 : Math.min(100, Math.round(completed / total * 100))
  const state = error !== null ? 'stalled' : terminal ? (job?.failed ? 'failed' : 'done') : 'running'
  const title = job?.status === 'superseded' ? 'Icon job replaced'
    : terminal ? (job?.failed ? 'Icons finished with errors' : 'Icons updated')
      : job?.status === 'pending' ? 'Icons queued' : 'Fetching icons'

  return (
    <section className="favicon-job-progress" data-state={state} data-testid="favicon-job-progress" aria-label="Favicon task progress">
      <div className="favicon-job-row">
        <Icon name="sync" />
        <span className="favicon-job-title" role="status">
          {title}{determinate ? ` — ${completed}/${total} processed` : activeJobs > 0 ? ` — ${activeJobs} ${activeJobs === 1 ? 'task' : 'tasks'} remaining` : '…'}
        </span>
        {determinate && <span className="favicon-job-percent">{percent}%</span>}
        {onDetails && <button className="btn btn-ghost btn-sm" type="button" onClick={onDetails}>Details</button>}
      </div>
      <progress
        className="favicon-job-bar"
        aria-label="Favicon task progress"
        aria-valuetext={determinate && job !== null ? `${completed} of ${total} processed, ${job.succeeded} succeeded, ${job.failed} failed, ${job.skipped} skipped` : 'Fetching icons; waiting for progress'}
        max={total || 1}
        value={determinate ? Math.min(completed, total) : undefined}
      />
      {job !== null && (
        <p className="meta favicon-job-detail">
          {job.succeeded} updated · {job.failed} failed · {job.skipped} skipped
          {activeJobs > 1 ? ` · ${activeJobs - 1} other icon ${activeJobs === 2 ? 'task' : 'tasks'}` : ''}
        </p>
      )}
      {!terminal && <p className="meta favicon-job-detail">You can close Settings. Icons continue updating in the background.</p>}
      {job !== null && (job.status === 'failed' || job.status === 'partial') && job.failed > 0 && (
        <button type="button" className="btn btn-secondary btn-sm" data-testid="favicon-job-retry" disabled={retrying} onClick={() => void retry()}>
          {retrying ? 'Retrying…' : `Retry ${job.failed} failed`}
        </button>
      )}
      {(error || retryError) && <p className="field-error" role="alert">{retryError || error}</p>}
    </section>
  )
}
