import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'

interface MeasuredListProps<T> {
  items: T[]
  /** First guess for rows that have never been rendered. */
  estimatedItemHeight: number
  overscan?: number
  renderItem: (item: T, index: number) => ReactNode
  className?: string
  testId?: string
  density?: string
  itemRole?: 'listitem' | 'presentation'
}

/**
 * Windowing for rows whose height is NOT uniform.
 *
 * `VirtualList` positions each row at `index * itemHeight`, which is correct only
 * when every row is the same height. The comfort list is a flex column of
 * auto-height rows — titles clamp at two lines and some rows carry a description
 * — so it needs real measurements, and that is what this adds: each mounted row
 * reports its height, the offsets are rebuilt from those, and rows that have
 * never been mounted fall back to the running average.
 *
 * It is a separate component rather than a mode on `VirtualList` on purpose. The
 * compact list and the library desk depend on the fixed-height arithmetic and its
 * tests; keeping the two paths apart means this cannot change their behaviour.
 *
 * The offsets are a plain O(n) scan, not a balanced tree. That is deliberate: the
 * win being bought here is DOM size (the unvirtualized list measured ~16 elements
 * per row, so 100_000 rows is ~1.6M elements), and rebuilding a few thousand
 * offsets per scroll frame is far cheaper than mounting the rows.
 */
export function MeasuredList<T>({
  items,
  estimatedItemHeight,
  overscan = 3,
  renderItem,
  className,
  testId,
  density,
  itemRole = 'listitem',
}: MeasuredListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef(0)
  const rowNodes = useRef(new Map<number, HTMLDivElement>())
  const resizeObserver = useRef<ResizeObserver | null>(null)
  /**
   * Reported row heights, in STATE rather than a ref plus a version counter.
   *
   * The offsets are derived from these, so React has to know when one lands;
   * a ref made the dependency invisible to the lint rule and to readers (the
   * counter that stood in for it is not an input to anything), and the memo
   * had to name an argument it never read to stay correct.
   */
  const [measured, setMeasured] = useState<ReadonlyMap<number, number>>(() => new Map())
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  const onScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => { setScrollTop(el.scrollTop) })
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') {
      setViewportHeight((height) => height || 600)
      return
    }
    let width = el.clientWidth
    const sync = () => {
      setViewportHeight(el.clientHeight)
      const widthChanged = width !== el.clientWidth
      width = el.clientWidth
      const heights = [...rowNodes.current].map(([index, node]) =>
        [index, node.getBoundingClientRect().height] as const)
      // Width changes invalidate offscreen measurements too. Rebuild from the
      // mounted rows and estimate the rest at the new width.
      setMeasured((current) => {
        const next = new Map(widthChanged ? [] : current)
        let changed = widthChanged
        for (const [index, height] of heights) {
          if (height > 0 && next.get(index) !== height) {
            next.set(index, height)
            changed = true
          }
        }
        return changed ? next : current
      })
    }
    const ro = new ResizeObserver(sync)
    resizeObserver.current = ro
    ro.observe(el)
    for (const node of rowNodes.current.values()) ro.observe(node)
    sync()
    return () => {
      ro.disconnect()
      resizeObserver.current = null
      cancelAnimationFrame(frameRef.current)
    }
  }, [])

  /**
   * Average of what has been measured, so unmeasured rows are placed sensibly.
   *
   * Derived from `measured`, not from scroll position: a measurement landing is
   * what changes this, and memoising on scroll left the offsets built from the
   * stale estimate while every row had already reported its real height.
   */
  const estimate = useMemo(() => {
    const heights = [...measured.values()]
    if (heights.length === 0) return estimatedItemHeight
    return heights.reduce((sum, height) => sum + height, 0) / heights.length
  }, [estimatedItemHeight, measured])

  /** Prefix offsets: `offsets[i]` is where row i starts. */
  const offsets = useMemo(() => {
    const result = new Array<number>(items.length + 1)
    result[0] = 0
    for (let index = 0; index < items.length; index += 1) {
      result[index + 1] = result[index]! + (measured.get(index) ?? estimate)
    }
    return result
  }, [items, estimate, measured])

  const totalHeight = offsets[items.length] ?? 0
  const view = viewportHeight || 600

  // First row whose END is past the top of the viewport, and the first whose
  // START is past its bottom.
  let startIndex = 0
  while (startIndex < items.length && offsets[startIndex + 1]! < scrollTop) startIndex += 1
  let endIndex = startIndex
  while (endIndex < items.length && offsets[endIndex]! < scrollTop + view) endIndex += 1
  startIndex = Math.max(0, startIndex - overscan)
  endIndex = Math.min(items.length, endIndex + overscan)

  const measure = useCallback((index: number, node: HTMLDivElement | null) => {
    const previous = rowNodes.current.get(index)
    if (previous) resizeObserver.current?.unobserve(previous)
    if (node === null) {
      rowNodes.current.delete(index)
      return
    }
    rowNodes.current.set(index, node)
    resizeObserver.current?.observe(node)
    const height = node.getBoundingClientRect().height
    if (height <= 0) return
    setMeasured((current) => {
      // Unchanged heights must not allocate: this runs from a ref callback on
      // every commit, and returning a new Map each time would re-render for ever.
      if (current.get(index) === height) return current
      const next = new Map(current)
      next.set(index, height)
      return next
    })
  }, [])

  return (
    <div
      ref={containerRef}
      role="list"
      className={`virtual-list${className ? ` ${className}` : ''}`}
      data-testid={testId}
      data-density={density}
      onScroll={onScroll}
    >
      <div className="virtual-list-spacer" data-testid="virtual-list-spacer"
        style={{ ['--vl-total' as string]: `${totalHeight}px` }}>
        {Array.from({ length: endIndex - startIndex }, (_, offset) => startIndex + offset).map((index) => {
          const item = items[index]!
          return (
            <div
              key={index}
              ref={(node) => { measure(index, node) }}
              role={itemRole}
              // `--measured` sets `height: auto`. Without it the wrapper's CSS
              // imposes `--vl-item-h`, and reading that same node's rect would
              // return the value just imposed instead of the row's real height.
              className="virtual-list-item virtual-list-item--measured"
              style={{
                ['--vl-top' as string]: `${offsets[index]}px`,
                // Only a floor for the first paint, before the measurement lands.
                ['--vl-item-h' as string]: `${measured.get(index) ?? estimate}px`,
              }}
            >
              {renderItem(item, index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
