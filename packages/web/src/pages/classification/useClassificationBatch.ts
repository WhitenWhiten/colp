import { useEffect, useRef, useState } from 'react'
import { productClient, ProductApiError, type ClassificationRun, type ClassificationRunCreateRequest, type ClassificationRunApplyRequest } from '../../api'
import { isAbort } from '../../lib/libraryTree'
import { readBatchSession, writeBatchSession, type BatchIntent } from './batch-session'

const appliedDetailsStale = 'Selected changes were applied. The detail refresh failed, so the details may be stale.'

function isApplyConfirmation(value: unknown, runId: string): boolean {
  if (!value || typeof value !== 'object') return false
  const body = value as { status?: unknown; runId?: unknown }
  return body.status === 'applied' && body.runId === runId
}

function batchErrorMessage(error: ProductApiError, intentKind: BatchIntent['kind']): string {
  if (error.code === 'credit_price_changed') return 'The credit price changed. Refresh the current price and start a new batch with a new request.'
  if (error.code === 'billing_consent_required') return 'Confirm the displayed credit cost before starting this hosted batch.'
  if (error.code === 'credit_limit_exceeded') return 'The selected batch exceeds the confirmed credit limit. Review the quantity and confirm again.'
  if (error.code === 'insufficient_credits') return 'There are not enough available credits for this batch. Reduce the quantity or try again after a grant.'
  if (error.code === 'credits_busy' || error.code === 'credits_reconciling' || error.code === 'credits_unavailable') return 'Credits are temporarily unavailable. Check the result again shortly.'
  if (error.status === 404) return 'Classification is not available for this collection.'
  if (intentKind === 'apply') return 'The collection or batch changed. Start a new batch to review your selection.'
  return 'The request was not accepted. Refresh progress and review your selection before trying again.'
}

