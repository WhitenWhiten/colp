import { useEffect, useState } from 'react'

/* Counts 0 → target with easeOutQuart for editorial stat emphasis.
   Reduced-motion users and the test environment get the final value. */
export function useCountUp(target: number, durationMs = 350): number {
  const [value, setValue] = useState(target)

  useEffect(() => {
    if (target === 0 || import.meta.env.MODE === 'test') {
      setValue(target)
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target)
      return
    }
    let raf = 0
    const start = performance.now()
    setValue(0)
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      setValue(Math.round(target * (1 - Math.pow(1 - t, 4))))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs])

  return value
}
