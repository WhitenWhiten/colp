import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isProductApiError, productClient,
  type ReadingProgressResourceType, type ReadingProgressStatus,
  type ReadingProgressUpdate, type ReadingProgressView,
} from '../api'
import { getSessionSnapshot, subscribeSession } from '../api/sessionStore'

type Locator = { resourceType: ReadingProgressResourceType; resourceId: string; debounceMs?: number; maxWaitMs?: number; enabled?: boolean }
type SaveState = 'loading' | 'saved' | 'saving' | 'unknown' | 'error'
export type ReadingProgressSaveOutcome = 'saved' | 'unknown' | 'error' | 'skipped'

type Pending = { body: ReadingProgressUpdate; intentId: string; ifMatch: string | null }
type Cached = { status: ReadingProgressStatus; progress: number; etag: string | null; updatedAt: string | null }
const cache = new Map<string, Cached>()
const SYNC_EVENT = 'known-reading-progress'
let cacheIdentity = ''

function identity() { const snapshot = getSessionSnapshot(); return `${snapshot.me?.account.id ?? 'anonymous'}:${snapshot.sessionEpoch}` }
function key(locator: Pick<Locator, 'resourceType' | 'resourceId'>) { return `${identity()}:${locator.resourceType}:${locator.resourceId}` }
function empty(): Cached { return { status: 'not_started', progress: 0, etag: null, updatedAt: null } }
function fromView(view: ReadingProgressView | null): Cached { return view ? { status: view.status, progress: view.progress, etag: view.etag, updatedAt: view.updatedAt } : empty() }
function mutationView(body: ReadingProgressUpdate, etag: string, updatedAt: string): Cached { return { ...body, etag, updatedAt } }
function unknownKey(locator: Pick<Locator, 'resourceType' | 'resourceId'>) { return `known.reading-progress.pending.${getSessionSnapshot().me?.account.id ?? 'anonymous'}.${locator.resourceType}.${locator.resourceId}` }
function storeUnknown(locator: Pick<Locator, 'resourceType' | 'resourceId'>, command: Pending | null) { try { if (command) sessionStorage.setItem(unknownKey(locator), JSON.stringify(command)); else sessionStorage.removeItem(unknownKey(locator)) } catch { /* in-memory state remains usable */ } }
function restoreUnknown(locator: Pick<Locator, 'resourceType' | 'resourceId'>): Pending | null { try { const raw = sessionStorage.getItem(unknownKey(locator)); if (!raw) return null; const parsed = JSON.parse(raw) as Pending; return parsed?.intentId && parsed.body && (parsed.body.status === 'not_started' || parsed.body.status === 'in_progress' || parsed.body.status === 'completed') ? parsed : null } catch { return null } }
function clearUnknownOutcomes() { try { for (let index = sessionStorage.length - 1; index >= 0; index -= 1) { const storageKey = sessionStorage.key(index); if (storageKey?.startsWith('known.reading-progress.pending.')) sessionStorage.removeItem(storageKey) } } catch { /* storage may be unavailable */ } }
function usePrivateIdentity() { const [value, setValue] = useState(identity); useEffect(() => subscribeSession(() => setValue(identity())), []); return value }
function sameCached(a: Cached | undefined, b: Cached) { return a !== undefined && a.status === b.status && a.progress === b.progress && a.etag === b.etag && a.updatedAt === b.updatedAt }
function notify(locator: Pick<Locator, 'resourceType' | 'resourceId'>, value: Cached) {
  const cacheKey = key(locator)
  const previous = cache.get(cacheKey)
  cache.set(cacheKey, value)
  // A read that only confirms the cached value must not wake the other
  // consumers. Broadcasting it made every Path Reader step change reload the
  // whole progress list, which reset the progress bar and the done markers.
  if (sameCached(previous, value)) return
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { identity: identity(), resourceType: locator.resourceType, resourceId: locator.resourceId, value } }))
}
subscribeSession((snapshot) => { const next = `${snapshot.me?.account.id ?? 'anonymous'}:${snapshot.sessionEpoch}`; if (next !== cacheIdentity) { cache.clear(); cacheIdentity = next }; if (!snapshot.authenticated) clearUnknownOutcomes() })

