import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface VirtualListProps<T> {
  items: T[]
  itemHeight: number
  overscan?: number
  renderItem: (item: T, index: number) => React.ReactNode
  className?: string
  testId?: string
  density?: string
  /** `presentation` when `renderItem` already renders the list item semantics. */
  itemRole?: 'listitem' | 'presentation'
}

/**
 * Lightweight virtual list — renders only visible items + overscan buffer.
 * Requires uniform item height for accurate positioning.
 */
export function VirtualList<T>({
  items,
  itemHeight,
  overscan = 3,
  renderItem,
  className,
  testId,
  density,
  itemRole = 'listitem',
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  const onScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      setScrollTop(el.scrollTop)
    })
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') {
      setViewportHeight((height) => height || 600)
      return
    }
    const sync = () => setViewportHeight(el.clientHeight)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const totalHeight = items.length * itemHeight
  const view = viewportHeight || 600
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan)
  const endIndex = Math.min(
    items.length,
    Math.ceil((scrollTop + view) / itemHeight) + overscan,
  )

  const visibleItems = useMemo(
    () => items.slice(startIndex, endIndex).map((item, i) => ({
      item,
      index: startIndex + i,
    })),
    [items, startIndex, endIndex],
  )

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
        {visibleItems.map(({ item, index }) => (
          <div
            key={index}
            role={itemRole}
            className="virtual-list-item"
            style={{ ['--vl-top' as string]: `${index * itemHeight}px`, ['--vl-item-h' as string]: `${itemHeight}px` }}
          >
            {renderItem(item, index)}
          </div>
        ))}
      </div>
    </div>
  )
}
