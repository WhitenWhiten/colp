import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isProductApiError,
  productClient,
  type FaviconIconJob,
  type FaviconIconPolicy,
} from '../../api'
import { LoadingState } from '../../components/EmptyState'

type FaviconPolicyState =
  | { kind: 'loading' }
  | { kind: 'ready'; policy: FaviconIconPolicy & { etag: string } }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

const JOB_POLL_DELAY_MS = 5_000

function isTerminal(status: FaviconIconJob['status']): boolean {
  return status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'superseded'
}

/**
 * Batch-job progress (FO-03): polls the durable job through
 * getMyFaviconJob every 5s, shows the aggregate counters, and offers an
 * explicit retry of a failed/partial job (retryMyFaviconJob re-runs only the
 * failed items). Closing the settings dialog stops the polling, never the job.
 */
function JobProgress({ jobId, onRetried }: {
  jobId: string
  onRetried: (jobId: string) => void
}) {
  const [job, setJob] = useState<FaviconIconJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const retryingRef = useRef(false)

  useEffect(() => {
    let timer: number | undefined
    let stopped = false
    const poll = async (): Promise<void> => {
      if (stopped) return
      try {
        const next = await productClient.getMyFaviconJob(jobId, { maxRetries: 0 })
        if (stopped) return
        setJob(next)
        if (isTerminal(next.status)) return
      } catch (pollError) {
        if (isAbort(pollError) || stopped) return
        setError('The favicon job progress could not be checked.')
        return
      }
      timer = window.setTimeout(() => { void poll() }, JOB_POLL_DELAY_MS)
    }
    void poll()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [jobId])

  const retry = async (): Promise<void> => {
    if (retryingRef.current) return
    retryingRef.current = true
    setError(null)
    try {
      const accepted = await productClient.retryMyFaviconJob(jobId, {
        intentId: productClient.mutationIntentKey(`retry-favicon-job:${jobId}`, productClient.newCommandId()),
        maxRetries: 0,
      })
      onRetried(accepted.jobId)
    } catch (retryError) {
      if (!isAbort(retryError)) {
        setError(isProductApiError(retryError) ? retryError.recoveryHint : 'The favicon job could not be retried.')
      }
    } finally {
      retryingRef.current = false
    }
  }

  if (job === null && error === null) {
    return <p className="meta" role="status">Batch icon job running…</p>
  }
  return (
    <p className="meta" data-testid="favicon-job-progress">
      {job !== null && !isTerminal(job.status) && (
        <span role="status">
          Batch icon job {job.status === 'pending' ? 'queued' : 'in progress'} — {job.succeeded}/{job.total}
          {job.failed > 0 ? `, ${job.failed} failed` : ''}
          {job.skipped > 0 ? `, ${job.skipped} skipped` : ''}
        </span>
      )}
      {job !== null && isTerminal(job.status) && job.status !== 'succeeded' && (
        <span className="field-error" role="status">
          Batch icon job {job.status === 'failed' ? 'failed' : 'finished with errors'} —{' '}
          {job.succeeded}/{job.total} ok, {job.failed} failed, {job.skipped} skipped.
        </span>
      )}
      {job !== null && job.status === 'succeeded' && (
        <span role="status">Batch icon job finished — {job.succeeded} updated.</span>
      )}
      {job !== null && (job.status === 'failed' || job.status === 'partial') && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="favicon-job-retry"
          disabled={retryingRef.current}
          onClick={() => void retry()}
        >
          Retry {job.failed} failed
        </button>
      )}
      {error !== null && <span className="field-error" role="alert">{error}</span>}
    </p>
  )
}

/**
 * Settings → Favicon: the account-wide icon source policy. FO-03 makes every
 * setting real: the new-bookmark default (capture/online/none), the online
 * provider template, fillMissing and forceAllOnline. A policy change that
 * activates a batch behavior returns a durable jobId which is polled here
 * (progress + explicit retry of failed items); the online providerTemplate
 * alone never enables online, and no-op patches keep the same revision.
 */
