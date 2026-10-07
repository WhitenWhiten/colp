import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { useDeskStorage } from '../../lib/useDeskStorage'

/**
 * Draggable split between the desk's collections rail and the bookmark pane.
 * The chosen width is a px-locked CSS custom property on the grid; until the
 * user drags (or after a double-click reset) the responsive minmax() default
 * in library.css owns the column. Desktop only — the rail is hidden below
 * 720px and the divider renders display:none there.
 */
export const LIBRARY_SPLIT_MIN_PX = 200
export const LIBRARY_SPLIT_MAX_PX = 480
const KEYBOARD_STEP_PX = 16

function clampWidth(value: number): number {
  return Math.min(LIBRARY_SPLIT_MAX_PX, Math.max(LIBRARY_SPLIT_MIN_PX, Math.round(value)))
}

export function useLibraryDeskSplit() {
  const { value: stored, set: persist } = useDeskStorage<number | null>({
    storageKey: 'library-desk.sidebar-width',
    fallback: () => null,
    normalize: (value) => (typeof value === 'number' && Number.isFinite(value) ? clampWidth(value) : null),
  })
  const [live, setLive] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const dividerRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const liveRef = useRef<number | null>(null)
  liveRef.current = live
  const width = live ?? stored

  const measureRail = useCallback((): number | null => {
    const aside = dividerRef.current?.previousElementSibling
    return aside instanceof HTMLElement ? aside.getBoundingClientRect().width : null
  }, [])

  const applyWidth = useCallback((next: number | null) => {
    setLive(null)
    persist(next === null ? null : clampWidth(next))
  }, [persist])

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const startWidth = measureRail() ?? stored
    if (startWidth === null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth }
    setDragging(true)
    document.body.setAttribute('data-library-split', '')
  }, [measureRail, stored])

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    setLive(clampWidth(drag.startWidth + event.clientX - drag.startX))
  }, [])

  const endDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    document.body.removeAttribute('data-library-split')
    setDragging(false)
    if (liveRef.current !== null) applyWidth(liveRef.current)
  }, [applyWidth])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const current = liveRef.current ?? stored ?? measureRail()
    if (current === null) return
    applyWidth(current + (event.key === 'ArrowRight' ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX))
  }, [applyWidth, measureRail, stored])

  const onDoubleClick = useCallback(() => applyWidth(null), [applyWidth])

  const style = width === null
    ? undefined
    : ({ '--library-sidebar-w': `${width}px` } as CSSProperties)

  return {
    dividerRef,
    dragging,
    style,
    width,
    dividerProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize the collections panel',
      ...(width === null ? {} : { 'aria-valuenow': width, 'aria-valuemin': LIBRARY_SPLIT_MIN_PX, 'aria-valuemax': LIBRARY_SPLIT_MAX_PX }),
      tabIndex: 0,
      title: 'Drag to resize · double-click to reset',
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown,
      onDoubleClick,
    } as const,
  }
}

export type LibraryDeskSplit = ReturnType<typeof useLibraryDeskSplit>
