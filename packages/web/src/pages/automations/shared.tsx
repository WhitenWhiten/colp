import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { automationApi, type AutomationApi } from '../../api/automationClient'
import { ProductApiError } from '../../api/errors'
import { StatusBadge } from '../../components/StatusBadge'
import type { AutomationRule } from '../../api/automationTypes'
import { defaultFolderSource, type FolderSource } from './folders'
import { agentsApi, type AgentsApi } from '../../api/agentsClient'
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
  const [state, setState] = useState<Load<T>>({ status: 'loading' })
  const [version, setVersion] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const active = useRef<AbortController | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (key === null) return
    const controller = new AbortController()
    const request = ++generation.current
    active.current = controller
    void loaderRef.current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted && request === generation.current) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && request === generation.current) setState({ status: 'error', error })
      })
    return () => {
      controller.abort()
      if (active.current === controller) active.current = null
    }
  }, [key, version])

  useEffect(() => {
    setState({ status: 'loading' })
  }, [key])

  const reload = useCallback(() => {
    generation.current += 1
    active.current?.abort()
    setVersion((value) => value + 1)
  }, [])
  const replace = useCallback((data: T) => {
    generation.current += 1
    active.current?.abort()
    setState({ status: 'ready', data })
  }, [])
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
