import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useExitAnimation } from '../lib/useExitAnimation'
import { Icon, type IconName } from './Icon'

type ToastVariant = 'info' | 'success' | 'error'

/**
 * Optional small button/link inside the toast, rendered with the same visual
 * language as the close button. Infrastructure for follow-ups like
 * "Moved → View in folder" (`to`) and "Deleted → Undo" (`onClick`).
 */
export type ToastAction =
  | { label: string; onClick: () => void; to?: never }
  | { label: string; to: string; onClick?: never }

type ToastOptions = {
  action?: ToastAction
}

type PendingToast = {
  msg: string
  variant: ToastVariant
  options?: ToastOptions
}

type ToastCtx = {
  toast: (msg: string, variant?: ToastVariant, options?: ToastOptions) => void
  success: (msg: string, options?: ToastOptions) => void
  error: (msg: string, options?: ToastOptions) => void
}

const Ctx = createContext<ToastCtx>({ toast: () => {}, success: () => {}, error: () => {} })

/**
 * Route-boundary reset only (see ToastRouteReset) — kept out of the public
 * useToast surface so feature code cannot wipe another surface's feedback.
 */
const ClearCtx = createContext<() => void>(() => {})

/**
 * Feedback-channel rule — see PRODUCT.md "Toast vs inline status".
 * This slot is cross-cutting, brief, and optionally undoable: one at a time,
 * never parked. Field errors, in-flight on the same widget, and persistent
 * page/section state belong in `role="status"` / `role="alert"` / `.field-error`.
 * Do not toast a field error or duplicate a visible inline success.
 */
export function useToast() {
  return useContext(Ctx)
}

/**
 * Errors used to be duration 0 (parked until closed). A real-user walkthrough
 * showed stale errors surviving route changes and starving the single slot,
 * so every variant now auto-dismisses: errors get the longest floor since
 * they carry the most consequence, but nothing lives forever.
 */
const variantConfig: Record<ToastVariant, { icon: IconName; duration: number; className: string }> = {
  info:    { icon: 'info',    duration: 5000, className: '' },
  success: { icon: 'check',   duration: 6000, className: 'toast--success' },
  /* `cross` is the dismiss control. A second one in the status slot reads as a dead close button. */
  error:   { icon: 'alert',   duration: 8000, className: 'toast--error' },
}

/**
 * Transient toasts have to outlast reading them. Auth flows put the target
 * mailbox in the message ("We sent a code to …"), which was unreadable at the
 * old sub-two-second dwell, so the variant duration acts as a floor and long
 * messages earn reading time on top of it — capped so nothing parks on screen.
 */
const READING_MS_PER_CHAR = 60
const MAX_DURATION_MS = 12_000

/**
 * R7-10: toasts carrying an action (Undo, View in folder) are a safety net,
 * not just feedback — they get a longer floor so the user can still reach
 * them after re-orienting (the old 6s success dwell regularly expired before
 * an accidental delete was noticed).
 */
const ACTION_TOAST_MIN_MS = 10_000

/**
 * A freshly shown error keeps a short reading-protection window during which
 * nothing displaces it (the bounded remnant of the old sticky-error intent).
 * Past the window it counts as read, and the newest toast takes the slot.
 */
const ERROR_READ_PROTECTION_MS = 2000

/**
 * Shared so surfaces with their own toast (the dashboard canvas) dwell for the
 * same time as the app toast instead of picking a second, shorter number.
 */
export function transientToastDwell(message: string, variant: 'info' | 'success' = 'info') {
  return dwellFor(message, variantConfig[variant].duration)
}

