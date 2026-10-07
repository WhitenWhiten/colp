import { useLayoutEffect, useState } from 'react'

/* Clamp-aware tooltips: TooltipHost turns every title= into a bubble, so a
   title on fully visible text only repeats it. Hosts set title only while
   this reports the element's text as cut off — by a line clamp (height) or
   a one-line ellipsis (width). Same measurement as ClampedText. One shared
   ResizeObserver serves every row, so long lists stay cheap. */

type Measure = () => void
const watchers = new Map<Element, Measure>()
let observer: ResizeObserver | null = null

function sharedObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') return null
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) watchers.get(entry.target)?.()
  })
  return observer
}

export function isClamped(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1
}

/** Returns a callback ref for the clamped element and whether its text is
    currently cut off. `text` re-measures when the content changes. */
export function useIsClamped<T extends HTMLElement>(text: string): [ref: (node: T | null) => void, clamped: boolean] {
  const [node, setNode] = useState<T | null>(null)
  const [clamped, setClamped] = useState(false)

  useLayoutEffect(() => {
    if (!node) return
    const measure = () => setClamped(isClamped(node))
    measure()
    const resize = sharedObserver()
    if (!resize) {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    watchers.set(node, measure)
    resize.observe(node)
    return () => {
      watchers.delete(node)
      resize.unobserve(node)
    }
  }, [node, text])

  return [setNode, clamped && node !== null]
}
