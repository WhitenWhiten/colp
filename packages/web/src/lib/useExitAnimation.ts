import { useEffect, useState } from 'react'
import { DURATION_FAST_MS, DURATION_STATE_MS } from './durations'

/* Exit animations run at the state tier — must match --duration-state in
   tokens.css. Enters stay on --duration-enter/-spatial; exits are quicker
   (the user already decided to leave). */
export const EXIT_DURATION_MS = DURATION_STATE_MS

/* Fast tier for hover-grade surfaces whose enter already runs at
   --duration-fast (hover cards, context menus). Must match --duration-fast. */
export const EXIT_DURATION_FAST_MS = DURATION_FAST_MS

/**
 * Whether the closing state should be entered at all.
 *
 * `animate` is injectable so the timer branch below is reachable from a test.
 * Deriving this purely from `import.meta.env.MODE` made the whole timer path
 * dead under vitest, so the JS duration and its CSS token could only be compared
 * as text — the lockstep that actually matters was unassertable.
 */
export function canAnimateExit(animate?: boolean): boolean {
  if (animate !== undefined) return animate
  if (import.meta.env.MODE === 'test') return false
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: no-preference)').matches
  )
}

/**
 * Presence controller for exit animations: after `open` flips false the
 * element stays mounted for `durationMs` with `closing: true` so an
 * `.is-closing` CSS animation can play before unmount. Reduced-motion users
 * and the test environment unmount immediately (mirrors the polish.css
 * reduced-motion contract, which zeroes all animation durations anyway).
 */
export function useExitAnimation(
  open: boolean,
  durationMs: number = EXIT_DURATION_MS,
  animate?: boolean,
): { mounted: boolean; closing: boolean } {
  const [state, setState] = useState<'closed' | 'open' | 'closing'>(open ? 'open' : 'closed')

  // Both transitions are render-phase adjustments so `closing` is already
  // true in the very render where `open` flips false. An effect-based
  // transition would let the browser paint one frame that is neither open
  // nor closing — consumers that swap to cached last-frame content only
  // while `closing` would flash their caller's already-cleared live state.
  if (open && state !== 'open') setState('open')
  if (!open && state === 'open') setState(canAnimateExit(animate) ? 'closing' : 'closed')

  useEffect(() => {
    if (state !== 'closing') return
    const timer = window.setTimeout(() => setState('closed'), durationMs)
    return () => window.clearTimeout(timer)
  }, [state, durationMs])

  return { mounted: state !== 'closed', closing: state === 'closing' }
}
