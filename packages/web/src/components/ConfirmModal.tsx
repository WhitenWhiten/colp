import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { INTERNAL_NAVIGATION_REQUEST } from '../lib/navigationGuard'
import { Modal } from './Modal'

export type ConfirmRequest = {
  /** Dialog heading + accessible label, e.g. "Delete this private note?" */
  title: string
  /** Supporting copy — keep the operator-visible consequences here. */
  body?: ReactNode
  /** Destructive-action button text. Default "Delete". */
  confirmLabel?: string
  cancelLabel?: string
}

type PendingConfirm = ConfirmRequest & {
  resolve: (confirmed: boolean) => void
}

/* R9-19: one promise-based confirm modal mounted once under Layout replaces
   the six window.confirm sites. The hook-level API stays synchronous-looking
   (`await confirm({…}) → boolean`); the actual prompt is Modal tone="danger",
   so destructive choices inherit the shared focus trap, Esc handling and the
   non-destructive-first initial focus. Outside a provider (bare hook mounts
   in tests) the default context resolves false — never silently confirms.
   R11-01: owners that used to mount their own Modal must dismiss the shared
   prompt when they unmount or navigate, otherwise it outlives the page. */
const ConfirmContext = createContext<(request: ConfirmRequest) => Promise<boolean>>(
  () => Promise.resolve(false),
)
const ConfirmCancelContext = createContext<() => void>(() => {})

export function useConfirm() {
  return useContext(ConfirmContext)
}

/** Dismiss an open prompt as cancelled. No-op when nothing is pending. */
export function useCancelConfirm() {
  return useContext(ConfirmCancelContext)
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const resolverRef = useRef<PendingConfirm | null>(null)

  const settle = useCallback((confirmed: boolean) => {
    resolverRef.current?.resolve(confirmed)
    resolverRef.current = null
    setPending(null)
  }, [])

  const confirm = useCallback((request: ConfirmRequest) => {
    // A second request supersedes a still-open one: resolve the stale
    // promise false so its caller treats it as cancelled rather than waiting
    // forever on a modal that is no longer theirs.
    resolverRef.current?.resolve(false)
    return new Promise<boolean>((resolve) => {
      const entry: PendingConfirm = { ...request, resolve }
      resolverRef.current = entry
      setPending(entry)
    })
  }, [])

  /* Unmounting with a prompt open (route changed under us) resolves false —
   * callers never observe a dangling confirm. */
  useEffect(
    () => () => {
      resolverRef.current?.resolve(false)
      resolverRef.current = null
    },
    [],
  )

  const cancel = useCallback(() => settle(false), [settle])

  return (
    <ConfirmContext.Provider value={confirm}>
      <ConfirmCancelContext.Provider value={cancel}>
        {children}
        <Modal
          open={pending !== null}
          onClose={() => settle(false)}
          label={pending?.title ?? 'Confirm'}
          title={pending?.title ?? ''}
          size="sm"
          tone="danger"
        >
          {pending?.body ? <p>{pending.body}</p> : null}
          <div className="empty-state-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => settle(false)}
            >
              {pending?.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => settle(true)}
            >
              {pending?.confirmLabel ?? 'Delete'}
            </button>
          </div>
        </Modal>
      </ConfirmCancelContext.Provider>
    </ConfirmContext.Provider>
  )
}

/** Block in-app navigation while `active` is true. In-app clicks flow through
    Layout's capture-phase interceptor, which turns each internal anchor click
    into a cancelable `INTERNAL_NAVIGATION_REQUEST`; this guard vetoes the
    request synchronously (a modal cannot answer inside the dispatch) and the
    paired click handler opens the confirm modal. On confirm the original
    anchor is re-clicked under a one-shot bypass, so Layout still routes the
    navigation (view transitions included). beforeunload stays browser-native
    — a custom modal cannot intercept tab closes. */
export function useConfirmLeaveGuard(active: boolean, request: ConfirmRequest) {
  const confirm = useConfirm()
  const requestRef = useRef(request)
  requestRef.current = request
  const bypassRef = useRef(false)

  useEffect(() => {
    if (!active) {
      bypassRef.current = false
      return
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    const guardInternalNavigation = (event: Event) => {
      if (bypassRef.current || event.defaultPrevented) return
      event.preventDefault()
    }
    const guardLinks = (event: MouseEvent) => {
      if (bypassRef.current) return
      // Do NOT skip defaultPrevented anchors: when Layout's interceptor ran
      // first it already preventDefaulted this click (and our request veto
      // stopped the navigation) — the modal is still owed.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]')
      if (!anchor || anchor.target === '_blank') return
      if (new URL(anchor.href, window.location.href).origin !== window.location.origin) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void confirm(requestRef.current).then((ok) => {
        if (!ok) return
        bypassRef.current = true
        anchor.click()
        bypassRef.current = false
      })
    }
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener(INTERNAL_NAVIGATION_REQUEST, guardInternalNavigation)
    document.addEventListener('click', guardLinks, true)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      window.removeEventListener(INTERNAL_NAVIGATION_REQUEST, guardInternalNavigation)
      document.removeEventListener('click', guardLinks, true)
    }
  }, [active, confirm])
}
