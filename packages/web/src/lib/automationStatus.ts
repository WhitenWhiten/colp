import { useEffect, useSyncExternalStore } from 'react'
import { automationApi, type AutomationApi } from '../api/automationClient'
import { ProductApiError } from '../api/errors'
import type { AutomationPauseState } from '../api/automationTypes'

/* Whether this server offers automations, and whether the owner paused them
   all. The server conceals the whole surface (404) unless its operator
   enabled it, so only the server can say; the answer drives the nav entry
   and the "Paused" marker every page shows (AU-14). One read per account per
   page load; the Automations page publishes fresher state as it learns it. */

export type AutomationStatus =
  | { state: 'unknown' }
  | { state: 'unavailable' }
  | { state: 'available'; paused: boolean; pause: AutomationPauseState | null }

const STORAGE_PREFIX = 'known.automations.available.v1:'

let status: AutomationStatus = { state: 'unknown' }
let loadedFor: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function remember(accountId: string, available: boolean) {
  try {
    localStorage.setItem(STORAGE_PREFIX + accountId, available ? '1' : '0')
  } catch { /* a preference cache only */ }
}

function remembered(accountId: string): AutomationStatus {
  try {
    const value = localStorage.getItem(STORAGE_PREFIX + accountId)
    if (value === '1') return { state: 'available', paused: false, pause: null }
    if (value === '0') return { state: 'unavailable' }
  } catch { /* fall through */ }
  return { state: 'unknown' }
}

function set(next: AutomationStatus) {
  status = next
  emit()
}

/** A page that read the pause state hands it on, so the nav agrees with it. */
export function publishAutomationPause(pause: AutomationPauseState): void {
  set({ state: 'available', paused: pause.paused, pause })
  if (loadedFor) remember(loadedFor, true)
}

/** A page that met the server's 404 says the feature is off here. */
export function publishAutomationUnavailable(): void {
  set({ state: 'unavailable' })
  if (loadedFor) remember(loadedFor, false)
}

export function isAutomationUnavailableError(error: unknown): boolean {
  return error instanceof ProductApiError
    && (error.status === 404 || (error.status === 403 && error.code === 'automation_mode_disabled'))
}

async function load(accountId: string, api: AutomationApi) {
  try {
    const pause = await api.getPause()
    if (loadedFor !== accountId) return
    publishAutomationPause(pause)
  } catch (error) {
    if (loadedFor !== accountId) return
    // A network failure keeps the remembered answer; only the server's "no" hides the entry.
    if (isAutomationUnavailableError(error)) publishAutomationUnavailable()
  }
}

/** Reads the status once per signed-in account; signed out, it is unknown. */
export function useAutomationStatus(accountId: string | null, api: AutomationApi = automationApi): AutomationStatus {
  useEffect(() => {
    if (accountId === null) {
      loadedFor = null
      set({ state: 'unknown' })
      return
    }
    if (loadedFor === accountId) return
    loadedFor = accountId
    set(remembered(accountId))
    // Vitest replaces fetch with a guard; the default loader must not call it.
    if (import.meta.env.MODE === 'test' && api === automationApi) return
    void load(accountId, api)
  }, [accountId, api])
  return useSyncExternalStore(subscribe, () => status, () => status)
}

/** Test seam: forget the page-lifetime state. */
export function resetAutomationStatus(): void {
  status = { state: 'unknown' }
  loadedFor = null
  emit()
}
