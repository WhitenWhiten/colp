import { useEffect, useRef, useState, type DependencyList } from 'react'

/** Header height the sticky toolbars pin under (matches --header-h). */
const HEADER_ROOT_MARGIN = '-56px 0px 0px 0px'

/**
 * Sticky-toolbar "stuck" state shared by the public Collection page and the
 * digest edition reader: a 1px sentinel sits right above the toolbar; once it
 * scrolls under the header the toolbar is pinned and gets the floating
 * shadow (`.is-stuck`). Pass the value the toolbar renders after (snapshot,
 * contents) so the observer re-attaches when the sentinel remounts.
 */
export function useStuckToolbar(deps: DependencyList) {
  const [isStuck, setIsStuck] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => { const entry = entries[0]; if (entry) setIsStuck(!entry.isIntersecting) },
      { rootMargin: HEADER_ROOT_MARGIN },
    )
    io.observe(sentinel)
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied remount deps
  }, deps)

  return { sentinelRef, isStuck }
}