/** This hook is remounted for each account/collection/run identity. */
export function useClassificationBatch(collectionId: string, sessionKey: string, initialRunId: string | undefined, onRun: (id: string) => void) {
  const initial = useRef(readBatchSession(sessionKey))
  const [run, setRun] = useState<ClassificationRun | null>(null)
  const [runId, setRunId] = useState(initialRunId ?? initial.current?.runId)
  const [pending, setPending] = useState<BatchIntent | undefined>(initial.current?.pending)
  const pendingRef = useRef(pending)
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lifetime = useRef(new AbortController())
  const active = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const readVersion = useRef(0)
  const confirmedAppliedRunId = useRef<string | null>(null)
  const onRunRef = useRef(onRun); onRunRef.current = onRun
  function remember(next: BatchIntent | undefined, id = runId) {
    pendingRef.current = next; setPending(next)
    writeBatchSession(sessionKey, { ...(id ? { runId: id } : {}), ...(next ? { pending: next } : {}) })
  }
  function receive(next: ClassificationRun) {
    // A confirmed apply is not reopened by a later detail read.
    if (confirmedAppliedRunId.current === next.runId && next.status !== 'applied') return false
    if (next.status === 'applied') confirmedAppliedRunId.current = next.runId
    setRun(next); setRunId(next.runId)
    const intent = pendingRef.current
    if (intent && (next.status === 'applied' || next.status === 'cancelled' || next.status === 'expired' || next.status === 'failed')) {
      remember(undefined, next.runId); productClient.forgetClassificationRunIntent(intent.intentId)
    } else writeBatchSession(sessionKey, { runId: next.runId, ...(intent ? { pending: intent } : {}) })
    return true
  }
  async function refresh(id = runId) {
    if (!id || lifetime.current.signal.aborted) return
    clearTimeout(timer.current)
    const version = ++readVersion.current
    try {
      const next = await productClient.getClassificationRun(collectionId, id, { signal: lifetime.current.signal, maxRetries: 0 })
      if (lifetime.current.signal.aborted || version !== readVersion.current) return
      if (!receive(next)) { setError(appliedDetailsStale); return }
      if (!blocked) setError(null)
      if (!initialRunId) onRunRef.current(next.runId)
      if (next.status === 'queued' || next.status === 'running') timer.current = setTimeout(() => { void refresh(id) }, 2000)
    } catch (cause) {
      if (!isAbort(cause) && !lifetime.current.signal.aborted && version === readVersion.current) {
        if (confirmedAppliedRunId.current === id) { setError(appliedDetailsStale); return }
        if (cause instanceof ProductApiError && cause.status === 404) setBlocked(true)
        setError(cause instanceof ProductApiError && cause.status === 404 ? 'This batch expired or is no longer available.' : 'Could not check batch progress. Retry when connected.')
      }
    }
  }
  useEffect(() => {
    lifetime.current = new AbortController()
    if (runId) void refresh(runId)
    return () => { lifetime.current.abort(); clearTimeout(timer.current) }
    // Scope changes remount this component, preserving pending requests in session storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit(intent: BatchIntent) {
    if (active.current || lifetime.current.signal.aborted) return
    readVersion.current++; clearTimeout(timer.current)
    active.current = true; setBusy(true); setError(null); remember(intent)
    const options = { intentId: intent.intentId, signal: lifetime.current.signal, maxRetries: 0, clearIntentOnSuccess: false }
    try {
      if (intent.kind === 'create') {
        const next = await productClient.createClassificationRun(collectionId, intent.document, options)
        if (lifetime.current.signal.aborted) return
        remember(undefined, next.runId); receive(next); onRunRef.current(next.runId)
        productClient.forgetClassificationRunIntent(intent.intentId)
      } else if (intent.kind === 'cancel') {
        const next = await productClient.cancelClassificationRun(collectionId, intent.runId, intent.etag, options)
        if (lifetime.current.signal.aborted) return
        remember(undefined, next.runId); receive(next); productClient.forgetClassificationRunIntent(intent.intentId)
      } else {
        const confirmed = await productClient.applyClassificationRun(collectionId, intent.runId, intent.document, intent.etag, options)
        if (lifetime.current.signal.aborted) return
        if (!isApplyConfirmation(confirmed, intent.runId)) {
          setError('The result is not confirmed yet. Check again before starting another action.')
          return
        }
        // The apply body confirms status only. Keep the last known ETag and creditUsage.
        confirmedAppliedRunId.current = intent.runId
        setRun(current => current && current.runId === intent.runId ? { ...current, status: 'applied' } : current)
        remember(undefined, intent.runId); productClient.forgetClassificationRunIntent(intent.intentId)
        await refresh(intent.runId)
      }
    } catch (cause) {
      if (isAbort(cause) || lifetime.current.signal.aborted) return
      if (intent.kind === 'apply' && confirmedAppliedRunId.current === intent.runId) { setError(appliedDetailsStale); return }
      const definitive = cause instanceof ProductApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 429
        && !cause.sameRequestRetrySafe
      if (definitive) {
        remember(undefined); productClient.forgetClassificationRunIntent(intent.intentId)
        if (intent.kind === 'apply') setBlocked(true)
        setError(batchErrorMessage(cause, intent.kind))
      } else setError('The result is not confirmed yet. Check again before starting another action.')
    } finally {
      active.current = false
      if (!lifetime.current.signal.aborted) setBusy(false)
    }
  }
  const id = () => productClient.mutationIntentKey('classification-batch', `${sessionKey}:${crypto.randomUUID()}`)
  return { run, runId, pending, busy, blocked, error, refresh,
    create: (document: ClassificationRunCreateRequest) => submit({ kind: 'create', intentId: id(), document }),
    cancel: () => run && submit({ kind: 'cancel', intentId: id(), runId: run.runId, etag: run.etag }),
    apply: (document: ClassificationRunApplyRequest) => run && submit({ kind: 'apply', intentId: id(), runId: run.runId, etag: run.etag, document }),
    retry: () => pendingRef.current && submit(pendingRef.current),
  }
}
