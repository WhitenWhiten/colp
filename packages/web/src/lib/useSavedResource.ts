import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient, type SavedResourceType, type SavedResourceView } from '../api'
import { getSessionSnapshot, subscribeSession } from '../api/sessionStore'

type State = 'loading' | 'ready' | 'saving' | 'unknown' | 'error'
type Locator = { resourceType: SavedResourceType; resourceId: string }
type Intent = { target: boolean; intentId: string }
const cache = new Map<string, boolean>()
let cacheIdentity = ''
subscribeSession((snapshot) => {
  const identity = `${snapshot.me?.account.id ?? 'anonymous'}:${snapshot.sessionEpoch}`
  if (identity !== cacheIdentity) { cache.clear(); cacheIdentity = identity }
})
function key(locator: Locator) {
  const snapshot = getSessionSnapshot()
  return `${snapshot.me?.account.id ?? 'anonymous'}:${snapshot.sessionEpoch}:${locator.resourceType}:${locator.resourceId}`
}

function identity() {
  const snapshot = getSessionSnapshot()
  return `${snapshot.me?.account.id ?? 'anonymous'}:${snapshot.sessionEpoch}`
}

function usePrivateIdentity() {
  const [value, setValue] = useState(identity)
  useEffect(() => subscribeSession(() => setValue(identity())), [])
  return value
}

export function useSavedResource(locator: Locator) {
  const [saved, setSaved] = useState(() => cache.get(key(locator)) ?? false)
  const [state, setState] = useState<State>('loading')
  const [message, setMessage] = useState('Loading saved state')
  const pending = useRef<Intent | null>(null)
  const generation = useRef(0)
  const readController = useRef<AbortController | null>(null)
  const mutationController = useRef<AbortController | null>(null)
  const accountId = useRef(getSessionSnapshot().me?.account.id ?? null)
  const privateIdentity = usePrivateIdentity()

  const load = useCallback(async () => {
    if (pending.current) return
    const current = ++generation.current
    readController.current?.abort(); const next = new AbortController(); readController.current = next
    setState('loading')
    try {
      const items = await productClient.loadSavedResources({ resourceType: locator.resourceType }, { signal: next.signal, maxRetries: 0 })
      if (current !== generation.current) return
      const value = items.some((item) => item.resourceType === locator.resourceType && item.resourceId === locator.resourceId)
      cache.set(key(locator), value); setSaved(value); setState('ready'); setMessage(value ? 'Saved' : 'Not saved')
    } catch (error) {
      if (next.signal.aborted || current !== generation.current) return
      setState('error'); setMessage(isProductApiError(error) ? error.recoveryHint : "Couldn't load the saved state")
    }
    // Primitive locator fields; object identity would reload on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locator ids, not identity
  }, [locator.resourceId, locator.resourceType])

  useEffect(() => {
    const snapshot = getSessionSnapshot()
    const nextAccountId = snapshot.me?.account.id ?? null
    const accountChanged = accountId.current !== nextAccountId
    accountId.current = nextAccountId
    if (!snapshot.authenticated || accountChanged) {
      generation.current += 1
      readController.current?.abort(); mutationController.current?.abort(); pending.current = null
      setSaved(snapshot.authenticated ? (cache.get(key(locator)) ?? false) : false)
      if (!snapshot.authenticated) { setState('ready'); setMessage('Not saved'); return }
    }
    if (!pending.current) void load()
    return () => readController.current?.abort()
    // Primitive locator fields; object identity would reload on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locator ids, not identity
  }, [load, privateIdentity])
  useEffect(() => () => { generation.current += 1; readController.current?.abort(); mutationController.current?.abort() }, [locator.resourceId, locator.resourceType])

  const execute = useCallback(async (intent: Intent) => {
    pending.current = intent
    mutationController.current?.abort(); const next = new AbortController(); mutationController.current = next
    const current = generation.current
    setSaved(intent.target); cache.set(key(locator), intent.target); setState('saving'); setMessage(intent.target ? 'Saving' : 'Removing')
    try {
      const options = { intentId: intent.intentId, signal: next.signal, maxRetries: 0 }
      if (intent.target) await productClient.saveResource(locator.resourceType, locator.resourceId, options)
      else await productClient.unsaveResource(locator.resourceType, locator.resourceId, options)
      if (current !== generation.current) return
      pending.current = null; setState('ready'); setMessage(intent.target ? 'Saved' : 'Not saved')
    } catch (error) {
      if (next.signal.aborted || current !== generation.current) return
      if (isProductApiError(error) && (error.code === 'transport_error' || error.code === 'command_id_reused')) {
        setState('unknown'); setMessage('The change may not have been saved. Try again.'); return
      }
      pending.current = null; cache.set(key(locator), !intent.target); setSaved(!intent.target); setState('error')
      setMessage(isProductApiError(error) ? error.recoveryHint : 'Saved state could not be changed')
    }
    // Primitive locator fields; object identity would reload on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locator ids, not identity
  }, [locator.resourceId, locator.resourceType])

  const toggle = useCallback(() => {
    if (pending.current || state === 'saving' || state === 'unknown') return
    const target = !saved
    void execute({ target, intentId: productClient.mutationIntentKey(target ? 'save-resource' : 'unsave-resource', productClient.newCommandId()) })
  }, [execute, saved, state])
  const retry = useCallback(() => { if (pending.current && state === 'unknown') void execute(pending.current) }, [execute, state])
  return { saved, state, message, pending: state === 'saving' || state === 'unknown', label: saved ? 'Saved' : 'Save', toggle, retry, reload: load }
}

export function useSavedResources() {
  const [items, setItems] = useState<SavedResourceView[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('Loading saved resources')
  const privateIdentity = usePrivateIdentity()
  const controllerRef = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const load = useCallback(() => {
    const current = ++generation.current
    const requestedIdentity = identity()
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setItems([])
    if (!getSessionSnapshot().authenticated) { setState('ready'); return }
    setState('loading')
    productClient.loadSavedResources({}, { signal: controller.signal, maxRetries: 0 }).then((next) => {
      if (controller.signal.aborted || current !== generation.current || requestedIdentity !== identity()) return
      setItems(next); setState('ready')
    }, (error) => {
      if (controller.signal.aborted || current !== generation.current || requestedIdentity !== identity()) return
      setItems([]); setState('error'); setMessage(isProductApiError(error) ? error.recoveryHint : "Couldn't load saved bookmarks")
    })
  }, [])
  useEffect(() => {
    load()
    return () => {
      controllerRef.current?.abort()
      generation.current += 1
    }
  }, [load, privateIdentity])
  return { items, state, message, reload: load }
}