function dwellFor(message: string, base: number) {
  if (base <= 0) return 0
  return Math.min(MAX_DURATION_MS, Math.max(base, message.length * READING_MS_PER_CHAR))
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const [variant, setVariant] = useState<ToastVariant>('info')
  const [action, setAction] = useState<ToastAction | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const remaining = useRef(0)
  const startedAt = useRef(0)
  const timed = useRef(false)
  const visibleVariant = useRef<ToastVariant | null>(null)
  const visibleSince = useRef(0)
  const visibleAction = useRef<ToastAction | null>(null)
  const queued = useRef<PendingToast | null>(null)

  const dismiss = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    remaining.current = 0
    timed.current = false
    visibleVariant.current = null
    visibleAction.current = null
    setMsg(null)
    setAction(null)
  }, [])

  const clear = useCallback(() => {
    queued.current = null
    /* R7-10: an action toast (Undo after delete) must survive route changes —
       deleting often navigates away from the deleted place, and wiping the
       toast there would destroy the only path back. It still auto-dismisses
       on its own timer. */
    if (visibleAction.current) return
    dismiss()
  }, [dismiss])

  const armTimer = useCallback((duration: number) => {
    window.clearTimeout(timer.current)
    timed.current = duration > 0
    if (duration <= 0) {
      remaining.current = 0
      timer.current = undefined
      return
    }
    remaining.current = duration
    startedAt.current = Date.now()
    timer.current = window.setTimeout(dismiss, duration)
  }, [dismiss])

  const fire = useCallback((m: string, v: ToastVariant = 'info', options?: ToastOptions) => {
    // An error inside its reading-protection window is not displaced:
    // arrivals queue behind it (latest wins) and surface when it clears.
    // Once the window has passed the error counts as read and the newest
    // toast replaces it — the single slot must not starve later feedback.
    if (
      visibleVariant.current === 'error' &&
      Date.now() - visibleSince.current < ERROR_READ_PROTECTION_MS
    ) {
      queued.current = { msg: m, variant: v, options }
      return
    }
    /* R9-31 (R6-17 residual): a visible action toast is the only path back
       from a destructive row action (Undo). A long dwell alone did not stop
       a follow-up "Copied" from displacing it — so while one is on screen,
       non-error arrivals queue behind it. A fresh error still displaces it:
       an error outranks everything once its own window has passed. */
    if (visibleAction.current !== null && v !== 'error') {
      queued.current = { msg: m, variant: v, options }
      return
    }
    // The incoming toast is newer than anything parked behind the previous
    // one, so displacing also drops the stale queue entry.
    queued.current = null
    visibleVariant.current = v
    visibleSince.current = Date.now()
    visibleAction.current = options?.action ?? null
    setMsg(m)
    setVariant(v)
    setAction(options?.action ?? null)
    const floor = options?.action
      ? Math.max(variantConfig[v].duration, ACTION_TOAST_MIN_MS)
      : variantConfig[v].duration
    armTimer(dwellFor(m, floor))
  }, [armTimer])

  // Once the visible toast clears, surface whatever queued behind it.
  useEffect(() => {
    if (msg !== null) return
    const next = queued.current
    if (!next) return
    queued.current = null
    fire(next.msg, next.variant, next.options)
  }, [msg, fire])

  const pauseTimer = useCallback(() => {
    if (!timed.current || !timer.current) return
    window.clearTimeout(timer.current)
    timer.current = undefined
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current))
  }, [])

  const resumeTimer = useCallback(() => {
    if (!timed.current || timer.current) return
    if (remaining.current <= 0) {
      dismiss()
      return
    }
    startedAt.current = Date.now()
    timer.current = window.setTimeout(dismiss, remaining.current)
  }, [dismiss])

  const swipeStartY = useRef<number | null>(null)
  const onSwipeStart = useCallback((event: PointerEvent<HTMLDivElement>) => {
    swipeStartY.current = event.clientY
  }, [])
  const onSwipeEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const start = swipeStartY.current
    swipeStartY.current = null
    if (start != null && event.clientY - start >= 56) dismiss()
  }, [dismiss])

  const value = useMemo(() => ({
    toast: fire,
    success: (m: string, options?: ToastOptions) => fire(m, 'success', options),
    error: (m: string, options?: ToastOptions) => fire(m, 'error', options),
  }), [fire])

  // Exit phase: after dismissal the toast stays mounted for one beat with
  // .is-closing so the fade-down can play. The slot state is already null by
  // then, so the last visible content is kept for the closing frame.
  const open = msg !== null
  const { mounted, closing } = useExitAnimation(open)
  const lastShownRef = useRef<{ msg: string; variant: ToastVariant; action: ToastAction | null }>({
    msg: '',
    variant: 'info',
    action: null,
  })
  if (open) lastShownRef.current = { msg, variant, action }
  const shown = closing ? lastShownRef.current : { msg: msg ?? '', variant, action }

  const { icon, className } = variantConfig[shown.variant]
  const isError = shown.variant === 'error'
  const shownAction = shown.action
  const politeActive = mounted && !isError
  const assertiveActive = mounted && isError

  const toastBody = (active: boolean) => {
    if (!active) return null
    return (
      <>
        <span className="toast-icon" aria-hidden>
          <Icon name={icon} />
        </span>
        <span className="toast-message">{shown.msg}</span>
        {shownAction && (shownAction.to !== undefined ? (
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- react-router Link renders a native anchor; Enter fires onClick (dismiss) natively
          <Link className="toast-action" to={shownAction.to} onClick={dismiss}>
            {shownAction.label}
          </Link>
        ) : (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              const run = shownAction.onClick
              dismiss()
              run()
            }}
          >
            {shownAction.label}
          </button>
        ))}
        <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={dismiss}>
          <Icon name="cross" />
        </button>
      </>
    )
  }

  const liveRegion = (kind: 'status' | 'alert', active: boolean) => (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- hovering pauses auto-dismiss; keyboard parity lives in the onFocus/onBlur handlers on this same element
    <div
      className={active ? `toast ${className}${closing ? ' is-closing' : ''}` : 'visually-hidden'}
      role={kind}
      aria-live={kind === 'alert' ? 'assertive' : 'polite'}
      aria-atomic="true"
      inert={active && closing ? true : undefined}
      onMouseEnter={active ? pauseTimer : undefined}
      onMouseLeave={active ? resumeTimer : undefined}
      onFocus={active ? pauseTimer : undefined}
      onBlur={active ? resumeTimer : undefined}
      onPointerDown={active ? onSwipeStart : undefined}
      onPointerUp={active ? onSwipeEnd : undefined}
      onPointerCancel={active ? () => { swipeStartY.current = null } : undefined}
    >
      {toastBody(active)}
    </div>
  )

  return (
    <Ctx.Provider value={value}>
      <ClearCtx.Provider value={clear}>
        {children}
        {/* R10-34: two always-mounted live regions. A single node whose
            role flips from status to alert (or remounts via key) can drop
            the announcement. Empty polite/assertive slots stay in the tree. */}
        {liveRegion('status', politeActive)}
        {liveRegion('alert', assertiveActive)}
      </ClearCtx.Provider>
    </Ctx.Provider>
  )
}

/**
 * Clears the visible toast and the queue when the route changes, so feedback
 * never follows the user across pages (walkthrough: a login error trailed the
 * user into /library and blocked every later success message). Mounted by
 * Layout inside both the router and ToastProvider — the provider itself stays
 * router-free so it can render (and be tested) without one.
 */
export function ToastRouteReset() {
  const { pathname } = useLocation()
  const clear = useContext(ClearCtx)
  const firstRoute = useRef(true)
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false
      return
    }
    clear()
  }, [pathname, clear])
  return null
}
