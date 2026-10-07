/**
 * Scroll restoration for browser Back/Forward.
 *
 * The browser's automatic restoration runs before lazy route content has
 * loaded, so on POP it gives up and the user lands at the top of the page.
 * This component takes over (`history.scrollRestoration = 'manual'`) and
 * owns three jobs:
 *
 * - Record: a passive scroll listener saves window.scrollY against the
 *   current location.key, throttled by rAF. Key and position are read
 *   synchronously in the event callback — by the time the frame runs the
 *   router may have committed the next entry, and the old page's position
 *   would be saved under the new entry's key.
 * - Restore: on POP with a saved position, scroll there immediately in a
 *   layout effect (pre-paint). If the document is still shorter than the
 *   target, content is loading — a ResizeObserver on <body> retries after
 *   each height growth (it also sees image loads, which mutate no DOM
 *   nodes). A 3s timer, reset by every growth, abandons the
 *   restore once loading stalls, and wheel/touch/scroll-key input cancels
 *   it instantly: the user's hand always beats a pending restore.
 * - Reset: PUSH/REPLACE keep the old ScrollToTop semantics — top on
 *   pathname change (desk-to-desk hops exempt) and on pushed ?folder hops.
 *
 * Pages served from the bfcache are restored wholesale by the browser,
 * scroll included, so they need no handling here.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { isLibraryDeskPath } from '../lib/libraryDesk'
import { readPosition, savePosition } from '../lib/scrollPositions'

/* Keys that scroll the page — pressing one means the user is driving. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', ' ', 'Home', 'End'])

const RESTORE_TIMEOUT_MS = 3000

if ('scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual'
}

type CancelRef = { current: (() => void) | null }

/* The pre-paint scroll already happened but the document was too short —
   content is still loading. Retry on every height growth; give up when
   growth stalls (timeout) or the user grabs the scrollbar (input). The
   returned state is owned through cancelRef so the next navigation or an
   unmount can abort it; cleanup is idempotent (StrictMode double-runs). */
function scheduleRestore(target: number, cancelRef: CancelRef): void {
  let lastHeight = document.documentElement.scrollHeight
  let timer = 0
  let observer: ResizeObserver | null = null

  function cleanup() {
    if (cancelRef.current === cleanup) cancelRef.current = null
    observer?.disconnect()
    observer = null
    window.clearTimeout(timer)
    window.removeEventListener('wheel', cancel)
    window.removeEventListener('touchstart', cancel)
    window.removeEventListener('keydown', onKeyDown)
  }

  function cancel() {
    cleanup()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (SCROLL_KEYS.has(event.key)) cleanup()
  }

  function fits() {
    return document.documentElement.scrollHeight >= target + window.innerHeight
  }

  function onGrowth() {
    const height = document.documentElement.scrollHeight
    if (height <= lastHeight) return
    lastHeight = height
    window.scrollTo({ top: target, behavior: 'instant' })
    if (fits()) {
      cleanup()
      return
    }
    /* Still short but growing — keep waiting. */
    window.clearTimeout(timer)
    timer = window.setTimeout(cleanup, RESTORE_TIMEOUT_MS)
  }

  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(onGrowth)
    observer.observe(document.body)
  }
  timer = window.setTimeout(cleanup, RESTORE_TIMEOUT_MS)
  window.addEventListener('wheel', cancel, { passive: true })
  window.addEventListener('touchstart', cancel, { passive: true })
  window.addEventListener('keydown', onKeyDown)

  cancelRef.current = cleanup
}

/* Entries created outside the router (the tab's first page, address-bar
   navigations) all share location.key "default", so the key alone would leak
   one page's position into another's first load. The URL disambiguates; a
   given history entry never changes its URL, so restores still match. */
function entryKey(location: { key: string; pathname: string; search: string }): string {
  return `${location.key}:${location.pathname}${location.search}`
}

export function NavigationScrollManager() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const keyRef = useRef(entryKey(location))
  const prevRef = useRef({ pathname: location.pathname, search: location.search, key: location.key })
  const cancelRestoreRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let frame = 0
    let pendingKey = keyRef.current
    let pendingY = window.scrollY
    const onScroll = () => {
      pendingKey = keyRef.current
      pendingY = window.scrollY
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        savePosition(pendingKey, pendingY)
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])

  useLayoutEffect(() => {
    keyRef.current = entryKey(location)
    /* A new navigation supersedes any restore still pending. */
    cancelRestoreRef.current?.()
    cancelRestoreRef.current = null

    const prev = prevRef.current
    prevRef.current = { pathname: location.pathname, search: location.search, key: location.key }

    if (navigationType === 'POP') {
      /* A hash means the anchor wins; no saved position means first visit
         (the initial load is a POP too). */
      const target = location.hash ? undefined : readPosition(entryKey(location))
      if (target !== undefined) {
        window.scrollTo({ top: target, behavior: 'instant' })
        if (document.documentElement.scrollHeight < target + window.innerHeight) {
          scheduleRestore(target, cancelRestoreRef)
        }
      }
    } else if (prev.pathname !== location.pathname) {
      /* Desk-to-desk hops swap the workspace in place — yanking to the top
         there reads as a glitch. */
      if (!(isLibraryDeskPath(prev.pathname) && isLibraryDeskPath(location.pathname))) {
        window.scrollTo({ top: 0, behavior: 'instant' })
      }
    } else if (navigationType === 'PUSH') {
      /* Same pathname: only a pushed ?folder hop (drill-down) lands at the
         top — replace-driven q/view edits must not move the page. */
      const prevFolder = new URLSearchParams(prev.search).get('folder')
      const nextFolder = new URLSearchParams(location.search).get('folder')
      if (prevFolder !== nextFolder) {
        window.scrollTo({ top: 0, behavior: 'instant' })
      }
    }

    return () => {
      cancelRestoreRef.current?.()
      cancelRestoreRef.current = null
    }
  }, [location, navigationType])

  return null
}
