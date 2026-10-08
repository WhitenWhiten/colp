import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient, type BookmarkFaviconSource } from '../api'
import { LoadingState } from './EmptyState'

type SourceState =
  | { kind: 'loading' }
  | { kind: 'ready'; source: BookmarkFaviconSource & { etag: string } }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

const POLL_FIRST_DELAY_MS = 2_000
const POLL_REPEAT_DELAY_MS = 5_000

/**
 * Bookmark inspector → icon source. FO-02 adds online selection and the
 * durable refresh button: choosing online persists the mode (never changes the
 * account default), and refresh POSTs the favicon-refresh endpoint which
 * returns a durable jobId. The UI then polls ONLY the effective source state
 * (first after 2s, then every 5s) and stops on a terminal status; closing the
 * inspector stops the client polling but never cancels the durable job.
 * A shared/public online icon renders the pinned object URL; unshared private
 * online renders the provider directUrl. Uploaded stays locked.
 */
export function FaviconSourceControl({ collectionId, nodeId, disabled, refreshKey = 0 }: {
  collectionId: string
  nodeId: string
  disabled: boolean
  /** Bump to refetch the source — the inspector raises it after an upload or
      delete through the sibling drop card, so the control never keeps showing
      a stale source (e.g. old radios while the node is already 'uploaded'). */
  refreshKey?: number | string | null
}) {
  const [state, setState] = useState<SourceState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /* F7: an image that fails to load falls back to a placeholder instead of a
     broken <img>; the src comparison re-shows the image after a refresh. */
  const [previewFailedSrc, setPreviewFailedSrc] = useState<string | null>(null)
  /* A generation counter, not a boolean: the second StrictMode setup would set a
     boolean back to true, so the torn-down pass could no longer tell that it was
     the stale one and would apply its result over the live pass's. Each effect
     run owns a generation and only applies its own — for the success, 404 and
     error branches alike. */
  const activeGenerationRef = useRef(0)
  const refreshingRef = useRef(false)
  const pollTimerRef = useRef<number | undefined>(undefined)
  const resolvePollWaitRef = useRef<(() => void) | undefined>(undefined)

  const setRefreshingState = useCallback((value: boolean) => {
    refreshingRef.current = value
    setRefreshing(value)
  }, [])

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    resolvePollWaitRef.current = resolve
    pollTimerRef.current = window.setTimeout(() => {
      pollTimerRef.current = undefined
      resolvePollWaitRef.current = undefined
      resolve()
    }, ms)
  })

  /** `generation` defaults to the live one for callers outside the effect. */
  const load = useCallback(async (signal?: AbortSignal, generation = activeGenerationRef.current) => {
    setNotice(null)
    setPreviewFailedSrc(null)
    try {
      const source = await productClient.getBookmarkFaviconSource(collectionId, nodeId, {
        signal,
        maxRetries: 0,
      })
      if (activeGenerationRef.current === generation) setState({ kind: 'ready', source })
    } catch (error) {
      if (isAbort(error)) return
      if (isProductApiError(error) && error.status === 404) {
        if (activeGenerationRef.current === generation) setState({ kind: 'unavailable' })
        return
      }
      // Guarded like the other two branches, and the generation IS bumped on
      // unmount now, so a late error cannot land on a torn-down tree either.
      if (activeGenerationRef.current === generation) {
        setState({
          kind: 'error',
          message: isProductApiError(error) ? error.recoveryHint : "Couldn't load the icon source.",
        })
      }
    }
  }, [collectionId, nodeId])

  const pollUntilTerminal = useCallback(async (jobId: string,
    generation: number) => {
    let delayMs = POLL_FIRST_DELAY_MS
    while (activeGenerationRef.current === generation && refreshingRef.current) {
      await sleep(delayMs)
      if (activeGenerationRef.current !== generation || !refreshingRef.current) return
      try {
        // Poll the DURABLE job through getMyFaviconJob (first after 2s, then
        // every 5s), stopping on a terminal status; the job itself keeps
        // running on the server even if this view closes.
        const job = await productClient.getMyFaviconJob(jobId, { maxRetries: 0 })
        if (activeGenerationRef.current !== generation) return
        if (job.status === 'pending' || job.status === 'running') {
          delayMs = POLL_REPEAT_DELAY_MS
          continue
        }
        // Terminal (succeeded/partial/failed/superseded): refresh the view.
        await load(undefined, generation)
        if (activeGenerationRef.current !== generation) return
        setRefreshingState(false)
        setBusy(false)
        if (job.status === 'failed' || job.status === 'partial') {
          setNotice(
            job.status === 'failed'
              ? 'Icon refresh failed — showing the last icon.'
              : 'Icon refresh finished with errors — showing the last icon.',
          )
        }
        return
      } catch (error) {
        if (isAbort(error) || activeGenerationRef.current !== generation) return
        setRefreshingState(false)
        setBusy(false)
        setNotice(isProductApiError(error) ? error.recoveryHint : 'The icon refresh result could not be checked.')
        return
      }
    }
  }, [load, setRefreshingState])

  useEffect(() => {
    activeGenerationRef.current += 1
    const generation = activeGenerationRef.current
    setState({ kind: 'loading' })
    setBusy(false)
    setRefreshingState(false)
    const controller = new AbortController()
    void load(controller.signal, generation)
    return () => {
      // Invalidate both pending mutations and polls before releasing their wait.
      activeGenerationRef.current += 1
      refreshingRef.current = false
      controller.abort()
      if (pollTimerRef.current !== undefined) window.clearTimeout(pollTimerRef.current)
      pollTimerRef.current = undefined
      resolvePollWaitRef.current?.()
      resolvePollWaitRef.current = undefined
    }
  }, [load, refreshKey, setRefreshingState])

  const choose = async (mode: 'inherit' | 'none' | 'online') => {
    if (state.kind !== 'ready' || busy || disabled || state.source.sourceMode === mode) return
    const generation = activeGenerationRef.current
    setBusy(true)
    try {
      await productClient.setBookmarkFaviconSource(
        collectionId,
        nodeId,
        { sourceMode: mode },
        state.source.etag,
        {
          intentId: productClient.mutationIntentKey(
            `set-favicon-source:${collectionId}:${nodeId}`,
            productClient.newCommandId(),
          ),
          maxRetries: 0,
        },
      )
      if (activeGenerationRef.current !== generation) return
      await load(undefined, generation)
    } catch (error) {
      if (activeGenerationRef.current !== generation || isAbort(error)) return
      if (isProductApiError(error) && error.isPreconditionFailed) {
        await load(undefined, generation)
        if (activeGenerationRef.current !== generation) return
        setNotice('The icon source changed elsewhere — view refreshed, choose again.')
      } else if (isProductApiError(error)) {
        setNotice(error.recoveryHint)
      } else {
        setNotice('The icon source could not be saved.')
      }
    } finally {
      if (activeGenerationRef.current === generation) setBusy(false)
    }
  }

  const refresh = async () => {
    if (state.kind !== 'ready' || busy || disabled) return
    const canRefresh = state.source.sourceMode === 'online'
      || (state.source.sourceMode === 'inherit' && state.source.effectiveMode === 'online')
    if (!canRefresh) return
    const generation = activeGenerationRef.current
    setBusy(true)
    setRefreshingState(true)
    setNotice(null)
    try {
      const accepted = await productClient.refreshBookmarkFavicon(
        collectionId,
        nodeId,
        state.source.etag,
        {
          intentId: productClient.mutationIntentKey(
            `refresh-favicon-source:${collectionId}:${nodeId}`,
            productClient.newCommandId(),
          ),
          maxRetries: 0,
        },
      )
      // The durable job is tracked by the returned jobId; closing the UI
      // stops the polling below, never the job.
      if (activeGenerationRef.current !== generation) return
      if (typeof accepted.jobId !== 'string') throw new Error('missing jobId')
      void pollUntilTerminal(accepted.jobId, generation)
    } catch (error) {
      if (activeGenerationRef.current !== generation || isAbort(error)) return
      setRefreshingState(false)
      setBusy(false)
      if (isProductApiError(error) && error.isPreconditionFailed) {
        await load(undefined, generation)
        if (activeGenerationRef.current !== generation) return
        setNotice('The icon source changed elsewhere — view refreshed, try again.')
      } else if (isProductApiError(error)) {
        setNotice(error.recoveryHint)
      } else {
        setNotice('The icon refresh could not be started.')
      }
    }
  }

  const ready = state.kind === 'ready' ? state.source : null
  const pending = busy || disabled
  const previewSrc = ready ? (ready.iconUrl ?? ready.directUrl) : null

  return (
    <div className="favicon-source-control" data-testid="favicon-source-control">
      {state.kind === 'loading' && <LoadingState label="Loading icon source…" />}
      {state.kind === 'unavailable' && (
        <p className="meta" data-testid="favicon-source-unavailable">
          Icon sources are managed automatically. There is nothing to set up.
        </p>
      )}
      {state.kind === 'error' && <p className="field-error" role="alert">{state.message}</p>}
      {ready && (
        <fieldset className="option-group" disabled={pending}>
          <legend>Icon source</legend>
          {ready.sourceMode === 'uploaded' && (
            <p className="meta" data-testid="favicon-source-uploaded">
              Uploaded image — replaced only by uploading a new one.
            </p>
          )}
          {previewSrc !== null && (
            <div className="row">
              {previewFailedSrc !== previewSrc ? (
                <img
                  className="favicon-source-preview"
                  data-testid="favicon-source-preview"
                  src={previewSrc}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={() => setPreviewFailedSrc(previewSrc)}
                />
              ) : (
                <span
                  className="favicon-source-preview-fallback"
                  data-testid="favicon-source-preview-fallback"
                  role="status"
                >
                  Icon preview unavailable
                </span>
              )}
              {ready.status === 'pending' && <span className="meta" role="status">Refreshing…</span>}
              {ready.status === 'failed' && <span className="field-error" role="status">Refresh failed — showing the last icon.</span>}
            </div>
          )}
          <label className="option-row">
            <input
              type="radio"
              name="favicon-source"
              value="inherit"
              checked={ready.sourceMode === 'inherit'
                || (ready.sourceMode !== 'none' && ready.sourceMode !== 'uploaded'
                  && ready.sourceMode !== 'online')}
              onChange={() => void choose('inherit')}
            />
            <span>Inherit the account default</span>
          </label>
          <label className="option-row">
            <input
              type="radio"
              name="favicon-source"
              value="online"
              checked={ready.sourceMode === 'online'}
              onChange={() => void choose('online')}
            />
            <span>Fetch online</span>
          </label>
          <label className="option-row">
            <input
              type="radio"
              name="favicon-source"
              value="none"
              checked={ready.sourceMode === 'none'}
              onChange={() => void choose('none')}
            />
            <span>No icon</span>
          </label>
          {(ready.sourceMode === 'online'
            || (ready.sourceMode === 'inherit' && ready.effectiveMode === 'online')) && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="favicon-source-refresh"
              disabled={busy || refreshing}
              onClick={() => void refresh()}
            >
              {refreshing ? 'Refreshing…' : 'Refresh icon'}
            </button>
          )}
          {notice && <p className="field-error" role="alert">{notice}</p>}
        </fieldset>
      )}
    </div>
  )
}