export function FaviconSection() {
  const [state, setState] = useState<FaviconPolicyState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [providerDraft, setProviderDraft] = useState<string>('')
  const [dirtyProvider, setDirtyProvider] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const policy = await productClient.getMyFaviconPolicy({ signal, maxRetries: 0 })
      // The controller is what normally prevents a stale apply; checking the
      // signal keeps it true for callers that pass none.
      if (signal?.aborted) return
      setState({ kind: 'ready', policy })
      setProviderDraft(policy.providerTemplate)
      setDirtyProvider(false)
    } catch (error) {
      if (isAbort(error)) return
      if (isProductApiError(error) && error.status === 404) {
        setState({ kind: 'unavailable' })
        return
      }
      setState({
        kind: 'error',
        message: isProductApiError(error) ? error.recoveryHint : "Couldn't load favicon settings.",
      })
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const save = async (patch: Record<string, unknown>) => {
    if (state.kind !== 'ready' || busy) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await productClient.updateMyFaviconPolicy(patch, state.policy.etag, {
        intentId: productClient.mutationIntentKey('favicon-policy:me', productClient.newCommandId()),
        maxRetries: 0,
      })
      await load()
      setJobId(result.jobId)
      if (result.jobId !== null) setNotice({ kind: 'info', text: 'A batch icon job was started for this change.' })
    } catch (error) {
      if (isAbort(error)) return
      if (isProductApiError(error) && error.isPreconditionFailed) {
        await load()
        setNotice({ kind: 'info', text: 'Favicon settings changed elsewhere — view refreshed, choose again.' })
      } else {
        setNotice({
          kind: 'error',
          text: isProductApiError(error) ? error.recoveryHint : 'The favicon settings could not be saved.',
        })
      }
    } finally {
      if (state.kind === 'ready') setBusy(false)
    }
  }

  const choose = (newDefault: FaviconIconPolicy['newDefault']) => {
    if (state.kind !== 'ready' || state.policy.newDefault === newDefault) return
    void save({ newDefault })
  }

  const toggleFill = (value: boolean) => {
    if (state.kind !== 'ready' || state.policy.fillMissing === value) return
    void save({ fillMissing: value })
  }

  const toggleForce = (value: boolean) => {
    if (state.kind !== 'ready' || state.policy.forceAllOnline === value) return
    void save({ forceAllOnline: value })
  }

  const submitProvider = () => {
    if (state.kind !== 'ready' || !dirtyProvider) return
    void save({ providerTemplate: providerDraft })
  }

  const current = state.kind === 'ready' ? state.policy : null

  return (
    <section className="settings-section" data-testid="settings-favicon">
      <div className="settings-section-head">
        <h3 className="settings-toggle-label">Favicon</h3>
        <p className="meta">
          What happens to a bookmark icon when no image was uploaded by hand.
        </p>
      </div>
      {state.kind === 'loading' && <LoadingState label="Loading icon settings…" />}
      {state.kind === 'unavailable' && (
        <p className="meta" data-testid="favicon-policy-unavailable">
          Automatic icons are managed for you. There is no per-account setting to change here.
        </p>
      )}
      {state.kind === 'error' && (
        <p className="field-error" role="alert">{state.message}</p>
      )}
      {state.kind === 'ready' && (
        <>
          <fieldset className="option-group" disabled={busy}>
            <legend className="settings-toggle-label">Default for new bookmarks</legend>
            <label className="option-row">
              <input
                type="radio"
                name="favicon-default"
                value="capture"
                checked={current?.newDefault === 'capture'}
                onChange={() => void choose('capture')}
              />
              <span>
                Capture automatically
                <span className="meta">Reuse an icon the site or extension provides.</span>
              </span>
            </label>
            <label className="option-row">
              <input
                type="radio"
                name="favicon-default"
                value="online"
                checked={current?.newDefault === 'online'}
                onChange={() => void choose('online')}
              />
              <span>
                Fetch online
                <span className="meta">Capture the provider icon for every new bookmark.</span>
              </span>
            </label>
            <label className="option-row">
              <input
                type="radio"
                name="favicon-default"
                value="none"
                checked={current?.newDefault === 'none'}
                onChange={() => void choose('none')}
              />
              <span>
                No icon
                <span className="meta">Only show initials until an image is uploaded.</span>
              </span>
            </label>
          </fieldset>

          <div className="field">
            <label className="settings-toggle-label" htmlFor="favicon-provider-template">Online provider template</label>
            <div className="row">
              <input
                id="favicon-provider-template"
                className="input"
                data-testid="favicon-provider-template"
                value={providerDraft}
                onChange={(event) => { setProviderDraft(event.target.value); setDirtyProvider(true) }}
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid="favicon-provider-save"
                disabled={busy || !dirtyProvider}
                onClick={() => void submitProvider()}
              >
                Save provider
              </button>
            </div>
            <p className="meta">
              Must contain exactly one {'{hostname}'} placeholder, e.g. https://favicone.com/{'{hostname}'}.
              The template alone never enables online.
            </p>
          </div>

          <div className="option-group">
            <label className="option-row">
              <input
                type="checkbox"
                data-testid="favicon-fill-missing"
                checked={current?.fillMissing === true}
                disabled={busy}
                onChange={(event) => void toggleFill(event.target.checked)}
              />
              <span>
                Fill missing icons
                <span className="meta">Capture provider icons for bookmarks without one (except those set to none).</span>
              </span>
            </label>
            <label className="option-row">
              <input
                type="checkbox"
                data-testid="favicon-force-online"
                checked={current?.forceAllOnline === true}
                disabled={busy}
                onChange={(event) => void toggleForce(event.target.checked)}
              />
              <span>
                Force all icons online
                <span className="meta">
                  Temporarily replace every icon (including uploaded) with the provider icon; disabling restores the
                  original images.
                </span>
              </span>
            </label>
          </div>

          {notice !== null && (
            <p
              className={notice.kind === 'error' ? 'field-error' : 'meta'}
              role={notice.kind === 'error' ? 'alert' : 'status'}
              data-testid="favicon-policy-notice"
            >
              {notice.text}
            </p>
          )}
          {jobId !== null && current !== null && <JobProgress jobId={jobId} onRetried={setJobId} />}
        </>
      )}
    </section>
  )
}