import { useEffect } from 'react'

let lockCount = 0
let previousOverflow = ''

/**
 * Locks document scrolling while `locked` is true. Overlapping callers
 * (drawer + modal) share one counter so the first unlock does not restore
 * overflow while another surface is still open.
 *
 * The lock goes on the root element, not body: global.css gives `html`
 * `overflow-y: auto`, so the viewport scrolls the root scroller and body's
 * overflow never propagates. Locking body left the page scrollable behind
 * dialogs and let modal scrollports chain to it once they bottomed out.
 */
export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return
    const root = document.documentElement
    if (lockCount === 0) previousOverflow = root.style.overflow
    lockCount += 1
    root.style.overflow = 'hidden'
    return () => {
      lockCount -= 1
      if (lockCount === 0) root.style.overflow = previousOverflow
    }
  }, [locked])
}
