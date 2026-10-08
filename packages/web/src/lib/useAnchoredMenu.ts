import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { anchorPopover, type AnchorPopoverOptions, type AnchorPopoverPos } from './anchorPopover'
import { menuItemsOf, nextTabbableAfter } from './menuKeys'

export type AnchoredMenuPosition = { x: number; y: number }

export type AnchoredMenuSize = { width: number; height: number }

type UseAnchoredMenuOptions = {
  /** Trigger refs whose own pointerdown must not dismiss the menu; Escape
      also returns focus to the first exempt ref (the invoking control). */
  exemptRefs?: ReadonlyArray<RefObject<HTMLElement | null>>
}

type MenuState =
  | { mode: 'point'; pos: AnchoredMenuPosition }
  | {
      mode: 'anchor'
      getAnchor: () => DOMRect | null
      popover: AnchorPopoverOptions
      pos: AnchorPopoverPos
    }

/**
 * Context/dropdown menu state: viewport-clamped position, dismissal
 * (outside pointerdown, Escape, resize), and APG menu keyboard behavior
 * (focus first item on open, ArrowUp/ArrowDown/Home/End roaming, Tab closes
 * and continues from the trigger, Escape returns focus to the trigger).
 * Assumes the panel carries role="menu".
 *
 * Two open modes:
 *  - `openAt(x, y, size)` — pointer-point menus (context menus). Resize
 *    closes them; the coordinate anchor is already stale by then.
 *  - `openAnchored(getRect, popover)` — trigger-anchored dropdowns. Scroll
 *    (capture, so nested scrollers count) and resize reposition the panel
 *    against the live trigger rect; if the trigger left the DOM the menu
 *    closes instead of floating orphaned.
 * The outside-pointerdown listener attaches one tick after opening so the
 * pointerdown that accompanies the opening gesture (contextmenu) does not
 * immediately close the menu; Escape/resize/scroll arm immediately — no
 * opening gesture produces them.
 */
export function useAnchoredMenu(options?: UseAnchoredMenuOptions) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const exemptRef = useRef(options?.exemptRefs)
  exemptRef.current = options?.exemptRefs
  // Viewport listeners read the live state through this ref — a reposition
  // must not tear down and re-arm the dismissal set.
  const stateRef = useRef<MenuState | null>(menu)
  stateRef.current = menu

  const close = useCallback(() => setMenu(null), [])

  const openAt = useCallback((clientX: number, clientY: number, size: AnchoredMenuSize) => {
    const pad = 8
    const x = Math.max(pad, Math.min(clientX, window.innerWidth - size.width - pad))
    const y = Math.max(pad, Math.min(clientY, window.innerHeight - size.height - pad))
    setMenu({ mode: 'point', pos: { x, y } })
  }, [])

  const reposition = useCallback(() => {
    setMenu((current) => {
      if (current?.mode !== 'anchor') return current
      const rect = current.getAnchor()
      if (!rect) return null
      return { ...current, pos: anchorPopover(rect, current.popover) }
    })
  }, [])

  const openAnchored = useCallback(
    (getAnchor: () => DOMRect | null, popover: AnchorPopoverOptions = {}) => {
      const rect = getAnchor()
      if (!rect) return
      setMenu({ mode: 'anchor', getAnchor, popover, pos: anchorPopover(rect, popover) })
    },
    [],
  )

  const open = menu !== null

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenu(null)
      // APG: Escape closes and focus returns to the invoking control — but
      // only when focus was inside the menu (or nowhere), never yank it
      // away from an unrelated element the user moved to.
      const active = document.activeElement
      const focusWasInside =
        active instanceof HTMLElement &&
        (menuRef.current?.contains(active) || active === document.body)
      if (focusWasInside) exemptRef.current?.[0]?.current?.focus({ preventScroll: true })
    }
    const onResize = () => {
      if (stateRef.current?.mode === 'anchor') reposition()
      else setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    // Anchor mode also tracks scroll (capture — nested scrollers count);
    // point menus ignore it so a context menu over a scrolling list stays.
    if (stateRef.current?.mode === 'anchor') {
      window.addEventListener('scroll', reposition, true)
    }
    // Outside-pointerdown waits a tick: the same gesture that opened a
    // context menu (right-button down → contextmenu) must not close it.
    let pointerCleanup: (() => void) | undefined
    const timer = window.setTimeout(() => {
      const onPointerDown = (event: Event) => {
        const target = event.target as Node | null
        if (menuRef.current?.contains(target)) return
        if (exemptRef.current?.some((ref) => ref.current?.contains(target))) return
        setMenu(null)
      }
      window.addEventListener('pointerdown', onPointerDown, true)
      pointerCleanup = () => window.removeEventListener('pointerdown', onPointerDown, true)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      pointerCleanup?.()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, reposition])

  // APG menu keys: focus the first item on open, then roam with arrows.
  // The menu mounts in the same commit as the open flag, so menuRef is
  // ready here; keying on `open` (not the position object) keeps a
  // reposition from re-focusing the first item mid-navigation.
  useEffect(() => {
    if (!open) return
    const menuEl = menuRef.current
    if (!menuEl) return
    // The control that had focus when the menu opened: the trigger for
    // dropdowns, the row for context menus without an exempt trigger.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    menuItemsOf(menuEl)[0]?.focus({ preventScroll: true })

    const onKeyDown = (event: KeyboardEvent) => {
      /* APG: Tab closes the menu (a transient overlay, not a focus trap).
         R15-35: the panel is portaled to the end of <body> with tabindex=-1
         items, so native traversal dropped focus on <body>. Continue from
         the trigger instead: Shift+Tab lands on it, Tab moves past it. */
      if (event.key === 'Tab') {
        event.preventDefault()
        setMenu(null)
        const trigger = exemptRef.current?.[0]?.current ?? opener
        if (!trigger?.isConnected) return
        trigger.focus({ preventScroll: true })
        if (!event.shiftKey) nextTabbableAfter(trigger, menuEl)?.focus()
        return
      }
      const items = menuItemsOf(menuEl)
      if (items.length === 0) return
      const current = items.indexOf(document.activeElement as HTMLElement)
      let next: number | null = null
      if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length
      else if (event.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = items.length - 1
      if (next === null) return
      event.preventDefault()
      items[next]?.focus({ preventScroll: true })
    }
    menuEl.addEventListener('keydown', onKeyDown)
    return () => menuEl.removeEventListener('keydown', onKeyDown)
  }, [open])

  return {
    open,
    pos: menu?.mode === 'point' ? menu.pos : null,
    anchorPos: menu?.mode === 'anchor' ? menu.pos : null,
    openAt,
    openAnchored,
    close,
    menuRef,
  }
}
