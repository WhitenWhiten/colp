import { useEffect, useId, useRef } from 'react'

/* One styled tooltip for every DOM title= in the app. The OS tooltip can't be
   styled and only answers the mouse, so while a titled element is hovered or
   keyboard-focused its title moves into this top-layer bubble and comes back
   when the bubble closes. The text stays reachable meanwhile: an icon-only
   element gets it as aria-label, anything else is described by the bubble.
   Layout mounts this once. */

const SHOW_DELAY_MS = 450
/** Moving straight from one titled element to the next shows it at once. */
const WARM_MS = 300
/** R15-45: time to cross the gap from the element onto the bubble (1.4.13
    hoverable) before a pointer leave closes it. */
const GRACE_MS = 150
const GAP_PX = 6
const EDGE_PX = 8

/** Centred above the anchor, below it when the top edge is too close, and
 *  clamped inside the viewport's sides. */
export function placeTooltip(
  anchor: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'width'>,
  tip: Pick<DOMRect, 'width' | 'height'>,
  viewportWidth: number,
): { left: number; top: number; below: boolean } {
  const above = anchor.top - GAP_PX - tip.height
  const below = above < EDGE_PX
  const centred = anchor.left + anchor.width / 2 - tip.width / 2
  const left = Math.max(EDGE_PX, Math.min(centred, viewportWidth - tip.width - EDGE_PX))
  return { left: Math.round(left), top: Math.round(below ? anchor.bottom + GAP_PX : above), below }
}

type Held = {
  el: Element
  title: string
  /** Attribute values to put back on release (null = was absent). */
  restore: Array<[name: string, value: string | null]>
  /** A keyboard-focus bubble persists through pointer moves and scrolling. */
  by: 'pointer' | 'focus'
  /** True when the host set aria-label from the title (icon-only element). */
  labelled: boolean
  watch: MutationObserver
}

function titledFrom(target: EventTarget | null): Element | null {
  const el = target instanceof Element ? target.closest('[title]') : null
  if (!el || el instanceof HTMLIFrameElement) return null
  return el.getAttribute('title')?.trim() ? el : null
}

function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return false
  }
}

export function TooltipHost() {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const tip = ref.current
    if (!tip) return
    let held: Held | null = null
    let timer: number | undefined
    let shown = false
    let closedAt = 0
    /** Clicked or Escaped: stays quiet until the pointer leaves it, like the OS tooltip. */
    let dismissed: Element | null = null

    let grace: number | undefined

    const hold = (el: Element, by: Held['by']) => {
      const title = el.getAttribute('title') ?? ''
      const restore: Held['restore'] = [['title', title]]
      const set = (name: string, value: string) => {
        restore.push([name, el.getAttribute(name)])
        el.setAttribute(name, value)
      }
      el.removeAttribute('title')
      const text = el.textContent?.trim() ?? ''
      let labelled = false
      if (!text && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
        set('aria-label', title)
        labelled = true
      } else if (text !== title.trim() && el.getAttribute('aria-label') !== title) {
        set('aria-describedby', [el.getAttribute('aria-describedby'), id].filter(Boolean).join(' '))
      }
      tip.textContent = title
      /* R15-45: the page may change the title while it is held (React re-sets
         it, e.g. "Mark as read" → "Mark as unread"); take the new text. */
      const watch = new MutationObserver(() => {
        const next = el.getAttribute('title')
        if (next === null || held?.el !== el) return
        el.removeAttribute('title')
        if (!next.trim()) return
        held.title = next
        tip.textContent = next
        if (held.labelled) el.setAttribute('aria-label', next)
        if (shown) place()
      })
      watch.observe(el, { attributes: true, attributeFilter: ['title'] })
      held = { el, title, restore, by, labelled, watch }
    }

    const release = () => {
      window.clearTimeout(timer)
      window.clearTimeout(grace)
      if (shown) {
        if (typeof tip.hidePopover === 'function' && tip.matches(':popover-open')) tip.hidePopover()
        shown = false
        closedAt = Date.now()
      }
      if (!held) return
      const { el, restore, watch, title } = held
      watch.disconnect()
      held = null
      // A title changed while held is the one to put back.
      restore[0] = ['title', title]
      for (const [name, value] of restore) {
        // React may have re-set a changed title while it was held; keep that one.
        if (name === 'title' && el.hasAttribute('title')) continue
        if (value === null) el.removeAttribute(name)
        else el.setAttribute(name, value)
      }
    }

    const place = () => {
      if (!held) return
      const pos = placeTooltip(held.el.getBoundingClientRect(), tip.getBoundingClientRect(), document.documentElement.clientWidth)
      tip.style.translate = `${pos.left}px ${pos.top}px`
      tip.dataset.side = pos.below ? 'below' : 'above'
    }

    const show = () => {
      if (!held?.el.isConnected) return release()
      if (typeof tip.showPopover === 'function' && !tip.matches(':popover-open')) tip.showPopover()
      shown = true
      place()
    }

    const dismiss = (target: EventTarget | null) => {
      dismissed = held?.el ?? titledFrom(target)
      release()
    }

    const onOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      // R15-45: a keyboard-focus bubble is not the pointer's to move.
      if (held?.by === 'focus') return
      const target = event.target as Node | null
      // Back on the element, or onto the bubble itself: keep it (hoverable).
      if (held?.el.contains(target) || tip.contains(target)) {
        window.clearTimeout(grace)
        return
      }
      if (dismissed?.contains(event.target as Node | null)) return
      dismissed = null
      const el = titledFrom(event.target)
      const warm = shown || Date.now() - closedAt < WARM_MS
      release()
      if (!el) return
      hold(el, 'pointer')
      timer = window.setTimeout(show, warm ? 0 : SHOW_DELAY_MS)
    }
    const onOut = (event: PointerEvent) => {
      if (!held || held.by === 'focus') return
      const to = event.relatedTarget as Node | null
      if (held.el.contains(to) || tip.contains(to)) return
      // Leaving the element or the bubble: close, after a gap-crossing grace
      // when there is a bubble to cross to.
      window.clearTimeout(grace)
      if (shown) grace = window.setTimeout(release, GRACE_MS)
      else release()
    }
    const onFocusIn = (event: FocusEvent) => {
      const el = event.target instanceof Element ? event.target : null
      if (!el?.getAttribute('title')?.trim() || !focusVisible(el)) return
      release()
      hold(el, 'focus')
      show()
    }
    const onFocusOut = (event: FocusEvent) => {
      if (held?.el === event.target) release()
    }
    const onDown = (event: PointerEvent) => {
      // Pressing inside the (hoverable) bubble, e.g. to select its text, keeps it.
      if (tip.contains(event.target as Node | null)) return
      dismiss(event.target)
    }
    /* R15-45: Escape closes the bubble first and only the bubble — captured
       on window so an open Modal's own Escape handler never sees it. */
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !held) return
      if (shown) {
        event.stopImmediatePropagation()
        event.preventDefault()
      }
      dismiss(held.el)
    }
    const onScroll = () => {
      if (held?.by === 'focus') {
        if (shown) place()
        return
      }
      release()
    }

    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onOut)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('blur', release)
    return () => {
      release()
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onOut)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('blur', release)
    }
  }, [id])

  return <div ref={ref} id={id} className="app-tooltip" role="tooltip" popover="manual" />
}
