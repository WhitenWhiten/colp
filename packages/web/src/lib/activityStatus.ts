import { useEffect, useSyncExternalStore } from 'react'
import { activityApi, isActivityUnavailableError, type ActivityApi } from '../api/activityClient'
import type { ActivitySummary } from '../api/activityTypes'

export type ActivityStatus = {
  state: 'unknown' | 'unavailable' | 'available'
  unreadCount: number
  revision: string
}

const UNKNOWN: ActivityStatus = { state: 'unknown', unreadCount: 0, revision: '0' }
const listeners = new Set<() => void>()
let status = UNKNOWN
let loadedFor: string | null = null
let runtime: ReturnType<typeof start> | null = null

function publish(next: ActivityStatus) {
  status = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** A 404 conceals navigation only on legacy servers without the /me feature switch. */
export function publishActivityUnavailable(): void {
  publish({ state: 'unavailable', unreadCount: 0, revision: '0' })
  runtime?.pause()
}

/** A successful summary is the only authority for the shared unread count. */
export function publishActivitySummary(summary: ActivitySummary): void {
  publish({ state: 'available', unreadCount: summary.unreadCount, revision: summary.revision })
}

function start(accountId: string, api: ActivityApi) {
  let stopped = false
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let pending: Promise<void> | null = null
  const enabled = !(import.meta.env.MODE === 'test' && api === activityApi)
  const current = () => !stopped && loadedFor === accountId
  const pause = () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }
  const load = (force = false): Promise<void> => {
    if (!current() || !enabled || status.state === 'unavailable') return Promise.resolve()
    if (pending && !force) return pending
    controller?.abort()
    const request = new AbortController()
    controller = request
    const result = api.getActivitySummary(request.signal)
      .then((summary) => {
        if (current() && !request.signal.aborted) publishActivitySummary(summary)
      })
      .catch((error: unknown) => {
        if (current() && !request.signal.aborted && isActivityUnavailableError(error)) publishActivityUnavailable()
        // Transient errors retain the last successful count; the next poll retries.
      })
      .finally(() => { if (controller === request) pending = null })
    pending = result
    return result
  }
  const resume = () => {
    pause()
    if (!enabled || document.visibilityState !== 'visible' || status.state === 'unavailable') return
    void load()
    timer = setInterval(() => { void load() }, 60_000)
  }
  const focus = () => { if (document.visibilityState === 'visible') void load() }
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('focus', focus)
  resume()
  return {
    accountId, api, users: 0, pause, load,
    stop() {
      stopped = true
      pause()
      controller?.abort()
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('focus', focus)
    },
  }
}

/** Refresh after a read mutation, discarding any summary begun before it committed. */
export async function refreshActivitySummary(): Promise<void> {
  await runtime?.load(true)
}

export function useActivityStatus(accountId: string | null, api: ActivityApi = activityApi): ActivityStatus {
  useEffect(() => {
    if (loadedFor !== accountId) {
      runtime?.stop()
      runtime = null
      loadedFor = accountId
      publish(UNKNOWN)
    }
    if (accountId === null) return
    if (!runtime || runtime.api !== api) {
      runtime?.stop()
      runtime = start(accountId, api)
    }
    const active = runtime
    active.users += 1
    return () => {
      active.users -= 1
      if (active.users === 0) {
        active.stop()
        if (runtime === active) runtime = null
      }
    }
  }, [accountId, api])
  const snapshot = useSyncExternalStore(subscribe, () => status, () => UNKNOWN)
  return accountId !== null && loadedFor === accountId ? snapshot : UNKNOWN
}

/** Test seam: reset both the account state and all background work. */
export function resetActivityStatus(): void {
  runtime?.stop()
  runtime = null
  loadedFor = null
  publish(UNKNOWN)
}
