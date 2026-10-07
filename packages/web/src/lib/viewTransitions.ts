import { flushSync } from 'react-dom'
import type { NavigateFunction } from 'react-router-dom'

/**
 * Cross-route View Transitions (baseline 2026: Chromium, Safari 18.4+, and
 * graceful no-op elsewhere).
 *
 * A capture-phase click listener in Layout intercepts internal
 * <a href="/…"> clicks and routes them through here. Unsupported browsers
 * and reduced-motion users fall back to a plain React Router navigate.
 *
 * flushSync forces the new route to commit before the browser captures the
 * "new" snapshot. The vt-active class on <html> suppresses page-enter /
 * rise while the snapshot is captured, so the snapshot shows the
 * fully-formed page instead of elements frozen at opacity 0.
 *
 * vt-active is lifted when `transition.ready` resolves — after the new
 * snapshot has been captured but while the root crossfade is still running.
 * The new page's entrance animations can therefore start behind the
 * crossfade instead of being replayed from opacity 0 after the transition
 * has already shown the complete page. Keeping them suppressed for the
 * lifetime of the landed page (the previous vt-entered approach) prevented
 * the replay, but also meant every page reached through an internal link
 * never played its entrance animation.
 *
 * Back/forward navigation bypasses the click interceptor, so the class is
 * cleared on popstate and the restored page plays its own entrance.
 *
 * The scroll-to-top belongs to NavigationScrollManager, which resets in a
 * layout effect when the route commits. Resetting here instead would run
 * BEFORE the router commit (v7 navigate schedules through startTransition,
 * so flushSync does not force it), and the scroll event it fires would be
 * recorded against the OLD history entry — silently erasing the position
 * that Back is supposed to restore.
 */
export function navigateWithViewTransition(navigate: NavigateFunction, to: string) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduceMotion || typeof document.startViewTransition !== 'function') {
    navigate(to)
    return
  }

  const root = document.documentElement
  root.classList.add('vt-active')

  const transition = document.startViewTransition(() => {
    flushSync(() => navigate(to))
  })

  /* A newer navigation skips the running transition, rejecting `finished`
     and `ready`; only the latest transition should own the class hand-off. */
  transition.finished.catch(() => {})
  transition.ready
    .catch(() => {})
    .finally(() => {
      if (current === transition) {
        current = null
        root.classList.remove('vt-active')
      }
    })
  current = transition
}

let current: ViewTransition | null = null

/* Back/forward bypasses the click interceptor, so clear the snapshot
   suppression before React Router commits the restored route. Registered at
   module import — ahead of the router's own popstate subscription. */
window.addEventListener('popstate', () => {
  document.documentElement.classList.remove('vt-active')
})
