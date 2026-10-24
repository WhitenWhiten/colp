import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isActivityUnavailableError, type ActivityApi } from '../../api/activityClient'
import type { ActivityItem, ActivityPage } from '../../api/activityTypes'
import { privateSessionIdentity, subscribeSession } from '../../api/sessionStore'
import { useToast } from '../../components/AppToast'
import { publishActivityUnavailable, refreshActivitySummary } from '../../lib/activityStatus'

type Inbox = ActivityPage & { loading: boolean; loadingMore: boolean; error: unknown }
const EMPTY: Inbox = { items: [], nextCursor: null, unreadCount: 0, loading: true, loadingMore: false, error: null }

/** The page keeps its arrival-time New markers, just as run outputs do. */
export function useActivityInbox(api: ActivityApi, accountId: string | null) {
  const identity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const key = `${accountId ?? ''}:${identity}`
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const [version, setVersion] = useState(0)
  const [loaded, setLoaded] = useState({ key, filter, inbox: EMPTY })
  const [markingFor, setMarkingFor] = useState<string | null>(null)
  /* The visit's automatic read has answered: until then Mark all read would
     only flash in the head between the first page and that read. */
  const [settledFor, setSettledFor] = useState<string | null>(null)
  const marking = markingFor === key
  const firstPageMarked = useRef<string | null>(null)
  const generation = useRef(0)
  const activeKey = useRef(key)
  const mounted = useRef(false)
  activeKey.current = key
  const { error: toastError } = useToast()
  const inbox = loaded.key === key && loaded.filter === filter ? loaded.inbox : EMPTY
  const toastRef = useRef(toastError)
  toastRef.current = toastError

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current += 1 }
  }, [])

  useEffect(() => {
    if (!accountId) return
    const controller = new AbortController()
    const request = ++generation.current
    setLoaded({ key, filter, inbox: EMPTY })
    api.listActivity({ state: filter, limit: 20 }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || request !== generation.current || key !== activeKey.current) return
        setLoaded({ key, filter, inbox: { ...page, loading: false, loadingMore: false, error: null } })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || request !== generation.current || key !== activeKey.current) return
        if (isActivityUnavailableError(error)) publishActivityUnavailable()
        setLoaded({ key, filter, inbox: { ...EMPTY, loading: false, error } })
      })
    return () => controller.abort()
  }, [accountId, api, filter, key, version])

  const markRead = useCallback(async (shown: ActivityItem, everything = false) => {
    setMarkingFor(key)
    try {
      // On demand, also what arrived after this page loaded: the summary
      // names the newest item; the page's newest stands in if it can't.
      const latest = everything ? (await api.getActivitySummary().catch(() => null))?.latest : undefined
      const boundary = latest ?? shown
      const result = await api.markActivityRead({ through: boundary.id, throughRevision: boundary.revision })
      if (!mounted.current || key !== activeKey.current) return
      setLoaded((value) => value.key === key ? { ...value, inbox: { ...value.inbox, unreadCount: result.unreadCount } } : value)
      await refreshActivitySummary()
    } catch (error) {
      if (mounted.current && key === activeKey.current) toastRef.current(error instanceof Error ? error.message : 'Could not mark activity read. Try again.')
    } finally {
      if (mounted.current && key === activeKey.current) setMarkingFor(null)
    }
  }, [api, key])

  // Runs after the first rendered page, once for this account's visit. A
  // later page or filter never advances the initial read-through boundary.
  useEffect(() => {
    const newest = inbox.items[0]
    if (inbox.loading || inbox.error || !newest || firstPageMarked.current === key) return
    firstPageMarked.current = key
    if (inbox.unreadCount === 0) setSettledFor(key)
    else void markRead(newest).finally(() => { if (mounted.current && key === activeKey.current) setSettledFor(key) })
  }, [inbox, key, markRead])

  async function more() {
    if (!inbox.nextCursor || inbox.loadingMore) return
    const request = generation.current
    setLoaded((value) => ({ ...value, inbox: { ...value.inbox, loadingMore: true } }))
    try {
      const page = await api.listActivity({ state: filter, cursor: inbox.nextCursor, limit: 20 })
      if (request !== generation.current || key !== activeKey.current) return
      setLoaded((value) => {
        const ids = new Set(value.inbox.items.map((item) => item.id))
        return { ...value, inbox: { ...page, items: [...value.inbox.items, ...page.items.filter((item) => !ids.has(item.id))], loading: false, loadingMore: false, error: null } }
      })
    } catch (error) {
      if (request !== generation.current || key !== activeKey.current) return
      toastRef.current(error instanceof Error ? error.message : 'Could not load more activity. Try again.')
      setLoaded((value) => ({ ...value, inbox: { ...value.inbox, loadingMore: false } }))
    }
  }

  return {
    inbox, filter, setFilter, marking, more,
    canMarkAll: settledFor === key && inbox.unreadCount > 0 && inbox.items.length > 0,
    retry: () => setVersion((value) => value + 1),
    markAll: () => { if (!marking && inbox.items[0]) void markRead(inbox.items[0], true) },
  }
}