export function useReadingProgress(locator: Locator) {
  const initial = cache.get(key(locator)) ?? empty()
  const [value, setValue] = useState(initial)
  const [saveState, setSaveState] = useState<SaveState>('loading')
  const [message, setMessage] = useState('Loading progress')
  const valueRef = useRef(value); valueRef.current = value
  const pending = useRef<Pending | null>(null)
  const unsent = useRef<ReadingProgressUpdate | null>(null)
  const debounceTimer = useRef<number | undefined>(undefined); const maxTimer = useRef<number | undefined>(undefined); const firstQueuedAt = useRef<number | null>(null)
  const generation = useRef(0); const readController = useRef<AbortController | null>(null); const mutationControllers = useRef(new Set<AbortController>())
  const privateIdentity = usePrivateIdentity(); const accountId = useRef(getSessionSnapshot().me?.account.id ?? null)
  const identityRef = useRef(privateIdentity); const resourceRef = useRef(`${locator.resourceType}:${locator.resourceId}`)
  const lastIncomplete = useRef(initial.progress > 0 && initial.progress < 1 ? initial.progress : 0.99)

  const clearTimers = useCallback(() => { if (debounceTimer.current !== undefined) window.clearTimeout(debounceTimer.current); if (maxTimer.current !== undefined) window.clearTimeout(maxTimer.current); debounceTimer.current = undefined; maxTimer.current = undefined; firstQueuedAt.current = null }, [])

  const load = useCallback(async () => {
    if (pending.current || unsent.current) return
    const current = ++generation.current; readController.current?.abort(); const controller = new AbortController(); readController.current = controller; setSaveState('loading')
    try {
      const remote = await productClient.getReadingProgress(locator.resourceType, locator.resourceId, { signal: controller.signal, maxRetries: 0 })
      if (controller.signal.aborted || current !== generation.current) return
      const authoritative = fromView(remote); valueRef.current = authoritative; setValue(authoritative); notify(locator, authoritative); setSaveState('saved'); setMessage(remote ? 'Progress saved' : 'Not started')
    } catch (error) {
      if (controller.signal.aborted || current !== generation.current) return
      setSaveState('error'); setMessage(isProductApiError(error) ? error.recoveryHint : "Couldn't load progress")
    }
    // Primitive locator fields; object identity would reload on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locator ids, not identity
  }, [locator.resourceId, locator.resourceType])

  const execute = useCallback(async (command: Pending): Promise<ReadingProgressSaveOutcome> => {
    pending.current = command; const requestGeneration = ++generation.current; const controller = new AbortController(); mutationControllers.current.add(controller)
    setSaveState('saving'); setMessage('Saving progress')
    try {
      const result = await productClient.putReadingProgress(locator.resourceType, locator.resourceId, command.body, command.ifMatch, { intentId: command.intentId, signal: controller.signal, maxRetries: 0, clearIntentOnSuccess: false })
      if (controller.signal.aborted) return 'skipped'
      if (requestGeneration !== generation.current) {
        productClient.abandonReadingProgressIntent(command.intentId); storeUnknown(locator, null)
        if (pending.current?.intentId === command.intentId) { pending.current = null; queueMicrotask(() => { void flushRef.current() }) }
        return 'skipped'
      }
      const accepted = mutationView(command.body, result.etag, result.updatedAt); valueRef.current = accepted; setValue(accepted); notify(locator, accepted)
      productClient.abandonReadingProgressIntent(command.intentId); storeUnknown(locator, null); pending.current = null; setSaveState('saved'); setMessage('Progress saved'); queueMicrotask(() => { void flushRef.current() })
      return 'saved'
    } catch (error) {
      if (controller.signal.aborted) return 'skipped'
      if (requestGeneration !== generation.current) {
        if (isProductApiError(error) && (error.code === 'transport_error' || error.code === 'command_in_progress')) storeUnknown(locator, command)
        else { productClient.abandonReadingProgressIntent(command.intentId); storeUnknown(locator, null) }
        return 'skipped'
      }
      if (isProductApiError(error) && error.isPreconditionFailed) {
        productClient.abandonReadingProgressIntent(command.intentId); storeUnknown(locator, null); pending.current = null; unsent.current = null; setMessage('Progress changed elsewhere. Showing the latest version.'); await load(); return 'error'
      }
      if (isProductApiError(error) && (error.code === 'transport_error' || error.code === 'command_in_progress')) {
        storeUnknown(locator, command); setSaveState('unknown'); setMessage('Progress may not have been saved. Try again.'); return 'unknown'
      }
      productClient.abandonReadingProgressIntent(command.intentId); storeUnknown(locator, null); pending.current = null; setSaveState('error'); setMessage(isProductApiError(error) ? error.recoveryHint : 'Progress could not be saved'); await load()
      return 'error'
    } finally { mutationControllers.current.delete(controller) }
    // Primitive locator fields; object identity would reload on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locator ids, not identity
  }, [load, locator.resourceId, locator.resourceType])

  const flush = useCallback(async (): Promise<ReadingProgressSaveOutcome> => {
    if (!unsent.current || pending.current) return 'skipped'
    const body = unsent.current; unsent.current = null; clearTimers()
    const optimistic = { ...valueRef.current, ...body }; valueRef.current = optimistic; setValue(optimistic)
    return execute({ body, ifMatch: valueRef.current.etag, intentId: productClient.mutationIntentKey('reading-progress', productClient.newCommandId()) })
  }, [clearTimers, execute])
  const flushRef = useRef(flush); flushRef.current = flush

  const queue = useCallback((body: ReadingProgressUpdate, immediate = false): Promise<ReadingProgressSaveOutcome> => {
    if (pending.current && saveState === 'unknown') return Promise.resolve('skipped')
    unsent.current = body; const optimistic = { ...valueRef.current, ...body }; valueRef.current = optimistic; setValue(optimistic); setSaveState('saving'); setMessage('Saving progress')
    if (body.progress > 0 && body.progress < 1) lastIncomplete.current = body.progress
    // Bind an immediate intent to this render's locator. Path Reader advances to
    // the next resource in the same click, before a queued microtask can run.
    if (immediate) {
      clearTimers()
      return new Promise((resolve) => { queueMicrotask(() => { void flush().then(resolve) }) })
    }
    const now = Date.now(); if (firstQueuedAt.current === null) firstQueuedAt.current = now
    if (debounceTimer.current !== undefined) window.clearTimeout(debounceTimer.current)
    debounceTimer.current = window.setTimeout(() => { void flushRef.current() }, locator.debounceMs ?? 500)
    if (maxTimer.current === undefined) maxTimer.current = window.setTimeout(() => { void flushRef.current() }, locator.maxWaitMs ?? 2000)
    return Promise.resolve('skipped')
  }, [clearTimers, flush, locator.debounceMs, locator.maxWaitMs, saveState])

  useEffect(() => {
    const snapshot = getSessionSnapshot(); const nextAccount = snapshot.me?.account.id ?? null; const changed = accountId.current !== nextAccount; accountId.current = nextAccount
    const identityChanged = identityRef.current !== privateIdentity; identityRef.current = privateIdentity
    const nextResource = `${locator.resourceType}:${locator.resourceId}`; const resourceChanged = resourceRef.current !== nextResource; resourceRef.current = nextResource
    generation.current += 1; readController.current?.abort()
    if (identityChanged) { if (pending.current) productClient.abandonReadingProgressIntent(pending.current.intentId); for (const controller of mutationControllers.current) controller.abort(); mutationControllers.current.clear() }
    pending.current = null; unsent.current = null; clearTimers()
    if (locator.enabled === false) { setSaveState('saved'); return }
    if (!snapshot.authenticated) { const next = empty(); valueRef.current = next; setValue(next); setSaveState('saved'); setMessage('Sign in to save progress'); return }
    if (changed || resourceChanged) { const next = cache.get(key(locator)) ?? empty(); valueRef.current = next; setValue(next) }
    const restored = restoreUnknown(locator)
    if (restored) { pending.current = restored; const optimistic = { ...valueRef.current, ...restored.body }; valueRef.current = optimistic; setValue(optimistic); setSaveState('unknown'); setMessage('Progress may not have been saved. Try again.'); return }
    void load()
  // Primitive locator fields; object identity would reload on every parent render.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- locator ids, not identity
  }, [clearTimers, load, privateIdentity, locator.enabled, locator.resourceId, locator.resourceType])

  useEffect(() => {
    const sync = (event: Event) => { const detail = (event as CustomEvent).detail as { identity: string; resourceType: string; resourceId: string; value: Cached }; if (detail.identity !== identity() || detail.resourceType !== locator.resourceType || detail.resourceId !== locator.resourceId || pending.current || unsent.current) return; generation.current += 1; valueRef.current = detail.value; setValue(detail.value); setSaveState('saved'); setMessage('Progress synced') }
    if (locator.enabled === false) return
    const refresh = () => { if (document.visibilityState !== 'hidden' && !pending.current && !unsent.current) void load() }
    const pagehide = () => flushRef.current()
    const visibility = () => document.visibilityState === 'hidden' ? flushRef.current() : refresh()
    window.addEventListener(SYNC_EVENT, sync); window.addEventListener('focus', refresh); window.addEventListener('pageshow', refresh); window.addEventListener('pagehide', pagehide); document.addEventListener('visibilitychange', visibility)
    return () => { window.removeEventListener(SYNC_EVENT, sync); window.removeEventListener('focus', refresh); window.removeEventListener('pageshow', refresh); window.removeEventListener('pagehide', pagehide); document.removeEventListener('visibilitychange', visibility); flush(); readController.current?.abort() }
  }, [flush, load, locator.enabled, locator.resourceId, locator.resourceType])

  const setProgress = useCallback((progress: number) => { const rounded = Math.max(0, Math.min(0.99999, Math.round(progress * 100000) / 100000)); if (rounded <= valueRef.current.progress || valueRef.current.status === 'completed') return; void queue({ status: rounded === 0 ? 'not_started' : 'in_progress', progress: rounded }) }, [queue])
  const toggleComplete = useCallback(() => {
    if (valueRef.current.status === 'completed') {
      return queue({ status: 'in_progress', progress: Math.min(0.99999, Math.max(0.00001, lastIncomplete.current)) }, true)
    }
    return queue({ status: 'completed', progress: 1 }, true)
  }, [queue])
  const retry = useCallback(() => { if (pending.current && saveState === 'unknown') void execute(pending.current) }, [execute, saveState])
  return { progress: value.progress, status: value.status, complete: value.status === 'completed', saveState, message, setProgress, toggleComplete, retry, flush, reload: load }
}

