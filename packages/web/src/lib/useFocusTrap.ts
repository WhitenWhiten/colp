import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Where focus lands when the trap activates: a ref to an element, or a
 * selector scoped to the trap container. Falls back to the first
 * focusable element when absent or unmatched.
 */
export type InitialFocusTarget = RefObject<HTMLElement | null> | string

function isShown(el: HTMLElement): boolean {
  if (el.closest('[hidden], [aria-hidden="true"]')) return false
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  return true
}

/**
 * Traps Tab inside a container while `active` is true.
 * Listens on document so Tab still cycles after focus lands on body,
 * skips hidden descendants, and restores the previously focused element.
 * `initialFocus` is read once at activation time.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  active: boolean,
  initialFocus?: InitialFocusTarget,
) {
  const containerRef = useRef<T>(null)

  useEffect(() => {
    if (!active) return
    const node = containerRef.current
    if (!node) return
    const trapRoot: HTMLElement = node

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null

    function getFocusable() {
      return Array.from(trapRoot.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isShown)
    }

    function resolveInitialFocus() {
      if (typeof initialFocus === 'string') return trapRoot.querySelector<HTMLElement>(initialFocus)
      return initialFocus?.current
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return

      const focusable = getFocusable()
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const activeEl = document.activeElement
      const inside = activeEl instanceof Node && trapRoot.contains(activeEl)

      if (!inside) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }

      if (event.shiftKey) {
        if (activeEl === first) {
          event.preventDefault()
          last.focus()
        }
      } else if (activeEl === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    const frame = requestAnimationFrame(() => {
      const target = resolveInitialFocus() ?? getFocusable()[0]
      // preventScroll: trap containers are overlays that may still be
      // animating in from off-screen; a reveal-scroll here pans the whole
      // page (the "slide" seen when the node drawer opens).
      target?.focus({ preventScroll: true })
    })

    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
    // initialFocus is captured at activation; see the hook docstring.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read initialFocus once
  }, [active])

  return containerRef
}
