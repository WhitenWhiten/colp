import { useEffect, useState, type RefCallback } from 'react'

/**
 * R15-29: true once the observed element comes within `rootMargin` of the
 * viewport, then stays true. `eager` (or no IntersectionObserver) starts
 * true, for deep links that must render the target at once.
 */
export function useNearViewport(eager = false, rootMargin = '800px 0px'): [RefCallback<Element>, boolean] {
  const [near, setNear] = useState(() => eager || typeof IntersectionObserver === 'undefined')
  const [node, setNode] = useState<Element | null>(null)

  useEffect(() => {
    if (near || node === null) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true)
    }, { rootMargin })
    observer.observe(node)
    return () => observer.disconnect()
  }, [near, node, rootMargin])

  return [setNode, near || eager]
}
