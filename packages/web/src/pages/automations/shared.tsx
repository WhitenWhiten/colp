import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { automationApi, type AutomationApi } from '../../api/automationClient'
import { ProductApiError } from '../../api/errors'
import { StatusBadge } from '../../components/StatusBadge'
import type { AutomationRule } from '../../api/automationTypes'
import { defaultFolderSource, type FolderSource } from './folders'
import { agentsApi, type AgentsApi } from '../../api/agentsClient'
import { privateSessionIdentity, subscribeSession } from '../../api/sessionStore'
import { RULE_STATE } from './copy'

export type AutomationDeps = { api: AutomationApi; folders: FolderSource; agents?: Pick<AgentsApi, 'listAgents'> }

const DepsContext = createContext<AutomationDeps>({ api: automationApi, folders: defaultFolderSource, agents: agentsApi })

export function AutomationDepsProvider({ value, children }: { value: AutomationDeps; children: ReactNode }) {
  return <DepsContext.Provider value={value}>{children}</DepsContext.Provider>
}

export function useAutomationDeps(): AutomationDeps {
  return useContext(DepsContext)
}

export type Load<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown }

/**
 * One read keyed by `key`: a new key reloads, `reload` re-reads in place
 * (keeping the current data on screen), `replace` stores a fresher copy a
 * write returned. Responses for an older key are dropped.
 */
export function useLoad<T>(key: string | null, loader: (signal: AbortSignal) => Promise<T>) {
  const identity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const [loaded, setLoaded] = useState<{ identity: string; key: string | null; state: Load<T> }>({ identity, key, state: { status: 'loading' } })
  const [version, setVersion] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const active = useRef<AbortController | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (key === null || identity !== privateSessionIdentity()) return
    const setState = (state: Load<T>) => setLoaded({ identity, key, state })
    const controller = new AbortController()
    const request = ++generation.current
    active.current = controller
    void loaderRef.current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted && request === generation.current && identity === privateSessionIdentity()) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && request === generation.current && identity === privateSessionIdentity()) setState({ status: 'error', error })
      })
    return () => {
      controller.abort()
      if (active.current === controller) active.current = null
    }
  }, [key, version, identity])

  useEffect(() => {
    setLoaded({ identity, key, state: { status: 'loading' } })
  }, [key, identity])

  const reload = useCallback(() => {
    if (identity !== privateSessionIdentity()) return
    generation.current += 1
    active.current?.abort()
    setVersion((value) => value + 1)
  }, [identity])
  const replace = useCallback((data: T) => {
    if (identity !== privateSessionIdentity()) return
    generation.current += 1
    active.current?.abort()
    setLoaded({ identity, key, state: { status: 'ready', data } })
  }, [identity, key])
  const state: Load<T> = loaded.identity === identity && loaded.key === key ? loaded.state : { status: 'loading' }
  return { state, reload, replace }
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ProductApiError && error.message ? error.message : fallback
}

/** A write the server refused because the view was out of date. */
export function isStale(error: unknown): boolean {
  return error instanceof ProductApiError
    && (error.code === 'precondition_failed' || error.code === 'automation_stale_input' || error.status === 412)
}

export function RuleStateBadge({ state }: { state: AutomationRule['effectiveState'] }) {
  const copy = RULE_STATE[state]
  return <StatusBadge tone={copy.tone} data-state={state}>{copy.label}</StatusBadge>
}
