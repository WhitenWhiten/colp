import { useEffect, useRef } from 'react'

/**
 * Focus `elementId` when `active` flips from false to true.
 * Skips the initial mount so a default-active field does not steal first paint.
 */
export function useFocusWhen(active: boolean, elementId: string) {
  const wasActive = useRef(active)

  useEffect(() => {
    if (active && !wasActive.current) {
      document.getElementById(elementId)?.focus()
    }
    wasActive.current = active
  }, [active, elementId])
}