export function useReadingProgressList() {
  const [items, setItems] = useState<ReadingProgressView[]>([]); const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading'); const [message, setMessage] = useState('Loading reading progress'); const privateIdentity = usePrivateIdentity()
  const controllerRef = useRef<AbortController | null>(null); const generation = useRef(0); const itemsRef = useRef<ReadingProgressView[]>([])
  const replace = useCallback((next: ReadingProgressView[]) => { itemsRef.current = next; setItems(next) }, [])
  // `reset` empties the list before refetching; only an identity change or a
  // signed-out session warrants it. A plain refresh keeps the rendered rows and
  // stays out of the loading state, so consumers never flash back to an empty
  // list while revalidating.
  const load = useCallback((options?: { readonly reset?: boolean }) => {
    const current = ++generation.current; controllerRef.current?.abort(); const controller = new AbortController(); controllerRef.current = controller
    if (options?.reset) replace([])
    if (!getSessionSnapshot().authenticated) { replace([]); setState('ready'); return () => controller.abort() }
    if (itemsRef.current.length === 0) setState('loading')
    productClient.loadReadingProgress({}, { signal: controller.signal, maxRetries: 0 }).then((next) => { if (controller.signal.aborted || current !== generation.current) return; replace(next); setState('ready') }, (error) => { if (controller.signal.aborted || current !== generation.current) return; setState('error'); setMessage(isProductApiError(error) ? error.recoveryHint : "Couldn't load reading progress") })
    return () => controller.abort()
  }, [replace])
  useEffect(() => load({ reset: true }), [load, privateIdentity])
  useEffect(() => { const refresh = () => { load() }; window.addEventListener(SYNC_EVENT, refresh); window.addEventListener('focus', refresh); return () => { window.removeEventListener(SYNC_EVENT, refresh); window.removeEventListener('focus', refresh); controllerRef.current?.abort() } }, [load])
  return { items, state, message, reload: load }
}
